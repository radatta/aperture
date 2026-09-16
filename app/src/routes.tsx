import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { HomePage } from './pages/Home';
import { LogPage } from './pages/Log';
import { TasksPage } from './pages/Tasks';
import { RecruitingPage } from './pages/Recruiting';
import { AttemptsSection } from './pages/Recruiting/AttemptsSection';
import { StoryBank } from './pages/Recruiting/StoryBank';
import { HabitsPage } from './pages/Habits';
import { InboxPage } from './pages/Inbox';
import { SettingsPage } from './pages/Settings';

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
      { path: 'inbox', element: <InboxPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];
