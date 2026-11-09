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
  const { relay: relayLib, overlayState, selectors: selLib, timer, wire, outbox } = NS;
  const debug = NS.debug || { log() {}, dumpControls() {} };
  const mintId = NS.ulid.ulid;
  // packages/shared/src/sittings.ts SITTING_ACTIVE_ERROR (background.test.ts checks the copy).
  const ACTIVE_ERROR = 'Another sitting is still open — end it in Aperture first.';
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
  let pendingStart = null; // {clientSittingId, startedAt} for the Start in progress
  let lastStartRetryable = false;
  const problems = new Map(); // slug → LeetCode's questionDetail.question, this page load
  const questionIds = new Map(); // slug → questionId (from syncedCode)
  let buffer = [];
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
  window.addEventListener('aperture-lc-hello', (e) => {
    const ok = relay.hello(e.detail);
    debug.log('hello.recv', { type: typeof e.detail, len: String(e.detail).length, accepted: !!ok });
    if (!ok) return;
    window.dispatchEvent(new CustomEvent('aperture-lc-ack')); // same tick: no page script can get between
    ok.then((good) => debug.log('handshake', { ok: good }));
  });
  window.dispatchEvent(new CustomEvent('aperture-lc-ready'));
  debug.log('ready.sent', {});

  // ---- page messages, one at a time ----
  let chain = Promise.resolve();
  window.addEventListener('aperture-lc', (e) => {
    const detail = e.detail;
    chain = chain.then(() => onPageMessage(detail)).catch(() => {});
  });
  async function onPageMessage(detail) {
    const r = await relay.accept(detail, { screenSlug, binding: liveBinding() });
    if (!r.ok) {
      if (r.reason !== 'no-sitting') debug.log('relay.reject', { reason: r.reason });
      return;
    }
    const m = r.msg;
    debug.log('wire', {
      kind: m.kind,
      slug: m.slug,
      bytes: typeof detail === 'string' ? detail.length : 0,
    });
    if (m.kind === 'problem') return onProblem(m.slug, m.payload, m.questionId);
    if (m.kind === 'hint') {
      if (m.questionId) questionIds.set(screenSlug, m.questionId);
      return;
    }
    buffer.push(...wire.toEventInputs(m, mintId));
    if (m.kind === 'submit' || m.kind === 'run') flushNow();
    else scheduleFlush();
  }

  // ---- events → the background, coalesced 3 s; a run or submit goes at once ----
  function scheduleFlush() {
    if (!flushTimer) flushTimer = setTimeout(flushNow, 3000);
  }
  function flushNow() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!buffer.length) return;
    const events = buffer;
    buffer = [];
    if (!binding) return;
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

  // LeetCode's timer, read from its own localStorage (shared with this world) every 2 s while a sitting is open.
  setInterval(() => {
    if (!liveBinding() || bindingStatus() !== 'active') return;
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
    buffer.push({
      id: mintId(),
      type: 'timer',
      at: Date.now(),
      payload: { state: parsed, heartbeat },
    });
    scheduleFlush();
  }, 2000);

  // ---- the problem ----
  function onProblem(slug, doc, questionId) {
    if (!doc || wire.bytes(JSON.stringify(doc)) > PROBLEM_MAX) return;
    problems.set(slug, doc);
    if (questionId) questionIds.set(slug, questionId);
    // A1 fills in a sitting's problem doc on a repeat Start: LeetCode only sends it after a submit or a nav.
    if (binding && binding.slug === slug && !binding.problemSent && state.phase === 'active')
      lateFill();
  }
  async function lateFill() {
    const r = await send({
      type: 'start',
      body: startBody(binding.clientSittingId, binding.clientStartedAt),
    }).catch(() => null);
    if (r && r.status === 200 && binding) await saveBinding({ ...binding, problemSent: true });
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
  function startBody(clientSittingId, startedAt) {
    const doc = problems.get(screenSlug) || null;
    const dom = readDom();
    const docTags =
      doc && Array.isArray(doc.topicTags)
        ? doc.topicTags.map((t) => clip(t && t.name, 40)).filter(Boolean)
        : null;
    const idOf = (v) => (v == null ? null : clip(String(v), 20));
    return {
      clientSittingId,
      problemSlug: screenSlug,
      problemTitle: clip(doc && doc.title, 200) || dom.title || humanize(screenSlug),
      questionId: idOf((doc && doc.questionId) ?? questionIds.get(screenSlug)),
      frontendId: idOf(doc && doc.questionFrontendId),
      difficulty: clip(doc && doc.difficulty, 20) || dom.difficulty,
      topicTags: docTags && docTags.length ? docTags.slice(0, 20) : dom.topicTags,
      lang: dom.lang || 'python3',
      startedAt,
      tzOffsetMinutes: new Date().getTimezoneOffset(),
      lcSolveSessionId: solveSession(screenSlug),
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

  // ---- Start: LeetCode's reset → its confirm → its timer → the server ----
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
    if (step === 'send') return sendStart();
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
  async function sendStart() {
    const start = pendingStart;
    const deadline = Date.now() + START_RETRY_MS;
    for (let tries = 0; ; tries++) {
      const body = startBody(start.clientSittingId, start.startedAt);
      const r = await send({ type: 'start', body }).catch(() => ({
        status: 0,
        error: 'the extension was reloaded — reload this page',
      }));
      const s = r.status === 200 && r.json && r.json.sitting;
      if (s && s.status === 'active' && s.problemSlug === screenSlug) {
        await saveBinding({
          slug: screenSlug,
          sittingId: s.id,
          clientSittingId: s.clientSittingId,
          questionId: s.questionId || body.questionId,
          clientStartedAt: s.clientStartedAt,
          title: s.problemTitle,
          problemSent: !!body.problem,
        });
        await local.set({
          [`sync:${screenSlug}`]: { sittingId: s.id, status: 'active', at: Date.now() },
        });
        sync = { sittingId: s.id, status: 'active' };
        lastTimerRaw = null;
        pendingStart = null;
        debug.log('start', { ok: true, resumed: !!r.json.resumed });
        return act({ type: 'started' });
      }
      if (s) {
        pendingStart = null; // an ended sitting came back: the next try mints a fresh id
        return act({
          type: 'stepFail',
          step: 'send',
          reason: 'That sitting has already ended — Retry starts a new one.',
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

  async function resume() {
    const b = binding;
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
    // Unreachable or retrying: trust the binding — the outbox holds events until Aperture is back.
    const offline = r.status === -1 || r.status === 0 || outbox.retryable(r.status);
    debug.log('resume', { active: offline, http: r.status });
    act({ type: 'resumed', active: offline });
  }

  // ---- the overlay ----
  const view = NS.overlay.create({
    start: () => begin('start'),
    retry: () => begin('retry'),
    startAnyway: () => begin('startAnyway'),
    dismiss: () => act({ type: 'dismiss' }),
  });
  function begin(type) {
    if (!pendingStart || !lastStartRetryable)
      pendingStart = { clientSittingId: mintId(), startedAt: Date.now() };
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
  async function onNav() {
    const slug = relayLib.slugOf(location.pathname);
    if (navigated && slug === screenSlug) return;
    navigated = true;
    flushNow(); // the old problem's events go first
    screenSlug = slug;
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
  window.addEventListener('popstate', () => {
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
        (state.phase === 'active' || state.phase === 'resuming')
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
