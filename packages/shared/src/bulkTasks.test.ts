import { describe, it, expect } from 'vitest';
import { parseBulkTasks, toCreateInputs } from './bulkTasks';

const CATS = [
  { id: 'c1', label: 'Admin' },
  { id: 'c2', label: 'Deep Work' },
  { id: 'c3', label: 'Recruiting' },
];

const parse = (text: string, existing?: ReadonlySet<string>) =>
  parseBulkTasks(text, CATS, existing);
const only = (text: string) => parse(text).lines[0]!;

describe('parseBulkTasks — titles', () => {
  it('a bare line is a title-only task', () => {
    const l = only('email coach');
    expect(l.title).toBe('email coach');
    expect(l.errors).toEqual([]);
    expect(l.estimateMin).toBeNull();
    expect(l.categoryId).toBeNull();
    expect(l.dueDay).toBeNull();
  });
  it('trims the title but never rewrites its interior', () => {
    expect(only('  fix the thing  ').title).toBe('fix the thing');
  });
  it("'#','~','due:' are literal before the separator", () => {
    const l = only('fix issue #42 ~ due: stuff');
    expect(l.title).toBe('fix issue #42 ~ due: stuff');
    expect(l.errors).toEqual([]);
    expect(l.categoryLabel).toBeNull();
  });
  it('an empty title is a hard error', () => {
    expect(only(' | ~30').errors).toContain('empty title');
  });
});

describe('parseBulkTasks — tokens', () => {
  it('parses all three tokens together', () => {
    const l = only('email coach | ~30 #Admin due:2026-09-25');
    expect(l.title).toBe('email coach');
    expect(l.estimateMin).toBe(30);
    expect(l.categoryId).toBe('c1');
    expect(l.dueDay).toBe('2026-09-25');
    expect(l.errors).toEqual([]);
  });
  it('accepts the tokens in any order', () => {
    const l = only('email coach | due:2026-09-25 #Admin ~30');
    expect(l.estimateMin).toBe(30);
    expect(l.categoryId).toBe('c1');
    expect(l.dueDay).toBe('2026-09-25');
  });
  it('matches a quoted multi-word label, case-insensitively', () => {
    expect(only('plan | #"Deep Work"').categoryId).toBe('c2');
    expect(only('plan | #"deep work"').categoryId).toBe('c2');
    expect(only('plan | #recruiting').categoryId).toBe('c3');
  });
});

describe('parseBulkTasks — estimate errors', () => {
  it('rejects units, zero, decimals, and empty', () => {
    for (const bad of ['~30m', '~0', '~1.5', '~', '~-5']) {
      const l = only(`t | ${bad}`);
      expect(l.errors.length).toBeGreaterThan(0);
      expect(l.estimateMin).toBeNull();
    }
  });
});

describe('parseBulkTasks — due errors', () => {
  it('rejects impossible, unpadded, and capitalized keyword', () => {
    expect(only('t | due:2026-02-30').errors.length).toBeGreaterThan(0);
    expect(only('t | due:2026-2-5').errors.length).toBeGreaterThan(0);
    // capital 'Due:' is not the keyword → unrecognized token
    expect(only('t | Due:2026-09-25').errors.length).toBeGreaterThan(0);
  });
});

describe('parseBulkTasks — category resolution', () => {
  it('an unknown label is a yellow warning, task created uncategorised', () => {
    const l = only('t | #Nope');
    expect(l.errors).toEqual([]);
    expect(l.warnings.length).toBe(1);
    expect(l.categoryId).toBeNull();
    expect(l.categoryLabel).toBe('Nope');
  });
  it('an ambiguous label is a hard error', () => {
    const dupe = [
      { id: 'a', label: 'Ops' },
      { id: 'b', label: 'ops' },
    ];
    const l = parseBulkTasks('t | #Ops', dupe).lines[0]!;
    expect(l.errors.length).toBe(1);
    expect(l.categoryId).toBeNull();
  });
  it('an unterminated quote is a hard error', () => {
    expect(only('t | #"Deep Work').errors.length).toBeGreaterThan(0);
  });
  it('an empty label is a hard error, bare or quoted', () => {
    expect(only('t | #').errors.some((e) => /empty category label/.test(e))).toBe(true);
    expect(only('t | #""').errors.some((e) => /empty category label/.test(e))).toBe(true);
  });
});

describe('parseBulkTasks — token structure errors', () => {
  it('a repeated token kind is a hard error', () => {
    expect(only('t | ~30 ~40').errors.length).toBeGreaterThan(0);
    expect(only('t | #Admin #Recruiting').errors.length).toBeGreaterThan(0);
  });
  it('an unrecognized token is a hard error', () => {
    expect(only('t | banana').errors.length).toBeGreaterThan(0);
  });
  it("a trailing ' |' with no tokens is a hard error", () => {
    expect(only('t | ').errors.length).toBeGreaterThan(0);
  });
  it("a stray '|' in the title is a hard error", () => {
    expect(only('a|b').errors.length).toBeGreaterThan(0);
    expect(only('email coach |').errors.length).toBeGreaterThan(0);
  });
  it('a list marker is a hard error (never silently stripped)', () => {
    expect(only('- email coach').errors.length).toBeGreaterThan(0);
    expect(only('1. email coach').errors.length).toBeGreaterThan(0);
    expect(only('* email coach').errors.length).toBeGreaterThan(0);
  });
});

describe('parseBulkTasks — duplicates (yellow)', () => {
  it('warns on a duplicate title within the paste', () => {
    const p = parse('review PR\nreview PR');
    expect(p.lines[0]!.warnings).toEqual([]);
    expect(p.lines[1]!.warnings).toContain('duplicate title in this paste');
    expect(p.canSubmit).toBe(true); // yellow does not block
  });
  it('warns when a live task already has the title', () => {
    const l = parse('email coach', new Set(['email coach'])).lines[0]!;
    expect(l.warnings).toContain('a live task already has this title');
    expect(l.errors).toEqual([]);
  });
});

describe('parseBulkTasks — line handling', () => {
  it('skips blank lines but preserves the true line number', () => {
    const p = parse('one\n\n\ntwo');
    expect(p.lines.length).toBe(2);
    expect(p.lines[0]!.line).toBe(1);
    expect(p.lines[1]!.line).toBe(4);
  });
  it('normalises CRLF', () => {
    const p = parse('one\r\ntwo');
    expect(p.lines.map((l) => l.title)).toEqual(['one', 'two']);
  });
});

describe('parseBulkTasks — submit gating', () => {
  it('one red among greens blocks the whole batch', () => {
    const p = parse('good one\nbad | ~oops\ngood two');
    expect(p.lines.length).toBe(3);
    expect(p.errorCount).toBe(1);
    expect(p.canSubmit).toBe(false);
  });
  it('empty text cannot submit', () => {
    const p = parse('   \n  ');
    expect(p.lines.length).toBe(0);
    expect(p.canSubmit).toBe(false);
  });
  it('all-clean submits', () => {
    expect(parse('a\nb | ~15').canSubmit).toBe(true);
  });
});

describe('toCreateInputs', () => {
  it('maps clean lines to inputs, in paste order, with resolved fields', () => {
    const p = parse('first | ~30 #Admin due:2026-09-25\nsecond');
    const inputs = toCreateInputs(p);
    expect(inputs).toEqual([
      { title: 'first', categoryId: 'c1', estimateMin: 30, dueDay: '2026-09-25' },
      { title: 'second', categoryId: null, estimateMin: null, dueDay: null },
    ]);
  });
  it('leaves categoryId null for an unmatched label', () => {
    expect(toCreateInputs(parse('t | #Nope'))[0]!.categoryId).toBeNull();
  });
});
