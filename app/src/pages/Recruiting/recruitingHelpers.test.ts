import { describe, expect, it } from 'vitest';
import type { LeetcodeAttempt } from '@aperture/shared';
import { summarize, verdictLabel, verdictTone, withAttemptOrdinals } from './recruitingHelpers';

const mk = (over: Partial<LeetcodeAttempt>): LeetcodeAttempt => ({
  id: 'x',
  userId: 'local',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  day: '2026-08-01',
  problemSlug: 's',
  problemTitle: 'T',
  verdict: 'accepted',
  submittedAt: 0,
  lang: 'python3',
  runtimeMs: null,
  memory: null,
  leetcodeSubmissionId: 'id',
  frontendId: null,
  difficulty: null,
  topicTags: null,
  ...over,
});

describe('recruitingHelpers', () => {
  it('derives per-problem chronological ordinals, returns newest-first', () => {
    const rows = withAttemptOrdinals([
      mk({ id: 'a', problemSlug: 'two-sum', submittedAt: 100 }),
      mk({ id: 'b', problemSlug: 'two-sum', submittedAt: 200 }),
      mk({ id: 'c', problemSlug: 'add-two', submittedAt: 150 }),
    ]);
    expect(rows.map((r) => r.attempt.id)).toEqual(['b', 'c', 'a']); // reverse-chron
    const b = rows.find((r) => r.attempt.id === 'b')!;
    expect(b.attemptNo).toBe(2);
    expect(b.problemAttempts).toBe(2);
    const c = rows.find((r) => r.attempt.id === 'c')!;
    expect(c.attemptNo).toBe(1);
    expect(c.problemAttempts).toBe(1);
  });

  it('summarizes distinct problems, total attempts, and solved-count', () => {
    const s = summarize([
      mk({ problemSlug: 'two-sum', verdict: 'wrong_answer' }),
      mk({ problemSlug: 'two-sum', verdict: 'accepted' }),
      mk({ problemSlug: 'add-two', verdict: 'wrong_answer' }),
    ]);
    expect(s).toEqual({ problems: 2, attempts: 3, solved: 1 });
  });

  it('labels verdicts and keeps tone non-punitive (accepted teal, others gold — never red)', () => {
    expect(verdictLabel('wrong_answer')).toBe('Wrong Answer');
    expect(verdictLabel('accepted')).toBe('Accepted');
    expect(verdictTone('accepted')).toBe('teal');
    expect(verdictTone('runtime_error')).toBe('gold');
    expect(verdictTone('wrong_answer')).toBe('gold');
  });
});
