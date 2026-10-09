// Pure event → spoken-phrase reducer for voice cues. No DOM, no SpeechSynthesis,
// no Date.now — time is passed in — so it's deterministic and unit-testable. The
// effectful SpeechSynthesis calls live in speaker.ts. Cooldowns run off the last
// *spoken* time so dropped candidates don't shift the clock.

import type { ExerciseEvent } from '@aperture/shared/flux';

export type CuePriority = 'high' | 'normal';

export interface Utterance {
  readonly text: string;
  readonly priority: CuePriority; // "high" interrupts and bypasses cooldowns
}

export interface CueState {
  readonly lastByType: Partial<Record<ExerciseEvent['type'], number>>;
  readonly lastUtteranceAt: number; // ms of the last emitted utterance
  readonly lastText: string | null;
}

export const initialCueState: CueState = {
  lastByType: {},
  lastUtteranceAt: Number.NEGATIVE_INFINITY,
  lastText: null,
};

// Per-event-type minimum spacing (ms). Absent = no per-type cooldown.
const COOLDOWN_MS: Partial<Record<ExerciseEvent['type'], number>> = {
  repCompleted: 600,
  holdStarted: 500,
  holdCompleted: 500,
  positionReached: 1500,
  trialCompleted: 800,
  driftWarning: 4000,
  postureWarning: 4000,
};
const MIN_GAP_MS = 600; // global anti-overlap between any two utterances
const DEDUP_MS = 1200; // suppress back-to-back identical text

function phraseFor(e: ExerciseEvent): Utterance | null {
  switch (e.type) {
    case 'setCompleted':
      return { text: 'Set complete. Well done.', priority: 'high' };
    case 'repCompleted':
      return {
        text: e.reachedTarget ? 'Good, full range' : 'Good',
        priority: 'normal',
      };
    case 'holdStarted':
      return { text: 'Hold', priority: 'normal' };
    case 'holdCompleted':
      return { text: 'And release', priority: 'normal' };
    case 'positionReached':
      return { text: 'Hold it there', priority: 'normal' };
    case 'trialCompleted':
      return { text: 'Nice', priority: 'normal' };
    case 'driftWarning':
      return { text: 'Head still', priority: 'normal' };
    case 'postureWarning':
      return { text: 'Keep steady, one plane', priority: 'normal' };
    case 'positionLost': // boundary flicker — the visual already shows it
    case 'cycleCompleted': // fires many times per gaze set — would be chatter
      return null;
  }
}

export function reduceCue(
  state: CueState,
  event: ExerciseEvent,
  nowMs: number,
): { readonly state: CueState; readonly utterance: Utterance | null } {
  const u = phraseFor(event);
  if (!u) return { state, utterance: null };

  if (u.priority !== 'high') {
    const cd = COOLDOWN_MS[event.type] ?? 0;
    const lastType = state.lastByType[event.type] ?? Number.NEGATIVE_INFINITY;
    if (nowMs - lastType < cd) return { state, utterance: null };
    if (nowMs - state.lastUtteranceAt < MIN_GAP_MS) return { state, utterance: null };
    if (u.text === state.lastText && nowMs - state.lastUtteranceAt < DEDUP_MS)
      return { state, utterance: null };
  }

  return {
    state: {
      lastByType: { ...state.lastByType, [event.type]: nowMs },
      lastUtteranceAt: nowMs,
      lastText: u.text,
    },
    utterance: u,
  };
}
