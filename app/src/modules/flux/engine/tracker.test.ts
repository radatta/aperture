import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FluxEngineEvent } from './engine';
import type { FromWorker, ToWorker } from './protocol';
import { cameraErrorMessage, FluxTracker } from './tracker';

class FakeWorker {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: ToWorker[] = [];
  terminated = false;
  postMessage(msg: ToWorker) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(msg: FromWorker) {
    this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
  }
  frames = () => this.posted.filter((m) => m.type === 'frame').length;
}

function fakeStream() {
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    getSettings: () => ({ width: 640, height: 480 }),
  });
  return {
    track,
    stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream,
  };
}

const SAMPLE = {
  rel: { pitch: 0, yaw: 0, roll: 0 },
  rom: { pitch: 0, yaw: 0, roll: 0 },
  raw: { pitch: 0, yaw: 0, roll: 0 },
  faceVisible: true,
  fps: 30,
  tSec: 1,
};

let frameCb: (() => void) | null;
let video: HTMLVideoElement;
let workers: FakeWorker[];
let events: FluxEngineEvent[];
let getStream: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>;
let stream: ReturnType<typeof fakeStream>;
let trackers: FluxTracker[] = [];

function setup() {
  workers = [];
  events = [];
  frameCb = null;
  stream = fakeStream();
  getStream = vi.fn(async () => stream.stream);
  video = document.createElement('video');
  Object.defineProperty(video, 'readyState', { value: 4 });
  Object.assign(video, {
    requestVideoFrameCallback: (cb: () => void) => {
      frameCb = cb;
      return 1;
    },
    play: vi.fn(async () => {}),
  });
  const tracker = new FluxTracker({
    getStream,
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    },
    grabFrame: async () => ({ close: vi.fn() }) as unknown as ImageBitmap,
    now: () => performance.now(),
  });
  tracker.subscribe((e) => events.push(e));
  trackers.push(tracker);
  return tracker;
}

// Run the pending video-frame callback and let its async grab settle.
async function nextFrame() {
  const cb = frameCb;
  frameCb = null;
  cb?.();
  await Promise.resolve();
  await Promise.resolve();
}

const last = () => workers.at(-1) as FakeWorker;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

const startTracker = (t: FluxTracker) =>
  t.start({ video, canvas: document.createElement('canvas') });
const gpuMark = () => localStorage.getItem('aperture.flux.gpuBoot');

describe('FluxTracker', () => {
  let clearRect: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    localStorage.clear();
    // jsdom has no 2D context; a spy one lets release() clear the overlay without console noise.
    clearRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect,
    } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => {
    // Stop every tracker so no document listener or init timer outlives its test.
    for (const t of trackers) t.stop();
    trackers = [];
    // Drop the instance override setVisibility() leaves, back to jsdom's own getter.
    delete (document as { visibilityState?: unknown }).visibilityState;
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('starts a GPU worker with the remembered selection, then pumps once ready', async () => {
    const t = setup();
    t.selectExercise('chin-tuck', 'a');
    await t.start({ video, canvas: document.createElement('canvas') });
    expect(last().posted[0]).toEqual({
      type: 'init',
      delegate: 'GPU',
      neutral: null,
      select: { id: 'chin-tuck', side: 'a' },
    });
    expect(getStream).toHaveBeenCalledTimes(1);
    expect(frameCb).toBeNull(); // not before the model is ready
    last().reply({ type: 'ready', delegate: 'GPU' });
    expect(events).toContainEqual({ type: 'ready', delegate: 'GPU' });
    await nextFrame();
    expect(last().frames()).toBe(1);
  });

  it('sends no second frame until the worker acks the first (backpressure)', async () => {
    const t = setup();
    await t.start({ video, canvas: document.createElement('canvas') });
    last().reply({ type: 'ready', delegate: 'GPU' });
    await nextFrame();
    await nextFrame();
    await nextFrame();
    expect(last().frames()).toBe(1);
    expect(t.debug().droppedFrames).toBe(2);
    last().reply({ type: 'frameDone' });
    await nextFrame();
    expect(last().frames()).toBe(2);
  });

  it('maps a denied camera to a camera error with what to do', async () => {
    const t = setup();
    getStream.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await t.start({ video, canvas: document.createElement('canvas') });
    expect(events).toContainEqual({
      type: 'error',
      stage: 'camera',
      message: cameraErrorMessage(new DOMException('', 'NotAllowedError')),
    });
    expect(cameraErrorMessage(new DOMException('', 'NotAllowedError'))).toMatch(/blocked/);
    expect(cameraErrorMessage(new DOMException('', 'NotFoundError'))).toMatch(/No camera/);
    expect(cameraErrorMessage(new DOMException('', 'NotReadableError'))).toMatch(/busy/);
  });

  it('replaces a GPU worker that fails to init with a CPU one, keeping the selection', async () => {
    const t = setup();
    t.selectExercise('cervical-rotation', 'a');
    await t.start({ video, canvas: document.createElement('canvas') });
    const gpu = last();
    gpu.reply({ type: 'error', stage: 'init', message: 'webgl context lost' });
    expect(gpu.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(last().posted[0]).toMatchObject({ type: 'init', delegate: 'CPU' });
    last().reply({ type: 'ready', delegate: 'CPU' });
    expect(events).toContainEqual({ type: 'ready', delegate: 'CPU', fallback: true });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('carries the neutral into the CPU replacement after repeated detect failures', async () => {
    const t = setup();
    await t.start({ video, canvas: document.createElement('canvas') });
    last().reply({ type: 'ready', delegate: 'GPU' });
    const neutral = { pitch: 1, yaw: 2, roll: 3 };
    last().reply({ type: 'calibrated', ok: true, neutral });
    last().reply({ type: 'error', stage: 'detect', message: 'boom' });
    expect(last().posted[0]).toEqual({ type: 'init', delegate: 'CPU', neutral, select: null });
    expect(t.debug().fallbacks).toBe(1);
  });

  it('a CPU worker that fails is an error, not another fallback', async () => {
    const t = setup();
    t.setForcedCpu(true);
    await t.start({ video, canvas: document.createElement('canvas') });
    expect(last().posted[0]).toMatchObject({ delegate: 'CPU' });
    last().reply({ type: 'error', stage: 'init', message: 'no wasm' });
    expect(workers).toHaveLength(1);
    expect(events).toContainEqual({ type: 'error', stage: 'init', message: 'no wasm' });
  });

  it('asset failures are errors even on GPU (a CPU retry would download the same files)', async () => {
    const t = setup();
    await t.start({ video, canvas: document.createElement('canvas') });
    last().reply({ type: 'error', stage: 'assets', message: 'HTTP 404' });
    expect(workers).toHaveLength(1);
    expect(events).toContainEqual({ type: 'error', stage: 'assets', message: 'HTTP 404' });
  });

  it('marks a GPU boot only once the worker starts the GPU init, and clears it on the first sample', async () => {
    const t = setup();
    await startTracker(t);
    expect(gpuMark()).toBeNull(); // the download isn't the risky part
    last().reply({ type: 'initStarted', delegate: 'GPU' });
    expect(gpuMark()).toBe('1');
    last().reply({ type: 'ready', delegate: 'GPU' });
    expect(gpuMark()).toBe('1'); // ready isn't enough — the first detect can still crash
    last().reply({ type: 'sample', sample: SAMPLE, landmarks: new Float32Array(0) });
    expect(localStorage.getItem('aperture.flux.gpuBoot')).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'sample', sample: SAMPLE });
  });

  it('starts on CPU after a GPU boot that never finished', async () => {
    localStorage.setItem('aperture.flux.gpuBoot', '1');
    const t = setup();
    await t.start({ video, canvas: document.createElement('canvas') });
    expect(last().posted[0]).toMatchObject({ delegate: 'CPU' });
  });

  it('pauses when the page is hidden and resumes on a fresh stream', async () => {
    const t = setup();
    await t.start({ video, canvas: document.createElement('canvas') });
    last().reply({ type: 'ready', delegate: 'GPU' });
    setVisibility('hidden');
    expect(events.at(-1)).toEqual({ type: 'paused' });
    expect(stream.track.stop).toHaveBeenCalled();
    setVisibility('visible');
    await t.resume();
    expect(getStream).toHaveBeenCalledTimes(2);
    expect(workers).toHaveLength(1); // same worker, same neutral
    t.stop();
  });

  it('pauses when the camera track ends', async () => {
    const t = setup();
    await t.start({ video, canvas: document.createElement('canvas') });
    stream.track.dispatchEvent(new Event('ended'));
    expect(events.at(-1)).toEqual({ type: 'paused' });
    t.stop();
  });

  it('undoes a pause it did not ask for while live (speech pausing the video)', async () => {
    const t = setup();
    await t.start({ video, canvas: document.createElement('canvas') });
    last().reply({ type: 'ready', delegate: 'GPU' });
    vi.mocked(video.play).mockClear();
    video.dispatchEvent(new Event('pause'));
    expect(video.play).toHaveBeenCalledTimes(1);
    t.stop();
  });

  it('stop terminates the worker, releases the camera and clears the GPU mark', async () => {
    const t = setup();
    await t.start({ video, canvas: document.createElement('canvas') });
    const w = last();
    t.stop();
    expect(w.posted.at(-1)).toEqual({ type: 'stop' });
    expect(w.terminated).toBe(true);
    expect(stream.track.stop).toHaveBeenCalled();
    expect(localStorage.getItem('aperture.flux.gpuBoot')).toBeNull();
    expect(t.debug().delegate).toBeNull();
    expect(clearRect).toHaveBeenCalled(); // no stale landmarks left on the stage
  });

  it('releases a camera granted after stop()', async () => {
    const t = setup();
    let grant: (s: MediaStream) => void = () => {};
    getStream.mockReturnValueOnce(new Promise((r) => (grant = r)));
    const started = t.start({ video, canvas: document.createElement('canvas') });
    t.stop();
    grant(stream.stream);
    await started;
    expect(stream.track.stop).toHaveBeenCalled();
  });
  it('never marks a CPU init', async () => {
    const t = setup();
    t.setForcedCpu(true);
    await startTracker(t);
    last().reply({ type: 'initStarted', delegate: 'CPU' });
    expect(gpuMark()).toBeNull();
  });

  it('clears the GPU mark when the page is hidden mid-boot (an evicted PWA is not a crash)', async () => {
    const t = setup();
    await startTracker(t);
    last().reply({ type: 'initStarted', delegate: 'GPU' });
    setVisibility('hidden');
    expect(gpuMark()).toBeNull();
  });

  it('clears the GPU mark when the GPU init fails over to CPU', async () => {
    const t = setup();
    await startTracker(t);
    last().reply({ type: 'initStarted', delegate: 'GPU' });
    last().reply({ type: 'error', stage: 'init', message: 'webgl' });
    expect(gpuMark()).toBeNull();
    expect(last().posted[0]).toMatchObject({ delegate: 'CPU' });
  });

  it('a worker that becomes ready while paused does not pump until Resume', async () => {
    const t = setup();
    await startTracker(t);
    setVisibility('hidden');
    last().reply({ type: 'ready', delegate: 'GPU' });
    expect(frameCb).toBeNull();
    setVisibility('visible');
    await t.resume();
    await nextFrame();
    expect(last().frames()).toBe(1);
  });

  it('a Stop → Start during the first camera prompt still gets a camera', async () => {
    const t = setup();
    const first = fakeStream();
    let grantFirst: (s: MediaStream) => void = () => {};
    getStream.mockReturnValueOnce(new Promise((r) => (grantFirst = r)));
    const started = startTracker(t);
    t.stop();
    await startTracker(t); // the second request, answered at once with `stream`
    expect(getStream).toHaveBeenCalledTimes(2);
    grantFirst(first.stream);
    await started;
    expect(first.track.stop).toHaveBeenCalled(); // the stale grant is released…
    expect(stream.track.stop).not.toHaveBeenCalled(); // …the live one is kept
    expect(video.srcObject).toBe(stream.stream);
    last().reply({ type: 'ready', delegate: 'GPU' });
    await nextFrame();
    expect(last().frames()).toBe(1);
  });

  it('a stale camera error from a stopped session is not reported', async () => {
    const t = setup();
    let denyFirst: (e: unknown) => void = () => {};
    getStream.mockReturnValueOnce(new Promise((_, reject) => (denyFirst = reject)));
    const started = startTracker(t);
    t.stop();
    await startTracker(t);
    denyFirst(new DOMException('denied', 'NotAllowedError'));
    await started;
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('an init that stalls falls back to CPU, and a stalled CPU init is an error', async () => {
    vi.useFakeTimers();
    const t = setup();
    await startTracker(t);
    vi.advanceTimersByTime(29_000);
    last().reply({ type: 'progress', loaded: 1, total: 2 }); // progress re-arms the timer
    vi.advanceTimersByTime(29_000);
    expect(workers).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(workers).toHaveLength(2);
    expect(last().posted[0]).toMatchObject({ type: 'init', delegate: 'CPU' });
    vi.advanceTimersByTime(30_000);
    expect(events).toContainEqual({
      type: 'error',
      stage: 'init',
      message: 'The tracking engine took too long to start.',
    });
  });

  it('a ready worker cancels the stall timer', async () => {
    vi.useFakeTimers();
    const t = setup();
    await startTracker(t);
    last().reply({ type: 'ready', delegate: 'GPU' });
    vi.advanceTimersByTime(60_000);
    expect(workers).toHaveLength(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('a new start resets the fallback count and dropped frames', async () => {
    const t = setup();
    await startTracker(t);
    last().reply({ type: 'error', stage: 'init', message: 'webgl' });
    expect(t.debug().fallbacks).toBe(1);
    t.stop();
    await startTracker(t);
    expect(t.debug()).toMatchObject({ fallbacks: 0, droppedFrames: 0 });
    expect(last().posted[0]).toMatchObject({ delegate: 'GPU' });
  });
});
