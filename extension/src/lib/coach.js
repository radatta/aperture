// The coach's rules — pure, over a caller's clock. At a sitting's first Submit the extension holds the click
// once and shows a trace card (three inputs traced by hand: the empty or smallest, a boundary, a normal one);
// he Traces or Skips, then clicks Submit himself — the extension never clicks it. A Submit within a minute of a
// failed one gets a non-blocking "trace the failing input" note. What happened goes to Aperture as `coach`
// events (packages/shared/src/types.ts CoachEventPayload); the card, the hold and the note are each off-able in
// Options (storage.local coachTrace, coachHold, coachNudge — absent means on).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).coach = api;
})(globalThis, function () {
  'use strict';
  const KEYS = Object.freeze({ trace: 'coachTrace', hold: 'coachHold', nudge: 'coachNudge' });
  const FIELDS = ['empty', 'boundary', 'normal'];
  const INPUT_MAX = 300; // per input, as the plan stores them
  const NUDGE_MS = 60_000; // a Submit this soon after a failed verdict gets the note
  const NOTE_MS = 8000; // how long a badge note shows
  const ACCEPTED = 10; // LeetCode's raw status_code for Accepted; no other verdict logic here

  // The switches from storage: anything but `false` is on. The hold needs the card, so it's off without it.
  function settingsOf(got) {
    const on = (k) => !got || got[KEYS[k]] !== false;
    const trace = on('trace');
    return { trace, hold: trace && on('hold'), nudge: on('nudge') };
  }

  // The card's three fields: trimmed, at most 300 characters, blank → null.
  function traceInputs(raw) {
    const out = {};
    for (const k of FIELDS) {
      const v = raw && typeof raw[k] === 'string' ? raw[k].trim().slice(0, INPUT_MAX) : '';
      out[k] = v || null;
    }
    return out;
  }
  const msOf = (ms) => (Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0);
  // Trace with nothing typed is a Skip.
  function cardPayload(raw, ms) {
    const inputs = traceInputs(raw);
    return FIELDS.some((k) => inputs[k])
      ? { kind: 'trace', inputs, ms: msOf(ms) }
      : { kind: 'trace-skip', ms: msOf(ms) };
  }

  // Whether this Submit click is held: a real click, on LeetCode's Submit, in an open sitting, with the hold on,
  // before any trace, skip or submit — and only once a sitting. `coach` is the binding's coach state.
  function shouldHold({ settings, trusted, active, coach }) {
    const c = coach || {};
    return !!(settings && settings.hold && trusted && active && !c.trace && !c.held);
  }

  // A judged submit's verdict from its raw result: 'accepted', 'failed', or null (unjudged or unreadable).
  function verdictOf(payload) {
    const r = payload && payload.result;
    if (!r || typeof r !== 'object' || r.pending || typeof r.status_code !== 'number') return null;
    return r.status_code === ACCEPTED ? 'accepted' : 'failed';
  }
  // The gap to a failed verdict this Submit follows within a minute (null: no note). `last` is
  // {at (when the verdict came), verdict}.
  function nudgeGap({ settings, last, now }) {
    if (!settings || !settings.nudge || !last || last.verdict !== 'failed') return null;
    const gap = now - last.at;
    return gap >= 0 && gap <= NUDGE_MS ? gap : null;
  }

  const event = (payload, mintId, at) => ({ id: mintId(), type: 'coach', at, payload });
  const configPayload = (s) => ({ kind: 'config', trace: s.trace, hold: s.hold, nudge: s.nudge });

  return {
    KEYS,
    FIELDS,
    INPUT_MAX,
    NUDGE_MS,
    NOTE_MS,
    settingsOf,
    traceInputs,
    cardPayload,
    shouldHold,
    verdictOf,
    nudgeGap,
    event,
    configPayload,
  };
});
