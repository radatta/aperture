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
import { initialCueState, reduceCue, type CueState } from './voice/cues';

// The Flux stage's state machine over a FluxEngine — what flux-track's route held in a dozen useStates,
// with a live error and a paused state it never had. Only derived numbers reach React: samples are
// throttled to ~16 Hz for display, exercise state arrives at ~15 Hz from the engine.

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
  readonly onSetCompleted?: (set: FluxSetDraft, index: number) => void;
}

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

  const flash = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

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
          // A worker that comes up while the camera is paused (backgrounded mid-download, a fallback)
          // leaves the stage paused — Resume is still the way back.
          if (pausedRef.current) return;
          runClock(clock.current);
          return setStatus('running');
        case 'sample': {
          latest.current.sample = e.sample;
          const now = performance.now();
          if (now - lastDisplayRef.current < DISPLAY_MS) return;
          lastDisplayRef.current = now;
          return setSample(e.sample);
        }
        case 'calibrated':
          if (!e.ok) return flash('Face the camera to calibrate');
          latest.current.calibrated = true;
          setCalibrated(true);
          return flash('Neutral set');
        case 'exerciseState':
          return setExState(e.state);
        case 'exerciseEvent': {
          const r = reduceCue(cueRef.current, e.event, performance.now());
          cueRef.current = r.state;
          if (r.utterance) {
            o.voice.speak(r.utterance);
            // Mirrored on the HUD, so a muted phone (silent switch, ducking) still shows the cue —
            // except counts (repCompleted, holdReached): the readout's number (or, at the hold, its
            // ring turning gold) already says it.
            if (e.event.type !== 'repCompleted' && e.event.type !== 'holdReached') {
              setLastCue(r.utterance.text);
              clearTimeout(cueTimer.current);
              cueTimer.current = setTimeout(() => setLastCue(null), CUE_MS);
            }
          }
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
          return;
        }
        case 'paused':
          pausedRef.current = true;
          pauseClock(clock.current);
          return setStatus('paused');
        case 'error':
          pauseClock(clock.current);
          readyRef.current = false;
          engine.stop();
          setError({ stage: e.stage, message: e.message });
          return setStatus('error');
      }
    };
    const off = engine.subscribe(onEvent);
    return () => {
      off();
      engine.stop();
      clearTimeout(noticeTimer.current);
      clearTimeout(cueTimer.current);
    };
  }, [engine, flash]);

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
      clock.current = { activeMs: 0, since: null };
      setStatus('loading');
      await engine.start(els);
    },
    [engine, reset],
  );

  const stop = useCallback((): SessionSummary => {
    pauseClock(clock.current);
    const summary = { activeMs: clock.current.activeMs, sets: setsRef.current };
    engine.stop();
    optsRef.current.voice.cancel();
    reset();
    setStatus('idle');
    return summary;
  }, [engine, reset]);

  const resume = useCallback(async () => {
    optsRef.current.voice.prime();
    pausedRef.current = false;
    if (readyRef.current) {
      runClock(clock.current);
      setStatus('running');
    } else setStatus('loading'); // the model is still coming; `ready` will take it to running
    await engine.resume();
  }, [engine]);

  // Live active time, for the Roll strip while a session runs.
  const activeMs = useCallback(() => {
    const c = clock.current;
    return c.activeMs + (c.since === null ? 0 : performance.now() - c.since);
  }, []);

  const calibrate = useCallback(() => engine.calibrate(), [engine]);
  const control = useCallback((c: EvalControl) => engine.control(c), [engine]);
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
