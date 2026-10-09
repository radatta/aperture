import FluxWorker from './flux.worker?worker';
import { defaultStream, FluxTracker } from './tracker';

// The app's FluxEngine: the real camera, the real worker. Kept apart from tracker.ts so tests construct
// FluxTracker with fakes and never import the `?worker` module.
export const createWorkerEngine = () =>
  new FluxTracker({
    getStream: defaultStream,
    createWorker: () => new FluxWorker(),
    grabFrame: (video) => createImageBitmap(video),
    now: () => performance.now(),
  });
