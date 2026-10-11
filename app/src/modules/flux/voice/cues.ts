// Pure event → spoken-phrase reducer for voice cues. No DOM, no SpeechSynthesis,
// no Date.now — time is passed in — so it's deterministic and unit-testable. The
// effectful SpeechSynthesis calls live in speaker.ts. Cooldowns run off the last
// *spoken* time so dropped candidates don't shift the clock. Rep counts, "Set
// complete" and "And release" bypass every gate and queue, so a number — or the
// release you're waiting for with your eyes closed — is never dropped (D27, D34).

import type { ExerciseEvent } from '@aperture/shared/flux';

// high: bypasses the gates and interrupts (the speaker cancels in-flight speech);
// always: bypasses the gates but queues; normal: gated by cooldown, gap and dedup.
export type CuePriority = 'high' | 'always' | 'normal';

export interface Utterance {
  readonly text: string;
  readonly priority: CuePriority;
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
  holdStarted: 500,
  positionReached: 1500,
  trialCompleted: 800,
  holdBroken: 3000,
  driftWarning: 4000,
};
const MIN_GAP_MS = 600; // global anti-overlap between any two utterances
const DEDUP_MS = 1200; // suppress back-to-back identical text

const NUMBERS = (
  'One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen Fifteen ' +
  'Sixteen Seventeen Eighteen Nineteen Twenty'
).split(' ');
const countWord = (n: number) => NUMBERS[n - 1] ?? String(n);

function phraseFor(e: ExerciseEvent): Utterance | null {
  switch (e.type) {
    case 'setCompleted':
      // Queued, not interrupting — "high" used to cancel the final count.
      return { text: 'Set complete. Well done.', priority: 'always' };
    case 'holdReached':
      return { text: countWord(e.count), priority: 'always' };
    case 'repCompleted':
      // With an end-range hold the count was spoken at holdReached; an early return still counts aloud.
      return e.holdReached ? null : { text: countWord(e.count), priority: 'always' };
    case 'holdStarted':
      return { text: 'Hold', priority: 'normal' };
    case 'holdCompleted':
      // The eyes-closed signal that the time is up — never gated; timer-paced, so it can't chatter.
      return { text: 'And release', priority: 'always' };
    case 'holdBroken':
      return { text: 'Back into position', priority: 'normal' };
    case 'positionReached':
      return { text: 'Hold it there', priority: 'normal' };
    case 'trialCompleted':
      return { text: 'Nice', priority: 'normal' };
    case 'driftWarning':
      return { text: 'Head still', priority: 'normal' };
    case 'postureWarning': // visual only — the panel's Keep steady line; spoken, it fired constantly
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

  if (u.priority === 'normal') {
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
