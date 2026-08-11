import { useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router';
import { AppHeader } from './AppHeader';
import { AppNav } from './AppNav';
import { CaptureBar } from '../modules/capture/CaptureBar';
import { TimerBar } from '../modules/pomodoro/TimerBar';

// The layout every route renders inside: header + deep-view nav + the routed page, above a single
// fixed bottom dock.
//
// The dock is one element on purpose. Timers and capture used to be two independent `fixed`
// children at overlapping offsets, so the running-timer stack sat on top of page content and, on a
// phone, on top of the capture bar itself. Stacking them in one column at the same width as the
// content means they can never collide.
export function AppShell() {
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);

  // Reserve exactly as much room as the dock currently needs. A fixed padding can't be right: the
  // dock grows when a timer is running, when several run at once, and when the capture field wraps
  // to six lines — and whatever constant you pick, some combination reaches past it and starts
  // covering the last card on the page.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setDockHeight(entry!.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-surface text-ink">
      <div
        className="mx-auto max-w-3xl px-5"
        style={{ paddingBottom: `calc(${dockHeight}px + 2rem)` }}
      >
        <AppHeader />
        <AppNav />
        <main className="pt-5">
          <Outlet />
        </main>
      </div>
      <div
        ref={dockRef}
        data-dock
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-safe"
      >
        <div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-2">
          <TimerBar />
          <CaptureBar />
        </div>
      </div>
    </div>
  );
}
