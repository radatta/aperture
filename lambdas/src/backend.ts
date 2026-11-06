import {
  assertAttachmentAllowed,
  assertCategoryDeletable,
  AUTO_PLACED_ERROR,
  autoSyncOn,
  calendarPullPlan,
  calendarSyncPlan,
  seenAfter,
  syncedFieldsChanged,
  accruesTime,
  completeSession,
  countsTowardCap,
  createUlid,
  dayKey,
  dayKeyForOffset,
  discardSession,
  eventWindow,
  syncWindow,
  gcalSyncMessage,
  isPendingRemoval,
  FINANCE_DEFAULT_BUDGET_CENTS,
  FINANCE_DEFAULT_PAYMENT_DAY,
  findOpenRollTask,
  heartbeatSession,
  normalizeContentType,
  normalizeDue,
  normalizeNotes,
  normalizeReflection,
  normalizeVerdict,
  resolveStaleSession,
  resumeSession,
  ROLL_PLAN_FALLBACK_MIN,
  rollRepFields,
  sanitizeFilename,
  seriesCadence,
  seriesDueOn,
  seriesHasOccurrence,
  occurrenceFields,
  setNotesArg,
  setReflectionArg,
  followUpPlanDay,
  followUpPlanMinutes,
  assertCanBePart,
  becomeParent,
  calibrationTasks,
  cancelParent,
  completeParent,
  freezeParentLock,
  hasParts,
  newParentFrom,
  PARENT_NO_ACTUAL_ERROR,
  PARENT_NO_ESTIMATE_ERROR,
  PARENT_NO_EVENT_ERROR,
  PARENT_NO_PLAN_ERROR,
  isTimed,
  TIMED_NO_PLAN_ERROR,
  FUTURE_DAY_ERROR,
  isDayKey,
  PARENT_NO_SPLIT_ERROR,
  PARENT_NO_START_ERROR,
  partsOf,
  rollupParts,
  releaseParent,
  splitFollowUp,
  rescopedPlanMinutes,
  splitOriginal,
  stalePlannedMoves,
  taskTransition,
  UPLOAD_URL_TTL_MS,
  USER_TIME_ZONE,
  viewableInline,
  withEstimate,
  zonedDayTime,
  PULL_THROTTLE_MS,
  dayKeyInZone,
  parseBudgetMs,
  runQuickParse,
  userDueEpoch,
  placeDigestOf,
  placeError,
  placeUnknownError,
  PLACE_FINISHED_ERROR,
  PLACE_PART_ERROR,
  PLACE_TOKEN_RACE_ERROR,
  slugify,
} from '@aperture/shared';
import type {
  ApiClient,
  Attachment,
  BaseEntity,
  BusyInterval,
  CalendarBusy,
  CalibrationPoint,
  Category,
  CreateAttachmentInput,
  CreateLinkTokenInput,
  CreateTaskInput,
  DateRange,
  Day,
  GetCalendarBusyInput,
  GoogleCalendar,
  GoogleStatus,
  InsertCalendarEventInput,
  ExchangePublicTokenInput,
  ExportBundle,
  FinanceAccount,
  FinanceAccountPatch,
  FinanceItem,
  FinanceOverview,
  FinancePeriodOverride,
  FinanceRule,
  FinanceTransaction,
  LinkTokenResult,
  RequestFinanceSyncResult,
  SetFinanceBucketInput,
  SetTaskDueInput,
  SplitTaskInput,
  SyncContext,
  UpsertFinanceRuleInput,
  Habit,
  HabitCheck,
  Idea,
  IdeaStatus,
  LeetcodeAttempt,
  FluxSet,
  FluxSetFilter,
  RecordFluxSetInput,
  LogEntry,
  Place,
  PlaceDigest,
  PlaceTokenStatus,
  PomodoroSession,
  RecordLeetcodeAttemptInput,
  Roll,
  Settings,
  SettingsPatch,
  StartSessionInput,
  Story,
  StoryPatch,
  CreateStoryInput,
  GcalSyncState,
  PullAction,
  PullCalendarResult,
  ParseTaskResult,
  PulledEvent,
  Task,
  TaskPlan,
  TaskSeries,
  TaskStatus,
  UpsertCategoryInput,
  UpsertHabitInput,
  UpsertPlaceInput,
  UpsertPlanInput,
  UpsertRollInput,
  UpsertSeriesInput,
} from '@aperture/shared';
import { fluxFilterError, fluxSetError, inRange } from '@aperture/shared/flux';
import type { Repo } from './ddb/repo';
import type { PlaceTokenPointer, PlaceTokenStore } from './ddb/placeTokens';
import { ConditionFailedError } from './ddb/DocClient';
import {
  countPlaceRead,
  hashPlaceToken,
  mintPlaceToken,
  readsToday,
  type PlaceReadAuth,
} from './auth/placeToken';
import { FinanceService } from './finance/service';
import { noopInvoker } from './finance/invoker';
import type { FinanceSyncInvoker } from './finance/invoker';
import { noopPlaid } from './plaid/gateway';
import type { PlaidGateway } from './plaid/gateway';
import { EventGoneError, noopGoogle, PullIncompleteError } from './google/gateway';
import type { GoogleGateway } from './google/gateway';
import { signState } from './google/state';
import type { Presigner } from './s3/presigner';
import type { ObjectStore } from './s3/objects';
import { noopAnthropic } from './anthropic/gateway';
import type { AnthropicGateway } from './anthropic/gateway';

export interface BackendOptions {
  userId?: string;
  now?: () => number;
  google?: GoogleGateway; // gated external calendar seam; defaults to the inert noop
  stateSecret?: string; // HMAC key for the OAuth state (derived from ORIGIN_SECRET in prod)
  presigner?: Presigner;
  objects?: ObjectStore; // gated S3 delete seam (attachment bytes); unconfigured → throws on use
  plaid?: PlaidGateway; // gated Plaid seam; defaults to the inert noop
  financeInvoker?: FinanceSyncInvoker; // starts a finance sync; defaults to nothing
  anthropic?: AnthropicGateway; // gated Claude API seam (quick add's parse); defaults to the inert noop
  placeTokens?: PlaceTokenStore; // the Shortcut token's lookup rows (outside the user partition)
}

// Non-attachment methods never touch it, so a missing presigner is only an error if an attachment method
// is actually called (e.g. a smoke run, or a misconfigured handler).
const unconfiguredPresigner: Presigner = {
  putUrl: () => {
    throw new Error('Attachments unavailable: no presigner configured.');
  },
  getUrl: () => {
    throw new Error('Attachments unavailable: no presigner configured.');
  },
};
// Same idea for deletes: a handler that forgot the store fails the delete loudly, never skips the bytes.
const unconfiguredObjects: ObjectStore = {
  deleteObject: () => {
    throw new Error('Attachments unavailable: no object store configured.');
  },
};
// And for the place token: only the token methods and the Shortcut read touch it.
const noPlaceTokens = (): never => {
  throw new Error('Place tokens unavailable: no token store configured.');
};
const unconfiguredPlaceTokens = {
  get: noPlaceTokens,
  create: noPlaceTokens,
  replace: noPlaceTokens,
  delete: noPlaceTokens,
  pointer: noPlaceTokens,
} as unknown as PlaceTokenStore;
const INACTIVE_TOKEN: PlaceTokenStatus = {
  active: false,
  createdAt: null,
  lastUsedAt: null,
  hint: null,
  readsToday: 0,
};

// The server-side ApiClient — the SAME contract as the stub, over the DynamoDB Repo. Business rules
// come straight from the shared machines (taskTransition/withEstimate/split/heartbeat/…), so lifecycle
// behavior is identical to the stub by construction. The one thing SK order doesn't give for free is
// the stub's explicit list sorts, so each list method re-applies them for byte-for-byte parity.
// Calendar inserts in flight at once for a bulk create (createTasks), and how long — measured from the
// call's start, so the task writes count — new ones may start for. Worst case: budget (3 s) + one
// sync's two Google fetches at GOOGLE_TIMEOUT_MS each (token refresh + insert, liveGoogle.ts) = 11 s,
// plus the uncapped-but-fast SSM token read and a few DynamoDB writes — inside the 15 s Lambda timeout.
const SYNC_CONCURRENCY = 4;
const BULK_SYNC_BUDGET_MS = 3_000;
// A calendar pull's budget (pullCalendar), from the request's start: unlike a paste, nothing is
// half-written if it runs out (the old sync token replays), so it may spend more. Each page's fetch is
// capped at what's left (liveGoogle.ts); the uncapped tail is one token refresh (4 s) on the first page
// plus the per-event DynamoDB writes — inside the 15 s Lambda timeout.
const PULL_BUDGET_MS = 8_000;

// A task's place as given ('' or absent is none), refused unless an alive place has that slug — the
// stub's knownPlace. The wire is untrusted JSON, so a non-string is refused too.
function knownPlace(slug: unknown, places: ReadonlySet<string>): string | null {
  if (slug === undefined || slug === null || slug === '') return null;
  if (typeof slug !== 'string' || !places.has(slug))
    throw new Error(placeUnknownError(String(slug)));
  return slug;
}
const byAdded = (a: Place, b: Place) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
const isFinished = (t: Task) => t.status === 'done' || t.status === 'cancelled';
// A part's place is its parent's: none given takes it, a different slug is refused. Not a part → as given.
function partPlace(given: string | null, parent: Task | undefined): string | null {
  if (!parent) return given;
  if (given !== null && given !== parent.place) throw new Error(PLACE_PART_ERROR);
  return parent.place;
}
// Every hash a new pointer must retire: the live one it replaces, plus any a cut-short delete left.
const retiringOf = (prev: PlaceTokenPointer | null): string[] =>
  prev ? [...new Set([...(prev.hash ? [prev.hash] : []), ...prev.retiring])] : [];

export class BackendClient implements ApiClient {
  private readonly userId: string;
  private readonly now: () => number;
  private readonly ulid: () => string;
  private readonly google: GoogleGateway;
  private readonly stateSecret: string;
  private readonly presigner: Presigner;
  private readonly objects: ObjectStore;
  private readonly finance: FinanceService;
  private readonly anthropic: AnthropicGateway;
  private readonly placeTokens: PlaceTokenStore;

  constructor(
    private readonly repo: Repo,
    opts: BackendOptions = {},
  ) {
    this.userId = opts.userId ?? 'local';
    this.now = opts.now ?? (() => Date.now());
    this.ulid = createUlid(this.now);
    this.google = opts.google ?? noopGoogle();
    this.stateSecret = opts.stateSecret ?? 'dev-state-secret';
    this.presigner = opts.presigner ?? unconfiguredPresigner;
    this.objects = opts.objects ?? unconfiguredObjects;
    this.anthropic = opts.anthropic ?? noopAnthropic();
    this.placeTokens = opts.placeTokens ?? unconfiguredPlaceTokens;
    this.finance = new FinanceService({
      repo,
      userId: this.userId,
      now: this.now,
      ulid: this.ulid,
      plaid: opts.plaid ?? noopPlaid(),
      invoker: opts.financeInvoker ?? noopInvoker(),
      settings: () => this.ensureSettings(),
    });
  }

  private baseAt(t: number): BaseEntity {
    return { id: this.ulid(), userId: this.userId, createdAt: t, updatedAt: t, deletedAt: null };
  }
  private base(): BaseEntity {
    return this.baseAt(this.now());
  }
  // The task literal, shared by createTask and createTasks. `t` is the createdAt stamp — a batch passes
  // one value for every task so they tie on createdAt and render as a block in ULID (paste) order.
  // `places` = the alive slugs (placeSlugsFor); an unknown one throws here, before any write. `tasks` =
  // the alive tasks when some input is a part (its parent's place is the part's — partPlace).
  private newTask(
    input: CreateTaskInput,
    t: number,
    places: ReadonlySet<string>,
    tasks: readonly Task[],
  ): Task {
    const parent = input.parentId ? tasks.find((x) => x.id === input.parentId) : undefined;
    return {
      ...this.baseAt(t),
      title: input.title,
      status: 'backlog',
      categoryId: input.categoryId ?? null,
      ...normalizeDue(input.dueDay ?? null, input.dueTime ?? null),
      notes: normalizeNotes(input.notes),
      reflection: null,
      seriesId: null,
      rollId: null,
      estimateMin: input.estimateMin ?? null,
      bufferMin: input.bufferMin ?? null,
      estimateLockedMin: null,
      parentId: input.parentId || null, // '' is no parent, never a link to validate
      place: partPlace(knownPlace(input.place, places), parent),
      actualAccruedMin: 0,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
      gcalSyncError: null,
    };
  }
  // A task taking its first part (parts.ts becomeParent): its estimate goes, it leaves its plan (rows
  // tombstoned), and its block becomes its due marker (a timed one with none gets one — one Google call
  // either way). Pass the task as it was; call AFTER the first part is written.
  private async adoptAsParent(parent: Task): Promise<Task> {
    const now = this.now();
    // Consistent: a row "+ Today" just wrote must go too.
    const plans = await this.repo.listAllPlans({ consistent: true });
    for (const p of plans.filter((p) => p.taskId === parent.id))
      await this.repo.putPlan({ ...p, deletedAt: now, updatedAt: now }, p);
    const became = await this.repo.putTask(becomeParent(parent, now));
    return this.syncCalendar(parent, became, true, undefined, { parent: true });
  }
  // The rollup's baseline, frozen when `starting` — the first part to leave planning — does
  // (parts.ts freezeParentLock). Freeze and release decide on the list straight after a task write, so
  // they read it strongly consistent: an eventually consistent query can miss that write.
  private async freezeLock(parentId: string | null, starting: string): Promise<void> {
    if (!parentId) return;
    const tasks = await this.repo.listTasks({ consistent: true });
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent) return;
    const frozen = freezeParentLock(parent, partsOf(tasks, parentId), starting, this.now());
    if (frozen) await this.repo.putTask(frozen);
  }
  // A task whose last part just went is plain again: its parts' lock goes (parts.ts releaseParent) and
  // its due marker turns back into a block.
  private async releaseParentState(parentId: string | null): Promise<void> {
    if (!parentId) return;
    const tasks = await this.repo.listTasks({ consistent: true });
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent || hasParts(tasks, parentId)) return;
    const released = releaseParent(parent, tasks, this.now());
    const plain = released ? await this.repo.putTask(released) : parent;
    if (plain.gcalEventId)
      await this.syncCalendar(plain, plain, true, undefined, { parent: false });
  }
  // `consistent` for a read whose copy is written back (updateSettings); display reads stay eventual.
  private async ensureSettings(opts?: { consistent?: boolean }): Promise<Settings> {
    const def: Settings = {
      ...this.base(),
      dayStartHour: 4,
      pomodoroWorkMin: 25,
      pomodoroBreakMin: 5,
      theme: 'auto',
      googleAccounts: [],
      calendarShapeRefs: [],
      calendarWriteDefault: null,
      autoCalendar: true,
      dayFocusStart: 8,
      dayEndHour: 22,
      financeBudgetCents: FINANCE_DEFAULT_BUDGET_CENTS,
      financePaymentDay: FINANCE_DEFAULT_PAYMENT_DAY,
      fluxRollId: null,
      fluxDisclaimerAckAt: null,
    };
    const row = await this.repo.getSettingsRow(opts);
    // Backfill defaults over an existing row: fields added later (the calendar set) read as their
    // default, not undefined, on settings written before those fields existed.
    if (row) return { ...def, ...row };
    await this.repo.putSettings(def);
    return def;
  }
  // The Lambda's clock is UTC — a task's wall-clock deadline is resolved in the user's zone, never locally.
  private readonly dueEpoch = userDueEpoch;
  private readonly pullTime = {
    epoch: this.dueEpoch,
    clock: (ms: number) => zonedDayTime(ms, USER_TIME_ZONE),
  };

  // Calendar auto-sync after a task write (shared calendarSyncPlan decides; docs/areas/calendar →
  // Auto-sync). The task is already saved: a Google failure never fails the write — it lands on the
  // task as gcalSyncError (shown with a retry) and is logged, and a failed remove keeps the event linked
  // so the retry can finish it. Returns the task as it now stands.
  //
  // `ctx` is what the caller already knows: `parent` (adopt and release know before the list does), and
  // `tasks`, a list to find a part's parent in (its title names the block). The event's look (marker or
  // block) heals from gcalSeen either way.
  private async syncCalendar(
    prev: Task | null,
    task: Task,
    ensure = false,
    known?: Settings, // a batch reads settings once
    ctx: Pick<SyncContext, 'parent'> & { tasks?: Task[] } = {},
  ): Promise<Task> {
    // Most writes are on untimed, unlinked tasks — nothing to sync, so don't even read settings.
    if (!task.dueTime && !task.gcalEventId && !task.gcalSyncError) return task;
    const settings = known ?? (await this.ensureSettings());
    // A parent's one event is its due marker (parts.ts) — the planner needs to know, and only the list
    // says. A brand-new task can't be one (its parts would have to exist first), so a create skips the
    // scan — a timed bulk paste pays for none of them inside its sync budget. The retry (ensure) always
    // looks. Strongly consistent: a part write comes straight before.
    const scan = ctx.parent === undefined && (prev !== null || ensure);
    const tasks = ctx.tasks ?? (scan ? await this.repo.listTasks({ consistent: true }) : undefined);
    const parent = ctx.parent ?? (scan ? hasParts(tasks!, task.id) : false);
    const parentTitle = task.parentId
      ? ((tasks?.find((t) => t.id === task.parentId) ?? (await this.repo.getTask(task.parentId)))
          ?.title ?? null)
      : null;
    const action = calendarSyncPlan(prev, task, settings, this.dueEpoch, {
      ensure,
      parent,
      parentTitle,
    });
    // A linked task's title/time/estimate edit — pushed, failed or not pushed at all (done, sync off) —
    // retires an "updated from Google" note it has just superseded.
    const edited =
      !!prev && !!task.gcalEventId && !!task.gcalPulled && syncedFieldsChanged(prev, task);
    const editStamp = edited ? { gcalPulled: null } : {};
    if (action.kind === 'none') {
      // A stale failure note goes once nothing is left to sync: no event and no time, sync turned off,
      // or the task finished — otherwise it'd sit there with a Retry that can't do anything.
      const moot =
        task.gcalSyncError &&
        ((!task.gcalEventId && !syncWindow(task, this.dueEpoch, parent)) ||
          settings.autoCalendar === false ||
          task.status === 'done' ||
          task.status === 'cancelled');
      if (!moot && !edited) return task;
      return this.putGcal(task, { ...(moot && { gcalSyncError: null }), ...editStamp });
    }
    const unlinked = {
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
      gcalSyncError: null,
      gcalSeen: null,
    };
    // A successful create/patch records the event as it now stands (gcalSeen — the base both directions
    // diff against), versioned by Google's `updated` for it (a delta state older than that is stale).
    try {
      if (action.kind === 'create') {
        const { eventId, updatedMs } = await this.google.insertEvent({
          sub: action.target.accountSub,
          calendarId: action.target.calendarId,
          title: action.title,
          startMs: action.startMs,
          endMs: action.endMs,
          taskId: task.id,
          marker: action.marker,
        });
        return this.putGcal(task, {
          gcalAccountId: action.target.accountSub,
          gcalCalendarId: action.target.calendarId,
          gcalEventId: eventId,
          gcalSyncError: null,
          gcalSeen: seenAfter(action, null, updatedMs),
          gcalPulled: null, // a "Removed in Google Calendar" mark no longer holds
        });
      }
      if (!task.gcalAccountId || !task.gcalCalendarId || !task.gcalEventId) return task;
      const ref = {
        sub: task.gcalAccountId,
        calendarId: task.gcalCalendarId,
        eventId: task.gcalEventId,
      };
      // Not via deleteCalendarEvent: that swallows Google errors (right for cancel/delete, where the
      // task is going away) — here a failed remove must surface. An already-gone event is a success.
      if (action.kind === 'delete') {
        await this.google.deleteEvent(ref).catch((e: unknown) => {
          if (!(e instanceof EventGoneError)) throw e;
        });
        return this.putGcal(task, unlinked);
      }
      let updatedMs: number;
      try {
        ({ updatedMs } = await this.google.patchEvent({
          ...ref,
          title: action.title,
          startMs: action.startMs,
          endMs: action.endMs,
          marker: action.marker,
        }));
      } catch (e) {
        if (!(e instanceof EventGoneError)) throw e;
        // Deleted in Google on purpose — drop the dead pointer, don't resurrect it. A later time change
        // creates a fresh one.
        return this.putGcal(task, unlinked);
      }
      return this.putGcal(task, {
        gcalSyncError: null,
        gcalSeen: seenAfter(action, task.gcalSeen, updatedMs),
        ...editStamp,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.log(
        JSON.stringify({ event: 'gcal_sync_failed', taskId: task.id, kind: action.kind, detail }),
      );
      return this.putGcal(task, {
        gcalSyncError: gcalSyncMessage(action.kind, detail),
        ...editStamp,
      });
    }
  }
  // Write only the calendar fields, onto a FRESH read: the sync spans a Google round-trip, and a
  // concurrent write (a session closing, an edit from another device) must not be overwritten by it.
  // (No row — a testMode write that never landed — falls back to the task in hand.)
  private async putGcal(
    task: Task,
    fields: Partial<
      Pick<
        Task,
        | 'gcalAccountId'
        | 'gcalCalendarId'
        | 'gcalEventId'
        | 'gcalSyncError'
        | 'gcalSeen'
        | 'gcalPulled'
      >
    >,
  ): Promise<Task> {
    // Consistent: it follows a write, and what it returns goes straight into the app's list.
    const fresh = (await this.repo.getTask(task.id, { consistent: true })) ?? task;
    return this.repo.putTask({ ...fresh, ...fields, updatedAt: this.now() });
  }
  // Consistent: every caller spreads what it reads into a put — a lagging read would write an older copy
  // over an edit a moment before (a title, then its due). One strongly consistent get per RPC.
  private async mustTask(id: string): Promise<Task> {
    const t = await this.repo.getTask(id, { consistent: true });
    if (!t) throw new Error(`Not found: ${id}`);
    return t;
  }

  // --- Log ---
  async listLogEntries(day: string): Promise<LogEntry[]> {
    return (await this.repo.listLog(day)).sort((a, b) => a.createdAt - b.createdAt);
  }
  async createLogEntry(text: string, day: string): Promise<LogEntry> {
    return this.repo.putLog({ ...this.base(), day, text });
  }
  async updateLogEntry(id: string, text: string): Promise<LogEntry> {
    const e = await this.repo.findLog(id, { consistent: true });
    if (!e) throw new Error(`Not found: ${id}`);
    return this.repo.putLog({ ...e, text, updatedAt: this.now() });
  }

  // --- Recruiting (LeetCode) ---
  async recordLeetcodeAttempt(input: RecordLeetcodeAttemptInput): Promise<LeetcodeAttempt> {
    // Extension is passive; metadata is DOM-scraped client-side (docs/areas/recruiting/index.md → Design
    // decisions). Log `metaCaptured` per ingest for the Logs Insights hit-rate query — deliberately no
    // custom metric (same doc → Watching an ingest).
    const metaCaptured =
      input.difficulty != null || (Array.isArray(input.topicTags) && input.topicTags.length > 0);
    console.log(
      JSON.stringify({ event: 'leetcode_ingest', problemSlug: input.problemSlug, metaCaptured }),
    );
    const dup = await this.repo.findLeetcodeBySubmissionId(input.leetcodeSubmissionId);
    if (dup) return dup; // idempotent — the extension may fire twice for one submission
    const start = (await this.ensureSettings()).dayStartHour;
    return this.repo.putLeetcodeAttempt({
      ...this.base(),
      day: dayKeyForOffset(input.submittedAt, input.tzOffsetMinutes, start),
      problemSlug: input.problemSlug,
      problemTitle: input.problemTitle,
      verdict: normalizeVerdict(input.statusCode, input.statusMsg),
      submittedAt: input.submittedAt,
      lang: input.lang,
      runtimeMs: input.runtimeMs ?? null,
      memory: input.memory ?? null,
      leetcodeSubmissionId: input.leetcodeSubmissionId,
      frontendId: input.frontendId ?? null,
      difficulty: input.difficulty ?? null,
      topicTags: input.topicTags ?? null,
    });
  }
  async listLeetcodeAttempts(range?: DateRange): Promise<LeetcodeAttempt[]> {
    return (await this.repo.listLeetcodeAttempts())
      .filter((a) => !range || (a.day >= range.from && a.day <= range.to))
      .sort((a, b) => b.submittedAt - a.submittedAt); // reverse-chron
  }

  // --- Flux sets (D47) ---
  async recordFluxSet(input: RecordFluxSetInput): Promise<FluxSet> {
    const err = fluxSetError(input);
    if (err) throw new Error(err);
    // Idempotent on the client's id — an outbox retry (even of a deleted set) gets the stored row back.
    const dup = await this.repo.findFluxSet(input.id);
    if (dup) return dup;
    const t = this.now();
    const set: FluxSet = {
      id: input.id,
      userId: this.userId,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      day: input.day,
      exerciseId: input.exerciseId,
      kind: input.kind,
      side: input.side,
      condition: input.condition,
      count: input.count,
      avgPeakDeg: input.avgPeakDeg ?? null,
      avgErrorDeg: input.avgErrorDeg ?? null,
      rom: { pitch: input.rom.pitch, yaw: input.rom.yaw, roll: input.rom.roll },
      calibrated: input.calibrated,
      delegate: input.delegate,
      durationSec: input.durationSec,
      completedAt: input.completedAt,
      repTaskId: input.repTaskId,
      stoppedEarly: input.stoppedEarly,
      planned: input.planned,
    };
    if (await this.repo.putFluxSetIfAbsent(set)) return set;
    // A concurrent retry won the write — read it back strongly, or an eventual read can miss the row.
    return (await this.repo.findFluxSet(input.id, { consistent: true })) ?? set;
  }
  async listFluxSets(filter?: FluxSetFilter): Promise<FluxSet[]> {
    const err = fluxFilterError(filter);
    if (err) throw new Error(err);
    return inRange(await this.repo.listAllFluxSets(), filter);
  }
  async deleteFluxSet(id: string): Promise<void> {
    // Strongly: a set saved moments ago must be found, or the delete would quietly do nothing.
    const existing = await this.repo.findFluxSet(id, { consistent: true });
    if (existing && existing.deletedAt === null)
      await this.repo.putFluxSet({ ...existing, deletedAt: this.now(), updatedAt: this.now() });
  }

  // --- Story bank ---
  // Consistent: its one caller writes the copy back.
  private async mustStory(id: string): Promise<Story> {
    const s = await this.repo.getStory(id, { consistent: true });
    if (!s) throw new Error(`Not found: ${id}`);
    return s;
  }
  async listStories(): Promise<Story[]> {
    // Same sort the stub applies (SK order doesn't give updatedAt-desc for free).
    return (await this.repo.listStories()).sort(
      (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
    );
  }
  async createStory(input: CreateStoryInput): Promise<Story> {
    return this.repo.putStory({
      ...this.base(),
      title: input.title,
      competencyTags: input.competencyTags ?? [],
      situation: input.situation ?? '',
      action: input.action ?? '',
      result: input.result ?? '',
    });
  }
  async updateStory(id: string, patch: StoryPatch): Promise<Story> {
    return this.repo.putStory({ ...(await this.mustStory(id)), ...patch, updatedAt: this.now() });
  }
  async deleteStory(id: string): Promise<void> {
    const existing = await this.repo.getStory(id, { consistent: true });
    if (existing)
      await this.repo.putStory({ ...existing, deletedAt: this.now(), updatedAt: this.now() });
  }

  // --- Task attachments ---
  // Consistent: confirm writes the row back, and a download moments after an upload must find it.
  private async mustAttachment(id: string): Promise<Attachment> {
    const a = await this.repo.findAttachment(id, { consistent: true }); // null on missing OR tombstoned
    if (!a) throw new Error(`Not found: ${id}`);
    return a;
  }
  async createAttachmentUploadUrl(
    input: CreateAttachmentInput,
  ): Promise<{ attachment: Attachment; uploadUrl: string }> {
    await this.mustTask(input.taskId); // must exist under this user's partition (cross-user impossible)
    const now = this.now();
    const liveCount = (await this.repo.listAttachmentsForTask(input.taskId)).filter((a) =>
      countsTowardCap(a, now),
    ).length;
    assertAttachmentAllowed(input.size, liveCount); // size/type/count enforced server-side, pre-signing
    const b = this.base();
    const attachment: Attachment = {
      ...b,
      taskId: input.taskId,
      filename: sanitizeFilename(input.filename),
      contentType: normalizeContentType(input.contentType),
      size: input.size,
      s3Key: `u/${this.userId}/${input.taskId}/${b.id}`, // scoped by the JWT sub, never the filename
      status: 'pending',
    };
    await this.repo.putAttachment(attachment);
    const uploadUrl = await this.presigner.putUrl(
      attachment.s3Key,
      attachment.contentType,
      attachment.size,
    );
    return { attachment, uploadUrl };
  }
  async confirmAttachment(id: string): Promise<Attachment> {
    const a = await this.mustAttachment(id);
    if (a.status === 'ready') return a; // idempotent
    // Past the upload TTL the presigned PUT can't have succeeded, and countsTowardCap has already freed
    // the slot — confirming here would resurrect a discounted row (cap bypass) and mark a byte-less object
    // ready. Reject; the client re-requests a fresh upload URL.
    if (this.now() - a.createdAt >= UPLOAD_URL_TTL_MS)
      throw new Error('Upload window expired; start the upload again.');
    return this.repo.putAttachment({ ...a, status: 'ready', updatedAt: this.now() });
  }
  async listAttachments(taskId?: string): Promise<Attachment[]> {
    const rows =
      taskId === undefined
        ? await this.repo.listAllAttachments()
        : await this.repo.listAttachmentsForTask(taskId);
    return rows
      .filter((a) => a.status === 'ready')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async getAttachmentDownloadUrl(id: string): Promise<string> {
    const a = await this.mustAttachment(id);
    // Browser-renderable, script-free types (image/PDF/text/audio/video) open inline; HTML, SVG/+xml,
    // and unknown binaries are forced to a download so nothing active runs from the S3 origin.
    const disposition = viewableInline(a.contentType)
      ? 'inline'
      : `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`;
    return this.presigner.getUrl(a.s3Key, a.contentType, disposition);
  }
  async deleteAttachment(id: string): Promise<void> {
    const a = await this.repo.findAttachment(id, { consistent: true });
    if (a) await this.removeAttachment(a, this.now());
  }
  // Bytes FIRST, then the tombstone. A failed S3 delete throws with the row still live and pointing at
  // real bytes, so a retry works; tombstone-first would strand the bytes where nothing can reach them.
  // If the put fails after the delete, the retry's DeleteObject is idempotent in effect (204, one more
  // free delete marker) and the tombstone lands.
  private async removeAttachment(a: Attachment, now: number): Promise<void> {
    await this.objects.deleteObject(a.s3Key);
    await this.repo.putAttachment({ ...a, deletedAt: now, updatedAt: now });
  }

  // --- Tasks ---
  async listBacklog(): Promise<Task[]> {
    return (await this.repo.listTasks())
      .filter((t) => t.status === 'backlog')
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async listTasks(): Promise<Task[]> {
    return (await this.repo.listTasks()).sort((a, b) => b.createdAt - a.createdAt);
  }
  async getTask(id: string): Promise<Task | null> {
    return this.repo.getTask(id);
  }
  async createTask(input: CreateTaskInput): Promise<Task> {
    if (input.parentId) return (await this.createTasks([input]))[0]!; // the parts rules live once
    const task = this.newTask(input, this.now(), await this.placeSlugsFor([input]), []);
    return this.syncCalendar(null, await this.repo.putTask(task));
  }
  // The alive place slugs — read only when some input names a place. Consistent, like placeSlugs: a
  // capture right after adding the place must find it.
  private async placeSlugsFor(inputs: readonly CreateTaskInput[]): Promise<ReadonlySet<string>> {
    if (!inputs.some((i) => i?.place)) return new Set();
    return this.placeSlugs();
  }
  // Quick add's parse (shared runQuickParse; docs/areas/tasks/quick-add.md). The server owns "today" and
  // the category list — the client sends only the text — so Raycast and the app resolve "tmw" against
  // the same dayStartHour and can only ever get an active category's id back. Writes nothing.
  async parseTask(text: string): Promise<ParseTaskResult> {
    if (typeof text !== 'string') throw new Error('text must be a string');
    const [settings, all, alivePlaces] = await Promise.all([
      this.ensureSettings(),
      this.repo.listCategories(),
      this.repo.listPlaces({ consistent: true }), // a place added a moment ago resolves its @slug
    ]);
    const categories = all.filter((c) => c.active).map(({ id, label }) => ({ id, label }));
    const places = alivePlaces.map(({ slug, name }) => ({ slug, name }));
    const today = dayKeyInZone(this.now(), USER_TIME_ZONE, settings.dayStartHour);
    const ctx = { categories, places, today, dayStartHour: settings.dayStartHour };
    return runQuickParse(text, ctx, (line) =>
      this.anthropic.parseTask({ text: line, today, categories, timeoutMs: parseBudgetMs(line) }),
    );
  }
  async createTasks(inputs: CreateTaskInput[]): Promise<Task[]> {
    if (inputs.length === 0) return [];
    const t = this.now();
    // Parts (parts.ts): every parent is checked before any write. A planned task taking its first part
    // hands its spot on the plan to that part (the batch's first for it) — an untimed one: a timed part
    // is on its own day by its time (option 3). A part takes its parent's place (partPlace).
    // Consistent: a parent is written back from this copy (adoptAsParent), and a part made a moment
    // ago must count — else a rename just saved is lost, or the parent is adopted twice.
    const parentIds = [...new Set(inputs.map((x) => x?.parentId).filter((x): x is string => !!x))];
    const all = parentIds.length ? await this.repo.listTasks({ consistent: true }) : [];
    const places = await this.placeSlugsFor(inputs);
    const tasks = inputs.map((input) => this.newTask(input, t, places, all)); // normalizes all first: one bad input writes nothing
    const deadline = Date.now() + BULK_SYNC_BUDGET_MS; // from the start: the writes below spend it too
    const landing = new Map<string, TaskPlan>(); // part id → the parent's row it takes over
    if (parentIds.length) {
      const plans = await this.repo.listAllPlans({ consistent: true });
      for (const id of parentIds) {
        const parent = all.find((x) => x.id === id);
        if (!parent) throw new Error(`Not found: ${id}`);
        assertCanBePart(null, parent, all);
        if (parent.status !== 'planned' || hasParts(all, id)) continue;
        const day = followUpPlanDay(plans, id);
        const row = plans.find((p) => p.taskId === id && p.day === day);
        const first = tasks.find((x) => x.parentId === id)!;
        if (row && !first.dueTime) landing.set(first.id, row);
      }
    }
    const saved = await this.repo.putTasks(
      tasks.map((x) => (landing.has(x.id) ? { ...x, status: 'planned' as const } : x)),
    );
    for (const id of parentIds) {
      if (!hasParts(all, id)) await this.adoptAsParent(all.find((x) => x.id === id)!);
    }
    for (const part of saved) {
      const row = landing.get(part.id);
      if (row)
        await this.repo.putPlan({
          ...this.base(),
          taskId: part.id,
          day: row.day,
          plannedMinutes: followUpPlanMinutes(part.estimateMin, part.bufferMin),
          order: row.order,
        });
    }
    if (!saved.some((t) => t.dueTime)) return saved;
    // Timed tasks get their events a few at a time, inside a time budget: the tasks are already saved,
    // so the Lambda timing out now would report a failed paste (and invite a duplicating resubmit). No
    // new Google call starts after the budget, or once one has failed (Google is likely down for all
    // of them) — the rest are marked for Retry instead. Worst case: budget + one sync's timeouts.
    const settings = await this.ensureSettings();
    let tripped = false;
    const out = [...saved];
    const skipped: number[] = [];
    let next = 0;
    const worker = async () => {
      while (next < out.length) {
        const i = next++;
        const task = out[i]!;
        if (!task.dueTime) continue;
        if (tripped || Date.now() > deadline) {
          skipped.push(i);
          continue;
        }
        out[i] = await this.syncCalendar(null, task, false, settings, { tasks: all });
        if (out[i]!.gcalSyncError) tripped = true;
      }
    };
    await Promise.all(Array.from({ length: SYNC_CONCURRENCY }, worker));
    // Mark the skipped rows for Retry — in parallel, each onto a fresh read (putGcal): they've been
    // listable since putTasks, so another device may have touched one meanwhile.
    const note = gcalSyncMessage('create', 'not attempted — retry');
    await Promise.all(
      skipped.map(async (i) => (out[i] = await this.putGcal(out[i]!, { gcalSyncError: note }))),
    );
    return out;
  }
  async setTaskEstimate(
    id: string,
    estimateMin: number | null,
    bufferMin: number | null,
  ): Promise<Task> {
    const prev = await this.mustTask(id);
    if (hasParts(await this.repo.listTasks(), id)) throw new Error(PARENT_NO_ESTIMATE_ERROR);
    const next = await this.repo.putTask(withEstimate(prev, estimateMin, bufferMin, this.now()));
    return this.syncCalendar(prev, next);
  }
  async setTaskParent(id: string, parentId: string | null): Promise<Task> {
    const task = await this.mustTask(id);
    if (parentId === null) {
      if (!task.parentId) return task; // not a part: nothing to detach (a parent keeps its marker)
      const part = await this.repo.putTask({ ...task, parentId: null, updatedAt: this.now() });
      await this.releaseParentState(task.parentId);
      return this.syncCalendar(task, part, false, undefined, { parent: false }); // loses the prefix
    }
    const parent = await this.mustTask(parentId);
    const all = await this.repo.listTasks();
    assertCanBePart(task, parent, all);
    const first = !hasParts(all, parentId);
    // An open part takes its parent's place (PLACE_PART_ERROR); a finished one's is history. A detach
    // (above) keeps whatever it had.
    const place = isFinished(task) ? task.place : parent.place;
    const part = await this.repo.putTask({ ...task, parentId, place, updatedAt: this.now() });
    if (first) await this.adoptAsParent(parent);
    if (task.parentId === parentId) return part; // already its part: nothing moved, nothing starts
    await this.releaseParentState(task.parentId); // moved from another parent
    await this.freezeLock(parentId, id); // attaching a started task can be its parent's first start
    // Its block is named after its new parent (a part has no parts of its own).
    return this.syncCalendar(task, part, false, undefined, { parent: false, tasks: [parent] });
  }
  async setTaskCategory(id: string, categoryId: string | null): Promise<Task> {
    const t = await this.mustTask(id);
    return this.repo.putTask({ ...t, categoryId, updatedAt: this.now() });
  }
  async setTaskDueDay(id: string, dueDay: string | null): Promise<Task> {
    return this.setTaskDue(id, { dueDay });
  }
  async setTaskDue(id: string, due: SetTaskDueInput): Promise<Task> {
    const prev = await this.mustTask(id);
    const fields = normalizeDue(due.dueDay, due.dueTime, prev.dueTime); // throws before any write
    const next = await this.repo.putTask({ ...prev, ...fields, updatedAt: this.now() });
    return this.syncCalendar(prev, next);
  }
  async setTaskTitle(id: string, title: string): Promise<Task> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('Title is required');
    const prev = await this.mustTask(id);
    const next = await this.repo.putTask({ ...prev, title: trimmed, updatedAt: this.now() });
    // A part has no parts of its own, so only a possible parent pays for the (consistent) list read.
    const tasks = prev.parentId ? undefined : await this.repo.listTasks({ consistent: true });
    const parts = tasks ? partsOf(tasks, id) : [];
    const synced = await this.syncCalendar(prev, next, false, undefined, {
      parent: parts.length > 0,
      tasks,
    });
    // A parent's name is in each of its parts' blocks: each linked open one is re-sent — one Google
    // call each, a failure landing on that part (Retry), never on the rename.
    const settings = parts.some((p) => p.gcalEventId) ? await this.ensureSettings() : undefined;
    for (const part of parts)
      if (part.gcalEventId && part.status !== 'done' && part.status !== 'cancelled')
        await this.syncCalendar(part, part, false, settings, { parent: false, tasks: [next] });
    return synced;
  }
  async setTaskNotes(id: string, notes: string | null): Promise<Task> {
    const normalized = setNotesArg(notes); // throws (missing, over the cap) before any read or write
    const t = await this.mustTask(id);
    return this.repo.putTask({ ...t, notes: normalized, updatedAt: this.now() });
  }
  async setTaskReflection(id: string, reflection: string | null): Promise<Task> {
    const normalized = setReflectionArg(reflection); // throws (missing, over the cap) before any read or write
    const t = await this.mustTask(id);
    return this.repo.putTask({ ...t, reflection: normalized, updatedAt: this.now() });
  }
  async transitionTask(id: string, to: TaskStatus): Promise<Task> {
    const task = await this.mustTask(id);
    // Consistent: completeParent writes the sum of the parts' actuals, often a tap after the last part's.
    const parts = partsOf(await this.repo.listTasks({ consistent: true }), id);
    if (parts.length) return this.transitionParent(task, parts, to);
    const next = await this.transitionOne(task, to);
    // Its FIRST start only: a rolled-back part starting again isn't the parent's first start.
    const firstStart =
      task.startedAt === null &&
      (task.status === 'backlog' || task.status === 'planned') &&
      (to === 'in_progress' || to === 'done');
    if (!task.parentId || !firstStart) return next;
    await this.freezeLock(task.parentId, id);
    return (await this.repo.getTask(id, { consistent: true })) ?? next;
  }
  // A parent is never worked on itself: it's marked done once its parts are dealt with (a hard block
  // otherwise; its due marker stays, as a done task's block does), and dropping it drops its open parts
  // first — each through the normal cancel path, so their calendar blocks go too — then the parent and
  // its marker last.
  private async transitionParent(task: Task, parts: Task[], to: TaskStatus): Promise<Task> {
    if (to === 'done') return this.repo.putTask(completeParent(task, parts, this.now()));
    if (to === 'cancelled') {
      const { parent, parts: dropped } = cancelParent(task, parts, this.now());
      for (const p of dropped) await this.transitionOne(await this.mustTask(p.id), to);
      const saved = await this.repo.putTask(parent);
      return task.gcalEventId ? this.deleteCalendarEvent(task.id) : saved;
    }
    throw new Error(to === 'in_progress' ? PARENT_NO_START_ERROR : PARENT_NO_PLAN_ERROR);
  }
  private async transitionOne(task: Task, to: TaskStatus): Promise<Task> {
    const id = task.id;
    // A finished task has nothing left to sync, so a failure note (and its Retry) goes with it — unless
    // it's an owed removal, which the finish carries out (reporting, not swallowing, a failure).
    const finished = to === 'done' || to === 'cancelled';
    const owed = task.gcalEventId && isPendingRemoval(task.gcalSyncError);
    const next = await this.repo.putTask({
      ...taskTransition(task, to, this.now()),
      ...(finished && task.gcalSyncError && !owed ? { gcalSyncError: null } : {}),
    });
    if (finished && owed) return this.syncCalendar(task, next);
    // Delete-on-cancel: dropping a task removes its calendar event (via the owning account) and clears
    // the pointers. Guarded by gcalEventId, so tasks without an event are unaffected.
    if (to === 'cancelled' && task.gcalEventId) return this.deleteCalendarEvent(id);
    return next;
  }
  async setTaskActual(id: string, actualMin: number, reflection?: string | null): Promise<Task> {
    // Normalized before any read or write: an over-cap reflection lands nothing. undefined keeps the current one.
    const note = reflection === undefined ? {} : { reflection: normalizeReflection(reflection) };
    const t = await this.mustTask(id);
    if (hasParts(await this.repo.listTasks(), id)) throw new Error(PARENT_NO_ACTUAL_ERROR);
    return this.repo.putTask({ ...t, actualAccruedMin: actualMin, ...note, updatedAt: this.now() });
  }
  async splitTask(
    id: string,
    input: SplitTaskInput,
  ): Promise<{ parent: Task; original: Task; followUp: Task }> {
    const task = await this.mustTask(id);
    if (hasParts(await this.repo.listTasks(), id)) throw new Error(PARENT_NO_SPLIT_ERROR);
    const standalone = !task.parentId;
    const shaped = splitOriginal(task, input, this.now(), standalone); // validates everything before any write
    // Split always yields parent + parts: a standalone task gets a new parent (its due marker is synced
    // last, once it has parts), a part splits under the parent it has.
    const newParent = standalone
      ? await this.repo.putTask({ ...this.base(), ...newParentFrom(task, input) })
      : null;
    const parentId = newParent?.id ?? task.parentId!;
    const edited = { ...shaped, parentId };
    const done = input.finish === 'done';
    // A TIMED task's event is the block before its deadline. A done part has no future there, so the link
    // moves to the follow-up (which re-titles/re-times it — no delete + re-create). Kept going, each part
    // owns its own block: the original keeps its event, and the follow-up gets one from the planner (it
    // gains a time). A timed task's one linked block is its auto block, whatever placed it. Any other
    // linked event (a manual one on an untimed original) stays on the original.
    const moveLink = done && !!task.dueDay && !!task.dueTime && !!task.gcalEventId;
    let original: Task;
    if (done) {
      // A finish drops a failure note, but carries out an owed removal (reporting, like transitionTask).
      const owed = !moveLink && !!task.gcalEventId && isPendingRemoval(task.gcalSyncError);
      original = await this.repo.putTask({
        ...edited,
        ...(moveLink
          ? {
              gcalAccountId: null,
              gcalCalendarId: null,
              gcalEventId: null,
              gcalSeen: null,
              gcalPulled: null, // the follow-up owns the event a pulled note would describe
            }
          : {}),
        gcalSyncError: owed ? task.gcalSyncError : null,
      });
      // Through the sync path whenever the event stays: an owed removal is carried out, and a rename
      // retires a pulled note like any edit on a done task.
      if (!moveLink) original = await this.syncCalendar(task, original);
    } else {
      original = await this.syncCalendar(task, await this.repo.putTask(edited));
    }
    // The follow-up lands on the original's plan day (planned), else in the backlog — and a timed
    // original's is on its day by its time (option 3). Task before row: a planned task whose row never
    // landed is what getDay's stale sweep moves back to backlog.
    const day =
      !task.dueTime && (task.status === 'planned' || task.status === 'in_progress')
        ? followUpPlanDay(await this.repo.listAllPlans(), id)
        : null;
    const fields = splitFollowUp(task, input.followUp, day !== null, parentId);
    const created = await this.repo.putTask({
      ...this.base(),
      ...fields,
      // The link moves with what Aperture knows about the event (its base). The follow-up's new title and
      // window differ from it — unsent, so they win a conflict and go with its first push.
      ...(moveLink
        ? {
            gcalAccountId: task.gcalAccountId,
            gcalCalendarId: task.gcalCalendarId,
            gcalEventId: task.gcalEventId,
            gcalSeen: task.gcalSeen ?? null,
          }
        : {}),
    });
    if (day !== null) {
      const dayPlans = await this.repo.listPlans(day);
      const own = dayPlans.find((p) => p.taskId === id);
      const resized = rescopedPlanMinutes(input, original);
      if (own && resized !== null && resized !== own.plannedMinutes)
        await this.repo.putPlan({ ...own, plannedMinutes: resized, updatedAt: this.now() }, own);
      await this.repo.putPlan({
        ...this.base(),
        taskId: created.id,
        day,
        plannedMinutes: followUpPlanMinutes(fields.estimateMin, fields.bufferMin),
        order: dayPlans.length,
      });
    }
    // No freeze here: a standalone split's parent IS the original's lock, and nothing started just now.
    // The new parent in hand names the follow-up's block (a read straight after its write could miss it).
    const followUp = await this.syncCalendar(
      null,
      created,
      false,
      undefined,
      newParent ? { tasks: [newParent] } : {},
    );
    const parent = newParent
      ? await this.syncCalendar(null, newParent, false, undefined, { parent: true })
      : await this.mustTask(parentId);
    return { parent, original, followUp };
  }
  async deleteTask(id: string): Promise<void> {
    // Bytes FIRST, for the task and every part, before any other cascade step: an S3 failure then
    // throws with the task, its parts, plans and calendar event untouched — only the files already
    // removed are gone, and a retry finishes. Consistent reads, so a file attached a moment ago goes too.
    if (!(await this.repo.getTask(id, { consistent: true }))) return;
    const parts = partsOf(await this.repo.listTasks({ consistent: true }), id);
    for (const taskId of [id, ...parts.map((p) => p.id)])
      for (const a of await this.repo.listAttachmentsForTask(taskId, { consistent: true }))
        await this.removeAttachment(a, this.now());
    return this.deleteOne(id, true);
  }
  // `release`: a part's parent is left plain if this was its last part — not when the parent is going
  // too (its marker is deleted with it, not first patched back into a block: no wasted Google call).
  private async deleteOne(id: string, release: boolean): Promise<void> {
    // Consistent reads: the tombstone is built from this copy, and a part made a moment ago must go too.
    const task = await this.repo.getTask(id, { consistent: true });
    if (!task) return; // idempotent — already tombstoned or never existed
    // A parent goes with every part — each through this same path (event, plans, attachments), first.
    for (const part of partsOf(await this.repo.listTasks({ consistent: true }), id))
      await this.deleteOne(part.id, false);
    // Calendar event FIRST (deleteCalendarEvent uses mustTask, so it must run before the tombstone).
    // Build the tombstone from the RETURNED task: it has the gcal pointers nulled, so we don't re-put
    // stale pointers onto the tombstone.
    const cleared = task.gcalEventId ? await this.deleteCalendarEvent(id) : task;
    const now = this.now();
    for (const p of (await this.repo.listAllPlans()).filter((p) => p.taskId === id))
      await this.repo.putPlan({ ...p, deletedAt: now, updatedAt: now }, p);
    // Every status, so a never-confirmed pending upload's bytes go too. deleteTask already removed them
    // up front; this catches one that landed since. Consistent, so a just-tombstoned row isn't re-deleted.
    for (const a of await this.repo.listAttachmentsForTask(id, { consistent: true }))
      await this.removeAttachment(a, now);
    await this.repo.putTask({ ...cleared, deletedAt: now, updatedAt: now }); // task LAST
    if (release) await this.releaseParentState(task.parentId);
  }

  // --- Plans ---
  async listPlansForDay(day: string): Promise<TaskPlan[]> {
    return (await this.repo.listPlans(day)).sort((a, b) => a.order - b.order);
  }
  async upsertPlan(input: UpsertPlanInput): Promise<TaskPlan> {
    // Consistent: "+ Today" can follow straight on the editor's save that cleared the time.
    const tasks = await this.repo.listTasks({ consistent: true });
    if (hasParts(tasks, input.taskId)) throw new Error(PARENT_NO_PLAN_ERROR);
    const task = tasks.find((t) => t.id === input.taskId);
    if (task && isTimed(task)) throw new Error(TIMED_NO_PLAN_ERROR);
    const fields = {
      taskId: input.taskId,
      day: input.day,
      plannedMinutes: input.plannedMinutes,
      order: input.order,
    };
    if (input.id) {
      // Consistent: a second reorder straight after the first must move the row the first one left,
      // not resurrect the one it dropped.
      const existing = await this.repo.findPlan(input.id, { consistent: true });
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putPlan({ ...existing, ...fields, updatedAt: this.now() }, existing);
    }
    // One alive row per (task, day): an id-less insert means "put it on this day", so a task already
    // there is returned untouched — no resize, no reorder (edits go through `id`). Consistent, so a
    // second "+ Today" straight after the first sees the first one's row.
    const dup = (await this.repo.listPlans(input.day, { consistent: true })).find(
      (p) => p.taskId === input.taskId,
    );
    if (dup) return dup;
    return this.repo.putPlan({ ...this.base(), ...fields });
  }
  async removePlan(id: string): Promise<void> {
    const existing = await this.repo.findPlan(id, { consistent: true });
    if (existing)
      await this.repo.putPlan(
        { ...existing, deletedAt: this.now(), updatedAt: this.now() },
        existing,
      );
  }

  // --- Series ---
  async listSeries(): Promise<TaskSeries[]> {
    return this.repo.listSeries();
  }
  async upsertSeries(input: UpsertSeriesInput): Promise<TaskSeries> {
    const fields = {
      title: input.title,
      categoryId: input.categoryId,
      defaultEstimateMin: input.defaultEstimateMin,
      rule: input.rule,
      anchorDate: input.anchorDate,
      active: input.active ?? true,
      ...seriesCadence(input), // throws before any write
    };
    if (input.id) {
      const existing = await this.repo.getSeries(input.id, { consistent: true });
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putSeries({ ...existing, ...fields, updatedAt: this.now() });
    }
    return this.repo.putSeries({ ...this.base(), ...fields });
  }
  async deactivateSeries(id: string): Promise<TaskSeries> {
    const existing = await this.repo.getSeries(id, { consistent: true });
    if (!existing) throw new Error(`Not found: ${id}`);
    return this.repo.putSeries({ ...existing, active: false, updatedAt: this.now() });
  }
  async deleteSeries(id: string): Promise<void> {
    const existing = await this.repo.getSeries(id, { consistent: true }); // written back: the tombstone
    if (!existing) return; // idempotent — already tombstoned or never existed
    await this.repo.putSeries({ ...existing, deletedAt: this.now(), updatedAt: this.now() });
  }

  // --- Sessions ---
  async startSession(input: StartSessionInput): Promise<PomodoroSession> {
    const t = this.now();
    if (input.taskId && input.kind === 'work') {
      const existing = (await this.repo.listRunningSessions()).find(
        (s) => s.kind === 'work' && s.taskId === input.taskId,
      );
      if (existing) return existing;
    }
    const categoryId =
      input.categoryId ??
      (input.taskId ? ((await this.repo.getTask(input.taskId))?.categoryId ?? null) : null);
    const wasWork = categoryId
      ? ((await this.repo.getCategory(categoryId))?.isWork ?? false)
      : false;
    return this.repo.putSession({
      ...this.base(),
      taskId: input.taskId,
      categoryId,
      label: input.label ?? null,
      wasWork,
      kind: input.kind,
      startedAt: t,
      endedAt: null,
      day: input.day,
      activeMinutes: 0,
      status: 'running',
      lastHeartbeatAt: t,
    });
  }
  // Heartbeat/resume/stop/resolveStale only ever act on RUNNING sessions → a direct running-key read.
  private async mustSession(id: string): Promise<PomodoroSession> {
    const s = await this.repo.getRunningSession(id);
    if (!s) throw new Error(`Not found: ${id}`);
    return s;
  }
  async heartbeatSession(id: string): Promise<PomodoroSession> {
    return this.repo.putSession(heartbeatSession(await this.mustSession(id), this.now()));
  }
  async resumeSession(id: string): Promise<PomodoroSession> {
    return this.repo.putSession(resumeSession(await this.mustSession(id), this.now()));
  }
  async stopSession(id: string, status: 'completed' | 'discarded'): Promise<PomodoroSession> {
    const session = await this.mustSession(id);
    const next =
      status === 'completed'
        ? completeSession(session, this.now())
        : discardSession(session, this.now());
    await this.repo.putSession(next);
    if (status === 'completed') await this.accrueToTask(next);
    return next;
  }
  async listSessionsForDay(day: string): Promise<PomodoroSession[]> {
    return (await this.repo.listAllSessions()).filter((s) => s.day === day);
  }
  async findRunningSession(): Promise<PomodoroSession | null> {
    return (await this.runningSessions())[0] ?? null;
  }
  async listRunningSessions(): Promise<PomodoroSession[]> {
    return this.runningSessions();
  }
  private async runningSessions(): Promise<PomodoroSession[]> {
    return (await this.repo.listRunningSessions()).sort((a, b) => a.createdAt - b.createdAt);
  }
  async resolveStaleSession(id: string, decision: 'keep' | 'discard'): Promise<PomodoroSession> {
    const next = resolveStaleSession(await this.mustSession(id), decision, this.now());
    await this.repo.putSession(next);
    if (decision === 'keep') await this.accrueToTask(next);
    return next;
  }
  private async accrueToTask(session: PomodoroSession): Promise<void> {
    if (session.kind !== 'work' || !session.taskId) return;
    const task = await this.repo.getTask(session.taskId, { consistent: true }); // written back below
    if (!task || !accruesTime(task)) return; // finished meanwhile: the session keeps its minutes, the task doesn't
    await this.repo.putTask({
      ...task,
      actualAccruedMin: task.actualAccruedMin + session.activeMinutes,
      updatedAt: this.now(),
    });
  }

  // --- Habits ---
  async listHabits(): Promise<Habit[]> {
    return (await this.repo.listHabits()).sort((a, b) => a.createdAt - b.createdAt);
  }
  async upsertHabit(input: UpsertHabitInput): Promise<Habit> {
    const fields = {
      name: input.name,
      categoryId: input.categoryId,
      cadencePerWeek: input.cadencePerWeek,
      active: input.active ?? true,
    };
    if (input.id) {
      const existing = await this.repo.getHabit(input.id, { consistent: true });
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putHabit({ ...existing, ...fields, updatedAt: this.now() });
    }
    return this.repo.putHabit({ ...this.base(), ...fields });
  }
  // Consistent both ways: a check then an uncheck at once must leave none, and the reverse one.
  async checkHabit(habitId: string, date: string): Promise<HabitCheck> {
    const existing = await this.repo.getCheck(date, habitId, { consistent: true });
    if (existing) return existing;
    return this.repo.putCheck({ ...this.base(), habitId, date }, date, habitId);
  }
  // A tombstone at the same key, like every other delete (TECH §2.1): a stale device can tell "removed"
  // from "never synced". A re-check writes a fresh row over it (new id) — stub parity.
  async uncheckHabit(habitId: string, date: string): Promise<void> {
    const existing = await this.repo.getCheck(date, habitId, { consistent: true });
    if (existing)
      await this.repo.putCheck(
        { ...existing, deletedAt: this.now(), updatedAt: this.now() },
        date,
        habitId,
      );
  }
  async listHabitChecks(range: DateRange): Promise<HabitCheck[]> {
    return this.repo.listChecks(range.from, range.to);
  }

  // --- Rolls ---
  async listRolls(): Promise<Roll[]> {
    return (await this.repo.listRolls()).sort((a, b) => a.createdAt - b.createdAt);
  }
  async upsertRoll(input: UpsertRollInput): Promise<Roll> {
    const fields = {
      name: input.name,
      categoryId: input.categoryId,
      estimateMin: input.estimateMin,
      active: input.active ?? true,
    };
    if (input.id) {
      const existing = await this.repo.getRoll(input.id, { consistent: true });
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putRoll({ ...existing, ...fields, updatedAt: this.now() });
    }
    return this.repo.putRoll({ ...this.base(), ...fields });
  }
  // Reuse the open rep if one exists (re-planning a rolled-back backlog one), else spawn a fresh planned
  // rep; then ensure it sits on `day`'s plan, appended like addToDay. A timed open rep is refused like
  // any timed plan (one open rep per roll — rolls.md D6). Mirrors the stub exactly.
  async pickRollToday(rollId: string, day: string): Promise<{ task: Task; plan: TaskPlan }> {
    const roll = await this.repo.getRoll(rollId);
    if (!roll) throw new Error(`Not found: ${rollId}`);
    const existing = findOpenRollTask(await this.repo.listTasks({ consistent: true }), rollId);
    if (existing && isTimed(existing)) throw new Error(TIMED_NO_PLAN_ERROR);
    const task = existing
      ? existing.status === 'backlog'
        ? await this.repo.putTask(taskTransition(existing, 'planned', this.now()))
        : existing
      : await this.repo.putTask({ ...this.base(), ...rollRepFields(roll) });
    const dayPlans = await this.repo.listPlans(day);
    const existingPlan = dayPlans.find((p) => p.taskId === task.id);
    const plan =
      existingPlan ??
      (await this.repo.putPlan({
        ...this.base(),
        taskId: task.id,
        day,
        plannedMinutes: roll.estimateMin ?? ROLL_PLAN_FALLBACK_MIN,
        order: dayPlans.length,
      }));
    return { task, plan };
  }

  // --- Ideas ---
  async listIdeas(status?: IdeaStatus): Promise<Idea[]> {
    return (await this.repo.listIdeas())
      .filter((i) => (status ? i.status === status : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async createIdea(text: string): Promise<Idea> {
    return this.repo.putIdea({ ...this.base(), text, status: 'open' });
  }
  async triageIdea(id: string, status: IdeaStatus): Promise<Idea> {
    const existing = await this.repo.getIdea(id, { consistent: true });
    if (!existing) throw new Error(`Not found: ${id}`);
    return this.repo.putIdea({ ...existing, status, updatedAt: this.now() });
  }

  // --- Day (lazy recurrence + stale sweep on read) ---
  // `consistent` for the setters below, whose copy is written back: a capacity then an intent typed
  // straight after must both land. The app's load read stays eventual.
  async getDay(day: string, opts?: { consistent?: boolean }): Promise<Day> {
    // Refused, never clamped: a day after the user's app day (their zone, their day start) would sweep
    // today's plan. Past days stay allowed — Night at 2am reads yesterday's key by design.
    if (!isDayKey(day)) throw new Error('Invalid day');
    const { dayStartHour } = await this.ensureSettings();
    if (day > dayKeyInZone(this.now(), USER_TIME_ZONE, dayStartHour))
      throw new Error(FUTURE_DAY_ERROR);
    await this.materializeDueSeries(day);
    await this.sweepStalePlanned(day);
    const existing = await this.repo.getDayRow(day, opts);
    if (existing) return existing;
    return this.repo.putDay({
      ...this.base(),
      date: day,
      capacityHours: null,
      intent: null,
      reflectionPrompt: null,
      reflectionText: null,
    });
  }
  // An occurrence is spawned once per (series, day) — identity by seriesDay (seriesHasOccurrence), so an
  // unplanned occurrence isn't respawned (recurring.md D4). Stub parity. Spawns go through the repo's
  // putTask/putPlan like every other task write (their item shapes are the repo's).
  private async materializeDueSeries(day: string): Promise<void> {
    const active = (await this.repo.listSeries()).filter((s) => s.active);
    if (active.length === 0) return;
    const due = active.filter((s) => seriesDueOn(s, day));
    if (due.length === 0) return;
    const tasks = await this.repo.listTasks();
    const plansOnDay = await this.repo.listPlans(day);
    for (const series of due) {
      if (seriesHasOccurrence(series, day, tasks, plansOnDay)) continue;
      const task = await this.repo.putTask({ ...this.base(), ...occurrenceFields(series, day) });
      await this.repo.putPlan({
        ...this.base(),
        taskId: task.id,
        day,
        plannedMinutes: series.defaultEstimateMin ?? 0,
        order: 1000,
      });
    }
  }
  // Rule lives in the shared stalePlannedMoves (stub parity). Plans are read only when something is
  // planned. Each move re-reads the task first (consistently): a sweep races the user's own writes (e.g.
  // starting the task, or clearing its time), and writing back the list-time copy would undo them.
  private async sweepStalePlanned(day: string): Promise<void> {
    const tasks = await this.repo.listTasks();
    if (!tasks.some((t) => t.status === 'planned')) return;
    // A move is decided on consistent rows: a row "+ Today" just wrote must not read as missing. Rows
    // before `day` never decide one (stalePlannedMoves reads `p.day >= day`), so this is one bounded
    // read from today's rows on — not a scan of every plan row ever written.
    const plans = await this.repo.listPlansFrom(day, { consistent: true });
    for (const { task } of stalePlannedMoves(tasks, plans, day)) {
      const fresh = await this.repo.getTask(task.id, { consistent: true });
      if (!fresh) continue;
      // The rule again on the fresh copy, among the tasks it was judged with (a superseded occurrence
      // needs its series' copy in the list): the list-time copy may have lost its time since.
      const listed = tasks.map((t) => (t.id === fresh.id ? fresh : t));
      const move = stalePlannedMoves(listed, plans, day).find((m) => m.task.id === fresh.id);
      if (!move) continue;
      // Gained a calendar event since the list read → backlog, never an orphaned event.
      await this.repo.putTask(
        taskTransition(fresh, fresh.gcalEventId ? 'backlog' : move.to, this.now()),
      );
    }
  }
  async setDayCapacity(day: string, capacityHours: number | null): Promise<Day> {
    const d = await this.getDay(day, { consistent: true });
    return this.repo.putDay({ ...d, capacityHours, updatedAt: this.now() });
  }
  async setDayIntent(day: string, intent: string): Promise<Day> {
    const d = await this.getDay(day, { consistent: true });
    return this.repo.putDay({ ...d, intent, updatedAt: this.now() });
  }
  async setDayReflection(day: string, prompt: string, text: string): Promise<Day> {
    const d = await this.getDay(day, { consistent: true });
    return this.repo.putDay({
      ...d,
      reflectionPrompt: prompt,
      reflectionText: text,
      updatedAt: this.now(),
    });
  }

  // --- Categories ---
  async listCategories(): Promise<Category[]> {
    return (await this.repo.listCategories()).sort((a, b) => a.order - b.order);
  }
  async upsertCategory(input: UpsertCategoryInput): Promise<Category> {
    if (input.id) {
      // Consistent: a work flip straight after a rename keeps the rename.
      const existing = await this.repo.getCategory(input.id, { consistent: true });
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putCategory({
        ...existing,
        label: input.label,
        isWork: input.isWork,
        order: input.order ?? existing.order,
        active: input.active ?? existing.active,
        updatedAt: this.now(),
      });
    }
    return this.repo.putCategory({
      ...this.base(),
      label: input.label,
      isWork: input.isWork,
      order: input.order ?? (await this.repo.listCategories()).length,
      active: input.active ?? true,
    });
  }
  async setCategoryWork(
    id: string,
    isWork: boolean,
    backfillPast: boolean,
  ): Promise<{ category: Category; backfilled: number }> {
    const existing = await this.repo.getCategory(id, { consistent: true });
    if (!existing) throw new Error(`Not found: ${id}`);
    const category = await this.repo.putCategory({ ...existing, isWork, updatedAt: this.now() });
    let backfilled = 0;
    if (backfillPast) {
      for (const s of (await this.repo.listAllSessions()).filter((x) => x.categoryId === id)) {
        await this.repo.putSession({ ...s, wasWork: isWork, updatedAt: this.now() });
        backfilled++;
      }
    }
    return { category, backfilled };
  }
  async deleteCategory(id: string, reassignToId: string | null): Promise<void> {
    // Consistent: every matching task is written back.
    const tasks = (await this.repo.listTasks({ consistent: true })).filter(
      (t) => t.categoryId === id,
    );
    const habits = (await this.repo.listHabits()).filter((h) => h.categoryId === id);
    const series = (await this.repo.listSeries()).filter((s) => s.categoryId === id);
    const rolls = (await this.repo.listRolls()).filter((r) => r.categoryId === id);
    assertCategoryDeletable(
      tasks.length + habits.length + series.length + rolls.length,
      reassignToId,
    );
    for (const t of tasks)
      await this.repo.putTask({ ...t, categoryId: reassignToId, updatedAt: this.now() });
    for (const h of habits)
      await this.repo.putHabit({ ...h, categoryId: reassignToId, updatedAt: this.now() });
    for (const s of series)
      await this.repo.putSeries({ ...s, categoryId: reassignToId, updatedAt: this.now() });
    for (const r of rolls)
      await this.repo.putRoll({ ...r, categoryId: reassignToId, updatedAt: this.now() });
    const cat = await this.repo.getCategory(id, { consistent: true });
    if (cat) await this.repo.putCategory({ ...cat, deletedAt: this.now(), updatedAt: this.now() });
  }

  // --- Places (errand lists — places.ts) ---
  // Consistent (N is tiny): Settings reads it straight after a rename or an add.
  async listPlaces(): Promise<Place[]> {
    return (await this.repo.listPlaces({ consistent: true })).sort(byAdded);
  }
  // Consistent: an update decides on (and writes back) this row, and a just-deleted place must read gone.
  private async mustPlace(id: string): Promise<Place> {
    const p = await this.repo.getPlace(id, { consistent: true });
    if (!p) throw new Error(`Not found: ${id}`);
    return p;
  }
  private async placeSlugs(): Promise<ReadonlySet<string>> {
    return new Set((await this.repo.listPlaces({ consistent: true })).map((p) => p.slug));
  }
  async upsertPlace(input: UpsertPlaceInput): Promise<Place> {
    if (typeof input?.name !== 'string') throw new Error('A place needs a name');
    if (input.slug !== undefined && typeof input.slug !== 'string')
      throw new Error('A place link must be a string');
    const name = input.name.trim();
    // Consistent: the slug-uniqueness check must see a place added a moment ago.
    const others = (await this.repo.listPlaces({ consistent: true })).filter(
      (p) => p.id !== input.id,
    );
    if (input.id) {
      const existing = await this.mustPlace(input.id);
      const slug = input.slug ?? existing.slug;
      const err = placeError(name, slug, others);
      if (err) throw new Error(err);
      // The slug is what tasks store, so a new one follows them — finished ones too: they stay placed, so
      // their calibration can't change. Consistent: each is written back.
      if (slug !== existing.slug)
        for (const t of await this.repo.listTasks({ consistent: true }))
          if (t.place === existing.slug)
            await this.repo.putTask({ ...t, place: slug, updatedAt: this.now() });
      return this.repo.putPlace({ ...existing, name, slug, updatedAt: this.now() });
    }
    const slug = input.slug ?? slugify(name);
    const err = placeError(name, slug, others);
    if (err) throw new Error(err);
    return this.repo.putPlace({ ...this.base(), name, slug, lastReadAt: null });
  }
  // Its alive tasks move to `reassignToSlug` (another alive place — finished ones too, they stay placed),
  // or its open ones go off any list (null — a finished task keeps the old slug as history, so it never
  // turns into a calibration point after the fact). Then the place is tombstoned. Every check runs before
  // the first write.
  async deletePlace(id: string, reassignToSlug: string | null): Promise<void> {
    const place = await this.mustPlace(id);
    if (reassignToSlug === place.slug)
      throw new Error('Move its errands to another place, or to no place');
    const to = knownPlace(reassignToSlug, await this.placeSlugs());
    for (const t of await this.repo.listTasks({ consistent: true }))
      if (t.place === place.slug && (to !== null || !isFinished(t)))
        await this.repo.putTask({ ...t, place: to, updatedAt: this.now() });
    await this.repo.putPlace({ ...place, deletedAt: this.now(), updatedAt: this.now() });
  }
  // Open tasks only: a finished task's place is history, like its estimate (PLACE_FINISHED_ERROR). A part
  // follows its parent (PLACE_PART_ERROR); a parent carries its open parts along — finished parts keep
  // theirs. Parts first, so a cut-short move is finished by re-running it (each part whose place differs).
  async setTaskPlace(id: string, place: string | null): Promise<Task> {
    const t = await this.mustTask(id);
    if (isFinished(t)) throw new Error(PLACE_FINISHED_ERROR);
    if (t.parentId) throw new Error(PLACE_PART_ERROR);
    const slug = knownPlace(place, place ? await this.placeSlugs() : new Set());
    // Consistent: each part is written back from this copy.
    const parts = (await this.repo.listTasks({ consistent: true })).filter(
      (p) => p.parentId === id && !isFinished(p) && p.place !== slug,
    );
    if (parts.length)
      await this.repo.putTasks(parts.map((p) => ({ ...p, place: slug, updatedAt: this.now() })));
    return this.repo.putTask({ ...t, place: slug, updatedAt: this.now() });
  }
  // The Shortcut's digest as a pure read (Settings' Test, MCP) — no heartbeat, no count.
  async listPlaceTasks(slug: string): Promise<PlaceDigest> {
    const place = (await this.repo.listPlaces()).find((p) => p.slug === slug);
    if (!place) throw new Error(placeUnknownError(String(slug)));
    return placeDigestOf(place, await this.repo.listTasks());
  }

  // The Shortcut route (index.ts, NOT via RPC — like completeGoogleConnect): the edge resolved the token
  // (auth + cap, resolvePlaceRead) and built this backend for its userId. Reads the place and its open
  // errands; only then writes, exactly twice: the token's count (first — a token revoked mid-read fails
  // here, 401, before anything else lands) and the place's lastReadAt. An unknown slug writes nothing.
  // The heartbeat is best-effort: once the read is counted the digest goes out even if it fails (logged,
  // name only) — Settings' "last called" lags, the Shortcut still shows the list.
  async readPlaceForShortcut(slug: string, auth: PlaceReadAuth): Promise<PlaceDigest> {
    if (auth.userId !== this.userId) throw new Error('Unauthorized: token is for another user');
    const place = (await this.repo.listPlaces()).find((p) => p.slug === slug);
    if (!place) throw new Error(placeUnknownError(slug));
    const digest = placeDigestOf(place, await this.repo.listTasks());
    const now = this.now();
    await countPlaceRead(this.placeTokens, auth, now);
    try {
      await this.repo.touchPlace(place, now);
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      console.log(JSON.stringify({ event: 'place_heartbeat_failed', name }));
    }
    return digest;
  }

  // The Shortcut token: one per user. Never the token or its hash out — hint (last 4) and timestamps.
  async getPlaceTokenStatus(): Promise<PlaceTokenStatus> {
    const ptr = await this.repo.getPlaceTokenPointer();
    // Revoked (hash null), or a pointer whose lookup row is gone: a token that no longer works.
    const row = ptr?.hash ? await this.placeTokens.get(ptr.hash, { consistent: true }) : null;
    if (!row) return INACTIVE_TOKEN;
    return {
      active: true,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      hint: row.hint,
      readsToday: readsToday(row, this.now()),
    };
  }
  // Pointer P (consistent) → new lookup row N → pointer {N, retiring: P's hash + P's leftovers}, written
  // only on P's version → every retiring row deleted → retiring cleared. Two devices racing: one pointer
  // write wins, the loser deletes its own N and throws (PLACE_TOKEN_RACE_ERROR) — no orphan token works.
  // A crash after the pointer moved leaves the old hashes in `retiring`, deleted by the next rotate/revoke;
  // they're already dead — a read is refused unless the pointer names its hash (resolvePlaceRead).
  // The plaintext leaves here once and is never stored or logged.
  async rotatePlaceToken(): Promise<{ token: string; status: PlaceTokenStatus }> {
    const now = this.now();
    const token = mintPlaceToken();
    const hash = hashPlaceToken(token);
    const hint = token.slice(-4);
    const prev = await this.repo.getPlaceTokenPointer();
    await this.placeTokens.create(hash, {
      userId: this.userId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      readsDay: null,
      readsCount: 0,
      hint,
    });
    const next: PlaceTokenPointer = {
      hash,
      createdAt: now,
      hint,
      retiring: retiringOf(prev),
      updatedAt: prev ? Math.max(now, prev.updatedAt + 1) : now,
    };
    try {
      await this.repo.putPlaceTokenPointer(next, prev?.updatedAt ?? null);
    } catch (err) {
      // Lost or unknown: N must not outlive a pointer that may not name it (a pointer naming a deleted
      // row just reads inactive — fail closed).
      await this.placeTokens.delete(hash);
      if (err instanceof ConditionFailedError)
        throw new Error(PLACE_TOKEN_RACE_ERROR, { cause: err });
      throw err;
    }
    await this.retirePlaceTokens(next);
    return {
      token,
      status: { active: true, createdAt: now, lastUsedAt: null, hint, readsToday: 0 },
    };
  }
  // Pointer → {hash: null, retiring: every old hash} on the version read → those rows deleted → retiring
  // cleared. Leaves an inactive pointer (never a delete), so a rotate racing it loses its conditional write.
  async revokePlaceToken(): Promise<void> {
    const prev = await this.repo.getPlaceTokenPointer();
    const retiring = retiringOf(prev);
    if (!prev || (prev.hash === null && retiring.length === 0)) return;
    const next: PlaceTokenPointer = {
      hash: null,
      createdAt: null,
      hint: null,
      retiring,
      updatedAt: Math.max(this.now(), prev.updatedAt + 1),
    };
    try {
      await this.repo.putPlaceTokenPointer(next, prev.updatedAt);
    } catch (err) {
      if (err instanceof ConditionFailedError)
        throw new Error(PLACE_TOKEN_RACE_ERROR, { cause: err });
      throw err;
    }
    await this.retirePlaceTokens(next);
  }
  // Delete every retiring lookup row (idempotent), then clear the list on the pointer as just written. A
  // failed delete throws with the list intact — the next rotate/revoke retries it. A lost clear means
  // another rotate/revoke already took the list over, so it is dropped, not retried.
  private async retirePlaceTokens(ptr: PlaceTokenPointer): Promise<void> {
    if (ptr.retiring.length === 0) return;
    for (const h of ptr.retiring) await this.placeTokens.delete(h);
    try {
      await this.repo.putPlaceTokenPointer(
        { ...ptr, retiring: [], updatedAt: Math.max(this.now(), ptr.updatedAt + 1) },
        ptr.updatedAt,
      );
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
    }
  }

  // --- Settings ---
  async getSettings(): Promise<Settings> {
    return this.ensureSettings();
  }
  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const current = await this.ensureSettings({ consistent: true });
    return this.repo.putSettings({ ...current, ...patch, updatedAt: this.now() });
  }

  // --- Google Calendar (multi-account) ---
  // Every external effect (SSM token get/put, Google fetch) goes through the gated `this.google`, so a
  // testMode/smoke run makes zero real calls. Settings + task-pointer writes go through the repo Writes.

  async googleConnectUrl(): Promise<{ url: string }> {
    const state = signState(this.userId, this.stateSecret, this.now());
    return { url: await this.google.buildConsentUrl(state) };
  }

  // Called by the browser-driven callback route (NOT via RPC), after index.ts verified the state and
  // built this backend with the state's userId. Exchanges the code, stores the token, records the account.
  async completeGoogleConnect(code: string): Promise<void> {
    const { sub, email, refreshToken } = await this.google.exchangeCode(code);
    await this.google.storeRefreshToken(sub, refreshToken);
    const settings = await this.ensureSettings({ consistent: true });
    const others = settings.googleAccounts.filter((a) => a.sub !== sub);
    // Default the account's primary calendar (id = email) into the shape set on connect, so a freshly
    // connected account contributes to the day shape without a manual picker step; set it as the write
    // default if none is set yet. Dedup so a reconnect doesn't double-add.
    const primaryRef = { accountSub: sub, calendarId: email };
    const hasRef = settings.calendarShapeRefs.some(
      (r) => r.accountSub === sub && r.calendarId === email,
    );
    await this.repo.putSettings({
      ...settings,
      googleAccounts: [...others, { sub, email }],
      calendarShapeRefs: hasRef
        ? settings.calendarShapeRefs
        : [...settings.calendarShapeRefs, primaryRef],
      calendarWriteDefault: settings.calendarWriteDefault ?? primaryRef,
      updatedAt: this.now(),
    });
  }

  async getGoogleStatus(): Promise<GoogleStatus> {
    const settings = await this.ensureSettings();
    const accounts = await Promise.all(
      settings.googleAccounts.map(async (a) => {
        // Per-account resilience (the Cognito model): a transient probe failure for one account must
        // not sink the whole status read — degrade that one to reconnect-required.
        const [state, sync] = await Promise.all([
          this.google
            .getAccountState(a.sub)
            .catch(() => ({ connected: true, reconnectRequired: true })),
          this.repo.getGcalSyncState(a.sub),
        ]);
        return {
          sub: a.sub,
          email: a.email,
          connected: state.connected,
          reconnectRequired: state.reconnectRequired,
          lastSyncedAt: sync?.lastSyncedAt ?? null,
          lastPullError: sync?.lastPullError ?? null,
        };
      }),
    );
    return { accounts };
  }

  async listGoogleCalendars(): Promise<GoogleCalendar[]> {
    // Primary-only: each account's PRIMARY calendar, whose calendarId is the account email. We do NOT
    // call calendarList.list — the `calendar.events` scope does not grant it (403 "insufficient scopes";
    // listing all calendars would need calendar.readonly / calendar.calendarlist.readonly). events.list
    // and events.insert both work on the primary with the scope we have. If a non-primary picker is ever
    // wanted, add that scope and restore the gateway's listCalendars (still on the interface).
    const settings = await this.ensureSettings();
    return settings.googleAccounts.map((a) => ({
      accountSub: a.sub,
      calendarId: a.email,
      summary: a.email,
      primary: true,
    }));
  }

  async getCalendarBusy(input: GetCalendarBusyInput): Promise<CalendarBusy> {
    const settings = await this.ensureSettings();
    const intervals: BusyInterval[] = [];
    let allDayCount = 0;
    // One account's dead token must not sink the whole read (the Cognito resilience model): swallow a
    // per-account failure; the reconnect prompt surfaces via getGoogleStatus.
    await Promise.all(
      settings.calendarShapeRefs.map(async (ref) => {
        try {
          const res = await this.google.listBusy(
            ref.accountSub,
            ref.calendarId,
            input.windowStartMs,
            input.windowEndMs,
          );
          intervals.push(...res.intervals);
          allDayCount += res.allDayCount;
        } catch {
          /* per-account failure is recoverable; see getGoogleStatus */
        }
      }),
    );
    return { intervals, allDayCount };
  }

  async insertCalendarEvent(input: InsertCalendarEventInput): Promise<Task> {
    const task = await this.mustTask(input.taskId);
    // A parent's one event is its due marker, placed by its deadline (parts.ts). Before the other checks,
    // so MCP gets the reason that applies.
    if (hasParts(await this.repo.listTasks(), task.id)) throw new Error(PARENT_NO_EVENT_ERROR);
    // A timed task's block is its auto block, placed at its deadline — no picked time while sync is on.
    if (eventWindow(task, this.dueEpoch) && autoSyncOn(await this.ensureSettings()))
      throw new Error(AUTO_PLACED_ERROR);
    // One live event per task — a second insert would orphan the first.
    if (task.gcalEventId) throw new Error('Task already has a calendar event');
    // Two-system write: the event is created before its pointer is stored. If putTask below fails, a
    // real event is left with no stored id (a retry double-books). Accepted: it carries its task id
    // (extendedProperties), but nothing reconciles it — the pull only matches stored pointers.
    const { eventId, updatedMs } = await this.google.insertEvent({
      sub: input.accountSub,
      calendarId: input.calendarId,
      title: input.title,
      startMs: input.startMs,
      endMs: input.endMs,
      taskId: task.id,
    });
    return this.repo.putTask({
      ...task,
      gcalAccountId: input.accountSub,
      gcalCalendarId: input.calendarId,
      gcalEventId: eventId,
      gcalSeen: { title: input.title, startMs: input.startMs, endMs: input.endMs, updatedMs },
      gcalPulled: null, // a "Removed in Google Calendar" mark no longer holds
      updatedAt: this.now(),
    });
  }

  async deleteCalendarEvent(taskId: string): Promise<Task> {
    const task = await this.mustTask(taskId);
    // Blast-radius safety: only ever delete an event whose id WE stored, on its owning account+calendar.
    if (task.gcalEventId && task.gcalAccountId && task.gcalCalendarId) {
      await this.google
        .deleteEvent({
          sub: task.gcalAccountId,
          calendarId: task.gcalCalendarId,
          eventId: task.gcalEventId,
        })
        .catch(() => {}); // an already-gone event shouldn't block clearing the pointer
    }
    return this.repo.putTask({
      ...task,
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
      gcalSyncError: null,
      gcalSeen: null,
      updatedAt: this.now(),
    });
  }

  async syncCalendarEvent(taskId: string): Promise<Task> {
    return this.syncCalendar(null, await this.mustTask(taskId), true);
  }

  // Two-way sync, Google → task (calendarPull.ts decides; docs/areas/calendar → Two-way sync). Pulls each
  // account's events.list delta and applies edits made in Google to the events Aperture created —
  // matched by stored pointer, everything else dropped untouched. Never writes to Google. A Google
  // failure lands on that account's GcalSyncState (shown in Settings), never on the caller.
  async pullCalendar(): Promise<PullCalendarResult> {
    const deadlineMs = Date.now() + PULL_BUDGET_MS; // from the start: the reads below spend it too
    const settings = await this.ensureSettings();
    const idle: PullCalendarResult = { pulled: false, changedTaskIds: [], accounts: [] };
    if (settings.autoCalendar === false || settings.googleAccounts.length === 0) return idle;
    const now = this.now();
    const states = await Promise.all(
      settings.googleAccounts.map(
        async (a) =>
          (await this.repo.getGcalSyncState(a.sub, { consistent: true })) ?? {
            ...this.base(),
            id: a.sub,
            sub: a.sub,
            calendarId: a.email, // primary-only: its calendarId is the account email
            syncToken: null,
            lastPulledAt: null,
            lastSyncedAt: null,
            lastPullError: null,
            lastPullErrorAt: null,
          },
      ),
    );
    // At most once a minute per account — failures count, so a dead Google is probed no faster.
    const due = states.filter(
      (st) => !st.lastPulledAt || now - st.lastPulledAt >= PULL_THROTTLE_MS,
    );
    if (due.length === 0) return idle;
    const linked = new Map<string, Task>();
    const all = await this.repo.listTasks();
    for (const t of all)
      if (t.gcalAccountId && t.gcalCalendarId && t.gcalEventId)
        linked.set(`${t.gcalAccountId}|${t.gcalCalendarId}|${t.gcalEventId}`, t);
    const changed: string[] = [];
    const accounts = await Promise.all(
      due.map(async (st) => {
        await this.repo.putGcalSyncState({ ...st, lastPulledAt: now, updatedAt: now });
        try {
          const delta = await this.google.listEventChanges({
            sub: st.sub,
            calendarId: st.calendarId,
            syncToken: st.syncToken,
            deadlineMs,
          });
          for (const ev of delta.events) {
            const task = linked.get(`${st.sub}|${st.calendarId}|${ev.eventId}`);
            if (!task) continue;
            // The writes spend the budget too; stopping keeps the old token, and a replay is idempotent.
            if (Date.now() > deadlineMs) throw new PullIncompleteError();
            const kind = await this.putPull(task.id, st, ev, !st.syncToken, all);
            if (kind === 'apply' || kind === 'unlink') changed.push(task.id);
          }
          await this.repo.putGcalSyncState({
            ...st,
            syncToken: delta.syncToken,
            lastPulledAt: now,
            lastSyncedAt: now,
            lastPullError: null,
            lastPullErrorAt: null,
            updatedAt: this.now(),
          });
          return { sub: st.sub, ok: true, error: null };
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          console.log(JSON.stringify({ event: 'gcal_pull_failed', sub: st.sub, detail }));
          await this.repo.putGcalSyncState({
            ...st,
            lastPulledAt: now,
            lastPullError: detail,
            lastPullErrorAt: now,
            updatedAt: this.now(),
          });
          return { sub: st.sub, ok: false, error: detail };
        }
      }),
    );
    return { pulled: true, changedTaskIds: changed, accounts };
  }
  // A pull's write, PLANNED on a fresh read: the task scan can be seconds old by the time the delta
  // lands, and an edit (or a delete) since must win. A task that's gone or no longer linked to this
  // event is left alone. Never re-runs syncCalendar (the pull never writes to Google) — the task now
  // matches the event, except where Aperture's value was kept: that goes with the next push.
  private async putPull(
    taskId: string,
    st: GcalSyncState,
    ev: PulledEvent,
    firstSync: boolean, // the account's first sync (no token yet) — calendarPullPlan's first sight
    all: Task[], // the scan: whether it's a parent (its marker), and a part's parent's title
  ): Promise<PullAction['kind']> {
    const fresh = await this.repo.getTask(taskId, { consistent: true }); // written back, like putGcal's
    if (
      !fresh ||
      fresh.gcalAccountId !== st.sub ||
      fresh.gcalCalendarId !== st.calendarId ||
      fresh.gcalEventId !== ev.eventId
    )
      return 'none';
    const parent = hasParts(all, fresh.id);
    const parentTitle = fresh.parentId
      ? (all.find((t) => t.id === fresh.parentId)?.title ?? null)
      : null;
    const action = calendarPullPlan(fresh, ev, this.pullTime, { firstSync, parent, parentTitle });
    if (action.kind === 'none') return 'none';
    const now = this.now();
    const write: Partial<Task> =
      action.kind === 'see'
        ? { gcalSeen: action.seen }
        : action.kind === 'apply'
          ? {
              ...action.fields,
              gcalSeen: action.seen,
              gcalPulled: { at: now, note: action.note },
            }
          : {
              gcalAccountId: null,
              gcalCalendarId: null,
              gcalEventId: null,
              gcalSyncError: null,
              gcalSeen: null,
              gcalPulled: { at: now, note: action.note },
            };
    await this.repo.putTask({ ...fresh, ...write, updatedAt: now });
    return action.kind;
  }

  async disconnectGoogleAccount(accountSub: string): Promise<void> {
    await this.google.removeAccount(accountSub);
    // Tombstone the cursor (never a hard delete — TECH §2.4); a reconnect starts with a full sync.
    const sync = await this.repo.getGcalSyncState(accountSub, { consistent: true });
    if (sync)
      await this.repo.putGcalSyncState({ ...sync, deletedAt: this.now(), updatedAt: this.now() });
    const settings = await this.ensureSettings({ consistent: true });
    await this.repo.putSettings({
      ...settings,
      googleAccounts: settings.googleAccounts.filter((a) => a.sub !== accountSub),
      calendarShapeRefs: settings.calendarShapeRefs.filter((r) => r.accountSub !== accountSub),
      calendarWriteDefault:
        settings.calendarWriteDefault?.accountSub === accountSub
          ? null
          : settings.calendarWriteDefault,
      updatedAt: this.now(),
    });
  }

  // --- Calibration ---
  // Parity with the stub: every done+locked task (parts.ts calibrationTasks), by completion DAY
  // (dayStartHour offset).
  // TODO(scale): swap the full task scan for `repo.doneTasksInWindow` over the GSI once the
  // day-range → epoch-window mapping (with the offset) is nailed down.
  async getCalibration(range: DateRange): Promise<CalibrationPoint[]> {
    const start = (await this.ensureSettings()).dayStartHour;
    const tasks = await this.repo.listTasks();
    return calibrationTasks(tasks)
      .filter((t) => t.completedAt !== null)
      .map((t) => ({
        taskId: t.id,
        day: dayKey(t.completedAt as number, start),
        estimateLockedMin: t.estimateLockedMin as number,
        actualAccruedMin: t.actualAccruedMin,
        categoryId: t.categoryId,
        reflection: t.reflection ?? null,
        parts: rollupParts(tasks, t.id),
      }))
      .filter((p) => p.day >= range.from && p.day <= range.to)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  async exportData(): Promise<ExportBundle> {
    return {
      exportedAt: this.now(),
      userId: this.userId,
      logEntries: await this.repo.listAllLog(),
      tasks: await this.repo.listTasks(),
      plans: await this.repo.listAllPlans(),
      series: await this.repo.listSeries(),
      ideas: await this.repo.listIdeas(),
      habits: await this.repo.listHabits(),
      habitChecks: await this.repo.listAllChecks(),
      rolls: await this.repo.listRolls(),
      sessions: await this.repo.listAllSessions(),
      days: await this.repo.listAllDays(),
      categories: await this.repo.listCategories(),
      places: await this.listPlaces(), // never the token pointer or its lookup row (a credential)
      leetcodeAttempts: await this.repo.listLeetcodeAttempts(),
      stories: await this.repo.listStories(),
      attachments: (await this.repo.listAllAttachments()).filter((a) => a.status === 'ready'),
      fluxSets: inRange(await this.repo.listAllFluxSets()),
      ...(await this.finance.exportCollections()),
      gcalSyncStates: await this.repo.listGcalSyncStates(),
      settings: await this.ensureSettings(),
    };
  }

  // --- Finances (finance/service.ts) ---
  getFinanceOverview(input: { today: string }): Promise<FinanceOverview> {
    return this.finance.getFinanceOverview(input);
  }
  listFinanceTransactions(range: DateRange): Promise<FinanceTransaction[]> {
    return this.finance.listFinanceTransactions(range);
  }
  setFinanceBucket(input: SetFinanceBucketInput): Promise<FinanceTransaction[]> {
    return this.finance.setFinanceBucket(input);
  }
  setFinancePeriodOverride(
    id: string,
    override: FinancePeriodOverride | null,
  ): Promise<FinanceTransaction> {
    return this.finance.setFinancePeriodOverride(id, override);
  }
  setFinanceNote(id: string, note: string | null): Promise<FinanceTransaction> {
    return this.finance.setFinanceNote(id, note);
  }
  setFinancePeriodStart(id: string, marked: boolean): Promise<FinanceTransaction> {
    return this.finance.setFinancePeriodStart(id, marked);
  }
  linkFinanceRefund(refundId: string, chargeId: string | null): Promise<FinanceTransaction> {
    return this.finance.linkFinanceRefund(refundId, chargeId);
  }
  listFinanceRules(): Promise<FinanceRule[]> {
    return this.finance.listFinanceRules();
  }
  upsertFinanceRule(input: UpsertFinanceRuleInput): Promise<FinanceRule> {
    return this.finance.upsertFinanceRule(input);
  }
  deleteFinanceRule(id: string): Promise<void> {
    return this.finance.deleteFinanceRule(id);
  }
  updateFinanceAccount(id: string, patch: FinanceAccountPatch): Promise<FinanceAccount> {
    return this.finance.updateFinanceAccount(id, patch);
  }
  createPlaidLinkToken(input: CreateLinkTokenInput): Promise<LinkTokenResult> {
    return this.finance.createPlaidLinkToken(input);
  }
  exchangePlaidPublicToken(input: ExchangePublicTokenInput): Promise<FinanceItem> {
    return this.finance.exchangePlaidPublicToken(input);
  }
  completePlaidUpdate(itemId: string): Promise<FinanceItem> {
    return this.finance.completePlaidUpdate(itemId);
  }
  removePlaidItem(itemId: string): Promise<void> {
    return this.finance.removePlaidItem(itemId);
  }
  requestFinanceSync(input: { refresh: boolean }): Promise<RequestFinanceSyncResult> {
    return this.finance.requestFinanceSync(input);
  }
}
