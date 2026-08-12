import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { AuthProvider as OidcProvider, useAuth as useOidc } from 'react-oidc-context';
import { API_MODE, COGNITO_AUTHORITY, COGNITO_CLIENT_ID } from '../shared/env';
import { AuthContext } from './auth-context';
import type { AuthState } from './auth-context';
import { setAuthToken } from './tokenStore';

// Auth has two shapes behind one `useAuth()`:
//   - stub mode (local dev): bypassed — a fixed 'local' identity, no Cognito, no token. The app runs
//     exactly as it did before auth existed.
//   - http mode (deployed): real Cognito Hosted UI via react-oidc-context (PKCE, no secret), bridged
//     into our uniform AuthState, with the access token pushed to the token store for httpClient.
export function AuthProvider({ children }: { children: ReactNode }) {
  if (API_MODE !== 'http') return <BypassProvider>{children}</BypassProvider>;

  return (
    <OidcProvider
      authority={COGNITO_AUTHORITY}
      client_id={COGNITO_CLIENT_ID}
      redirect_uri={window.location.origin}
      post_logout_redirect_uri={window.location.origin}
      response_type="code"
      scope="openid email"
      automaticSilentRenew
      onSigninCallback={() => window.history.replaceState({}, '', window.location.pathname)}
    >
      <OidcBridge>{children}</OidcBridge>
    </OidcProvider>
  );
}

function BypassProvider({ children }: { children: ReactNode }) {
  useEffect(() => setAuthToken(null), []); // no token in stub mode — the stub never hits the network
  const value = useMemo<AuthState>(
    () => ({
      status: 'authenticated',
      user: { sub: 'local', email: 'local@aperture.dev' },
      error: null,
      signIn: () => {},
      signOut: () => {},
    }),
    [],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}

function OidcBridge({ children }: { children: ReactNode }) {
  const oidc = useOidc();

  // Mirror the token during render, not in an effect: child effects fire before parent effects, so an
  // effect here would let a child's first query go out token-less. Writing the module store in render
  // is idempotent and ensures the token is set before anything below mounts.
  setAuthToken(oidc.user?.access_token ?? null);

  const value = useMemo<AuthState>(
    () => ({
      status: oidc.isLoading
        ? 'loading'
        : oidc.isAuthenticated
          ? 'authenticated'
          : 'unauthenticated',
      user: oidc.user
        ? { sub: oidc.user.profile.sub, email: oidc.user.profile.email ?? null }
        : null,
      error: oidc.error?.message ?? null,
      signIn: () => void oidc.signinRedirect(),
      signOut: () => void oidc.signoutRedirect(),
    }),
    [oidc],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}
