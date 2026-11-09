import { sittingMetrics } from '@aperture/shared';
import type { LeetcodeVerdict, Sitting } from '@aperture/shared';

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
export function sittingOutcome(s: Sitting): SittingOutcome {
  const m = sittingMetrics(s);
  const submits = s.summary.submits;
  if (m.firstSubmitAccepted === null) return { label: 'no submit yet', tone: 'muted' };
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
