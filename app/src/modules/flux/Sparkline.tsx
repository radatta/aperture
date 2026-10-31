// A small trend line for one exercise (History, D50) — hand-drawn SVG, no chart library (HoldRing's
// precedent). One series, so no legend: the stat tile's label names it. Marks follow the dataviz
// specs: a 2px round line, an end dot (r 4) with a 2px surface ring, the target as a solid hairline.
// Every point keeps a native tooltip on a hit target larger than the mark; the list below is the table.

export interface SparkPoint {
  readonly value: number;
  readonly label: string; // "Oct 20 · 52°" — the tooltip
}

const W = 240;
const H = 48;
const PAD = 6;

export function Sparkline({
  points,
  target,
  label,
}: {
  points: readonly SparkPoint[];
  target?: number;
  label: string; // the accessible name: what's plotted, and how it's going
}) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const lo = Math.min(...values, target ?? Infinity);
  const hi = Math.max(...values, target ?? -Infinity);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / (points.length - 1);
  const y = (v: number) => H - PAD - ((v - lo) * (H - 2 * PAD)) / span;
  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join('');
  const last = points.length - 1;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-12 w-full overflow-visible"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {target !== undefined && (
        <line
          x1={PAD}
          x2={W - PAD}
          y1={y(target)}
          y2={y(target)}
          stroke="var(--line-strong)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke="var(--teal)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={x(last)}
        cy={y(points[last]!.value)}
        r={4}
        fill="var(--teal)"
        stroke="var(--surface)"
        strokeWidth={2}
      />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.value)} r={10} fill="transparent">
          <title>{p.label}</title>
        </circle>
      ))}
    </svg>
  );
}
