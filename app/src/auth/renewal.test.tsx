import { StrictMode, useEffect } from 'react';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { ErrorResponse } from 'oidc-client-ts';
import type { UserManager } from 'oidc-client-ts';
import { AuthProvider as OidcProvider } from 'react-oidc-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../data/queryClient';
import { OidcBridge } from './OidcBridge';
import { RequireAuth } from './RequireAuth';
import { getAuthToken, notifyUnauthorized } from './tokenStore';
import { useAuth } from './auth-context';

// The renewal machine is the one piece of auth that never runs in the rest of the suite: API_MODE is
// 'stub' under vitest, so AuthProvider always takes the bypass path and OidcBridge never mounts. Every
// regression in this logic landed in that blind spot, so it gets driven directly here against a fake
// UserManager — no module mocking, so tokenStore and queryClient stay the singletons the bridge uses.

type FakeUser = {
  access_token: string;
  refresh_token?: string;
  expired: boolean;
  profile: { sub: string; email: string };
};

const makeUser = (o: Partial<FakeUser> = {}): FakeUser => ({
  access_token: 't1',
  refresh_token: 'r1',
  expired: false,
  profile: { sub: 'u1', email: 'u@test' },
  ...o,
});

function createEmitter<T = void>() {
  const handlers = new Set<(a: T) => void>();
  return {
    add: (cb: (a: T) => void) => {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
    remove: (cb: (a: T) => void) => void handlers.delete(cb),
    emit: (a: T) => handlers.forEach((h) => h(a)),
    get count() {
      return handlers.size;
    },
  };
}

function createFakeManager(initial: FakeUser | null = makeUser({ expired: true })) {
  const loaded = createEmitter<FakeUser>();
  const unloaded = createEmitter();
  const signedOut = createEmitter();
  const expired = createEmitter();
  const renewError = createEmitter<unknown>();
  let user = initial;

  const manager = {
    settings: { authority: 'https://authority.test', client_id: 'c' },
    events: {
      addUserLoaded: loaded.add,
      removeUserLoaded: loaded.remove,
      addUserUnloaded: unloaded.add,
      removeUserUnloaded: unloaded.remove,
      addUserSignedOut: signedOut.add,
      removeUserSignedOut: signedOut.remove,
      addSilentRenewError: renewError.add,
      removeSilentRenewError: renewError.remove,
      addAccessTokenExpired: expired.add,
      removeAccessTokenExpired: expired.remove,
    },
    getUser: vi.fn(async () => user),
    // mirrors the real storeUser(null) + events.unload()
    removeUser: vi.fn(async () => {
      user = null;
      unloaded.emit();
    }),
    signinSilent: vi.fn(async (): Promise<FakeUser | null> => {
      throw new Error('not stubbed');
    }),
    signinRedirect: vi.fn(async () => {}),
    signoutRedirect: vi.fn(async () => {}),
  };

  return {
    manager: manager as unknown as UserManager,
    calls: manager,
    events: { loaded, unloaded, expired, renewError },
    setUser: (u: FakeUser | null) => void (user = u),
    getStoredUser: () => user,
    // success mirrors _useRefreshToken: store the user and raise userLoaded BEFORE resolving
    renewSucceeds: (next = makeUser({ access_token: 't2' })) =>
      manager.signinSilent.mockImplementation(async () => {
        user = next;
        loaded.emit(next);
        return next;
      }),
    renewFails: (err: unknown) =>
      manager.signinSilent.mockImplementation(async () => {
        throw err;
      }),
  };
}

function Probe() {
  const { status } = useAuth();
  return <div data-testid="status">{status}</div>;
}

function ErrorProbe() {
  const { error } = useAuth();
  return <div data-testid="error">{error ?? ''}</div>;
}

// Reports whether errors are currently suppressed, which `error` alone can't distinguish from "no error".
function SignInTrigger() {
  const { signIn, error } = useAuth();
  return (
    <>
      <button data-testid="signin" onClick={signIn}>
        sign in
      </button>
      <div data-testid="hidden">{error === null ? 'suppressed-or-none' : 'shown'}</div>
    </>
  );
}

// Counts mounts so an unmount of the tree under RequireAuth is directly assertable — that unmount is
// what loses PomodoroProvider's in-memory paused/blocked state.
let mounts = 0;
function MountCounter({ children }: { children?: ReactNode }) {
  useEffect(() => {
    mounts++;
  }, []);
  return <>{children}</>;
}

const setVisibility = (v: 'visible' | 'hidden') =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
const setOnline = (b: boolean) =>
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => b });

const fireVisibility = () => document.dispatchEvent(new Event('visibilitychange'));
const fireOnline = () => window.dispatchEvent(new Event('online'));

function renderBridge(fake: ReturnType<typeof createFakeManager>, strict = false) {
  const tree = (
    <OidcProvider userManager={fake.manager}>
      <OidcBridge manager={fake.manager}>
        <Probe />
        <RequireAuth>
          <MountCounter>
            <div>gated</div>
          </MountCounter>
        </RequireAuth>
      </OidcBridge>
    </OidcProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const status = () => screen.getByTestId('status').textContent;

let invalidateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mounts = 0;
  // We drive React's act() directly here (outside RTL's own calls), so the flag has to be set explicitly
  // or React logs "environment is not configured to support act(...)".
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  setVisibility('visible');
  setOnline(true);
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // These are prototype accessors in jsdom; the per-test overrides are own properties, so drop those to
  // restore. Typed loosely because both are readonly on the lib types.
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(navigator, 'onLine');
});

const settle = () => act(async () => void (await Promise.resolve()));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe('renewal — relaunch', () => {
  it('renews once when the stored token is already expired at mount', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);
    expect(status()).toBe('authenticated');
  });

  it('does not renew when the stored token is still fresh', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    expect(fake.calls.signinSilent).not.toHaveBeenCalled();
  });

  it('renews on accessTokenExpired', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    await act(async () => fake.events.expired.emit());
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);
    // Only a 401 asks for a refetch; an ordinary expiry must not invalidate every query.
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('publishes the renewed access token to the token store', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewSucceeds(makeUser({ access_token: 'fresh-token' }));
    renderBridge(fake);
    await settle();

    expect(getAuthToken()).toBe('fresh-token');
  });
});

describe('renewal — network failure keeps the session', () => {
  it('never clears the user on a network error, so the refresh token survives', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('Failed to fetch'));
    renderBridge(fake);
    await settle();
    await advance(60_000);

    expect(fake.calls.removeUser).not.toHaveBeenCalled();
    expect(fake.getStoredUser()?.refresh_token).toBe('r1');
  });

  it('runs a fast ladder, then backs off to a slow retry', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('offline'));
    renderBridge(fake);
    await settle();

    await advance(30_000); // 2+4+8+16s
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(5);

    await advance(30_000); // the fast ladder is done; nothing rapid in this window
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(5);

    await advance(30_000); // the slow retry lands a minute after giving up
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(6);
  });

  it('shows the loading state, not a sign-in button, while retrying', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('offline'));
    renderBridge(fake);
    await settle();
    await advance(6_000);

    expect(status()).toBe('loading');
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
  });

  it('offers sign-in after the ladder is exhausted, then recovers when back online', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('offline'));
    renderBridge(fake);
    await settle();
    await advance(30_000);
    expect(status()).toBe('unauthenticated');

    fake.renewSucceeds();
    await act(async () => fireOnline());
    await settle();

    expect(status()).toBe('authenticated');
  });

  // The wakeup listeners only fire on events the browser raises. A Cognito 5xx, a captive portal or a
  // DNS failure never flips navigator.onLine, so without a slow retry the app would sit on a sign-in
  // button whose tap costs a password — the outcome this change exists to prevent.
  it('keeps retrying after giving up, without a connectivity event', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('503 from the authority'));
    renderBridge(fake);
    await settle();
    await advance(30_000);
    const exhausted = fake.calls.signinSilent.mock.calls.length;
    expect(status()).toBe('unauthenticated');

    fake.renewSucceeds();
    await advance(60_000);

    expect(fake.calls.signinSilent.mock.calls.length).toBeGreaterThan(exhausted);
    expect(status()).toBe('authenticated');
  });

  it('does not flip the sign-in button back to loading for a background retry', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('503'));
    renderBridge(fake);
    await settle();
    await advance(30_000);
    expect(status()).toBe('unauthenticated');

    await advance(60_000); // a slow retry runs and fails again
    expect(status()).toBe('unauthenticated');
  });

  it('ignores a visibilitychange to hidden', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('offline'));
    renderBridge(fake);
    await settle();
    await advance(30_000);
    const after = fake.calls.signinSilent.mock.calls.length;

    setVisibility('hidden');
    await act(async () => fireVisibility());
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(after);
  });

  it('does not retry while still offline, and keeps the budget for when connectivity returns', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('offline'));
    renderBridge(fake);
    await settle();
    await advance(30_000);
    const after = fake.calls.signinSilent.mock.calls.length;

    setOnline(false);
    await act(async () => fireVisibility());
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(after);
  });

  // The regression that made focus expensive: renewing on every wakeup regardless of whether anything
  // was owed meant a token POST each time the app came forward.
  it('costs zero token requests on focus churn with a fresh token', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    for (let i = 0; i < 3; i++) {
      setVisibility('visible');
      await act(async () => fireVisibility());
      setVisibility('hidden');
      await act(async () => fireVisibility());
    }
    await act(async () => fireOnline());

    expect(fake.calls.signinSilent).not.toHaveBeenCalled();
  });
});

describe('renewal — authority rejects the grant', () => {
  it('clears the session on invalid_grant without retrying', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new ErrorResponse({ error: 'invalid_grant' }));
    renderBridge(fake);
    await settle();
    await advance(60_000);

    expect(fake.calls.removeUser).toHaveBeenCalledTimes(1);
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);
    expect(status()).toBe('unauthenticated');
  });

  // The routine expiry is expected, not a fault. react-oidc-context sets `error` on silentRenewError and
  // clears it only on USER_LOADED, so the teardown path would otherwise leave "invalid_grant" in red
  // under the sign-in button.
  it('does not surface an error when the session expires normally', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new ErrorResponse({ error: 'invalid_grant' }));
    render(
      <OidcProvider userManager={fake.manager}>
        <OidcBridge manager={fake.manager}>
          <ErrorProbe />
          <RequireAuth>
            <div>gated</div>
          </RequireAuth>
        </OidcBridge>
      </OidcProvider>,
    );
    await settle();
    await act(async () =>
      fake.events.renewError.emit(new ErrorResponse({ error: 'invalid_grant' })),
    );
    await settle();

    expect(screen.getByTestId('error').textContent).toBe('');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
  });

  // The quiet window has to end somewhere, or every later failure is swallowed too — tap Sign in while
  // offline and the button just looks dead.
  it('stops hiding errors once the user asks to sign in', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new ErrorResponse({ error: 'invalid_grant' }));
    render(
      <OidcProvider userManager={fake.manager}>
        <OidcBridge manager={fake.manager}>
          <ErrorProbe />
          <SignInTrigger />
        </OidcBridge>
      </OidcProvider>,
    );
    await settle();
    await act(async () =>
      fake.events.renewError.emit(new ErrorResponse({ error: 'invalid_grant' })),
    );
    await settle();
    expect(screen.getByTestId('error').textContent).toBe('');

    await act(async () => screen.getByTestId('signin').click());
    await act(async () => fake.events.renewError.emit(new Error('discovery unreachable')));
    await settle();

    expect(screen.getByTestId('hidden').textContent).toBe('shown');
  });

  it('clears on a silentRenewError carrying invalid_grant, but retries a network one', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewFails(new Error('offline'));
    renderBridge(fake);
    await settle();

    await act(async () => fake.events.renewError.emit(new Error('network')));
    expect(fake.calls.signinSilent).toHaveBeenCalled();
    expect(fake.calls.removeUser).not.toHaveBeenCalled();

    await act(async () =>
      fake.events.renewError.emit(new ErrorResponse({ error: 'invalid_grant' })),
    );
    expect(fake.calls.removeUser).toHaveBeenCalled();
  });
});

describe('renewal — nothing to renew with', () => {
  it('does not call the token endpoint when signed out', async () => {
    const fake = createFakeManager(null);
    renderBridge(fake);
    await settle();

    await act(async () => fake.events.expired.emit());
    await advance(60_000);
    expect(fake.calls.signinSilent).not.toHaveBeenCalled();
  });

  it('offers sign-in when the stored user has no refresh token', async () => {
    const fake = createFakeManager(makeUser({ expired: true, refresh_token: undefined }));
    renderBridge(fake);
    await settle();
    await advance(60_000);

    expect(fake.calls.signinSilent).not.toHaveBeenCalled();
    expect(status()).toBe('unauthenticated');
  });
});

describe('renewal — the 401 bridge', () => {
  it('renews and refetches queries once the token is good again', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    await act(async () => notifyUnauthorized());
    await settle();

    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  // A 401 a fresh token can't fix (audience mismatch, clock skew) otherwise self-sustains: invalidate →
  // refetch → 401 → renew → invalidate, at network speed against both the BFF and Cognito.
  it('caps a 401 that renewing does not fix', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    for (let i = 0; i < 10; i++) {
      await act(async () => notifyUnauthorized());
      await settle();
    }

    // Exact, not an upper bound: `toBeLessThanOrEqual` also passes at zero, which would hide a
    // regression where a 401 stops triggering renewal at all.
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(2);
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  // The budget is for sequential loops (renew → refetch → 401 → renew). A burst of concurrent 401s —
  // which is what invalidateQueries produces, every panel at once — must not spend it on notifications
  // that did no work, or a genuine 401 an hour later goes unanswered while every query sits errored.
  it('does not spend the cap on a burst of 401s during one in-flight renewal', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    let release: (u: FakeUser) => void = () => {};
    fake.calls.signinSilent.mockImplementation(
      () =>
        new Promise((res) => {
          release = (u) => {
            fake.setUser(u);
            fake.events.loaded.emit(u);
            res(u);
          };
        }),
    );

    await act(async () => void renderBridge(fake));
    await act(async () => {
      notifyUnauthorized();
      notifyUnauthorized();
      notifyUnauthorized();
      notifyUnauthorized();
    });
    await act(async () => void release(makeUser({ access_token: 't2' })));
    await settle();
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);

    // A later, genuine 401 must still be answered.
    fake.renewSucceeds();
    await act(async () => notifyUnauthorized());
    await settle();
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(2);
  });

  it('honours a 401 again after a real expiry resets the cap', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    for (let i = 0; i < 5; i++) {
      await act(async () => notifyUnauthorized());
      await settle();
    }
    const capped = fake.calls.signinSilent.mock.calls.length;

    await act(async () => fake.events.expired.emit());
    await settle();
    await act(async () => notifyUnauthorized());
    await settle();

    expect(fake.calls.signinSilent.mock.calls.length).toBeGreaterThan(capped + 1);
  });

  it('keeps the app mounted through a 401 and its renewal', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();
    expect(mounts).toBe(1);

    await act(async () => notifyUnauthorized());
    await settle();

    expect(status()).toBe('authenticated');
    expect(mounts).toBe(1);
  });
});

describe('renewal — state does not get stuck', () => {
  // The stuck-flag regression: after giving up, a renewal completed by SilentRenewService (which raises
  // userLoaded without going through us) has to clear the given-up state. Otherwise the next ordinary
  // expiry skips the loading grace and unmounts the tree.
  it('clears the given-up state when a renewal succeeds elsewhere', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewFails(new Error('offline'));
    renderBridge(fake);
    await settle();
    await advance(30_000);
    expect(status()).toBe('unauthenticated');

    await act(async () => fake.events.loaded.emit(makeUser({ expired: false })));
    await settle();
    // The second emit carries an EXPIRED user on purpose. react-oidc-context computes isAuthenticated
    // only at dispatch time, so after a silent expiry it stays stale-true and masks the phase entirely.
    // Flipping it false is what makes the phase observable — without this the test passes either way.
    await act(async () => fake.events.loaded.emit(makeUser({ expired: true })));
    await settle();

    expect(status()).toBe('loading');
  });

  it('does not ladder when a renewal completes elsewhere mid-flight', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    let fail: (e: unknown) => void = () => {};
    fake.calls.signinSilent.mockImplementation(() => new Promise((_res, rej) => void (fail = rej)));
    renderBridge(fake);
    await settle();
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);

    // SilentRenewService gets there first, then our in-flight call rejects on the network.
    await act(async () => fake.events.loaded.emit(makeUser({ expired: false })));
    await act(async () => {
      fail(new Error('offline'));
      await Promise.resolve();
    });
    await advance(30_000);

    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);
    expect(status()).toBe('authenticated');
  });

  it('ignores an expiry that arrives while a renewal is already running', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    let release: (u: FakeUser) => void = () => {};
    fake.calls.signinSilent.mockImplementation(
      () =>
        new Promise((res) => {
          release = (u) => {
            fake.setUser(u);
            fake.events.loaded.emit(u);
            res(u);
          };
        }),
    );
    renderBridge(fake);
    await settle();

    await act(async () => fake.events.expired.emit());
    await act(async () => fake.events.expired.emit());
    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);

    await act(async () => void release(makeUser({ expired: false })));
    await settle();
    expect(status()).toBe('authenticated');
  });

  it('never unmounts the app across an expire and successful renew', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    await act(async () => fake.events.expired.emit());
    await settle();

    expect(mounts).toBe(1);
  });
});

describe('renewal — lifecycle', () => {
  it('stops responding to every trigger after unmount', async () => {
    const fake = createFakeManager(makeUser({ expired: false }));
    fake.renewSucceeds();
    const { unmount } = renderBridge(fake);
    await settle();
    unmount();

    await act(async () => fake.events.expired.emit());
    await act(async () => fireOnline());
    await act(async () => notifyUnauthorized());
    await advance(60_000);

    expect(fake.calls.signinSilent).not.toHaveBeenCalled();
    expect(fake.events.expired.count).toBe(0);
    expect(fake.events.renewError.count).toBe(0);
  });

  it('does not warn or clear the user when a renew rejects after unmount', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeManager(makeUser({ expired: true }));
    let reject: (e: unknown) => void = () => {};
    fake.calls.signinSilent.mockImplementation(
      () => new Promise((_res, rej) => void (reject = rej)),
    );

    const { unmount } = renderBridge(fake);
    await settle();
    unmount();
    await act(async () => {
      reject(new Error('offline'));
      await Promise.resolve();
    });

    expect(fake.calls.removeUser).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  // Expired on mount, so the double-invoked effect exercises the mount kick — the path StrictMode can
  // actually double. A fresh user would make this test vacuous.
  it('renews once under StrictMode despite the double-invoked effect', async () => {
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewSucceeds();
    renderBridge(fake, true);
    await settle();

    expect(fake.calls.signinSilent).toHaveBeenCalledTimes(1);
  });

  it('skips the mount renew during the OIDC redirect callback', async () => {
    const search = window.location.search;
    window.history.replaceState({}, '', '/?code=abc&state=xyz');
    const fake = createFakeManager(makeUser({ expired: true }));
    fake.renewSucceeds();
    renderBridge(fake);
    await settle();

    // OidcProvider is still exchanging the code; renewing the old stored user here races it, and an
    // invalid_grant on that one would remove the session just signed into.
    expect(fake.calls.signinSilent).not.toHaveBeenCalled();
    window.history.replaceState({}, '', search || '/');
  });
});
