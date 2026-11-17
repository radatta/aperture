import { addDays, fmtDayHeading, isSittingOpen, sittingMetrics } from '@aperture/shared';
import type {
  AttemptOutcome,
  CauseTag,
  CoachSlot,
  CoachToday,
  LeetcodeVerdict,
  Sitting,
  SlotKind,
} from '@aperture/shared';

// Pure view helpers for the Recruiting page. Everything here is DERIVED from the sitting's fold, and verdict
// presentation stays non-punitive — accepted reads positive, everything else reads "attention", never a
// red/guilt signal (the app's anti-guilt rule).

export const VERDICT_LABEL: Record<LeetcodeVerdict, string> = {
  accepted: 'Accepted',
  wrong_answer: 'Wrong Answer',
  time_limit: 'Time Limit',
  runtime_error: 'Runtime Error',
  compile_error: 'Compile Error',
  memory_limit: 'Memory Limit',
  other: 'Other',
};

export function verdictLabel(v: LeetcodeVerdict): string {
  return VERDICT_LABEL[v] ?? 'Other';
}

// accepted → teal (positive); everything else → gold (attention, never punitive red).
export function verdictTone(v: LeetcodeVerdict): 'teal' | 'gold' {
  return v === 'accepted' ? 'teal' : 'gold';
}

// A sitting's one-line outcome, the headline being whether the FIRST submit was accepted. Accepted reads
// teal; anything else gold or muted — attention, never a red "you failed" (the anti-guilt rule).
export interface SittingOutcome {
  label: string;
  tone: 'teal' | 'gold' | 'muted';
}
export function sittingOutcome(s: Sitting, now: number): SittingOutcome {
  const m = sittingMetrics(s);
  const submits = s.summary.submits;
  if (m.firstSubmitAccepted === null)
    return { label: isSittingOpen(s, now) ? 'no submit yet' : 'no submit', tone: 'muted' };
  if (m.firstSubmitAccepted) return { label: 'first submit accepted', tone: 'teal' };
  if (m.submitsBeforeAccepted !== null)
    return { label: `accepted on submit ${m.submitsBeforeAccepted + 1}`, tone: 'gold' };
  return {
    label: `not accepted · ${submits} ${submits === 1 ? 'submit' : 'submits'}`,
    tone: 'gold',
  };
}

export interface SittingsSummary {
  sittings: number;
  problems: number; // distinct problems sat
  firstTry: number; // sittings whose first submit was accepted
}
export function summarizeSittings(sittings: Sitting[]): SittingsSummary {
  return {
    sittings: sittings.length,
    problems: new Set(sittings.map((s) => s.problemSlug)).size,
    firstTry: sittings.filter((s) => sittingMetrics(s).firstSubmitAccepted === true).length,
  };
}

// Newest day first, the open sitting pulled out to sit above them all.
export function groupSittings(sittings: Sitting[]): {
  open: Sitting[];
  days: [string, Sitting[]][];
} {
  const open = sittings.filter((s) => s.status === 'active');
  const byDay = new Map<string, Sitting[]>();
  for (const s of [...sittings].sort((a, b) => b.startedAt - a.startedAt)) {
    if (s.status === 'active') continue;
    byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  }
  return { open, days: [...byDay].sort(([a], [b]) => (a < b ? 1 : -1)) };
}

// --- The coach (docs/areas/recruiting/coach.md) ---
export const SLOT_KIND_LABEL: Record<SlotKind, string> = {
  'carry-over': 'Carry-over',
  new: 'New',
  're-solve': 'Re-solve',
  stretch: 'Stretch',
};

// A slot's state on the card: done reads teal only when clean, gold otherwise — never red.
export function slotState(s: Pick<CoachSlot, 'status' | 'outcome'>): SittingOutcome {
  if (s.status === 'in-progress') return { label: 'in progress', tone: 'gold' };
  if (s.status === 'skipped') return { label: 'skipped today', tone: 'muted' };
  if (s.status !== 'done') return { label: 'open', tone: 'muted' };
  const label: Record<AttemptOutcome, string> = {
    clean: 'done · clean',
    solved: 'done · solved',
    failed: 'done · not yet',
  };
  return s.outcome
    ? { label: label[s.outcome], tone: s.outcome === 'clean' ? 'teal' : 'gold' }
    : { label: 'done', tone: 'muted' };
}

// A queue day as the 48-hour list reads it: due now, tomorrow, or the weekday heading.
export function dueLabel(dueDay: string, today: string): string {
  if (dueDay <= today) return 'due';
  if (dueDay === addDays(today, 1)) return 'tomorrow';
  return fmtDayHeading(dueDay);
}

// The cause the review form starts on when none is saved: no trace, when the extension saw the trace skipped or
// a submit with none before it, or when the first submit failed with no run before it.
export function suggestedCause(s: Pick<Sitting, 'summary'>): CauseTag | null {
  const trace = s.summary.coach?.trace;
  if (trace === 'skipped' || trace === 'none') return 'no-trace';
  const first = s.summary.firstSubmit;
  if (first && first.verdict !== 'accepted' && s.summary.runsBeforeFirstSubmit === 0)
    return 'no-trace';
  return null;
}

// The due re-solves beyond today's live slots: one that's a slot today is counted there; one skipped, or swapped
// away, is still due and counted here. The card's 48-hour list and Home's line use the same rule.
export const dueBeyondSlots = (t: Pick<CoachToday, 'due' | 'slots'>) =>
  t.due.filter((q) => !t.slots.some((s) => s.status !== 'skipped' && s.slug === q.slug));

// Home's morning line: "LeetCode · 4 today · +1 re-solve due". A floor day names its one problem; a day with
// every slot done or skipped says so.
export function coachGlance(t: CoachToday): string {
  const live = t.slots.filter((s) => s.status !== 'skipped');
  const left = live.filter((s) => s.status !== 'done').length;
  const head =
    t.floor?.on && !t.floor.done
      ? `floor day · ${t.floor.title}`
      : !live.length
        ? 'nothing planned today'
        : left === 0
          ? `${live.length} of ${live.length} done`
          : left < live.length
            ? `${left} left today`
            : `${left} today`;
  const due = dueBeyondSlots(t).length;
  return `LeetCode · ${head}${due ? ` · +${due} ${due === 1 ? 're-solve' : 're-solves'} due` : ''}`;
}
