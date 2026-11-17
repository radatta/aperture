import {
  fmtPastDay,
  fmtSpokenDay,
  isPatternId,
  PATTERN_NAMES,
  problemStatus,
} from '@aperture/shared';
import type {
  Difficulty,
  PatternCoverage,
  PatternId,
  ProblemRecord,
  ProblemState,
  ProblemStatus,
} from '@aperture/shared';

// The Progress tab's pure helpers (docs/areas/recruiting/coach.md → The Progress tab): words, the Solves rows and
// filters, and the URL state (the view, the open pattern, Left only and the filters live in the query string, so a
// reload or Back keeps them).

export type ProgressView = 'map' | 'solves' | 'trends';
export const PROGRESS_VIEWS: { value: ProgressView; label: string }[] = [
  { value: 'map', label: 'Map' },
  { value: 'solves', label: 'Solves' },
  { value: 'trends', label: 'Trends' },
];
export const parseView = (v: string | null): ProgressView =>
  v === 'solves' || v === 'trends' ? v : 'map';
export const parsePattern = (v: string | null): PatternId | null =>
  v && isPatternId(v) && v !== 'other' ? v : null;

export const STATE_LABEL: Record<ProblemState, string> = {
  untried: 'Not tried',
  earlier: 'Solved before',
  clean: 'Clean',
  solved: 'Solved',
  peeked: 'Peeked',
  'not-yet': 'Not yet',
};
// Teal for clean, gold for the rest that went somewhere, muted for history: never red.
export const stateTone = (s: ProblemState): 'teal' | 'gold' | 'muted' =>
  s === 'clean' ? 'teal' : s === 'solved' || s === 'peeked' || s === 'not-yet' ? 'gold' : 'muted';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The re-solve line: due, next, graduated, or out of the queue (history only); null when untried.
export function reSolveText(st: ProblemStatus, today: string): string | null {
  if (st.dueSince)
    return st.dueSince === today
      ? 'Re-solve due today'
      : `Re-solve due since ${fmtSpokenDay(st.dueSince, today)}`;
  if (st.nextDue) return `Next re-solve ${fmtSpokenDay(st.nextDue, today)}`;
  if (st.graduated) return 'Graduated: no more re-solves';
  if (st.state === 'earlier' || st.state === 'not-yet') return 'Not in the re-solve queue';
  return null;
}
const liveTries = (r: ProblemRecord) => r.tries.filter((t) => !t.historical);
export function triesText(r: ProblemRecord): string {
  const n = liveTries(r).length;
  return n ? `${n} ${n === 1 ? 'try' : 'tries'}` : 'solved before';
}
// The first live try: what the gap is measured on. A history-only problem has none.
export function firstTryText(r: ProblemRecord): string {
  const t = liveTries(r)[0];
  return !t ? '–' : t.outcome === 'failed' ? 'not yet' : t.outcome;
}
export const lastTriedText = (r: ProblemRecord, today: string) => cap(fmtPastDay(r.lastDay, today));

// A pattern card's accessible name: everything the cells say, in words.
export function patternCardName(p: PatternCoverage, focus: boolean): string {
  return [
    PATTERN_NAMES[p.pattern],
    `${p.done} of ${p.total} done`,
    p.tried && `${p.tried} tried`,
    p.untried && `${p.untried} not tried`,
    p.due && `${p.due} re-solve${p.due === 1 ? '' : 's'} due`,
    focus && 'focus',
  ]
    .filter(Boolean)
    .join(', ');
}

// --- Solves ---
export type SolveStatus = Exclude<ProblemState, 'untried'> | 'due' | 'graduated';
export const SOLVE_STATUSES: { value: SolveStatus; label: string }[] = [
  { value: 'clean', label: 'Clean' },
  { value: 'solved', label: 'Solved' },
  { value: 'not-yet', label: 'Not yet' },
  { value: 'peeked', label: 'Peeked' },
  { value: 'due', label: 'Re-solve due' },
  { value: 'graduated', label: 'Graduated' },
  { value: 'earlier', label: 'Solved before' },
];
export const DIFFICULTIES: Difficulty[] = ['Easy', 'Medium', 'Hard'];
export interface SolveFilters {
  pattern: PatternId | null;
  status: SolveStatus | null;
  difficulty: Difficulty | null;
}
export function parseFilters(q: URLSearchParams): SolveFilters {
  const status = q.get('status');
  const difficulty = q.get('difficulty');
  return {
    pattern: q.get('pattern') === 'other' ? 'other' : parsePattern(q.get('pattern')),
    status: SOLVE_STATUSES.some((s) => s.value === status) ? (status as SolveStatus) : null,
    difficulty: DIFFICULTIES.includes(difficulty as Difficulty) ? (difficulty as Difficulty) : null,
  };
}
export interface SolveRow {
  record: ProblemRecord;
  status: ProblemStatus;
}
// Every touched problem, the newest try first.
export const solveRows = (records: readonly ProblemRecord[], today: string): SolveRow[] =>
  [...records]
    .sort((a, b) => b.lastDay.localeCompare(a.lastDay) || a.title.localeCompare(b.title))
    .map((record) => ({ record, status: problemStatus(record, today) }));
export function matchesSolve({ record, status }: SolveRow, f: SolveFilters): boolean {
  if (f.pattern && record.pattern !== f.pattern) return false;
  if (f.difficulty && record.difficulty !== f.difficulty) return false;
  if (!f.status) return true;
  if (f.status === 'due') return !!status.dueSince;
  if (f.status === 'graduated') return status.graduated;
  return status.state === f.status;
}
// A row's status tag: graduated reads over its last outcome.
export const solveTag = (st: ProblemStatus): string =>
  st.graduated ? 'Graduated' : STATE_LABEL[st.state];
