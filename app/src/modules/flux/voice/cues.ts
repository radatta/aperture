// Pure event → spoken-phrase reducer for voice cues — the one table of every phrase the session says,
// exercise events and session cues alike. No DOM, no SpeechSynthesis, no Date.now — time is passed in —
// so it's deterministic and unit-testable. The effectful SpeechSynthesis calls live in speaker.ts.
// Cooldowns run off the last *spoken* time so dropped candidates don't shift the clock. Every state
// change you act on with your eyes closed — counts, "Hold", "And release", "Hold longer", the
// joint-position prompts, "Go", the set and session cues, "Can't see you" — bypasses the gap and dedup
// and queues, so it's never dropped (D27, D34–D43); guidance ("Further", nudges, "Back into position")
// is gated.

import type { Axis, ExerciseEvent } from '@aperture/shared/flux';

// Session cues: what the hook says about the session itself, not an exercise event (D40–D43).
export type SessionCue =
  | { readonly type: 'neutralSet' }
  | { readonly type: 'holdStillHint' }
  | { readonly type: 'getReady' }
  | { readonly type: 'nextSet'; readonly number: number; readonly otherSide: boolean }
  | { readonly type: 'sessionComplete' }
  | { readonly type: 'faceLost' }
  | { readonly type: 'faceFound' };

export type CueEvent = ExerciseEvent | SessionCue;

// high: bypasses the gates and interrupts (the speaker cancels in-flight speech);
// always: bypasses the gates but queues; normal: gated by cooldown, gap and dedup.
export type CuePriority = 'high' | 'always' | 'normal';

export interface Utterance {
  readonly text: string;
  readonly priority: CuePriority;
}

export interface CueState {
  readonly lastByType: Partial<Record<CueEvent['type'], number>>;
  readonly lastUtteranceAt: number; // ms of the last emitted utterance
  readonly lastText: string | null;
}

export const initialCueState: CueState = {
  lastByType: {},
  lastUtteranceAt: Number.NEGATIVE_INFINITY,
  lastText: null,
};

// Per-event-type minimum spacing (ms), for every priority. Absent = no per-type cooldown.
const COOLDOWN_MS: Partial<Record<CueEvent['type'], number>> = {
  holdStarted: 500,
  positionReached: 1500,
  holdBroken: 3000,
  driftWarning: 4000,
  stoppedShort: 2000,
  nudge: 3000,
  holdStillHint: 20_000,
  faceLost: 5000,
};
const MIN_GAP_MS = 600; // global anti-overlap between any two utterances
const DEDUP_MS = 1200; // suppress back-to-back identical text

const NUMBERS = (
  'One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen Fifteen ' +
  'Sixteen Seventeen Eighteen Nineteen Twenty'
).split(' ');
const countWord = (n: number) => NUMBERS[n - 1] ?? String(n);

// "more"/"less" is relative to the target's own sign, so it's right on either side and whichever way
// the device's yaw/roll signs run; pitch is verified on-device (+ = chin down), so it names the way.
function nudgePhrase(axis: Axis, toward: 'more' | 'less', deg: number): string {
  if (axis === 'pitch') return deg > 0 ? 'Chin down' : 'Chin up';
  return `${axis === 'yaw' ? 'Turn' : 'Tilt'} ${toward}`;
}

const REPOSITION_PROMPT = {
  away: 'Turn away',
  returning: 'Back to neutral',
  settling: 'Hold still',
} as const;

function phraseFor(e: CueEvent): Utterance | null {
  switch (e.type) {
    case 'setCompleted':
      // Queued, not interrupting — "high" used to cancel the final count.
      return { text: 'Set complete. Well done.', priority: 'always' };
    case 'holdReached':
      return { text: countWord(e.count), priority: 'always' };
    case 'repCompleted':
      // With an end-range hold the count was spoken at holdReached; with no hold it counts aloud on return.
      return e.holdReached ? null : { text: countWord(e.count), priority: 'always' };
    case 'holdEntered':
      // Eyes closed, it's the only sign you've gone far enough — the hold clock is running (D36).
      return { text: 'Hold', priority: 'always' };
    case 'stoppedShort':
      return { text: 'Further', priority: 'normal' };
    case 'holdStarted':
      return { text: 'Hold', priority: 'normal' };
    case 'holdCompleted':
      // The eyes-closed signal that the time is up — never gated; timer-paced, so it can't chatter.
      return { text: 'And release', priority: 'always' };
    case 'holdBroken':
      return { text: 'Back into position', priority: 'normal' };
    case 'holdShort':
      // Eyes closed, it's the only sign the rep didn't count; paced by a full excursion, so it can't chatter.
      return { text: 'Hold longer', priority: 'always' };
    case 'positionReached':
      return { text: 'Hold it there', priority: 'normal' };
    case 'nudge':
      return { text: nudgePhrase(e.axis, e.toward, e.deg), priority: 'normal' };
    case 'repositionPrompt':
      return { text: REPOSITION_PROMPT[e.sub], priority: 'always' };
    case 'trialCompleted': {
      const n = Math.round(e.errorDeg);
      return { text: `Nice. ${n} ${n === 1 ? 'degree' : 'degrees'}.`, priority: 'always' };
    }
    case 'setStarted':
      return { text: 'Go', priority: 'always' };
    case 'driftWarning':
      return { text: 'Head still', priority: 'normal' };
    case 'postureWarning': // visual only — the panel's Keep steady line; spoken, it fired constantly
    case 'positionLost': // boundary flicker — the visual already shows it
    case 'cycleCompleted': // fires many times per gaze set — would be chatter
      return null;
    case 'neutralSet':
      return { text: 'Neutral set', priority: 'always' };
    case 'holdStillHint':
      return { text: 'Hold still to set neutral', priority: 'normal' };
    case 'getReady':
      return { text: 'Get ready', priority: 'always' };
    case 'nextSet':
      return {
        text: e.otherSide ? 'Other side' : `Set ${countWord(e.number).toLowerCase()}`,
        priority: 'always',
      };
    case 'sessionComplete':
      return { text: 'Session complete.', priority: 'always' };
    case 'faceLost':
      return { text: "Can't see you", priority: 'always' };
    case 'faceFound':
      return { text: 'Tracking', priority: 'normal' };
  }
}

// Shown on the stage as well as spoken, so a muted phone still gets it — except counts (the readout's
// number, or its ring turning gold, already says it) and the joint-position prompts (the readout note
// shows the same words).
export const isMirrored = (e: CueEvent): boolean =>
  e.type !== 'repCompleted' && e.type !== 'holdReached' && e.type !== 'repositionPrompt';

export function reduceCue(
  state: CueState,
  event: CueEvent,
  nowMs: number,
): { readonly state: CueState; readonly utterance: Utterance | null } {
  const u = phraseFor(event);
  if (!u) return { state, utterance: null };

  const cd = COOLDOWN_MS[event.type] ?? 0;
  const lastType = state.lastByType[event.type] ?? Number.NEGATIVE_INFINITY;
  if (nowMs - lastType < cd) return { state, utterance: null };
  if (u.priority === 'normal') {
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
