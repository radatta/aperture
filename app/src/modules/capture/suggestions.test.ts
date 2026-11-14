import { describe, expect, it } from 'vitest';
import { parseTaskLine, tokenAtCaret } from '@aperture/shared';
import {
  applySuggestion,
  categorySuggestions,
  completeTokens,
  dueSuggestions,
  estimateSuggestions,
  placeSuggestions,
  suggestionsFor,
} from './suggestions';

const CATS = [
  { id: 'a', label: 'Admin' },
  { id: 'd', label: 'Deep Work' },
  { id: 'q', label: 'Say "hi"' },
];
const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

describe('categorySuggestions', () => {
  it('empty partial offers every writable label', () => {
    expect(labels(categorySuggestions('', CATS))).toEqual(['Admin', 'Deep Work']);
  });
  it('matches word-starts, case-insensitively', () => {
    expect(labels(categorySuggestions('AD', CATS))).toEqual(['Admin']);
    expect(labels(categorySuggestions('work', CATS))).toEqual(['Deep Work']);
    expect(labels(categorySuggestions('deep w', CATS))).toEqual(['Deep Work']);
    expect(categorySuggestions('ee', CATS)).toEqual([]);
  });
  it('quotes a multi-word label', () => {
    expect(categorySuggestions('deep', CATS)[0]!.insert).toBe('#"Deep Work"');
    expect(categorySuggestions('ad', CATS)[0]!.insert).toBe('#Admin');
  });
});

describe('placeSuggestions', () => {
  const PLACES = [
    { slug: 'corner', name: 'Corner Shop' },
    { slug: 'tj', name: "Thrift Jo's" },
  ];
  it('matches the link word or a word of the name, and types the link word', () => {
    expect(labels(placeSuggestions('', PLACES))).toEqual(['@Corner Shop', "@Thrift Jo's"]);
    expect(labels(placeSuggestions('tj', PLACES))).toEqual(["@Thrift Jo's"]);
    expect(labels(placeSuggestions('JO', PLACES))).toEqual(["@Thrift Jo's"]);
    expect(placeSuggestions('shop', PLACES)[0]!.insert).toBe('@corner');
    expect(placeSuggestions('x', PLACES)).toEqual([]);
  });
  it('is what an @ token under the caret offers', () => {
    const text = 'milk | @co';
    const tok = tokenAtCaret(text, text.length)!;
    expect(tok.kind).toBe('place');
    const chips = suggestionsFor(tok, { cats: [], places: PLACES, today: '2026-10-12' });
    expect(applySuggestion(text, tok, chips[0]!).text).toBe('milk | @corner ');
  });
});

describe('estimateSuggestions', () => {
  it('filters presets by digit prefix', () => {
    expect(labels(estimateSuggestions('1'))).toEqual(['15m', '2h']);
    expect(estimateSuggestions('7')).toEqual([]);
    expect(estimateSuggestions('')).toHaveLength(6);
  });
});

describe('dueSuggestions', () => {
  it('inserts concrete ISO dates, filtered by what was typed', () => {
    const all = dueSuggestions('', '2026-09-30');
    expect(all[2]).toMatchObject({ label: 'Fri', insert: 'due:2026-10-02' });
    expect(labels(dueSuggestions('2026-10-0', '2026-09-30'))).toEqual([
      'Tomorrow',
      'Fri',
      'Mon',
      'Tue',
      'Oct 7',
    ]);
  });
});

describe('applySuggestion', () => {
  it('at the end, replaces the token and adds a space', () => {
    const text = 'memo | #ad';
    const tok = tokenAtCaret(text, text.length)!;
    expect(applySuggestion(text, tok, categorySuggestions('ad', CATS)[0]!)).toEqual({
      text: 'memo | #Admin ',
      caret: 14,
    });
  });
  it('mid-line, reuses the following space', () => {
    const text = 'memo | #ad ~30';
    const tok = tokenAtCaret(text, 10)!;
    expect(applySuggestion(text, tok, categorySuggestions('ad', CATS)[0]!)).toEqual({
      text: 'memo | #Admin ~30',
      caret: 14,
    });
  });
  it('a day chip chains: no space, caret at the token end — at the end and mid-line', () => {
    const day = dueSuggestions('', '2026-09-30')[0]!; // Today
    const end = 'memo | due:';
    expect(applySuggestion(end, tokenAtCaret(end, end.length)!, day)).toEqual({
      text: 'memo | due:2026-09-30',
      caret: 21,
    });
    const mid = 'memo | due: ~30';
    expect(applySuggestion(mid, tokenAtCaret(mid, 11)!, day)).toEqual({
      text: 'memo | due:2026-09-30 ~30',
      caret: 21,
    });
  });
});

describe('completeTokens — a half-typed token never drops quietly', () => {
  const places = [
    { slug: 'grocer', name: 'Grocer' },
    { slug: 'tj', name: "Thrift Jo's" },
    { slug: 'tackle', name: 'Tackle' },
  ];
  const done = (text: string) => completeTokens(parseTaskLine(text, CATS, places), CATS, places);

  it('takes the one match, as Tab would, and drops the "created without one" warning', () => {
    expect(done('x | #adm')).toMatchObject({
      categoryId: 'a',
      categoryLabel: 'Admin',
      warnings: [],
    });
    expect(done('x | #work')).toMatchObject({ categoryId: 'd' }); // a word of the label, like the chip
    expect(done('x | @gro')).toMatchObject({
      place: 'grocer',
      placeSlug: 'grocer',
      warnings: [],
    });
    expect(done('x | @thrift')).toMatchObject({ place: 'tj' }); // a word of the name
  });

  it('several matches are a red error naming them', () => {
    const l = done('x | @t');
    expect(l.place).toBeNull();
    expect(l.errors).toEqual(["@t could be Thrift Jo's or Tackle — pick one"]);
    expect(l.errorKinds).toEqual([{ kind: 'place' }]);
  });

  it('a token that starts nothing keeps its warning; a whole one is untouched', () => {
    expect(done('x | @zz')).toMatchObject({
      place: null,
      warnings: ["no place '@zz' — created without one"],
    });
    expect(done('x | #Nope').warnings).toEqual(["no category 'Nope' — created without one"]);
    expect(done('x | @tj')).toEqual(parseTaskLine('x | @tj', CATS, places));
  });

  it('completes nothing while the lists are still loading (empty)', () => {
    const raw = parseTaskLine('x | @gro #adm', [], []);
    expect(completeTokens(raw, [], [])).toEqual(raw);
  });
});
