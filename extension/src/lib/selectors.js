// Where LeetCode's own controls are. The known ones come from the 2026-11-08 page dump; the editor reset, its
// confirm and the timer start are UNKNOWN until Rahul's debug session (README → Debug mode), so they ship
// null and the overlay says "not configured" — Continue without a clear still keeps the sitting. Options → Selectors
// overrides any of them without a rebuild (LeetCode moves its DOM; a prod Xcode rebuild is the slow path).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).selectors = api;
})(globalThis, function () {
  'use strict';
  const DEFAULTS = Object.freeze({
    editorReset: null, // one of the five unlabelled icon buttons in #editor's toolbar (dump) — UNKNOWN
    resetConfirm: null, // the "Are you sure" modal's confirm button — UNKNOWN
    dialog: '[role="dialog"],[role="alertdialog"]',
    // Clicked in order to (re)start LeetCode's timer: e.g. its reset ([aria-label="Reset"], dump), then its
    // start control — UNKNOWN. Empty = not configured.
    timerClicks: [],
    lang: '[data-e2e-locator="lang-selector-button"]',
    run: '[data-e2e-locator="console-run-button"]',
    submit: '[data-e2e-locator="console-submit-button"]',
  });
  const KEYS = Object.keys(DEFAULTS);

  // Overrides from storage (an object, or its JSON text) over the defaults; unknown keys and wrong types
  // are ignored, so a bad paste can't break the overlay.
  function merge(overrides) {
    let o = overrides;
    if (typeof o === 'string') {
      try {
        o = JSON.parse(o);
      } catch {
        o = null;
      }
    }
    const out = { ...DEFAULTS };
    if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
    for (const k of KEYS) {
      const v = o[k];
      if (k === 'timerClicks') {
        if (Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim()))
          out[k] = v.slice(0, 5);
      } else if (v === null || (typeof v === 'string' && v.trim())) out[k] = v;
    }
    return out;
  }
  return { DEFAULTS, KEYS, merge };
});
