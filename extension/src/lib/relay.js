// The relay's acceptance rules, pure (the isolated world runs them on every page message). Rahul's forgery
// rules (docs/areas/recruiting/index.md → Design decisions): a page message can never Start anything — it
// can only add events to the sitting the extension itself opened, for the problem on screen. accept() checks
// the envelope: this load's tag, a fresh sequence number, raw text of the right shape. The isolated world
// then parses that text itself (lib/wire.js), and admit() rules on each item it finds — but a problem doc,
// which names its own problem and is only ever used for that one, goes to keepsDoc() instead.
(function (root, factory) {
  const api = factory(root.ApertureLC && root.ApertureLC.tag);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).relay = api;
})(globalThis, function (tagLib) {
  'use strict';
  const tag = tagLib || (typeof require === 'function' ? require('./tag.js') : null);
  const SENDABLE = ['snapshot', 'run', 'submit', 'submitDetails', 'note', 'replay'];
  const CACHE_ONLY = ['hint'];
  // LeetCode's judging can finish after you've moved on: these, when made from their own problem's page, go
  // to that problem's open sitting (content.js asks admit() again with that problem as ctx), never to the one
  // on screen (Rahul, 2026-11-08).
  const LATE = ['run', 'submit', 'submitDetails'];
  // Far over any one item LeetCode sends (the outbox trims to the server's caps); bounds a flood's parse.
  const DETAIL_MAX = 6 * 1024 * 1024; // two raw texts at RAW_MAX, JSON-escaped twice over
  const RAW_MAX = 1024 * 1024; // one request's or response's text (inject-main.js skips anything longer)
  const URL_MAX = 2048;
  const HOW = /^[a-z0-9:-]{1,40}$/;

  const SLUG_PATH = /^\/problems\/([a-z0-9-]{1,128})(?:\/|$)/;
  // The problem on screen, from the isolated world's own location — never from a page message.
  const slugOf = (pathname) => {
    const m = typeof pathname === 'string' ? pathname.match(SLUG_PATH) : null;
    return m ? m[1] : null;
  };
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  function createRelay() {
    let keyReady = null; // set by the first hello — it wins, even while its key is still importing
    let lastSeq = 0;

    // Synchronous on purpose: content.js acks in the same tick, so the page world stops answering "ready"
    // before any LeetCode script could ask it to repeat the hello. null = refused; else resolves to ok.
    function hello(detail) {
      if (keyReady || typeof detail !== 'string') return null;
      const nonce = parse(detail)?.nonce;
      if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) return null;
      keyReady = tag.keyOf(nonce).catch(() => null);
      return keyReady.then((k) => !!k);
    }

    // The envelope: ours (the tag verifies), in order, and raw LeetCode text — the page world parses nothing.
    // → {ok: true, raw: {url, reqText, resText, reqAt, resAt}} | {ok: false, reason}
    async function accept(detail) {
      const key = keyReady && (await keyReady);
      if (!key) return { ok: false, reason: 'no-handshake' };
      if (typeof detail !== 'string') return { ok: false, reason: 'not-string' };
      if (detail.length > DETAIL_MAX) return { ok: false, reason: 'too-big' };
      const env = parse(detail);
      if (!env || typeof env.body !== 'string') return { ok: false, reason: 'bad-envelope' };
      if (!(await tag.verify(key, env.body, env.tag))) return { ok: false, reason: 'bad-tag' };
      const msg = parse(env.body);
      if (!msg || msg.v !== 3 || !Number.isSafeInteger(msg.seq))
        return { ok: false, reason: 'version' };
      if (msg.seq <= lastSeq) return { ok: false, reason: 'replayed-seq' };
      lastSeq = msg.seq; // a gap (a lost frame) resyncs here; a tag can't be forged, so it's still ours
      const text = (v) => v === null || (typeof v === 'string' && v.length <= RAW_MAX);
      if (
        typeof msg.url !== 'string' ||
        msg.url.length > URL_MAX ||
        typeof msg.page !== 'string' ||
        msg.page.length > URL_MAX ||
        !text(msg.reqText) ||
        !text(msg.resText) ||
        !Number.isFinite(msg.reqAt) ||
        !Number.isFinite(msg.resAt)
      )
        return { ok: false, reason: 'raw-shape' };
      const { url, page, reqText, resText, reqAt, resAt } = msg;
      // The page world's word on how it read the response (inject-main.js emit): a debug-log probe only.
      const how = typeof msg.how === 'string' && HOW.test(msg.how) ? msg.how : null;
      return { ok: true, raw: { url, page, reqText, resText, reqAt, resAt, how } };
    }
    return { hello, accept };
  }

  // One item the isolated world parsed out of raw traffic (lib/wire.js) → whether it may be used.
  // ctx: { screenSlug, binding: {questionId, status} | null } → {ok: true} | {ok: false, reason}
  function admit(item, ctx) {
    if (!item || (!SENDABLE.includes(item.kind) && !CACHE_ONLY.includes(item.kind)))
      return { ok: false, reason: 'kind' };
    if (!ctx.screenSlug) return { ok: false, reason: 'off-problem' };
    if (item.slug != null && item.slug !== ctx.screenSlug)
      return { ok: false, reason: 'off-screen-slug' };
    // A hint counts only for the problem on screen; it needs no sitting: it's kept for the next Start.
    if (item.kind === 'hint') return { ok: true };
    const b = ctx.binding;
    if (!b || b.status !== 'active') return { ok: false, reason: 'no-sitting' };
    if (
      item.questionId != null &&
      b.questionId != null &&
      String(item.questionId) !== String(b.questionId)
    )
      return { ok: false, reason: 'foreign-question' };
    return { ok: true };
  }

  // A problem doc → whether to keep it. It's kept by its own slug wherever it was fetched — LeetCode fetches the
  // next problem's before you click Next (debug log 9) — and content.js uses it only while the address names
  // that slug, so one for another problem can't set this sitting's title or question id.
  const isSlug = (s) => typeof s === 'string' && slugOf(`/problems/${s}/`) === s;
  const keepsDoc = (item) =>
    item && item.kind === 'problem' && isSlug(item.slug)
      ? { ok: true }
      : { ok: false, reason: 'slug' };

  return { createRelay, admit, keepsDoc, isSlug, slugOf, SENDABLE, LATE, RAW_MAX };
});
