// Synthetic legacy LeetCode rows (the pre-sittings capture, `lc#`) for tests and the stub's seed: catalog slugs,
// made-up days, ids and times. Nothing writes these rows any more, so tests hand them to the store directly.
import { addDays } from './dates';
import type { LeetcodeVerdict, LegacyLeetcodeAttempt } from './types';

export function legacyRow(
  slug: string,
  day: string,
  verdict: LeetcodeVerdict,
  at: number,
  n: number,
): LegacyLeetcodeAttempt {
  return {
    id: `01LEGACY${String(n).padStart(18, '0')}`,
    userId: 'u',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    day,
    problemSlug: slug,
    problemTitle: slug
      .split('-')
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(' '),
    verdict,
    submittedAt: at,
    lang: 'python3',
    runtimeMs: null,
    memory: null,
    leetcodeSubmissionId: `sub-${n}`,
    frontendId: null,
    difficulty: null,
    topicTags: null,
  };
}

// Three groups ~a month before `today`: contains-duplicate solved on the second submit, valid-anagram accepted
// first try, two-sum (excluded by default as extension testing).
export function legacyFixture(today: string, base: number): LegacyLeetcodeAttempt[] {
  const d1 = addDays(today, -30);
  const d2 = addDays(today, -29);
  return [
    legacyRow('contains-duplicate', d1, 'wrong_answer', base, 1),
    legacyRow('contains-duplicate', d1, 'accepted', base + 60_000, 2),
    legacyRow('valid-anagram', d2, 'accepted', base + 86_400_000, 3),
    legacyRow('two-sum', d2, 'accepted', base + 86_400_000 + 60_000, 4),
  ];
}
