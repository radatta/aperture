import { Link, useLocation, useParams } from 'react-router';
import {
  CATALOGS,
  catalogProblem,
  CAUSE_NAMES,
  COACH_PARAMS,
  fmtPastDay,
  isProblemSlug,
  listsOf,
  PATTERN_NAMES,
  problemStatus,
  sittingProblemUrl,
  todayKey,
} from '@aperture/shared';
import type { ProblemRecord, ProblemTry } from '@aperture/shared';
import { ButtonLink } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useCoachToday } from '../../data/hooks/useCoach';
import { useProblemRecords } from '../../data/hooks/useCoachProgress';
import { useSettings } from '../../data/hooks/useSettings';
import { cx } from '../../lib/cx';
import { reSolveText, solveTag, stateTone, STATE_LABEL } from './progressHelpers';

// One problem's page (docs/areas/recruiting/coach.md → The Progress tab): what it is, where it stands, and every try
// newest first — minutes against the cap, help, cause, the logged note, and its sittings. Back returns to Progress
// as it was left (view, filters, open pattern).
export function ProblemPage() {
  const { slug = '' } = useParams();
  const back = (useLocation().state as { back?: string } | null)?.back ?? '';
  const records = useProblemRecords();
  const plan = useCoachToday();
  const settings = useSettings();
  const backLink = (
    <Link
      to={`/recruiting/progress${back}`}
      className="self-start text-sm text-teal hover:underline"
    >
      ← Progress
    </Link>
  );
  if (!records.data)
    return (
      <div className="flex flex-col gap-3">
        {backLink}
        <EmptyState
          pending={records.isPending}
          error={records.isError}
          onRetry={() => void records.refetch()}
          title="Couldn’t load this problem."
        />
      </div>
    );
  const today = plan.data?.day ?? todayKey(settings.data?.dayStartHour ?? 4);
  const r = records.data.find((x) => x.slug === slug) ?? null;
  const cat = isProblemSlug(slug) ? catalogProblem(slug) : null;
  if (!r && !cat)
    return (
      <div className="flex flex-col gap-3">
        {backLink}
        <EmptyState
          title="No problem by that name."
          action={
            <ButtonLink to="/recruiting/progress" size="sm">
              Back to Progress
            </ButtonLink>
          }
        >
          It isn’t on the list and hasn’t been tried.
        </EmptyState>
      </div>
    );
  const title = r?.title ?? cat!.title;
  const pattern = r?.pattern ?? cat!.pattern;
  const difficulty = r?.difficulty ?? cat?.difficulty ?? null;
  const st = problemStatus(r, today);
  const lists = r?.lists ?? listsOf(slug);
  const reSolve = reSolveText(st, today);
  return (
    <article className="flex max-w-3xl flex-col gap-3">
      {backLink}
      <Text as="h2" size="xl" weight="semibold">
        {title}
      </Text>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Text size="sm" tone="muted">
          {[
            PATTERN_NAMES[pattern],
            difficulty,
            lists.length ? lists.map((l) => CATALOGS[l].label).join(', ') : 'Off the list',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        <Tag tone={st.graduated ? 'muted' : stateTone(st.state)}>
          {r ? solveTag(st) : STATE_LABEL.untried}
        </Tag>
        {reSolve && (
          <Text size="sm" tone="muted">
            {reSolve}
          </Text>
        )}
        <a
          href={sittingProblemUrl(slug)}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-teal hover:underline"
          aria-label={`${title} on LeetCode (opens a new tab)`}
        >
          LeetCode ↗
        </a>
      </div>
      {r ? (
        <Tries record={r} today={today} />
      ) : (
        <Text size="sm" tone="muted">
          Not tried yet.
        </Text>
      )}
    </article>
  );
}

const TAG = {
  teal: 'bg-teal-soft text-teal',
  gold: 'bg-gold-soft text-gold',
  muted: 'border border-line bg-panel-2 text-ink-muted',
};
function Tag({ tone, children }: { tone: keyof typeof TAG; children: string }) {
  return (
    <span className={cx('whitespace-nowrap rounded-full px-2 text-xs font-semibold', TAG[tone])}>
      {children}
    </span>
  );
}

const OUTCOME = { clean: 'Clean', solved: 'Solved', failed: 'Not yet' } as const;
function Tries({ record, today }: { record: ProblemRecord; today: string }) {
  const tries = [...record.tries].reverse();
  return (
    <section aria-labelledby="problem-tries" className="flex flex-col gap-2">
      <Text as="h3" id="problem-tries" size="sm" weight="semibold">
        {tries.length === 1 ? 'One try' : `${tries.length} tries`}, newest first
      </Text>
      <ol className="ml-1.5 flex flex-col border-l-2 border-line">
        {tries.map((t, i) => (
          <TryRow key={`${t.day}-${i}`} t={t} today={today} />
        ))}
      </ol>
    </section>
  );
}
function TryRow({ t, today }: { t: ProblemTry; today: string }) {
  const peeked = t.help === 'solution';
  const word = t.historical ? 'Before the coach' : peeked ? 'Peeked' : OUTCOME[t.outcome];
  const tone = t.historical ? 'muted' : t.outcome === 'clean' ? 'teal' : 'gold';
  const over = t.minutes !== null && t.minutes > COACH_PARAMS.capMin;
  const bits = [
    t.historical && OUTCOME[t.outcome],
    t.minutes !== null && (
      <span key="m" className={cx(over && 'font-semibold text-gold')}>
        {t.minutes} min{over ? `, over the ${COACH_PARAMS.capMin} min cap` : ''}
      </span>
    ),
    t.help === 'hint' && 'a hint',
    peeked && 'read the solution',
    t.cause && CAUSE_NAMES[t.cause],
  ].filter(Boolean);
  return (
    <li className="relative flex flex-col gap-0.5 pb-4 pl-5">
      <span
        aria-hidden="true"
        className={cx(
          'absolute -left-[7px] top-1.5 size-3 rounded-full border-2',
          tone === 'teal'
            ? 'border-teal bg-teal'
            : tone === 'gold'
              ? peeked || t.outcome === 'failed'
                ? 'border-gold bg-surface'
                : 'border-gold bg-gold'
              : 'border-ink-subtle bg-ink-subtle',
        )}
      />
      <span className="flex flex-wrap items-center gap-2">
        <Text size="sm" weight="semibold">
          {fmtPastDay(t.day, today).replace(/^./, (c) => c.toUpperCase())}
        </Text>
        <Tag tone={tone}>{word}</Tag>
        {t.historical && (
          <Text size="xs" tone="muted">
            history only: never due, never a first try
          </Text>
        )}
      </span>
      {bits.length > 0 && (
        <Text size="sm" tone="muted">
          {bits.flatMap((b, i) => (i ? [' · ', b] : [b]))}
        </Text>
      )}
      {t.note && (
        <Text size="sm" tone="muted">
          Note: {t.note}
        </Text>
      )}
      {(t.sittingIds.length > 0 || t.attemptIds.length > 0) && (
        <span className="flex flex-wrap gap-x-3 text-sm">
          {t.sittingIds.map((id, k) => (
            <Link key={id} to={`/recruiting/sittings/${id}`} className="text-teal hover:underline">
              {t.sittingIds.length > 1 ? `Sitting ${k + 1}` : 'Sitting'} →
            </Link>
          ))}
          {t.attemptIds.length > 0 && (
            <Text size="sm" tone="muted">
              logged in the thread
            </Text>
          )}
        </span>
      )}
    </li>
  );
}
