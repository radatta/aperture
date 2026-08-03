import { RouterProvider } from 'react-router/dom';
import { router } from './router';

// Phase 4: the three-mode glanceable home + deep-view routing. The app body is the router; providers
// (query, api, home mode, theme) wrap it in main.tsx. AppShell supplies the header, nav, and the
// global capture bar around every route.
export default function App() {
  return <RouterProvider router={router} />;
}
