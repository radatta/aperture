import { afterAll, beforeAll } from 'vitest';

// jsdom has no 2D context: getContext() logs "Not implemented" and returns null, which the console guard fails
// on. A file whose code draws (the fake Flux engine clears and dots its canvas) calls this at its top level: null
// is still what the code gets, so it runs the same no-context path, quietly. A plain override for the whole file,
// not vi.spyOn: a file's own vi.restoreAllMocks() runs before setup's unmount, which still draws. Per file, not in
// setup, so an unexpected canvas use anywhere else still fails by name.
export function stubCanvas2d(): void {
  const real = HTMLCanvasElement.prototype.getContext;
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof real;
  });
  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = real;
  });
}
