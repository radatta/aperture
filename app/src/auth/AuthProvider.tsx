import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { AuthProvider as OidcProvider } from 'react-oidc-context';
import { API_MODE } from '../shared/env';
import { OidcBridge } from './OidcBridge';
import { AuthContext } from './auth-context';
import type { AuthState } from './auth-context';
import { setAuthToken } from './tokenStore';
import { getUserManager } from './userManager';

// Auth has two shapes behind one `useAuth()`:
//   - stub mode (local dev): bypassed — a fixed 'local' identity, no Cognito, no token. The app runs
//     exactly as it did before auth existed.
//   - http mode (deployed): real Cognito Hosted UI via react-oidc-context (PKCE, no secret), bridged
//     into our uniform AuthState, with the access token pushed to the token store for httpClient.
export function AuthProvider({ children }: { children: ReactNode }) {
  if (API_MODE !== 'http') return <BypassProvider>{children}</BypassProvider>;

  // One manager, handed to both: the context wraps it for the app, and the bridge calls it raw (the
  // wrapper swallows rejections into `null`, which would hide why a renew failed).
  const manager = getUserManager();
  return (
    <OidcProvider
      userManager={manager}
      onSigninCallback={() => window.history.replaceState({}, '', window.location.pathname)}
    >
      <OidcBridge manager={manager}>{children}</OidcBridge>
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
