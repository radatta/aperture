// Main-thread shell around the hot-loop worker — the FluxEngine the app uses. Owns the webcam, the frame
// pump and the worker's lifecycle: grabs each video frame as an ImageBitmap and transfers it to the
// worker, draws the overlay from the points it sends back, and turns worker messages into engine events.
// All inference and exercise logic lives in the worker. Ported from flux-track's tracker.ts with:
// ack-based backpressure, pause/resume on background, real error mapping, the video-pause guard for
// speech (WebKit 218815), and delegate policy (GPU first, CPU on failure or by choice).

import type { EvalControl, Euler, ExerciseId } from '@aperture/shared/flux';
import { clearGpuBoot, markGpuBoot, preferredDelegate, writeForcedCpu } from '../prefs';
import type { EngineDebug, FluxEngine, FluxEngineEvent, StageElements } from './engine';
import type { Delegate, FromWorker, ToWorker } from './protocol';
import type { Side } from './side';

// requestVideoFrameCallback isn't in every lib.dom version; declare the surface we use (rAF fallback).
type RvfcVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

// A frame whose ack never comes (a wedged worker) must not stop the pump forever.
const ACK_WATCHDOG_MS = 2000;

export interface TrackerDeps {
  readonly getStream: () => Promise<MediaStream>;
  readonly createWorker: () => Worker;
  readonly grabFrame: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  readonly now: () => number;
}

export const defaultStream = () =>
  navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false,
  });

/** getUserMedia's DOMException names → what to do about it. */
export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Camera access is blocked. Allow the camera for this site in Safari’s settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No camera was found on this device.';
  if (name === 'NotReadableError' || name === 'AbortError')
    return 'The camera is busy — close any other app using it, then try again.';
  return err instanceof Error && err.message ? err.message : 'The camera could not start.';
}

export class FluxTracker implements FluxEngine {
  private readonly listeners = new Set<(e: FluxEngineEvent) => void>();
  private els: StageElements | null = null;
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private inflightSince: number | null = null;
  private delegate: Delegate | null = null;
  private pendingDelegate: Delegate = 'GPU';
  private fallback = false;
  private sawFrame = false;
  private neutral: Euler | null = null;
  private select: { id: ExerciseId | null; side: Side } | null = null;
  private dropped = 0;
  private detectFailures = 0;

  constructor(private readonly deps: TrackerDeps) {}

  async start(els: StageElements): Promise<void> {
    this.els = els;
    this.neutral = null;
    this.spawn(preferredDelegate());
    await this.acquire();
  }

  stop(): void {
    // A GPU session ended by the user didn't take the page down; a crashed one never gets here.
    if (this.pendingDelegate === 'GPU') clearGpuBoot();
    this.halt();
    this.post({ type: 'stop' });
    this.worker?.terminate();
    this.worker = null;
    this.delegate = null;
    this.neutral = null;
    this.release();
    this.unwatch();
  }

  async resume(): Promise<void> {
    if (!this.worker) return;
    await this.acquire();
  }

  calibrate(): void {
    this.post({ type: 'calibrate' });
  }

  selectExercise(id: ExerciseId | null, side: Side): void {
    this.select = { id, side };
    this.post({ type: 'selectExercise', id, side });
  }

  control(control: EvalControl): void {
    this.post({ type: 'control', control });
  }

  setForcedCpu(on: boolean): void {
    writeForcedCpu(on);
    if (!on) clearGpuBoot(); // asking for GPU again also forgives an earlier crashed boot
    if (!this.worker) return;
    this.fallback = false;
    this.respawn(on ? 'CPU' : 'GPU');
  }

  subscribe(listener: (e: FluxEngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  debug(): EngineDebug {
    const s = this.stream?.getVideoTracks()[0]?.getSettings();
    return {
      delegate: this.delegate,
      droppedFrames: this.dropped,
      detectFailures: this.detectFailures,
      trackSize: s?.width && s.height ? `${s.width}×${s.height}` : null,
    };
  }

  // ─── worker ──────────────────────────────────────────────────────────────────

  private spawn(delegate: Delegate): void {
    this.pendingDelegate = delegate;
    this.sawFrame = false;
    // A GPU boot that never reaches its first frame (the page died) leaves this set — next launch is CPU.
    if (delegate === 'GPU') markGpuBoot();
    const worker = this.deps.createWorker();
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (worker === this.worker) this.onMessage(e.data);
    };
    worker.onerror = (e) => {
      if (worker !== this.worker) return;
      e.preventDefault();
      this.onWorkerFailure('init', e.message || 'The tracking engine crashed.');
    };
    this.worker = worker;
    this.post({ type: 'init', delegate, neutral: this.neutral, select: this.select });
  }

  private respawn(delegate: Delegate): void {
    this.worker?.terminate();
    this.inflightSince = null;
    this.delegate = null;
    this.spawn(delegate);
  }

  private onWorkerFailure(stage: 'assets' | 'init' | 'detect', message: string): void {
    // GPU trouble is recoverable: replace the worker on CPU and say so. Anything else is an error.
    if (this.pendingDelegate === 'GPU' && stage !== 'assets') {
      if (stage === 'detect') this.detectFailures++;
      this.fallback = true;
      clearGpuBoot();
      this.respawn('CPU');
      return;
    }
    clearGpuBoot();
    this.emit({ type: 'error', stage, message });
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'frameDone':
        this.inflightSince = null;
        return;
      case 'progress':
        return this.emit(msg);
      case 'ready':
        this.delegate = msg.delegate;
        this.emit({
          type: 'ready',
          delegate: msg.delegate,
          ...(this.fallback && { fallback: true }),
        });
        this.fallback = false;
        if (this.stream) this.pump();
        return;
      case 'sample':
        if (!this.sawFrame) {
          this.sawFrame = true;
          if (this.delegate === 'GPU') clearGpuBoot(); // this GPU boot survived its first detect
        }
        this.draw(msg.landmarks, msg.sample.faceVisible);
        return this.emit({ type: 'sample', sample: msg.sample });
      case 'calibrated':
        if (msg.ok) this.neutral = msg.neutral;
        return this.emit({ type: 'calibrated', ok: msg.ok });
      case 'exerciseState':
      case 'exerciseEvent':
        return this.emit(msg);
      case 'error':
        if (msg.stage === 'camera') return this.emit(msg);
        return this.onWorkerFailure(msg.stage, msg.message);
    }
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  private emit(e: FluxEngineEvent): void {
    this.listeners.forEach((l) => l(e));
  }

  // ─── camera ──────────────────────────────────────────────────────────────────

  private async acquire(): Promise<void> {
    const video = this.els?.video;
    if (!video) return;
    let stream: MediaStream;
    try {
      stream = await this.deps.getStream();
    } catch (err) {
      this.emit({ type: 'error', stage: 'camera', message: cameraErrorMessage(err) });
      return;
    }
    if (!this.worker) {
      // stop() ran while the permission prompt was up — don't leave the camera on.
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    video.srcObject = stream;
    this.watch(stream);
    try {
      await video.play();
    } catch {
      // play() can reject on an interrupted load; the pause guard and the pump retry
    }
    if (this.delegate) this.pump();
  }

  private release(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.els) this.els.video.srcObject = null;
  }

  /** The camera went away under us: stop pumping, keep the worker and neutral, offer Resume. */
  private pauseFromOutside = (): void => {
    if (!this.stream) return;
    this.halt();
    this.release();
    this.emit({ type: 'paused' });
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.pauseFromOutside();
  };

  // WebKit 218815: speechSynthesis.speak() can pause a <video> playing a getUserMedia stream. Any pause
  // we didn't ask for while live is undone.
  private onVideoPause = (): void => {
    if (this.running && this.stream) void this.els?.video.play().catch(() => undefined);
  };

  private watch(stream: MediaStream): void {
    document.addEventListener('visibilitychange', this.onVisibility);
    this.els?.video.addEventListener('pause', this.onVideoPause);
    for (const t of stream.getVideoTracks()) t.addEventListener('ended', this.pauseFromOutside);
  }

  private unwatch(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.els?.video.removeEventListener('pause', this.onVideoPause);
  }

  // ─── frame pump ──────────────────────────────────────────────────────────────

  private pump(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  private halt(): void {
    this.running = false;
    this.inflightSince = null;
  }

  private schedule(): void {
    if (!this.running) return;
    const video = this.els?.video as RvfcVideo | undefined;
    if (typeof video?.requestVideoFrameCallback === 'function')
      video.requestVideoFrameCallback(() => void this.tick());
    else requestAnimationFrame(() => void this.tick());
  }

  private async tick(): Promise<void> {
    const video = this.els?.video;
    if (!this.running || !this.worker || !video) return;
    const now = this.deps.now();
    if (this.inflightSince !== null && now - this.inflightSince > ACK_WATCHDOG_MS)
      this.inflightSince = null;
    if (this.inflightSince !== null) this.dropped++;
    else if (video.readyState >= 2) {
      this.inflightSince = now;
      try {
        const bitmap = await this.deps.grabFrame(video);
        if (this.running && this.worker) this.post({ type: 'frame', bitmap, tMs: now }, [bitmap]);
        else bitmap.close();
      } catch {
        this.inflightSince = null; // transient grab failure — skip this frame
      }
    }
    this.schedule();
  }

  private draw(points: Float32Array, faceVisible: boolean): void {
    const canvas = this.els?.canvas;
    const video = this.els?.video;
    if (!canvas || !video) return;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const c = canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, w, h);
    if (!faceVisible || points.length === 0) return;
    c.fillStyle = getComputedStyle(canvas).getPropertyValue('--teal').trim() || 'teal';
    c.globalAlpha = 0.7;
    for (let i = 0; i + 1 < points.length; i += 2) {
      c.beginPath();
      c.arc((points[i] ?? 0) * w, (points[i + 1] ?? 0) * h, 1.1, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }
}
