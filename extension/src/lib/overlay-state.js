// The overlay's state machine, per tab — pure: reduce(state, action) → {state, effects}. content.js runs the
// effects (the server Start, then the clicks) and feeds their outcome back as actions; overlay.js paints it.
// The server goes first: a Start Aperture refuses never touches the editor. `open` says the sitting exists.
//   hidden ─nav(problem)→ prompt ─start→ starting(send → reset → confirm → timer) → active
//   prompt ─dismiss→ hidden (remembered for the slug, this browser session)
//   starting ─stepFail→ failed:
//     not open (the send failed) ─retry→ starting(send) | ─dismiss→ hidden
//     open (a click failed)      ─retry→ starting(that step, or an earlier one) | ─continue→ active
//   active | resuming | open ─ended→ ended
//   nav(problem with an open sitting) → resuming ─resumed(active)→ active | ─resumed(not)→ prompt
//   ended: badge only; the next nav prompts again
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).overlayState = api;
})(globalThis, function () {
  'use strict';
  const STEPS = ['send', 'reset', 'confirm', 'timer'];
  const initial = () => ({
    phase: 'hidden',
    slug: null,
    step: null,
    reason: null,
    retrying: null,
    open: false,
  });
  const at = (state, patch) => ({ ...state, retrying: null, ...patch });
  const same = (state) => ({ state, effects: [] });
  const go = (state, step) => ({
    state: at(state, { phase: 'starting', step, reason: null }),
    effects: [{ do: 'step', step }],
  });

  function reduce(state, action) {
    switch (action.type) {
      case 'nav': {
        const base = { ...initial(), slug: action.slug || null };
        if (!action.slug) return { state: base, effects: [] };
        if (action.binding && action.binding.status === 'active')
          return { state: { ...base, phase: 'resuming' }, effects: [{ do: 'resume' }] };
        if (action.dismissed) return { state: base, effects: [] };
        return { state: { ...base, phase: 'prompt' }, effects: [] };
      }
      case 'start':
        return state.phase === 'prompt' ? go(state, 'send') : same(state);
      case 'retry': {
        if (state.phase !== 'failed') return same(state);
        if (!state.open) return go(state, 'send');
        // A click step again; `from` may step back (LeetCode's confirm dialog closed → the reset again).
        const back = STEPS.indexOf(action.from);
        return go(state, back > 0 && back <= STEPS.indexOf(state.step) ? action.from : state.step);
      }
      case 'continue':
        if (state.phase !== 'failed' || !state.open) return same(state);
        return { state: at(state, { phase: 'active', step: null, reason: null }), effects: [] };
      case 'stepOk': {
        if (state.phase !== 'starting' || state.step !== action.step) return same(state);
        const next = STEPS[STEPS.indexOf(action.step) + 1];
        const open = state.open || action.step === 'send';
        if (!next) return { state: at(state, { phase: 'active', step: null, open }), effects: [] };
        return { state: at(state, { step: next, open }), effects: [{ do: 'step', step: next }] };
      }
      case 'stepFail':
        if (state.phase !== 'starting' || state.step !== action.step) return same(state);
        return { state: at(state, { phase: 'failed', reason: action.reason }), effects: [] };
      case 'retrying':
        if (state.phase !== 'starting') return same(state);
        return { state: { ...state, retrying: action.reason }, effects: [] };
      case 'dismiss':
        // Just looking only while nothing is open; an open sitting's way out is Retry or Continue.
        if (state.phase !== 'prompt' && !(state.phase === 'failed' && !state.open))
          return same(state);
        return {
          state: at(state, { phase: 'hidden', step: null, reason: null }),
          effects: [{ do: 'rememberDismiss' }],
        };
      case 'resumed':
        if (state.phase !== 'resuming') return same(state);
        return action.active
          ? { state: at(state, { phase: 'active', open: true }), effects: [] }
          : { state: at(state, { phase: 'prompt' }), effects: [{ do: 'clearBinding' }] };
      case 'ended':
        // Also mid-Start once the sitting is open: a Retry would otherwise click LeetCode's reset for a
        // sitting Aperture has already closed.
        if (state.phase !== 'active' && state.phase !== 'resuming' && !state.open)
          return same(state);
        return { state: at(state, { phase: 'ended' }), effects: [{ do: 'clearBinding' }] };
      default:
        return same(state);
    }
  }
  return { STEPS, initial, reduce };
});
