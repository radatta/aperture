import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  fmtPastDay,
  fmtSpokenDay,
  MOCK_KIND_NAMES,
  PATTERN_NAMES,
  PATTERNS,
} from '@aperture/shared';
import type { CoachSlot, CoachToday, MockBrief, PatternId } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { LoadError } from '../../components/LoadError';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import {
  useCoachToday,
  useDeleteMock,
  useSetCoachFloor,
  useSetCoachFocus,
  useSetCoachSlot,
} from '../../data/hooks/useCoach';
import { isTransientRead } from '../../data/retry';
import { cx } from '../../lib/cx';
import { returnFocus, useDisclosure } from '../../lib/useDisclosure';
import { MockForm } from './MockForm';
import { dueBeyondSlots, dueLabel, SLOT_KIND_LABEL, slotState } from './recruitingHelpers';

const sittingPath = (id: string) => `/recruiting/sittings/${id}`;
const ENGINE = ''; // the focus picker's "the coach's pick" option (clears the override)

// The coach's day on the Sittings tab (docs/areas/recruiting/coach.md): the focus pattern, up to four slots with
// their reasons, the floor option, what's due in the next 48 hours and the week's momentum. The thread in
// claude.ai drives the coaching; this is the glance, plus the few changes worth a tap: another problem, skip,
// restore, a floor day, the focus override. Every write is reversible, and a refused one says why inline.
export function TodayCard() {
  const { data: today, isPending, isError, refetch, startFailed, retryStart } = useCoachToday();
  const id = useId();
  const status = aiStatus(today, startFailed);
  return (
    <Card aria-labelledby={`${id}-h`} role="region" className="flex flex-col gap-3">
      <Text as="h2" id={`${id}-h`} size="lg" weight="semibold">
        Today’s practice
      </Text>
      {/* The AI pick's one live region, mounted before the plan loads so its first line is announced too. */}
      <div
        className={cx(
          'flex flex-wrap items-center gap-2',
          (!status.text || status.quiet) && 'sr-only',
        )}
      >
        <p role="status" className="text-sm text-ink-muted">
          {status.text}
        </p>
        {status.retry && (
          <Button variant="quiet" size="sm" onClick={retryStart}>
            Retry
          </Button>
        )}
      </div>
      {isError && !today ? (
        <LoadError onRetry={() => void refetch()}>Couldn’t load today’s plan.</LoadError>
      ) : isPending || !today ? (
        <Text size="sm" tone="muted">
          Loading today’s plan…
        </Text>
      ) : (
        <TodayBody today={today} startFailed={startFailed} />
      )}
    </Card>
  );
}

// The AI pick's state on the card: whether it's still picking (slots withheld), and the line said about it — a
// fallback's notice, a failed start (with a Retry), or, once picked, a screen-reader-only "picked" (`quiet`).
function aiStatus(today: CoachToday | undefined, startFailed: boolean) {
  const ai = today?.ai;
  const picking = ai?.status === 'pending' || (ai?.status === 'due' && !startFailed);
  const retry = ai?.status === 'due' && startFailed;
  const text = picking
    ? 'Opus is picking today’s problems… usually under a minute.'
    : retry
      ? 'Couldn’t start today’s AI pick — using the rules for now.'
      : ai?.status === 'fallback'
        ? ai.notice
        : ai?.status === 'ok'
          ? 'Opus picked today’s problems.'
          : null;
  return { picking, retry, text, quiet: ai?.status === 'ok' };
}

function TodayBody({ today, startFailed }: { today: CoachToday; startFailed: boolean }) {
  const slot = useSetCoachSlot();
  const floor = useSetCoachFloor();
  const [error, setError] = useState<string | null>(null);
  const busy = slot.isPending || floor.isPending;
  // One write at a time: a second tap while one is in flight does nothing, so a double tap is one change. A ref,
  // since both taps of a double tap land before the pending state renders.
  const inFlight = useRef(false);
  // True when the write landed.
  async function run(write: () => Promise<unknown>): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setError(null);
    try {
      await write();
      return true;
    } catch (e) {
      setError((e as Error).message || 'Couldn’t change the plan — try again.');
      return false;
    } finally {
      inFlight.current = false;
    }
  }
  const change = (s: CoachSlot, action: 'swap' | 'skip' | 'restore') =>
    run(() => slot.mutateAsync({ slug: s.slug, action }));
  // While Opus picks, the rule slots aren't shown — nor what's due beyond them: the plan never shifts under a glance.
  const ai = today.ai;
  const { picking } = aiStatus(today, startFailed);
  const queue = picking ? today.next48h : [...dueBeyondSlots(today), ...today.next48h];
  const upcoming = today.mock?.upcoming ?? [];
  const mocks = useMockState();

  return (
    <div className="flex flex-col gap-4">
      <FocusLine today={today} />
      {/* The plan mode in one line (coach.md → Plan mode): what the mix is today and why. */}
      <Text size="xs" tone="muted" data-testid="plan-mode">
        {today.planMode?.line}
      </Text>

      {ai?.status === 'ok' && ai.focusChange && (
        <Text size="xs" tone="muted">
          Opus moved the focus from {PATTERN_NAMES[ai.focusChange.from]} to{' '}
          {PATTERN_NAMES[ai.focusChange.to]}
          {ai.focusChange.why ? ` — ${ai.focusChange.why}` : ''}
        </Text>
      )}
      {ai?.status === 'ok' && ai.note && <Text size="sm">{ai.note}</Text>}

      {picking ? null : today.slots.length === 0 ? (
        <Text size="sm" tone="muted">
          Nothing to plan today — every problem in reach is done or queued for later.
        </Text>
      ) : (
        <ul aria-label="Today’s slots" className="flex flex-col divide-y divide-line">
          {today.slots.map((s) => (
            <SlotRow
              // The engine's pick: steady across a swap (which can change the kind) and a restore, so the row
              // keeps its DOM, and focus, through either. Slots never share one (applySlotChange).
              key={s.swappedFrom ?? s.slug}
              slot={s}
              busy={busy}
              canStart={() => !inFlight.current}
              onChange={change}
            />
          ))}
        </ul>
      )}

      {today.floor && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-line px-3 py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Text size="sm" weight="medium">
              {today.floor.on ? 'Floor day: just ' : 'Short on time? Floor: '}
              <a
                href={`https://leetcode.com/problems/${today.floor.slug}/`}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {today.floor.title}
              </a>
              {today.floor.done && (
                <Text as="span" size="sm" tone="teal">
                  {' '}
                  · done
                </Text>
              )}
            </Text>
            <Text size="xs" tone="muted">
              {today.floor.reason}
            </Text>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={busy || undefined}
            onClick={() => void run(() => floor.mutateAsync(!today.floor!.on))}
          >
            {today.floor.on ? 'Full day' : 'Floor day'}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {today.offPlan.length > 0 && (
        <Text size="sm" tone="muted">
          Also today:{' '}
          {today.offPlan.map((o, i) => (
            <span key={o.sittingId}>
              {i > 0 && ', '}
              <Link
                to={sittingPath(o.sittingId)}
                className="text-ink underline-offset-2 hover:underline"
              >
                {o.title}
              </Link>
            </span>
          ))}{' '}
          (off plan)
        </Text>
      )}

      {today.unreviewed.length > 0 && (
        <Text size="sm" tone="muted">
          No cause yet:{' '}
          {today.unreviewed.map((u, i) => (
            <span key={u.sittingId}>
              {i > 0 && ', '}
              <Link
                to={sittingPath(u.sittingId)}
                className="text-ink underline-offset-2 hover:underline"
              >
                {u.title}
              </Link>
            </span>
          ))}
        </Text>
      )}

      {(queue.length > 0 || upcoming.length > 0) && (
        <section aria-label="Next 48 hours" className="flex flex-col gap-1">
          <Text size="sm" weight="semibold" tone="muted">
            Next 48 hours
          </Text>
          <ul className="flex flex-col gap-0.5">
            {upcoming.map((m) => (
              <PlannedMockRow
                key={m.id}
                mock={m}
                today={today.day}
                onLog={() => mocks.openLog(m)}
                onCancel={() => void mocks.cancel(m)}
              />
            ))}
            {queue.map((q) => (
              <li key={q.slug} className="flex items-baseline justify-between gap-3">
                <Text size="sm" className="min-w-0 truncate">
                  {q.title}
                  <Text as="span" size="xs" tone="subtle">
                    {' '}
                    · {PATTERN_NAMES[q.pattern]}
                    {q.track === 'retry' ? ' · retry' : ''}
                  </Text>
                </Text>
                <Text size="xs" tone="muted" className="shrink-0">
                  {dueLabel(q.dueDay, today.day)}
                </Text>
              </li>
            ))}
          </ul>
        </section>
      )}

      {today.mock && <MockBlock today={today} state={mocks} />}

      <Text size="xs" tone="muted" tabular>
        {today.momentum.activeDays} of {today.momentum.of} days practised this week
      </Text>
    </div>
  );
}

// The card's mock state, shared by the 48-hour rows (Log it, Cancel) and the mock block (its line, Log a mock and
// the form). The form opens in the block either way; closing it hands focus back to Log a mock, and a row cancelled
// while a form stays open hands it to the mock section.
function useMockState() {
  const del = useDeleteMock();
  const [form, setForm] = useState<{ mock: MockBrief | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Log a mock is back once the form closes: focus moves to it after that render (MockBlock's effect). Holds what
  // had focus when the action began, so the effect can tell focus that was lost from focus the user moved.
  const refocus = useRef<{ from: Element | null } | null>(null);
  const pend = () => (refocus.current = { from: document.activeElement });
  const close = () => {
    pend();
    setForm(null);
  };
  return {
    form,
    error,
    trigger,
    refocus,
    close,
    openNew: () => {
      setError(null);
      setForm({ mock: null });
    },
    openLog: (m: MockBrief) => {
      setError(null);
      setForm({ mock: m });
    },
    cancel: async (m: MockBrief) => {
      if (del.isPending) return;
      setError(null);
      const from = document.activeElement;
      try {
        await del.mutateAsync(m.id);
        refocus.current = { from }; // the row and its buttons go
        if (form?.mock?.id === m.id) setForm(null);
      } catch (e) {
        setError(
          isTransientRead(e)
            ? 'Couldn’t confirm the mock was cancelled — the card shows what stands.'
            : `${(e as Error).message || 'Couldn’t cancel the mock'}. Nothing changed.`,
        );
      }
    },
  };
}
type MockState = ReturnType<typeof useMockState>;

const mockWho = (m: Pick<MockBrief, 'kind' | 'partner'>) =>
  m.partner ? `with ${m.partner}` : MOCK_KIND_NAMES[m.kind].toLowerCase();

function PlannedMockRow({
  mock: m,
  today,
  onLog,
  onCancel,
}: {
  mock: MockBrief;
  today: string;
  onLog: () => void;
  onCancel: () => void;
}) {
  const when = m.day < today ? fmtPastDay(m.day, today) : fmtSpokenDay(m.day, today);
  const named = `mock ${when} ${mockWho(m)}`; // as the row reads, so two the same day still differ
  return (
    <li className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <Text size="sm" className="min-w-0 truncate">
          Mock interview
          <Text as="span" size="xs" tone="subtle">
            {' '}
            · {mockWho(m)}
          </Text>
        </Text>
        <Text size="xs" tone="muted" className="shrink-0">
          {when}
        </Text>
      </div>
      <div className="-ml-2 flex flex-wrap gap-1">
        {/* From its day on: a mock not yet held has nothing to log. */}
        {m.day <= today && (
          <Button variant="quiet" size="sm" onClick={onLog} aria-label={`Log it — ${named}`}>
            Log it
          </Button>
        )}
        <Button variant="quiet" size="sm" onClick={onCancel} aria-label={`Cancel — ${named}`}>
          Cancel
        </Button>
      </div>
    </li>
  );
}

// The week's mock in one line (muted when there's none yet — never a count of missed weeks), Log a mock, and the
// form when open.
function MockBlock({ today, state }: { today: CoachToday; state: MockState }) {
  const none = today.mock.thisWeek === 'none' && !today.mock.upcoming.length;
  const unlogged = today.mock.unlogged ?? [];
  // Back to Log a mock; while a form stays open (a row cancelled beside it), the section itself.
  const section = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const pending = state.refocus.current;
    const to = state.trigger.current ?? section.current;
    if (!pending || !to) return;
    const at = document.activeElement;
    if (at && at === pending.from && at.isConnected) return; // its row hasn't gone yet: wait for that render
    state.refocus.current = null;
    // Only focus that was lost: never pull it out of a form the user went on to while the write ran.
    if (at && at !== document.body && at.isConnected) return;
    returnFocus(to);
  });
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label="Mock interviews"
      className="flex flex-col gap-2 outline-offset-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <Text size="sm" tone={none ? 'muted' : 'ink'} data-testid="mock-line">
          {today.mock.line}
        </Text>
        {!state.form && (
          <Button ref={state.trigger} variant="quiet" size="sm" onClick={state.openNew}>
            Log a mock
          </Button>
        )}
      </div>
      {/* Planned for a day already past: still to log, or to cancel — never left dangling. */}
      {unlogged.length > 0 && (
        <ul aria-label="Planned mocks not logged yet" className="flex flex-col gap-0.5">
          {unlogged.map((m) => (
            <PlannedMockRow
              key={m.id}
              mock={m}
              today={today.day}
              onLog={() => state.openLog(m)}
              onCancel={() => void state.cancel(m)}
            />
          ))}
        </ul>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.form && (
        <MockForm
          key={state.form.mock?.id ?? 'new'}
          today={today.day}
          mock={state.form.mock}
          onSaved={state.close}
          onCancel={state.close}
        />
      )}
    </section>
  );
}

function FocusLine({ today }: { today: CoachToday }) {
  const focus = useSetCoachFocus();
  // A pick or Cancel closes the picker and hands focus back to Change (useDisclosure).
  const picker = useDisclosure();
  const picking = picker.open;
  const [error, setError] = useState<string | null>(null);
  const f = today.focus;
  async function pick(v: string) {
    if (focus.isPending) return;
    setError(null);
    try {
      await focus.mutateAsync(v === ENGINE ? null : (v as PatternId));
      picker.onClose();
    } catch (e) {
      setError((e as Error).message || 'Couldn’t change the focus — try again.');
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Text size="sm" weight="medium">
          {PATTERN_NAMES[f.pattern]} · day {f.day} of {f.of}
          {f.source === 'override' ? ' · your pick' : f.source === 'ai' ? ' · Opus’s pick' : ''}
        </Text>
        <Button
          variant="quiet"
          size="sm"
          ref={picker.triggerRef}
          aria-expanded={picking}
          onClick={() => {
            setError(null);
            if (picking) picker.onClose();
            else picker.onOpen();
          }}
        >
          {picking ? 'Cancel' : 'Change'}
        </Button>
      </div>
      <Text size="xs" tone="muted">
        {f.why}
      </Text>
      {picking && (
        <Select
          autoFocus
          label="Focus pattern"
          value={f.source === 'override' ? f.pattern : ENGINE}
          aria-disabled={focus.isPending || undefined}
          onChange={(e) => void pick(e.target.value)}
          options={[
            { value: ENGINE, label: 'The coach’s pick' },
            ...PATTERNS.map((p) => ({ value: p, label: PATTERN_NAMES[p] })),
          ]}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function SlotRow({
  slot: s,
  busy,
  canStart,
  onChange,
}: {
  slot: CoachSlot;
  busy: boolean;
  canStart: () => boolean; // false while another change is in flight: this tap won't start one
  onChange: (s: CoachSlot, action: 'swap' | 'skip' | 'restore') => Promise<boolean>;
}) {
  const state = slotState(s);
  const row = useRef<HTMLLIElement>(null);
  // The pressed button usually goes with the change (Skip → Restore), and the new plan commits after the write
  // resolves. So the row re-homes focus as that commit lands: on its first button, else its title — never left on
  // <body> (CONVENTIONS → focus-return). A refused change keeps its button, and focus with it.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const li = row.current;
    if (!li || li.contains(document.activeElement)) return;
    const next = li.querySelector<HTMLElement>('button') ?? li.querySelector<HTMLElement>('a');
    if (next) returnFocus(next);
  }, [s.status, s.slug, s.swappedFrom]);
  const act = (action: 'swap' | 'skip' | 'restore') => async () => {
    if (!canStart()) return; // a second tap mid-write: the first tap's own arm stands
    refocus.current = true;
    if (!(await onChange(s, action))) refocus.current = false;
  };
  const quiet = (label: string, action: 'swap' | 'skip' | 'restore', name: string) => (
    <Button
      variant="quiet"
      size="sm"
      aria-label={`${name} — ${s.title}`}
      aria-disabled={busy || undefined}
      onClick={act(action)}
    >
      {label}
    </Button>
  );
  return (
    <li ref={row} className="flex flex-col gap-1 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Text size="xs" tone="subtle" weight="medium">
            {SLOT_KIND_LABEL[s.kind]}
            {s.difficulty ? ` · ${s.difficulty}` : ''} · {s.capMin} min
          </Text>
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className={cx(
              'font-medium underline-offset-2 hover:underline',
              s.status === 'skipped' ? 'text-ink-subtle' : 'text-ink',
            )}
          >
            {/* The strike sits on the title alone; a no-break space keeps ↗ on its last line. */}
            <span className={cx(s.status === 'skipped' && 'line-through')}>{s.title}</span>
            <span aria-hidden className="text-ink-subtle">
              {'\u00A0↗'}
            </span>
          </a>
        </div>
        {s.status !== 'open' && (
          <Text size="sm" tone={state.tone} className="shrink-0 text-right">
            {state.label}
          </Text>
        )}
      </div>
      <Text size="xs" tone="muted">
        {s.aiWhy ?? s.reason}
      </Text>
      <div className="-ml-2 flex flex-wrap items-center gap-1">
        {s.status === 'in-progress' && s.sittingId && (
          <Link to={sittingPath(s.sittingId)} className="px-2 text-sm text-teal hover:underline">
            Open sitting →
          </Link>
        )}
        {s.status === 'done' && s.sittingId && (
          <Link
            to={sittingPath(s.sittingId)}
            className="px-2 text-sm text-ink-muted hover:underline"
          >
            Review →
          </Link>
        )}
        {/* Another only while an easier unseen problem is left in the pattern (the engine's own pick). */}
        {s.status === 'open' &&
          s.alternatives.length > 0 &&
          quiet('Another', 'swap', 'Another problem')}
        {s.status === 'open' && quiet('Skip today', 'skip', 'Skip today')}
        {(s.status === 'skipped' || (s.status === 'open' && s.swappedFrom)) &&
          quiet('Restore', 'restore', 'Restore')}
      </div>
    </li>
  );
}
