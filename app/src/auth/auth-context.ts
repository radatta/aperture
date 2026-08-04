import { createContext, useContext } from 'react';

export interface AuthUser {
  sub: string; // the identity that scopes every item (Cognito sub, or 'local' in stub mode)
  email: string | null;
}

export interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated';
  user: AuthUser | null;
  error: string | null;
  signIn: () => void;
  signOut: () => void;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
