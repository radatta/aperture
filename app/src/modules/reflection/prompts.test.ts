import { describe, it, expect } from 'vitest';
import { REFLECTION_PROMPTS, reflectionPromptFor } from './prompts';

describe('reflectionPromptFor', () => {
  it('returns a prompt from the list', () => {
    expect(REFLECTION_PROMPTS).toContain(reflectionPromptFor('2026-08-03'));
  });
  it('is stable for a given day', () => {
    expect(reflectionPromptFor('2026-08-03')).toBe(reflectionPromptFor('2026-08-03'));
  });
  it('varies across days (not all identical)', () => {
    const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'];
    const uniq = new Set(days.map(reflectionPromptFor));
    expect(uniq.size).toBeGreaterThan(1);
  });
});
