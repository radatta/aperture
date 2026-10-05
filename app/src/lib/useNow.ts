import { useEffect, useState } from 'react';

// The wall clock, re-read every minute and whenever the tab becomes visible again (the realistic
// "reopen it later" path) — for anything that changes with time alone, like a due-time colour. Every
// row on a long list uses it, so they all share ONE interval and ONE visibility listener, started by the
// first subscriber and torn down with the last (nothing outlives an unmount, so tests start clean).
const TICK_MS = 60_000;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop) {
    const tick = () => listeners.forEach((l) => l());
    const id = setInterval(tick, TICK_MS);
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    stop = () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(() => setNow(Date.now())), []);
  return now;
}
