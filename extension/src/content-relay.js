// Aperture relay — runs in the ISOLATED content-script world (default).
// The MAIN-world interceptor (inject-main.js) can patch page globals but has NO access to the
// browser.* / chrome.* extension APIs. This relay bridges the gap: it listens for the CustomEvent
// dispatched on window by the interceptor and forwards the payload to the background script.

(() => {
  "use strict";

  const runtime =
    (typeof browser !== "undefined" && browser.runtime && browser) ||
    (typeof chrome !== "undefined" && chrome.runtime && chrome) ||
    null;

  if (!runtime) return;

  window.addEventListener("aperture-leetcode-attempt", (e) => {
    try {
      const payload = e && e.detail;
      if (!payload) return;
      const p = runtime.runtime.sendMessage({ type: "attempt", payload });
      // browser.* returns a promise; chrome.* may not. Swallow errors either way
      // (e.g. background not ready / no receiver) so nothing leaks to the page.
      if (p && typeof p.then === "function") p.then(() => {}, () => {});
    } catch (_err) {
      // Never throw.
    }
  });
})();
