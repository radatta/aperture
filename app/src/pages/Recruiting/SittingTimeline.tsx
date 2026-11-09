import { msToMin, timelineOf } from '@aperture/shared';
import type { JudgeDetail, Sitting, SittingEvent } from '@aperture/shared';
import { Text } from '../../components/Text';
import { verdictLabel, verdictTone } from './recruitingHelpers';

// The sitting's Runs and Submits in order, each with its verdict (teal accepted, gold otherwise — never red)
// and, folded away, LeetCode's own failing case; between them how many times the code was snapshotted.
export function SittingTimeline({ sitting, events }: { sitting: Sitting; events: SittingEvent[] }) {
  const entries = timelineOf(sitting, events);
  if (!entries.some((e) => e.kind === 'judged'))
    return (
      <Text as="p" size="sm" tone="muted">
        No runs or submits yet.
      </Text>
    );
  return (
    <ol aria-label="Runs and submits" className="flex flex-col gap-2">
      {entries.map((e, i) =>
        e.kind === 'codeChanged' ? (
          <li key={`c${i}`} className="pl-3">
            <Text size="xs" tone="subtle">
              code changed ×{e.count}
            </Text>
          </li>
        ) : (
          <li key={e.id} className="rounded-xl border border-line bg-surface px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <Text size="sm" weight="medium">
                {e.type === 'run' ? 'Run' : 'Submit'} {e.n}
                <Text size="sm" tone="muted" tabular>
                  {' '}
                  · +{msToMin(e.offsetMs)}m
                </Text>
              </Text>
              <Text size="sm" weight="medium" tone={verdictTone(e.verdict.verdict)} tabular>
                {e.verdict.statusMsg ?? verdictLabel(e.verdict.verdict)}
                {e.verdict.total != null && ` · ${e.verdict.passed ?? 0}/${e.verdict.total}`}
              </Text>
            </div>
            <CaseDetail detail={e.detail} />
          </li>
        ),
      )}
    </ol>
  );
}

function CaseDetail({ detail }: { detail: JudgeDetail }) {
  const rows = (
    [
      ['Input', detail.input],
      ['Expected', detail.expected],
      ['Output', detail.output],
      ['Error', detail.error],
    ] as const
  ).filter(([, v]) => v !== null);
  if (!rows.length) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-sm text-ink-muted">
        {detail.error ? 'Error' : 'Failing case'}
      </summary>
      <dl className="mt-1 flex flex-col gap-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <dt>
              <Text size="xs" tone="subtle">
                {k}
              </Text>
            </dt>
            <dd className="overflow-x-auto rounded-lg bg-panel px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words text-ink">
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
