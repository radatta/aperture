import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { capTimes, COACH_PARAMS, fmtMonthShortDay, progressWeeks } from '@aperture/shared';
import type { CapTimes, ProblemRecord, ProgressWeek, Rate } from '@aperture/shared';
import { Text } from '../../components/Text';
import { useWide } from '../../lib/useWide';
import { MIN_PCT } from './patternsHelpers';

// Trends (docs/areas/recruiting/coach.md → The Progress tab): four inline-SVG charts over live tries, the last 12
// ISO weeks. A rate bar under MIN_PCT tries is drawn hollow, so one lucky week doesn't read like a full one. Each
// chart's aria-label lists its values; each mark's <title> is its hover tooltip. Per pattern lives on Patterns.

// The drawing's width: wide on a desktop card, narrower on a phone so the 11px labels stay near 11px on screen.
const WIDE_W = 540;
const NARROW_W = 380;
const ChartW = createContext(WIDE_W);
const H = 180;
const L = 38; // left gutter for the y labels ("100%" fits)
const B = 22; // bottom gutter for the week labels
const T = 16;
const BW = 22;
const xOf = (i: number, n: number, W: number) => L + (i + 0.5) * ((W - L - 4) / n);
const weekLabel = (w: ProgressWeek) => fmtMonthShortDay(w.start);

function XAxis({ weeks }: { weeks: ProgressWeek[] }) {
  const W = useContext(ChartW);
  return weeks.map((w, i) =>
    i % (W < WIDE_W ? 3 : 2) === 0 || i === weeks.length - 1 ? (
      <text
        key={w.week}
        x={xOf(i, weeks.length, W)}
        y={H - 6}
        textAnchor="middle"
        className="fill-ink-muted text-[11px]"
      >
        {weekLabel(w)}
      </text>
    ) : null,
  );
}
function Grid({
  ticks,
  y,
  fmt,
}: {
  ticks: number[];
  y: (v: number) => number;
  fmt: (v: number) => string;
}) {
  const W = useContext(ChartW);
  return ticks.map((v) => (
    <g key={v}>
      <line x1={L} x2={W} y1={y(v)} y2={y(v)} className="stroke-line" />
      <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-ink-muted text-[11px]">
        {fmt(v)}
      </text>
    </g>
  ));
}

function ProblemsAWeek({ weeks }: { weeks: ProgressWeek[] }) {
  const W = useContext(ChartW);
  const totals = weeks.map((w) => w.clean + w.solved + w.failed);
  const max = Math.max(4, ...totals);
  const step = Math.ceil(max / 2);
  const top = step * 2;
  const y = (v: number) => H - B - (v / top) * (H - B - T);
  const label = `Problems a week: ${weeks
    .map((w) => `${weekLabel(w)} ${w.clean} clean, ${w.solved} solved, ${w.failed} not yet`)
    .join('; ')}`;
  const n = weeks.length;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className="h-auto w-full overflow-visible"
    >
      <Grid ticks={[0, step, top]} y={y} fmt={String} />
      {weeks.map((w, i) => {
        const x = xOf(i, n, W) - BW / 2;
        let base = 0;
        const segs: [number, string][] = [
          [w.clean, 'fill-teal'],
          [w.solved, 'fill-gold'],
          [w.failed, 'fill-none stroke-gold'],
        ];
        const tip = `${weekLabel(w)}: ${w.clean} clean, ${w.solved} solved, ${w.failed} not yet`;
        return (
          <g key={w.week}>
            {segs.map(([v, cls], k) => {
              if (!v) return null;
              const y0 = y(base);
              const y1 = y(base + v);
              base += v;
              const hollow = cls.includes('stroke');
              return (
                <rect
                  key={k}
                  x={x + (hollow ? 0.75 : 0)}
                  y={y1 + 1}
                  width={BW - (hollow ? 1.5 : 0)}
                  height={Math.max(0, y0 - y1 - 2)}
                  rx={3}
                  strokeWidth={hollow ? 1.5 : undefined}
                  className={cls}
                >
                  <title>{tip}</title>
                </rect>
              );
            })}
            {i === n - 1 && base > 0 && (
              <text
                x={xOf(i, n, W)}
                y={y(base) - 6}
                textAnchor="middle"
                className="fill-ink text-[11px] font-semibold"
              >
                {base}
              </text>
            )}
          </g>
        );
      })}
      <XAxis weeks={weeks} />
    </svg>
  );
}

function RateBars({
  weeks,
  pick,
  what,
}: {
  weeks: ProgressWeek[];
  pick: (w: ProgressWeek) => Rate;
  what: string;
}) {
  const W = useContext(ChartW);
  const y = (v: number) => H - B - v * (H - B - T);
  const n = weeks.length;
  const label = `${what} a week: ${weeks
    .map((w) => `${weekLabel(w)} ${pick(w).hit} of ${pick(w).of}`)
    .join(', ')}`;
  const lastWith = weeks.reduce((k, w, i) => (pick(w).of ? i : k), -1);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className="h-auto w-full overflow-visible"
    >
      <Grid ticks={[0, 0.5, 1]} y={y} fmt={(v) => `${v * 100}%`} />
      {weeks.map((w, i) => {
        const r = pick(w);
        if (!r.of) return null;
        const hollow = r.of < MIN_PCT;
        const t = y(r.hit / r.of);
        return (
          <g key={w.week}>
            <rect
              x={xOf(i, n, W) - BW / 2 + (hollow ? 0.75 : 0)}
              y={t}
              width={BW - (hollow ? 1.5 : 0)}
              height={Math.max(2, y(0) - t)}
              rx={3}
              strokeWidth={hollow ? 1.5 : undefined}
              className={hollow ? 'fill-none stroke-teal' : 'fill-teal'}
            >
              <title>{`${weekLabel(w)}: ${r.hit} of ${r.of} clean`}</title>
            </rect>
            {i === lastWith && (
              <text
                x={xOf(i, n, W)}
                y={t - 6}
                textAnchor="middle"
                className="fill-ink text-[11px] font-semibold"
              >
                {r.hit} of {r.of}
              </text>
            )}
          </g>
        );
      })}
      <XAxis weeks={weeks} />
    </svg>
  );
}

function CapChart({ c }: { c: CapTimes }) {
  const W = useContext(ChartW);
  const rowH = 24;
  const lx = 70;
  const max = Math.max(1, ...c.bins.map((b) => b.n));
  const bw = W - lx - 40;
  const firstOver = c.bins.findIndex((b) => b.over);
  const yOf = (i: number) => 4 + i * rowH + (i >= firstOver ? 10 : 0);
  const ruleY = yOf(firstOver) - 5;
  const label = `Minutes a try against the ${c.capMin} minute cap: ${c.bins.map((b) => `${b.label} ${b.n}`).join(', ')}`;
  return (
    <svg
      viewBox={`0 0 ${W} ${yOf(c.bins.length - 1) + rowH + 4}`}
      role="img"
      aria-label={label}
      className="h-auto w-full overflow-visible"
    >
      {c.bins.map((b, i) => (
        <g key={b.label}>
          <text x={lx - 8} y={yOf(i) + 15} textAnchor="end" className="fill-ink-muted text-[11px]">
            {b.label}
          </text>
          {b.n > 0 && (
            <rect
              x={lx}
              y={yOf(i) + 4}
              width={(b.n / max) * bw}
              height={15}
              rx={3}
              className={b.over ? 'fill-gold' : 'fill-teal'}
            >
              <title>{`${b.label}: ${b.n} ${b.n === 1 ? 'try' : 'tries'}`}</title>
            </rect>
          )}
          <text
            x={lx + (b.n / max) * bw + 6}
            y={yOf(i) + 15}
            className="fill-ink-muted text-[11px]"
          >
            {b.n}
          </text>
        </g>
      ))}
      <line
        x1={8}
        x2={W}
        y1={ruleY}
        y2={ruleY}
        strokeDasharray="4 3"
        className="stroke-ink-muted"
      />
      <text x={W} y={ruleY - 4} textAnchor="end" className="fill-ink text-[11px] font-semibold">
        {c.capMin} min cap
      </text>
    </svg>
  );
}

function ChartCard({
  title,
  note,
  children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-panel p-3">
      <Text as="h3" size="sm" weight="semibold">
        {title}
      </Text>
      {note && (
        <Text as="p" size="xs" tone="muted">
          {note}
        </Text>
      )}
      {children}
    </section>
  );
}
const Swatch = ({ cls }: { cls: string }) => (
  <span aria-hidden="true" className={`inline-block size-3 rounded-[3px] ${cls}`} />
);

export function ProgressTrends({
  records,
  today,
}: {
  records: readonly ProblemRecord[];
  today: string;
}) {
  const weeks = progressWeeks(records, today);
  const active = weeks.filter((w) => w.clean + w.solved + w.failed > 0).length;
  const firsts = weeks.some((w) => w.firstTry.of > 0);
  const resolves = weeks.some((w) => w.resolve.of > 0);
  const cap = capTimes(records, today);
  const narrow = !useWide('(min-width: 640px)');
  return (
    <ChartW value={narrow ? NARROW_W : WIDE_W}>
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title="Problems a week">
          {active < 2 ? (
            <Text size="sm" tone="muted">
              Two weeks of practice draws this. So far:{' '}
              {weeks.reduce((n, w) => n + w.clean + w.solved + w.failed, 0)} tries in the last 12
              weeks.
            </Text>
          ) : (
            <>
              <ul aria-label="Key" className="flex flex-wrap gap-3">
                {(
                  [
                    ['bg-teal', 'Clean'],
                    ['bg-gold', 'Solved'],
                    ['border-[1.5px] border-gold', 'Not yet'],
                  ] as const
                ).map(([c, l]) => (
                  <li key={l} className="flex items-center gap-1.5">
                    <Swatch cls={c} />
                    <Text size="xs" tone="muted">
                      {l}
                    </Text>
                  </li>
                ))}
              </ul>
              <ProblemsAWeek weeks={weeks} />
            </>
          )}
        </ChartCard>
        <ChartCard
          title={`Time against the ${cap.capMin} min cap`}
          note={
            cap.timed ? (
              <>
                <span className="font-semibold text-ink">
                  {cap.inside} of {cap.timed}
                </span>{' '}
                inside {cap.capMin} min · median {cap.medianMin} min
              </>
            ) : undefined
          }
        >
          {cap.timed ? (
            <CapChart c={cap} />
          ) : (
            <Text size="sm" tone="muted">
              Timed tries draw this: a sitting, or a logged attempt with minutes.
            </Text>
          )}
        </ChartCard>
        <ChartCard
          title="First tries that were clean"
          note={
            firsts
              ? `All patterns. A hollow bar is a week under ${MIN_PCT} first tries.`
              : undefined
          }
        >
          {firsts ? (
            <RateBars weeks={weeks} pick={(w) => w.firstTry} what="First tries clean" />
          ) : (
            <Text size="sm" tone="muted">
              No first tries in the last 12 weeks.
            </Text>
          )}
        </ChartCard>
        <ChartCard title="Re-solves that were clean">
          {resolves ? (
            <RateBars weeks={weeks} pick={(w) => w.resolve} what="Re-solves clean" />
          ) : (
            <Text size="sm" tone="muted">
              No re-solves yet. The first comes due {COACH_PARAMS.gaps.peeked[0]} to{' '}
              {COACH_PARAMS.gaps.clean[0]} days after a try.
            </Text>
          )}
        </ChartCard>
      </div>
    </ChartW>
  );
}
