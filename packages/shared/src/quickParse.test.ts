import { describe, expect, it, vi } from 'vitest';
import {
  parseBudgetMs,
  parseFailText,
  PARSE_TEXT_MAX,
  runQuickParse,
  spokenFallbackDue,
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
  now: Date.UTC(2026, 9, 12, 15, 0), // Monday 2026-10-12, 08:00 in LA
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

  it('a clock lands on its next occurrence; a later day stays', () => {
    const due = (over: Record<string, unknown>, line?: string) => {
      const i = validateParsedTask(fields(over), line ? { ...ctx, line } : ctx)!.input;
      return [i.dueDay, i.dueTime];
    };
    // 08:00: a small-hours clock on today is tonight's, a clock still ahead stays today, a past one rolls.
    expect(due({ dueDay: '2026-10-12', dueTime: '02:30' })).toEqual(['2026-10-13', '02:30']);
    expect(due({ dueTime: '02:30' }, 'essay 2:30am')).toEqual(['2026-10-13', '02:30']);
    expect(due({ dueDay: '2026-10-12', dueTime: '09:00' })).toEqual(['2026-10-12', '09:00']);
    expect(due({ dueDay: '2026-10-12', dueTime: '07:00' })).toEqual(['2026-10-13', '07:00']);
    expect(due({ dueDay: '2026-10-13', dueTime: '01:00' })).toEqual(['2026-10-13', '01:00']);
    // A past day the model read ("monday" as last Monday) rolls like any past clock.
    expect(due({ dueDay: '2026-10-05', dueTime: '09:00' })).toEqual(['2026-10-12', '09:00']);
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
      now,
      voice: true,
    })!;

  it('a bare hour wraps whatever the model wrote; a clock with no words for it is dropped', () => {
    // No model clock: the grammar fills.
    expect(voice('call mum at 5').input).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:00' });
    // The model's 05:00 read as said, no half: a bare 5 at 06:00 is today's evening…
    expect(voice('call mum at 5', { dueDay: '2026-11-16', dueTime: '05:00' }).input.dueTime).toBe(
      '17:00',
    );
    // …and a clock the words don't hold is dropped.
    const v = voice('call mum', { dueDay: '2026-11-16', dueTime: '10:00' });
    expect(v.input).toEqual({ title: 'call mum', dueDay: '2026-11-16' });
    expect(v.dropped).toEqual(['dropped due time']);
  });

  it('a day from the model counts only when the words name one', () => {
    // 18:30: "at 5" is tomorrow 5 AM, even if the model dated it tomorrow on its own.
    const late = Date.UTC(2026, 10, 17, 2, 30);
    const v = (line: string) =>
      validateParsedTask(fields({ dueDay: '2026-11-17' }), {
        ...ctx,
        today: '2026-11-16',
        line,
        now: late,
        voice: true,
      })!.input;
    expect(v('call mum at 5')).toMatchObject({ dueDay: '2026-11-17', dueTime: '05:00' });
    expect(v('call mum tomorrow at 5')).toMatchObject({ dueDay: '2026-11-17', dueTime: '17:00' });
    // A later day the model read from words no list covers stays.
    const later = (line: string) =>
      validateParsedTask(fields({ dueDay: '2026-12-24' }), {
        ...ctx,
        today: '2026-11-16',
        line,
        now: late,
        voice: true,
      })!.input;
    expect(later('dentist on Christmas Eve at 9am')).toMatchObject({
      dueDay: '2026-12-24',
      dueTime: '09:00',
    });
    // Said the day before, with the clock still ahead: the model's tomorrow stands for a stated clock.
    const eve = validateParsedTask(fields({ dueDay: '2026-11-17' }), {
      ...ctx,
      today: '2026-11-16',
      line: 'dentist on the eve at 9am',
      now: Date.UTC(2026, 10, 16, 16, 0), // 08:00 LA
      voice: true,
    })!.input;
    expect(eve).toMatchObject({ dueDay: '2026-11-17', dueTime: '09:00' });
    expect(
      validateParsedTask(fields({ dueDay: '2026-11-18' }), {
        ...ctx,
        today: '2026-11-16',
        line: 'call mum in 2 days at 5 pm',
        now: late,
        voice: true,
      })!.input,
    ).toMatchObject({ dueDay: '2026-11-18', dueTime: '17:00' });
  });

  it('a minute the grammar can’t read leaves the model’s clock, placed by its half', () => {
    // 06:00: stated 05:20 is tomorrow's (a bare 5:20 would be today's 17:20).
    expect(
      voice('call mum at five twenty in the morning', { dueTime: '05:20', dueTimeHalf: 'stated' })
        .input,
    ).toMatchObject({ dueDay: '2026-11-17', dueTime: '05:20' });
    expect(
      voice('call mum at five twenty', { dueTime: '05:20', dueTimeHalf: 'none' }).input,
    ).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:20' });
  });

  it('a night never moves a clock the words stated, and 13:00–15:59 is no night hour', () => {
    // 06:00: "tonight … at 6 am" — the grammar read 06:00 stated; as a night hour it would be 18:00.
    expect(
      voice('remind me tonight to call mum at 6 am', {
        title: 'call mum',
        dueTime: '06:00',
        dueTimeHalf: 'night',
      }).input,
    ).toMatchObject({ dueDay: '2026-11-17', dueTime: '06:00' });
    for (const line of [
      'remind me at 3 pm to pack for tonight',
      'pack for tonight at three in the afternoon',
    ])
      expect(
        voice(line, { title: 'pack for tonight', dueTime: '15:00', dueTimeHalf: 'night' }).input,
      ).toMatchObject({ dueDay: '2026-11-16', dueTime: '15:00' });
  });

  it('a night the model dated calendar tomorrow with no day in the words stays tonight’s', () => {
    // 22:00 Monday: "at 1 tonight" is Tuesday 01:00, not Wednesday's.
    const v = validateParsedTask(
      fields({ title: 'call mum', dueDay: '2026-11-17', dueTime: '01:00', dueTimeHalf: 'night' }),
      {
        ...ctx,
        today: '2026-11-16',
        line: 'call mum at 1 tonight',
        now: Date.UTC(2026, 10, 17, 6, 0),
        voice: true,
      },
    )!;
    expect(v.input).toMatchObject({ dueDay: '2026-11-17', dueTime: '01:00' });
  });

  it('a day-part noun the model kept never blocks its clock; its words stay in the title', () => {
    // Before: the kept "morning" made the line's time "dropped".
    expect(
      voice('send the morning report by seven', {
        title: 'send the morning report',
        dueTime: '07:00',
        dueTimeHalf: 'none',
      }).input,
    ).toMatchObject({ title: 'send the morning report', dueDay: '2026-11-16', dueTime: '07:00' });
    // The model dropped the task's own "morning": a bare hour's day-part words come back.
    expect(
      voice('at 5 send the morning report', {
        title: 'send the report',
        dueTime: '05:00',
        dueTimeHalf: 'none',
      }).input.title,
    ).toBe('send the morning report');
  });

  it('a day-part beside clock words the grammar can’t read leaves the model’s title', () => {
    expect(
      voice('remind me tonight around eight to call mum', {
        dueTime: '20:00',
        dueTimeHalf: 'night',
      }).input,
    ).toMatchObject({ title: 'call mum', dueDay: '2026-11-16', dueTime: '20:00' });
    expect(
      voice('remind me this morning by nine to send the report', {
        title: 'send the report',
        dueTime: '09:00',
        dueTimeHalf: 'stated',
      }).input,
    ).toMatchObject({ title: 'send the report', dueTime: '09:00' });
  });

  it('words the model kept in its title were not a time', () => {
    const v = voice('look at one of the leases', { title: 'look at one of the leases' });
    expect(v.input).toEqual({ title: 'look at one of the leases' });
    expect(voice('email the morning team', { title: 'email the morning team' }).input.dueTime).toBe(
      undefined,
    );
  });

  it("a clock the grammar can't read is the model's, placed by the rules; an invented one is dropped", () => {
    // 06:00 now: "quarter past five" says no half of the day, so it's a bare hour (rule 1): the next 5:15 is the
    // evening's (2026-11-17, Sonnet; before, the model's 05:15 was taken as stated and rolled to tomorrow).
    expect(voice('call mum at quarter past five', { dueTime: '05:15' }).input).toMatchObject({
      dueDay: '2026-11-16',
      dueTime: '17:15',
    });
    expect(voice('call mum at quarter past five am', { dueTime: '05:15' }).input).toMatchObject({
      dueDay: '2026-11-17',
      dueTime: '05:15',
    });
    const made = voice('call mum soon', { dueTime: '10:00' });
    expect(made.input.dueTime).toBeUndefined();
    expect(made.dropped).toEqual(['dropped due time']);
  });

  it('the model says which half of the day: none wraps, stated stands, night is the night’s', () => {
    // 06:00. One line, every reading of the field: missing or unknown is none (a bare hour, rule 1).
    const half = (dueTimeHalf: unknown, dueTime = '05:00') =>
      voice('call mum at 5', { dueTime, dueTimeHalf }).input;
    expect(half('none')).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:00' });
    expect(half(undefined)).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:00' });
    expect(half('garbage')).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:00' });
    expect(half('none', '17:00')).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:00' });
    expect(half('stated')).toMatchObject({ dueDay: '2026-11-17', dueTime: '05:00' });
    expect(half('night')).toMatchObject({ dueDay: '2026-11-16', dueTime: '17:00' });
    // No clock in the line: a half with nothing to place sets no time.
    expect(voice('call mum', { dueTimeHalf: 'stated' }).input.dueTime).toBeUndefined();
    // A stated clock the grammar read stays stated whatever the field says (06:00: as a bare 5 it would be
    // today 5 PM), and its due phrase leaves the title.
    expect(
      voice('call mum at 5 am', {
        title: 'call mum at 5 am',
        dueTime: '05:00',
        dueTimeHalf: 'none',
      }).input,
    ).toMatchObject({ title: 'call mum', dueDay: '2026-11-17', dueTime: '05:00' });
  });

  it('a day-part word that belongs to the task says nothing; a time phrase anywhere does', () => {
    // 06:00: "morning" belongs to the report, not the 5 — a bare 5, today's evening.
    for (const title of ['send the morning report', 'send this morning’s notes'])
      expect(
        voice(`remind me at 5 to ${title}`, { title, dueTime: '05:00', dueTimeHalf: 'none' }).input,
      ).toMatchObject({ title, dueDay: '2026-11-16', dueTime: '17:00' });
    for (const dueTime of ['21:00', '09:00'])
      expect(
        voice('remind me tonight to call mum at 9', {
          title: 'call mum',
          dueTime,
          dueTimeHalf: 'night',
        }).input,
      ).toMatchObject({ dueDay: '2026-11-16', dueTime: '21:00' });
    expect(
      voice('remind me tomorrow morning to go for a run at 6', {
        title: 'go for a run',
        dueDay: '2026-11-17',
        dueTime: '06:00',
        dueTimeHalf: 'stated',
      }).input,
    ).toMatchObject({ dueDay: '2026-11-17', dueTime: '06:00' });
    // A clock the grammar can't read, said for tonight: the model's 20:30, and its title — the grammar has no
    // words for that clock, so none come back into it.
    expect(
      voice('remind me tonight at half past eight to call mum', {
        dueTime: '20:30',
        dueTimeHalf: 'night',
      }).input,
    ).toMatchObject({ title: 'call mum', dueDay: '2026-11-16', dueTime: '20:30' });
    expect(
      voice('remind me at quarter past five to book the night bus', {
        title: 'book the night bus',
        dueTime: '05:15',
        dueTimeHalf: 'none',
      }).input,
    ).toMatchObject({ title: 'book the night bus', dueTime: '17:15' });
  });

  it('a night\'s small hour lands after its day, as "at 1 tonight" does', () => {
    const night = (line: string, dueTime: string, dueDay: string | null = '2026-11-20') =>
      voice(line, { dueDay, dueTime, dueTimeHalf: 'night' }).input;
    expect(night('call mum at 1 friday night', '01:00')).toMatchObject({
      dueDay: '2026-11-21',
      dueTime: '01:00',
    });
    expect(night('call mum at one twenty friday night', '01:20')).toMatchObject({
      dueDay: '2026-11-21',
      dueTime: '01:20',
    });
    expect(night('call mum at 1 am friday night', '01:00')).toMatchObject({
      dueDay: '2026-11-21',
      dueTime: '01:00',
    });
    expect(night('call mum at 9 friday night', '21:00')).toMatchObject({
      dueDay: '2026-11-20',
      dueTime: '21:00',
    });
    // "at 12 tonight" is midnight, written either way.
    for (const t of ['00:00', '12:00'])
      expect(night('call mum at 12 tonight', t, null)).toMatchObject({
        dueDay: '2026-11-17',
        dueTime: '00:00',
      });
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

  it("the model's clock and its half place the time; the grammar's misreads don't (F213 class)", () => {
    // 02:00 Monday, before the day start (the app's today is Sunday).
    const night = Date.UTC(2026, 10, 16, 10, 0);
    const at = (line: string, over: Record<string, unknown>) =>
      validateParsedTask(fields({ title: 'call mum', ...over }), {
        ...ctx,
        today: '2026-11-15',
        line,
        now: night,
        voice: true,
      })!.input;
    const stated = { dueTimeHalf: 'stated' };
    const none = { dueTimeHalf: 'none' };
    // The grammar reads "at 5 in the evening" as a bare 5; the model's stated 17:00 stands.
    expect(at('call mum at 5 in the evening', { dueTime: '17:00', ...stated })).toMatchObject({
      dueDay: '2026-11-16',
      dueTime: '17:00',
    });
    // A bare hour wraps (rule 1) whatever hour the model wrote: 02:00 + "at 5" is 5 AM.
    expect(at('call mum at 5', { dueTime: '17:00', ...none })).toMatchObject({
      dueDay: '2026-11-16',
      dueTime: '05:00',
    });
    expect(at('call mum at 4', { dueTime: '05:00', ...none })).toMatchObject({
      dueDay: '2026-11-16',
      dueTime: '05:00',
    });
    // "5:30" is a bare hour: 02:00 + 5:30 is the morning's; at 06:00 the evening's.
    expect(at('call mum at 5:30', { dueTime: '05:30', ...none })).toMatchObject({
      dueDay: '2026-11-16',
      dueTime: '05:30',
    });
    expect(voice('call mum at 5:30', { dueTime: '05:30', ...none }).input).toMatchObject({
      dueDay: '2026-11-16',
      dueTime: '17:30',
    });
    expect(
      at('at 4 book the night bus', { title: 'book the night bus', dueTime: '16:00', ...none }),
    ).toMatchObject({ dueDay: '2026-11-16', dueTime: '04:00' });
    expect(
      at('call mum at five twenty and book the night bus', {
        title: 'call mum and book the night bus',
        dueTime: '16:20',
        ...none,
      }),
    ).toMatchObject({ dueDay: '2026-11-16', dueTime: '04:20' });
    // A stated half anywhere in the line: the model's clock as said.
    expect(
      at('call mum at 8 tomorrow evening', { dueDay: '2026-11-16', dueTime: '20:00', ...stated }),
    ).toMatchObject({ dueDay: '2026-11-16', dueTime: '20:00' });
    expect(
      at('call flat 4 owner at 4 this afternoon', {
        title: 'call flat 4 owner',
        dueTime: '16:00',
        ...stated,
      }),
    ).toMatchObject({ dueDay: '2026-11-16', dueTime: '16:00' });
    expect(
      at('remind me this evening to call mum at 6', { dueTime: '18:00', ...stated }),
    ).toMatchObject({ dueDay: '2026-11-16', dueTime: '18:00' });
    expect(at('call mum this evening at 5', { dueTime: '17:00', ...stated })).toMatchObject({
      dueTime: '17:00',
    });
    // "tonight" alone: the rule's 8 PM — a line with no number has no clock for the model to read.
    expect(at('call mum tonight', { dueTime: '21:00', dueTimeHalf: 'night' })).toMatchObject({
      dueTime: '20:00',
    });
    // "at 1 tonight" and "friday at 1 tonight": the small hours after the day.
    expect(at('call mum at 1 tonight', { dueTime: '01:00', dueTimeHalf: 'night' })).toMatchObject({
      dueDay: '2026-11-17',
      dueTime: '01:00',
    });
    expect(
      at('call mum friday at 1 tonight', {
        dueDay: '2026-11-20',
        dueTime: '01:00',
        dueTimeHalf: 'night',
      }),
    ).toMatchObject({ dueDay: '2026-11-21', dueTime: '01:00' });
  });

  it('a relative delay is a time, never an estimate', () => {
    const v = voice('call mum in 2 hours', { estimateMin: 120 });
    expect(v.input).toEqual({ title: 'call mum', dueDay: '2026-11-16', dueTime: '08:00' });
    expect(v.dropped).toEqual(['dropped estimate']);
    // A real duration beside it still counts.
    expect(voice('stretch 20 minutes in an hour', { estimateMin: 20 }).input.estimateMin).toBe(20);
  });

  it('a stated clock the model kept in its title was not the time; a delay always is', () => {
    expect(
      voice('email the team about the 3pm meeting', {
        title: 'email the team about the 3pm meeting',
      }).input.dueTime,
    ).toBeUndefined();
    expect(voice('stretch in 20 minutes', { title: 'stretch in 20 minutes' }).input.dueTime).toBe(
      '06:20',
    );
  });

  it('typed: a stated clock the model missed is filled from the words; a different one stands', () => {
    const typed = (line: string, over: Record<string, unknown>) =>
      validateParsedTask(fields({ title: 'call the bank', ...over }), {
        ...ctx,
        today: '2026-11-16',
        now,
        line,
      })!;
    // The dev miss (2026-11-16): today, no time, for "at 6 pm".
    const missed = typed('call the bank at 6 pm', { dueDay: '2026-11-16' });
    expect(missed.input).toMatchObject({ dueDay: '2026-11-16', dueTime: '18:00' });
    expect(missed.dropped).toEqual([]);
    expect(typed('call the bank at 6 pm', {}).input).toMatchObject({
      dueDay: '2026-11-16',
      dueTime: '18:00',
    });
    expect(typed('move the 3pm to 5pm', { dueTime: '17:00' }).input.dueTime).toBe('17:00');
    // Words the model kept in its title weren't the due time — unless they're an at/by clock (next test).
    expect(typed('watch 9pm show', { title: 'watch 9pm show' }).input.dueTime).toBeUndefined();
    expect(
      typed('move the 3pm to 5pm', { title: 'move the 3pm to 5pm' }).input.dueTime,
    ).toBeUndefined();
    // Nothing stated outright: nothing filled.
    expect(typed('call the bank at 6', {}).input.dueTime).toBeUndefined();
  });

  it('typed lines roll a past clock forward, as spoken ones do (the maintainer, 2026-11-17)', () => {
    const v = validateParsedTask(fields({ title: 'call', dueTime: '09:00' }), {
      ...ctx,
      today: '2026-11-16',
      now: Date.UTC(2026, 10, 16, 23, 0), // 15:00 LA
      line: 'call 9am',
    })!;
    expect(v.input).toMatchObject({ dueDay: '2026-11-17', dueTime: '09:00' });
  });

  // Dev, 2026-11-17: a typed "…call the bank typed at 1 am" came back unchanged, with no day and no time.
  it('an at/by clock the model kept in its title fills and leaves the title', () => {
    const run = (line: string, over: Record<string, unknown>, voice = false) =>
      validateParsedTask(fields({ title: line, ...over }), {
        ...ctx,
        today: '2026-11-16',
        now, // 06:00 LA
        line,
        voice,
      })!;
    for (const voice of [false, true]) {
      expect(run('call the bank at 1 am', {}, voice)).toMatchObject({
        input: { title: 'call the bank', dueDay: '2026-11-17', dueTime: '01:00' },
        dropped: [],
      });
      expect(run('call the bank by 5PM.', {}, voice).input).toMatchObject({
        title: 'call the bank',
        dueDay: '2026-11-16',
        dueTime: '17:00',
      });
      expect(run('At noon, call mum', {}, voice).input).toMatchObject({
        title: 'call mum',
        dueTime: '12:00',
      });
      expect(run('pay rent due at 13:00 sharp', {}, voice).input).toMatchObject({
        title: 'pay rent sharp',
        dueTime: '13:00',
      });
    }
    // The model's own same time, words kept: the phrase still leaves, so the title doesn't depend on the model.
    expect(run('call the bank at 7 pm', { dueTime: '19:00' }).input.title).toBe('call the bank');
    // A different model time stands, and the words stay.
    expect(run('move standup at 3pm to 5pm', { dueTime: '17:00' }).input).toMatchObject({
      title: 'move standup at 3pm to 5pm',
      dueTime: '17:00',
    });
    // Only the phrase: the title stays whole rather than going blank.
    expect(run('at 9am', {}).input).toMatchObject({ title: 'at 9am', dueTime: '09:00' });
  });

  it('a clock not phrased as a due gets no time when the model kept it', () => {
    const run = (line: string, voice: boolean) =>
      validateParsedTask(fields({ title: line }), {
        ...ctx,
        today: '2026-11-16',
        now,
        line,
        voice,
      })!.input;
    for (const voice of [false, true])
      for (const line of [
        'watch 9pm show',
        'email the team about the 3pm meeting',
        'move the 3pm to 5pm',
        'look at one of the leases',
        'look at 5 options', // a bare hour: never an at/by clock
        'move standup at 3pm to 5pm', // two stated clocks: the at/by one isn't taken on its own
      ])
        expect(run(line, voice), `${line} (${voice ? 'voice' : 'typed'})`).toEqual({ title: line });
  });
});

// The maintainer, 2026-11-17: every clock lands on its next occurrence, typed or spoken, at any hour — the small
// hours (app day still yesterday, dayStartHour 4) included.
describe('validateParsedTask — the small hours', () => {
  // 2026-11-17 in LA (UTC-8); the app day is 11-16 before 04:00.
  const at = (h: number, m: number) => Date.UTC(2026, 10, 17, h + 8, m);
  const appDay = (h: number) => (h < 4 ? '2026-11-16' : '2026-11-17');
  const cases: [string, number, number, Record<string, [string, string]>][] = [
    // now, then each clock's landing
    [
      '00:30',
      0,
      30,
      {
        '1 am': ['2026-11-17', '01:00'],
        '12 am': ['2026-11-18', '00:00'],
        '9am': ['2026-11-17', '09:00'],
      },
    ],
    [
      '01:35',
      1,
      35,
      {
        '1 am': ['2026-11-18', '01:00'],
        '12 am': ['2026-11-18', '00:00'],
        '9am': ['2026-11-17', '09:00'],
      },
    ],
    [
      '02:01',
      2,
      1,
      {
        '1 am': ['2026-11-18', '01:00'],
        '12 am': ['2026-11-18', '00:00'],
        '9am': ['2026-11-17', '09:00'],
      },
    ],
    [
      '03:59',
      3,
      59,
      {
        '1 am': ['2026-11-18', '01:00'],
        '12 am': ['2026-11-18', '00:00'],
        '9am': ['2026-11-17', '09:00'],
      },
    ],
    [
      '04:00',
      4,
      0,
      {
        '1 am': ['2026-11-18', '01:00'],
        '12 am': ['2026-11-18', '00:00'],
        '9am': ['2026-11-17', '09:00'],
      },
    ],
    [
      '23:30',
      23,
      30,
      {
        '1 am': ['2026-11-18', '01:00'],
        '12 am': ['2026-11-18', '00:00'],
        '9am': ['2026-11-18', '09:00'],
      },
    ],
  ];
  const hhmm: Record<string, string> = { '1 am': '01:00', '12 am': '00:00', '9am': '09:00' };
  it('typed and spoken agree at every small-hours clock', () => {
    for (const [label, h, m, want] of cases) {
      const today = appDay(h);
      const calendar = '2026-11-17';
      for (const [said, landing] of Object.entries(want)) {
        const line = `call the bank at ${said}`;
        const run = (over: Record<string, unknown>, voice: boolean) => {
          const i = validateParsedTask(fields({ title: 'call the bank', ...over }), {
            ...ctx,
            today,
            now: at(h, m),
            line,
            voice,
          })!.input;
          return [i.dueDay, i.dueTime];
        };
        const why = `${said} at ${label}`;
        // The model's answers seen on dev: the time on the app day, on the calendar day, none with the
        // words kept, or none at all.
        for (const day of [null, today, calendar])
          expect(
            run({ dueDay: day, dueTime: hhmm[said] }, false),
            `${why}, typed, model day ${day}`,
          ).toEqual(landing);
        expect(run({ title: line }, false), `${why}, typed, kept`).toEqual(landing);
        expect(run({}, false), `${why}, typed, missed`).toEqual(landing);
        expect(run({}, true), `${why}, spoken`).toEqual(landing);
        expect(run({ title: line }, true), `${why}, spoken, kept`).toEqual(landing);
      }
    }
  });
});

// The maintainer, 2026-11-17 (Q3): a day the typed line names stays as written; only a clock with no day word
// rolls. Spoken lines keep their own rules ("today at 5 am" rolls, above).
describe('validateParsedTask — a day the typed line names', () => {
  // 2026-11-17 (a Tuesday) in LA (UTC-8); the app day is 11-16 before the day start.
  const at = (h: number, m: number) => Date.UTC(2026, 10, 17, h + 8, m);
  const typed = (line: string, over: Record<string, unknown>, h: number, m: number, start = 4) => {
    const i = validateParsedTask(fields({ title: 'pay rent', ...over }), {
      ...ctx,
      today: h < start ? '2026-11-16' : '2026-11-17',
      dayStartHour: start,
      now: at(h, m),
      line,
    })!.input;
    return [i.dueDay, i.dueTime];
  };
  const day = (d: string, t: string) => ({ dueDay: d, dueTime: t });

  it('a written day stays as written, even past; a small-hours clock on today is its night', () => {
    // 15:00: today 9am is overdue, not tomorrow's; a past date stays.
    expect(typed('pay rent today 9am', day('2026-11-17', '09:00'), 15, 0)).toEqual([
      '2026-11-17',
      '09:00',
    ]);
    expect(typed('pay rent nov 10 9am', day('2026-11-10', '09:00'), 15, 0)).toEqual([
      '2026-11-10',
      '09:00',
    ]);
    // 02:01, the app's today still 11-16: "today 1am" is its night's 01:00 — the one just gone.
    expect(typed('pay rent today 1am', day('2026-11-16', '01:00'), 2, 1)).toEqual([
      '2026-11-17',
      '01:00',
    ]);
    // 15:00: "today 2:30am" is tonight's.
    expect(typed('pay rent today 2:30am', day('2026-11-17', '02:30'), 15, 0)).toEqual([
      '2026-11-18',
      '02:30',
    ]);
    // 00:30: "tomorrow 1am", read against the app's 11-16, is 11-17.
    expect(typed('pay rent tomorrow 1am', day('2026-11-17', '01:00'), 0, 30)).toEqual([
      '2026-11-17',
      '01:00',
    ]);
    // "today" is the app's day whatever day the model read: at 02:01, 9am is the app day's — overdue.
    expect(typed('pay rent today 9am', day('2026-11-17', '09:00'), 2, 1)).toEqual([
      '2026-11-16',
      '09:00',
    ]);
    // "tonight" names today too: 9pm at 22:00 is overdue, 2:30am typed at 3pm the coming night's.
    expect(typed('pay rent tonight 9pm', day('2026-11-17', '21:00'), 22, 0)).toEqual([
      '2026-11-17',
      '21:00',
    ]);
    expect(typed('pay rent tonight 2:30am', day('2026-11-17', '02:30'), 15, 0)).toEqual([
      '2026-11-18',
      '02:30',
    ]);
    // A written date stays — a small-hours clock on today's date, an ISO date, m/d, the weekday itself.
    expect(typed('pay rent nov 17 2am', day('2026-11-17', '02:00'), 15, 0)).toEqual([
      '2026-11-17',
      '02:00',
    ]);
    expect(typed('pay rent 2026-11-10 9am', day('2026-11-10', '09:00'), 15, 0)).toEqual([
      '2026-11-10',
      '09:00',
    ]);
    expect(typed('pay rent 11/10 9am', day('2026-11-10', '09:00'), 15, 0)).toEqual([
      '2026-11-10',
      '09:00',
    ]);
    expect(typed('pay rent tue 9am', day('2026-11-17', '09:00'), 15, 0)).toEqual([
      '2026-11-17',
      '09:00',
    ]);
  });

  it('"today" and "tomorrow" come from the words when the model read no day', () => {
    expect(typed('pay rent today 9am', { dueTime: '09:00' }, 15, 0)).toEqual([
      '2026-11-17',
      '09:00',
    ]);
    expect(typed('pay rent tomorrow 9am', { dueTime: '09:00' }, 15, 0)).toEqual([
      '2026-11-18',
      '09:00',
    ]);
    // The whole line kept, no day, no time: the at-clock fills, the day is the words'.
    expect(typed('pay rent today at 9am', { title: 'pay rent today at 9am' }, 15, 0)).toEqual([
      '2026-11-17',
      '09:00',
    ]);
    const kept = validateParsedTask(
      fields({ title: 'pay rent today at 9am', dueDay: '2026-11-17' }),
      {
        ...ctx,
        today: '2026-11-17',
        now: at(15, 0),
        line: 'pay rent today at 9am',
      },
    )!.input;
    // The day beside the due clock leaves the title with it (titleWords.ts).
    expect(kept).toMatchObject({ title: 'pay rent', dueDay: '2026-11-17', dueTime: '09:00' });
  });

  it('a day start other than 4: "today" is the app day that start makes', () => {
    // Midnight start: "today 1am" at 02:01 is today's 01:00, gone.
    expect(typed('pay rent today 1am', day('2026-11-17', '01:00'), 2, 1, 0)).toEqual([
      '2026-11-17',
      '01:00',
    ]);
    // 6am start: "today 5am" typed at 15:00 is the coming night's.
    expect(typed('pay rent today 5am', day('2026-11-17', '05:00'), 15, 0, 6)).toEqual([
      '2026-11-18',
      '05:00',
    ]);
  });

  it('no day of its own: the clock rolls, whatever day the model put on it', () => {
    expect(typed('pay rent 9am', day('2026-11-17', '09:00'), 15, 0)).toEqual([
      '2026-11-18',
      '09:00',
    ]);
    // Day-ish words that name no day: the model's "today" for a bare clock still rolls.
    for (const line of [
      'may need to call the bank 9am',
      'call Jan at 9am',
      '2nd interview 9am',
      'month-end close 9am',
      'day trip prep 9am',
      'sat down with the plan 9am', // 11-17 is a Tuesday
    ])
      expect(typed(line, day('2026-11-17', '09:00'), 15, 0), line).toEqual(['2026-11-18', '09:00']);
  });
});

describe('validateParsedTask — a typed day-part beside a day', () => {
  it('"morning" the model dropped with its day stays out of the title', () => {
    const v = validateParsedTask(fields({ title: 'gym', dueDay: '2026-11-20' }), {
      ...ctx,
      line: 'gym nov 20 morning',
    })!;
    expect(v.input).toMatchObject({ title: 'gym', dueDay: '2026-11-20' });
  });
});

describe('spokenFallbackDue (a spoken line saved without the model)', () => {
  // Monday 2026-11-16, 14:00 in LA.
  const c = { now: Date.UTC(2026, 10, 16, 22, 0), today: '2026-11-16' };
  it("places the words' own time by the voice rules", () => {
    expect(spokenFallbackDue('call mum at 5', c)).toEqual({
      dueDay: '2026-11-16',
      dueTime: '17:00',
    });
    expect(spokenFallbackDue('call mum at 9 am', c)).toEqual({
      dueDay: '2026-11-17',
      dueTime: '09:00',
    });
    expect(spokenFallbackDue('call mum in 20 minutes', c)).toEqual({
      dueDay: '2026-11-16',
      dueTime: '14:20',
    });
    expect(spokenFallbackDue('call mum tonight', c)).toEqual({
      dueDay: '2026-11-16',
      dueTime: '20:00',
    });
    expect(spokenFallbackDue('call mum today at 5', c)).toEqual({
      dueDay: '2026-11-16',
      dueTime: '17:00',
    });
  });
  it('"tomorrow" is the app\'s next day, as the model reads it; any other day word means no time', () => {
    // 00:30 before the day rolls: the app's today is still yesterday, so its tomorrow is the calendar's today.
    const late = { now: Date.UTC(2026, 10, 17, 8, 30), today: '2026-11-16' };
    expect(spokenFallbackDue('call mum tomorrow at 9', late)).toEqual({
      dueDay: '2026-11-17',
      dueTime: '09:00',
    });
    expect(spokenFallbackDue('call mum tomorrow at 9', c)).toEqual({
      dueDay: '2026-11-17',
      dueTime: '09:00',
    });
    expect(spokenFallbackDue('call mum friday at 5', c)).toBeNull();
    expect(spokenFallbackDue('call mum the day after tomorrow at 5', c)).toBeNull();
  });
  it("the fallback is the grammar alone: its day-parts and the words' own clock", () => {
    // Known fallback reading (as before the model read the half): "morning" anywhere is the 5's.
    expect(spokenFallbackDue('remind me at 5 to send the morning report', c)).toEqual({
      dueDay: '2026-11-17',
      dueTime: '05:00',
    });
    // No "evening" in the grammar: a bare 5.
    expect(spokenFallbackDue('call mum at 5 in the evening', c)).toEqual({
      dueDay: '2026-11-16',
      dueTime: '17:00',
    });
    // 06:00: "tonight" anywhere makes the 9 the evening's (the bare wrap alone would give 09:00).
    const early = { now: Date.UTC(2026, 10, 16, 14, 0), today: '2026-11-16' };
    expect(spokenFallbackDue('remind me tonight to call mum at 9', early)).toEqual({
      dueDay: '2026-11-16',
      dueTime: '21:00',
    });
  });
  it('no time in the words: none', () => {
    expect(spokenFallbackDue('call mum', c)).toBeNull();
  });
});

describe('validateParsedTask — notes on a short line (F232)', () => {
  const now = Date.UTC(2026, 10, 18, 0, 41); // Tue 2026-11-17, 16:41 in LA
  const run = (line: string, over: Record<string, unknown>) =>
    validateParsedTask(
      fields({ title: 'call the dentist', dueDay: '2026-11-18', dueTime: '17:00', ...over }),
      { ...ctx, categories: [], today: '2026-11-17', now, line },
    )!.input;

  it("the line's own words the model moved to notes go back into the title", () => {
    expect(
      run('devcheck aaebaafull call the dentist typed tomorrow at 5 pm', {
        notes: 'devcheck aaebaafull typed',
      }),
    ).toEqual({
      title: 'devcheck aaebaafull call the dentist typed',
      dueDay: '2026-11-18',
      dueTime: '17:00',
    });
  });

  it('notes with a word the line never had, or that would overflow the title, stand', () => {
    expect(
      run('call the dentist typed tomorrow at 5 pm', { notes: 'bring the insurance card' }),
    ).toMatchObject({ title: 'call the dentist', notes: 'bring the insurance card' });
    const long = `call the dentist ${'about the crown and the bridge and the cleaning '.repeat(3)}tomorrow at 5 pm`;
    const rest = long.slice('call the dentist '.length, long.indexOf(' tomorrow'));
    expect(run(long, { notes: rest })).toMatchObject({ title: 'call the dentist', notes: rest });
  });
});
