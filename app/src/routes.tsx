import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { HomePage } from './pages/Home';
import { LogPage } from './pages/Log';
import { TasksPage } from './pages/Tasks';
import { RecruitingPage } from './pages/Recruiting';
import { SittingDetail } from './pages/Recruiting/SittingDetail';
import { SittingsSection } from './pages/Recruiting/SittingsSection';
import { StoryBank } from './pages/Recruiting/StoryBank';
import { HabitsPage } from './pages/Habits';
import { RollsPage } from './pages/Rolls';
import { InboxPage } from './pages/Inbox';
import { SettingsPage } from './pages/Settings';
import { FinancesAllTab, FinancesPage, FinancesRulesTab, FinancesSortTab } from './pages/Finances';
import { lazyPage } from './lib/lazyPage';
import type { RouteHandle } from './lib/routeHandle';

// Flux is the one lazy area: its pages load as one chunk on the first Flux visit (pages/Flux/flux-pages.ts),
// so `/` never fetches them; the shell stays up while it loads (lib/lazyPage, docs/areas/flux D64).
type FluxPages = typeof import('./pages/Flux/flux-pages');
const fluxPage = (pick: (m: FluxPages) => FluxPages[keyof FluxPages]) =>
  lazyPage(() => import('./pages/Flux/flux-pages'), pick);

// Route table, shared by the browser router (App) and the memory router used in tests. AppShell is
// the layout; `/` is the glanceable home, the rest are deep views. Pomodoro + capture are not routes.
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'log', element: <LogPage /> },
      { path: 'tasks', element: <TasksPage /> },
      {
        path: 'recruiting',
        element: <RecruitingPage />,
        children: [
          { index: true, element: <SittingsSection /> },
          { path: 'sittings/:id', element: <SittingDetail /> },
          { path: 'stories', element: <StoryBank /> },
        ],
      },
      { path: 'habits', element: <HabitsPage /> },
      { path: 'rolls', element: <RollsPage /> },
      {
        path: 'flux',
        element: fluxPage((m) => m.FluxPage),
        children: [
          { index: true, element: fluxPage((m) => m.FluxLibraryTab) },
          { path: 'history', element: fluxPage((m) => m.FluxHistoryTab) },
          {
            path: ':exerciseId',
            element: fluxPage((m) => m.FluxExerciseView),
            // Nothing to capture mid-set, and the bar ate the phone's bottom strip (flux D30).
            handle: { hideCapture: true } satisfies RouteHandle,
          },
        ],
      },
      {
        path: 'finances',
        element: <FinancesPage />,
        children: [
          { index: true, element: <FinancesSortTab /> },
          { path: 'all', element: <FinancesAllTab /> },
          { path: 'rules', element: <FinancesRulesTab /> },
        ],
      },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];
