import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ErrorResponse } from 'oidc-client-ts';
import type { UserManager } from 'oidc-client-ts';
import { hasAuthParams, useAuth as useOidc } from 'react-oidc-context';
import { queryClient } from '../data/queryClient';
import { AuthContext } from './auth-context';
import type { AuthState } from './auth-context';
import { setAuthToken, setReauthHandler } from './tokenStore';

// Retries on a network failure before the sign-in button appears. 2+4+8+16 ≈ 30s of backoff — long
// enough to ride out a reconnect, short enough not to look hung.
const MAX_RENEW_ATTEMPTS = 5;
// A 401 that a fresh token doesn't fix (audience or issuer mismatch, clock skew, a missing user record)
// would otherwise self-sustain: renew succeeds, queries refetch, they 401 again, repeat at network
// speed. Two attempts is enough for a genuinely stale token; past that the 401 isn't about the token.
const MAX_UNAUTHORIZED_RENEWS = 2;
// Once the ladder has given up, keep retrying at this interval. The wakeup listeners only catch failures
// that flip navigator.onLine; a Cognito outage or captive portal never does.
const STALLED_RETRY_MS = 60_000;

// What renewal is doing, as far as the UI is concerned. Distinct from the OIDC context's own state:
// 'renewing' keeps RequireAuth on the loading screen instead of offering a sign-in that would land on a
// Hosted UI whose session cookie is long dead, and 'stalled' is the escape from it.
type Phase = 'idle' | 'renewing' | 'stalled';

// The manager arrives as a prop rather than through getUserManager() so this is reachable from a test:
// API_MODE is 'stub' under vitest, so AuthProvider always takes the bypass path and this never renders.
// Every regression in this logic landed in that blind spot — see renewal.test.tsx.
export function OidcBridge({ manager, children }: { manager: UserManager; children: ReactNode }) {
  const oidc = useOidc();
  const [phase, setPhase] = useState<Phase>('idle');
  // react-oidc-context sets `error` on every silentRenewError and clears it only on USER_LOADED — and
  // the invalid_grant teardown goes out through USER_UNLOADED, so without this a routine weekly expiry
  // renders "invalid_grant" in danger text under the sign-in button and reads as a crash.
  const [hideError, setHideError] = useState(false);

  // Mirror the token during render, not in an effect: child effects fire before parent effects, so an
  // effect here would let a child's first query go out token-less. Writing the module store in render
  // is idempotent and ensures the token is set before anything below mounts.
  setAuthToken(oidc.user?.access_token ?? null);

  useEffect(() => {
    let cancelled = false;
    let needsRenew = false; // the stored session isn't usable and we owe it a renew
    let renewing = false; // one of ours is in flight; SilentRenewService also renews on its own
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let recoverQueries = false; // a 401 sent us here, so refetch once the token is good
    let unauthorizedRenews = 0;

    let current: Phase = 'idle'; // mirror of `phase`, readable inside this closure

    const settle = (next: Phase, owed: boolean) => {
      needsRenew = owed;
      clearTimeout(retry);
      current = next;
      if (!cancelled) setPhase(next);
    };

    const renew = async () => {
      if (renewing || cancelled) return;
      renewing = true;
      try {
        const user = await manager.getUser();
        if (cancelled) return;
        // Nothing to renew with. signinSilent would throw a plain Error ('No silent_redirect_uri
        // configured'), which reads as a network fault and buys a pointless 30s ladder for a session
        // that is simply signed out.
        if (!user?.refresh_token) return settle('stalled', false);
        // Don't yank the sign-in button away for a background retry that already gave up once — the
        // slow ladder below runs indefinitely, and flipping the UI every minute would just look broken.
        if (current !== 'stalled') {
          current = 'renewing';
          setPhase('renewing');
        }
        await manager.signinSilent(); // success is handled by userLoaded, not here
      } catch (err) {
        // Someone else finished the job while we were in flight (SilentRenewService, or the redirect
        // callback) — userLoaded already cleared the debt. Laddering on now would burn token requests
        // against a session that is already fresh, and could assert 'stalled' while we hold a valid one.
        if (!needsRenew || cancelled) return;
        // invalid_grant is the authority saying this refresh token is finished — expired, revoked, or
        // dropped by a password change. Clearing the user is what puts RequireAuth back on sign-in; if
        // even that fails (storage full, private mode) fall through to the button rather than spin.
        if (err instanceof ErrorResponse && err.error === 'invalid_grant') {
          setHideError(true); // an expected weekly expiry, not a fault to show the user
          await manager.removeUser().catch(() => settle('stalled', false));
          return;
        }
        // Anything else is the network. Never removeUser here: a tunnel would cost the very refresh
        // token this change exists to preserve. Stay owed, so a wakeup can retry it.
        if (++attempt >= MAX_RENEW_ATTEMPTS) {
          settle('stalled', true);
          // Keep trying, slowly. The wakeup listeners miss any failure that doesn't flip navigator.onLine
          // — a Cognito 5xx, a captive portal, DNS — and without this the app sits on a button whose tap
          // costs a password, which is the outcome this whole change exists to avoid.
          if (!cancelled) retry = setTimeout(() => void renew(), STALLED_RETRY_MS);
        } else if (!cancelled) retry = setTimeout(() => void renew(), 2 ** attempt * 1000);
      } finally {
        renewing = false;
      }
    };

    const request = (reason: 'expired' | 'renewError' | 'unauthorized') => {
      if (reason === 'unauthorized') {
        recoverQueries = true; // any 401 wants its query refetched once the token is good again
        // Charge the budget only when a renew will actually start. A burst of 401s — normal, and
        // guaranteed right after invalidateQueries refetches every panel — would otherwise spend the
        // whole allowance on notifications that did no work, leaving a genuine 401 later unanswerable.
        if (renewing || unauthorizedRenews >= MAX_UNAUTHORIZED_RENEWS) return;
        unauthorizedRenews++;
      } else unauthorizedRenews = 0; // a real expiry means the breaker's window is over
      needsRenew = true;
      attempt = 0;
      clearTimeout(retry);
      void renew();
    };

    // userLoaded/userUnloaded are the only reset points, because the library raises them whoever did the
    // work — us, SilentRenewService, or the redirect callback. Resetting inside our own success path
    // instead is what previously left the UI stuck one expiry away from dropping the whole tree.
    const offLoaded = manager.events.addUserLoaded(() => {
      attempt = 0;
      setHideError(false);
      settle('idle', false);
      if (recoverQueries) {
        recoverQueries = false;
        void queryClient.invalidateQueries();
      }
    });
    const offUnloaded = manager.events.addUserUnloaded(() => {
      attempt = 0;
      unauthorizedRenews = 0;
      recoverQueries = false;
      settle('idle', false);
    });
    const offExpired = manager.events.addAccessTokenExpired(() => request('expired'));
    const offRenewError = manager.events.addSilentRenewError((err) => {
      if (err instanceof ErrorResponse && err.error === 'invalid_grant') {
        setHideError(true); // expected expiry, not a fault (see hideError above)
        void manager.removeUser().catch(() => settle('stalled', false));
      } else request('renewError');
    });
    setReauthHandler(() => request('unauthorized')); // the BFF's 401 is the same signal by another route

    // Wakeups retry a renew we already owe; they never start one. With a fresh token nothing is owed, so
    // coming back to the app costs no token requests at all.
    const wake = () => {
      if (!needsRenew || renewing) return;
      attempt = 0;
      clearTimeout(retry);
      void renew();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) wake();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVisible);

    // Relaunch: the token is usually already dead on load. accessTokenExpired does fire a second later
    // (getUser arms the expired timer), but asking up front makes the common case immediate instead of
    // visibly delayed. Never during the redirect callback: this effect runs before OidcProvider finishes
    // exchanging the code, so a renew here would race it on the *old* stored user — and an invalid_grant
    // on that one would call removeUser and wipe the session just signed into.
    if (!hasAuthParams()) {
      void (async () => {
        const user = await manager.getUser();
        if (!cancelled && user?.expired) request('expired');
      })();
    }

    return () => {
      cancelled = true;
      clearTimeout(retry);
      offLoaded();
      offUnloaded();
      offExpired();
      offRenewError();
      setReauthHandler(null);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [manager]);

  const value = useMemo<AuthState>(
    () => ({
      // Order matters. isAuthenticated first, so a background renew can't drop the tree under RequireAuth
      // and take the in-memory state below it with it (a paused Pomodoro reads as running on remount).
      // Then 'stalled' is the escape hatch, and anything else with a stored user or a renew in flight
      // counts as loading rather than unauthenticated.
      status: oidc.isAuthenticated
        ? 'authenticated'
        : phase === 'stalled'
          ? 'unauthenticated'
          : oidc.user || oidc.isLoading || phase === 'renewing'
            ? 'loading'
            : 'unauthenticated',
      user: oidc.user
        ? { sub: oidc.user.profile.sub, email: oidc.user.profile.email ?? null }
        : null,
      error: hideError ? null : (oidc.error?.message ?? null),
      // Asking for a sign-in ends the quiet window: from here on the user is acting, so anything that
      // goes wrong is theirs to see. Without this an offline signinRedirect leaves a button that just
      // looks dead. (Clearing it on userUnloaded instead would un-hide the expiry we're hiding — that
      // event *is* the teardown.)
      signIn: () => {
        setHideError(false);
        void oidc.signinRedirect();
      },
      signOut: () => void oidc.signoutRedirect(),
    }),
    [oidc, phase, hideError],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}
