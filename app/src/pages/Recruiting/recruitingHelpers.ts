import type { LeetcodeAttempt, LeetcodeVerdict } from '@aperture/shared';

// Pure view helpers for the Recruiting page. attempt-count is DERIVED here (never stored), and verdict
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

export interface AttemptRow {
  attempt: LeetcodeAttempt;
  attemptNo: number; // 1-based ordinal among this problem's attempts, chronological
  problemAttempts: number; // total attempts for this problem
}

// Assign each attempt its per-problem chronological ordinal, then return newest-first for display.
export function withAttemptOrdinals(attempts: LeetcodeAttempt[]): AttemptRow[] {
  const asc = [...attempts].sort((a, b) => a.submittedAt - b.submittedAt);
  const totals = new Map<string, number>();
  for (const a of asc) totals.set(a.problemSlug, (totals.get(a.problemSlug) ?? 0) + 1);
  const seen = new Map<string, number>();
  const rows = asc.map((attempt): AttemptRow => {
    const n = (seen.get(attempt.problemSlug) ?? 0) + 1;
    seen.set(attempt.problemSlug, n);
    return { attempt, attemptNo: n, problemAttempts: totals.get(attempt.problemSlug)! };
  });
  return rows.reverse();
}

export interface RecruitingSummary {
  problems: number; // distinct problems attempted
  attempts: number; // total submissions
  solved: number; // distinct problems with ≥1 accepted
}

export function summarize(attempts: LeetcodeAttempt[]): RecruitingSummary {
  const slugs = new Set<string>();
  const solved = new Set<string>();
  for (const a of attempts) {
    slugs.add(a.problemSlug);
    if (a.verdict === 'accepted') solved.add(a.problemSlug);
  }
  return { problems: slugs.size, attempts: attempts.length, solved: solved.size };
}
