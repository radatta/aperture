import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import type { ExerciseDefinition } from '@aperture/shared/flux';
import { Button } from '../../components/Button';
import { VolumeIcon, VolumeOffIcon } from '../../components/icons';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { StageReadout } from './StageReadout';
import type { FluxEngineHandle } from './useFluxEngine';
import type { VoiceControl } from './useVoice';

// The camera box: mirrored video + landmark overlay, an overlay per non-running state, and the HUD
// (tracking badge, delegate glyph, voice toggle, live count + hold ring, Calibrate / Stop) inside the
// box — nothing fixed to the viewport (CONVENTIONS: one dock). The video is never display:none while live; WebKit pauses
// hidden camera video.

const MB = (n: number) => (n / 1_000_000).toFixed(1);

const ERROR_LEAD: Record<string, string> = {
  assets: 'Couldn’t download the tracking model. Check your connection and try again.',
  init: 'The tracking engine couldn’t start on this device.',
  detect: 'Tracking stopped working.',
};

export function CameraStage({
  def,
  engine,
  voice,
  videoRef,
  canvasRef,
  onStart,
  onStop,
  startAccessory,
}: {
  def: ExerciseDefinition; // as shown (mirrored for side B), same as the panel's
  engine: FluxEngineHandle;
  voice: VoiceControl;
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onStart: () => void;
  onStop: () => void;
  startAccessory?: ReactNode; // beside Start camera — the sets stepper
}) {
  const { status, sample, calibrated, delegate, progress, error } = engine;
  const aspect = useTrackAspect(videoRef);
  const running = status === 'running';

  return (
    <div
      // Capped from sm up so the panel starts on screen (a 4:3 stage is ~576px tall on a Mac), never
      // under 20rem so a landscape phone still fits the live readout. The box keeps full width and
      // shortens; video and canvas share object-cover, so they crop alike.
      className="relative overflow-hidden rounded-2xl border border-line bg-black sm:max-h-[max(50dvh,20rem)]"
      style={{ aspectRatio: aspect }}
    >
      <video
        ref={videoRef}
        playsInline
        muted
        className="absolute inset-0 h-full w-full -scale-x-100 object-cover"
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100 object-cover"
      />

      {!running && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface/80 p-6 text-center">
          {status === 'error' && error ? (
            <>
              <div role="alert" className="flex max-w-xs flex-col gap-1">
                {ERROR_LEAD[error.stage] && (
                  <Text as="p" size="sm" tone="danger">
                    {ERROR_LEAD[error.stage]}
                  </Text>
                )}
                <Text
                  as="p"
                  size={ERROR_LEAD[error.stage] ? 'xs' : 'sm'}
                  tone={ERROR_LEAD[error.stage] ? 'muted' : 'danger'}
                >
                  {error.message}
                </Text>
              </div>
              <Button onClick={onStart}>Try again</Button>
            </>
          ) : status === 'paused' ? (
            <>
              <Text as="p" size="sm" className="max-w-xs">
                Camera paused. Your neutral is kept — resume to carry on.
              </Text>
              <div className="flex gap-2">
                <Button onClick={() => void engine.resume()}>Resume</Button>
                <Button variant="ghost" onClick={onStop}>
                  Stop
                </Button>
              </div>
            </>
          ) : (
            <>
              <Text as="p" size="sm" className="max-w-xs">
                Sit facing the camera at arm&apos;s length. Nothing leaves your device — all
                tracking runs locally.
              </Text>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {status === 'idle' && startAccessory}
                <Button onClick={onStart} disabled={status === 'loading'}>
                  {status === 'loading' ? 'Loading model…' : 'Start camera'}
                </Button>
              </div>
              {status === 'loading' &&
                progress &&
                progress.total > 0 &&
                progress.loaded < progress.total && (
                  <Text as="p" size="xs" tone="muted" tabular aria-live="polite">
                    Downloading model… {MB(progress.loaded)} / {MB(progress.total)} MB
                  </Text>
                )}
            </>
          )}
        </div>
      )}

      {running && (
        <>
          <div className="absolute top-3 left-3 flex items-center gap-2 rounded-full bg-surface/85 px-3 py-1 text-xs text-ink">
            <span
              className={cx('h-2 w-2 rounded-full', sample.faceVisible ? 'bg-teal' : 'bg-gold')}
            />
            {sample.faceVisible ? 'Tracking' : 'No face'} · {sample.fps} fps
            {delegate && (
              <button
                type="button"
                onClick={() => engine.setForcedCpu(delegate === 'GPU')}
                aria-label={
                  delegate === 'GPU'
                    ? 'Running on the GPU — switch to CPU'
                    : 'Running on the CPU — try the GPU'
                }
                title={delegate === 'GPU' ? 'Switch to CPU' : 'Try the GPU'}
                className="rounded-md border border-line px-1.5 font-mono text-[10px] text-ink"
              >
                {delegate}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={voice.toggle}
            aria-label={voice.on ? 'Mute voice cues' : 'Enable voice cues'}
            title={voice.on ? 'Mute voice cues' : 'Enable voice cues'}
            className="absolute top-3 right-3 rounded-full bg-surface/85 p-2 text-ink transition hover:bg-panel-2"
          >
            {voice.on ? <VolumeIcon /> : <VolumeOffIcon className="text-ink-muted" />}
          </button>
          <StageReadout def={def} state={engine.exState} />
          {(engine.notice || engine.lastCue) && (
            // Left of the live readout's column (right-24), so a long cue never covers the ring.
            <div
              aria-live="polite"
              className="absolute right-24 bottom-16 left-3 flex justify-center"
            >
              <span className="rounded-full bg-surface/90 px-3 py-1 text-sm font-medium text-ink">
                {engine.notice ?? engine.lastCue}
              </span>
            </div>
          )}
          <div className="absolute right-3 bottom-3 left-3 flex gap-2">
            <button
              type="button"
              onClick={engine.calibrate}
              className="flex-1 rounded-lg bg-surface/90 px-3 py-2 text-xs font-medium text-ink transition hover:bg-panel-2"
            >
              {calibrated ? 'Re-calibrate' : 'Calibrate neutral'}
            </button>
            <button
              type="button"
              onClick={onStop}
              className="rounded-lg bg-surface/90 px-3 py-2 text-xs font-medium text-ink transition hover:bg-panel-2"
            >
              Stop
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// The live track's aspect once known (iOS portrait gives 3:4 or rotated frames), 4:3 until then.
function useTrackAspect(videoRef: RefObject<HTMLVideoElement | null>): string {
  const [aspect, setAspect] = useState('4 / 3');
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const update = () => {
      if (v.videoWidth && v.videoHeight) setAspect(`${v.videoWidth} / ${v.videoHeight}`);
    };
    v.addEventListener('loadedmetadata', update);
    v.addEventListener('resize', update);
    return () => {
      v.removeEventListener('loadedmetadata', update);
      v.removeEventListener('resize', update);
    };
  }, [videoRef]);
  return aspect;
}
