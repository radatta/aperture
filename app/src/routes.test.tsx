import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { screen } from '@testing-library/react';
import { AppShell } from './components/AppShell';
import { lazyPage } from './lib/lazyPage';
import { renderApp } from './test/utils';
import { realWait } from './test/realWait';

// The Flux pages are the one lazy chunk (routes.tsx → lib/lazyPage). The Suspense sits inside the route
// element, so a deep link shows the shell with "Loading…" in the outlet while the chunk loads — never a blank
// page (docs/areas/flux D64). The app's own chunk resolves once per worker (the suite shares a module
// registry), so the moment under test is built here: the same shell, the same helper, a chunk this test holds.
describe('routes', () => {
  it('a deep link to /flux/history keeps the shell up, with "Loading…" in the outlet, until the Flux chunk lands', async () => {
    let land = () => {};
    const chunk = new Promise<{ History: () => ReactElement }>((r) => {
      land = () => r({ History: () => <h1>Flux history landed</h1> });
    });
    renderApp({
      path: '/flux/history',
      routes: [
        {
          path: '/',
          element: <AppShell />,
          children: [
            {
              path: 'flux/history',
              element: lazyPage(
                () => chunk,
                (m) => m.History,
              ),
            },
          ],
        },
      ],
    });
    expect(screen.getByRole('link', { name: 'Flux' })).toBeTruthy(); // the shell, at once
    expect(screen.getByText('Loading…')).toBeTruthy();
    await realWait(50);
    expect(screen.queryByRole('heading', { name: 'Flux history landed' })).toBeNull(); // still held
    expect(screen.getByText('Loading…')).toBeTruthy();
    land();
    expect(await screen.findByRole('heading', { name: 'Flux history landed' })).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByRole('link', { name: 'Flux' })).toBeTruthy();
  });

  it('a chunk that fails to load shows the error with Retry in the outlet, never the router’s error page', async () => {
    renderApp({
      path: '/flux/history',
      routes: [
        {
          path: '/',
          element: <AppShell />,
          children: [
            {
              path: 'flux/history',
              element: lazyPage(
                () => Promise.reject(new Error('offline')),
                (m: { History: () => ReactElement }) => m.History,
              ),
            },
          ],
        },
      ],
    });
    expect(await screen.findByText(/Couldn’t load this|Couldn't load this/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Flux' })).toBeTruthy(); // the shell is still there
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });
});
