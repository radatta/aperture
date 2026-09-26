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

// Capture's commit affordance — a paper-plane, the one universally-read "send this" mark.
export function SendIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-8.5L2 8.5 21 3Z" />
    </Svg>
  );
}

// Overflow — the secondary actions a row keeps out of sight until asked.
export function MoreIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

// Inline-edit cue on log rows — nothing else says "this line is editable".
export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    </Svg>
  );
}

export function ArrowUpIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </Svg>
  );
}

export function ArrowDownIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </Svg>
  );
}

// The always-reachable focus starter in the dock.
export function TimerIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9.5V13l2.5 1.5M9.5 2h5" />
    </Svg>
  );
}

export function PlusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

// Notes — a page with lines of text, the "there's more written here" mark.
export function NoteIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 3h9l4 4v14H6Z" />
      <path d="M9.5 11h6M9.5 14.5h6M9.5 18h3.5" />
    </Svg>
  );
}

// Attachments — a paperclip, the universal "a file rides along" mark.
export function PaperclipIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 11.5 12 20.5a5.5 5.5 0 0 1-7.8-7.8l9-9a3.5 3.5 0 0 1 5 5l-9 9a1.5 1.5 0 0 1-2.2-2.2l8.3-8.3" />
    </Svg>
  );
}
