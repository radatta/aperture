import type { HTMLAttributes, Ref } from 'react';
import { cx } from '../../lib/cx';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  raised?: boolean;
  ref?: Ref<HTMLDivElement>; // React 19: a plain prop — the sort queue moves focus between cards
}

export function Card({ raised = false, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cx(
        'rounded-2xl border border-line p-4',
        raised ? 'bg-panel-2' : 'bg-panel',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
