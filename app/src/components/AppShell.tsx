import { useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router';
import { AppHeader } from './AppHeader';
import { AppNav } from './AppNav';
import { CaptureBar } from '../modules/capture/CaptureBar';
import { IdleFocus, TimerBar } from '../modules/pomodoro/TimerBar';

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
  // The same height is published as --dock-h, which index.css turns into the root's
  // scroll-padding-bottom — so anything scrolled into view (focus moves, scrollIntoView) lands above
  // the dock instead of under it.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const root = document.documentElement;
    // offsetHeight, not contentRect: contentRect is the CONTENT box and so excludes the dock's own
    // pb-safe. On a home-indicator iPhone that's ~34px the reserve would land short — precisely the
    // overlap this measurement exists to prevent.
    const measure = () => {
      setDockHeight(el.offsetHeight);
      root.style.setProperty('--dock-h', `${el.offsetHeight}px`);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      root.style.removeProperty('--dock-h');
    };
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
        // Selector for the out-of-repo browser harness that asserts nothing on a page is ever
        // covered by the dock. Not used by app code or CSS.
        data-dock
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-safe"
      >
        {/* This column stays pointer-events-none and each PANEL opts back in. The timer stack is
            only sm:w-80, so an auto-everywhere column would swallow clicks on the page showing
            through the transparent strip beside it. */}
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          <TimerBar />
          <CaptureBar trailing={<IdleFocus />} />
        </div>
      </div>
    </div>
  );
}
