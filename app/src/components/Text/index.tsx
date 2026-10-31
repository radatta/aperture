import type { ReactNode, Ref } from 'react';
import { cx } from '../../lib/cx';

type Tone = 'ink' | 'muted' | 'subtle' | 'gold' | 'teal' | 'danger';
type Size = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl';
type Weight = 'normal' | 'medium' | 'semibold';

const toneClass: Record<Tone, string> = {
  ink: 'text-ink',
  muted: 'text-ink-muted',
  subtle: 'text-ink-subtle',
  gold: 'text-gold',
  teal: 'text-teal',
  danger: 'text-danger',
};
const sizeClass: Record<Size, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
  '3xl': 'text-3xl',
};
const weightClass: Record<Weight, string> = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
};

export interface TextProps {
  as?: 'span' | 'p' | 'div' | 'label' | 'h1' | 'h2' | 'h3';
  tone?: Tone;
  size?: Size;
  weight?: Weight;
  tabular?: boolean; // tabular-nums for data that shouldn't jitter
  id?: string; // so an aria-describedby/labelledby target can be a Text node
  ref?: Ref<HTMLElement>; // a focus target (a page heading as the last resort)
  tabIndex?: number;
  'aria-live'?: 'polite';
  'aria-hidden'?: boolean;
  'data-focus-rescue'?: true; // the page's last-resort focus target (modules/flux/focus.ts tells it apart)
  className?: string;
  children: ReactNode;
}

// The one text primitive — inline styling goes through here (tone/size/weight), never one-off spans.
export function Text({
  as: Tag = 'span',
  tone = 'ink',
  size = 'base',
  weight = 'normal',
  tabular = false,
  id,
  ref,
  tabIndex,
  className,
  children,
  ...aria
}: TextProps) {
  return (
    <Tag
      id={id}
      ref={ref as Ref<never>} // Tag is a union of elements; every one is an HTMLElement
      tabIndex={tabIndex}
      {...aria}
      className={cx(
        toneClass[tone],
        sizeClass[size],
        weightClass[weight],
        tabular && 'tabular-nums',
        className,
      )}
    >
      {children}
    </Tag>
  );
}
