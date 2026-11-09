// LeetCode's own timer, read from localStorage QD_TIMER_STATE — {mode:'reverse', startTimestamp, pauseMs,
// endMs, status, …} (2026-11-08 capture). Read the same way as A1's lcTimerState (packages/shared/src/
// sittings.ts): pauseMs is elapsed-at-pause; a running timer adds now − startTimestamp. That reading is an
// inference until the debug session's log confirms it.
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

  return { KEY, HEARTBEAT_KEY, parseTimerState, startedFresh };
});
