// LeetCode's own timer, read from localStorage QD_TIMER_STATE — {mode:'forward'|'reverse' (stopwatch|countdown),
// startTimestamp, pauseMs, endMs, lastUsedEndMs, status:'idle'|'running'|'pause', isUserPaused}. Read the same
// way as A1's lcTimerState (packages/shared/src/sittings.ts), confirmed by the 2026-11-10 debug log: pauseMs is
// elapsed-at-pause; a resume clears it and backdates startTimestamp by it, so running elapsed is now − start.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).timer = api;
})(globalThis, function () {
  'use strict';
  const KEY = 'QD_TIMER_STATE';
  const HEARTBEAT_KEY = 'QD_TIMER_HEARTBEAT';
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  function parseTimerState(json, now) {
    let s;
    try {
      s = JSON.parse(json);
    } catch {
      return null;
    }
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const pauseMs = num(s.pauseMs) ?? 0;
    const start = num(s.startTimestamp);
    const status = typeof s.status === 'string' ? s.status : null;
    const running = start !== null && status !== 'pause';
    return {
      mode: typeof s.mode === 'string' ? s.mode : null,
      status,
      running,
      elapsedMs: running ? pauseMs + Math.max(0, now - start) : pauseMs,
      endMs: num(s.endMs),
    };
  }
  // What Start's timer step waits for: a clock that is running and was (re)started just now.
  const startedFresh = (state, withinMs = 10_000) =>
    !!state && state.running && state.elapsedMs <= withinMs;

  // Whether Start has to reset LeetCode's timer before starting it: any state but idle (running, paused, or one
  // never seen, like a countdown that ran out). No state at all is a timer never used: idle.
  const needsReset = (state) => !!state && state.status !== 'idle';

  return { KEY, HEARTBEAT_KEY, parseTimerState, startedFresh, needsReset };
});
