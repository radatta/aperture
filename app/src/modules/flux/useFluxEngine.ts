import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Condition,
  Euler,
  EvalControl,
  ExerciseId,
  ExerciseKind,
  ExerciseState,
} from '@aperture/shared/flux';
import {
  createFluxEngine,
  type EngineDebug,
  type FluxEngineEvent,
  type StageElements,
} from './engine/engine';
import type { Delegate, ErrorStage, Sample } from './engine/protocol';
import type { Side } from './engine/side';
import { readForcedCpu, readGpuBootMark } from './prefs';
import type { VoiceControl } from './useVoice';
import { initialCueState, isMirrored, reduceCue, type CueEvent, type CueState } from './voice/cues';

// The Flux stage's state machine over a FluxEngine — what flux-track's route held in a dozen useStates,
// with a live error and a paused state it never had. Only derived numbers reach React: samples are
// throttled to ~16 Hz for display, exercise state arrives at ~15 Hz from the engine.
//
// Once Start is tapped the session runs itself, eyes and hands free (the guiding principle): the neutral
// sets itself (D40), timed kinds start on their own (D41), sets follow each other after a rest and the
// session ends itself (D42), and a lost face is said out loud (D43).

export type FluxStatus = 'idle' | 'loading' | 'running' | 'paused' | 'error';

// One finished set, as the session holds it — the shape Flux history (the next PR) persists.
export interface FluxSetDraft {
  readonly exerciseId: ExerciseId;
  readonly kind: ExerciseKind;
  readonly side: Side | null;
  readonly condition: Condition | null; // the library chip when the set was done
  readonly count: number;
  readonly avgPeakDeg?: number;
  readonly avgErrorDeg?: number;
  readonly rom: Euler;
  readonly calibrated: boolean;
  readonly delegate: Delegate | null;
  readonly durationSec: number; // from the set's start (selection, Start/Again, or the last set) to done
  readonly completedAt: number; // epoch ms
}

// What Stop hands back: the session's active minutes (paused time excluded) and how many sets it held.
export interface SessionSummary {
  readonly activeMs: number;
  readonly sets: number;
}

export interface FluxEngineOptions {
  readonly exerciseId: ExerciseId;
  readonly kind: ExerciseKind;
  readonly side: Side | null; // null for exercises without a side
  readonly condition: Condition | null;
  // The contraindication gate: until acknowledged the engine runs with no exercise selected.
  readonly acknowledged: boolean;
  readonly voice: VoiceControl;
  readonly sets?: number; // sets this session, set before Start (D42); DEFAULT_SETS
  readonly onSetCompleted?: (set: FluxSetDraft, index: number) => void;
  // The rest is over and set `index` (0-based) is about to start — a sided stretch flips its side here.
  readonly onNextSet?: (index: number) => void;
  // The last set finished and the session stopped itself — the same summary Stop returns.
  readonly onSessionEnd?: (summary: SessionSummary) => void;
}

export const DEFAULT_SETS = 2;
// Kinds that wait for a Start: the session starts them itself, after a lead-in (D41).
const READY_KINDS: ReadonlySet<ExerciseKind> = new Set(['guidedHold', 'reposition', 'oscillation']);
const SET_LEAD_MS = 3000; // "Get ready" → the set starts
const SET_REST_MS = 30_000; // between sets (D42)
const FACE_LOST_SEC = 1; // gone this long → "Can't see you" (D43)
const FACE_BACK_SEC = 0.5; // back this long → "Tracking"
const HOLD_STILL_HINT_SEC = 20; // a visible face with no neutral this long → the hint (D40)

// A pending automatic step, kept so a pause can cancel it and Resume can re-arm it.
type AutoStep = { readonly kind: 'start' } | { readonly kind: 'rest'; readonly index: number };

const DISPLAY_MS = 60;
const NOTICE_MS = 2500;
const CUE_MS = 2000;
const ZERO: Euler = { pitch: 0, yaw: 0, roll: 0 };
export const IDLE_SAMPLE: Sample = {
  rel: ZERO,
  rom: ZERO,
  raw: ZERO,
  faceVisible: false,
  fps: 0,
  tSec: 0,
};

interface Clock {
  activeMs: number;
  since: number | null;
}
const runClock = (c: Clock) => {
  c.since ??= performance.now();
};
const pauseClock = (c: Clock) => {
  if (c.since !== null) c.activeMs += performance.now() - c.since;
  c.since = null;
};

export function useFluxEngine(opts: FluxEngineOptions) {
  const [engine] = useState(createFluxEngine);
  const [status, setStatus] = useState<FluxStatus>('idle');
  const [error, setError] = useState<{ stage: ErrorStage; message: string } | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [delegate, setDelegate] = useState<Delegate | null>(null);
  const [fellBack, setFellBack] = useState(false);
  // On CPU because the last GPU boot took the page down (the crash mark) — said on the stage.
  const [cpuAfterCrash, setCpuAfterCrash] = useState(false);
  const [sample, setSample] = useState<Sample>(IDLE_SAMPLE);
  const [exState, setExState] = useState<ExerciseState | null>(null);
  const [calibrated, setCalibrated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastCue, setLastCue] = useState<string | null>(null);
  const [sessionSets, setSessionSets] = useState<readonly FluxSetDraft[]>([]);
  // The last session ended itself after its last set (D42) — the idle stage says so.
  const [sessionDone, setSessionDone] = useState(false);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const cueRef = useRef<CueState>(initialCueState);
  const lastDisplayRef = useRef(0);
  const latest = useRef({
    sample: IDLE_SAMPLE,
    calibrated: false,
    delegate: null as Delegate | null,
  });
  const setsRef = useRef(0);
  const readyRef = useRef(false); // the engine is ready — apart from whether the camera is live
  const pausedRef = useRef(false); // the camera is paused — apart from whether the engine is ready
  // Active session time: accumulated across pauses, so a backgrounded phone doesn't inflate the
  // Actual the Roll tie offers (it's what the estimate is calibrated against).
  const clock = useRef<Clock>({ activeMs: 0, since: null });
  const setStartRef = useRef(0);

  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cueTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The session's automatic steps (D41, D42): one timer, and what it will do.
  const autoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoStep = useRef<AutoStep | null>(null);
  const planDoneRef = useRef(0); // sets of this exercise done this session, toward opts.sets
  const startOnCalibrate = useRef(false); // "Start now" tapped before there was a neutral
  // Face-presence cues and the calibration hint, timed in worker seconds (sample.tSec).
  const face = useRef({
    seen: false,
    lostSince: null as number | null,
    lostSaid: false,
    backSince: null as number | null,
    hintSince: null as number | null,
  });

  const flash = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  // Reduce, speak, and mirror on the stage (a muted phone still shows it) — every phrase goes through
  // here. True if it was said (a gated cue can be dropped).
  const say = useCallback((cue: CueEvent): boolean => {
    const r = reduceCue(cueRef.current, cue, performance.now());
    cueRef.current = r.state;
    if (!r.utterance) return false;
    optsRef.current.voice.speak(r.utterance);
    if (!isMirrored(cue)) return true;
    setLastCue(r.utterance.text);
    clearTimeout(cueTimer.current);
    cueTimer.current = setTimeout(() => setLastCue(null), CUE_MS);
    return true;
  }, []);

  const clearAuto = useCallback(() => {
    clearTimeout(autoTimer.current);
    autoTimer.current = undefined;
    autoStep.current = null;
  }, []);

  // The rest is over (or Again cut it short) — assigned below, once `arm` exists.
  const nextSetRef = useRef<(index: number, now: boolean) => void>(() => {});

  // Run (or re-arm, after a pause) an automatic step: the lead-in before a timed set starts, or the rest
  // before the next set.
  const arm = useCallback(
    (step: AutoStep) => {
      clearAuto();
      autoStep.current = step;
      autoTimer.current = setTimeout(
        () => {
          autoStep.current = null;
          if (step.kind === 'start') engine.control({ type: 'start' });
          else nextSetRef.current(step.index, false);
        },
        step.kind === 'start' ? SET_LEAD_MS : SET_REST_MS,
      );
    },
    [engine, clearAuto],
  );

  // Flip a sided stretch, say the set, and start it from a clean slate (a Re-calibrate during the rest may
  // have reopened the finished set). Timed kinds get the lead-in unless a tap asked for now.
  nextSetRef.current = (index, now) => {
    clearAuto();
    const o = optsRef.current;
    o.onNextSet?.(index);
    say({ type: 'nextSet', number: index + 1, otherSide: o.side !== null });
    engine.control({ type: 'stop' });
    if (READY_KINDS.has(o.kind) && !now) arm({ kind: 'start' });
    else engine.control({ type: 'start' });
  };

  const resetFace = () => {
    face.current = {
      seen: false,
      lostSince: null,
      lostSaid: false,
      backSince: null,
      hintSince: null,
    };
  };

  useEffect(() => {
    const onEvent = (e: FluxEngineEvent) => {
      const o = optsRef.current;
      switch (e.type) {
        case 'progress':
          return setProgress({ loaded: e.loaded, total: e.total });
        case 'ready':
          readyRef.current = true;
          latest.current.delegate = e.delegate;
          setDelegate(e.delegate);
          if (e.fallback) setFellBack(true);
          setCpuAfterCrash(
            e.delegate === 'CPU' && !e.fallback && readGpuBootMark() && !readForcedCpu(),
          );
          setStartRef.current = performance.now();
          resetFace(); // a new worker restarts the sample clock
          // A fallback restarts the set (D26) — said, not only shown: a timed set is led in again, a
          // self-paced one says so. A pending lead-in or rest carries on as it was.
          if (e.fallback && latest.current.calibrated && o.acknowledged && !autoStep.current) {
            if (READY_KINDS.has(o.kind)) {
              say({ type: 'getReady' });
              arm({ kind: 'start' });
            } else say({ type: 'setRestarted' });
          }
          // A worker that comes up while the camera is paused (backgrounded mid-download, a fallback)
          // leaves the stage paused — Resume is still the way back.
          if (pausedRef.current) return;
          runClock(clock.current);
          return setStatus('running');
        case 'sample': {
          latest.current.sample = e.sample;
          if (readyRef.current && !pausedRef.current) watchFace(e.sample);
          const now = performance.now();
          if (now - lastDisplayRef.current < DISPLAY_MS) return;
          lastDisplayRef.current = now;
          return setSample(e.sample);
        }
        case 'calibrated':
          if (!e.ok) return flash('Face the camera to calibrate');
          latest.current.calibrated = true;
          setCalibrated(true);
          face.current.hintSince = null;
          // Spoken and mirrored as a cue (not a notice), so a "Get ready" right after it shows too; it
          // supersedes a "Face the camera" refusal still on screen.
          setNotice(null);
          say({ type: 'neutralSet' });
          // Calibrating resets the set, so a timed kind starts itself again (D41) — at once if
          // "Start now" was what asked for the neutral. A rest in progress runs on: its end starts the set.
          if (!READY_KINDS.has(o.kind) || !o.acknowledged) return;
          if (autoStep.current?.kind === 'rest') return;
          if (startOnCalibrate.current) {
            startOnCalibrate.current = false;
            clearAuto();
            return engine.control({ type: 'start' });
          }
          say({ type: 'getReady' });
          return arm({ kind: 'start' });
        case 'exerciseState':
          return setExState(e.state);
        case 'exerciseEvent': {
          const sets = Math.max(1, o.sets ?? DEFAULT_SETS);
          const last = e.event.type === 'setCompleted' && planDoneRef.current + 1 >= sets;
          // The last set says "Session complete." in place of "Set complete" (D42).
          say(last ? { type: 'sessionComplete' } : e.event);
          if (e.event.type !== 'setCompleted') return;
          const { summary } = e.event;
          const now = performance.now();
          const set: FluxSetDraft = {
            exerciseId: o.exerciseId,
            kind: o.kind,
            side: o.side,
            condition: o.condition,
            count: summary.count,
            ...(summary.avgPeakDeg !== undefined && { avgPeakDeg: summary.avgPeakDeg }),
            ...(summary.avgErrorDeg !== undefined && { avgErrorDeg: summary.avgErrorDeg }),
            rom: latest.current.sample.rom,
            calibrated: latest.current.calibrated,
            delegate: latest.current.delegate,
            durationSec: Math.round((now - setStartRef.current) / 1000),
            completedAt: Date.now(),
          };
          setStartRef.current = now;
          const index = setsRef.current++;
          setSessionSets((s) => [...s, set]);
          o.onSetCompleted?.(set, index);
          const done = ++planDoneRef.current;
          if (!last) return arm({ kind: 'rest', index: done });
          // Ends itself: the camera goes off with no tap, and the queued "Session complete." still plays.
          const session = endRef.current(false);
          setSessionDone(true);
          return o.onSessionEnd?.(session);
        }
        case 'paused': {
          pausedRef.current = true;
          pauseClock(clock.current);
          // Hold the pending step; Resume re-arms it from the start.
          const step = autoStep.current;
          clearAuto();
          autoStep.current = step;
          say({ type: 'cameraPaused' });
          return setStatus('paused');
        }
        case 'error':
          pauseClock(clock.current);
          readyRef.current = false;
          clearAuto();
          engine.stop();
          say({ type: 'trackingStopped' });
          setError({ stage: e.stage, message: e.message });
          return setStatus('error');
      }
    };
    // "Can't see you" after a second gone, "Tracking" once back; the calibration hint while uncalibrated.
    const watchFace = (smp: Sample) => {
      const f = face.current;
      if (!smp.faceVisible) {
        f.backSince = null;
        f.hintSince = null;
        if (!f.seen || f.lostSaid) return;
        f.lostSince ??= smp.tSec;
        if (smp.tSec - f.lostSince < FACE_LOST_SEC) return;
        // Latched only once said: inside its 5 s cooldown it's retried each frame until it is.
        f.lostSaid = say({ type: 'faceLost' });
        return;
      }
      f.seen = true;
      f.lostSince = null;
      if (f.lostSaid) {
        f.backSince ??= smp.tSec;
        if (smp.tSec - f.backSince >= FACE_BACK_SEC) {
          f.lostSaid = false;
          f.backSince = null;
          say({ type: 'faceFound' });
        }
      }
      if (latest.current.calibrated) return;
      f.hintSince ??= smp.tSec;
      // The reducer paces repeats to every 20 s.
      if (smp.tSec - f.hintSince >= HOLD_STILL_HINT_SEC) say({ type: 'holdStillHint' });
    };
    const off = engine.subscribe(onEvent);
    return () => {
      off();
      engine.stop();
      clearTimeout(noticeTimer.current);
      clearTimeout(cueTimer.current);
      clearAuto();
    };
  }, [engine, flash, say, arm, clearAuto]);

  // Feed the engine the exercise only once safety is acknowledged; a fresh selection starts a fresh
  // cue history (no cooldowns leaking between exercises).
  const selected = opts.acknowledged ? opts.exerciseId : null;
  const side = opts.side ?? 'a';
  useEffect(() => {
    cueRef.current = initialCueState;
    setStartRef.current = performance.now();
    setExState(null);
    engine.selectExercise(selected, side);
  }, [engine, selected, side]);
  // A different exercise starts its own run of sets; a side flip between sets (onNextSet) doesn't. One
  // acknowledged after the neutral is set (a contraindication) still starts itself if it's timed.
  useEffect(() => {
    clearAuto();
    planDoneRef.current = 0;
    startOnCalibrate.current = false;
    if (!selected || !latest.current.calibrated || !READY_KINDS.has(optsRef.current.kind)) return;
    say({ type: 'getReady' });
    arm({ kind: 'start' });
  }, [selected, clearAuto, say, arm]);

  const reset = useCallback(() => {
    setCalibrated(false);
    latest.current.calibrated = false;
    setExState(null);
    setSample(IDLE_SAMPLE);
    setProgress(null);
    setDelegate(null);
    setFellBack(false);
    setCpuAfterCrash(false);
    readyRef.current = false;
    pausedRef.current = false;
  }, []);

  const start = useCallback(
    async (els: StageElements) => {
      // The Start tap is a user gesture — unlock speech now (iOS).
      optsRef.current.voice.prime();
      cueRef.current = initialCueState;
      setError(null);
      reset();
      setSessionSets([]);
      setsRef.current = 0;
      setSessionDone(false);
      planDoneRef.current = 0;
      startOnCalibrate.current = false;
      clearAuto();
      resetFace();
      clock.current = { activeMs: 0, since: null };
      setStatus('loading');
      await engine.start(els);
    },
    [engine, reset, clearAuto],
  );

  // `cancelVoice` false only when the session ends itself, so its last words aren't cut off.
  function endSession(cancelVoice: boolean): SessionSummary {
    pauseClock(clock.current);
    const summary = { activeMs: clock.current.activeMs, sets: setsRef.current };
    clearAuto();
    startOnCalibrate.current = false;
    engine.stop();
    if (cancelVoice) optsRef.current.voice.cancel();
    reset();
    setStatus('idle');
    return summary;
  }
  const endRef = useRef(endSession);
  endRef.current = endSession;
  const stop = useCallback((): SessionSummary => endRef.current(true), []);

  const resume = useCallback(async () => {
    optsRef.current.voice.prime();
    pausedRef.current = false;
    if (readyRef.current) {
      runClock(clock.current);
      setStatus('running');
    } else setStatus('loading'); // the model is still coming; `ready` will take it to running
    resetFace();
    // Re-arm the held step once the camera is back, so a lead-in can't run out while it re-acquires.
    const step = autoStep.current;
    await engine.resume();
    if (step && !pausedRef.current && autoStep.current === step) arm(step);
  }, [engine, arm]);

  // Live active time, for the Roll strip while a session runs.
  const activeMs = useCallback(() => {
    const c = clock.current;
    return c.activeMs + (c.since === null ? 0 : performance.now() - c.since);
  }, []);

  const calibrate = useCallback(() => engine.calibrate(), [engine]);
  // A tap is the override: it cancels any pending lead-in or rest. "Start now" with no neutral yet asks
  // for one, and the set starts the moment it's set (now, or when auto-calibrate gets there).
  const control = useCallback(
    (c: EvalControl) => {
      // Again during the rest is the next set, now — with its side flip and cue.
      const step = autoStep.current;
      if (c.type === 'start' && step?.kind === 'rest') return nextSetRef.current(step.index, true);
      clearAuto();
      if (
        c.type === 'start' &&
        !latest.current.calibrated &&
        READY_KINDS.has(optsRef.current.kind)
      ) {
        startOnCalibrate.current = true;
        return engine.calibrate();
      }
      engine.control(c);
    },
    [engine, clearAuto],
  );
  const setForcedCpu = useCallback(
    (on: boolean) => {
      setFellBack(false);
      engine.setForcedCpu(on);
    },
    [engine],
  );
  const debug = useCallback((): EngineDebug => engine.debug(), [engine]);

  return {
    status,
    error,
    progress,
    delegate,
    fellBack,
    cpuAfterCrash,
    sample,
    exState,
    calibrated,
    notice,
    lastCue,
    sessionSets,
    sessionDone,
    activeMs,
    start,
    stop,
    resume,
    calibrate,
    control,
    setForcedCpu,
    debug,
  };
}

export type FluxEngineHandle = ReturnType<typeof useFluxEngine>;
