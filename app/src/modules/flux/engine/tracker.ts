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
// A worker that goes this long with neither download progress nor `ready` is treated as a failed
// init (a GPU init that hangs instead of throwing): GPU falls back to CPU, CPU is an error.
const INIT_STALL_MS = 30_000;

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

// getUserMedia's DOMException names → what to do about it.
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
  // Bumped by start, stop and an outside pause: an await that resumes under a newer session drops
  // its result (a camera granted after Stop, or a Stop → Start while the first prompt was up).
  private session = 0;
  // The session whose camera request is in flight — per session, so a Stop → Start during the first
  // prompt still asks again rather than waiting on a request whose result will be dropped.
  private acquiring: number | null = null;
  // Each frame loop carries its id; halting bumps it, so a frame callback left over from the previous
  // loop exits instead of running a second loop alongside the new one.
  private loop = 0;
  private running = false;
  private inflightSince: number | null = null;
  private delegate: Delegate | null = null;
  private pendingDelegate: Delegate = 'GPU';
  private fallback = false;
  private gpuBootPending = false;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private neutral: Euler | null = null;
  private select: { id: ExerciseId | null; side: Side } | null = null;
  private dropped = 0;
  private fallbacks = 0;
  private dotColor = 'teal';

  constructor(private readonly deps: TrackerDeps) {}

  async start(els: StageElements): Promise<void> {
    this.session++;
    this.els = els;
    this.neutral = null;
    this.fallback = false;
    this.dropped = 0;
    this.fallbacks = 0;
    this.dotColor = getComputedStyle(els.canvas).getPropertyValue('--teal').trim() || 'teal';
    this.spawn(preferredDelegate());
    await this.acquire();
  }

  stop(): void {
    this.session++;
    // A GPU boot ended by the user didn't take the page down.
    if (this.gpuBootPending) this.endGpuBoot();
    clearTimeout(this.initTimer);
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
    if (!on) clearGpuBoot(); // asking for the GPU again also forgives an earlier crashed boot
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
      fallbacks: this.fallbacks,
      trackSize: s?.width && s.height ? `${s.width}×${s.height}` : null,
    };
  }

  // ─── worker ──────────────────────────────────────────────────────────────────

  private spawn(delegate: Delegate): void {
    this.pendingDelegate = delegate;
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
    this.armInitTimer();
    this.post({ type: 'init', delegate, neutral: this.neutral, select: this.select });
  }

  private respawn(delegate: Delegate): void {
    this.worker?.terminate();
    this.inflightSince = null;
    this.delegate = null;
    this.spawn(delegate);
  }

  private armInitTimer(): void {
    clearTimeout(this.initTimer);
    this.initTimer = setTimeout(
      () => this.onWorkerFailure('init', 'The tracking engine took too long to start.'),
      INIT_STALL_MS,
    );
  }

  // The crash mark covers only the GPU init and its first detect — the window where a broken GPU path
  // takes the page down. Set when the worker reports it's starting the GPU, cleared once a frame
  // came back, on any failure, on Stop, or when the page is hidden mid-boot (iOS evicting a backgrounded
  // PWA is not a GPU crash). Still set at the next start means it was: that start is on CPU, and the
  // stage says so (useFluxEngine).
  private beginGpuBoot(): void {
    this.gpuBootPending = true;
    markGpuBoot();
  }
  private endGpuBoot(): void {
    this.gpuBootPending = false;
    clearGpuBoot();
  }

  private onWorkerFailure(stage: 'assets' | 'init' | 'detect', message: string): void {
    clearTimeout(this.initTimer);
    if (this.gpuBootPending) this.endGpuBoot();
    // GPU trouble is recoverable: replace the worker on CPU and say so. Anything else is an error.
    if (this.pendingDelegate === 'GPU' && stage !== 'assets') {
      this.fallbacks++;
      this.fallback = true;
      this.respawn('CPU');
      return;
    }
    this.emit({ type: 'error', stage, message });
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'frameDone':
        this.inflightSince = null;
        return;
      case 'progress':
        this.armInitTimer();
        return this.emit(msg);
      case 'initStarted':
        this.armInitTimer();
        if (msg.delegate === 'GPU') this.beginGpuBoot();
        return;
      case 'ready':
        clearTimeout(this.initTimer);
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
        if (this.gpuBootPending) this.endGpuBoot(); // this GPU boot survived its first detect
        this.draw(msg.landmarks, msg.sample.faceVisible);
        return this.emit({ type: 'sample', sample: msg.sample });
      case 'calibrated':
        if (msg.ok) this.neutral = msg.neutral;
        return this.emit({ type: 'calibrated', ok: msg.ok, ...(msg.auto && { auto: true }) });
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
    if (!video || this.acquiring === this.session || this.stream) return;
    const session = this.session;
    this.acquiring = session;
    let stream: MediaStream;
    try {
      stream = await this.deps.getStream();
    } catch (err) {
      if (session === this.session)
        this.emit({ type: 'error', stage: 'camera', message: cameraErrorMessage(err) });
      return;
    } finally {
      if (this.acquiring === session) this.acquiring = null;
    }
    if (session !== this.session || !this.worker) {
      // Stopped (or restarted) while the permission prompt was up — don't leave this camera on.
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
    if (session === this.session && this.delegate) this.pump();
  }

  private release(): void {
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (!this.els) return;
    this.els.video.srcObject = null;
    const { canvas } = this.els;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); // no stale landmarks
  }

  // The camera went away under us: stop pumping, keep the worker and neutral, offer Resume.
  private pauseFromOutside = (): void => {
    if (!this.stream) return;
    this.session++;
    this.halt();
    this.release();
    this.emit({ type: 'paused' });
  };

  private onVisibility = (): void => {
    if (document.visibilityState !== 'hidden') return;
    if (this.gpuBootPending) this.endGpuBoot();
    this.pauseFromOutside();
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
    this.schedule(++this.loop);
  }

  private halt(): void {
    this.running = false;
    this.loop++;
    this.inflightSince = null;
  }

  private schedule(loop: number): void {
    if (!this.running || loop !== this.loop) return;
    const video = this.els?.video as RvfcVideo | undefined;
    if (typeof video?.requestVideoFrameCallback === 'function')
      video.requestVideoFrameCallback(() => void this.tick(loop));
    else requestAnimationFrame(() => void this.tick(loop));
  }

  private async tick(loop: number): Promise<void> {
    const video = this.els?.video;
    if (!this.running || loop !== this.loop || !this.worker || !video) return;
    const now = this.deps.now();
    if (this.inflightSince !== null && now - this.inflightSince > ACK_WATCHDOG_MS)
      this.inflightSince = null;
    if (this.inflightSince !== null) this.dropped++;
    else if (video.readyState >= 2) {
      this.inflightSince = now;
      try {
        const bitmap = await this.deps.grabFrame(video);
        if (this.running && loop === this.loop && this.worker)
          this.post({ type: 'frame', bitmap, tMs: now }, [bitmap]);
        else bitmap.close();
      } catch {
        this.inflightSince = null; // transient grab failure — skip this frame
      }
    }
    this.schedule(loop);
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
    c.fillStyle = this.dotColor;
    c.globalAlpha = 0.7;
    for (let i = 0; i + 1 < points.length; i += 2) {
      c.beginPath();
      c.arc((points[i] ?? 0) * w, (points[i + 1] ?? 0) * h, 1.1, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  }
}
