import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Link } from 'react-router';
import { cx } from '../../lib/cx';

type Variant = 'primary' | 'gold' | 'ghost' | 'quiet';
type Size = 'sm' | 'md';

// text-surface as the on-accent color is deliberate: surface is always the opposite lightness of
// the accent, so it stays readable in both themes without a second token.
const variantClass: Record<Variant, string> = {
  primary: 'bg-teal text-surface hover:opacity-90',
  gold: 'bg-gold text-surface hover:opacity-90',
  ghost: 'bg-transparent text-ink border border-line hover:bg-panel-2 hover:border-line-strong',
  // No border, no fill — for secondary actions that shouldn't add a box to a dense row.
  quiet: 'bg-transparent text-ink-muted hover:bg-panel-2 hover:text-ink',
};
const sizeClass: Record<Size, string> = {
  sm: 'text-sm px-3 py-1.5',
  md: 'text-sm px-4 py-2',
};

const base = 'inline-flex items-center justify-center rounded-xl font-medium transition';

function recipe(variant: Variant, size: Size, className?: string) {
  return cx(
    base,
    'disabled:opacity-50 disabled:pointer-events-none',
    variantClass[variant],
    sizeClass[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  // React 19 takes ref as a plain prop; disclosure triggers need one to take focus back on close.
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={recipe(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

// A route link that reads as a button. Empty states hand you the next action, and that action is
// usually "go to the deep view" — which must stay a real anchor (middle-click, open in new tab)
// rather than a button with an onClick navigate.
export function ButtonLink({
  to,
  variant = 'ghost',
  size = 'md',
  className,
  children,
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={recipe(variant, size, className)}>
      {children}
    </Link>
  );
}
