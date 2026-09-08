import { fmtMonthDayYear } from '@aperture/shared';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useLeetcodeAttempts } from '../../data/hooks/useLeetcodeAttempts';
import { summarize, verdictLabel, verdictTone, withAttemptOrdinals } from './recruitingHelpers';

// Recruiting — V1 is LeetCode attempt capture. A reverse-chron list of every submission (accepted and
// wrong), with a derived per-problem attempt-count. Rows are fed by the browser extension; there's no
// authoring here. Firm-but-honest, never a streak or a red "you failed" — that tone lands in V2 planning.
export function RecruitingPage() {
  const { data: attempts = [], isPending, isError } = useLeetcodeAttempts();
  const rows = withAttemptOrdinals(attempts);
  const s = summarize(attempts);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <Text as="h1" size="2xl" weight="semibold">
          Recruiting
        </Text>
        {/* Only once there's something to summarize — "0 solved · 0 problems · 0 attempts" is the same
            confidently-wrong assertion as a premature empty state, and it's outside EmptyState's reach. */}
        {rows.length > 0 && (
          <Text as="p" size="sm" tone="muted">
            {s.solved} solved · {s.problems} {s.problems === 1 ? 'problem' : 'problems'} ·{' '}
            {s.attempts} {s.attempts === 1 ? 'attempt' : 'attempts'}
          </Text>
        )}
      </header>

      <div className="flex flex-col divide-y divide-line">
        {rows.length === 0 ? (
          <div className="py-8">
            <EmptyState
              pending={isPending}
              error={isError}
              title="No LeetCode attempts captured yet."
            >
              Install the extension to start logging them here.
            </EmptyState>
          </div>
        ) : (
          rows.map(({ attempt, attemptNo, problemAttempts }) => (
            <div key={attempt.id} className="flex items-start justify-between gap-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <Text weight="medium" className="truncate">
                    {attempt.problemTitle}
                  </Text>
                  {attempt.difficulty && (
                    <Text size="xs" tone="subtle">
                      {attempt.difficulty}
                    </Text>
                  )}
                </div>
                <Text size="xs" tone="subtle">
                  attempt {attemptNo} of {problemAttempts} · {attempt.lang}
                  {attempt.topicTags && attempt.topicTags.length > 0
                    ? ` · ${attempt.topicTags.join(', ')}`
                    : ''}
                </Text>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <Text size="sm" weight="medium" tone={verdictTone(attempt.verdict)}>
                  {verdictLabel(attempt.verdict)}
                </Text>
                <Text size="xs" tone="subtle" tabular>
                  {fmtMonthDayYear(attempt.day)}
                </Text>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
