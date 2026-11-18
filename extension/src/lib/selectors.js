// Where LeetCode's own controls are. The language comes from the 2026-11-08 page dump; the editor
// reset, its confirm and the timer's controls from the maintainer's debug session (2026-11-10, localNotes/debug-log.json).
// Options → Selectors overrides any of them without a rebuild (LeetCode moves its DOM; a prod Xcode rebuild is the
// slow path). `null` on a click key (editorReset, resetConfirm, timer*) turns that step off: the overlay says "not
// configured" and Continue still keeps the sitting. `dialog` and `lang` aren't steps — leave them set.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).selectors = api;
})(globalThis, function () {
  'use strict';
  const DEFAULTS = Object.freeze({
    // The 4th of the five unlabelled icons in the editor toolbar's right-hand group (the logged path). Pinned to
    // exactly five: an icon added or removed reads as "not found", never a neighbour's click (a reorder still would).
    editorReset:
      '#editor > div:nth-of-type(1) > div:nth-of-type(2) > button:nth-of-type(4):nth-last-of-type(2)',
    // The "Are you sure?" modal, which LeetCode renders inside #editor. Narrow on purpose: the streaks and
    // timer pop-overs are [role=dialog] too (Radix, id^=radix-, no aria-modal) and would pass for it.
    dialog: '#editor [role="dialog"][aria-modal="true"]',
    // Its Confirm, by its green: a reordered Cancel/Confirm pair can't be clicked as the confirm.
    resetConfirm: '#editor [role="dialog"][aria-modal="true"] button.bg-green-s',
    // The idle timer's opener — "Stopwatch" as logged in forward mode; "Timer" is a guess for countdown.
    timerOpen: '[role="button"][aria-label="Stopwatch"],[role="button"][aria-label="Timer"]',
    // The pop-up's Start Stopwatch / Start Timer, and its Reset Stopwatch / Reset Timer — in an OPEN pop-up only:
    // a click on our overlay dismisses it (Radix), and while it animates out it is still there, `data-state="closed"`.
    // The toolbar logged 2026-11-14 (debug log 11) has its own Start instead: the idle clock's control.
    timerStart:
      '[role="dialog"][id^="radix-"][data-state="open"] button.bg-sd-primary,[role="button"][aria-label="Start"]',
    // A [role=button] div on the 2026-11-10 toolbar; a plain <button> on the one logged 2026-11-13/14, where it
    // resets with no pop-up (debug logs 10a, 11).
    timerReset: '[role="button"][aria-label="Reset"],button[aria-label="Reset"]',
    timerResetConfirm: '[role="dialog"][id^="radix-"][data-state="open"] button.bg-sd-secondary',
    lang: '[data-e2e-locator="lang-selector-button"]',
  });
  const KEYS = Object.keys(DEFAULTS);
  // The keys `null` turns off: each click step; `dialog` and `lang` aren't steps, so a null there is ignored.
  const OFFABLE = [
    'editorReset',
    'resetConfirm',
    'timerOpen',
    'timerStart',
    'timerReset',
    'timerResetConfirm',
  ];
  // Keys no longer read, which Options drops from a saved override: `submit` (2.2.1), LeetCode's Submit button —
  // the resubmit note reads the submit request instead, so ⌘↵ counts (lib/coach.js). Its `null` meant "note
  // off", which Options carries over to the note's switch.
  const RETIRED = ['submit'];

  // Overrides from storage (an object, or its JSON text) over the defaults: each key a non-empty string, or null
  // on an off-able key.
  // Unknown keys (a retired `timerClicks` or `submit` too) and wrong types are ignored, so a bad paste can't break the overlay.
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
      if ((v === null && OFFABLE.includes(k)) || (typeof v === 'string' && v.trim())) out[k] = v;
    }
    return out;
  }
  return { DEFAULTS, KEYS, RETIRED, merge };
});
