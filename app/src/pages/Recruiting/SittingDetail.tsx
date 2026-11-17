import { useId, useRef, useState } from 'react';
import { useParams } from 'react-router';
import {
  isSittingOpen,
  mayBeIdle,
  msToMin,
  problemCompanies,
  ROLL_PLAN_FALLBACK_MIN,
  sittingMetrics,
  sittingMinutes,
  sittingProblemUrl,
} from '@aperture/shared';
import type { Sitting, SittingDetail as Detail } from '@aperture/shared';
import { Button, ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useRolls } from '../../data/hooks/useRolls';
import {
  useIdleRecheck,
  useReopenSitting,
  useSitting,
  useSittings,
  useVoidSitting,
} from '../../data/hooks/useSittings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { fmtDuration } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { DoneForm } from '../../modules/tasks/DoneForm';
import { REVIEW_ID, ReviewForm } from './ReviewForm';
import {
  canOfferReopen,
  IDLE_CLOSED_NOTICE,
  isIdleClosed,
  sittingOutcome,
} from './recruitingHelpers';
import { SittingTimeline } from './SittingTimeline';

// One sitting (docs/areas/recruiting → The page): the problem, how it went in numbers, every Run and Submit
// with its failing case, the final code, the review — and, while it's open, End sitting: the rep's Done form
// prefilled with the sitting's minutes (Done on the rep is what ends a sitting). Closed by idle, it says so, with
// Reopen and the rep's Done (its minutes stopped at the close) while the rep is still in progress.
export function SittingDetail() {
  const { id = '' } = useParams();
  const q = useSitting(id);
  const { data, isPending, isError, error, refetch } = q;
  const now = useNow();
  // A page left open: its cached head may have closed by idle since — read again before End sitting prefills.
  const stale = useIdleRecheck(
    data?.sitting,
    {
      fetchedAt: q.dataUpdatedAt,
      failedAt: q.errorUpdatedAt,
      fetching: q.isFetching,
      refetch,
    },
    now,
  );
  const missing = isError && /Not found/.test(String(error?.message));
  if (!data)
    return (
      <EmptyState
        pending={isPending}
        error={isError && !missing}
        onRetry={() => void refetch()}
        title="No such sitting."
        action={
          <ButtonLink to="/recruiting" size="sm">
            Back to sittings
          </ButtonLink>
        }
      >
        It may have been deleted with its rep.
      </EmptyState>
    );
  // The re-read failed: End sitting falls back to the cached minutes, and says so.
  const recheckFailed =
    mayBeIdle(data.sitting, now) &&
    q.errorUpdatedAt > q.dataUpdatedAt &&
    isSittingOpen(data.sitting, now);
  return <Loaded detail={data} now={now} stale={stale} recheckFailed={recheckFailed} />;
}

function Loaded({
  detail,
  now,
  stale,
  recheckFailed,
}: {
  detail: Detail;
  now: number;
  stale: boolean;
  recheckFailed: boolean;
}) {
  const { sitting, live, events, problem, liveReads } = detail;
  // A later sitting took its rep (a Start on another problem attached it): this one's rep is that one's now.
  // Unknown until the list is read: neither is offered meanwhile (or on a failed read).
  const list = useSittings();
  const all = list.data;
  const superseded =
    !all || all.some((x) => x.repTaskId === sitting.repTaskId && x.startedAt > sitting.startedAt);
  const idleOpen = isIdleClosed(sitting) && sitting.status === 'abandoned' && !superseded;
  const outcome = sittingOutcome(sitting, now);
  const m = sittingMetrics(sitting);
  const companies = problemCompanies(problem);
  const open = isSittingOpen(sitting, now);
  // Closed by idle, the boxed notice below says so: no "Dropped" here, and no empty line.
  const statusLine = [
    open
      ? 'In progress'
      : sitting.status === 'abandoned' && !isIdleClosed(sitting)
        ? 'Dropped'
        : null,
    sitting.status === 'active' && !open ? 'Past its 24 h window' : null,
    liveReads > 0
      ? `Claude watched live · ${liveReads} ${liveReads === 1 ? 'pull' : 'pulls'}`
      : null,
    sitting.prepTarget !== 'General' ? `For ${sitting.prepTarget}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <article className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <ButtonLink to="/recruiting" variant="quiet" size="sm" className="-ml-3 self-start">
          ← Sittings
        </ButtonLink>
        <Text as="h2" size="xl" weight="semibold">
          <a
            href={sittingProblemUrl(sitting.problemSlug)}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {sitting.problemTitle}
          </a>
        </Text>
        <Text size="sm" tone="muted">
          {[sitting.difficulty, ...(sitting.topicTags ?? [])].filter(Boolean).join(' · ')}
        </Text>
        {companies.length > 0 && (
          <Text size="sm" tone="subtle">
            Asked lately at {companies.join(', ')}
          </Text>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Metric label="Outcome">
          <Text weight="medium" tone={outcome.tone}>
            {outcome.label}
          </Text>
        </Metric>
        <Metric label="First submit">
          {m.timeToFirstSubmitMs === null
            ? '—'
            : `after ${fmtDuration(Math.max(1, msToMin(m.timeToFirstSubmitMs)))}`}
        </Metric>
        <Metric label={open ? 'So far' : 'Took'}>
          {fmtDuration(sittingMinutes(sitting, now))}
        </Metric>
        <Metric label="Runs · submits">
          {sitting.summary.runs} · {sitting.summary.submits}
        </Metric>
      </dl>
      {statusLine && (
        <Text as="p" size="sm" tone="muted">
          {statusLine}
        </Text>
      )}

      {isIdleClosed(sitting) && (
        <IdleClosed
          id={sitting.id}
          repTaskId={sitting.repTaskId}
          offer={canOfferReopen(sitting, now) && !superseded}
          // Reopen takes its button away: focus goes on to End sitting, the same button renamed.
          onReopened={() => requestAnimationFrame(() => document.getElementById(END_ID)?.focus())}
        />
      )}

      {isIdleClosed(sitting) && sitting.status === 'abandoned' && list.isError && (
        <p role="alert" className="text-sm text-danger">
          Couldn’t read your sittings to offer Reopen.{' '}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            Retry
          </button>
        </p>
      )}

      {recheckFailed && (
        <p role="alert" className="text-sm text-danger">
          Couldn’t re-check whether this sitting closed for inactivity — End sitting’s minutes may
          run past your last activity.
        </p>
      )}

      {(open || idleOpen) && (
        <EndSitting
          // Mark done takes End sitting away: focus goes on to the review, the next thing to do.
          onEnded={() => requestAnimationFrame(() => document.getElementById(REVIEW_ID)?.focus())}
          repTaskId={sitting.repTaskId}
          rollId={sitting.rollId}
          minutes={sittingMinutes(sitting, now)}
          label={open ? 'End sitting' : 'Mark rep done'}
          heading={open ? 'End the sitting — mark its rep done' : 'Mark its rep done'}
          waiting={stale}
        />
      )}

      <section aria-labelledby="sitting-timeline" className="flex flex-col gap-2">
        <Text as="h2" id="sitting-timeline" size="lg" weight="semibold">
          Runs and submits
        </Text>
        <SittingTimeline sitting={sitting} events={events} open={open} />
      </section>

      {live?.code && (
        <details className="rounded-xl border border-line bg-surface px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-ink">Final code</summary>
          <pre className="mt-2 overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre text-ink">
            {live.code}
          </pre>
        </details>
      )}

      <ReviewForm key={sitting.id} sitting={sitting} />

      {sitting.claudeNotes?.text && (
        <section aria-labelledby="claude-notes" className="flex flex-col gap-1">
          <Text as="h2" id="claude-notes" size="lg" weight="semibold">
            Claude’s notes
          </Text>
          <Text as="p" size="sm" className="whitespace-pre-line">
            {sitting.claudeNotes.text}
          </Text>
        </section>
      )}

      <VoidControl sitting={sitting} />
    </article>
  );
}

// Closed by idle: said outright, never silent, with Reopen while the server would take it (inside its window, its
// rep still in progress). A refusal (another sitting open, its rep moved on) shows inline, the button kept.
function IdleClosed({
  id,
  repTaskId,
  offer,
  onReopened,
}: {
  id: string;
  repTaskId: string;
  offer: boolean;
  onReopened: () => void;
}) {
  const reopen = useReopenSitting();
  const { data: tasks } = useAllTasks();
  const rep = tasks?.find((t) => t.id === repTaskId);
  const show = offer && rep?.status === 'in_progress';
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text size="sm">{IDLE_CLOSED_NOTICE}</Text>
        {show && (
          <Button
            aria-disabled={reopen.isPending || undefined}
            onClick={() => !reopen.isPending && reopen.mutate(id, { onSuccess: onReopened })}
          >
            Reopen
          </Button>
        )}
      </div>
      {reopen.isError && (
        <p role="alert" className="text-sm text-danger">
          {reopen.error instanceof Error ? reopen.error.message : 'Couldn’t reopen it.'}
        </p>
      )}
    </div>
  );
}

// A test sitting (the extension tried, a warm-up) is voided, not deleted: out of the plan, stats and re-solves, and
// back with one tap. One button whose label flips, so focus stays put; a refused write says why inline.
function VoidControl({ sitting }: { sitting: Sitting }) {
  const v = useVoidSitting();
  const voided = sitting.review?.test === true;
  return (
    <div className="flex flex-col gap-2">
      {voided && (
        <Text as="p" size="sm" className="rounded-xl border border-line bg-panel px-3 py-2">
          Doesn’t count — left out of the plan, stats and re-solves.
        </Text>
      )}
      <Button
        variant="quiet"
        size="sm"
        className="self-start"
        aria-disabled={v.isPending || undefined}
        onClick={() => !v.isPending && v.mutate({ id: sitting.id, test: !voided })}
      >
        {voided ? 'Count it again' : 'Doesn’t count'}
      </Button>
      {v.isError && (
        <Text as="p" size="xs" tone="danger" role="alert">
          Couldn’t change that — {(v.error as Error).message || 'try again'}.
        </Text>
      )}
    </div>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt>
        <Text size="xs" tone="subtle">
          {label}
        </Text>
      </dt>
      <dd>
        <Text tabular>{children}</Text>
      </dd>
    </div>
  );
}

// Done on the rep ends the sitting (the server's hook); the form starts on the sitting's own minutes, and the
// Roll's estimate when the rep lost one — RepTie's call.
const focusOnMount = (el: HTMLElement | null) => el?.focus();
const END_ID = 'end-sitting';

function EndSitting({
  repTaskId,
  rollId,
  minutes,
  onEnded,
  label,
  heading,
  waiting,
}: {
  repTaskId: string;
  rollId: string;
  minutes: number;
  onEnded: () => void;
  label: string;
  heading: string;
  waiting: boolean; // its minutes are being read again (useIdleRecheck)
}) {
  const [ending, setEnding] = useState(false);
  const back = useRef(false); // Cancel hands focus back to End sitting
  const id = useId();
  const { data: tasks } = useAllTasks();
  const rolls = useRolls();
  const rep = tasks?.find((t) => t.id === repTaskId);
  if (!rep || rep.status !== 'in_progress') return null;
  const roll = rolls.data?.find((r) => r.id === rollId);
  if (!ending)
    return (
      <Button
        id={END_ID}
        className="self-start"
        ref={(el) => {
          if (el && back.current) el.focus();
          back.current = false;
        }}
        // The form waits for the Rolls: its estimate is copied once, and must be the Roll's, not the fallback.
        aria-disabled={rolls.isPending || waiting || undefined}
        onClick={() => !rolls.isPending && !waiting && setEnding(true)}
      >
        {label}
      </Button>
    );
  // Focus lands on the form, not its Actual field — no keyboard springs up on a phone.
  return (
    <div
      ref={focusOnMount}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${id}-end`}
      className="outline-none"
    >
      <Text size="sm" weight="medium" id={`${id}-end`}>
        {heading}
      </Text>
      <DoneForm
        task={rep}
        initialActualMin={minutes}
        initialEstimateMin={Math.max(1, Math.round(roll?.estimateMin ?? ROLL_PLAN_FALLBACK_MIN))}
        onDone={() => {
          setEnding(false);
          onEnded();
        }}
        onCancel={() => {
          back.current = true;
          setEnding(false);
        }}
      />
    </div>
  );
}
