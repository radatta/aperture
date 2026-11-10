import { describe, expect, it } from 'vitest';
import { lcLangName, normalizeVerdict } from './leetcode';

describe('normalizeVerdict', () => {
  it('maps status_code as the primary signal', () => {
    expect(normalizeVerdict(10)).toBe('accepted');
    expect(normalizeVerdict(11)).toBe('wrong_answer');
    expect(normalizeVerdict(12)).toBe('memory_limit');
    expect(normalizeVerdict(14)).toBe('time_limit');
    expect(normalizeVerdict(15)).toBe('runtime_error');
    expect(normalizeVerdict(20)).toBe('compile_error');
  });

  it('falls back to status_msg text when the code is absent or unknown', () => {
    expect(normalizeVerdict(null, 'Accepted')).toBe('accepted');
    expect(normalizeVerdict(undefined, 'Wrong Answer')).toBe('wrong_answer');
    expect(normalizeVerdict(999, 'Time Limit Exceeded')).toBe('time_limit');
  });

  it('returns other for anything unrecognized', () => {
    expect(normalizeVerdict(999)).toBe('other');
    expect(normalizeVerdict(null, 'Some New Verdict')).toBe('other');
    expect(normalizeVerdict()).toBe('other');
  });
});

describe('lcLangName', () => {
  it('names LeetCode’s numeric language ids, passes text through, and has no name for an unknown id', () => {
    expect(lcLangName('11')).toBe('Python3');
    expect(lcLangName('0')).toBe('C++');
    expect(lcLangName('27')).toBe('Vanilla JS');
    expect(lcLangName('python3')).toBe('python3');
    expect(lcLangName('999')).toBeNull();
    expect(lcLangName('')).toBeNull();
    expect(lcLangName(null)).toBeNull();
    expect(lcLangName(undefined)).toBeNull();
  });
});
