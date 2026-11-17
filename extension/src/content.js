// Aperture's LeetCode capture, extension side of the page — the ISOLATED world (document_start), after the libs,
// debug.js and overlay.js. It owns everything the page must not: the handshake and the relay's checks
// (lib/relay.js), the Start overlay and its clicks on LeetCode's own reset and timer (lib/overlay-state.js),
// the per-problem binding to the sitting it opened, and the hand-off of events to the background. Nothing it
// learns from Aperture is ever passed back into the page.
(() => {
  'use strict';
  const api =
    globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;
  const NS = globalThis.ApertureLC;
  const {
    relay: relayLib,
    overlayState,
    selectors: selLib,
    timer,
    wire,
    outbox,
    batch,
    coach: coachLib,
  } = NS;
  const debug = NS.debug || { log() {}, dumpControls() {}, wants: () => false };
  const mintId = NS.ulid.ulid;
  // packages/shared/src/sittings.ts SITTING_ACTIVE_ERROR (background.test.ts checks the copy).
  const ACTIVE_ERROR = 'Another sitting is still open — end it in Aperture first.';
  const START_TIME_ERROR = 'The Start’s time is off by more than a day.';
  const PENDING_MAX = 500; // page messages waiting for the relay; past it a flood is dropped
  const bootState = document.readyState; // Safari may run document_start late — the debug log says
  const PROBLEM_MAX = 64 * 1024;
  const PROBLEMS_MAX = 8; // fetched docs kept, each at most PROBLEM_MAX: the oldest off screen goes first
  const PAGE_DATA_MAX = 1024 * 1024; // a longer __NEXT_DATA__ isn't parsed
  const START_RETRY_MS = 60_000;

  const local = api.storage.local;
  const send = (msg) => api.runtime.sendMessage(msg);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (selector) => {
    try {
      return selector ? document.querySelector(selector) : null;
    } catch {
      return null;
    }
  };
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(50);
    }
  }

  // ---- state ----
  const relay = relayLib.createRelay();
  let screenSlug = null;
  let navigated = false;
  let state = overlayState.initial();
  let binding = null; // storage.local sitting:<slug> — the sitting this extension opened for the problem
  let sync = null; // storage.local sync:<slug> — the background's last word on it
  let status = null; // storage.local status — the outbox's state
  let sel = selLib.merge(null);
  let coachOn = coachLib.settingsOf(null); // Options' coach switches (lib/coach.js); all on until read
  let pendingStart = null; // {slug, clientSittingId, startedAt} for the Start in progress
  let lastStartRetryable = false;
  const problems = new Map(); // slug → LeetCode's questionDetail.question, this page load, oldest first
  const pageDocs = new Map(); // slug → the same doc as rendered into this load's __NEXT_DATA__ (readPageDoc)
  const loadSlug = relayLib.slugOf(location.pathname); // the problem this document was loaded for
  const questionIds = new Map(); // slug → questionId (from syncedCode)
  const batcher = batch.createBatcher();
  const capture = wire.createCapture(); // LeetCode's raw traffic → items, parsed here, never in the page
  let flushTimer = null;
  let lastTimerRaw = null;

  const bindingStatus = () => {
    if (!binding) return null;
    return (sync && sync.sittingId === binding.sittingId && sync.status) || 'active';
  };
  const liveBinding = () =>
    binding && binding.slug === screenSlug && state.phase !== 'ended'
      ? { questionId: binding.questionId, status: bindingStatus() }
      : null;

  // ---- the handshake (README → How it works) ----
  // Both listeners capture: registered before any page script, they run before any page listener could
  // stop the event.
  window.addEventListener(
    'aperture-lc-hello',
    (e) => {
      const ok = relay.hello(e.detail);
      if (!ok) return;
      window.dispatchEvent(new CustomEvent('aperture-lc-ack')); // same tick: no page script can get between
      let pageState = null; // the page world's readyState when it ran (inject-main.js)
      try {
        pageState = String(JSON.parse(e.detail).readyState || '').slice(0, 20) || null;
      } catch {}
      ok.then((good) => debug.log('handshake', { ok: good, bootState, pageState }));
    },
    true,
  );
  window.dispatchEvent(new CustomEvent('aperture-lc-ready'));

  // ---- page messages, one at a time ----
  let chain = Promise.resolve();
  let pending = 0;
  window.addEventListener(
    'aperture-lc',
    (e) => {
      if (pending >= PENDING_MAX) return debug.log('relay.reject', { reason: 'flood' });
      pending++;
      const detail = e.detail;
      chain = chain
        .then(() => onPageMessage(detail))
        .catch(() => {})
        .then(() => pending--);
    },
    true,
  );
  async function onPageMessage(detail) {
    const r = await relay.accept(detail);
    if (!r.ok) return debug.log('relay.reject', { reason: r.reason });
    // A doc fetched at an SPA nav can land before the 500 ms poll sees the new path: catch up first.
    if (relayLib.slugOf(location.pathname) !== screenSlug) await onNav();
    const raw = r.raw;
    const near = (at) => (Math.abs(at - Date.now()) < 3600_000 ? at : Date.now());
    const items = capture.observe({ ...raw, reqAt: near(raw.reqAt), resAt: near(raw.resAt) });
    // The request is parsed again for its operation names only when the log would keep them.
    if (debug.wants())
      debug.log('wire', {
        items: items.map((i) => i.kind),
        bytes: (raw.reqText || '').length + (raw.resText || '').length,
        ops: wire.opNames(raw.reqText),
        req: raw.reqText == null ? null : raw.reqText.length,
        res: raw.resText == null ? null : raw.resText.length,
        how: raw.how, // why a body is missing, as the page world saw it (inject-main.js)
      });
    items.forEach(onItem);
  }
  function onItem(m) {
    // A problem doc is kept by its own slug, wherever it was fetched (relay.js keepsDoc).
    if (m.kind === 'problem') {
      const k = relayLib.keepsDoc(m);
      if (!k.ok) return debug.log('relay.reject', { reason: k.reason, kind: m.kind });
      return onProblem(m.slug, m.payload, m.questionId);
    }
    // Made from another page (the last problem, before a nav): never this one's. A run or submit made on its
    // own problem's page and judged after you left goes to that problem's sitting.
    const from = relayLib.slugOf(m.page);
    if (from !== screenSlug) {
      if (from && from === m.slug && relayLib.LATE.includes(m.kind)) return lateItem(m);
      return debug.log('relay.reject', { reason: 'off-page', kind: m.kind });
    }
    const a = relayLib.admit(m, { screenSlug, binding: liveBinding() });
    if (!a.ok) {
      if (a.reason !== 'no-sitting') debug.log('relay.reject', { reason: a.reason, kind: m.kind });
      return;
    }
    if (m.kind === 'hint') {
      // A hint (syncedCode) names no slug, so it may be a late answer for the last problem: it's taken only
      // when no id is known yet and the problem doc, if any, agrees.
      const doc = problems.get(screenSlug);
      const docId = doc ? scalar(doc.questionId) : null;
      if (
        m.questionId &&
        !questionIds.has(screenSlug) &&
        (!docId || docId === scalar(m.questionId))
      )
        learnQuestionId(screenSlug, m.questionId);
      return;
    }
    queue(wire.toEventInputs(m, mintId));
    if (m.kind === 'submit') onSubmitItem(m);
  }
  // A run or submit made on its problem's page and judged after you left (for another problem or none) goes
  // to that problem's open sitting — the one this extension bound there — never to the one on screen.
  async function lateItem(m) {
    const slug = m.slug;
    const got = await local.get([`sitting:${slug}`, `sync:${slug}`]).catch(() => ({}));
    const b = got[`sitting:${slug}`];
    const s = got[`sync:${slug}`];
    const status = (s && s.sittingId === (b && b.sittingId) && s.status) || 'active';
    const a = b
      ? relayLib.admit(m, { screenSlug: slug, binding: { questionId: b.questionId, status } })
      : { ok: false, reason: 'no-sitting' };
    debug.log('late', { kind: m.kind, ok: a.ok, reason: a.ok ? null : a.reason });
    if (!a.ok) return;
    const events = wire.toEventInputs(m, mintId);
    handOff({ type: 'enqueue', sittingId: b.sittingId, slug, events });
  }
  // A run or submit LeetCode never judged goes out unjudged after two minutes.
  setInterval(() => capture.sweep(Date.now()).forEach(onItem), 15_000);

  // ---- events → the background (lib/batch.js: 3 s batches, one snapshot per 30 s, a run or submit at once) ----
  function queue(events) {
    let now = false;
    for (const e of events) if (batcher.push(e, Date.now()) === 'now') now = true;
    if (now) flushNow();
    else arm();
  }
  function arm() {
    clearTimeout(flushTimer);
    const due = batcher.dueAt();
    if (due == null) return;
    flushTimer = setTimeout(
      () => {
        ship(batcher.drain(Date.now()));
        arm();
      },
      Math.max(0, due - Date.now()),
    );
  }
  function flushNow(leaving = false) {
    clearTimeout(flushTimer);
    flushTimer = null;
    ship(batcher.flush(), leaving);
  }
  function ship(events, leaving = false) {
    if (!events.length || !binding) return;
    handOff({ type: 'enqueue', sittingId: binding.sittingId, slug: binding.slug, events }, leaving);
  }
  // Safari sometimes refuses a hand-off ("Tab not found") with nothing reloaded: try again, in order (each
  // waits for the one before), a try with no answer in 15 s counting as refused. After the last try the
  // events are kept in this page — a reload would lose them — and tried again every 30 s, on coming back to
  // the tab and after any hand-off that lands; the badge says to keep the tab open. Only when the extension
  // itself is gone (reloaded or updated, so this page can never reach it) does it say to reload. A batch handed over twice is safe: the server writes each event id once. The debug log records
  // every refusal and whether a retry got through.
  const HANDOFF_RETRY_MS = [250, 1000, 3000, 10_000];
  const HANDOFF_WAIT_MS = 15_000;
  const STUCK_RETRY_MS = 30_000;
  const stuck = []; // hand-offs every try refused, oldest first
  let unstuck = 0; // of those, taken out to try again and not yet landed — the badge still counts them
  const extensionGone = () => {
    try {
      return !api.runtime || !api.runtime.id;
    } catch {
      return true;
    }
  };
  function retryStuck() {
    if (!stuck.length || extensionGone()) return;
    for (const m of stuck.splice(0)) {
      unstuck++;
      handOff(m, false, true);
    }
    paintBadge();
  }
  setInterval(retryStuck, STUCK_RETRY_MS);
  let handOffs = Promise.resolve();
  let inFlight = 0;
  // Landed only when the background says so: {ok: true}. Its {ok: false} (a storage write failed) and an
  // empty reply count as refused, as does a send that throws outright.
  const tryOnce = (msg) =>
    Promise.race([
      new Promise((resolve) => resolve(send(msg))).then((rep) => {
        if (!rep || rep.ok !== true) throw new Error((rep && rep.error) || 'no acknowledgement');
      }),
      sleep(HANDOFF_WAIT_MS).then(() => {
        throw new Error('no answer in 15 s');
      }),
    ]);
  // `leaving` (pagehide, or the tab hidden): the first try starts now, ahead of any wait in the chain, while
  // the page can still send.
  function handOff(msg, leaving = false, again = false) {
    const first = inFlight === 0 || leaving ? tryOnce(msg) : null;
    first?.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
    inFlight++;
    handOffs = handOffs
      .then(() => deliver(msg, first))
      .catch(() => {})
      .then(() => {
        inFlight--;
        if (again) unstuck--;
        paintBadge();
      });
  }
  async function deliver(msg, first) {
    for (let i = 0; ; i++) {
      let ok = false;
      try {
        await (i === 0 && first ? first : tryOnce(msg));
        ok = true;
      } catch (err) {
        debug.log('enqueue.fail', {
          error: String(err && err.message),
          try: i + 1,
          visibility: document.visibilityState,
        });
      }
      if (ok) {
        if (i) debug.log('enqueue.retried', { tries: i + 1 });
        return retryStuck();
      }
      if (i >= HANDOFF_RETRY_MS.length) return stuck.push(msg);
      await sleep(HANDOFF_RETRY_MS[i]);
    }
  }
  window.addEventListener('pagehide', () => flushNow(true));
  document.addEventListener('visibilitychange', (e) => {
    if (document.visibilityState === 'hidden') flushNow(true);
    else if (e.isTrusted) recheck();
  });

  // LeetCode's timer, read from its own localStorage (shared with this world) every 2 s while a sitting is
  // active — not while Start is still clicking, when it would still hold the last solve's state.
  function timerEvent(raw) {
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {}
    let heartbeat = null;
    try {
      heartbeat = String(localStorage.getItem(timer.HEARTBEAT_KEY) || '').slice(0, 64) || null;
    } catch {}
    return { id: mintId(), type: 'timer', at: Date.now(), payload: { state: parsed, heartbeat } };
  }
  const timerRaw = () => {
    try {
      const raw = localStorage.getItem(timer.KEY);
      return raw && raw.length <= 900 ? raw : null;
    } catch {
      return null;
    }
  };
  const timing = () => state.phase === 'active' && liveBinding() && bindingStatus() === 'active';
  setInterval(() => {
    if (!timing()) return;
    const raw = timerRaw();
    if (!raw || raw === lastTimerRaw) return;
    lastTimerRaw = raw;
    const e = timerEvent(raw);
    if (e.payload.state) queue([e]);
  }, 2000);

  // ---- the problem ----
  // A Start clicked before LeetCode named the question goes without its id; the sitting's binding learns it
  // when it comes, so the foreign-question check holds for the rest of the sitting.
  function learnQuestionId(slug, questionId) {
    questionIds.set(slug, questionId);
    if (binding && binding.slug === slug && binding.questionId == null)
      saveBinding({ ...binding, questionId: String(questionId) }).catch(() => {});
  }
  function onProblem(slug, doc, questionId) {
    const fit = wire.fitProblem(doc, PROBLEM_MAX);
    if (!fit) return;
    problems.delete(slug); // a refetch is the newest
    problems.set(slug, fit);
    let out = null;
    for (const k of problems.keys()) {
      if (problems.size <= PROBLEMS_MAX) break;
      if (k === screenSlug) continue;
      problems.delete(k);
      out = k;
    }
    const on = slug === screenSlug;
    debug.log('doc.keep', { on, n: problems.size, out });
    if (!on) return; // its id rides on the doc itself (startBody, the hint check), so it goes when the doc does
    if (questionId) learnQuestionId(slug, questionId);
    if (state.phase !== 'hidden') paint();
    maybeFill();
  }
  // The doc LeetCode rendered into a fresh load's __NEXT_DATA__ (README → step 8), kept only when it names
  // the problem this document was loaded for — after an SPA nav the tag still holds the first problem's. It's
  // names and text only: never a question id (the hint check, learnQuestionId, the binding's id) — the one id
  // it may supply is the display-only frontendId (startBody) — and a fetched doc wins over it (docFor).
  function readPageDoc(when) {
    let text = null;
    try {
      text = document.getElementById('__NEXT_DATA__')?.textContent || null;
    } catch {}
    const chars = text ? text.length : 0;
    const doc = text && chars <= PAGE_DATA_MAX ? wire.pageProblem(text) : null;
    const match = !!doc && !!loadSlug && doc.titleSlug === loadSlug;
    const detail = match ? wire.fitProblemDetail(doc, PROBLEM_MAX) : null;
    const fit = detail && detail.doc;
    debug.log('pageDoc', {
      when,
      readyState: document.readyState,
      chars,
      found: !!doc,
      match,
      fields: doc ? Object.keys(doc).length : 0,
      fit: detail && detail.fit,
      cleaned: detail ? detail.cleaned : 0, // values A1 couldn't store, dropped (wire.cleanProblem)
    });
    if (!fit) return;
    pageDocs.set(loadSlug, fit);
    if (loadSlug === screenSlug && state.phase !== 'hidden') paint();
    maybeFill();
  }
  const docFor = (slug) => problems.get(slug) || pageDocs.get(slug) || null;
  // A1 fills in a sitting's problem doc on a repeat Start: one that came after the Start went (LeetCode
  // fetches it after a submit, and for Next from the old page before the click; the page's own may be read
  // after Start) goes once the sitting is active — when the doc arrives, or when the phase gets there. The
  // phase's try is once per sitting per page load, as a resume is: a page flipping its path must not turn each
  // return into a Start call.
  const filledOnActive = new Set();
  function maybeFill(onActive = false) {
    if (!binding || binding.slug !== screenSlug || binding.problemSent) return;
    if (state.phase !== 'active' || !docFor(screenSlug)) return;
    if (onActive && filledOnActive.has(binding.sittingId)) return;
    if (onActive) filledOnActive.add(binding.sittingId);
    lateFill();
  }
  let filling = false;
  async function lateFill() {
    if (filling) return;
    filling = true;
    const b = binding;
    const r = await send({
      type: 'start',
      body: startBody(b.clientSittingId, b.clientStartedAt),
    }).catch(() => null);
    filling = false;
    debug.log('fill', { ok: !!r && r.status === 200, http: r ? r.status : null });
    // The binding may have been rewritten meanwhile (learnQuestionId): mark the one still on this sitting.
    if (r && r.status === 200 && binding && binding.sittingId === b.sittingId)
      await saveBinding({ ...binding, problemSent: true });
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => readPageDoc('load'), { once: true });
  else readPageDoc('load');

  const humanize = (slug) =>
    slug
      .split('-')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ');
  const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  // A page-supplied id as text: only a string or number, so an object whose toString throws can't stall a Start.
  const scalar = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
  const slugify = (t) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s-]+/g, '-');
  // The problem's name: LeetCode's own doc, else the tab title only once it names this problem (after a
  // move to the next problem it still names the last one for a moment), else the slug — humanized, or as is
  // when that leaves only spaces (`/problems/-/`): A1 refuses a blank title.
  function titleFor(slug, dom = readDom()) {
    const doc = docFor(slug);
    const tab = dom.title && slugify(dom.title) === slug ? dom.title : null;
    return clip(doc && doc.title, 200) || tab || clip(humanize(slug), 200) || slug;
  }
  function readDom() {
    const title = clip((document.title || '').replace(/\s*-\s*LeetCode\s*$/i, ''), 200);
    let difficulty = null;
    try {
      const cands = [...document.querySelectorAll('div,span,a,button,p')].filter(
        (e) =>
          e.childElementCount === 0 && /^(Easy|Medium|Hard)$/.test((e.textContent || '').trim()),
      );
      const chosen = cands.find((e) => !e.closest('a')) || cands[0];
      if (chosen) difficulty = chosen.textContent.trim();
    } catch {}
    const tags = [];
    try {
      for (const a of document.querySelectorAll('a[href*="/tag/"]')) {
        const m = (a.getAttribute('href') || '').match(/\/tag\/([^/?#]+)/);
        const t = clip(a.textContent, 40) || (m ? clip(humanize(m[1]), 40) : null); // never blank
        if (t && !tags.includes(t)) tags.push(t);
      }
    } catch {}
    let lang = clip(q(sel.lang) && q(sel.lang).textContent, 40);
    if (!lang)
      try {
        lang = clip(JSON.parse(localStorage.getItem('global_lang') || 'null'), 40);
      } catch {}
    return { title, difficulty, topicTags: tags.length ? tags.slice(0, 20) : null, lang };
  }
  function solveSession(slug) {
    try {
      const s = JSON.parse(localStorage.getItem(`qd_solve_session:${slug}`) || 'null');
      return s ? clip(scalar(s.id), 80) : null; // blank → none, as A1 requires
    } catch {
      return null;
    }
  }
  function startBody(clientSittingId, startedAt, slug = screenSlug) {
    const fetched = problems.get(slug) || null; // the ids come from LeetCode's fetched doc only
    const doc = docFor(slug);
    const dom = readDom();
    const docTags =
      doc && Array.isArray(doc.topicTags)
        ? doc.topicTags.map((t) => clip(t && t.name, 40)).filter(Boolean)
        : null;
    const idOf = (v) => clip(scalar(v), 20);
    // The number LeetCode shows, for display only: the page's doc may supply it, digits only.
    const shown =
      (fetched && fetched.questionFrontendId) ?? (pageDocs.get(slug) || {}).questionFrontendId;
    const domFresh = !!dom.title && slugify(dom.title) === slug; // the page shows this problem, not the last
    return {
      clientSittingId,
      problemSlug: slug,
      problemTitle: titleFor(slug, dom),
      questionId: idOf((fetched && fetched.questionId) ?? questionIds.get(slug)),
      frontendId: /^\d{1,6}$/.test(scalar(shown) ?? '') ? scalar(shown) : null,
      difficulty: clip(doc && doc.difficulty, 20) || (domFresh ? dom.difficulty : null),
      topicTags: docTags && docTags.length ? docTags.slice(0, 20) : domFresh ? dom.topicTags : null,
      lang: dom.lang || 'python3',
      startedAt,
      tzOffsetMinutes: new Date().getTimezoneOffset(),
      lcSolveSessionId: solveSession(slug),
      problem: wire.fitProblem(doc, PROBLEM_MAX),
    };
  }

  // ---- the binding ----
  async function saveBinding(b) {
    binding = b;
    await local.set({ [`sitting:${b.slug}`]: b });
  }
  async function clearBinding() {
    const slug = (binding && binding.slug) || screenSlug;
    binding = null;
    sync = null;
    if (slug) await local.remove([`sitting:${slug}`, `sync:${slug}`]);
  }

  // ---- Start: the server → LeetCode's reset → its confirm → its timer (a refusal touches nothing) ----
  const STEP = {
    async reset() {
      if (!sel.editorReset)
        return 'LeetCode’s reset button isn’t configured (Options → Selectors).';
      const b = q(sel.editorReset);
      if (!b) return 'Couldn’t find LeetCode’s reset button (editorReset).';
      b.click();
      return (await waitFor(() => q(sel.dialog), 1500))
        ? true
        : 'LeetCode didn’t ask to confirm the reset.';
    },
    async confirm() {
      if (!sel.resetConfirm)
        return 'The reset’s confirm button isn’t configured (Options → Selectors).';
      const b = await waitFor(() => q(sel.resetConfirm), 1500);
      if (!b) return 'Couldn’t find the reset’s confirm button (resetConfirm).';
      b.click();
      return (await waitFor(() => !q(sel.dialog), 1500))
        ? true
        : 'LeetCode didn’t confirm the reset.';
    },
    async timer() {
      const path = {};
      try {
        return await timerStep(path);
      } finally {
        debug.log('timer', path); // every exit: a failed Safari run is where the path matters most
      }
    },
  };
  // LeetCode's controls differ by its timer's state, so the step reads the state, not a fixed click list:
  // running or paused → its Reset; then, if LeetCode asks (the pop-up of the toolbar logged 2026-11-10), the
  // pop-up's Reset — the toolbar logged 2026-11-14 resets straight to idle; then Start (the pop-up's, still
  // showing after a reset, or the toolbar's own, else the idle opener first) in whichever mode LeetCode last
  // used. At most four clicks, no loop on page state, and a Retry picks up from wherever a half-done try left
  // it. `path` records the way it took.
  function readTimer() {
    try {
      return timer.parseTimerState(localStorage.getItem(timer.KEY), Date.now());
    } catch {
      return null;
    }
  }
  async function timerStep(path) {
    const { timerOpen, timerStart, timerReset, timerResetConfirm } = sel;
    if (!timerOpen || !timerStart || !timerReset || !timerResetConfirm)
      return 'LeetCode’s timer isn’t configured (Options → Selectors).';
    const before = readTimer();
    path.status = clip(before && before.status, 20);
    path.mode = clip(before && before.mode, 20);
    const idle = () => !timer.needsReset(readTimer());
    let settle = 0;
    if (timer.needsReset(before)) {
      let confirm = q(timerResetConfirm); // a Retry may find LeetCode's pop-up still open and asking
      if (!confirm) {
        const r = q(timerReset);
        if (!r) return 'Couldn’t find LeetCode’s timer reset (timerReset).';
        r.click();
        // Asked to confirm (its pop-up), or reset already (no pop-up; ~0.6 s in debug log 11).
        const next = await waitFor(() => q(timerResetConfirm) || (idle() && 'idle'), 3000);
        if (!next)
          return 'LeetCode’s timer didn’t reset or ask to confirm (timerReset, timerResetConfirm).';
        confirm = next === 'idle' ? null : next;
      }
      if (confirm) {
        confirm.click();
        path.confirmed = true;
        if (!(await waitFor(idle, 1500))) return 'LeetCode’s timer didn’t reset.';
      }
      path.reset = true;
      settle = 1000; // the pop-up swaps its Reset for Start; the toolbar's clock turns Start
    }
    let start = await waitFor(() => q(timerStart), settle);
    if (!start) {
      const open = q(timerOpen);
      if (!open) return 'Couldn’t find LeetCode’s timer (timerOpen).';
      open.click();
      path.opened = true;
      start = await waitFor(() => q(timerStart), 1500);
      if (!start) return 'Couldn’t find the timer’s Start button (timerStart).';
    }
    start.click();
    path.started = true;
    const fresh = () => timer.startedFresh(readTimer());
    return (await waitFor(fresh, 1500)) ? true : 'LeetCode’s timer didn’t start.';
  }

  async function runStep(step) {
    if (step === 'send')
      return sendStart().catch((err) =>
        act({ type: 'stepFail', step: 'send', reason: String((err && err.message) || err) }),
      );
    let r;
    try {
      r = await STEP[step]();
    } catch (err) {
      r = String((err && err.message) || err);
    }
    debug.log('step', { step, ok: r === true, reason: r === true ? null : r });
    if (r === true) act({ type: 'stepOk', step });
    else {
      debug.dumpControls();
      act({ type: 'stepFail', step, reason: r });
    }
  }

  function refusal(r) {
    if (r.status === -1) return r.error;
    if (r.status === 401) return 'Aperture refused the device token — check it in Options.';
    if (r.error === ACTIVE_ERROR) return `${r.error} Then Retry.`;
    return r.error || `Start failed (HTTP ${r.status}).`;
  }
  // The Start is for the problem it was clicked on: a nav away mid-send stops it acting on this page, and a
  // sitting Aperture opened meanwhile is still bound to its own problem, so going back resumes it.
  async function sendStart() {
    const start = pendingStart;
    const slug = start.slug;
    const stale = () => screenSlug !== slug || pendingStart !== start;
    await chain; // what LeetCode already sent (the question id, its problem doc) is read before the body
    if (!docFor(slug)) readPageDoc('start');
    const deadline = Date.now() + START_RETRY_MS;
    for (let tries = 0; ; tries++) {
      if (stale()) return;
      const body = startBody(start.clientSittingId, start.startedAt, slug);
      const r = await send({ type: 'start', body }).catch((err) => ({
        status: 0,
        error: extensionGone()
          ? 'the extension was reloaded — reload this page'
          : String((err && err.message) || err),
      }));
      const s = r.status === 200 && r.json && r.json.sitting;
      if (s && s.status === 'active' && s.problemSlug === slug) {
        const b = {
          slug,
          sittingId: s.id,
          clientSittingId: s.clientSittingId,
          questionId: s.questionId || body.questionId,
          clientStartedAt: s.clientStartedAt,
          title: s.problemTitle,
          problemSent: !!body.problem,
        };
        await local.set({
          [`sitting:${slug}`]: b,
          [`sync:${slug}`]: { sittingId: s.id, status: 'active', at: Date.now() },
        });
        if (stale()) {
          // Back on this problem already (A → B → A mid-send), read before this landed: read it again.
          if (screenSlug === slug && !binding) navTo(slug);
          return;
        }
        binding = b;
        sync = { sittingId: s.id, status: 'active' };
        lastTimerRaw = null;
        pendingStart = null;
        debug.log('start', { ok: true, resumed: !!r.json.resumed });
        return act({ type: 'stepOk', step: 'send' }); // the binding is saved: a reload mid-reset resumes
      }
      if (stale()) return;
      if (s) {
        pendingStart = null; // the next try mints a fresh id
        return act({
          type: 'stepFail',
          step: 'send',
          reason:
            s.status === 'active'
              ? `Aperture has a sitting open for ${s.problemSlug} under this Start — end it in Aperture, then Retry.`
              : 'That sitting has already ended — Retry starts a new one.',
        });
      }
      lastStartRetryable = r.status !== -1 && outbox.retryable(r.status);
      debug.log('start', { ok: false, http: r.status });
      if (lastStartRetryable && Date.now() < deadline) {
        act({ type: 'retrying', reason: r.error || `HTTP ${r.status}` });
        await sleep(Math.min(2000 * 2 ** tries, 15_000));
        continue;
      }
      return act({ type: 'stepFail', step: 'send', reason: refusal(r) });
    }
  }

  // A throw (storage full, say) keeps the binding: the same rule as no answer.
  function resume() {
    return resumeOnce().catch((err) => {
      debug.log('resume', { active: true, error: String((err && err.message) || err) });
      if (state.phase === 'resuming') act({ type: 'resumed', active: true });
    });
  }
  // Once per sitting per page load: a page flipping the path back and forth (pushState) must not turn into
  // a stream of Start calls. Later visits trust the binding; an end still arrives through sync:<slug>.
  const resumed = new Set();
  async function resumeOnce() {
    const b = binding;
    if (resumed.has(b.sittingId)) return act({ type: 'resumed', active: true });
    resumed.add(b.sittingId);
    const body = startBody(b.clientSittingId, b.clientStartedAt);
    const r = await send({ type: 'start', body }).catch(() => ({ status: 0 }));
    if (binding !== b) return;
    const s = r.status === 200 && r.json && r.json.sitting;
    if (s) {
      const active = s.status === 'active' && s.problemSlug === screenSlug;
      if (active)
        await saveBinding({
          ...b,
          sittingId: s.id,
          problemSent: b.problemSent || !!body.problem,
        });
      debug.log('resume', { active });
      return act({ type: 'resumed', active });
    }
    // Only Aperture saying the sitting is over ends it. Anything else — unreachable, a 401 after a token
    // change, a 404 — keeps the binding: clearing it would re-prompt mid-solve, one click from a reset; the
    // outbox holds the events and the badge shows why they wait.
    const over =
      r.status === 400 && (r.error === outbox.ENDED_ERROR || r.error === START_TIME_ERROR);
    debug.log('resume', { active: !over, http: r.status });
    act({ type: 'resumed', active: !over });
  }

  // Done is marked in Aperture, away from this tab, and an end otherwise arrives only with the next send:
  // coming back sends LeetCode's timer reading (at most every 15 s; nothing when LeetCode has none), and
  // Aperture's answer to that send says whether the sitting is still open. Not a repeat Start: those count
  // against the day's Start attempts. Coming back also tries any stuck hand-offs again.
  const RECHECK_MS = 15_000;
  let lastRecheck = 0;
  function recheck() {
    retryStuck();
    if (rereading()) rereadSync().then(paintBadge, () => {});
    if (!timing() || Date.now() - lastRecheck < RECHECK_MS) return;
    const raw = timerRaw();
    const e = raw && timerEvent(raw);
    if (!e || !e.payload.state) return; // no reading to send: the next send learns of an end instead
    lastRecheck = Date.now();
    queue([e]);
    flushNow();
  }
  window.addEventListener('focus', (e) => e.isTrusted && recheck());

  // ---- the coach (lib/coach.js): the trace card at the first Submit, the resubmit note ----
  // Its per-sitting state rides on the binding (`coach`: config sent, the trace's outcome, whether the hold
  // fired), so a reload never asks twice. The last verdict and the card are this page's only.
  let lastVerdict = null; // {at, verdict} of the last judged submit on this sitting
  let cardAt = null; // when the card opened; null while closed
  let note = null; // {text, until}: a short line on the badge
  const coachState = () => (binding && binding.coach) || {};
  const sittingOpen = () =>
    state.phase === 'active' && !!liveBinding() && bindingStatus() === 'active';
  function setCoach(patch) {
    if (!binding) return;
    saveBinding({ ...binding, coach: { ...coachState(), ...patch } }).catch(() => {});
  }
  const sendCoach = (payload, at = Date.now()) => queue([coachLib.event(payload, mintId, at)]);
  const flash = (text) => {
    note = { text, until: Date.now() + coachLib.NOTE_MS };
    paintBadge();
    setTimeout(paintBadge, coachLib.NOTE_MS + 50);
  };
  // Once a sitting, as it goes active (a Start, or a resume of one opened before this version): what was on.
  function coachConfig() {
    if (!binding || coachState().config) return;
    sendCoach(coachLib.configPayload(coachOn));
    setCoach({ config: true });
  }
  function openCard() {
    if (!sittingOpen() || coachState().trace || cardAt != null) return;
    cardAt = Date.now();
    view.renderCard(true);
    paintBadge();
  }
  function closeCard(how) {
    if (cardAt == null) return;
    const { keys } = view.cardState();
    debug.log('card', { how, ms: Date.now() - cardAt, keys }); // the probe: did typing land (overlay.js)
    cardAt = null;
    view.renderCard(false);
    paintBadge();
  }
  // Trace or Skip from the card (a trace with nothing typed is a Skip).
  function finishCard(values) {
    if (cardAt == null || !binding) return;
    const payload = coachLib.cardPayload(values, Date.now() - cardAt);
    sendCoach(payload);
    setCoach({ trace: payload.kind === 'trace' ? 'traced' : 'skipped' });
    closeCard(payload.kind);
    flash('now click Submit');
  }
  // A real click on LeetCode's Submit, in the capture phase at the window — ahead of React's root listener.
  // The first one in a sitting is held (no request is made) and the card shown; he clicks Submit again
  // himself. A page script's click() is never held. Submit by keyboard never passes here: it is logged when
  // its submit arrives (onSubmitItem).
  window.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      let hit = null;
      try {
        hit = sel.submit && e.target && e.target.closest ? e.target.closest(sel.submit) : null;
      } catch {}
      if (!hit || !sittingOpen()) return;
      const c = coachState();
      // With the card open, this Submit takes what's typed as the trace (nothing typed: just closes it).
      if (cardAt != null) {
        const { values } = view.cardState();
        if (coachLib.cardPayload(values, 0).kind === 'trace') return finishCard(values);
        return closeCard('submit');
      }
      if (coachLib.shouldHold({ settings: coachOn, trusted: true, active: true, coach: c })) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setCoach({ held: true });
        debug.log('hold', { at: Date.now() });
        return openCard();
      }
      const gap = coachLib.nudgeGap({ settings: coachOn, last: lastVerdict, now: Date.now() });
      if (gap == null) return;
      lastVerdict = null; // one note per failed verdict
      sendCoach({ kind: 'nudge-shown', gapMs: gap });
      flash('trace the failing input before you resubmit');
    },
    true,
  );
  // A submit LeetCode judged, for the open sitting: the verdict the next Submit's note reads, and — when
  // nothing was traced or skipped before it — an untraced submit (a keyboard submit, the hold off, the
  // Submit not found, or a second click past the card).
  function onSubmitItem(m) {
    const verdict = coachLib.verdictOf(m.payload);
    lastVerdict = verdict ? { at: Date.now(), verdict } : null;
    if (coachState().trace) return;
    // The probe for a hold that didn't hold: a submit while the card is still up came past it.
    if (cardAt != null) debug.log('hold.leak', { ms: Date.now() - cardAt });
    closeCard('submitted');
    sendCoach({ kind: 'untraced-submit' }, m.at);
    setCoach({ trace: 'untraced' });
  }

  // ---- the overlay ----
  const view = NS.overlay.create({
    start: () => begin('start'),
    retry: () => begin('retry'),
    continue: () => act({ type: 'continue' }),
    dismiss: () => act({ type: 'dismiss' }),
    reopen: () => reopen(),
    trace: (values) => finishCard(values),
    skip: () => finishCard({}),
    openCard: () => openCard(),
  });
  // The pill on a dismissed problem. A sitting still open for it (opened meanwhile in another tab) resumes
  // instead of prompting: the nav reads the binding. One already over (by bindingStatus's rule) prompts.
  async function reopen() {
    const slug = screenSlug;
    const still = () => state.phase === 'hidden' && state.slug === slug && screenSlug === slug;
    if (!slug || !still()) return;
    const got = await local.get([`sitting:${slug}`, `sync:${slug}`]).catch(() => null);
    if (!still()) return;
    const b = got && got[`sitting:${slug}`];
    const s = got && got[`sync:${slug}`];
    const over = b && s && s.sittingId === b.sittingId && s.status && s.status !== 'active';
    if (b && !over) {
      // Forgotten here too: once that sitting ends, the next visit prompts rather than showing the pill.
      send({ type: 'undismiss', slug }).catch(() => {});
      return navTo(slug);
    }
    act({ type: 'reopen' });
  }
  // A retryable failure on this problem keeps the id and sends this click's time; if the first try had in
  // fact landed, the server resumes that sitting and keeps its own (first) time.
  function begin(type) {
    if (type === 'retry' && state.open) {
      // The sitting exists: repeat the click step — from the reset if LeetCode's dialog has gone meanwhile.
      const from = state.step === 'confirm' && !q(sel.dialog) ? 'reset' : state.step;
      return act({ type, from });
    }
    pendingStart =
      pendingStart && lastStartRetryable && pendingStart.slug === screenSlug
        ? { ...pendingStart, startedAt: Date.now() }
        : { slug: screenSlug, clientSittingId: mintId(), startedAt: Date.now() };
    lastStartRetryable = false;
    act({ type });
  }
  function act(action) {
    const from = state.phase;
    const r = overlayState.reduce(state, action);
    state = r.state;
    if (from !== state.phase || action.type !== 'retrying')
      debug.log('overlay', { action: action.type, from, to: state.phase, step: state.step });
    paint();
    if (from !== 'active' && state.phase === 'active') {
      maybeFill(true);
      coachConfig();
    }
    if (state.phase !== 'active') closeCard('left');
    for (const e of r.effects) {
      if (e.do === 'step') runStep(e.step);
      else if (e.do === 'resume') resume();
      else if (e.do === 'rememberDismiss')
        send({ type: 'dismiss', slug: state.slug }).catch(() => {});
      else if (e.do === 'forgetDismiss')
        send({ type: 'undismiss', slug: state.slug }).catch(() => {});
      else if (e.do === 'clearBinding') clearBinding();
    }
  }
  function paint() {
    const dom = readDom();
    view.render(state, {
      title: screenSlug ? titleFor(screenSlug, dom) : dom.title,
      lang: dom.lang,
    });
    paintBadge();
  }
  let badgeTone = '';
  function setBadge(text, tone, action) {
    badgeTone = tone || '';
    view.setBadge(text, badgeTone, action);
  }
  const ago = (ms) =>
    ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60_000)}m ago`;
  function paintBadge() {
    const waiting = stuck.length + unstuck > 0;
    if (waiting && extensionGone())
      return setBadge('Aperture · the extension was reloaded — reload this page', 'bad');
    if (waiting)
      return setBadge(
        'Aperture · events waiting to reach the extension — retrying, keep this tab open',
        'bad',
      );
    if (state.phase === 'ended') return setBadge('Aperture · Sitting ended in Aperture', '');
    // Hidden with a slug is a dismissed problem (overlay-state): its way back.
    if (state.phase === 'hidden' && state.slug && state.slug === screenSlug)
      return setBadge('Aperture · Start a sitting', '', 'reopen');
    if (state.phase !== 'active' || !binding) return setBadge(null);
    const now = Date.now();
    const mins = Math.max(0, Math.floor((now - binding.clientStartedAt) / 60_000));
    const head = `Aperture · ${mins}m`;
    const st = status || {};
    if (st.paused === 'auth')
      return setBadge(`${head} · rejected: 401 — check the token in Options`, 'bad');
    if (st.paused === 'config')
      return setBadge(`${head} · not configured — set the token in Options`, 'bad');
    if (st.failed) return setBadge(`${head} · refused: ${st.detail || 'see Options'}`, 'bad');
    if (st.state === 'retrying')
      return setBadge(
        `${head} · retrying (${st.http || 'offline'}) · ${st.queued || 0} queued`,
        'warn',
      );
    const last = sync && sync.sittingId === binding.sittingId && sync.lastSyncAt;
    const synced = last ? `synced ${ago(now - last)}` : 'waiting for the first sync';
    if (note && note.until > now) return setBadge(`${head} · ${note.text}`, '');
    note = null;
    // Before the trace: the card's opener, and a word when the hold can't find LeetCode's Submit.
    const untraced = coachOn.trace && !coachState().trace && cardAt == null;
    const lost = untraced && coachOn.hold && !coachState().held && !q(sel.submit);
    setBadge(
      `${head} · ${synced}${lost ? ' · trace card off: Submit not found' : ''}`,
      '',
      untraced ? 'trace' : null,
    );
  }
  // The repaint never waits on the read: a reloaded extension's storage may never answer.
  setInterval(() => {
    if (state.phase === 'active') paintBadge();
    if (!rereading() || extensionGone()) return;
    rereadSync().then(
      () => state.phase === 'active' && paintBadge(),
      () => {},
    );
  }, 5000);

  // ---- navigation (LeetCode is a single-page app): this world's own location, never a page message ----
  // One nav at a time: a second call for the same path (the poll, a popstate and a page message can all
  // notice it) waits for the one in flight, so nobody reads a half-loaded binding.
  let navDone = Promise.resolve();
  function onNav() {
    const slug = relayLib.slugOf(location.pathname);
    if (navigated && slug === screenSlug) return navDone;
    navDone = navTo(slug);
    return navDone;
  }
  async function navTo(slug) {
    navigated = true;
    flushNow(); // the old problem's events go first
    screenSlug = slug;
    pendingStart = null; // a Start in flight stops acting on this page (sendStart checks)
    binding = null;
    sync = null;
    lastTimerRaw = null;
    lastVerdict = null;
    closeCard('nav');
    paintBadge(); // the last problem's pill or badge goes now, not after the reads below
    if (!slug) return act({ type: 'nav', slug: null });
    const got = await local.get([`sitting:${slug}`, `sync:${slug}`]);
    if (screenSlug !== slug) return;
    binding = got[`sitting:${slug}`] || null;
    sync = got[`sync:${slug}`] || null;
    if (binding && bindingStatus() !== 'active') await clearBinding();
    // A sitting started before LeetCode named the question learns its id from the doc fetched while away
    // (onProblem keeps an off-screen doc but learns nothing from it). The fetched doc wins, as on the hint path.
    const keptId = binding && binding.questionId == null && scalar(problems.get(slug)?.questionId);
    if (keptId) learnQuestionId(slug, keptId);
    const dismissed = binding
      ? false
      : !!((await send({ type: 'dismissed?', slug }).catch(() => null)) || {}).dismissed;
    if (screenSlug !== slug) return;
    debug.log('nav', { slug, bound: !!binding, dismissed });
    act({ type: 'nav', slug, binding: binding && { status: 'active' }, dismissed });
  }
  let lastPath = null;
  let lastTitle = null;
  setInterval(() => {
    view.ensureAttached();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      onNav();
    }
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      if (state.phase !== 'hidden') paint();
    }
  }, 500);
  window.addEventListener('popstate', (e) => {
    if (!e.isTrusted) return; // a page's synthetic popstate waits for the poll
    lastPath = location.pathname;
    onNav();
  });

  // ---- what the background and Options change ----
  // The background's word on the sitting (sync:<slug>) and the outbox (status).
  function learnSync(next) {
    sync = next || null;
    if (
      binding &&
      bindingStatus() !== 'active' &&
      (state.phase === 'active' || state.phase === 'resuming' || state.open)
    )
      act({ type: 'ended' });
  }
  // A probe for the next Safari session: which change events this page gets at all (its own debug-log writes
  // are only counted — logging them would loop), and whether it was restored from the back/forward cache.
  const pageId = mintId().slice(-6);
  let ownLogChanges = 0;
  debug.log('oc.reg', { pageId, readyState: document.readyState });
  api.storage.onChanged.addListener((changes, area) => {
    const keys = Object.keys(changes || {}).filter((k) => k !== 'debugLog');
    if (!keys.length) return void ownLogChanges++;
    debug.log('oc', { pageId, area: String(area), keys: keys.slice(0, 8), ownLogChanges });
  });
  window.addEventListener('pageshow', (e) =>
    debug.log('pageshow', { pageId, persisted: e.persisted }),
  );
  api.storage.onChanged.addListener((changes, area) => {
    if (area && area !== 'local') return; // Safari has passed no area name (WebKit bug 281644)
    if (changes.selectors) sel = selLib.merge(changes.selectors.newValue);
    if (Object.values(coachLib.KEYS).some((k) => changes[k]))
      local.get(Object.values(coachLib.KEYS)).then((got) => (coachOn = coachLib.settingsOf(got)), () => {});
    if (changes.status) status = changes.status.newValue || null;
    const k = screenSlug && `sync:${screenSlug}`;
    if (k && changes[k]) learnSync(changes[k].newValue);
    if (state.phase === 'active') paintBadge();
  });
  // Safari evidently doesn't always tell this page about the background's writes (2026-11-10: the server took
  // the events, yet the badge stayed on "waiting for the first sync" and never said the sitting ended), so
  // while a sitting is open the page also reads them itself, every 5 s. The debug log says when a read finds
  // what no change event brought (`sync.reread`).
  function rereading() {
    return state.phase === 'active' || state.phase === 'resuming' || state.open;
  }
  async function rereadSync() {
    const slug = screenSlug;
    const k = `sync:${slug}`;
    const got = await Promise.resolve()
      .then(() => local.get([k, 'status']))
      .catch(() => null);
    if (!got || screenSlug !== slug || !rereading()) return;
    status = got.status || null;
    const next = got[k] || null;
    if (JSON.stringify(next) === JSON.stringify(sync)) return;
    debug.log('sync.reread', { status: next && next.status, synced: !!(next && next.lastSyncAt) });
    learnSync(next);
  }

  local.get(['selectors', 'status', ...Object.values(coachLib.KEYS)]).then(
    (got) => {
      sel = selLib.merge(got.selectors);
      coachOn = coachLib.settingsOf(got);
      status = got.status || null;
      lastPath = location.pathname;
      onNav();
    },
    () => {
      lastPath = location.pathname;
      onNav();
    },
  );
})();
