import { useLayoutEffect, useRef, useState } from 'react';
import { fmtMockScores, fmtMonthShortDay, MOCK_KIND_NAMES } from '@aperture/shared';
import type { CoachStats, Mock } from '@aperture/shared';
import { Button } from '../../components/Button';
import { LoadError } from '../../components/LoadError';
import { Text } from '../../components/Text';
import { useDeleteMock, useMocks } from '../../data/hooks/useCoach';
import { isTransientRead } from '../../data/retry';
import { returnFocus } from '../../lib/useDisclosure';
import { fmtRate, mockRows } from './patternsHelpers';

const MAX_SHOWN = 12;

// Mock interviews on the Patterns tab (docs/areas/recruiting/coach.md → Mocks): Code and Solve over time, each
// mock beside the first-try rate of its week. The trend is the signal; one mock is noise, so the chart waits for
// two. Delete asks once, inline.
export function PatternsMocks({ weeks }: { weeks: CoachStats['weeks'] }) {
  const mocks = useMocks();
  // A deleted row takes its buttons with it: focus goes to the section's heading.
  const heading = useRef<HTMLElement>(null);
  const onDeleted = () => {
    if (heading.current) returnFocus(heading.current);
  };
  if (mocks.isError && !mocks.data)
    return <LoadError onRetry={() => void mocks.refetch()}>Couldn’t load the mocks.</LoadError>;
  if (!mocks.data) return null;
  const rows = mockRows(mocks.data, weeks).slice(0, MAX_SHOWN);
  return (
    <section aria-labelledby="patterns-mocks" className="flex flex-col gap-1">
      <Text
        as="h2"
        ref={heading}
        tabIndex={-1}
        id="patterns-mocks"
        size="sm"
        weight="semibold"
        tone="muted"
        className="outline-offset-2"
      >
        Mock interviews
      </Text>
      {rows.length === 0 ? (
        <Text as="p" size="xs" tone="muted">
          None logged yet — log one from Today’s practice. Code and Solve show here beside your
          first tries.
        </Text>
      ) : (
        <>
          <ScoreLines mocks={rows.map((r) => r.mock)} />
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((r) => (
              <MockRow key={r.mock.id} mock={r.mock} firstTry={r.firstTry} onDeleted={onDeleted} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function MockRow({
  mock: m,
  firstTry,
  onDeleted,
}: {
  mock: Mock;
  firstTry: CoachStats['firstTry'] | null;
  onDeleted: () => void;
}) {
  const del = useDeleteMock();
  const [asking, setAsking] = useState(false);
  // No hands focus back to the Delete it replaced (remounted with the question gone).
  const deleteButton = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  useLayoutEffect(() => {
    if (asking || !back.current || !deleteButton.current) return;
    back.current = false;
    returnFocus(deleteButton.current);
  }, [asking]);
  const [error, setError] = useState<string | null>(null);
  const when = fmtMonthShortDay(m.day);
  async function remove() {
    if (del.isPending) return;
    setError(null);
    try {
      await del.mutateAsync(m.id);
      onDeleted();
    } catch (e) {
      setError(
        isTransientRead(e)
          ? 'Couldn’t confirm the delete — the list shows what stands.'
          : `${(e as Error).message || 'Couldn’t delete the mock'}. Nothing changed.`,
      );
    }
  }
  return (
    <li className="flex flex-col gap-0.5 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <Text size="sm" className="min-w-0">
          {when}
          <Text as="span" size="xs" tone="subtle">
            {' '}
            · {m.partner ? `with ${m.partner}` : MOCK_KIND_NAMES[m.kind]}
          </Text>
        </Text>
        {asking ? (
          <span className="flex shrink-0 items-center gap-1">
            <Text size="xs" tone="muted">
              Delete?
            </Text>
            <Button
              variant="quiet"
              size="sm"
              aria-label={`Yes, delete the mock on ${when}`}
              aria-disabled={del.isPending || undefined}
              onClick={() => void remove()}
            >
              Yes
            </Button>
            <Button
              variant="quiet"
              size="sm"
              autoFocus
              onClick={() => {
                back.current = true;
                setAsking(false);
              }}
            >
              No
            </Button>
          </span>
        ) : (
          <Button
            ref={deleteButton}
            variant="quiet"
            size="sm"
            aria-label={`Delete the mock on ${when}`}
            onClick={() => setAsking(true)}
          >
            Delete
          </Button>
        )}
      </div>
      <Text size="sm" tabular>
        {fmtMockScores(m.scores!)}
      </Text>
      <Text size="xs" tone="muted">
        {firstTry ? `First try that week ${fmtRate(firstTry)}` : 'No first try that week'}
      </Text>
      {m.notes && (
        <Text size="xs" tone="muted" className="whitespace-pre-line">
          {m.notes}
        </Text>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

// Code (solid, teal) and Solve (dashed, gold) per mock, oldest to newest, on the 1–4 scale; from two mocks.
function ScoreLines({ mocks }: { mocks: Mock[] }) {
  const shown = [...mocks].reverse();
  if (shown.length < 2) return null;
  const step = 24;
  const h = 40;
  const pad = 4;
  const x = (i: number) => pad + i * step;
  const y = (v: number) => pad + ((4 - v) / 3) * (h - 2 * pad);
  const line = (k: 'code' | 'solve') => shown.map((m, i) => `${x(i)},${y(m.scores![k])}`).join(' ');
  const label = `Mock scores, oldest first: ${shown
    .map((m) => `${fmtMonthShortDay(m.day)} Code ${m.scores!.code}, Solve ${m.scores!.solve}`)
    .join('; ')}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
      <svg
        role="img"
        aria-label={label}
        width={x(shown.length - 1) + pad}
        height={h}
        className="shrink-0"
      >
        <polyline points={line('code')} className="fill-none stroke-teal" strokeWidth={2} />
        <polyline
          points={line('solve')}
          className="fill-none stroke-gold"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
      </svg>
      <Text size="xs" tone="muted" aria-hidden>
        <span className="text-teal">—</span> Code · <span className="text-gold">- -</span> Solve
      </Text>
    </div>
  );
}
