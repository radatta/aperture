import { useCallback, useEffect, useRef, useState } from 'react';
import type {
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
import type { VoiceControl } from './useVoice';
import { initialCueState, reduceCue, type CueState } from './voice/cues';

// The Flux stage's state machine over a FluxEngine — what flux-track's route held in a dozen useStates,
// with a live error and a paused state it never had. Only derived numbers reach React: samples are
// throttled to ~16 Hz for display, exercise state arrives at ~15 Hz from the engine.

export type FluxStatus = 'idle' | 'loading' | 'running' | 'paused' | 'error';

/** One finished set, as the session holds it. Flux history (the next PR) persists exactly this. */
export interface FluxSetDraft {
  readonly exerciseId: ExerciseId;
  readonly kind: ExerciseKind;
  readonly side: Side | null;
  readonly count: number;
  readonly avgPeakDeg?: number;
  readonly avgErrorDeg?: number;
  readonly rom: Euler;
  readonly calibrated: boolean;
  readonly delegate: Delegate | null;
  readonly completedAt: number; // epoch ms
}

export interface FluxEngineOptions {
  readonly exerciseId: ExerciseId;
  readonly kind: ExerciseKind;
  /** null for exercises without a side. */
  readonly side: Side | null;
  /** The contraindication gate: until acknowledged the engine runs with no exercise selected. */
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

export function useFluxEngine(opts: FluxEngineOptions) {
  const [engine] = useState(createFluxEngine);
  const [status, setStatus] = useState<FluxStatus>('idle');
  const [error, setError] = useState<{ stage: ErrorStage; message: string } | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [delegate, setDelegate] = useState<Delegate | null>(null);
  const [fellBack, setFellBack] = useState(false);
  const [sample, setSample] = useState<Sample>(IDLE_SAMPLE);
  const [exState, setExState] = useState<ExerciseState | null>(null);
  const [calibrated, setCalibrated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastCue, setLastCue] = useState<string | null>(null);
  const [sessionSets, setSessionSets] = useState<readonly FluxSetDraft[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);

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
          latest.current.delegate = e.delegate;
          setDelegate(e.delegate);
          if (e.fallback) setFellBack(true);
          setStartedAt((t) => t ?? Date.now());
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
            // Mirrored on the HUD, so a muted phone (silent switch, ducking) still shows the cue.
            setLastCue(r.utterance.text);
            clearTimeout(cueTimer.current);
            cueTimer.current = setTimeout(() => setLastCue(null), CUE_MS);
          }
          if (e.event.type !== 'setCompleted') return;
          const { summary } = e.event;
          const set: FluxSetDraft = {
            exerciseId: o.exerciseId,
            kind: o.kind,
            side: o.side,
            count: summary.count,
            ...(summary.avgPeakDeg !== undefined && { avgPeakDeg: summary.avgPeakDeg }),
            ...(summary.avgErrorDeg !== undefined && { avgErrorDeg: summary.avgErrorDeg }),
            rom: latest.current.sample.rom,
            calibrated: latest.current.calibrated,
            delegate: latest.current.delegate,
            completedAt: Date.now(),
          };
          const index = setsRef.current++;
          setSessionSets((s) => [...s, set]);
          o.onSetCompleted?.(set, index);
          return;
        }
        case 'paused':
          return setStatus('paused');
        case 'error':
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
  }, []);

  const start = useCallback(
    async (els: StageElements) => {
      // The Start tap is a user gesture — unlock speech now (iOS).
      optsRef.current.voice.prime();
      cueRef.current = initialCueState;
      setError(null);
      reset();
      setStatus('loading');
      await engine.start(els);
    },
    [engine, reset],
  );

  const stop = useCallback(() => {
    engine.stop();
    optsRef.current.voice.cancel();
    reset();
    setStatus('idle');
  }, [engine, reset]);

  const resume = useCallback(async () => {
    optsRef.current.voice.prime();
    setStatus('running');
    await engine.resume();
  }, [engine]);

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
    sample,
    exState,
    calibrated,
    notice,
    lastCue,
    sessionSets,
    startedAt,
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
