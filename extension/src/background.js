// Aperture's LeetCode capture, background -- the only part that talks to Aperture. content.js asks it to
// Start a sitting (answered directly) and hands it events, which go through the outbox (lib/outbox.js): one
// POST in flight, in order, retried with backoff, persisted in storage.local so a browser restart loses
// nothing. Every outcome lands in storage.local (`status`, `sync:<slug>`) for the badge and the options page.
// Safari loads it as an event page (manifest background.scripts, after lib/outbox.js).
(() => {
  'use strict';
  const api =
    globalThis.browser && globalThis.browser.runtime ? globalThis.browser : globalThis.chrome;
  const { outbox } = globalThis.ApertureLC;
  // packages/shared/src/rpc.ts AUTH_HEADER -- kept in sync by hand (background.test.ts checks it).
  const AUTH_HEADER = 'x-aperture-authorization';
  const SEND_TIMEOUT_MS = 30_000;
  const NOT_API =
    'Aperture answered with something that isn\u2019t its API \u2014 check the origin in the extension\u2019s options.';
  const NOT_CONFIGURED =
    'Set the Aperture origin and device token in the extension\u2019s options.';
  const local = api.storage.local;
  const session = api.storage.session || null; // Safari before 16.4 has none: then "just looking" lasts
  // as long as this background page does
  const memSession = new Map();

  let idSeq = 0;
  const entryId = () =>
    `${Date.now().toString(36)}-${(idSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  async function config() {
    const { apiOrigin, deviceToken } = await local.get(['apiOrigin', 'deviceToken']);
    return {
      origin: String(apiOrigin || '').replace(/\/+$/, ''),
      token: String(deviceToken || ''),
    };
  }

  // A 2xx counts only with the body the method answers: CloudFront serves the app's index.html as a 200
  // for an /api 403 or 404 (cdk app-stack errorResponses), which must not read as "sent".
  const SHAPE = {
    lcSittingEvents: (j) => typeof j.version === 'number',
    lcSittingStart: (j) => !!j.sitting && typeof j.sitting.id === 'string',
  };
  const timeout = () =>
    typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(SEND_TIMEOUT_MS)
      : undefined;

  // One RPC: {status, json, error}. status 0 = unreachable or not Aperture's API (retried); -1 = not configured.
  async function post(method, body) {
    const { origin, token } = await config();
    if (!origin || !token) return { status: -1, json: null, error: NOT_CONFIGURED };
    try {
      const res = await fetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${token}` },
        body: JSON.stringify({ args: [body] }),
        signal: timeout(),
      });
      const text = await res.text().catch(() => '');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (res.ok && !(json && typeof json === 'object' && SHAPE[method](json)))
        return { status: 0, json: null, error: NOT_API };
      const error = res.ok
        ? null
        : json && typeof json.error === 'string'
          ? json.error
          : `HTTP ${res.status}`;
      return { status: res.status, json, error };
    } catch {
      return { status: 0, json: null, error: 'Aperture is unreachable' };
    }
  }

  // ---- the outbox: every read-modify-write of storage.local.outbox goes through one chain ----
  let lock = Promise.resolve();
  function withQueue(fn) {
    const run = lock.then(async () => {
      const { outbox: stored } = await local.get('outbox');
      const q = stored && Array.isArray(stored.entries) ? stored : outbox.empty();
      const r = (await fn(q)) || {};
      if (r.queue) await local.set({ outbox: r.queue });
      return r;
    });
    lock = run.catch(() => {});
    return run;
  }

  // status and sync:<slug> are read-modify-writes too: one chain of their own, so no patch is lost.
  let notes = Promise.resolve();
  function note(fn) {
    const run = notes.then(fn);
    notes = run.catch(() => {});
    return run;
  }
  const setStatus = (patch) =>
    note(async () => {
      const { status } = await local.get('status');
      await local.set({ status: { ...(status || {}), ...patch, at: Date.now() } });
    });
  // A record is one sitting's: a patch for another sitting starts it afresh, so an old sitting's late
  // "ended" can never be merged into the next one's.
  const setSync = (slug, patch) =>
    note(async () => {
      const key = `sync:${slug}`;
      const stored = (await local.get(key))[key];
      const cur = stored && stored.sittingId === patch.sittingId ? stored : {};
      await local.set({ [key]: { ...cur, ...patch, at: Date.now() } });
    });

  let flushing = false;
  let again = false;
  let wake = null;
  function schedule(ms) {
    clearTimeout(wake);
    wake = setTimeout(flush, ms); // while this page lives; the alarm covers it being unloaded
    try {
      api.alarms.create('outbox', { when: Date.now() + Math.max(ms, 1000) });
    } catch {}
  }

  async function flush() {
    if (flushing) {
      again = true;
      return;
    }
    flushing = true;
    try {
      for (;;) {
        const { pick, counts } = await withQueue((q) => ({
          pick: outbox.next(q, Date.now()),
          counts: outbox.counts(q),
        }));
        if (!pick) {
          await setStatus({
            ...counts,
            state: counts.paused ? 'paused' : counts.failed ? 'failed' : 'ok',
          });
          break;
        }
        if (pick.wait != null) {
          schedule(pick.wait);
          await setStatus({ ...counts, state: 'retrying' });
          break;
        }
        const e = pick.entry;
        const r = await post('lcSittingEvents', { sittingId: e.sittingId, events: e.events });
        const { outcome } = await withQueue((q) =>
          r.status === -1
            ? { queue: { ...q, paused: 'config' }, outcome: 'paused' }
            : outbox.applyResult(q, e.id, r, Date.now()),
        );
        await afterSend(e, r, outcome);
        if (outcome === 'paused') {
          const { counts: c } = await withQueue((q) => ({ counts: outbox.counts(q) }));
          await setStatus({ ...c, state: 'paused', http: r.status, detail: r.error });
          break;
        }
      }
    } catch (err) {
      await setStatus({ state: 'failed', detail: String((err && err.message) || err) }).catch(
        () => {},
      );
    } finally {
      flushing = false;
      if (again) {
        again = false;
        flush();
      }
    }
  }

  async function afterSend(e, r, outcome) {
    const now = Date.now();
    if (outcome === 'sent') {
      const j = r.json || {};
      await setSync(e.slug, {
        sittingId: e.sittingId,
        status: j.status || 'active',
        version: j.version ?? null,
        lastSyncAt: now,
        http: r.status,
        error: null,
      });
      await setStatus({ http: r.status, detail: null, lastSentAt: now });
      return;
    }
    const ended = outcome === 'ended';
    await setSync(e.slug, {
      sittingId: e.sittingId,
      http: r.status,
      error: r.error,
      ...(ended ? { status: 'ended' } : {}),
    });
    await setStatus({ http: r.status, detail: r.error });
  }

  async function enqueue(msg) {
    const now = Date.now();
    const { batches, dropped } = outbox.splitBatch(Array.isArray(msg.events) ? msg.events : []);
    const entries = batches.map((events) =>
      outbox.entryOf(entryId(), msg.sittingId, msg.slug, events, now),
    );
    const { shed } = await withQueue((q) => outbox.enqueue(q, entries));
    if (dropped || shed)
      await setStatus({
        detail:
          `${dropped ? `${dropped} oversized event(s) dropped. ` : ''}${shed ? `${shed} old snapshot or replay batch(es) shed \u2014 the queue was full.` : ''}`.trim(),
      });
    flush();
  }

  // ---- "Just looking", remembered per problem for the browser session ----
  async function dismiss(slug) {
    if (session) await session.set({ [`dismissed:${slug}`]: true });
    else memSession.set(slug, true);
  }
  // The pill after Just looking: asked again from here on.
  async function undismiss(slug) {
    if (session) await session.remove(`dismissed:${slug}`);
    else memSession.delete(slug);
  }
  async function isDismissed(slug) {
    if (session) return !!(await session.get(`dismissed:${slug}`))[`dismissed:${slug}`];
    return memSession.has(slug);
  }

  async function onMessage(msg) {
    switch (msg && msg.type) {
      case 'start':
        return post('lcSittingStart', msg.body);
      case 'enqueue':
        await enqueue(msg);
        return { ok: true };
      case 'flush':
        flush();
        return { ok: true };
      case 'config-changed':
        await withQueue((q) => ({ queue: outbox.unpause(q) }));
        flush();
        return { ok: true };
      case 'retry-now':
        await withQueue((q) => ({ queue: outbox.retryNow(q, Date.now()) }));
        flush();
        return { ok: true };
      case 'clear-failed':
        await withQueue((q) => ({ queue: outbox.clearFailed(q) }));
        flush();
        return { ok: true };
      case 'dismiss':
        await dismiss(String(msg.slug));
        return { ok: true };
      case 'undismiss':
        await undismiss(String(msg.slug));
        return { ok: true };
      case 'dismissed?':
        return { dismissed: await isDismissed(String(msg.slug)) };
      default:
        return { ok: false };
    }
  }

  api.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!sender || sender.id !== api.runtime.id) return false; // only this extension's own pages and scripts
    onMessage(msg).then(reply, (err) =>
      reply({ ok: false, error: String((err && err.message) || err) }),
    );
    return true; // the reply is async
  });
  if (api.alarms) api.alarms.onAlarm.addListener((a) => a.name === 'outbox' && flush());
  if (api.runtime.onStartup) api.runtime.onStartup.addListener(flush);
  if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(flush);
  flush();
})();
