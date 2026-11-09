// Aperture's LeetCode capture, page side — the MAIN world (manifest: world "MAIN", document_start), loaded
// after page/tag.js and page/wire.js (copies of lib/'s: README → How it works). It watches LeetCode's own
// fetch/XHR traffic and passes what it means to the isolated world (content.js) as tagged messages. It is purely passive: it never blocks or alters a
// request, issues none of its own, reads no extension API, and nothing ever flows back into it — no server
// reply reaches the page (forgery rule 2). Why the tags: README → How it works → The relay.
(() => {
  'use strict';
  const NS = globalThis.ApertureLC;
  if (!NS || !NS.wire || !NS.tag) return;
  const { wire, tag } = NS;
  // The libs were only for this closure; the page never sees them.
  try {
    delete globalThis.ApertureLC;
  } catch {}

  // The originals, bound before any LeetCode script exists.
  const dispatch = EventTarget.prototype.dispatchEvent.bind(window);
  const listen = EventTarget.prototype.addEventListener.bind(window);
  const Custom = CustomEvent;
  const stringify = JSON.stringify;
  const now = Date.now;
  const every = setInterval;

  // The handshake: this load's nonce goes to the isolated world once — before any page script can listen.
  // Whichever world runs first, the hello lands: an early hello is caught by the isolated side's own
  // "ready", answered once and never again after the ack.
  const nonce = tag.newNonce();
  const keyReady = tag.keyOf(nonce);
  let acked = false;
  let reHelloed = false;
  const hello = () => dispatch(new Custom('aperture-lc-hello', { detail: stringify({ nonce }) }));
  listen('aperture-lc-ack', () => {
    acked = true;
  });
  listen('aperture-lc-ready', () => {
    if (acked || reHelloed) return;
    reHelloed = true;
    hello();
  });
  hello();

  // Each item goes out as {body, tag}: the tag is HMAC-SHA256(nonce, body), and body carries a sequence
  // number, so a page script that hears messages can neither mint one nor replay one. One promise chain
  // keeps the dispatch order equal to the sequence.
  let seq = 0;
  let chain = Promise.resolve();
  function emit(item) {
    const s = ++seq;
    chain = chain
      .then(async () => {
        const body = stringify({ v: 2, seq: s, ...item });
        const t = await tag.sign(await keyReady, body);
        dispatch(new Custom('aperture-lc', { detail: stringify({ body, tag: t }) }));
      })
      .catch(() => {});
  }

  const capture = wire.createCapture();
  function handle(url, reqText, resText, reqAt) {
    try {
      for (const item of capture.observe({ url, reqText, resText, reqAt, resAt: now() }))
        emit(item);
    } catch {}
  }
  every(() => {
    try {
      capture.sweep(now()).forEach(emit);
    } catch {}
  }, 15_000);

  // ---- fetch ----
  const realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input, init) {
      let url = null;
      let reqBody = Promise.resolve(null);
      let known = false; // the request text is in hand now, so whether to read the response is decided now
      let knownText = null;
      try {
        url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input && input.url;
        if (url && wire.interesting(url)) {
          if (init && typeof init.body === 'string') {
            known = true;
            knownText = init.body;
          } else if (init && init.body != null) {
            known = true; // not text (FormData, a stream): none of the requests we read look like this
          } else if (input && typeof input === 'object' && typeof input.clone === 'function') {
            reqBody = input
              .clone()
              .text()
              .catch(() => null); // before fetch disturbs the Request's body
          } else known = true;
        } else url = null;
      } catch {
        url = null;
      }
      const p = realFetch.apply(this, arguments);
      if (url) {
        const reqAt = now();
        const needRes = !known || wire.wantsResponse(url, knownText);
        p.then(
          (res) => {
            let copy = null;
            try {
              if (needRes) copy = res.clone(); // ours runs first: the page hasn't read the body yet
            } catch {}
            Promise.all([known ? knownText : reqBody, copy ? copy.text().catch(() => null) : null])
              .then(([reqText, resText]) =>
                handle(url, reqText, wire.wantsResponse(url, reqText) ? resText : null, reqAt),
              )
              .catch(() => {});
          },
          () => {
            Promise.resolve(known ? knownText : reqBody)
              .then((reqText) => handle(url, reqText, null, reqAt))
              .catch(() => {});
          },
        );
      }
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const realOpen = XHR.prototype.open;
    const realSend = XHR.prototype.send;
    const urls = new WeakMap();
    XHR.prototype.open = function (_method, url) {
      try {
        urls.set(this, String(url));
      } catch {}
      return realOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        const url = urls.get(this);
        if (url && wire.interesting(url)) {
          const reqText = typeof body === 'string' ? body : null;
          const reqAt = now();
          this.addEventListener('loadend', () => {
            let resText = null;
            try {
              if (wire.wantsResponse(url, reqText) && this.status >= 200 && this.status < 300) {
                if (this.responseType === '' || this.responseType === 'text')
                  resText = this.responseText;
                else if (this.responseType === 'json' && this.response != null)
                  resText = stringify(this.response);
              }
            } catch {}
            handle(url, reqText, resText, reqAt);
          });
        }
      } catch {}
      return realSend.apply(this, arguments);
    };
  }
})();
