import { beforeEach, describe, expect, it } from 'vitest';
import { heuristicParse, STUB_FAIL_NEXT_PARSE_KEY } from './stubParse';
import { createStubClient } from './stubClient';

// Monday 2026-10-12. The stub is the offline stand-in for the Lambda's Haiku parse
// (lambdas/src/backend.parse.test.ts holds the Lambda to the same flow).
const today = '2026-10-12';
const cats = [
  { id: 'c-ap', label: 'Aperture' },
  { id: 'c-sd', label: 'System Design' },
];
const parse = (line: string) => heuristicParse(line, cats, today);
const blank = { notes: null, categoryId: null, dueDay: null, dueTime: null, estimateMin: null };

describe('heuristicParse', () => {
  it('the Raycast README example: category, due day, estimate', () => {
    expect(parse('aperture, fix login bug due fri 30m')).toEqual({
      ...blank,
      title: 'fix login bug',
      categoryId: 'c-ap',
      dueDay: '2026-10-16',
      estimateMin: 30,
    });
  });

  it('a multi-word category label, tmw with a clock, hours', () => {
    expect(parse('System Design, read ddia ch5 due tmw 4pm 2h')).toEqual({
      ...blank,
      title: 'read ddia ch5',
      categoryId: 'c-sd',
      dueDay: '2026-10-13',
      dueTime: '16:00',
      estimateMin: 120,
    });
  });

  it('a weekday names the next such day, never today', () => {
    expect(parse('call mom due mon').dueDay).toBe('2026-10-19');
    expect(parse('call mom due sunday').dueDay).toBe('2026-10-18');
    expect(parse('call mom due today').dueDay).toBe('2026-10-12');
  });

  it('a lone clock is a time with no day (the validator makes it today); 24h works too', () => {
    expect(parse('call dentist 4:30pm')).toEqual({
      ...blank,
      title: 'call dentist',
      dueTime: '16:30',
    });
    expect(parse('call dentist at 9am')).toEqual({
      ...blank,
      title: 'call dentist',
      dueTime: '09:00',
    });
    expect(parse('standup due wed 09:15')).toMatchObject({
      dueDay: '2026-10-14',
      dueTime: '09:15',
    });
    expect(parse('call 12am').dueTime).toBe('00:00');
  });

  it('a plain line is just a title', () => {
    expect(parse('buy milk')).toEqual({ ...blank, title: 'buy milk' });
    expect(parse('aperture fix it')).toEqual({ ...blank, title: 'aperture fix it' }); // no comma, no category
  });

  it('a long line keeps ~80 characters in the title and moves the rest to notes', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const r = parse(words);
    expect(r.title.length).toBeLessThanOrEqual(80);
    expect(`${r.title} ${r.notes}`).toBe(words);
  });
});

describe('stub parseTask', () => {
  const stub = () =>
    createStubClient({
      seed: false,
      storageKey: `parse-${Math.random()}`,
      now: () => new Date(2026, 9, 12, 10, 0).getTime(),
    });

  beforeEach(() => localStorage.removeItem(STUB_FAIL_NEXT_PARSE_KEY));

  it('after midnight, “tonight 2:30am” is the coming night; “tomorrow 1am” and “today 9am” stay', async () => {
    const api = createStubClient({
      seed: false,
      storageKey: `parse-${Math.random()}`,
      now: () => new Date(2026, 9, 31, 0, 22).getTime(), // app day still Oct 30
    });
    const day = async (line: string) => {
      const r = await api.parseTask(line);
      return r.ok ? [r.input.dueDay, r.input.dueTime, r.today] : null;
    };
    expect(await day('essay due tonight 2:30am')).toEqual(['2026-10-31', '02:30', '2026-10-30']);
    expect(await day('essay due tomorrow 1am')).toEqual(['2026-10-31', '01:00', '2026-10-30']);
    expect(await day('essay due today 9am')).toEqual(['2026-10-30', '09:00', '2026-10-30']);
  });

  it('parses against the active categories and the stub day', async () => {
    const api = stub();
    const ap = await api.upsertCategory({ label: 'Aperture', isWork: true });
    const old = await api.upsertCategory({ label: 'Old', isWork: true });
    await api.upsertCategory({ id: old.id, label: 'Old', isWork: true, active: false });
    expect(await api.parseTask('aperture, fix it due tmw 30m')).toEqual({
      ok: true,
      source: 'haiku',
      input: { title: 'fix it', categoryId: ap.id, dueDay: '2026-10-13', estimateMin: 30 },
      categoryLabel: 'Aperture',
      dropped: [],
      today: '2026-10-12',
    });
    // A retired category is not offered.
    expect(await api.parseTask('old, fix it')).toMatchObject({
      ok: true,
      input: { title: 'old, fix it' },
    });
  });

  it('the fail hook fails the next parse once, then clears', async () => {
    const api = stub();
    localStorage.setItem(STUB_FAIL_NEXT_PARSE_KEY, '1');
    expect(await api.parseTask('fix it')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await api.parseTask('fix it')).toMatchObject({ ok: true });
  });

  it("a ' | ' line uses the grammar", async () => {
    expect(await stub().parseTask('fix it | ~30')).toMatchObject({
      ok: true,
      source: 'grammar',
      input: { title: 'fix it', estimateMin: 30 },
    });
  });
});
