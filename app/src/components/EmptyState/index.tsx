import type { ReactNode } from 'react';
import { LoadError } from '../LoadError';
import { Text } from '../Text';

export interface EmptyStateProps {
  // True while the query that would fill this list is still in flight. React Query hooks default
  // `data` to [], so a component that branches on `list.length === 0` alone will confidently assert
  // "Backlog is clear" during the very first render and then swap the copy underneath the reader.
  pending?: boolean;
  error?: boolean;
  onRetry?: () => void; // the failed query's refetch, shown as Retry beside the error
  title: string;
  children?: ReactNode; // the guidance line: what to do about it
  action?: ReactNode;
}

// One place that knows the three states a list can be in. The empty states in this app got louder
// (a headline, a sentence of guidance, sometimes a button), which made asserting emptiness too
// early correspondingly worse — so the guard lives here instead of being re-remembered per site.
export function EmptyState({ pending, error, onRetry, title, children, action }: EmptyStateProps) {
  if (pending)
    return (
      <Text tone="muted" size="sm">
        Loading…
      </Text>
    );
  if (error)
    return (
      <LoadError onRetry={onRetry}>
        Couldn&apos;t load this. Check your connection and try again.
      </LoadError>
    );

  return (
    <div className="flex flex-col items-start gap-2">
      <Text>{title}</Text>
      {children && (
        <Text tone="muted" size="sm">
          {children}
        </Text>
      )}
      {action}
    </div>
  );
}
