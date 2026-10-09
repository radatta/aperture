import { dayKey, findOpenRollTask, type Roll, type Task } from '@aperture/shared';

// The Roll tie: a Flux session counts as today's rep of the Roll linked in Settings (docs/areas/flux),
// so the estimate-vs-actual calibration rides Flux with no new machinery. Pure — the hook and strip
// live in RepTie.tsx.

export type RepTie =
  | { readonly kind: 'unlinked' }
  /** Linked, but no open rep and none done today: offer "Pick <roll> for today". */
  | { readonly kind: 'none'; readonly roll: Roll }
  /** An open rep (backlog or planned) — the first finished set starts it. */
  | { readonly kind: 'ready'; readonly roll: Roll; readonly task: Task }
  | { readonly kind: 'in_progress'; readonly roll: Roll; readonly task: Task }
  | { readonly kind: 'done'; readonly roll: Roll; readonly task: Task };

export function repTie(
  rollId: string | null,
  rolls: readonly Roll[],
  tasks: Task[],
  today: string,
  dayStartHour: number,
): RepTie {
  const roll = rollId ? rolls.find((r) => r.id === rollId && r.active) : undefined;
  if (!roll) return { kind: 'unlinked' };
  const open = findOpenRollTask(tasks, roll.id);
  if (open?.status === 'in_progress') return { kind: 'in_progress', roll, task: open };
  if (open) return { kind: 'ready', roll, task: open };
  const doneToday = tasks.find(
    (t) =>
      t.rollId === roll.id &&
      t.status === 'done' &&
      t.completedAt != null &&
      dayKey(t.completedAt, dayStartHour) === today,
  );
  return doneToday ? { kind: 'done', roll, task: doneToday } : { kind: 'none', roll };
}

/**
 * The Actual to prefill when a session ends: the session's minutes, or the rep's live elapsed if
 * that's more (a rep started earlier from Home, or with a focus timer running) — never undercount.
 */
export function prefillMinutes(sessionMs: number, liveElapsedMin: number): number {
  return Math.max(Math.round(sessionMs / 60_000), Math.round(liveElapsedMin));
}
