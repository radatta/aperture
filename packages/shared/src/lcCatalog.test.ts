import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  catalogCounts,
  formatClasses,
  LC_CATALOG_PART_MAX_CHARS,
  lcCatalogSourceUrl,
  normalizeCatalogImport,
  packCatalog,
  parseClasses,
  trimSourceRows,
  unpackCatalog,
} from './lcCatalog';
import type { LcClass, LcSourceRow } from './lcCatalog';

// Synthetic dataset rows in the source's shape — made-up problems, never real ones beyond NeetCode's own slugs.
const raw = (id: number, slug: string, over: Record<string, unknown> = {}) => ({
  questionFrontendId: String(id),
  title: `Synthetic ${id}`,
  titleSlug: null,
  difficulty: 'Medium',
  isPaidOnly: false,
  categoryTitle: 'Algorithms',
  topicTags: [{ name: 'Array' }],
  stats: JSON.stringify({ acRate: '42.5%' }),
  url: `https://leetcode.com/problems/${slug}/`,
  ...over,
});
const row = (id: number, slug: string, over: Partial<LcSourceRow> = {}): LcSourceRow => ({
  id,
  slug,
  title: `Synthetic ${id}`,
  difficulty: 'Medium',
  premium: false,
  acRate: 42.5,
  tags: ['Array'],
  algorithms: true,
  ...over,
});
const cls = (
  pattern: LcClass['pattern'],
  similar: number[] = [],
  harder: number[] = [],
): LcClass => ({
  pattern,
  similar,
  harder,
});

describe('trimSourceRows', () => {
  it('keeps the metadata, takes the slug from the url, parses acceptance, sorts by id', () => {
    const { rows, dropped } = trimSourceRows([
      raw(9002, 'synthetic-b', { isPaidOnly: true, categoryTitle: 'Database' }),
      raw(9001, 'synthetic-a'),
    ]);
    expect(dropped).toBe(0);
    expect(rows).toEqual([
      row(9001, 'synthetic-a'),
      row(9002, 'synthetic-b', { premium: true, algorithms: false }),
    ]);
  });

  it('drops and counts a malformed or repeated row, never guessing', () => {
    const { rows, dropped } = trimSourceRows([
      raw(1, 'ok-one'),
      raw(2, 'Bad_Slug'),
      raw(3, 'no-title', { title: '  ' }),
      raw(4, 'bad-difficulty', { difficulty: 'Extreme' }),
      raw(5, 'bad-paid', { isPaidOnly: 'no' }),
      raw(0, 'zero-id'),
      raw(6, 'ok-one'), // a repeated slug
      raw(1, 'repeated-id'),
      raw(7, 'off-site', { url: 'https://example.com/problems/off-site/' }),
      null,
      'nope',
    ]);
    expect(rows.map((r) => r.slug)).toEqual(['ok-one']);
    expect(dropped).toBe(10);
  });

  it('reads an unparseable acceptance as unknown, and a non-array as nothing', () => {
    expect(trimSourceRows([raw(1, 'a', { stats: 'not json' })]).rows[0]!.acRate).toBeNull();
    expect(
      trimSourceRows([raw(1, 'a', { stats: '{"acRate":"lots"}' })]).rows[0]!.acRate,
    ).toBeNull();
    expect(trimSourceRows({ rows: [] })).toEqual({ rows: [], dropped: 0 });
  });
});

describe('parseClasses', () => {
  it('reads id, pattern and related ids, skipping comments and blanks', () => {
    const { classes, bad } = parseClasses(
      '# source abc rows 2\n9001\tsliding-window\t9002,9003\t-\n\n9002\tother\t-\t9001\r\n',
    );
    expect(bad).toBe(0);
    expect(classes.get(9001)).toEqual(cls('sliding-window', [9002, 9003]));
    expect(classes.get(9002)).toEqual(cls('other', [], [9001]));
  });

  it('counts a malformed line and keeps the rest', () => {
    const { classes, bad } = parseClasses(
      [
        '9001\tnot-a-pattern\t-\t-',
        '9002\ttrees\tx\t-',
        '9003\ttrees\t-',
        '9004\ttrees\t-\t-\textra',
        'abc\ttrees\t-\t-',
        '9005\ttrees\t-\t-',
      ].join('\n'),
    );
    expect(bad).toBe(5);
    expect([...classes.keys()]).toEqual([9005]);
  });
});

describe('buildCatalog', () => {
  const source = [
    row(1, 'two-sum', { title: 'Dataset title', difficulty: 'Hard', premium: true }),
    row(9001, 'synthetic-a', { tags: ['Sliding Window'] }),
    row(9002, 'synthetic-b', { difficulty: 'Easy' }),
    row(9003, 'synthetic-c', { difficulty: 'Hard' }),
    row(9004, 'synthetic-db', { algorithms: false }),
  ];

  it('lets NeetCode’s facts win, then the rule, then a model’s class, else the tags', () => {
    const rows = buildCatalog(
      source,
      new Map([
        [1, cls('trees')], // ignored: NeetCode's own
        [9002, cls('greedy')],
        [9004, cls('trees')], // ignored: not an algorithm problem
      ]),
    );
    const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
    expect(by['two-sum']).toMatchObject({
      title: 'Two Sum',
      pattern: 'arrays-hashing',
      difficulty: 'Easy',
      by: 'neetcode',
    });
    expect(by['two-sum']!.premium).toBeUndefined();
    expect(by['synthetic-a']).toMatchObject({ pattern: 'sliding-window', by: 'tags' });
    expect(by['synthetic-b']).toMatchObject({ pattern: 'greedy', by: 'model' });
    expect(by['synthetic-db']).toMatchObject({ pattern: 'other', by: 'rule' });
    expect(catalogCounts(rows)).toEqual({
      count: 5,
      premium: 0,
      by: { neetcode: 1, rule: 1, model: 1, tags: 2 },
    });
  });

  it('keeps related problems only on the catalog, never itself, harder ones at least as hard, two at most', () => {
    const rows = buildCatalog(
      source,
      new Map([[9001, cls('sliding-window', [9001, 404, 9002, 9003, 1], [9002, 9003, 9003])]]),
    );
    const a = rows.find((r) => r.slug === 'synthetic-a')!;
    expect(a.similar).toEqual(['synthetic-b', 'synthetic-c']);
    expect(a.harder).toEqual(['synthetic-c']);
  });

  it('caps the other problems at `limit` and always keeps NeetCode’s', () => {
    const rows = buildCatalog(source, new Map(), 2);
    expect(rows.map((r) => r.slug)).toEqual(['two-sum', 'synthetic-a', 'synthetic-b']);
  });

  it('writes the class map back as the file parseClasses reads, sorted by id', () => {
    const classes = new Map([
      [9002, cls('heap')],
      [9001, cls('sliding-window', [9002, 9003], [9002])],
    ]);
    const text = formatClasses(classes);
    expect(text).toBe('9001\tsliding-window\t9002,9003\t9002\n9002\theap\t-\t-');
    expect(parseClasses(text)).toEqual({
      classes: new Map([...classes].sort(([a], [b]) => a - b)),
      bad: 0,
    });
  });
});

describe('packCatalog / unpackCatalog', () => {
  const rows = buildCatalog(
    [
      row(1, 'two-sum'),
      row(9001, 'synthetic-a', { premium: true, tags: ['Array', 'Heap (Priority Queue)'] }),
      row(9002, 'synthetic-b', { acRate: null, tags: [] }),
      row(9003, 'synthetic-db', { algorithms: false }),
    ],
    new Map([[9001, cls('heap', [9002], [9002])]]),
  );

  it('round-trips every row', () => {
    const packed = packCatalog(rows);
    expect(packed.tags).toEqual(['Array', 'Heap (Priority Queue)']);
    expect(unpackCatalog(JSON.parse(JSON.stringify(packed)))).toEqual(rows);
  });

  it('skips a malformed tuple, drops a dangling related id, and refuses a malformed whole', () => {
    const packed = packCatalog(rows);
    packed.rows[1]![8] = [404, 9002];
    (packed.rows as unknown[]).push(['bad'], [9, 'Bad Slug', 't', 0, 0, 0, null, [], [], [], 0]);
    const back = unpackCatalog(packed)!;
    expect(back).toHaveLength(4);
    expect(back[1]!.similar).toEqual(['synthetic-b']);
    expect(unpackCatalog(null)).toBeNull();
    expect(unpackCatalog({ v: 2, tags: [], rows: [] })).toBeNull();
  });
});

it('pins the source by commit', () => {
  expect(lcCatalogSourceUrl()).toMatch(
    /^https:\/\/raw\.githubusercontent\.com\/noworneverev\/leetcode-api\/[0-9a-f]{40}\/data\/leetcode_questions_mini\.json$/,
  );
});

describe('normalizeCatalogImport', () => {
  it('passes a kick, a dev cap and a part through', () => {
    expect(normalizeCatalogImport(undefined)).toEqual({});
    expect(normalizeCatalogImport({ limit: 300 })).toEqual({ limit: 300 });
    expect(normalizeCatalogImport({ classes: '1\ttrees\t-\t-' })).toEqual({
      classes: '1\ttrees\t-\t-',
      part: 1,
      parts: 1,
    });
    expect(normalizeCatalogImport({ classes: 'x', part: 2, parts: 3 })).toMatchObject({
      part: 2,
      parts: 3,
    });
  });

  it('refuses a malformed input with the reason', () => {
    expect(() => normalizeCatalogImport([])).toThrow(/object/);
    expect(() => normalizeCatalogImport({ nope: 1 })).toThrow(/Unknown import field/);
    expect(() => normalizeCatalogImport({ limit: 0 })).toThrow(/limit/);
    expect(() => normalizeCatalogImport({ part: 1 })).toThrow(/go with classes/);
    expect(() => normalizeCatalogImport({ classes: ' ' })).toThrow(/non-empty/);
    expect(() =>
      normalizeCatalogImport({ classes: 'x'.repeat(LC_CATALOG_PART_MAX_CHARS + 1) }),
    ).toThrow(/split it/);
    expect(() => normalizeCatalogImport({ classes: 'x', part: 4, parts: 3 })).toThrow(/part must/);
    expect(() => normalizeCatalogImport({ classes: 'x', parts: 9 })).toThrow(/parts must/);
  });
});
