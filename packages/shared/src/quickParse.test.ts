import { describe, expect, it, vi } from 'vitest';
import {
  parseBudgetMs,
  parseFailText,
  PARSE_TEXT_MAX,
  runQuickParse,
  validateParsedTask,
  type ModelOutcome,
} from './quickParse';
import { TASK_NOTES_MAX } from './taskNotes';

const ctx = {
  categories: [
    { id: 'c-ap', label: 'Aperture' },
    { id: 'c-lc', label: 'LeetCode' },
  ],
  today: '2026-10-12',
};
const fields = (over: Record<string, unknown> = {}) => ({
  title: 'fix login bug',
  notes: null,
  categoryId: null,
  dueDay: null,
  dueTime: null,
  estimateMin: null,
  ...over,
});

describe('validateParsedTask', () => {
  it('keeps a clean parse and resolves the category label', () => {
    const v = validateParsedTask(
      fields({
        categoryId: 'c-ap',
        dueDay: '2026-10-16',
        dueTime: '16:00',
        estimateMin: 30,
        notes: ' more ',
      }),
      ctx,
    );
    expect(v).toEqual({
      input: {
        title: 'fix login bug',
        categoryId: 'c-ap',
        dueDay: '2026-10-16',
        dueTime: '16:00',
        estimateMin: 30,
        notes: 'more',
      },
      categoryLabel: 'Aperture',
      dropped: [],
    });
  });

  it('returns null for a blank, missing or non-string title, or a non-object', () => {
    expect(validateParsedTask(fields({ title: '   ' }), ctx)).toBeNull();
    expect(validateParsedTask(fields({ title: 42 }), ctx)).toBeNull();
    expect(validateParsedTask({}, ctx)).toBeNull();
    expect(validateParsedTask(null, ctx)).toBeNull();
    expect(validateParsedTask('fix it', ctx)).toBeNull();
    expect(validateParsedTask([fields()], ctx)).toBeNull();
  });

  it('trims the title and leaves absent fields off the input', () => {
    expect(validateParsedTask(fields({ title: '  fix it \n' }), ctx)).toEqual({
      input: { title: 'fix it' },
      categoryLabel: null,
      dropped: [],
    });
  });

  it('blank notes are no notes; over the cap they are cut and named', () => {
    expect(validateParsedTask(fields({ notes: '  \n ' }), ctx)!.input.notes).toBeUndefined();
    const v = validateParsedTask(fields({ notes: 'x'.repeat(TASK_NOTES_MAX + 10) }), ctx)!;
    expect(v.input.notes).toHaveLength(TASK_NOTES_MAX);
    expect(v.dropped).toEqual(['notes cut']);
    expect(validateParsedTask(fields({ notes: 'x'.repeat(TASK_NOTES_MAX) }), ctx)!.dropped).toEqual(
      [],
    );
  });

  it('drops an unknown or non-string category', () => {
    for (const categoryId of ['c-gone', 7]) {
      const v = validateParsedTask(fields({ categoryId }), ctx)!;
      expect(v.input.categoryId).toBeUndefined();
      expect(v.categoryLabel).toBeNull();
      expect(v.dropped).toEqual(['unknown category']);
    }
  });

  it('keeps only real, zero-padded calendar days', () => {
    expect(validateParsedTask(fields({ dueDay: '2028-02-29' }), ctx)!.input.dueDay).toBe(
      '2028-02-29',
    );
    for (const dueDay of ['2026-02-30', '2026-2-5', 'friday', 20261016]) {
      const v = validateParsedTask(fields({ dueDay }), ctx)!;
      expect(v.input.dueDay).toBeUndefined();
      expect(v.dropped).toEqual(['dropped due day']);
    }
  });

  it('pads H:MM, rejects impossible clocks', () => {
    expect(
      validateParsedTask(fields({ dueDay: '2026-10-13', dueTime: '9:05' }), ctx)!.input.dueTime,
    ).toBe('09:05');
    for (const dueTime of ['24:00', '9:5', '4pm', 1600]) {
      const v = validateParsedTask(fields({ dueDay: '2026-10-13', dueTime }), ctx)!;
      expect(v.input.dueTime).toBeUndefined();
      expect(v.input.dueDay).toBe('2026-10-13');
      expect(v.dropped).toEqual(['dropped due time']);
    }
  });

  it('a time with no day lands on today; a time whose day was dropped goes too', () => {
    expect(validateParsedTask(fields({ dueTime: '16:00' }), ctx)!.input).toEqual({
      title: 'fix login bug',
      dueDay: '2026-10-12',
      dueTime: '16:00',
    });
    const v = validateParsedTask(fields({ dueDay: '2026-02-30', dueTime: '16:00' }), ctx)!;
    expect(v.input.dueDay).toBeUndefined();
    expect(v.input.dueTime).toBeUndefined();
    expect(v.dropped).toEqual(['dropped due day', 'dropped due time']);
  });

  it('estimate: whole minutes kept, 0 cleared quietly, anything else dropped', () => {
    expect(validateParsedTask(fields({ estimateMin: 45 }), ctx)!.input.estimateMin).toBe(45);
    const zero = validateParsedTask(fields({ estimateMin: 0 }), ctx)!;
    expect(zero.input.estimateMin).toBeUndefined();
    expect(zero.dropped).toEqual([]);
    for (const estimateMin of [1.5, -5, '30']) {
      const v = validateParsedTask(fields({ estimateMin }), ctx)!;
      expect(v.input.estimateMin).toBeUndefined();
      expect(v.dropped).toEqual(['dropped estimate']);
    }
  });
});

describe('parseBudgetMs', () => {
  it('4s, +1s per 400 characters, capped at 8s', () => {
    expect(parseBudgetMs('')).toBe(4_000);
    expect(parseBudgetMs('x'.repeat(399))).toBe(4_000);
    expect(parseBudgetMs('x'.repeat(400))).toBe(5_000);
    expect(parseBudgetMs('x'.repeat(1_600))).toBe(8_000);
    expect(parseBudgetMs('x'.repeat(40_000))).toBe(8_000);
  });
});

describe('runQuickParse', () => {
  const ok = (f: unknown) => vi.fn(async (): Promise<ModelOutcome> => ({ ok: true, fields: f }));

  it('sends the trimmed line to the model and validates what comes back', async () => {
    const model = ok(fields({ categoryId: 'c-lc', estimateMin: 30 }));
    const r = await runQuickParse('  leetcode, fix login bug 30m \n', ctx, model);
    expect(model).toHaveBeenCalledWith('leetcode, fix login bug 30m');
    expect(r).toEqual({
      ok: true,
      source: 'haiku',
      input: { title: 'fix login bug', categoryId: 'c-lc', estimateMin: 30 },
      categoryLabel: 'LeetCode',
      dropped: [],
      today: '2026-10-12',
    });
  });

  it("a ' | ' line takes the strict grammar and never reaches the model", async () => {
    const model = ok(fields());
    const r = await runQuickParse('fix it | ~30 #aperture due:2026-10-16@16:00', ctx, model);
    expect(model).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: true,
      source: 'grammar',
      input: {
        title: 'fix it',
        categoryId: 'c-ap',
        estimateMin: 30,
        dueDay: '2026-10-16',
        dueTime: '16:00',
        notes: null,
      },
      categoryLabel: 'Aperture',
      dropped: [],
      today: '2026-10-12',
    });
  });

  it('grammar: a red error fails with its message; an unknown #label is a dropped warning', async () => {
    const model = ok(fields());
    const bad = await runQuickParse('fix it | ~abc', ctx, model);
    expect(bad).toMatchObject({ ok: false, reason: 'grammar' });
    expect((bad as { detail: string }).detail).toMatch(/~/);
    const warn = await runQuickParse('fix it | #nope', ctx, model);
    expect(warn).toMatchObject({ ok: true, categoryLabel: null, input: { categoryId: null } });
    expect((warn as { dropped: string[] }).dropped).toHaveLength(1);
    expect(model).not.toHaveBeenCalled();
  });

  it('blank text, an over-long line, and an empty model title fail without a model call where they can', async () => {
    const model = ok(fields({ title: ' ' }));
    expect(await runQuickParse('  ', ctx, model)).toEqual({ ok: false, reason: 'empty-title' });
    const long = await runQuickParse('x'.repeat(PARSE_TEXT_MAX + 1), ctx, model);
    expect(long).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(model).not.toHaveBeenCalled();
    expect(await runQuickParse('x'.repeat(PARSE_TEXT_MAX), ctx, model)).toEqual({
      ok: false,
      reason: 'empty-title',
    });
  });

  it("passes the model's failure through unchanged", async () => {
    const model = vi.fn(async (): Promise<ModelOutcome> => ({ ok: false, reason: 'timeout' }));
    expect(await runQuickParse('fix it', ctx, model)).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('parseFailText', () => {
  it('reason, with the detail when there is one', () => {
    expect(parseFailText({ reason: 'timeout' })).toBe('timeout');
    expect(parseFailText({ reason: 'api', detail: 'HTTP 401 invalid x-api-key' })).toBe(
      'api: HTTP 401 invalid x-api-key',
    );
  });
});
