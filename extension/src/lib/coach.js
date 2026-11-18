// The coach's rules — pure, over a caller's clock. A submit (its request, however it was made: a click, ⌘↵)
// within a minute of a failed verdict gets a non-blocking "trace the failing input" note on the badge. What happened goes to Aperture as `coach` events
// (packages/shared/src/types.ts CoachEventPayload): `config` once a sitting, `nudge-shown` per note. The note is
// off-able in Options (storage.local coachNudge — absent means on). The trace card it once had is retired
// (2.2.0): whether a sitting was traced is the server's call, from the code (README → step 9).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).coach = api;
})(globalThis, function () {
  'use strict';
  const KEYS = Object.freeze({ nudge: 'coachNudge' });
  const RETIRED_KEYS = ['coachTrace', 'coachHold']; // the trace card's switches, removed by Options
  const NUDGE_MS = 60_000; // a submit this soon after a failed verdict gets the note
  const NOTE_MS = 8000; // how long a badge note shows
  const ACCEPTED = 10; // LeetCode's raw status_code for Accepted; no other verdict logic here

  // The switch from storage: anything but `false` is on.
  const settingsOf = (got) => ({ nudge: !got || got[KEYS.nudge] !== false });

  // A judged submit's verdict from its raw result: 'accepted', 'failed', or null (unjudged or unreadable).
  function verdictOf(payload) {
    const r = payload && payload.result;
    if (!r || typeof r !== 'object' || r.pending || typeof r.status_code !== 'number') return null;
    return r.status_code === ACCEPTED ? 'accepted' : 'failed';
  }
  // The gap to a failed verdict this submit follows within a minute (null: no note). `last` is
  // {at (when the verdict came), verdict}.
  function nudgeGap({ settings, last, now }) {
    if (!settings || !settings.nudge || !last || last.verdict !== 'failed') return null;
    const gap = now - last.at;
    return gap >= 0 && gap <= NUDGE_MS ? gap : null;
  }

  const event = (payload, mintId, at) => ({ id: mintId(), type: 'coach', at, payload });
  // Whether the note is on, once a sitting.
  const configPayload = (s) => ({ kind: 'config', nudge: s.nudge });

  return {
    KEYS,
    RETIRED_KEYS,
    NUDGE_MS,
    NOTE_MS,
    settingsOf,
    verdictOf,
    nudgeGap,
    event,
    configPayload,
  };
});
