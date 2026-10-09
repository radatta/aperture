import { Text } from '../../components/Text';
import type { RingTone } from './readout';

// A circular progress ring for hold/countdown timers (flux-track's HoldRing, same geometry). progress
// is 0..1. Tones: teal = getting there, gold = holding / done, warn = drifting.
const STROKE: Record<RingTone, string> = {
  teal: 'var(--teal)',
  gold: 'var(--gold)',
  warn: 'var(--danger)',
};

export function HoldRing({
  progress,
  label,
  sublabel,
  tone = 'teal',
  small = false,
}: {
  progress: number;
  label: string;
  sublabel?: string;
  tone?: RingTone;
  small?: boolean; // the overlay on the video
}) {
  const size = small ? 72 : 132;
  const stroke = small ? 6 : 10;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, progress));

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <title>Hold progress</title>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line-strong)"
          strokeOpacity={0.35}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={STROKE[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - clamped)}
          className="transition-[stroke-dashoffset] duration-100 motion-reduce:transition-none"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <Text size={small ? 'lg' : '3xl'} weight="semibold" tabular>
          {label}
        </Text>
        {sublabel && (
          <Text size="xs" tone="muted" className="mt-0.5">
            {sublabel}
          </Text>
        )}
      </div>
    </div>
  );
}
