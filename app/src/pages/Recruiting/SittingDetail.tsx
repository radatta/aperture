import { useRef, useState } from 'react';
import { useParams } from 'react-router';
import {
  isSittingOpen,
  msToMin,
  problemCompanies,
  ROLL_PLAN_FALLBACK_MIN,
  sittingMetrics,
  sittingMinutes,
  sittingProblemUrl,
} from '@aperture/shared';
import type { SittingDetail as Detail } from '@aperture/shared';
import { Button, ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useRolls } from '../../data/hooks/useRolls';
import { useSitting } from '../../data/hooks/useSittings';
import { useAllTasks } from '../../data/hooks/useTasks';
import { fmtDuration } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { DoneForm } from '../../modules/tasks/DoneForm';
import { ReviewForm } from './ReviewForm';
import { sittingOutcome } from './recruitingHelpers';
import { SittingTimeline } from './SittingTimeline';

// One sitting (docs/areas/recruiting → The page): the problem, how it went in numbers, every Run and Submit
// with its failing case, the final code, the review — and, while it's open, End sitting: the rep's Done form
// prefilled with the sitting's minutes (Done on the rep is what ends a sitting).
export function SittingDetail() {
  const { id = '' } = useParams();
  const { data, isPending, isError, error, refetch } = useSitting(id);
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
  return <Loaded detail={data} />;
}

function Loaded({ detail }: { detail: Detail }) {
  const { sitting, live, events, problem, liveReads } = detail;
  const now = useNow();
  const outcome = sittingOutcome(sitting);
  const m = sittingMetrics(sitting);
  const companies = problemCompanies(problem);
  const open = isSittingOpen(sitting, now);
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
      {(liveReads > 0 || sitting.status !== 'done' || sitting.prepTarget !== 'General') && (
        <Text as="p" size="sm" tone="muted">
          {[
            open ? 'In progress' : sitting.status === 'abandoned' ? 'Dropped' : null,
            sitting.status === 'active' && !open ? 'Past its 24 h window' : null,
            liveReads > 0
              ? `Claude watched live · ${liveReads} ${liveReads === 1 ? 'pull' : 'pulls'}`
              : null,
            sitting.prepTarget !== 'General' ? `For ${sitting.prepTarget}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      )}

      {open && (
        <EndSitting
          repTaskId={sitting.repTaskId}
          rollId={sitting.rollId}
          minutes={sittingMinutes(sitting, now)}
        />
      )}

      <section aria-labelledby="sitting-timeline" className="flex flex-col gap-2">
        <Text as="h2" id="sitting-timeline" size="lg" weight="semibold">
          Runs and submits
        </Text>
        <SittingTimeline sitting={sitting} events={events} />
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
    </article>
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

function EndSitting({
  repTaskId,
  rollId,
  minutes,
}: {
  repTaskId: string;
  rollId: string;
  minutes: number;
}) {
  const [ending, setEnding] = useState(false);
  const back = useRef(false); // Cancel hands focus back to End sitting
  const { data: tasks } = useAllTasks();
  const { data: rolls } = useRolls();
  const rep = tasks?.find((t) => t.id === repTaskId);
  if (!rep || rep.status !== 'in_progress') return null;
  const roll = rolls?.find((r) => r.id === rollId);
  if (!ending)
    return (
      <Button
        className="self-start"
        ref={(el) => {
          if (el && back.current) el.focus();
          back.current = false;
        }}
        onClick={() => setEnding(true)}
      >
        End sitting
      </Button>
    );
  // Focus lands on the form, not its Actual field — no keyboard springs up on a phone.
  return (
    <div ref={focusOnMount} tabIndex={-1} className="outline-none">
      <Text size="sm" weight="medium">
        End the sitting — mark its rep done
      </Text>
      <DoneForm
        task={rep}
        initialActualMin={minutes}
        initialEstimateMin={Math.max(1, Math.round(roll?.estimateMin ?? ROLL_PLAN_FALLBACK_MIN))}
        onDone={() => setEnding(false)}
        onCancel={() => {
          back.current = true;
          setEnding(false);
        }}
      />
    </div>
  );
}
