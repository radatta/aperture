import type { ReactNode } from 'react';
import { Button } from '../components/Button';
import { Text } from '../components/Text';
import { useAuth } from './auth-context';

// Gates the whole app on authentication. Stub mode is always authenticated (bypass), so this is a
// pass-through locally; in http mode it shows the sign-in screen until Cognito returns an identity.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, error, signIn } = useAuth();

  if (status === 'authenticated') return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface text-ink">
      <div className="flex w-80 max-w-full flex-col items-center gap-4 rounded-2xl border border-line bg-panel p-8 text-center shadow-lg">
        <Text as="h1" size="2xl" weight="semibold">
          Aperture
        </Text>
        {status === 'loading' ? (
          <Text size="sm" tone="muted">
            Signing you in…
          </Text>
        ) : (
          <>
            <Text size="sm" tone="muted">
              Plan the morning, do the day, reflect at night.
            </Text>
            <Button onClick={signIn}>Sign in</Button>
            {error && (
              <Text size="xs" tone="danger">
                {error}
              </Text>
            )}
          </>
        )}
      </div>
    </div>
  );
}
