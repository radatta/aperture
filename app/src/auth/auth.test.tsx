import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from './AuthProvider';
import { RequireAuth } from './RequireAuth';
import { useAuth } from './auth-context';

// API_MODE defaults to 'stub' under vitest (no VITE_API_MODE), so AuthProvider takes the bypass path —
// no real Cognito is touched. (The http path is proven server-side by the JWT verify tests.)
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
