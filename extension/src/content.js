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
  const { relay: relayLib, overlayState, selectors: selLib, timer, wire, outbox, batch } = NS;
  const debug = NS.debug || { log() {}, dumpControls() {} };
  const mintId = NS.ulid.ulid;
  // packages/shared/src/sittings.ts SITTING_ACTIVE_ERROR (background.test.ts checks the copy).
  const ACTIVE_ERROR = 'Another sitting is still open — end it in Aperture first.';
  const START_TIME_ERROR = 'The Start’s time is off by more than a day.';
  const PENDING_MAX = 500; // page messages waiting for the relay; past it a flood is dropped
  const bootState = document.readyState; // Safari may run document_start late — the debug log says
  const PROBLEM_MAX = 64 * 1024;
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
  let pendingStart = null; // {slug, clientSittingId, startedAt} for the Start in progress
  let lastStartRetryable = false;
  const problems = new Map(); // slug → LeetCode's questionDetail.question, this page load
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
    debug.log('wire', {
      items: items.map((i) => i.kind),
      bytes: (raw.reqText || '').length + (raw.resText || '').length,
    });
    items.forEach(onItem);
  }
  function onItem(m) {
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
    if (m.kind === 'problem') return onProblem(m.slug, m.payload, m.questionId);
    if (m.kind === 'hint') {
      // A hint (syncedCode) names no slug, so it may be a late answer for the last problem: it's taken only
      // when no id is known yet and the problem doc, if any, agrees.
      const doc = problems.get(screenSlug);
      const docId = doc && doc.questionId != null ? String(doc.questionId) : null;
      if (
        m.questionId &&
        !questionIds.has(screenSlug) &&
        (!docId || docId === String(m.questionId))
      )
        learnQuestionId(screenSlug, m.questionId);
      return;
    }
    queue(wire.toEventInputs(m, mintId));
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
    send({ type: 'enqueue', sittingId: b.sittingId, slug, events }).catch(() => {});
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
  function flushNow() {
    clearTimeout(flushTimer);
    flushTimer = null;
    ship(batcher.flush());
  }
  function ship(events) {
    if (!events.length || !binding) return;
    send({ type: 'enqueue', sittingId: binding.sittingId, slug: binding.slug, events }).catch(
      (err) => {
        debug.log('enqueue.fail', { error: String(err && err.message) });
        setBadge('Aperture · the extension was reloaded — reload this page', 'bad');
      },
    );
  }
  window.addEventListener('pagehide', flushNow);
  document.addEventListener(
    'visibilitychange',
    () => document.visibilityState === 'hidden' && flushNow(),
  );

  // LeetCode's timer, read from its own localStorage (shared with this world) every 2 s while a sitting is
  // active — not while Start is still clicking, when it would still hold the last solve's state.
  setInterval(() => {
    if (state.phase !== 'active' || !liveBinding() || bindingStatus() !== 'active') return;
    let raw = null;
    try {
      raw = localStorage.getItem(timer.KEY);
    } catch {}
    if (!raw || raw === lastTimerRaw || raw.length > 900) return;
    lastTimerRaw = raw;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    let heartbeat = null;
    try {
      heartbeat = String(localStorage.getItem(timer.HEARTBEAT_KEY) || '').slice(0, 64) || null;
    } catch {}
    queue([{ id: mintId(), type: 'timer', at: Date.now(), payload: { state: parsed, heartbeat } }]);
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
    if (!doc || wire.bytes(JSON.stringify(doc)) > PROBLEM_MAX) return;
    problems.set(slug, doc);
    if (questionId) learnQuestionId(slug, questionId);
    // A1 fills in a sitting's problem doc on a repeat Start: LeetCode only sends it after a submit or a nav.
    if (binding && binding.slug === slug && !binding.problemSent && state.phase === 'active')
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
    if (r && r.status === 200 && binding === b) await saveBinding({ ...b, problemSent: true });
  }

  const humanize = (slug) =>
    slug
      .split('-')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(' ');
  const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
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
        const t = clip(a.textContent, 40) || (m ? humanize(m[1]).slice(0, 40) : null);
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
      return s && s.id != null ? String(s.id).slice(0, 80) : null;
    } catch {
      return null;
    }
  }
  function startBody(clientSittingId, startedAt, slug = screenSlug) {
    const doc = problems.get(slug) || null;
    const dom = readDom();
    const docTags =
      doc && Array.isArray(doc.topicTags)
        ? doc.topicTags.map((t) => clip(t && t.name, 40)).filter(Boolean)
        : null;
    const idOf = (v) => (v == null ? null : clip(String(v), 20));
    return {
      clientSittingId,
      problemSlug: slug,
      problemTitle: clip(doc && doc.title, 200) || dom.title || humanize(slug),
      questionId: idOf((doc && doc.questionId) ?? questionIds.get(slug)),
      frontendId: idOf(doc && doc.questionFrontendId),
      difficulty: clip(doc && doc.difficulty, 20) || dom.difficulty,
      topicTags: docTags && docTags.length ? docTags.slice(0, 20) : dom.topicTags,
      lang: dom.lang || 'python3',
      startedAt,
      tzOffsetMinutes: new Date().getTimezoneOffset(),
      lcSolveSessionId: solveSession(slug),
      problem: doc,
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
        return 'LeetCode’s reset button isn’t configured yet (Options → Selectors).';
      const b = q(sel.editorReset);
      if (!b) return 'Couldn’t find LeetCode’s reset button.';
      b.click();
      return (await waitFor(() => q(sel.dialog), 1500))
        ? true
        : 'LeetCode didn’t ask to confirm the reset.';
    },
    async confirm() {
      if (!sel.resetConfirm)
        return 'The reset’s confirm button isn’t configured yet (Options → Selectors).';
      const b = await waitFor(() => q(sel.resetConfirm), 1500);
      if (!b) return 'Couldn’t find the reset’s confirm button.';
      b.click();
      return (await waitFor(() => !q(sel.dialog), 1500))
        ? true
        : 'LeetCode didn’t confirm the reset.';
    },
    async timer() {
      if (!sel.timerClicks.length)
        return 'LeetCode’s timer start isn’t configured yet (Options → Selectors).';
      for (const s of sel.timerClicks) {
        const b = await waitFor(() => q(s), 1500);
        if (!b) return 'Couldn’t find LeetCode’s timer control.';
        b.click();
        await sleep(150);
      }
      const fresh = () => {
        try {
          return timer.startedFresh(
            timer.parseTimerState(localStorage.getItem(timer.KEY), Date.now()),
          );
        } catch {
          return false;
        }
      };
      return (await waitFor(fresh, 1500)) ? true : 'LeetCode’s timer didn’t start.';
    },
  };

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
    const deadline = Date.now() + START_RETRY_MS;
    for (let tries = 0; ; tries++) {
      if (stale()) return;
      const body = startBody(start.clientSittingId, start.startedAt, slug);
      const r = await send({ type: 'start', body }).catch(() => ({
        status: 0,
        error: 'the extension was reloaded — reload this page',
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
    const r = await send({
      type: 'start',
      body: startBody(b.clientSittingId, b.clientStartedAt),
    }).catch(() => ({ status: 0 }));
    if (binding !== b) return;
    const s = r.status === 200 && r.json && r.json.sitting;
    if (s) {
      const active = s.status === 'active' && s.problemSlug === screenSlug;
      if (active)
        await saveBinding({
          ...b,
          sittingId: s.id,
          problemSent: b.problemSent || !!problems.get(screenSlug),
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

  // ---- the overlay ----
  const view = NS.overlay.create({
    start: () => begin('start'),
    retry: () => begin('retry'),
    continue: () => act({ type: 'continue' }),
    dismiss: () => act({ type: 'dismiss' }),
  });
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
    for (const e of r.effects) {
      if (e.do === 'step') runStep(e.step);
      else if (e.do === 'resume') resume();
      else if (e.do === 'rememberDismiss')
        send({ type: 'dismiss', slug: state.slug }).catch(() => {});
      else if (e.do === 'clearBinding') clearBinding();
    }
  }
  function paint() {
    const dom = readDom();
    view.render(state, {
      title: (problems.get(screenSlug) || {}).title || dom.title,
      lang: dom.lang,
    });
    paintBadge();
  }
  let badgeTone = '';
  function setBadge(text, tone) {
    badgeTone = tone || '';
    view.setBadge(text, badgeTone);
  }
  const ago = (ms) =>
    ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : `${Math.round(ms / 60_000)}m ago`;
  function paintBadge() {
    if (state.phase === 'ended') return setBadge('Aperture · Sitting ended in Aperture', '');
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
    setBadge(`${head} · ${last ? `synced ${ago(now - last)}` : 'waiting for the first sync'}`, '');
  }
  setInterval(() => {
    if (state.phase === 'active') paintBadge();
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
    if (!slug) return act({ type: 'nav', slug: null });
    const got = await local.get([`sitting:${slug}`, `sync:${slug}`]);
    if (screenSlug !== slug) return;
    binding = got[`sitting:${slug}`] || null;
    sync = got[`sync:${slug}`] || null;
    if (binding && bindingStatus() !== 'active') await clearBinding();
    const dismissed = binding
      ? false
      : !!((await send({ type: 'dismissed?', slug }).catch(() => null)) || {}).dismissed;
    if (screenSlug !== slug) return;
    debug.log('nav', { slug, bound: !!binding, dismissed });
    act({ type: 'nav', slug, binding: binding && { status: 'active' }, dismissed });
  }
  let lastPath = null;
  setInterval(() => {
    view.ensureAttached();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      onNav();
    }
  }, 500);
  window.addEventListener('popstate', (e) => {
    if (!e.isTrusted) return; // a page's synthetic popstate waits for the poll
    lastPath = location.pathname;
    onNav();
  });

  // ---- what the background and Options change ----
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.selectors) sel = selLib.merge(changes.selectors.newValue);
    if (changes.status) status = changes.status.newValue || null;
    const k = screenSlug && `sync:${screenSlug}`;
    if (k && changes[k]) {
      sync = changes[k].newValue || null;
      if (
        binding &&
        bindingStatus() !== 'active' &&
        (state.phase === 'active' || state.phase === 'resuming' || state.open)
      )
        act({ type: 'ended' });
    }
    if (state.phase === 'active') paintBadge();
  });

  local.get(['selectors', 'status']).then(
    (got) => {
      sel = selLib.merge(got.selectors);
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
