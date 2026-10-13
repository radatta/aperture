// The hot loop, in a module Web Worker: MediaPipe inference + FluxCore. Receives camera frames as
// transferred ImageBitmaps and posts back samples, decimated overlay points, and exercise state/events.
// Never imported statically — tracker.ts spawns it via `?worker`. One landmarker per worker for its
// whole life (see the `init` note in protocol.ts); the main thread replaces the worker to change
// delegate.

import { FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { loadFluxAssets } from './assets';
import { FluxCore } from './core';
import type { Delegate, ErrorStage, FromWorker, ToWorker } from './protocol';

// Consecutive detectForVideo throws before this worker gives up and asks for a CPU replacement.
// GPU output can also go wrong without throwing on WebKit (mediapipe issue 6142) — the Details readout
// and the tap-to-force-CPU glyph cover that case.
const MAX_DETECT_FAILURES = 5;

// `self` typed via the DOM `Worker` shape to avoid webworker/DOM lib conflicts.
const ctx = self as unknown as Worker;
const post = (msg: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);
const fail = (stage: ErrorStage, err: unknown) =>
  post({ type: 'error', stage, message: err instanceof Error ? err.message : String(err) });

const core = new FluxCore();
let landmarker: FaceLandmarker | null = null;
let failures = 0;
let failed = false;

async function init(delegate: Delegate): Promise<void> {
  let assets;
  try {
    assets = await loadFluxAssets((loaded, total) => post({ type: 'progress', loaded, total }));
  } catch (err) {
    return fail('assets', err);
  }
  post({ type: 'initStarted', delegate });
  try {
    landmarker = await FaceLandmarker.createFromOptions(assets.fileset, {
      baseOptions: { modelAssetBuffer: assets.modelBytes, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
    });
  } catch (err) {
    return fail('init', err);
  } finally {
    // The wasm is compiled by now (or never will be); drop the 13 MB blob it was read from.
    URL.revokeObjectURL(assets.fileset.wasmBinaryPath);
  }
  post({ type: 'ready', delegate });
}

// Decimate landmarks to a transferable [x,y,…] array for the overlay.
function overlayPoints(res: FaceLandmarkerResult): Float32Array {
  const lm = res.faceLandmarks[0];
  if (!lm) return new Float32Array(0);
  const out = new Float32Array(Math.ceil(lm.length / 2) * 2);
  let j = 0;
  for (let i = 0; i < lm.length; i += 2) {
    out[j++] = lm[i]?.x ?? 0;
    out[j++] = lm[i]?.y ?? 0;
  }
  return out.subarray(0, j);
}

function processFrame(bitmap: ImageBitmap, tMs: number): void {
  if (!landmarker || failed) return bitmap.close();
  let res: FaceLandmarkerResult;
  try {
    res = landmarker.detectForVideo(bitmap, tMs);
    failures = 0;
  } catch (err) {
    bitmap.close();
    // A single throw is a transient decode hiccup (flux skipped it). A run of them means the delegate
    // is broken — stop and let the main thread replace this worker on CPU.
    if (++failures >= MAX_DETECT_FAILURES) {
      failed = true;
      fail('detect', err);
    }
    return;
  }
  bitmap.close();

  const r = core.frame(res.facialTransformationMatrixes?.[0]?.data ?? null, tMs);
  if (!r) return; // non-increasing timestamp
  const points = overlayPoints(res);
  post({ type: 'sample', sample: r.sample, landmarks: points }, [points.buffer]);
  if (r.autoCalibrated)
    post({ type: 'calibrated', ok: true, neutral: r.autoCalibrated, auto: true });
  for (const event of r.events) post({ type: 'exerciseEvent', event });
  if (r.state) post({ type: 'exerciseState', state: r.state });
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      core.restoreNeutral(msg.neutral);
      if (msg.select) core.selectExercise(msg.select.id, msg.select.side);
      void init(msg.delegate);
      break;
    case 'frame':
      processFrame(msg.bitmap, msg.tMs);
      post({ type: 'frameDone' }); // every path — the main thread grabs the next frame only after this
      break;
    case 'calibrate': {
      const ok = core.calibrate();
      post({ type: 'calibrated', ok, neutral: core.neutralPose });
      break;
    }
    case 'selectExercise': {
      const state = core.selectExercise(msg.id, msg.side);
      if (state) post({ type: 'exerciseState', state });
      break;
    }
    case 'control': {
      const r = core.control(msg.control);
      if (!r) break;
      for (const event of r.events) post({ type: 'exerciseEvent', event });
      post({ type: 'exerciseState', state: r.state });
      break;
    }
    case 'stop':
      landmarker?.close();
      landmarker = null;
      break;
  }
};
