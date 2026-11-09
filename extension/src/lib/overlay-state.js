// The overlay's state machine, per tab — pure: reduce(state, action) → {state, effects}. content.js runs the
// effects (clicks, the server Start) and feeds their outcome back as actions; overlay.js paints the state.
//   hidden ─nav(problem)→ prompt ─start→ starting(reset → confirm → timer → send) ─started→ active
//   prompt ─dismiss→ hidden (remembered for the slug, this browser session)
//   starting ─stepFail→ failed ─retry→ starting(reset) | ─startAnyway→ starting(send) | ─dismiss→ hidden
//   nav(problem with an open sitting) → resuming ─resumed(active)→ active | ─resumed(not)→ prompt
//   active ─ended→ ended (badge only; the next nav prompts again)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.ApertureLC = root.ApertureLC || {}).overlayState = api;
})(globalThis, function () {
  'use strict';
  const STEPS = ['reset', 'confirm', 'timer', 'send'];
  const initial = () => ({ phase: 'hidden', slug: null, step: null, reason: null, retrying: null });
  const at = (state, patch) => ({ ...state, retrying: null, ...patch });
  const same = (state) => ({ state, effects: [] });

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
      case 'retry':
        if (state.phase !== 'prompt' && state.phase !== 'failed') return same(state);
        return {
          state: at(state, { phase: 'starting', step: 'reset', reason: null }),
          effects: [{ do: 'step', step: 'reset' }],
        };
      case 'startAnyway':
        if (state.phase !== 'failed') return same(state);
        return {
          state: at(state, { phase: 'starting', step: 'send', reason: null }),
          effects: [{ do: 'step', step: 'send' }],
        };
      case 'stepOk': {
        if (state.phase !== 'starting' || state.step !== action.step || action.step === 'send')
          return same(state);
        const next = STEPS[STEPS.indexOf(action.step) + 1];
        return { state: at(state, { step: next }), effects: [{ do: 'step', step: next }] };
      }
      case 'stepFail':
        if (state.phase !== 'starting' || state.step !== action.step) return same(state);
        return { state: at(state, { phase: 'failed', reason: action.reason }), effects: [] };
      case 'retrying':
        if (state.phase !== 'starting') return same(state);
        return { state: { ...state, retrying: action.reason }, effects: [] };
      case 'started':
        if (state.phase !== 'starting') return same(state);
        return { state: at(state, { phase: 'active', step: null }), effects: [] };
      case 'dismiss':
        if (state.phase !== 'prompt' && state.phase !== 'failed') return same(state);
        return {
          state: at(state, { phase: 'hidden', step: null, reason: null }),
          effects: [{ do: 'rememberDismiss' }],
        };
      case 'resumed':
        if (state.phase !== 'resuming') return same(state);
        return action.active
          ? { state: at(state, { phase: 'active' }), effects: [] }
          : { state: at(state, { phase: 'prompt' }), effects: [{ do: 'clearBinding' }] };
      case 'ended':
        if (state.phase !== 'active' && state.phase !== 'resuming') return same(state);
        return { state: at(state, { phase: 'ended' }), effects: [{ do: 'clearBinding' }] };
      default:
        return same(state);
    }
  }
  return { STEPS, initial, reduce };
});
