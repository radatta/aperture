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

// Quick add's Review — "let the model read this first" (a four-point sparkle, the common AI mark).
export function SparkleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3Z" />
      <path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
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

// Flux — the stage's back link.
export function ArrowLeftIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </Svg>
  );
}

// Flux voice cues on / off — a speaker with sound waves, or struck through.
export function VolumeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M11 5 6 9H3v6h3l5 4Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </Svg>
  );
}

export function VolumeOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M11 5 6 9H3v6h3l5 4Z" />
      <path d="m16 9 5 6M21 9l-5 6" />
    </Svg>
  );
}

// Flux's disclaimer — a shield with a check.
export function ShieldCheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6Z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

// A caution — a triangle with an exclamation mark.
export function WarningIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </Svg>
  );
}

export function InfoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4.5M12 8h.01" />
    </Svg>
  );
}

// A finished set — a check in a circle.
export function CheckCircleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Svg>
  );
}

export function PlayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 4.5v15l12-7.5Z" />
    </Svg>
  );
}

// "Again" — a counter-clockwise arrow.
export function RotateIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  );
}

// Flux category marks: range of motion (a pulse), stretches (a four-way move), sensorimotor (a target).
export function ActivityIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </Svg>
  );
}

export function MoveIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v18M3 12h18" />
      <path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
    </Svg>
  );
}

export function TargetIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </Svg>
  );
}
