import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { HomePage } from './pages/Home';
import { LogPage } from './pages/Log';
import { TasksPage } from './pages/Tasks';
import { RecruitingPage } from './pages/Recruiting';
import { AttemptsSection } from './pages/Recruiting/AttemptsSection';
import { StoryBank } from './pages/Recruiting/StoryBank';
import { HabitsPage } from './pages/Habits';
import { RollsPage } from './pages/Rolls';
import { InboxPage } from './pages/Inbox';
import { SettingsPage } from './pages/Settings';
import { FinancesAllTab, FinancesPage, FinancesRulesTab, FinancesSortTab } from './pages/Finances';
import { FluxPage } from './pages/Flux';
import { FluxExerciseView } from './pages/Flux/ExerciseView';
import { FluxLibraryTab } from './pages/Flux/LibraryTab';
import { FluxHistoryTab } from './pages/Flux/HistoryTab';
import type { RouteHandle } from './lib/routeHandle';

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
          { index: true, element: <AttemptsSection /> },
          { path: 'stories', element: <StoryBank /> },
        ],
      },
      { path: 'habits', element: <HabitsPage /> },
      { path: 'rolls', element: <RollsPage /> },
      {
        path: 'flux',
        element: <FluxPage />,
        children: [
          { index: true, element: <FluxLibraryTab /> },
          { path: 'history', element: <FluxHistoryTab /> },
          {
            path: ':exerciseId',
            element: <FluxExerciseView />,
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
