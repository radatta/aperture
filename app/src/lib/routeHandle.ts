import type { UIMatch } from 'react-router';

// Per-route layout flags, set as a route's `handle` in routes.tsx and read by AppShell via useMatches().
export interface RouteHandle {
  readonly hideCapture?: boolean; // drop the capture bar from the dock (timers stay)
}

export const hidesCapture = (matches: readonly UIMatch[]) =>
  matches.some((m) => (m.handle as RouteHandle | undefined)?.hideCapture === true);
