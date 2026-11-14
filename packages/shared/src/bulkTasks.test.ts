import { describe, it, expect } from 'vitest';
import {
  hasTaskTokens,
  parseBulkTasks,
  parseTaskLine,
  toCreateInput,
  toCreateInputs,
  tokenAtCaret,
} from './bulkTasks';

const CATS = [
  { id: 'c1', label: 'Admin' },
  { id: 'c2', label: 'Deep Work' },
  { id: 'c3', label: 'Recruiting' },
];

const PLACES = [
  { slug: 'grocer', name: 'Grocer' },
  { slug: 'thrift-jos', name: "Thrift Jo's" },
];

const parse = (text: string, existing?: ReadonlySet<string>) =>
  parseBulkTasks(text, CATS, PLACES, existing);
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

describe('parseBulkTasks — due time (@HH:MM)', () => {
  it('parses the day and the 24h time', () => {
    const l = only('pset | due:2026-10-09@17:00 ~90');
    expect(l).toMatchObject({ dueDay: '2026-10-09', dueTime: '17:00', estimateMin: 90 });
    expect(l.errors).toEqual([]);
    expect(only('pset | due:2026-10-09').dueTime).toBeNull();
  });
  it('a bad or missing time is red and sets neither field', () => {
    for (const bad of [
      'due:2026-10-09@5pm',
      'due:2026-10-09@5:00',
      'due:2026-10-09@24:00',
      'due:2026-10-09@',
    ]) {
      const l = only(`t | ${bad}`);
      expect(l.errors.join()).toMatch(/invalid due time/);
      expect(l.dueDay).toBeNull();
      expect(l.dueTime).toBeNull();
    }
    expect(only('t | due:2026-02-30@10:00').errors.join()).toMatch(/invalid due date/);
  });
  it('is literal inside notes', () => {
    const l = only('t | notes:"due:2026-10-09@17:00"');
    expect(l.dueDay).toBeNull();
    expect(l.notes).toBe('due:2026-10-09@17:00');
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
    const l = parseBulkTasks('t | #Ops', dupe, PLACES).lines[0]!;
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
      {
        title: 'first',
        categoryId: 'c1',
        estimateMin: 30,
        dueDay: '2026-09-25',
        dueTime: null,
        notes: null,
        place: null,
      },
      {
        title: 'second',
        categoryId: null,
        estimateMin: null,
        dueDay: null,
        dueTime: null,
        notes: null,
        place: null,
      },
    ]);
  });
  it('leaves categoryId null for an unmatched label', () => {
    expect(toCreateInputs(parse('t | #Nope'))[0]!.categoryId).toBeNull();
  });
});

describe('parseBulkTasks — notes token', () => {
  it('parses notes in any position, with \\n as a newline', () => {
    const l = only(
      'finish the pset | ~90 #"Deep Work" due:2026-09-25 notes:"Ch. 4 q1-8\\n- q6 hint: use the lemma\\nhttps://example.org/pset4"',
    );
    expect(l.errors).toEqual([]);
    expect(l.estimateMin).toBe(90);
    expect(l.categoryId).toBe('c2');
    expect(l.notes).toBe('Ch. 4 q1-8\n- q6 hint: use the lemma\nhttps://example.org/pset4');
    const first = only('t | notes:"a b" ~15');
    expect(first.notes).toBe('a b');
    expect(first.estimateMin).toBe(15);
  });
  it('keeps tokens inside the quotes literal, and trims the value', () => {
    const l = only('t | notes:"  ~30 #Admin due:2026-01-01 | x  "');
    expect(l.errors).toEqual([]);
    expect(l.notes).toBe('~30 #Admin due:2026-01-01 | x');
    expect(l.estimateMin).toBeNull();
    expect(l.categoryId).toBeNull();
  });
  it('flows into the create inputs', () => {
    expect(toCreateInputs(parse('t | notes:"hi"'))[0]!.notes).toBe('hi');
  });
  it.each([
    ['t | notes:"never closed', /unterminated notes/],
    ['t | notes:""', /empty notes/],
    ['t | notes:"  \\n "', /empty notes/],
    ['t | notes:"say "hi" ok"', /can't contain '"'/],
    ['t | notes:"a" notes:"b"', /duplicate notes/],
    ['t | Notes:"a"', /lowercase 'notes:'/],
    ['t | NOTES:"a"', /lowercase 'notes:'/],
    ['t | notes:bare', /need quotes/],
  ])('%j is red', (line, err) => {
    const l = only(line);
    expect(l.errors.some((e) => err.test(e))).toBe(true);
  });
  it('rejects notes over the cap after unescaping, and accepts exactly the cap', () => {
    expect(only(`t | notes:"${'x'.repeat(4998)}\\ny"`).errors).toEqual([]); // \n counts as one
    expect(only(`t | notes:"${'x'.repeat(5000)}"`).errors).toEqual([]);
    expect(only(`t | notes:"${'x'.repeat(5000)}\\n"`).errors).toEqual([]); // trailing \n trimmed
    expect(only(`t | notes:"${'x'.repeat(5001)}"`).errors[0]).toMatch(/5,001 characters/);
  });
  it('a notes: before the separator is part of the title, with a warning', () => {
    const l = only('read notes:"ch 4"');
    expect(l.title).toBe('read notes:"ch 4"');
    expect(l.notes).toBeNull();
    expect(l.errors).toEqual([]);
    expect(l.warnings[0]).toMatch(/tokens go after ' \| '/);
  });
  it('\\\\ is a literal backslash, so LaTeX and paths survive', () => {
    expect(only('t | notes:"show \\\\nabla f \\\\neq 0"').notes).toBe('show \\nabla f \\neq 0');
    expect(only('t | notes:"C:\\\\\\\\new"').notes).toBe('C:\\\\new');
    expect(only('t | notes:"a\\\\\\nb"').notes).toBe('a\\\nb'); // \\ then \n
  });
});

describe('parseTaskLine — capture', () => {
  it('matches parseBulkTasks on a single line', () => {
    for (const raw of [
      'email coach',
      'pset | ~90 #"Deep Work" due:2026-09-25',
      'x | ~30m',
      'x | #Nope',
      'read | notes:"a\\nb"',
    ])
      expect(parseTaskLine(raw, CATS, PLACES)).toEqual(only(raw));
  });
  it('a line break is a hard error, never split', () => {
    const l = parseTaskLine('a\nb | ~5', CATS, PLACES);
    expect(l.errors.some((e) => e.includes('single line'))).toBe(true);
  });
  it('never warns about duplicate titles', () => {
    expect(parseTaskLine('email coach', CATS, PLACES).warnings).toEqual([]);
  });
  it('hasTaskTokens gates on the exact separator, untrimmed', () => {
    expect(hasTaskTokens('a | ~5')).toBe(true);
    expect(hasTaskTokens('a | ')).toBe(true);
    expect(hasTaskTokens('a|b')).toBe(false);
    expect(hasTaskTokens('a |')).toBe(false);
  });
  it('toCreateInput maps every field', () => {
    expect(
      toCreateInput(parseTaskLine('memo | ~30 #admin due:2026-10-03 notes:"x"', CATS, PLACES)),
    ).toEqual({
      title: 'memo',
      categoryId: 'c1',
      estimateMin: 30,
      dueDay: '2026-10-03',
      dueTime: null,
      notes: 'x',
      place: null,
    });
    expect(toCreateInput(parseTaskLine('memo | due:2026-10-03@09:30', CATS, PLACES)).dueTime).toBe(
      '09:30',
    );
  });
});

describe('tokenAtCaret', () => {
  // '^' marks the caret; it's removed before the call.
  const at = (marked: string) => {
    const caret = marked.indexOf('^');
    return tokenAtCaret(marked.replace('^', ''), caret);
  };
  const tok = (kind: string, partial: string, replaceStart: number, replaceEnd: number) => ({
    kind,
    partial,
    replaceStart,
    replaceEnd,
  });

  it.each([
    ['milk^', null],
    ['mi^lk | #ad', null],
    ['milk |^ #ad', null],
    ['milk | #ad^', tok('category', 'ad', 7, 10)],
    ['milk | #^ad', tok('category', '', 7, 10)],
    ['milk | #^', tok('category', '', 7, 8)],
    ['milk | #"Deep W^', tok('category', 'Deep W', 7, 15)],
    ['milk | #"Deep^ Work" ~3', tok('category', 'Deep', 7, 19)],
    ['milk | #"Deep Work"^', tok('category', 'Deep Work', 7, 19)],
    ['milk | ~3^', tok('estimate', '3', 7, 9)],
    ['milk | ~30^ #ad', tok('estimate', '30', 7, 10)],
    ['milk | due:^', tok('due', '', 7, 11)],
    ['milk | due:2026-1^', tok('due', '2026-1', 7, 17)],
    ['milk | due:2026-10-05@1^', tok('due', '2026-10-05@1', 7, 23)],
    ['milk | notes:"a |^ b"', null],
    ['milk | notes:"open^', null],
    ['milk | ^', null],
    ['milk | ~30 ^#ad', tok('category', '', 11, 14)],
    ['milk | foo^', null],
    ['milk | Due:x^', null],
    ['milk | x | #a^', tok('category', 'a', 11, 13)],
  ])('%s', (marked, want) => {
    expect(at(marked)).toEqual(want);
  });
});

describe('errorKinds', () => {
  const kinds = (raw: string) => parseTaskLine(raw, CATS, PLACES).errorKinds;
  it('runs parallel to errors, saying what each is about', () => {
    const l = parseTaskLine('x | soon #"open ~0', CATS, PLACES);
    expect(l.errorKinds).toHaveLength(l.errors.length);
    expect(kinds('x | soon')).toEqual([{ kind: 'unknown', token: 'soon' }]);
    expect(kinds('x | #')).toEqual([{ kind: 'category' }]);
    expect(kinds('x | #"open')).toEqual([{ kind: 'category' }]);
    expect(kinds('x | #a #b')).toEqual([{ kind: 'category' }]);
    expect(kinds('x | due:2026-13-01')).toEqual([{ kind: 'due' }]);
    expect(kinds('x | due:2026-10-01@25:00')).toEqual([{ kind: 'due' }]);
    expect(kinds('x | due:2026-10-01 due:2026-10-02')).toEqual([{ kind: 'due' }]);
    expect(kinds('x | ~0')).toEqual([{ kind: 'estimate' }]);
    expect(kinds('x | ~')).toEqual([{ kind: 'estimate' }]);
    expect(kinds('x | ~5 ~10')).toEqual([{ kind: 'other' }]); // a repeat is "once", not the value
    expect(kinds('x | category')).toEqual([{ kind: 'unknown', token: 'category' }]);
  });
});

describe('@place', () => {
  it('resolves a known place, case-insensitively', () => {
    const l = only('shampoo | @Grocer ~5');
    expect(l.errors).toEqual([]);
    expect(l.placeSlug).toBe('grocer');
    expect(l.place).toBe('grocer');
    expect(toCreateInput(l).place).toBe('grocer');
    expect(only('syrup | @thrift-jos').place).toBe('thrift-jos');
  });
  it('an unknown place is a yellow warning — created off any list', () => {
    const l = only('nails | @tackle');
    expect(l.errors).toEqual([]);
    expect(l.place).toBeNull();
    expect(l.placeSlug).toBe('tackle');
    expect(l.warnings).toEqual(["no place '@tackle' — created without one"]);
  });
  it('empty, malformed and duplicate places are red', () => {
    expect(only('x | @').errorKinds).toEqual([{ kind: 'place' }]);
    expect(only('x | @-bad').errorKinds).toEqual([{ kind: 'place' }]);
    expect(only('x | @grocer @thrift-jos').errors).toEqual([
      'duplicate place (@) token — each is allowed once',
    ]);
  });
  it("a due time's @ is never a place", () => {
    const l = only('x | due:2026-10-03@09:30 @grocer');
    expect(l.errors).toEqual([]);
    expect(l.dueTime).toBe('09:30');
    expect(l.place).toBe('grocer');
  });
  it('an @ in the title is literal', () => {
    expect(only('email bob@example.com').title).toBe('email bob@example.com');
  });
  it('tokenAtCaret completes @', () => {
    expect(tokenAtCaret('x | @gro', 8)).toEqual({
      kind: 'place',
      partial: 'gro',
      replaceStart: 4,
      replaceEnd: 8,
    });
  });
});
