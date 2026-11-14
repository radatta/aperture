import { describe, expect, it } from 'vitest';
import { API_METHODS, blockTitle } from '@aperture/shared';
import type { ApiMethod } from '@aperture/shared';
import { CAPTURE_MAX, RPC_ARGS, TASK_TITLE_MAX, TEXT_MAX, checkArgs } from './argSpecs';
import type { ArgSpecs } from './argSpecs';
import { ShapeError, obj, opt, str } from './shape';

const passes = (method: ApiMethod, args: unknown[]) =>
  expect(() => checkArgs(method, args), `${method} ${JSON.stringify(args)}`).not.toThrow();
const refuses = (method: ApiMethod, args: unknown[], msg: string | RegExp) => {
  expect(() => checkArgs(method, args), `${method} ${JSON.stringify(args)}`).toThrow(ShapeError);
  expect(() => checkArgs(method, args)).toThrow(msg);
};

const series = {
  title: 'Gym',
  categoryId: null,
  defaultEstimateMin: 30,
  rule: { kind: 'weekly', daysOfWeek: [1, 3] },
  anchorDate: '2026-11-13',
};
const ref = { accountSub: 'g-sub', calendarId: 'primary' };

describe('the RPC argument specs', () => {
  it('has a spec for every API method', () => {
    expect(Object.keys(RPC_ARGS).sort()).toEqual([...API_METHODS].sort());
  });

  it('stays in lockstep with ApiClient at the type level', () => {
    // A spec of the wrong arity, a too-wide check or a missing field fails typecheck (the satisfies).
    // @ts-expect-error — createTask takes one argument
    const arity: ArgSpecs['createTask'] = [];
    // @ts-expect-error — a plain string check is too wide for a TaskStatus
    const wide: ArgSpecs['transitionTask'] = [str(10), str(10)];
    const fields = { title: str(10), result: opt(str(10)) };
    // @ts-expect-error — the story spec is missing fields
    const missing: ArgSpecs['createStory'] = [obj('story', fields)];
    expect([arity, wide, missing]).toHaveLength(3);
  });

  it('passes the legal calls the app, MCP and the harness send', () => {
    const legal: [ApiMethod, unknown[]][] = [
      ['listBacklog', []],
      ['createTask', [{ title: 'x' }]],
      [
        'createTask',
        [
          {
            title: 'x',
            categoryId: null,
            estimateMin: 30,
            bufferMin: null,
            dueDay: '2026-11-13',
            dueTime: '18:00',
            notes: 'n',
            parentId: null,
            place: 'grocer',
          },
        ],
      ],
      ['createTasks', [[]]],
      ['createLogEntry', ['hello', '2026-11-13']],
      ['createLogEntry', ['hello', '2026-11-13', { private: true }]],
      ['setTaskActual', ['t', 30]],
      ['setTaskActual', ['t', 30, null]],
      ['setTaskDue', ['t', { dueDay: null }]],
      ['splitTask', ['t', { finish: 'keep', followUp: { title: 'r', estimateMin: null } }]],
      ['upsertSeries', [series]],
      [
        'upsertSeries',
        [{ ...series, id: 's', rule: { kind: 'everyN', interval: 2 }, until: null }],
      ],
      ['upsertSeries', [{ ...series, rule: { kind: 'weekly', daysOfWeek: [] } }]],
      ['stopSession', ['s', 'completed']],
      ['stopSession', ['s', 'completed', { capMin: 5 }]],
      ['listIdeas', []],
      ['listSittings', []],
      ['upsertCategory', [{ label: 'x' }]],
      ['upsertCategory', [{ id: 'c', area: null }]],
      ['upsertPlace', [{ name: 'Grocer' }]],
      ['updateSettings', [{ calendarShapeRefs: [ref], calendarWriteDefault: ref, theme: 'dark' }]],
      ['updateSettings', [{ fluxSets: { 'chin-tuck': 3 }, remindTimed: false }]],
      ['subscribePush', [{ endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' }, label: 'l' }]],
      ['setSittingReview', ['s', { help: 'none', mistakes: [], tags: [] }]],
      [
        'createStory',
        [{ title: 'x', competencyTags: ['ownership'], situation: 's'.repeat(TEXT_MAX) }],
      ],
      ['updateStory', ['s', { result: 'r' }]],
      ['createPlaidLinkToken', [{ mode: 'connect' }]],
      ['createPlaidLinkToken', [{ mode: 'update', itemId: 'i' }]],
      [
        'exchangePlaidPublicToken',
        [
          {
            publicToken: 'public-sandbox-x',
            institution: { id: 'ins_1', name: 'Bank' },
            accounts: [
              { id: 'a', name: 'Checking', mask: '0000', type: 'depository', subtype: null },
            ],
          },
        ],
      ],
      ['setFinanceBucket', [{ ids: ['t'], bucket: null, rule: { pattern: 'x' } }]],
      ['listFluxSets', [{}]],
      ['getCalibration', [{ from: '2026-11-01', to: '2026-11-13' }]],
      ['lcSittingStart', [{ anything: 'the normalizer owns it' }]],
    ];
    for (const [m, a] of legal) passes(m, a);
  });

  it('passes the long titles real callers send: an idea made a task, an unparsed capture line', () => {
    passes('createTask', [{ title: 'i'.repeat(TASK_TITLE_MAX) }]);
    passes('createLogEntry', ['l'.repeat(CAPTURE_MAX), '2026-11-13']);
    passes('createLogEntry', ['l'.repeat(25_000), '2026-11-13']); // a long paste into the capture bar
    passes('createIdea', ['l'.repeat(25_000)]);
    passes('parseTask', ['l'.repeat(25_000)]); // saved raw past PARSE_TEXT_MAX
    passes('createTasks', [Array(600).fill({ title: 'bulk' })]);
    passes('createTasks', [[{ title: 'c'.repeat(2500) }]]);
    passes('createAttachmentUploadUrl', [
      { taskId: 't', filename: 'f'.repeat(255), contentType: 'image/png', size: 1 },
    ]);
  });

  it('passes a longest title wherever it is copied: a split, a calendar block', () => {
    const title = 't'.repeat(TASK_TITLE_MAX);
    // SplitForm: a standalone task's parent takes its title; the rest is `<title> (cont.)`.
    passes('splitTask', [
      'id',
      {
        finish: 'keep',
        parentTitle: title,
        title,
        followUp: { title: `${title} (cont.)`, estimateMin: null },
      },
    ]);
    // AddToCalendarForm and MCP's create_calendar_event: a part's block is "Parent · Part".
    passes('insertCalendarEvent', [
      {
        taskId: 't',
        accountSub: 'a',
        calendarId: 'c',
        title: blockTitle({ title }, 'p'.repeat(TASK_TITLE_MAX)),
        startMs: 1,
        endMs: 2,
      },
    ]);
  });

  it('refuses a null where the type is not nullable, even in an optional slot', () => {
    refuses('listAttachments', [null], /^taskId must be text$/);
    refuses('listIdeas', [null], /^status must be text$/);
    refuses('stopSession', ['s', 'completed', null], /^options must be an object$/);
    passes('setTaskActual', ['t', 30, null]); // nullable: clears the reflection
  });

  it('refuses values stored as sent with no domain rule behind them', () => {
    refuses('triageIdea', ['i', 'archived'], /^status must be one of open, triaged, discarded$/);
    refuses(
      'setFinancePeriodOverride',
      ['t', 'later'],
      /^override must be one of current, previous$/,
    );
    refuses(
      'createStory',
      [{ title: 'x', competencyTags: ['teamwork'] }],
      /competencyTags\[0\] must be one of/,
    );
  });

  it('refuses a wrong top-level shape, a missing argument and an extra one', () => {
    refuses('createTask', [null], /^task must be an object$/);
    refuses('createTask', [], /^createTask: task is required$/);
    refuses('setTaskTitle', ['t'], /^setTaskTitle: title is required$/);
    refuses('setTaskTitle', ['t', 5], /^title must be text$/);
    refuses('getDay', ['2026-11-13', { consistent: true }], /^getDay takes at most 1 argument$/);
    refuses('listTasks', [1], /^listTasks takes at most 0 arguments$/);
    passes('getDay', ['2026-11-13', undefined]); // an in-process trailing undefined is no argument
    refuses('setLogEntryPrivate', ['e', 'yes'], /^private must be true or false$/);
  });

  it('refuses nested objects that would be stored as sent (F46)', () => {
    const bad: [ApiMethod, unknown[], RegExp][] = [
      ['upsertSeries', [{ ...series, rule: 'weekly' }], /^rule must be an object$/],
      ['upsertSeries', [{ ...series, rule: { kind: 'monthly' } }], /^rule\.kind must be one of/],
      ['upsertSeries', [{ ...series, rule: { kind: 'weekly', daysOfWeek: [7] } }], /0 to 6/],
      [
        'upsertSeries',
        [{ ...series, rule: { kind: 'weekly', daysOfWeek: Array(8).fill(1) } }],
        /7 items/,
      ],
      ['upsertSeries', [{ ...series, rule: { kind: 'everyN', interval: 0 } }], /at least 1/],
      [
        'upsertSeries',
        [{ ...series, rule: { kind: 'daily', daysOfWeek: [1] } }],
        /Unknown rule field: daysOfWeek/,
      ],
      [
        'updateSettings',
        [{ calendarShapeRefs: [{ accountSub: 1, calendarId: 'c' }] }],
        /accountSub must be text/,
      ],
      ['updateSettings', [{ calendarShapeRefs: Array(51).fill(ref) }], /50 items/],
      [
        'updateSettings',
        [{ calendarWriteDefault: { ...ref, extra: 1 } }],
        /Unknown calendar field: extra/,
      ],
      ['updateSettings', [{ theme: 'neon' }], /theme must be one of/],
      ['updateSettings', [{ dayStartHour: '4' }], /dayStartHour must be a number/],
      ['createStory', [{ title: 'x', competencyTags: { a: 1 } }], /competencyTags must be a list/],
      ['createStory', [{ title: 'x', competencyTags: Array(7).fill('ownership') }], /6 items/],
      ['updateStory', ['s', { situation: 's'.repeat(TEXT_MAX + 1) }], /limited to 20000/],
      ['setSittingReview', ['s', { help: 'none', extra: 1 }], /^Unknown review field: extra$/],
      [
        'subscribePush',
        [{ endpoint: 'https://x', keys: {}, label: 'l', userId: 'm' }],
        /^Unknown push subscription field: userId$/,
      ],
      ['setFinancePeriodOverride', ['t', { current: true }], /override must be one of/],
      [
        'exchangePlaidPublicToken',
        [{ publicToken: 'p', institution: { id: 1 }, accounts: [] }],
        /institution\.id must be text/,
      ],
      [
        'createPlaidLinkToken',
        [{ mode: 'connect', itemId: 'i' }],
        /Unknown link token field: itemId/,
      ],
      ['setFinanceBucket', [{ ids: Array(2001).fill('t'), bucket: null }], /2000 items/],
      [
        'insertCalendarEvent',
        [{ taskId: 't', accountSub: 'a', calendarId: 'c', title: { t: 1 }, startMs: 1, endMs: 2 }],
        /title must be text/,
      ],
      ['createTask', [{ title: 't'.repeat(TASK_TITLE_MAX + 1) }], /title is limited to 40000/],
      [
        'createTasks',
        [[{ title: 'ok' }, { title: 'x', userId: 'm' }]],
        /Unknown task field: userId/,
      ],
      [
        'splitTask',
        ['t', { finish: 'keep', followUp: { title: 'r', estimateMin: 'five' } }],
        /followUp\.estimateMin must be a number of minutes/,
      ],
      ['createLogEntry', [{ text: 'x' }, '2026-11-13'], /^text must be text$/],
      ['createIdea', [['x']], /^text must be text$/],
      ['setDayIntent', ['2026-11-13', { a: 1 }], /^intent must be text$/],
      [
        'upsertHabit',
        [{ name: { a: 1 }, categoryId: null, cadencePerWeek: 3 }],
        /^name must be text$/,
      ],
    ];
    for (const [m, a, msg] of bad) refuses(m, a, msg);
  });

  it('refuses a non-object flux set here: fluxSetError reads fields without checking', () => {
    refuses('recordFluxSet', [null], /^flux set must be an object$/);
    refuses('recordFluxSet', ['x'], /^flux set must be an object$/);
  });

  it('keeps the two ingest methods to arity, so their normalizers keep their own messages', () => {
    passes('lcSittingStart', [null]);
    passes('lcSittingEvents', [{ sittingId: 's', events: 'not a list', extra: 1 }]);
    refuses('lcSittingStart', [{}, {}], /lcSittingStart takes at most 1 argument/);
  });
});
