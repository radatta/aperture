import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { coverage, DEFAULT_CATALOG, todayKey } from '@aperture/shared';
import type { PatternId } from '@aperture/shared';
import { LoadError } from '../../components/LoadError';
import { ModeToggle } from '../../components/ModeToggle';
import { Text } from '../../components/Text';
import { useCoachToday } from '../../data/hooks/useCoach';
import { useProblemRecords } from '../../data/hooks/useCoachProgress';
import { useSettings } from '../../data/hooks/useSettings';
import { ProgressMap } from './ProgressMap';
import { ProgressTrends } from './ProgressTrends';
import { SolvesList } from './SolvesList';
import { parseFilters, parsePattern, parseView, PROGRESS_VIEWS } from './progressHelpers';
import type { ProgressView, SolveFilters } from './progressHelpers';

// The Progress tab (docs/areas/recruiting/coach.md → The Progress tab): how much of the list is done, what's left,
// and every solve, against NeetCode 150. Patterns says how well; this says how much. Everything is derived in the
// app from the problem records and the static list; the day's plan gives today and the focus marker. The view, the
// open pattern, Left only and the Solves filters live in the URL.
export function ProgressSection() {
  const records = useProblemRecords();
  const plan = useCoachToday();
  const settings = useSettings();
  const [q, setQ] = useSearchParams();

  if (!records.data)
    return (
      <div className="py-8">
        {records.isError ? (
          <LoadError onRetry={() => void records.refetch()}>Couldn’t load your progress.</LoadError>
        ) : (
          <Text tone="muted" size="sm">
            Loading…
          </Text>
        )}
      </div>
    );

  const today = plan.data?.day ?? todayKey(settings.data?.dayStartHour ?? 4);
  const cov = coverage(records.data, DEFAULT_CATALOG, today);
  // Premium is marked only when the coach can't pick it (the setting off). Unknown settings read as the default, on.
  const premiumMarked = settings.data?.leetcodePremium === false;
  const view = parseView(q.get('view'));
  const set = (patch: Record<string, string | null>) =>
    setQ(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  const onView = (v: ProgressView) => set({ view: v === 'map' ? null : v });
  const onOpen = (p: PatternId | null) => set({ open: p });
  const onLeft = (on: boolean) => set({ left: on ? '1' : null });
  const onFilters = (f: SolveFilters) =>
    set({ pattern: f.pattern, status: f.status, difficulty: f.difficulty });

  // Wider than the app's column on a desktop (the map's five stages and the tables need the room); the header, tabs
  // and dock stay in the column. The arithmetic assumes AppShell's column (max-w-3xl, px-5 = 1.25rem, no padded
  // wrapper between it and this div): centred on it, up to 72rem, 1.25rem from each edge of the window.
  return (
    <div className="flex flex-col gap-4 lg:ml-[calc(50%-min(36rem,calc(50vw-1.25rem)))] lg:w-[min(72rem,calc(100vw-2.5rem))]">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-6">
        <Text as="p" size="sm" tone="muted" className="flex flex-wrap gap-x-1.5">
          <Part first>
            <span className="font-semibold text-ink">{cov.label}</span>
          </Part>
          <Part>
            <span className="font-semibold text-ink">{cov.done}</span> done
          </Part>
          {cov.tried > 0 && <Part>{cov.tried} tried, not solved yet</Part>}
          <Part>
            {cov.untried} not tried
            {premiumMarked && cov.premium > 0 ? ` (${cov.premium} Premium)` : ''}
          </Part>
          {cov.offList.length > 0 && <Part>{cov.offList.length} off the list</Part>}
          {cov.due > 0 && (
            <Part>
              {cov.due} re-solve{cov.due === 1 ? '' : 's'} due
            </Part>
          )}
        </Text>
        <WholeBar total={cov.total} done={cov.done} tried={cov.tried} />
      </div>
      <ModeToggle
        options={PROGRESS_VIEWS}
        value={view}
        onChange={onView}
        size="sm"
        className="self-start"
      />
      {plan.isError && !plan.data && view === 'map' && (
        <LoadError size="xs" onRetry={() => void plan.refetch()}>
          Couldn’t load the focus, so no pattern is marked.
        </LoadError>
      )}
      {view === 'map' ? (
        <ProgressMap
          cov={cov}
          today={today}
          focus={plan.data?.focus.pattern ?? null}
          open={parsePattern(q.get('open'))}
          left={q.get('left') === '1'}
          premiumMarked={premiumMarked}
          onOpen={onOpen}
          onLeft={onLeft}
        />
      ) : view === 'solves' ? (
        <SolvesList
          records={records.data}
          today={today}
          filters={parseFilters(q)}
          onFilters={onFilters}
        />
      ) : (
        <ProgressTrends records={records.data} today={today} />
      )}
    </div>
  );
}

// A " · "-joined part that never breaks inside.
function Part({ first = false, children }: { first?: boolean; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      {!first && <span aria-hidden="true">· </span>}
      {children}
    </span>
  );
}

// The whole list at a glance: done, tried, the rest.
function WholeBar({ total, done, tried }: { total: number; done: number; tried: number }) {
  return (
    <div
      role="meter"
      aria-label={`${done} of ${total} done`}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="flex h-2 min-w-40 flex-1 gap-0.5 overflow-hidden rounded-full"
    >
      {done > 0 && <div className="h-full bg-teal" style={{ flex: done }} />}
      {tried > 0 && <div className="h-full bg-gold" style={{ flex: tried }} />}
      {total - done - tried > 0 && (
        <div
          className="h-full rounded-r-full shadow-[inset_0_0_0_1.5px_var(--line-strong)]"
          style={{ flex: total - done - tried }}
        />
      )}
    </div>
  );
}
