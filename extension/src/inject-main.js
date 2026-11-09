// Aperture's LeetCode capture, page side — the MAIN world (manifest: world "MAIN", document_start), loaded
// after page/tag.js (a copy of lib/tag.js: README → How it works). It watches LeetCode's own fetch/XHR
// traffic and hands the isolated world (content.js) the raw text — URL, request, response, times — as tagged
// messages; the isolated world does all the parsing. It is purely passive: it never blocks or alters a
// request, issues none of its own, reads no extension API, and nothing ever flows back into it — no server
// reply reaches the page (forgery rule 2).
//
// A page script can patch built-ins after we load. So everything this file calls at request time is an
// original captured below and called through Reflect.apply; it never awaits or chains on a promise (a
// patched `then` could swap the value); and each message is strings and numbers in null-prototype objects,
// so no page `toJSON` applies. What that can't stop — a patch in place before we ran, or traffic a script
// makes or fakes for LeetCode itself — is the accepted residual (README → How it works → The relay).
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
  const urlHref = getterOf(typeof URL === 'function' && URL, 'href');
  const XHR = window.XMLHttpRequest;
  const xhrStatus = getterOf(XHR, 'status');
  const xhrType = getterOf(XHR, 'responseType');
  const xhrText = getterOf(XHR, 'responseText');

  const RAW_MAX = 1024 * 1024; // lib/relay.js RAW_MAX: a longer text goes as null
  const URL_MAX = 2048;
  // A prefilter only — lib/wire.js route() decides; replay.test.ts runs both ends, so a drift fails there.
  const OURS =
    /^(?:https?:\/\/(?:[a-z0-9-]+\.)*leetcode\.com)?\/(?:graphql\/?(?:[?#]|$)|problems\/[^/?#]+\/(?:submit|interpret_solution)\/?(?:[?#]|$)|submissions\/detail\/[^/?#]+\/(?:v2\/)?check\/?(?:[?#]|$))/;
  const GRAPHQL = /^(?:https?:\/\/(?:[a-z0-9-]+\.)*leetcode\.com)?\/graphql\/?(?:[?#]|$)/;
  const WANT_RES = /"operationName"\s*:\s*"(?:questionDetail|submissionDetails)"/;
  const hits = (re, s) => typeof s === 'string' && apply(reExec, re, [s]) !== null;
  // Whether to read the response: always for submit/run/check; for GraphQL only the operations we use.
  const wantsRes = (url, text) => !hits(GRAPHQL, url) || hits(WANT_RES, text);
  const textOr = (v) => (typeof v === 'string' && v.length <= RAW_MAX ? v : null);
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
        detail: stringify({ __proto__: null, nonce }),
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
  apply(pThen, tag.keyOf(nonce), [
    (k) => {
      key = k;
      pump();
    },
  ]);
  function emit(url, reqBody, resBody, reqAt) {
    if (typeof url !== 'string' || url.length > URL_MAX) return;
    const body = stringify({
      __proto__: null,
      v: 3,
      seq: ++seq,
      url,
      reqText: textOr(reqBody),
      resText: textOr(resBody),
      reqAt,
      resAt: now(),
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
    apply(pThen, tag.sign(key, node.body), [
      (t) => {
        const detail = stringify({ __proto__: null, body: node.body, tag: t });
        dispatch(new Custom('aperture-lc', { __proto__: null, detail }));
        done();
      },
      done,
    ]);
  }
  // A promise's value, for side effects only — never chained on, never awaited.
  const when = (p, ok) => (p ? apply(pThen, p, [ok, () => ok(null)]) : ok(null));

  // ---- fetch ----
  const realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input, init) {
      // The URL, read once and handed to the real fetch as that same string — so what we record is what
      // was asked for. A Request's url is fixed, so a Request passes through as is.
      let url = null;
      let req = null;
      if (typeof input === 'string') url = input;
      else {
        url = safe(reqUrl, input, []);
        if (url !== null) req = input;
        else url = safe(urlHref, input, []);
        if (url === null) url = safe(Str, undefined, [input]);
      }
      const args = req || typeof input === 'string' ? arguments : [url, init];
      if (!hits(OURS, url)) return apply(realFetch, this, args);
      let bodyNow = null; // the request text when it's in hand now; else read from a clone of the Request
      let bodyLater = null;
      const b = init != null ? init.body : undefined;
      if (typeof b === 'string') bodyNow = b;
      else if (b == null && req) bodyLater = safe(reqText, safe(reqClone, req, []), []);
      const p = apply(realFetch, this, args);
      const reqAt = now();
      when(p, (res) => {
        // Ours runs first: the page hasn't read the body yet.
        const copy = res && (bodyLater || wantsRes(url, bodyNow)) ? safe(resClone, res, []) : null;
        const resP = copy ? safe(resText, copy, []) : null;
        when(bodyLater, (later) => {
          const reqBody = bodyLater ? later : bodyNow;
          if (!resP || !wantsRes(url, reqBody)) return emit(url, reqBody, null, reqAt);
          when(resP, (text) => emit(url, reqBody, text, reqAt));
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
      if (hits(OURS, url)) {
        const reqBody = typeof body === 'string' ? body : null;
        const reqAt = now();
        safe(addListener, this, [
          'loadend',
          () => {
            let text = null;
            const status = safe(xhrStatus, this, []);
            const type = safe(xhrType, this, []);
            // LeetCode's XHRs are text (captured 2026-11-08); a 'json' one would need a page-patchable
            // serialization, so it goes without its response.
            if (
              wantsRes(url, reqBody) &&
              status >= 200 &&
              status < 300 &&
              (type === '' || type === 'text')
            )
              text = safe(xhrText, this, []);
            emit(url, reqBody, text, reqAt);
          },
        ]);
      }
      return apply(realSend, this, arguments);
    };
  }
})();
