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
  places: [{ slug: 'grocer', name: 'Grocer' }],
  today: '2026-10-12',
  dayStartHour: 4,
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

  it('a small-hours clock on today is tonight’s — the next date; other days stay', () => {
    const due = (over: Record<string, unknown>, line?: string) =>
      validateParsedTask(fields(over), line ? { ...ctx, line } : ctx)?.input.dueDay;
    expect(due({ dueDay: '2026-10-12', dueTime: '02:30' })).toBe('2026-10-13');
    expect(due({ dueTime: '02:30' }, 'essay 2:30am')).toBe('2026-10-13');
    expect(due({ dueDay: '2026-10-13', dueTime: '01:00' })).toBe('2026-10-13');
    expect(due({ dueDay: '2026-10-12', dueTime: '09:00' })).toBe('2026-10-12');
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

  // Dev check 2026-10-13: Haiku saved "today plan 10m" as due today 10am — a time nobody wrote, which also
  // put an invented block on the calendar. With the typed line known, a due time needs a clock in it.
  it('drops a due time when the typed line has no clock in it', () => {
    const withLine = (line: string, over: Record<string, unknown>) =>
      validateParsedTask(fields(over), { ...ctx, line })!;
    const invented = withLine('aperture, qazebra ten today plan 10m', {
      dueDay: '2026-10-12',
      dueTime: '10:00',
    });
    expect(invented.input).toEqual({ title: 'fix login bug', dueDay: '2026-10-12' }); // the day stays
    expect(invented.dropped).toEqual(['dropped due time']);
    for (const line of [
      'call 4pm',
      'call at 9:30am',
      'call 16:00',
      'call at noon',
      'call 4 p',
      'call midnight',
    ])
      expect(withLine(line, { dueTime: '16:00' }).input.dueTime).toBe('16:00');
    for (const line of [
      'call today',
      'call tonight 30m',
      'call tmw 2h',
      'room 4',
      'chapter 12 due fri',
    ])
      expect(withLine(line, { dueTime: '16:00' }).dropped).toEqual(['dropped due time']);
    // No line given (a caller with only the fields): the old behaviour.
    expect(validateParsedTask(fields({ dueTime: '16:00' }), ctx)!.input.dueTime).toBe('16:00');
  });

  it('drops an estimate when the typed line has no duration in it', () => {
    const est = (line: string) =>
      validateParsedTask(fields({ estimateMin: 15 }), { ...ctx, line })!;
    expect(est('qazebra fifteen call dentist tonight').dropped).toEqual(['dropped estimate']);
    expect(est('read 10 pages tmw').input.estimateMin).toBeUndefined();
    for (const line of [
      'x 15m',
      'x 2h',
      'x 1.5 hrs',
      'x 90 min',
      'x 20 minutes',
      'x an hour',
      'x half an hour',
    ])
      expect(est(line).input.estimateMin).toBe(15);
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
      placeName: null,
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
      },
      categoryLabel: 'Aperture',
      placeName: null,
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
    // Only set fields, same as a model parse — MCP's create_task rejects a present null.
    expect(warn).toMatchObject({ ok: true, categoryLabel: null, input: { title: 'fix it' } });
    expect(Object.keys((warn as { input: object }).input)).toEqual(['title']);
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

  it('validates against the typed line: an invented time is dropped', async () => {
    const model = ok(fields({ dueTime: '10:00' }));
    const r = await runQuickParse('plan the week today 10m', ctx, model);
    expect(r).toMatchObject({
      ok: true,
      input: { title: 'fix login bug' },
      dropped: ['dropped due time'],
    });
    expect((r as { input: object }).input).not.toHaveProperty('dueTime');
  });

  it('takes a known @place word before the model, which never sees it', async () => {
    const model = ok(fields({ title: 'shampoo' }));
    const r = await runQuickParse('shampoo @Grocer', ctx, model);
    expect(model).toHaveBeenCalledWith('shampoo');
    expect(r).toMatchObject({
      ok: true,
      input: { title: 'shampoo', place: 'grocer' },
      placeName: 'Grocer',
    });
  });

  it('takes a known @place followed by punctuation, stripping the punctuation with it', async () => {
    for (const [line, rest] of [
      ['shampoo @grocer, nails', 'shampoo nails'],
      ['shampoo @grocer.', 'shampoo'],
      ['shampoo @Grocer!?', 'shampoo'],
      ['@grocer: shampoo', 'shampoo'],
      ['shampoo @grocer;', 'shampoo'],
    ]) {
      const model = ok(fields({ title: rest }));
      const r = await runQuickParse(line!, ctx, model);
      expect(model).toHaveBeenCalledWith(rest);
      expect(r).toMatchObject({ ok: true, input: { place: 'grocer' }, placeName: 'Grocer' });
    }
    // Punctuation inside the word isn't trailing: an unknown word stays in the line.
    const model = ok(fields());
    await runQuickParse('ask @grocer,tackle', ctx, model);
    expect(model).toHaveBeenCalledWith('ask @grocer,tackle');
  });

  it('leaves an unknown @word in the line, and a lone @place is an empty title', async () => {
    const model = ok(fields());
    await runQuickParse('email bob @tackle', ctx, model);
    expect(model).toHaveBeenCalledWith('email bob @tackle');
    expect(await runQuickParse('@grocer', ctx, model)).toEqual({
      ok: false,
      reason: 'empty-title',
    });
  });

  it('grammar: @place resolves and names the list', async () => {
    const r = await runQuickParse('nails | @grocer', ctx, ok(fields()));
    expect(r).toMatchObject({
      ok: true,
      input: { title: 'nails', place: 'grocer' },
      placeName: 'Grocer',
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

describe('validateParsedTask — voice (capture.md → Time rules)', () => {
  // Monday 2026-11-16, 06:00 in LA.
  const now = Date.UTC(2026, 10, 16, 14, 0);
  const voice = (line: string, over: Record<string, unknown> = {}) =>
    validateParsedTask(fields({ title: 'call mum', ...over }), {
      ...ctx,
      today: '2026-11-16',
      line,
      voice: { now },
    })!;

  it('takes the time from the words, not the model', () => {
    expect(voice('call mum at 5').input).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:00' });
    // The model's own clock is ignored when the words say otherwise…
    expect(voice('call mum at 5', { dueDay: '2026-11-16', dueTime: '05:00' }).input.dueTime).toBe(
      '17:00',
    );
    // …and dropped when the words have none.
    const v = voice('call mum', { dueDay: '2026-11-16', dueTime: '10:00' });
    expect(v.input).toEqual({ title: 'call mum', dueDay: '2026-11-16' });
    expect(v.dropped).toEqual(['dropped due time']);
  });

  it('words the model kept in its title were not a time', () => {
    const v = voice('look at one of the leases', { title: 'look at one of the leases' });
    expect(v.input).toEqual({ title: 'look at one of the leases' });
    expect(voice('email the morning team', { title: 'email the morning team' }).input.dueTime).toBe(
      undefined,
    );
  });

  it("a clock the grammar can't read is the model's, rolled forward; an invented one is dropped", () => {
    // 06:00 now: "quarter past five" — the model's 05:15 has passed, so it rolls to tomorrow.
    expect(voice('call mum at quarter past five', { dueTime: '05:15' }).input).toMatchObject({
      dueDay: '2026-11-17',
      dueTime: '05:15',
    });
    const made = voice('call mum soon', { dueTime: '10:00' });
    expect(made.input.dueTime).toBeUndefined();
    expect(made.dropped).toEqual(['dropped due time']);
  });

  it('a named day from the model stays; "today" rolls a past time forward', () => {
    expect(voice('call mum friday at 5', { dueDay: '2026-11-20' }).input).toMatchObject({
      dueDay: '2026-11-20',
      dueTime: '17:00',
    });
    expect(voice('call mum today at 5 am', { dueDay: '2026-11-16' }).input).toMatchObject({
      dueDay: '2026-11-17',
      dueTime: '05:00',
    });
  });

  it('a relative delay is a time, never an estimate', () => {
    const v = voice('call mum in 2 hours', { estimateMin: 120 });
    expect(v.input).toEqual({ title: 'call mum', dueDay: '2026-11-16', dueTime: '08:00' });
    expect(v.dropped).toEqual(['dropped estimate']);
    // A real duration beside it still counts.
    expect(voice('stretch 20 minutes in an hour', { estimateMin: 20 }).input.estimateMin).toBe(20);
  });

  it('typed lines keep the 2026-10-09 rule: a past clock lands today', () => {
    const v = validateParsedTask(fields({ title: 'call', dueTime: '09:00' }), {
      ...ctx,
      today: '2026-11-16',
      line: 'call 9am',
    })!;
    expect(v.input).toMatchObject({ dueDay: '2026-11-16', dueTime: '09:00' });
  });
});
