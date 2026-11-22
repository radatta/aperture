import { useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { fmtPastDay, PATTERN_NAMES, PROGRESS_STAGES, sittingProblemUrl } from '@aperture/shared';
import type { Coverage, PatternCoverage, PatternId, ProblemCell } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { useWide } from '../../lib/useWide';
import { cx } from '../../lib/cx';
import { patternCardName, reSolveText, STATE_LABEL, triesText } from './progressHelpers';

// The Progress map (docs/areas/recruiting/coach.md → The Progress tab): the roadmap's 18 patterns in our own five
// stages, each a column (one under another on a phone) with its meter and a card per pattern; a card's squares are
// its problems in list order. A card opens its problems in a panel: under all five stages on a wide screen, under
// its own stage on a narrow one. Left only lists what's left instead. Shape and fill carry each state, never colour
// alone; a card's accessible name says it all in words.

export interface MapProps {
  cov: Coverage;
  today: string;
  focus: PatternId | null;
  open: PatternId | null;
  left: boolean;
  premiumMarked: boolean; // Premium can't be picked: its untried problems show dotted and labelled
  onOpen: (p: PatternId | null) => void;
  onLeft: (on: boolean) => void;
}

export function ProgressMap({
  cov,
  today,
  focus,
  open,
  left,
  premiumMarked,
  onOpen,
  onLeft,
}: MapProps) {
  const wide = useWide();
  const cards = useRef(new Map<PatternId, HTMLButtonElement>());
  const byPattern = new Map(cov.patterns.map((p) => [p.pattern, p]));
  const close = () => {
    const p = open;
    onOpen(null);
    if (p) cards.current.get(p)?.focus();
  };
  const panel = (
    <Panel
      cov={cov}
      open={open ? (byPattern.get(open) ?? null) : null}
      left={left}
      today={today}
      focus={focus}
      premiumMarked={premiumMarked}
      onClose={close}
    />
  );
  const openStage = PROGRESS_STAGES.find((s) => open && s.patterns.includes(open));
  const showPanel = !!open || left;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Legend premiumMarked={premiumMarked} />
        <button
          type="button"
          aria-pressed={left}
          onClick={() => onLeft(!left)}
          className={cx(
            'rounded-full border px-3 py-1 text-sm transition',
            left
              ? 'border-teal bg-teal-soft text-ink'
              : 'border-line-strong text-ink-muted hover:text-ink',
          )}
        >
          Left only
        </button>
      </div>
      <div className="grid gap-4 lg:grid-cols-5 lg:gap-3">
        {PROGRESS_STAGES.map((stage) => {
          const pats = stage.patterns.map((p) => byPattern.get(p)!);
          const done = pats.reduce((n, p) => n + p.done, 0);
          const total = pats.reduce((n, p) => n + p.total, 0);
          const headId = `stage-${stage.id}`;
          return (
            <section
              key={stage.id}
              aria-labelledby={headId}
              className="flex min-w-0 flex-col gap-2"
            >
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 lg:max-xl:min-h-8">
                  <Text
                    as="h3"
                    id={headId}
                    size="xs"
                    weight="semibold"
                    tone="muted"
                    className="uppercase tracking-wider"
                  >
                    {stage.label}
                  </Text>
                  <Text size="xs" tone="muted" tabular className="whitespace-nowrap">
                    {done} of {total}
                  </Text>
                </div>
                <div
                  role="meter"
                  aria-label={`${stage.label}: ${done} of ${total} done`}
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={done}
                  className="h-1.5 overflow-hidden rounded-full bg-panel-2 shadow-[inset_0_0_0_1px_var(--line)]"
                >
                  <div
                    className="h-full rounded-full bg-teal"
                    style={{ width: `${(done / total) * 100}%` }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                {pats.map((p) => (
                  <PatternCard
                    key={p.pattern}
                    p={p}
                    focus={focus === p.pattern}
                    selected={open === p.pattern}
                    premiumMarked={premiumMarked}
                    onClick={() => onOpen(open === p.pattern ? null : p.pattern)}
                    ref={(el) => {
                      if (el) cards.current.set(p.pattern, el);
                      else cards.current.delete(p.pattern);
                    }}
                  />
                ))}
              </div>
              {!wide && open && openStage?.id === stage.id && panel}
            </section>
          );
        })}
      </div>
      {(wide || !open) && showPanel && panel}
      {cov.offList.length > 0 && <OffList cov={cov} today={today} />}
    </div>
  );
}

function Legend({ premiumMarked }: { premiumMarked: boolean }) {
  const items: [string, string][] = [
    ['clean', 'Clean'],
    ['solved', 'Solved'],
    ['earlier', 'Solved before'],
    ['peeked', 'Peeked'],
    ['not-yet', 'Not yet'],
    ['untried', 'Not tried'],
    ...(premiumMarked ? ([['premium', 'Premium']] as [string, string][]) : []),
  ];
  return (
    <ul aria-label="Key" className="flex flex-wrap gap-x-3 gap-y-1">
      {items.map(([k, label]) => (
        <li key={k} className="flex items-center gap-1.5">
          <Square kind={k} />
          <Text size="xs" tone="muted">
            {label}
          </Text>
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <Square kind="untried" due />
        <Text size="xs" tone="muted">
          Re-solve due
        </Text>
      </li>
    </ul>
  );
}

const SQUARE: Record<string, string> = {
  untried: 'border-[1.5px] border-line-strong',
  premium: 'border-[1.5px] border-dotted border-line-strong',
  earlier: 'bg-ink-subtle',
  clean: 'bg-teal',
  solved: 'bg-gold',
  'not-yet': 'border-[1.5px] border-gold',
  peeked:
    'border-[1.5px] border-gold after:absolute after:inset-[2px] after:rounded-full after:bg-gold',
};
const BORDERED = new Set(['untried', 'premium', 'not-yet', 'peeked']);
const DUE_DOT =
  'before:absolute before:left-1/2 before:size-[2px] before:-translate-x-1/2 before:rounded-full before:bg-ink';
export function Square({
  kind,
  due = false,
  small = false,
}: {
  kind: string;
  due?: boolean;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-square={kind}
      className={cx(
        'relative inline-block shrink-0 rounded-[3px]',
        small ? 'size-2.5' : 'size-3',
        SQUARE[kind],
        // Re-solve due: a dot just under the square, inside the row gap — no outline, so the square keeps its size,
        // neighbours never merge, and each one counts (F397). `before:` because peeked's inner dot is `after:`. The
        // offset is from the padding box, so a bordered square's adds its 1.5px border: the same gap under every kind.
        due && DUE_DOT,
        due &&
          (BORDERED.has(kind) ? 'before:top-[calc(100%+2px)]' : 'before:top-[calc(100%+0.5px)]'),
      )}
    />
  );
}
const kindOf = (c: ProblemCell, premiumMarked: boolean) =>
  c.status.state === 'untried' && premiumMarked && c.problem.premium ? 'premium' : c.status.state;

function PatternCard({
  p,
  focus,
  selected,
  premiumMarked,
  onClick,
  ref,
}: {
  p: PatternCoverage;
  focus: boolean;
  selected: boolean;
  premiumMarked: boolean;
  onClick: () => void;
  ref: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-expanded={selected}
      aria-controls="progress-panel"
      aria-label={patternCardName(p, focus)}
      data-pattern={p.pattern}
      className={cx(
        'flex min-w-0 flex-col gap-1.5 rounded-xl border p-2.5 text-left transition',
        focus ? 'border-teal bg-teal-soft' : 'border-line bg-panel hover:border-line-strong',
        selected && 'shadow-[0_0_0_1px_var(--teal)]',
      )}
    >
      <span className="flex items-baseline justify-between gap-2">
        <Text size="sm" weight="semibold" className="min-w-0">
          {PATTERN_NAMES[p.pattern]}
        </Text>
        <Text size="xs" tone="muted" tabular className="whitespace-nowrap">
          {p.done}/{p.total}
        </Text>
      </span>
      {(focus || p.due > 0) && (
        <span className="flex flex-wrap gap-1">
          {focus && (
            <span className="rounded-full bg-teal px-1.5 text-xs font-semibold text-surface">
              Focus
            </span>
          )}
          {p.due > 0 && (
            <span className="rounded-full border border-ink-muted px-1.5 text-xs text-ink">
              {p.due} due
            </span>
          )}
        </span>
      )}
      <span aria-hidden="true" className="flex flex-wrap gap-[3px]">
        {p.problems.map((c) => (
          <Square
            key={c.problem.slug}
            kind={kindOf(c, premiumMarked)}
            due={!!c.status.dueSince}
            small
          />
        ))}
      </span>
    </button>
  );
}

// The opened pattern's problems, or (Left only) what's left: the open pattern's untried, else every pattern's.
function Panel({
  cov,
  open,
  left,
  today,
  focus,
  premiumMarked,
  onClose,
}: {
  cov: Coverage;
  open: PatternCoverage | null;
  left: boolean;
  today: string;
  focus: PatternId | null;
  premiumMarked: boolean;
  onClose: () => void;
}) {
  const groups = (open ? [open] : cov.patterns)
    .map((p) => ({
      p,
      cells: left ? p.problems.filter((c) => c.status.state === 'untried') : p.problems,
    }))
    .filter((g) => g.cells.length > 0);
  return (
    <div
      id="progress-panel"
      role="region"
      aria-label={open ? `${PATTERN_NAMES[open.pattern]} problems` : 'What’s left'}
      className="flex flex-col gap-3 rounded-2xl border border-teal bg-panel p-3 lg:p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Text as="h3" size="base" weight="semibold">
          {open ? PATTERN_NAMES[open.pattern] : 'What’s left'}
        </Text>
        {open && (
          <Text size="sm" tone="muted">
            {open.done} of {open.total} done
            {focus === open.pattern ? ' · the focus' : ''}
            {left ? ` · ${groups[0]?.cells.length ?? 0} left` : ''}
          </Text>
        )}
        {!open && (
          <Text size="sm" tone="muted">
            {cov.untried} not tried across the list
          </Text>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Link to="/recruiting/patterns" className="text-sm text-teal hover:underline">
            How it’s going on Patterns →
          </Link>
          {open && (
            <Button variant="quiet" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </span>
      </div>
      {groups.length === 0 ? (
        <Text size="sm" tone="muted">
          Nothing left to try here.
        </Text>
      ) : (
        groups.map((g) => (
          <div key={g.p.pattern} className="flex flex-col">
            {!open && (
              <h4 className="pt-1 text-sm font-semibold text-ink">{PATTERN_NAMES[g.p.pattern]}</h4>
            )}
            <ProblemList cells={g.cells} today={today} premiumMarked={premiumMarked} />
          </div>
        ))
      )}
    </div>
  );
}

const ROW =
  'lg:grid lg:grid-cols-[minmax(12rem,2fr)_5rem_6.5rem_7rem_7.5rem_minmax(0,1fr)_5.5rem] lg:items-baseline lg:gap-3';
function ProblemList({
  cells,
  today,
  premiumMarked,
}: {
  cells: ProblemCell[];
  today: string;
  premiumMarked: boolean;
}) {
  const back = useLocation().search;
  return (
    <div role="table" aria-label="Problems" className="flex flex-col">
      <div role="row" className={cx('hidden border-b border-line pb-1.5', ROW)}>
        {['Problem', 'Difficulty', 'Status', 'Tries', 'Last tried', 'Re-solve', 'Link'].map((h) => (
          <span
            key={h}
            role="columnheader"
            className={cx('text-xs text-ink-muted', h === 'Link' && 'sr-only')}
          >
            {h}
          </span>
        ))}
      </div>
      {cells.map((c) => {
        const r = c.record;
        const kind = kindOf(c, premiumMarked);
        const status = kind === 'premium' ? 'Premium, not tried' : STATE_LABEL[c.status.state];
        const reSolve = reSolveText(c.status, today);
        return (
          <div
            key={c.problem.slug}
            role="row"
            className={cx('flex flex-col gap-0.5 border-b border-line py-2 last:border-b-0', ROW)}
          >
            <span role="cell" className="flex min-w-0 items-baseline gap-2">
              <span className="translate-y-px">
                <Square kind={kind} due={!!c.status.dueSince} />
              </span>
              <Link
                to={`/recruiting/progress/${c.problem.slug}`}
                state={{ back }}
                className="min-w-0 text-sm font-medium text-ink underline decoration-line-strong underline-offset-[3px] hover:decoration-ink"
              >
                {c.problem.title}
              </Link>
            </span>
            <span role="cell" className="pl-5 text-sm text-ink-muted lg:pl-0">
              <span className="lg:hidden">
                {[
                  c.problem.difficulty,
                  status,
                  r && triesText(r),
                  r && `last ${fmtPastDay(r.lastDay, today)}`,
                  reSolve,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="hidden lg:inline">{c.problem.difficulty}</span>
            </span>
            <span role="cell" className="hidden text-sm text-ink lg:block">
              {status}
            </span>
            <span role="cell" className="hidden text-sm tabular-nums text-ink lg:block">
              {r ? triesText(r) : '–'}
            </span>
            <span role="cell" className="hidden text-sm text-ink lg:block">
              {r ? fmtPastDay(r.lastDay, today) : '–'}
            </span>
            <span role="cell" className="hidden text-sm text-ink lg:block">
              {reSolve ?? '–'}
            </span>
            <span role="cell" className="pl-5 lg:pl-0">
              <a
                href={sittingProblemUrl(c.problem.slug)}
                target="_blank"
                rel="noreferrer"
                className="whitespace-nowrap text-sm text-teal hover:underline"
                aria-label={`${c.problem.title} on LeetCode (opens a new tab)`}
              >
                LeetCode ↗
              </a>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function OffList({ cov, today }: { cov: Coverage; today: string }) {
  const back = useLocation().search;
  return (
    <details className="rounded-2xl border border-line bg-panel p-3">
      <summary className="cursor-pointer text-sm">
        <span className="font-semibold">Off the list</span>
        <span className="text-ink-muted">
          {' '}
          · {cov.offList.length} tried, not counted in the {cov.total}
        </span>
      </summary>
      <ul className="mt-2 flex flex-col">
        {cov.offList.map((r) => (
          <li
            key={r.slug}
            className="flex flex-wrap items-baseline gap-x-2 border-b border-line py-1.5 last:border-b-0"
          >
            <Link
              to={`/recruiting/progress/${r.slug}`}
              state={{ back }}
              className="text-sm font-medium text-ink underline decoration-line-strong underline-offset-[3px]"
            >
              {r.title}
            </Link>
            <Text size="xs" tone="muted">
              {PATTERN_NAMES[r.pattern]} · {triesText(r)} · last {fmtPastDay(r.lastDay, today)}
            </Text>
          </li>
        ))}
      </ul>
    </details>
  );
}
