import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ApiClient } from '@aperture/shared';
import { ApiContext } from '../data/api-context';
import { ThemeProvider } from '../components/ThemeProvider';
import { HomeModeProvider } from '../modules/home/HomeModeProvider';
import { PomodoroProvider } from '../modules/pomodoro/PomodoroProvider';
import { createStubClient } from '../data/stubClient';
import { routes } from '../routes';

// Render a component with a fresh QueryClient and an injected (isolated) ApiClient.
// A router is part of the baseline: in the real app nothing renders outside one, so any component
// reaching for router context (a NavLink, a ButtonLink) works here the same way it does in the app.
// So is the timer engine (PomodoroProvider): the Done and Split forms read its running timers.
export function renderWithProviders(ui: ReactElement, opts: { api: ApiClient }): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    // Built once, so a rerender() can't reset the router to "/" and throw away navigation the test
    // performed. The trade: `children` is captured at first render, so rerender() with a *different*
    // element won't take. No test needs that; if one ever does, swap to <MemoryRouter>.
    const [router] = useState(() =>
      createMemoryRouter([{ path: '*', element: children }], { initialEntries: ['/'] }),
    );
    return (
      <QueryClientProvider client={client}>
        <ApiContext value={opts.api}>
          <PomodoroProvider>
            <RouterProvider router={router} />
          </PomodoroProvider>
        </ApiContext>
      </QueryClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}

// Render the whole app (real route table + all providers) at a starting path, over an isolated stub.
// Used for routing + home-mode integration tests.
export function renderApp(
  opts: { api?: ApiClient; path?: string; seed?: boolean } = {},
): RenderResult & { api: ApiClient } {
  const api =
    opts.api ??
    createStubClient({ seed: opts.seed ?? true, storageKey: `app-test-${Math.random()}` });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [opts.path ?? '/'] });
  const result = render(
    <QueryClientProvider client={client}>
      <ApiContext value={api}>
        <HomeModeProvider>
          <ThemeProvider>
            <PomodoroProvider>
              <RouterProvider router={router} />
            </PomodoroProvider>
          </ThemeProvider>
        </HomeModeProvider>
      </ApiContext>
    </QueryClientProvider>,
  );
  return Object.assign(result, { api });
}
