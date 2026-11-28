import { act } from '@testing-library/react';

// A real-time wait with a tree mounted (docs/product/CONVENTIONS.md → the console guard). A raw sleep can catch a late
// update (the timer engine ticks every second) outside act(); one act around the whole sleep holds renders and effects
// to its end, so a "nothing happens within N ms" check would miss what a render sets off. Short act slices do neither.
const SLICE_MS = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function realWait(ms: number): Promise<void> {
  let left = ms;
  do {
    const step = Math.min(SLICE_MS, left);
    await act(async () => void (await sleep(step)));
    left -= step;
  } while (left > 0);
}
