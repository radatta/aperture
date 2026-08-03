// Inline SVG line icons — dependency-free and font-independent (emoji/arrow glyphs tofu in some
// runtimes; these always render). Stroke follows currentColor so tone utilities apply.
import type { SVGProps } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

// Morning — sunrise over a horizon.
export function SunriseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v3M5.6 9.6 7 11M18.4 9.6 17 11M3 15h3M18 15h3" />
      <path d="M8 15a4 4 0 0 1 8 0" />
      <path d="M2 19h20" />
    </Svg>
  );
}

// Daytime — sun high.
export function SunIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" />
    </Svg>
  );
}

// Night — crescent moon.
export function MoonIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4 7 7 0 1 0 20 14.5Z" />
    </Svg>
  );
}

export function ChevronLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 5l-7 7 7 7" />
    </Svg>
  );
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 5l7 7-7 7" />
    </Svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}
