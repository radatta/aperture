import type { ButtonHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';

type Variant = 'primary' | 'gold' | 'ghost';
type Size = 'sm' | 'md';

// text-surface as the on-accent color is deliberate: surface is always the opposite lightness of
// the accent, so it stays readable in both themes without a second token.
const variantClass: Record<Variant, string> = {
  primary: 'bg-teal text-surface hover:opacity-90',
  gold: 'bg-gold text-surface hover:opacity-90',
  ghost: 'bg-transparent text-ink border border-line hover:bg-panel-2',
};
const sizeClass: Record<Size, string> = {
  sm: 'text-sm px-3 py-1.5',
  md: 'text-sm px-4 py-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
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
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center rounded-xl font-medium transition',
        'disabled:opacity-50 disabled:pointer-events-none',
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
