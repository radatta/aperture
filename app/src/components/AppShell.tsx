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
// content means they can never collide, and the shell can reserve bottom room for the pair.
export function AppShell() {
  return (
    <div className="min-h-screen bg-surface text-ink">
      <div className="mx-auto max-w-3xl px-5 pb-44">
        <AppHeader />
        <AppNav />
        <main className="pt-5">
          <Outlet />
        </main>
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-safe">
        <div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-2">
          <TimerBar />
          <CaptureBar />
        </div>
      </div>
    </div>
  );
}
