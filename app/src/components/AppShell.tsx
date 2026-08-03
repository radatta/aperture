import { Outlet } from 'react-router';
import { AppHeader } from './AppHeader';
import { AppNav } from './AppNav';
import { CaptureBar } from '../modules/capture/CaptureBar';
import { TimerBar } from '../modules/pomodoro/TimerBar';

// The layout every route renders inside: header + deep-view nav + the routed page, with the global
// capture bar fixed at the bottom (present everywhere, never a route). pb-32 keeps content clear of it.
export function AppShell() {
  return (
    <div className="min-h-screen bg-surface text-ink">
      <div className="mx-auto max-w-3xl px-5 pb-32">
        <AppHeader />
        <AppNav />
        <main className="pt-5">
          <Outlet />
        </main>
      </div>
      <TimerBar />
      <CaptureBar />
    </div>
  );
}
