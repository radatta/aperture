// Aperture's LeetCode capture, page side — the MAIN world (manifest: world "MAIN", document_start), loaded
// after page/tag.js (a copy of lib/tag.js: README → How it works). It watches LeetCode's own fetch/XHR
// traffic and hands the isolated world (content.js) the raw text — URL, request, response, times — as tagged
// messages; the isolated world does all the parsing. It is purely passive: it never blocks or alters a
// request, issues none of its own, reads no extension API, and nothing ever flows back into it — no server
// reply reaches the page (forgery rule 2).
//
// A page script can patch built-ins after we load. So everything this file calls at request time is an
// original captured below and called through Reflect.apply; it never awaits or chains on a promise (a
// patched `then` could swap the value); the browser's own promise resolution can't be steered either —
// `then` is pinned to undefined on what our promises settle with (Response, CryptoKey, ArrayBuffer — a blob's
// text is a string, which settles with no `then` lookup); a Response counts only if the browser fetched it
// from leetcode.com (its own type and final URL), an XHR's body only through its own `response` getter; and each
// message is strings and numbers in null-prototype objects, so no page `toJSON` applies. What that can't
// stop — a patch in place before we ran, or traffic a script makes or fakes for LeetCode itself, or one it
// keeps from us (a listener ahead of ours) — is the accepted residual (README → How it works → The relay).
(() => {
  'use strict';
  const NS = globalThis.ApertureLC;
  if (!NS || !NS.tag) return;
  const { tag } = NS;
  // The lib was only for this closure; the page never sees it.
  try {
    delete globalThis.ApertureLC;
  } catch {}

  // ---- the originals, bound before any LeetCode script exists ----
  // First: the objects our promises settle with get a fixed, absent `then`, so the browser's resolution
  // never runs a page-installed one (which could swap a Response, or read the key).
  for (const C of [
    typeof Response === 'function' && Response,
    typeof CryptoKey === 'function' && CryptoKey,
    ArrayBuffer,
  ])
    try {
      if (C) Object.defineProperty(C.prototype, 'then', { value: undefined });
    } catch {}
  const apply = Reflect.apply;
  const dispatch = EventTarget.prototype.dispatchEvent.bind(window);
  const listen = EventTarget.prototype.addEventListener.bind(window);
  const addListener = EventTarget.prototype.addEventListener;
  const Custom = CustomEvent;
  const stringify = JSON.stringify;
  const now = Date.now;
  const Str = String;
  const pThen = Promise.prototype.then;
  const reExec = RegExp.prototype.exec;
  const wmGet = WeakMap.prototype.get;
  const wmSet = WeakMap.prototype.set;
  const getterOf = (C, name) => {
    try {
      const d = C && Object.getOwnPropertyDescriptor(C.prototype, name);
      return (d && d.get) || null;
    } catch {
      return null;
    }
  };
  const Res = typeof Response === 'function' ? Response.prototype : null;
  const Req = typeof Request === 'function' ? Request.prototype : null;
  const resClone = Res && Res.clone;
  const resText = Res && Res.text;
  const reqClone = Req && Req.clone;
  const reqText = Req && Req.text;
  const reqUrl = getterOf(typeof Request === 'function' && Request, 'url');
  const resType = getterOf(typeof Response === 'function' && Response, 'type');
  const resUrl = getterOf(typeof Response === 'function' && Response, 'url');
  const urlHref = getterOf(typeof URL === 'function' && URL, 'href');
  const XHR = window.XMLHttpRequest;
  const xhrStatus = getterOf(XHR, 'status');
  const xhrType = getterOf(XHR, 'responseType');
  const xhrText = getterOf(XHR, 'responseText');
  const xhrUrl = getterOf(XHR, 'responseURL');
  const xhrResponse = getterOf(XHR, 'response');
  // A Blob's size getter brand-checks its receiver, so it is also the is-it-a-real-Blob test.
  const blobSize = getterOf(typeof Blob === 'function' && Blob, 'size');
  const blobText =
    typeof Blob === 'function' && typeof Blob.prototype.text === 'function'
      ? Blob.prototype.text
      : null;

  const RAW_MAX = 1024 * 1024; // lib/relay.js RAW_MAX: a longer text goes as null
  const URL_MAX = 2048;
  // A prefilter only — lib/wire.js route() decides; replay.test.ts runs both ends, so a drift fails there.
  const OURS =
    /^(?:https?:\/\/(?:[a-z0-9-]+\.)*leetcode\.com)?\/(?:graphql\/?(?:[?#]|$)|problems\/[^/?#]+\/(?:submit|interpret_solution)\/?(?:[?#]|$)|submissions\/detail\/[^/?#]+\/(?:v2\/)?check\/?(?:[?#]|$))/;
  const GRAPHQL = /^(?:https?:\/\/(?:[a-z0-9-]+\.)*leetcode\.com)?\/graphql\/?(?:[?#]|$)/;
  // Where the browser actually went (a page's <base href> can send a relative path elsewhere).
  const LEETCODE = /^https:\/\/(?:[a-z0-9-]+\.)*leetcode\.com\//;
  const WANT_RES = /"operationName"\s*:\s*"(?:questionDetail|submissionDetails)"/;
  const hits = (re, s) => typeof s === 'string' && apply(reExec, re, [s]) !== null;
  // Whether to read the response: always for submit/run/check; for GraphQL only the operations we use.
  const wantsRes = (url, text) => !hits(GRAPHQL, url) || hits(WANT_RES, text);
  const textOr = (v) => (typeof v === 'string' && v.length <= RAW_MAX ? v : null);
  // The page a request was made from — window.location and its fields are unforgeable, so a page script
  // can change them only by navigating (pushState), never by redefining the getter.
  const pageNow = () => {
    try {
      return Str(location.pathname);
    } catch {
      return null;
    }
  };
  const safe = (fn, self, args) => {
    try {
      return fn ? apply(fn, self, args) : null;
    } catch {
      return null;
    }
  };

  // ---- the handshake: this load's nonce goes to the isolated world once, before any page script listens.
  // Whichever world runs first, the hello lands: an early hello is caught by the isolated side's own
  // "ready", answered once and never again after the ack.
  const nonce = tag.newNonce();
  let key = null;
  let acked = false;
  let reHelloed = false;
  const hello = () =>
    dispatch(
      new Custom('aperture-lc-hello', {
        __proto__: null,
        // readyState: whether this ran before the page's scripts (Safari's document_start; debug log).
        detail: stringify({ __proto__: null, nonce, readyState: Str(document.readyState) }),
      }),
    );
  listen('aperture-lc-ack', () => {
    acked = true;
  });
  listen('aperture-lc-ready', () => {
    if (acked || reHelloed) return;
    reHelloed = true;
    hello();
  });
  hello();

  // ---- messages: {body, tag}, tag = HMAC-SHA256(nonce, body), body numbered, sent in sequence order ----
  let seq = 0;
  let head = null;
  let tail = null;
  let busy = false;
  safe(pThen, tag.keyOf(nonce), [
    (k) => {
      key = k;
      pump();
    },
  ]);
  // `how`: why a response went with or without its body, a few fixed words for the debug log's probe (the
  // GraphQL bodies Safari sends as blob XHRs, debug log 9: README → Safari behaviour) — never content.
  function emit(url, reqBody, resBody, reqAt, page, how) {
    if (typeof url !== 'string' || url.length > URL_MAX) return;
    if (typeof page !== 'string' || page.length > URL_MAX) return;
    const big = typeof resBody === 'string' && resBody.length > RAW_MAX;
    const body = stringify({
      __proto__: null,
      v: 3,
      seq: ++seq,
      url,
      page,
      reqText: textOr(reqBody),
      resText: textOr(resBody),
      reqAt,
      resAt: now(),
      how: big ? how + ':big' : how,
    });
    const node = { __proto__: null, body, next: null };
    if (tail) tail.next = node;
    else head = node;
    tail = node;
    pump();
  }
  // One sign at a time, so dispatch order is sequence order; a linked list, so no Array method is called.
  function pump() {
    if (busy || !key || !head) return;
    busy = true;
    const node = head;
    head = node.next;
    if (!head) tail = null;
    const done = () => {
      busy = false;
      pump();
    };
    tag.sign(key, node.body, (t) => {
      try {
        if (t)
          dispatch(
            new Custom('aperture-lc', {
              __proto__: null,
              detail: stringify({ __proto__: null, body: node.body, tag: t }),
            }),
          );
      } catch {}
      done();
    });
  }
  // A promise's value, for side effects only — never chained on, never awaited.
  const when = (p, ok) => {
    if (!p) return ok(null);
    try {
      apply(pThen, p, [ok, () => ok(null)]);
    } catch {
      ok(null);
    }
  };
  // The browser's own Response from leetcode.com → its final URL; else null (one the page built, or a
  // request a <base href> sent elsewhere).
  const fetched = (res) => {
    const type = res ? safe(resType, res, []) : null;
    const real = type && type !== 'default' && type !== 'error' ? safe(resUrl, res, []) : null;
    return hits(LEETCODE, real) ? real : null;
  };

  // ---- fetch ----
  const realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input, init) {
      // The URL, read once and handed to the real fetch as that same string. A Request's url is fixed, so a
      // Request passes through as is; an input we can't read passes through untouched, uncaptured.
      let url;
      let req = null;
      if (typeof input === 'string') url = input;
      else {
        url = safe(reqUrl, input, []);
        if (url !== null) req = input;
        else url = safe(urlHref, input, []);
        if (url === null) url = safe(Str, undefined, [input]);
      }
      if (url === null) return apply(realFetch, this, arguments);
      const args = req || typeof input === 'string' ? arguments : [url, init];
      if (!hits(OURS, url)) return apply(realFetch, this, args);
      let bodyNow = null; // the request text when it's in hand now; else read from a clone of the Request
      let bodyLater = null;
      const b = init != null ? init.body : undefined;
      if (typeof b === 'string') bodyNow = b;
      else if (b == null && req) bodyLater = safe(reqText, safe(reqClone, req, []), []);
      const p = apply(realFetch, this, args);
      const reqAt = now();
      const page = pageNow();
      when(p, (res) => {
        const real = fetched(res);
        if (!real) return;
        // Ours runs first: the page hasn't read the body yet.
        const copy = bodyLater || wantsRes(real, bodyNow) ? safe(resClone, res, []) : null;
        const resP = copy ? safe(resText, copy, []) : null;
        when(bodyLater, (later) => {
          const reqBody = bodyLater ? later : bodyNow;
          if (!wantsRes(real, reqBody)) return emit(real, reqBody, null, reqAt, page, 'fetch:skip');
          if (!resP)
            return emit(
              real,
              reqBody,
              null,
              reqAt,
              page,
              copy ? 'fetch:no-text' : 'fetch:no-clone',
            );
          when(resP, (text) =>
            emit(real, reqBody, text, reqAt, page, text === null ? 'fetch:read-fail' : 'fetch:ok'),
          );
        });
      });
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  if (XHR && XHR.prototype) {
    const realOpen = XHR.prototype.open;
    const realSend = XHR.prototype.send;
    const urls = new WeakMap();
    const sends = new WeakMap(); // xhr → its latest send's token: a reused XHR's earlier listener stands down
    const ONCE = { __proto__: null, once: true }; // no prototype: a polluted `capture` or `signal` isn't read
    // A blob XHR's body (Safari's GraphQL, debug log 9): the Blob in hand, read through the originals. Nothing
    // is read from the XHR after this tick, so a reuse before the text settles can't swap the pair. WebKit's
    // wrapper caches the one Blob it makes per response, so the page gets that same Blob; an isolated world's
    // read would likely get none, so the read stays in this world (README → Safari behaviour).
    const readBlob = (blob, done) => {
      const size = safe(blobSize, blob, []);
      if (typeof size !== 'number') return done(null, 'xhr:blob-none'); // null, or not a real Blob
      // UTF-8 bytes are at least the text's UTF-16 length, so a blob within RAW_MAX is a text within it.
      if (size > RAW_MAX) return done(null, 'xhr:blob-big');
      if (size === 0) return done(null, 'xhr:blob-empty');
      if (!blobText) return done(null, 'xhr:blob-no-text');
      when(safe(blobText, blob, []), (t) =>
        typeof t === 'string' ? done(t, 'xhr:blob-ok') : done(null, 'xhr:blob-read-fail'),
      );
    };
    XHR.prototype.open = function () {
      // Read once, and the same string goes to the real open.
      const url = arguments.length > 1 ? safe(Str, undefined, [arguments[1]]) : null;
      if (url !== null) {
        arguments[1] = url;
        safe(wmSet, urls, [this, url]);
      }
      return apply(realOpen, this, arguments);
    };
    XHR.prototype.send = function (body) {
      const url = safe(wmGet, urls, [this]);
      // Each send gets its own token, so a listener only ever pairs its own request with a response.
      const prev = safe(wmGet, sends, [this]);
      const token = { __proto__: null };
      safe(wmSet, sends, [this, token]);
      if (hits(OURS, url)) {
        const reqBody = typeof body === 'string' ? body : null;
        const reqAt = now();
        const page = pageNow();
        safe(addListener, this, [
          'loadend',
          () => {
            if (safe(wmGet, sends, [this]) !== token) return; // sent again since: not this send's response
            const real = safe(xhrUrl, this, []); // where the browser went, not what the page wrote
            if (!hits(LEETCODE, real)) return;
            const done = (text, how) => emit(real, reqBody, text, reqAt, page, how);
            const status = safe(xhrStatus, this, []);
            const type = safe(xhrType, this, []); // the browser's enum
            if (!wantsRes(url, reqBody)) return done(null, 'xhr:skip');
            if (!(status >= 200 && status < 300)) return done(null, 'xhr:status-' + Str(status));
            // Safari sends LeetCode's GraphQL as 'blob' (debug log 9; the 2026-11-08 capture's text XHRs were
            // likely not Safari's). A 'json', 'document' or 'arraybuffer' one would need a page-patchable
            // conversion, so it goes without its response.
            if (type === 'blob') return readBlob(safe(xhrResponse, this, []), done);
            if (type !== '' && type !== 'text') return done(null, 'xhr:type-' + Str(type));
            const text = safe(xhrText, this, []);
            done(text, text === null ? 'xhr:no-text' : 'xhr:ok');
          },
          ONCE,
        ]);
      }
      try {
        return apply(realSend, this, arguments);
      } catch (e) {
        safe(wmSet, sends, [this, prev]); // a send the browser refused: the one in flight keeps its listener
        throw e;
      }
    };
  }
})();
