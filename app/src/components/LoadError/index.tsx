import type { ReactNode } from 'react';
import { Button } from '../Button';
import { Text } from '../Text';

export interface LoadErrorProps {
  children: ReactNode; // what failed, in the user's words: "Couldn’t load categories."
  onRetry?: () => void; // the query's refetch — a read that exhausted its retries needs a visible way back
  size?: 'xs' | 'sm';
}

// The one inline "a read failed" line. A failed read never collapses to an empty list or a default: it says
// what didn't load, as an alert, with a Retry (docs/product/CONVENTIONS.md → Failed reads).
export function LoadError({ children, onRetry, size = 'sm' }: LoadErrorProps) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2">
      <Text tone="danger" size={size}>
        {children}
      </Text>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
