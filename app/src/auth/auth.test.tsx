import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './AuthProvider';
import { RequireAuth } from './RequireAuth';
import { useAuth } from './auth-context';
import { getUserStore } from './userStore';

// API_MODE defaults to 'stub' under vitest (no VITE_API_MODE), so AuthProvider takes the bypass path —
// no real Cognito is touched. The http path is covered two ways: renewal.test.tsx drives OidcBridge
// against a fake UserManager, and the JWT verify tests cover the server side.
function Probe() {
  const { status, user } = useAuth();
  return <div>{`${status}:${user?.sub}:${user?.email}`}</div>;
}

describe('AuthProvider (stub bypass)', () => {
  it('provides a fixed local identity without Cognito', () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByText('authenticated:local:local@aperture.dev')).toBeTruthy();
  });

  it('RequireAuth passes through to the app when authenticated', () => {
    render(
      <AuthProvider>
        <RequireAuth>
          <div>gated content</div>
        </RequireAuth>
      </AuthProvider>,
    );
    expect(screen.getByText('gated content')).toBeTruthy();
  });
});

// The bug this guards: oidc-client-ts defaults its user store to sessionStorage, which the browser drops
// when the context goes away — so an installed PWA whose process the OS reclaimed lost a still-valid
// refresh token and demanded a full sign-in. Nothing surfaces that in dev; it only shows up a day later
// on a real device, so pin the storage backend here.
describe('OIDC token storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('persists tokens in localStorage, not sessionStorage, so a PWA relaunch keeps the session', async () => {
    await getUserStore().set('user:test', 'token-payload');

    expect(window.localStorage.getItem('oidc.user:test')).toBe('token-payload');
    expect(window.sessionStorage.length).toBe(0);
  });

  // A relaunch is a fresh module registry, so what matters is that the bytes outlive the store object,
  // not that one instance can read its own write. Rebuild the module to get a genuinely new store.
  it('reads back what a previous store instance wrote', async () => {
    await getUserStore().set('user:roundtrip', 'v1');

    vi.resetModules();
    const { getUserStore: freshStore } = await import('./userStore');

    expect(await freshStore().get('user:roundtrip')).toBe('v1');
  });
});
