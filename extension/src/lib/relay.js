// The relay's acceptance rules, as one pure function (the isolated world runs it on every page message).
// Rahul's forgery rules (localNotes/decisions.md, A2): a page message can never Start anything — it can only
// add events to the sitting the extension itself opened, for the problem on screen — and it must carry a
// valid tag from this load's handshake, in sequence. Messages arrive serialized by content.js.
(function (root, factory) {
  const api = factory(root.ApertureLC && root.ApertureLC.tag);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).relay = api;
})(globalThis, function (tagLib) {
  'use strict';
  const tag = tagLib || (typeof require === 'function' ? require('./tag.js') : null);
  const SENDABLE = ['snapshot', 'run', 'submit', 'submitDetails', 'note', 'replay'];
  const CACHE_ONLY = ['problem', 'hint'];

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

    // ctx: { screenSlug, binding: {questionId, status} | null } → {ok: true, msg} | {ok: false, reason}
    async function accept(detail, ctx) {
      const key = keyReady && (await keyReady);
      if (!key) return { ok: false, reason: 'no-handshake' };
      if (typeof detail !== 'string') return { ok: false, reason: 'not-string' };
      const env = parse(detail);
      if (!env || typeof env.body !== 'string') return { ok: false, reason: 'bad-envelope' };
      if (!(await tag.verify(key, env.body, env.tag))) return { ok: false, reason: 'bad-tag' };
      const msg = parse(env.body);
      if (!msg || msg.v !== 2 || !Number.isSafeInteger(msg.seq))
        return { ok: false, reason: 'version' };
      if (msg.seq <= lastSeq) return { ok: false, reason: 'replayed-seq' };
      lastSeq = msg.seq; // a gap (a lost frame) resyncs here; a tag can't be forged, so it's still ours
      if (!SENDABLE.includes(msg.kind) && !CACHE_ONLY.includes(msg.kind))
        return { ok: false, reason: 'kind' };
      // A problem doc is cached for its own slug (LeetCode prefetches the next problem's); nothing is sent.
      if (msg.kind === 'problem') return { ok: true, msg };
      if (!ctx.screenSlug) return { ok: false, reason: 'off-problem' };
      if (msg.slug != null && msg.slug !== ctx.screenSlug)
        return { ok: false, reason: 'off-screen-slug' };
      if (msg.kind === 'hint') return { ok: true, msg };
      const b = ctx.binding;
      if (!b || b.status !== 'active') return { ok: false, reason: 'no-sitting' };
      if (
        msg.questionId != null &&
        b.questionId != null &&
        String(msg.questionId) !== String(b.questionId)
      )
        return { ok: false, reason: 'foreign-question' };
      return { ok: true, msg };
    }
    return { hello, accept };
  }

  return { createRelay, slugOf, SENDABLE };
});
