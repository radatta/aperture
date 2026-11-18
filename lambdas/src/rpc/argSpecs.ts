// The RPC boundary's argument shapes: one entry per ApiClient method, a check per positional argument.
// handleRpc runs checkArgs before any backend is built, so a call off the wire (/api, /mcp, the local
// edge) with the wrong shape is a ShapeError — a 400 naming the problem — never a TypeError deep in a
// handler or a nested object stored as sent. The `satisfies` keeps this table in lockstep with ApiClient:
// a new method, a changed arity or a new input field without a check here fails typecheck.
import { COMPETENCY_TAGS, TOKEN_SCOPES } from '@aperture/shared';
import type {
  ApiClient,
  ApiMethod,
  Area,
  CalendarRef,
  CreateLinkTokenInput,
  CreateTaskInput,
  DateRange,
  FinanceBucket,
  IdeaStatus,
  LinkAccountMeta,
  RecurrenceRule,
  TaskStatus,
  CreateCategoryInput,
  SittingReviewInput,
  SittingReviewPatch,
  CatalogImportInput,
  CoachSlotInput,
  CoachAttemptInput,
  CoachVoidInput,
  ClaudeNotesInput,
  MockInput,
  PatternId,
  SubscribePushInput,
  UpdateCategoryInput,
  UpsertCategoryInput,
} from '@aperture/shared';
import type { Check } from './shape';
import {
  ShapeError,
  arr,
  as,
  bool,
  int,
  lit,
  named,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  owned,
  str,
  strOf,
} from './shape';

// Generic bounds — far above every domain cap behind them (TASK_NOTES_MAX 5000, a reflection 1000, a
// place name 40), so they only stop what no legitimate client sends.
export const ID_MAX = 128; // ULIDs are 26; Plaid ids ~37; Google subs ~21
export const CALENDAR_ID_MAX = 256; // group calendar ids run ~90
export const KEY_MAX = 64; // day keys, clock times, enum-ish strings a domain rule owns
export const NAME_MAX = 200; // a habit, roll, category, account or file name
// Free prose, and titles typed fresh (a series, a story). 4× TASK_NOTES_MAX; three story fields stay under
// DynamoDB's 400 KB.
export const TEXT_MAX = 20_000;
// What a capture line can become as sent: a log entry or an idea. The capture field has no maxLength, so
// this sits far out and only stops a body nothing types (one field near 300 KB at 3 bytes a character).
export const CAPTURE_MAX = 100_000;
// A task title, typed or copied in (an idea made a task, an unparsed capture line saves raw). Lower than
// CAPTURE_MAX because the task row can hold it twice — its synced event's title (gcalSeen) is the
// "Parent · Part" block title — and the row must stay under 400 KB. A body bound, not a guarantee.
export const TASK_TITLE_MAX = 40_000;
// Where a task title is copied with a few words added: a split's titles (`… (cont.)`), and a calendar
// block's "Parent · Part" (two titles and a separator).
export const SPLIT_TITLE_MAX = TASK_TITLE_MAX + NAME_MAX;
export const BLOCK_TITLE_MAX = 2 * TASK_TITLE_MAX + NAME_MAX;
export const FILENAME_MAX = 1024; // the raw file name; sanitizeFilename trims it to 200
export const BATCH_MAX = 2000; // createTasks inputs, setFinanceBucket ids; RPC_BODY_MAX bounds them too
export const CALENDAR_REFS_MAX = 50;
export const PLAID_ACCOUNTS_MAX = 100;
export const RPC_BODY_MAX = 1024 * 1024; // non-ingest bodies (index.ts); ingest keeps its 300 KB

// A count of minutes; the domain owns its range (a negative estimate's own refusal).
const minutes: Check<number> = {
  ...num,
  run: (v, p) => {
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw new ShapeError(`${p} must be a number of minutes`);
  },
};

const id = named('id', str(ID_MAX));
const idAs = (name: string) => named(name, str(ID_MAX));
const day = named('day', str(KEY_MAX));
const text = named('text', str(TEXT_MAX));
const captured = named('text', str(CAPTURE_MAX));
const range = obj<DateRange>('range', { from: str(KEY_MAX), to: str(KEY_MAX) });
const calendarRef = obj<CalendarRef>('calendar', {
  accountSub: str(ID_MAX),
  calendarId: str(CALENDAR_ID_MAX),
});
const capOpts = opt(obj<{ capMin?: number }>('options', { capMin: opt(minutes) }));

const taskInput = obj<CreateTaskInput>('task', {
  title: str(TASK_TITLE_MAX),
  categoryId: opt(nullable(str(ID_MAX))),
  estimateMin: opt(nullable(minutes)),
  bufferMin: opt(nullable(minutes)),
  dueDay: opt(nullable(str(KEY_MAX))),
  dueTime: opt(nullable(str(KEY_MAX))),
  notes: opt(nullable(str(TEXT_MAX))),
  parentId: opt(nullable(str(ID_MAX))),
  place: opt(nullable(str(KEY_MAX))),
});

// Whole days, 0 = Sunday; an interval of at least one day (seriesDueOn reads ≤ 0 as never).
const weekday: Check<number> = {
  ...int,
  run: (v, p) => {
    int.run(v, p);
    if ((v as number) < 0 || (v as number) > 6) throw new ShapeError(`${p} must be 0 to 6`);
  },
};
const interval: Check<number> = {
  ...int,
  run: (v, p) => {
    int.run(v, p);
    if ((v as number) < 1) throw new ShapeError(`${p} must be at least 1`);
  },
};
const rule = oneOf<RecurrenceRule>('rule', 'kind', {
  daily: obj<{ kind: 'daily' }>('rule', { kind: lit('daily') }),
  weekdays: obj<{ kind: 'weekdays' }>('rule', { kind: lit('weekdays') }),
  weekly: obj<{ kind: 'weekly'; daysOfWeek: number[] }>('rule', {
    kind: lit('weekly'),
    daysOfWeek: arr(weekday, 7),
  }),
  everyN: obj<{ kind: 'everyN'; interval: number }>('rule', {
    kind: lit('everyN'),
    interval,
  }),
});

// A create/update pair spec'd as one object, every field optional: which ones a create needs is the
// domain's rule (its 'needs label and isWork' refusal). Typed by the update's fields, so a new one fails
// typecheck here; the create must carry no field the update lacks.
type CategoryFields = Partial<UpdateCategoryInput>;
const createKeysCovered: keyof CreateCategoryInput extends keyof CategoryFields ? true : never =
  true;
void createKeysCovered;
const categoryInput = as<UpsertCategoryInput>(
  obj<CategoryFields>('category', {
    id: opt(str(ID_MAX)),
    label: opt(str(NAME_MAX)),
    isWork: opt(bool),
    order: opt(num),
    active: opt(bool),
    area: opt(nullable(strOf<Area>(KEY_MAX))),
  }),
);

const storyFields = {
  competencyTags: opt(arr(lit(...COMPETENCY_TAGS), COMPETENCY_TAGS.length)), // no domain check behind it
  situation: opt(str(TEXT_MAX)),
  action: opt(str(TEXT_MAX)),
  result: opt(str(TEXT_MAX)),
};

// The two LeetCode ingest methods keep arity only: their normalizers check every field with the
// extension's messages, and an extension in the wild can't change its keys in lockstep with this table.
// Each list is checked against its type's keys, so a new input field fails typecheck until it's here.
const keysOf = <T>(all: Record<keyof T, true>): string[] => Object.keys(all);
const SITTING_REVIEW_KEYS = keysOf<SittingReviewInput>({
  insight: true,
  help: true,
  mistakes: true,
  howItWent: true,
  tags: true,
  draftUsed: true,
  cause: true,
  test: true,
});
const REVIEW_PATCH_KEYS = keysOf<SittingReviewPatch>({ cause: true, help: true, test: true });
const SLOT_KEYS = keysOf<CoachSlotInput>({ slug: true, action: true, toSlug: true });
const VOID_KEYS = keysOf<CoachVoidInput>({ day: true, slug: true, void: true });
const NOTES_KEYS = keysOf<ClaudeNotesInput>({ sittingId: true, text: true });
const MOCK_KEYS = keysOf<MockInput>({
  id: true,
  day: true,
  status: true,
  kind: true,
  partner: true,
  sittingId: true,
  problemSlug: true,
  scores: true,
  notes: true,
});
const CATALOG_IMPORT_KEYS = keysOf<CatalogImportInput>({
  classes: true,
  part: true,
  parts: true,
  limit: true,
});
const ATTEMPT_KEYS = keysOf<CoachAttemptInput>({
  slug: true,
  title: true,
  day: true,
  outcome: true,
  help: true,
  cause: true,
  minutes: true,
  note: true,
  historical: true,
  difficulty: true,
  accepted: true,
});
const PUSH_KEYS = keysOf<SubscribePushInput>({ endpoint: true, keys: true, label: true });

type Positional<F> = F extends (...a: infer P) => unknown
  ? { [I in keyof Required<P>]: Check<P[I]> }
  : never;
export type ArgSpecs = { [M in keyof ApiClient]: Positional<ApiClient[M]> };

export const RPC_ARGS = {
  // Log
  listLogEntries: [day],
  createLogEntry: [
    captured,
    day,
    named('opts', opt(obj<{ private?: boolean }>('options', { private: opt(bool) }))),
  ],
  updateLogEntry: [id, captured],
  listLogRange: [
    obj<Partial<DateRange>>('range', { from: opt(str(KEY_MAX)), to: opt(str(KEY_MAX)) }),
  ],
  deleteLogEntry: [id],
  setLogEntryPrivate: [id, named('private', bool)], // 'private must be…' (the private-log scenario reads it)

  // Tasks
  listBacklog: [],
  listTasks: [],
  getTask: [id],
  createTask: [taskInput],
  createTasks: [named('inputs', arr(taskInput, BATCH_MAX))],
  parseTask: [captured], // runQuickParse saves a line over PARSE_TEXT_MAX raw
  setTaskEstimate: [
    id,
    named('estimateMin', nullable(minutes)),
    named('bufferMin', nullable(minutes)),
  ],
  setTaskCategory: [id, named('categoryId', nullable(str(ID_MAX)))],
  setTaskDueDay: [id, named('dueDay', nullable(str(KEY_MAX)))],
  setTaskDue: [
    id,
    obj('due', { dueDay: nullable(str(KEY_MAX)), dueTime: opt(nullable(str(KEY_MAX))) }),
  ],
  setTaskTitle: [id, named('title', str(TASK_TITLE_MAX))],
  setTaskNotes: [id, named('notes', nullable(str(TEXT_MAX)))],
  setTaskReflection: [id, named('reflection', nullable(str(TEXT_MAX)))],
  transitionTask: [id, named('to', strOf<TaskStatus>(KEY_MAX))],
  setTaskActual: [
    id,
    named('actualMin', minutes),
    named('reflection', opt(nullable(str(TEXT_MAX)))),
  ],
  splitTask: [
    id,
    obj('split', {
      finish: lit('done', 'keep'),
      title: opt(str(SPLIT_TITLE_MAX)),
      estimateMin: opt(nullable(minutes)),
      bufferMin: opt(nullable(minutes)),
      actualMin: opt(minutes),
      parentTitle: opt(str(SPLIT_TITLE_MAX)),
      followUp: obj('followUp', {
        title: str(SPLIT_TITLE_MAX),
        estimateMin: nullable(minutes),
        bufferMin: opt(nullable(minutes)),
      }),
    }),
  ],
  setTaskParent: [id, named('parentId', nullable(str(ID_MAX)))],
  deleteTask: [id],

  // Plans
  listPlansForDay: [day],
  upsertPlan: [
    obj('plan', {
      id: opt(str(ID_MAX)),
      taskId: str(ID_MAX),
      day: str(KEY_MAX),
      plannedMinutes: minutes,
      order: num,
    }),
  ],
  removePlan: [id],

  // Series
  listSeries: [],
  upsertSeries: [
    obj('series', {
      id: opt(str(ID_MAX)),
      title: str(TEXT_MAX),
      categoryId: nullable(str(ID_MAX)),
      defaultEstimateMin: nullable(minutes),
      rule,
      anchorDate: str(KEY_MAX),
      active: opt(bool),
      dueOffsetDays: opt(nullable(num)),
      until: opt(nullable(str(KEY_MAX))),
    }),
  ],
  deactivateSeries: [id],
  deleteSeries: [id],

  // Sessions
  startSession: [
    obj('session', {
      taskId: nullable(str(ID_MAX)),
      categoryId: nullable(str(ID_MAX)),
      kind: lit('work', 'break'),
      label: opt(nullable(str(NAME_MAX))),
      day: str(KEY_MAX),
    }),
  ],
  heartbeatSession: [id],
  resumeSession: [id],
  stopSession: [id, named('status', lit('completed', 'discarded')), named('opts', capOpts)],
  extendSession: [id, named('opts', capOpts)],
  listSessionsForDay: [day],
  findRunningSession: [],
  listRunningSessions: [],
  resolveStaleSession: [id, named('decision', lit('keep', 'discard'))],

  // Habits
  listHabits: [],
  upsertHabit: [
    obj('habit', {
      id: opt(str(ID_MAX)),
      name: str(NAME_MAX),
      categoryId: nullable(str(ID_MAX)),
      cadencePerWeek: num,
      active: opt(bool),
    }),
  ],
  checkHabit: [idAs('habitId'), named('date', str(KEY_MAX))],
  uncheckHabit: [idAs('habitId'), named('date', str(KEY_MAX))],
  listHabitChecks: [range],

  // Rolls
  listRolls: [],
  upsertRoll: [
    obj('roll', {
      id: opt(str(ID_MAX)),
      name: str(NAME_MAX),
      categoryId: nullable(str(ID_MAX)),
      estimateMin: nullable(minutes),
      active: opt(bool),
    }),
  ],
  pickRollToday: [idAs('rollId'), day],

  // Ideas
  listIdeas: [named('status', opt(strOf<IdeaStatus>(KEY_MAX)))],
  createIdea: [captured],
  triageIdea: [id, named('status', lit('open', 'triaged', 'discarded'))], // stored as sent

  // Day
  getDay: [day],
  peekDay: [day],
  setDayCapacity: [day, named('capacityHours', nullable(num))],
  setDayIntent: [day, named('intent', str(TEXT_MAX))],
  setDayReflection: [day, named('prompt', str(TEXT_MAX)), text],

  // Categories
  listCategories: [],
  upsertCategory: [categoryInput],
  setCategoryWork: [id, named('isWork', bool), named('backfillPast', bool)],
  setCategoryArea: [id, named('area', nullable(strOf<Area>(KEY_MAX)))],
  deleteCategory: [id, named('reassignToId', nullable(str(ID_MAX)))],

  // Places — name and slug are upsertPlace's and placeError's, with their own messages (a missing name
  // included: 'A place needs a name').
  listPlaces: [],
  upsertPlace: [
    obj('place', {
      id: opt(str(ID_MAX)),
      name: { ...owned<string>('place'), optional: true },
      slug: opt(owned('place')),
    }),
  ],
  deletePlace: [id, named('reassignToSlug', nullable(str(KEY_MAX)))],
  setTaskPlace: [id, named('place', nullable(str(KEY_MAX)))],
  listPlaceTasks: [named('slug', str(KEY_MAX))],
  getPlaceTokenStatus: [],
  rotatePlaceToken: [],
  revokePlaceToken: [],
  // Scoped tokens — the name is scopedTokenNameError's (blank, length, clash, the per-scope limit).
  listScopedTokens: [named('scope', lit(...TOKEN_SCOPES))],
  mintScopedToken: [named('scope', lit(...TOKEN_SCOPES)), named('name', str(NAME_MAX))],
  revokeScopedToken: [id],

  // Settings — fluxSets is fluxSetsError's (exercise ids and counts, with its own messages).
  getSettings: [],
  updateSettings: [
    obj(
      'settings',
      {
        dayStartHour: opt(num),
        pomodoroWorkMin: opt(num),
        pomodoroBreakMin: opt(num),
        theme: opt(lit('auto', 'light', 'dark')),
        calendarShapeRefs: opt(arr(calendarRef, CALENDAR_REFS_MAX)),
        calendarWriteDefault: opt(nullable(calendarRef)),
        autoCalendar: opt(bool),
        dayFocusStart: opt(num),
        dayEndHour: opt(num),
        financeBudgetCents: opt(num),
        financePaymentDay: opt(num),
        fluxRollId: opt(nullable(str(ID_MAX))),
        leetcodeRollId: opt(nullable(str(ID_MAX))),
        leetcodePremium: opt(bool),
        fluxDisclaimerAckAt: opt(nullable(num)),
        fluxSets: opt(owned('fluxSets')),
        remindTimed: opt(bool),
        remindDueDay: opt(bool),
        remindPlanned: opt(bool),
        coachAiPick: opt(bool),
        coachPlanMode: opt(lit('auto', 'balanced', 'catch-up')),
      },
      { notObject: 'settings patch must be an object' },
    ),
  ],

  // Reminders — parsePushInput rebuilds the subscription; unsubscribe refuses a non-id itself.
  subscribePush: [owned('push subscription', PUSH_KEYS)],
  unsubscribePush: [named('id', owned<string>('device'))],
  getPushStatus: [],
  sendTestPush: [],

  // Google Calendar
  googleConnectUrl: [],
  getGoogleStatus: [],
  listGoogleCalendars: [],
  getCalendarBusy: [obj('busy query', { day: str(KEY_MAX), windowStartMs: num, windowEndMs: num })],
  insertCalendarEvent: [
    obj('event', {
      taskId: str(ID_MAX),
      accountSub: str(ID_MAX),
      calendarId: str(CALENDAR_ID_MAX),
      title: str(BLOCK_TITLE_MAX),
      startMs: num,
      endMs: num,
    }),
  ],
  deleteCalendarEvent: [idAs('taskId')],
  syncCalendarEvent: [idAs('taskId')],
  pullCalendar: [],
  disconnectGoogleAccount: [idAs('accountSub')],

  // Calibration
  getCalibration: [range],

  // LeetCode sittings
  lcSittingStart: [owned('sitting')],
  lcSittingEvents: [owned('sitting events')],
  listSittings: [opt(range)],
  getSitting: [id],
  pullLiveSitting: [],
  reopenSitting: [id],
  listSittingReplay: [id],
  setSittingPrepTarget: [id, named('prepTarget', str(KEY_MAX))],
  setSittingReview: [id, owned('review', SITTING_REVIEW_KEYS)],
  draftSittingReview: [id],
  deleteSitting: [id],
  patchSittingReview: [id, owned('patch', REVIEW_PATCH_KEYS, { object: true })],

  // The LeetCode coach — the normalizers in coach.ts check every field with their own messages.
  getCoachToday: [opt(day)],
  startCoachPick: [],
  listProblemRecords: [],
  getCoachStats: [opt(owned('range', ['from', 'to'], { object: true }))],
  setCoachSlot: [owned('slot', SLOT_KEYS, { object: true })],
  setCoachFloor: [named('on', bool)],
  setCoachFocus: [nullable(strOf<PatternId>(KEY_MAX))],
  logCoachAttempts: [
    arr(owned<CoachAttemptInput>('attempt', ATTEMPT_KEYS, { object: true }), BATCH_MAX),
  ],
  deleteCoachAttempt: [id],
  listLegacyGroups: [opt(str(KEY_MAX))],
  // The normalizers (coach.ts) check every field and the batch caps with their own messages.
  setCoachVoids: [arr(owned<CoachVoidInput>('void', VOID_KEYS, { object: true }), BATCH_MAX)],
  setSittingClaudeNotes: [
    arr(owned<ClaudeNotesInput>('note', NOTES_KEYS, { object: true }), BATCH_MAX),
  ],
  // normalizeMock (coach.ts) checks every field with its own messages.
  upsertMock: [owned<MockInput>('mock', MOCK_KEYS, { object: true })],
  listMocks: [],
  deleteMock: [id],
  // The full catalog — normalizeCatalogImport checks every field with its own messages (a part's 64 k bound).
  getCatalogStatus: [],
  startCatalogImport: [owned('import', CATALOG_IMPORT_KEYS, { object: true })],

  // Flux — fluxSetError checks every field of a set and the row is rebuilt from them.
  recordFluxSet: [owned('flux set', undefined, { object: true })],
  listFluxSets: [
    opt(
      obj('filter', {
        from: opt(str(KEY_MAX)),
        to: opt(str(KEY_MAX)),
        exerciseId: opt(str(KEY_MAX)),
      }),
    ),
  ],
  deleteFluxSet: [id],
  getFluxWeekNote: [],

  // Stories
  listStories: [],
  createStory: [obj('story', { title: str(TEXT_MAX), ...storyFields })],
  updateStory: [
    id,
    obj(
      'story',
      { title: opt(str(TEXT_MAX)), ...storyFields },
      { notObject: 'story patch must be an object' },
    ),
  ],
  deleteStory: [id],

  // Attachments
  createAttachmentUploadUrl: [
    obj('attachment', {
      taskId: str(ID_MAX),
      filename: str(FILENAME_MAX),
      contentType: str(NAME_MAX),
      size: num,
    }),
  ],
  confirmAttachment: [id],
  listAttachments: [opt(idAs('taskId'))],
  getAttachmentDownloadUrl: [id],
  deleteAttachment: [id],

  // Finances
  getFinanceOverview: [obj('overview query', { today: str(KEY_MAX) })],
  listFinanceTransactions: [range],
  setFinanceBucket: [
    obj('bucket change', {
      ids: arr(str(ID_MAX), BATCH_MAX),
      bucket: nullable(strOf<FinanceBucket>(KEY_MAX)),
      rule: opt(obj('rule', { pattern: str(NAME_MAX) })),
    }),
  ],
  setFinancePeriodOverride: [id, named('override', nullable(lit('current', 'previous')))],
  setFinanceNote: [id, named('note', nullable(str(TEXT_MAX)))],
  setFinancePeriodStart: [id, named('marked', bool)],
  linkFinanceRefund: [idAs('refundId'), named('chargeId', nullable(str(ID_MAX)))],
  listFinanceRules: [],
  upsertFinanceRule: [
    obj('rule', {
      id: opt(str(ID_MAX)),
      pattern: str(NAME_MAX),
      bucket: strOf<FinanceBucket>(KEY_MAX),
      active: opt(bool),
    }),
  ],
  deleteFinanceRule: [id],
  updateFinanceAccount: [
    id,
    obj('account', { signOverride: opt(lit('auto', 'flip')), hidden: opt(bool) }),
  ],
  createPlaidLinkToken: [
    oneOf<CreateLinkTokenInput>('link token', 'mode', {
      connect: obj<{ mode: 'connect' }>('link token', { mode: lit('connect') }),
      update: obj<{ mode: 'update'; itemId: string }>('link token', {
        mode: lit('update'),
        itemId: str(ID_MAX),
      }),
    }),
  ],
  exchangePlaidPublicToken: [
    obj('Plaid link', {
      publicToken: str(NAME_MAX),
      institution: obj('institution', { id: str(ID_MAX), name: str(NAME_MAX) }),
      // Read for the duplicate-login check and never stored; Link adds fields (verification_status…).
      accounts: arr(
        obj<LinkAccountMeta>(
          'account',
          {
            id: str(ID_MAX),
            name: str(NAME_MAX),
            mask: nullable(str(KEY_MAX)),
            type: str(KEY_MAX),
            subtype: nullable(str(KEY_MAX)),
          },
          { extraKeys: 'allow' },
        ),
        PLAID_ACCOUNTS_MAX,
      ),
    }),
  ],
  completePlaidUpdate: [idAs('itemId')],
  removePlaidItem: [idAs('itemId')],
  requestFinanceSync: [obj('sync request', { refresh: bool })],

  exportData: [],
} as const satisfies ArgSpecs;

// The boundary check: at most the method's arity (an extra argument that isn't undefined is refused —
// getDay's backend-only second parameter is not the wire's), each required argument present, each
// present one its shape. A null is a value, refused where the type isn't nullable: the app drops trailing
// undefined arguments (httpClient's omitTrailing), and a handler can read a null as a real value
// (listAttachments(null) would look up a task named "null").
export function checkArgs(method: ApiMethod, args: readonly unknown[]): void {
  const spec = RPC_ARGS[method] as readonly Check<unknown>[];
  const extra = args.slice(spec.length).some((a) => a !== undefined);
  if (extra)
    throw new ShapeError(
      `${method} takes at most ${spec.length} argument${spec.length === 1 ? '' : 's'}`,
    );
  spec.forEach((c, i) => {
    const v = args[i];
    const name = c.name ?? `argument ${i + 1}`;
    if (v === undefined) {
      if (!c.optional) throw new ShapeError(`${method}: ${name} is required`);
      return;
    }
    c.run(v, c.obj ? '' : name);
  });
}
