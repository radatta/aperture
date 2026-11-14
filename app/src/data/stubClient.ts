// In-memory ApiClient implementation — the page-first stand-in. Persists to localStorage so a
// refresh keeps state. The real Lambda (Phase 10) implements the SAME interface; swapping is one
// module. Two things are deliberately faithful so this validates the product, not a toy:
//   - the WRITES-OBJECT seam: every mutation funnels through `writes` (single audit point), mirroring
//     the Lambda rule that guarantees no stray side effects.
//   - LAZY recurrence: due series occurrences materialize on getDay(), exactly like the Lambda will.
//   - LAZY stale sweep: getDay() also returns planned tasks with no plan row on/after the day to backlog.

import {
  addDays,
  applyRules,
  assertAttachmentAllowed,
  buildFinanceOverview,
  detectInternalMoves,
  FINANCE_DEFAULT_BUDGET_CENTS,
  FINANCE_DEFAULT_PAYMENT_DAY,
  FINANCE_OVERVIEW_LOOKBACK_DAYS,
  FINANCE_REFRESH_COOLDOWN_MS,
  financeBucketError,
  FIXTURE_ACCOUNTS,
  FIXTURE_INSTITUTION,
  FIXTURE_ITEM_ID,
  FIXTURE_LINK_ACCOUNTS,
  fixturePageAfter,
  duplicateItemMessage,
  isDuplicateItem,
  normalizeRulePattern,
  reconcileSyncPage,
  periodStartError,
  refundLinkError,
  todayKey,
  toCents,
  assertArea,
  assertCategoryDeletable,
  calendarPullPlan,
  seenFromTask,
  calendarSyncPlan,
  seenAfter,
  syncedFieldsChanged,
  AUTO_PLACED_ERROR,
  autoSyncOn,
  accruesTime,
  completeSession,
  countsTowardCap,
  createUlid,
  dayKeyInZone,
  USER_TIME_ZONE,
  dayKeyForOffset,
  discardSession,
  eventLengthMin,
  extendSession,
  eventWindow,
  syncWindow,
  isPendingRemoval,
  localDayTime,
  localEpochFromDayTime,
  PULL_THROTTLE_MS,
  normalizeDue,
  findOpenRollTask,
  heartbeatSession,
  normalizeContentType,
  normalizeNotes,
  normalizeReflection,
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
  parentOf,
  partsOf,
  rollupParts,
  releaseParent,
  splitFollowUp,
  rescopedPlanMinutes,
  splitOriginal,
  stalePlannedMoves,
  assertActualAllowed,
  taskTransition,
  UPLOAD_URL_TTL_MS,
  withEstimate,
  runQuickParse,
  PLACE_FINISHED_ERROR,
  PLACE_PART_ERROR,
  PLACE_TOKEN_PREFIX,
  placeDigestOf,
  PUSH_DEVICE_ID_LEN,
  PUSH_NO_DEVICE_ERROR,
  PUSH_UNKNOWN_DEVICE_ERROR,
  parsePushInput,
  REMINDER_SETTINGS_DEFAULTS,
  placeError,
  placeUnknownError,
  slugify,
  emptyLiveFields,
  emptySummary,
  endedSitting,
  foldLive,
  isHeadEvent,
  LC_ROLL_UNLINKED_ERROR,
  normalizePrepTarget,
  normalizeSittingEvents,
  normalizeSittingReview,
  normalizeSittingStart,
  draftMistakes,
  timelineOf,
  planSittingStart,
  reserveBudget,
  summarizeHeadRows,
  newerSummary,
  headRowOf,
  claimStart,
  countStartAttempt,
  emptyGate,
  releaseStart,
  SITTING_INGEST_WINDOW_MS,
  SITTING_START_TIME_ERROR,
  PREP_TARGET_DEFAULT,
  sittingIngestError,
  eventsBeforeEnd,
  isSittingOpen,
  newestOfType,
  sittingProblemUrl,
  sittingRepTitle,
} from '@aperture/shared';
import type {
  ApiClient,
  Attachment,
  BaseEntity,
  CalendarBusy,
  CalibrationPoint,
  Area,
  Category,
  CreateAttachmentInput,
  CreateLinkTokenInput,
  CreateTaskInput,
  DateRange,
  ExchangePublicTokenInput,
  FinanceAccount,
  FinanceAccountPatch,
  FinanceItem,
  FinanceOverview,
  FinancePeriodOverride,
  FinanceRule,
  FinanceSyncState,
  FinanceTransaction,
  GcalSeen,
  GcalSyncState,
  LinkTokenResult,
  ParseTaskResult,
  PullCalendarResult,
  PulledEvent,
  RequestFinanceSyncResult,
  SetFinanceBucketInput,
  SetTaskDueInput,
  SplitTaskInput,
  SyncContext,
  UpsertFinanceRuleInput,
  GetCalendarBusyInput,
  GoogleCalendar,
  GoogleStatus,
  InsertCalendarEventInput,
  Day,
  ExportBundle,
  Habit,
  HabitCheck,
  Idea,
  IdeaStatus,
  FluxSet,
  FluxSetFilter,
  RecordFluxSetInput,
  LogEntry,
  Place,
  PlaceDigest,
  PlaceTokenStatus,
  PomodoroSession,
  PushDevice,
  PushPollerHealth,
  PushStatus,
  PushSub,
  SubscribePushInput,
  Roll,
  Settings,
  SettingsPatch,
  StartSessionInput,
  Story,
  StoryPatch,
  CreateStoryInput,
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
  FluxWeekNote,
  FluxWeekNoteRow,
  LeetcodeProblem,
  NormalizedSittingStart,
  Sitting,
  SittingDetail,
  LiveSittingPull,
  SittingBudget,
  SittingHeadRow,
  LcStartGate,
  SittingEvent,
  SittingEventsInput,
  SittingEventsResult,
  SittingLive,
  SittingReplayChunk,
  SittingReviewInput,
  ReviewDraft,
  SittingStartInput,
  SittingStartResult,
} from '@aperture/shared';
import { patchKeyError, SETTINGS_PATCH_KEYS, STORY_PATCH_KEYS } from '@aperture/shared';
import {
  FLUX_NOTE_MIN_SETS,
  fluxFilterError,
  fluxNoteFingerprint,
  fluxNoteOf,
  fluxSetError,
  fluxSetsError,
  fluxWeekLine,
  fluxWeekSets,
  fluxWeekStart,
  fluxWeekSummary,
  inRange,
} from '@aperture/shared/flux';
import { heuristicParse, takeStubParseFailure } from './stubParse';
import { forgetStubBlob } from './attachmentTransport';
import { seedStore } from './seed';

const USER_ID = 'local';
const FINANCE_SETTINGS_DEFAULTS = {
  financeBudgetCents: FINANCE_DEFAULT_BUDGET_CENTS,
  financePaymentDay: FINANCE_DEFAULT_PAYMENT_DAY,
};
const FLUX_SETTINGS_DEFAULTS = { fluxRollId: null, fluxDisclaimerAckAt: null, fluxSets: {} };
const LC_SETTINGS_DEFAULTS = { leetcodeRollId: null };
const STORAGE_KEY = 'aperture.stub.v1';
// The stub's VAPID public key: a real uncompressed P-256 point (65 bytes, base64url), generated once with
// node:crypto, so the browser's pushManager.subscribe accepts it. Nothing holds its private half — the
// stub has no poller, so a subscription made against it never receives a push.
export const STUB_VAPID_PUBLIC_KEY =
  'BAuD2GLQNc-o5pGNgH9oDVlMVDBmI7fGShjqf4MGIOLBM1FLyvGDRLbxOm9GyIk-W7OvqPVECPjdOna3bq-sx6A';
const NO_POLLER_RUN: PushPollerHealth = {
  lastRunAt: null,
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
};
// Done or dropped: a finished task's place is history (places.ts PLACE_FINISHED_ERROR).
const isFinished = (t: Task) => t.status === 'done' || t.status === 'cancelled';
// A part's place is its parent's: none given takes it, a different slug is refused (PLACE_PART_ERROR).
function partPlace(given: string | null, parent: Task | undefined): string | null {
  if (!parent) return given;
  if (given !== null && given !== parent.place) throw new Error(PLACE_PART_ERROR);
  return parent.place;
}

// The Shortcut's token, kept in plaintext here — hashing it is the backend's job (places.md). The stub has
// no Shortcut route, so nothing ever reads with it: lastUsedAt stays null and readsToday 0.
interface StubPlaceToken {
  token: string;
  createdAt: number;
}

export interface Store {
  logEntries: LogEntry[];
  tasks: Task[];
  plans: TaskPlan[];
  series: TaskSeries[];
  ideas: Idea[];
  habits: Habit[];
  habitChecks: HabitCheck[];
  rolls: Roll[];
  sessions: PomodoroSession[];
  days: Day[];
  categories: Category[];
  places: Place[];
  placeToken: StubPlaceToken | null; // a credential: never exported
  pushSubs: PushSub[]; // credentials (endpoint + keys): never exported
  pushHealth: PushPollerHealth; // the poller's heartbeat, which only Send test moves here: not user data
  sittings: Sitting[];
  sittingLive: SittingLive[];
  sittingEvents: SittingEvent[];
  sittingReplay: SittingReplayChunk[];
  sittingBudgets: SittingBudget[]; // capture budgets: internal, never exported
  sittingReads: SittingReads[]; // Claude's live pulls per sitting (id = the sitting's): internal, never exported
  sittingHeadRows: (SittingHeadRow & BaseEntity)[];
  lcStartGate: LcStartGate | null; // the Start gate: internal, never exported
  leetcodeProblems: LeetcodeProblem[];
  stories: Story[];
  attachments: Attachment[];
  fluxSets: FluxSet[];
  fluxNotes: FluxWeekNoteRow[]; // the weekly note cache (D62) — the stub's note is the deterministic line
  financeItems: FinanceItem[];
  financeSyncStates: FinanceSyncState[];
  financeAccounts: FinanceAccount[];
  financeTransactions: FinanceTransaction[];
  financeRules: FinanceRule[];
  gcalSyncStates: GcalSyncState[];
  settings: Settings | null;
}

type SittingReads = BaseEntity & { sittingId: string; count: number };

export function emptyStore(): Store {
  return {
    logEntries: [],
    tasks: [],
    plans: [],
    series: [],
    ideas: [],
    habits: [],
    habitChecks: [],
    rolls: [],
    sessions: [],
    days: [],
    categories: [],
    places: [],
    placeToken: null,
    pushSubs: [],
    pushHealth: NO_POLLER_RUN,
    sittings: [],
    sittingLive: [],
    sittingEvents: [],
    sittingReplay: [],
    sittingBudgets: [],
    sittingReads: [],
    sittingHeadRows: [],
    lcStartGate: null,
    leetcodeProblems: [],
    stories: [],
    attachments: [],
    fluxSets: [],
    fluxNotes: [],
    financeItems: [],
    financeSyncStates: [],
    financeAccounts: [],
    financeTransactions: [],
    financeRules: [],
    gcalSyncStates: [],
    settings: null,
  };
}

export interface StubOptions {
  now?: () => number;
  storageKey?: string;
  seed?: boolean;
}

// Dev/test hook: set this localStorage key to a Plaid error code (e.g. INSTITUTION_NOT_RESPONDING, or
// ITEM_LOGIN_REQUIRED) and the stub's next finance sync fails with it, once. Stub-only — the real
// failure paths are Plaid's.
export const STUB_FAIL_NEXT_SYNC_KEY = 'aperture:stub:failNextFinanceSync';
function takeStubSyncFailure(): string | null {
  try {
    const code = globalThis.localStorage?.getItem(STUB_FAIL_NEXT_SYNC_KEY) ?? null;
    if (code) globalThis.localStorage?.removeItem(STUB_FAIL_NEXT_SYNC_KEY);
    return code || null;
  } catch {
    return null;
  }
}

// Dev/test hook: while this localStorage key is set, the stub refuses every recordFluxSet as if the
// network were down — how the Flux outbox (D49) is exercised without a real network. Stub-only.
export const STUB_FAIL_FLUX_SAVE_KEY = 'aperture:stub:failFluxSave';
function stubFluxSaveFails(): boolean {
  try {
    return Boolean(globalThis.localStorage?.getItem(STUB_FAIL_FLUX_SAVE_KEY));
  } catch {
    return false;
  }
}

// Dev/test hook for two-way calendar sync: the stub has no Google, so an edit "made in Google" is queued
// here as a JSON array and applied by the next pullCalendar — through the same shared planner as the
// Lambda. Each entry names a linked task and what changed; anything left out keeps the event as known.
// A non-empty queue bypasses the stub's once-a-minute throttle (stub-only) — but the app's own hook
// still pulls at most once a minute, so to see it: queue, then RELOAD (or foreground after a minute).
// `failAccount` makes that account's pull fail with `error`.
//   [{ "taskId": "…", "end": "2026-10-09 17:00", "durationMin": 45, "title": "pset 3" },
//    { "taskId": "…", "allDay": true }, { "taskId": "…", "cancelled": true },
//    { "failAccount": "seed-personal", "error": "timeout" }]
export const STUB_GCAL_EDITS_KEY = 'aperture:stub:gcalEdits';
export interface StubGcalEdit {
  taskId?: string;
  title?: string;
  end?: string; // "YYYY-MM-DD HH:MM", the user's wall clock
  durationMin?: number;
  allDay?: boolean;
  cancelled?: boolean;
  failAccount?: string;
  error?: string;
}
function takeStubGcalEdits(): StubGcalEdit[] {
  try {
    const raw = globalThis.localStorage?.getItem(STUB_GCAL_EDITS_KEY) ?? null;
    if (!raw) return [];
    globalThis.localStorage?.removeItem(STUB_GCAL_EDITS_KEY);
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StubGcalEdit[]) : [];
  } catch {
    return [];
  }
}

export function createStubClient(options: StubOptions = {}): ApiClient {
  return new StubClient(options);
}

class StubClient implements ApiClient {
  private store: Store;
  private readonly now: () => number;
  private readonly key: string;
  private readonly ulid: () => string;

  constructor(opts: StubOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.key = opts.storageKey ?? STORAGE_KEY;
    this.ulid = createUlid(this.now);
    const loaded = this.load();
    if (loaded) {
      this.store = loaded;
    } else {
      this.store = emptyStore();
      if (opts.seed !== false) {
        seedStore(this.store, this.now(), this.ulid);
        this.seedFinance();
      }
      this.persist();
    }
  }

  // --- persistence ---------------------------------------------------------
  private load(): Store | null {
    try {
      const raw = globalThis.localStorage?.getItem(this.key);
      // Coalesce over emptyStore() so a pre-existing persisted store gains new collections (e.g.
      // sittings) without a wipe or an undefined.push crash.
      if (!raw) return null;
      const store = { ...emptyStore(), ...(JSON.parse(raw) as Partial<Store>) };
      // Settings gain fields over time; a persisted row from before them reads the defaults.
      if (store.settings) {
        store.settings = {
          ...FINANCE_SETTINGS_DEFAULTS,
          ...FLUX_SETTINGS_DEFAULTS,
          ...LC_SETTINGS_DEFAULTS,
          ...REMINDER_SETTINGS_DEFAULTS,
          ...store.settings,
        };
        delete (store.settings as { financeCycleDay?: number }).financeCycleDay; // → financePaymentDay
      }
      // Rows persisted before refund linking / period marks existed read as unlinked and unmarked.
      store.financeTransactions = store.financeTransactions.map((t) => ({
        ...t,
        refundOfId: t.refundOfId ?? null,
        startsPeriod: t.startsPeriod ?? false,
      }));
      // Tasks from before places read as off every list.
      store.tasks = store.tasks.map((t) => ({ ...t, place: t.place ?? null }));
      store.financeSyncStates = store.financeSyncStates.map((x) => ({
        ...x,
        lastSyncErrorAt: x.lastSyncErrorAt ?? null,
        lastRefreshedAt: x.lastRefreshedAt ?? null,
      }));
      return store;
    } catch {
      return null;
    }
  }
  private persist(): void {
    try {
      globalThis.localStorage?.setItem(this.key, JSON.stringify(this.store));
    } catch {
      /* non-browser / quota — in-memory only */
    }
  }

  // --- the writes seam: how collections are mutated ------------------------
  // Every collection mutation goes through here (single audit point, mirroring the Lambda's rule).
  // The one thing outside it is `ensureSettings`, which lazily materialises the settings SINGLETON —
  // not a collection, so it doesn't fit these array-shaped helpers. Note that makes getSettings /
  // dayStartHour / exportData read paths that can write on a virgin store; the backend's own
  // ensureSettings does the same, so the two stay in parity.
  private writes = {
    insert: <T extends BaseEntity>(coll: T[], item: NoInfer<T>): T => {
      coll.push(item);
      this.persist();
      return item;
    },
    // Many rows, one persist — an ingest call's events (persisting the whole store per row is quadratic).
    insertMany: <T extends BaseEntity>(coll: T[], items: NoInfer<T>[]): T[] => {
      coll.push(...items);
      this.persist();
      return items;
    },
    put: <T extends BaseEntity>(coll: T[], next: NoInfer<T>): T => {
      const idx = coll.findIndex((x) => x.id === next.id);
      if (idx === -1) coll.push(next);
      else coll[idx] = next;
      this.persist();
      return next;
    },
    patch: <T extends BaseEntity>(coll: T[], id: string, patch: Partial<NoInfer<T>>): T => {
      const idx = coll.findIndex((x) => x.id === id && x.deletedAt === null);
      if (idx === -1) throw new Error(`Not found: ${id}`);
      const next = { ...coll[idx]!, ...patch, updatedAt: this.now() } as T;
      coll[idx] = next;
      this.persist();
      return next;
    },
    softDelete: <T extends BaseEntity>(coll: T[], id: string): void => {
      const idx = coll.findIndex((x) => x.id === id);
      if (idx === -1) return;
      coll[idx] = { ...coll[idx]!, deletedAt: this.now(), updatedAt: this.now() };
      this.persist();
    },
  };

  // --- helpers -------------------------------------------------------------
  private baseAt(t: number): BaseEntity {
    return { id: this.ulid(), userId: USER_ID, createdAt: t, updatedAt: t, deletedAt: null };
  }
  private base(): BaseEntity {
    return this.baseAt(this.now());
  }
  // Shared task literal for createTask + createTasks. A batch passes one `t` for every task so they
  // tie on createdAt and render as a block in ULID (paste) order (listTasks sorts createdAt desc, stable).
  private newTask(input: CreateTaskInput, t: number): Task {
    const parent = input.parentId ? this.find(this.store.tasks, input.parentId) : undefined;
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
      // Throws on an unknown slug, or a part's slug that isn't its parent's, before createTasks writes.
      place: partPlace(this.knownPlace(input.place ?? null), parent),
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
  // tombstoned), and its block becomes its due marker (a timed one with none gets one). Pass the task
  // as it was; returns it as a parent. Call AFTER the first part is written.
  private adoptAsParent(parent: Task): Task {
    for (const p of this.alive(this.store.plans).filter((p) => p.taskId === parent.id))
      this.writes.softDelete(this.store.plans, p.id);
    const became = this.writes.put(this.store.tasks, becomeParent(parent, this.now()));
    return this.syncCalendar(parent, became, true, { parent: true });
  }
  // The rollup's baseline, frozen when `starting` — the first part to leave planning — does
  // (parts.ts freezeParentLock).
  private freezeLock(parentId: string | null, starting: string): void {
    const parent = parentId ? this.find(this.store.tasks, parentId) : undefined;
    if (!parent) return;
    const parts = partsOf(this.alive(this.store.tasks), parent.id);
    const frozen = freezeParentLock(parent, parts, starting, this.now());
    if (frozen) this.writes.put(this.store.tasks, frozen);
  }
  // A task whose last part just went is plain again: its parts' lock goes (parts.ts releaseParent) and
  // its due marker turns back into a block.
  private releaseParentState(parentId: string | null): void {
    const parent = parentId ? this.find(this.store.tasks, parentId) : undefined;
    const alive = this.alive(this.store.tasks);
    if (!parent || hasParts(alive, parent.id)) return;
    const released = releaseParent(parent, alive, this.now());
    const plain = released ? this.writes.put(this.store.tasks, released) : parent;
    if (plain.gcalEventId) this.syncCalendar(plain, plain, true, { parent: false });
  }
  // Calendar auto-sync parity with the backend: the same shared planner, executed against a fake event
  // id (no Google here). The browser's clock is the user's, so the local epoch is the right one. `ctx`
  // overrides what the task list says (adopt and release know before the list does); the event's look
  // (marker or block) heals from gcalSeen either way.
  private syncCalendar(
    prev: Task | null,
    task: Task,
    ensure = false,
    ctx: Pick<SyncContext, 'parent'> = {},
  ): Task {
    if (!task.dueTime && !task.gcalEventId && !task.gcalSyncError) return task; // nothing to sync
    const settings = this.ensureSettings();
    const alive = this.alive(this.store.tasks);
    const parent = ctx.parent ?? hasParts(alive, task.id);
    const action = calendarSyncPlan(prev, task, settings, localEpochFromDayTime, {
      ensure,
      parent,
      parentTitle: parentOf(alive, task)?.title ?? null,
    });
    // A linked task's title/time/estimate edit — pushed, failed or not pushed at all (done, sync off) —
    // retires an "updated from Google" note it has just superseded.
    const edited =
      !!prev && !!task.gcalEventId && !!task.gcalPulled && syncedFieldsChanged(prev, task);
    const editStamp = edited ? { gcalPulled: null } : {};
    if (action.kind === 'none') {
      const moot =
        task.gcalSyncError &&
        ((!task.gcalEventId && !syncWindow(task, localEpochFromDayTime, parent)) ||
          settings.autoCalendar === false ||
          task.status === 'done' ||
          task.status === 'cancelled');
      if (!moot && !edited) return task;
      return this.writes.patch(this.store.tasks, task.id, {
        ...(moot && { gcalSyncError: null }),
        ...editStamp,
      });
    }
    if (action.kind === 'delete') return this.clearCalendarPointers(task.id);
    // A create or patch records the event as it now stands, versioned by the clock (Google's `updated`).
    if (action.kind === 'patch')
      return this.writes.patch(this.store.tasks, task.id, {
        gcalSyncError: null,
        gcalSeen: seenAfter(action, task.gcalSeen, this.now()),
        ...editStamp,
      });
    return this.writes.patch(this.store.tasks, task.id, {
      gcalAccountId: action.target.accountSub,
      gcalCalendarId: action.target.calendarId,
      gcalEventId: `stub-event-${this.ulid()}`,
      gcalSyncError: null,
      gcalSeen: seenAfter(action, null, this.now()),
      gcalPulled: null, // a "Removed in Google Calendar" mark no longer holds
    });
  }
  private clearCalendarPointers(taskId: string): Task {
    return this.writes.patch(this.store.tasks, taskId, {
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
      gcalSyncError: null,
      gcalSeen: null,
    });
  }
  private alive<T extends BaseEntity>(coll: T[]): T[] {
    return coll.filter((x) => x.deletedAt === null);
  }
  private find<T extends BaseEntity>(coll: T[], id: string): T | undefined {
    return coll.find((x) => x.id === id && x.deletedAt === null);
  }
  private mustFind<T extends BaseEntity>(coll: T[], id: string): T {
    const found = this.find(coll, id);
    if (!found) throw new Error(`Not found: ${id}`);
    return found;
  }
  private dayStartHour(): number {
    return this.ensureSettings().dayStartHour;
  }
  // A task's place as given ('' is none), refused when no alive place has that slug.
  private knownPlace(slug: string | null): string | null {
    if (!slug) return null;
    if (!this.alive(this.store.places).some((p) => p.slug === slug))
      throw new Error(placeUnknownError(slug));
    return slug;
  }
  private ensureSettings(): Settings {
    // A row from before the reminder toggles reads them on, like the backend's (reminderEnabled).
    if (this.store.settings) return { ...REMINDER_SETTINGS_DEFAULTS, ...this.store.settings };
    const settings: Settings = {
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
      ...FINANCE_SETTINGS_DEFAULTS,
      ...FLUX_SETTINGS_DEFAULTS,
      ...LC_SETTINGS_DEFAULTS,
      ...REMINDER_SETTINGS_DEFAULTS,
    };
    this.store.settings = settings;
    this.persist();
    return settings;
  }

  // --- Log -----------------------------------------------------------------
  async listLogEntries(day: string): Promise<LogEntry[]> {
    return this.alive(this.store.logEntries)
      .filter((e) => e.day === day)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async createLogEntry(text: string, day: string, opts?: { private?: boolean }): Promise<LogEntry> {
    if (opts?.private !== undefined && typeof opts.private !== 'boolean')
      throw new Error('private must be true or false');
    return this.writes.insert(this.store.logEntries, {
      ...this.base(),
      day,
      text,
      private: opts?.private === true,
    });
  }
  async updateLogEntry(id: string, text: string): Promise<LogEntry> {
    return this.writes.patch(this.store.logEntries, id, { text });
  }
  async listLogRange(range: Partial<DateRange>): Promise<LogEntry[]> {
    const { from, to } = range;
    if ((from !== undefined && !isDayKey(from)) || (to !== undefined && !isDayKey(to)))
      throw new Error('Invalid day');
    if (from !== undefined && to !== undefined && from > to) throw new Error('Invalid range');
    return this.alive(this.store.logEntries)
      .filter((e) => (from === undefined || e.day >= from) && (to === undefined || e.day <= to))
      .sort((a, b) =>
        a.day !== b.day
          ? a.day < b.day
            ? -1
            : 1
          : a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
      );
  }
  async deleteLogEntry(id: string): Promise<void> {
    if (this.store.logEntries.some((e) => e.id === id && e.deletedAt === null))
      this.writes.softDelete(this.store.logEntries, id);
  }
  async setLogEntryPrivate(id: string, isPrivate: boolean): Promise<LogEntry> {
    if (typeof isPrivate !== 'boolean') throw new Error('private must be true or false');
    return this.writes.patch(this.store.logEntries, id, { private: isPrivate });
  }

  // --- LeetCode sittings (sittings.ts) --------------------------------------
  async lcSittingStart(input: SittingStartInput): Promise<SittingStartResult> {
    const n = normalizeSittingStart(input);
    const now = this.now();
    if (Math.abs(n.startedAt - now) > SITTING_INGEST_WINDOW_MS)
      throw new Error(SITTING_START_TIME_ERROR);
    const settings = this.ensureSettings();
    const gateDay = dayKeyInZone(now, USER_TIME_ZONE, settings.dayStartHour);
    this.store.lcStartGate = {
      ...countStartAttempt(
        this.store.lcStartGate ?? { ...this.base(), id: 'lcstart', ...emptyGate(gateDay) },
        gateDay,
      ),
      updatedAt: now,
    };
    const linked = settings.leetcodeRollId ?? null;
    const roll = linked ? this.find(this.store.rolls, linked) : undefined;
    if (!roll?.active) throw new Error(LC_ROLL_UNLINKED_ERROR); // archived reads as unlinked
    const sittings = this.alive(this.store.sittings);
    const plan = planSittingStart(n, sittings, this.alive(this.store.tasks), roll.id, now);
    for (const e of plan.ends) this.endSitting(e.sitting.id, e.to, e.at);
    if (plan.kind === 'resume') {
      const shaped = await this.resumeShape(plan.sitting, roll);
      this.keepProblem(n, false);
      return { sitting: shaped, resumed: true };
    }
    // A deleted sitting's id, reused (backend parity: its tombstone wins the head's put-if-absent).
    if (this.store.sittings.some((x) => x.id === n.clientSittingId))
      throw new Error(`Not found: ${n.clientSittingId}`);
    const ended = new Set(plan.ends.map((e) => e.sitting.id));
    const claimed = claimStart(
      this.store.lcStartGate,
      gateDay,
      n.clientSittingId,
      sittings,
      ended,
      now,
    );
    if (claimed) this.store.lcStartGate = { ...claimed, updatedAt: now };
    // The head first, then the rep — the backend's order (its claim is what makes a retry safe).
    const sitting = this.writes.insert(this.store.sittings, {
      ...this.base(),
      id: n.clientSittingId, // the head's id IS the Start's idempotency key (backend parity)
      day: dayKeyForOffset(now, n.tzOffsetMinutes, settings.dayStartHour),
      startedAt: now,
      clientStartedAt: n.startedAt,
      endedAt: null,
      status: 'active',
      clientSittingId: n.clientSittingId,
      problemSlug: n.problemSlug,
      problemTitle: n.problemTitle,
      questionId: n.questionId,
      frontendId: n.frontendId,
      difficulty: n.difficulty,
      topicTags: n.topicTags,
      lang: n.lang,
      repTaskId: plan.kind === 'attach' ? plan.rep.id : this.ulid(),
      rollId: roll.id,
      prepTarget: PREP_TARGET_DEFAULT,
      lcSolveSessionId: n.lcSolveSessionId,
      shapedAt: null,
      summary: emptySummary(),
    });
    const shaped = await this.finishShaping(sitting, roll);
    this.keepProblem(n, true);
    return { sitting: shaped, resumed: false };
  }
  private async resumeShape(s: Sitting, linked: Roll): Promise<Sitting> {
    if (s.status !== 'active') return s;
    const roll =
      s.rollId === linked.id ? linked : (this.find(this.store.rolls, s.rollId) ?? linked);
    if (s.shapedAt === null) return this.finishShaping(s, roll); // undefined = a row from before: shaped
    await this.shapeRep(s, roll, false);
    return s;
  }
  private async finishShaping(s: Sitting, roll: Roll): Promise<Sitting> {
    await this.shapeRep(s, roll, true);
    const cur = this.mustFind(this.store.sittings, s.id);
    return cur.shapedAt === null
      ? this.writes.patch(this.store.sittings, s.id, { shapedAt: this.now() })
      : cur;
  }
  // Mirrors the backend's shapeRep: from the stored sitting; only a new sitting (or a rep just made) titles,
  // notes and plans it (no plan for a timed rep); a resume only starts it.
  private async shapeRep(s: Sitting, roll: Roll, isNew: boolean): Promise<void> {
    const title = sittingRepTitle(s.problemTitle);
    const url = sittingProblemUrl(s.problemSlug);
    let rep = this.find(this.store.tasks, s.repTaskId);
    const made = !rep;
    if (!rep)
      rep = this.writes.insert(this.store.tasks, {
        ...this.base(),
        ...rollRepFields(roll),
        id: s.repTaskId,
        title,
        notes: url,
      });
    if (rep.status === 'done' || rep.status === 'cancelled') return;
    if (isNew || made) {
      if (rep.title !== title) rep = await this.setTaskTitle(rep.id, title);
      if (!rep.notes) rep = this.writes.patch(this.store.tasks, rep.id, { notes: url });
      const dayPlans = this.alive(this.store.plans).filter((p) => p.day === s.day);
      const repId = rep.id;
      if (!isTimed(rep) && !dayPlans.some((p) => p.taskId === repId))
        this.writes.insert(this.store.plans, {
          ...this.base(),
          id: s.id,
          taskId: repId,
          day: s.day,
          plannedMinutes: roll.estimateMin ?? ROLL_PLAN_FALLBACK_MIN,
          order: dayPlans.length,
        });
    }
    if (rep.status !== 'in_progress') await this.transitionTask(rep.id, 'in_progress');
  }
  private keepProblem(n: NormalizedSittingStart, upsert: boolean): void {
    if (n.problem === null) return;
    const had = this.alive(this.store.leetcodeProblems).find((x) => x.slug === n.problemSlug);
    if (had && !upsert) return;
    this.upsertProblem(n);
  }
  private upsertProblem(n: NormalizedSittingStart): void {
    const fields = {
      slug: n.problemSlug,
      questionId: n.questionId,
      frontendId: n.frontendId,
      title: n.problemTitle,
      difficulty: n.difficulty,
      topicTags: n.topicTags,
      raw: n.problem,
    };
    const had = this.alive(this.store.leetcodeProblems).find((x) => x.slug === n.problemSlug);
    if (had)
      this.writes.put(this.store.leetcodeProblems, { ...had, ...fields, updatedAt: this.now() });
    else this.writes.insert(this.store.leetcodeProblems, { ...this.base(), ...fields });
  }
  private sittingLiveOf(id: string): SittingLive | null {
    return this.store.sittingLive.find((l) => l.id === id && l.deletedAt === null) ?? null;
  }
  async lcSittingEvents(input: SittingEventsInput): Promise<SittingEventsResult> {
    const { sittingId, events: all } = normalizeSittingEvents(input);
    const sitting = this.mustFind(this.store.sittings, sittingId);
    const now = this.now();
    const err = sittingIngestError(sitting, all, now);
    if (err) throw new Error(err);
    // Inside an ended sitting's grace only the events stamped before its end are kept; none kept writes nothing.
    const events = eventsBeforeEnd(sitting, all);
    const skipped = all.length - events.length;
    if (!events.length)
      return {
        accepted: 0,
        duplicates: 0,
        skipped,
        version: this.sittingLiveOf(sittingId)?.version ?? 0,
        status: sitting.status,
      };
    // The budget reserves every kept event, repeats included (backend parity), before anything is written.
    const bytes = events.reduce((n, e) => n + e.bytes, 0);
    const had = this.store.sittingBudgets.find((x) => x.id === sittingId);
    const budget = reserveBudget(
      had ?? { ...this.base(), id: sittingId, sittingId, events: 0, bytes: 0 },
      {
        count: events.length,
        bytes,
      },
    );
    this.writes.put(this.store.sittingBudgets, { ...budget, updatedAt: now });
    // Freshness per kind, as the backend's keys: head rows, raw bulk, replay.
    const mine = <T extends { sittingId: string; id: string }>(rows: T[]) =>
      new Set(rows.filter((x) => x.sittingId === sittingId).map((x) => x.id));
    const heads = mine(this.store.sittingHeadRows);
    const bulkIds = mine(this.store.sittingEvents.filter((x) => !isHeadEvent(x.type)));
    const replays = mine(this.store.sittingReplay);
    const fresh = events.filter((e) =>
      e.type === 'replay'
        ? !replays.has(e.id)
        : isHeadEvent(e.type)
          ? !heads.has(e.id)
          : !bulkIds.has(e.id),
    );
    const freshIds = new Set(fresh.map((e) => e.id));
    const row = (e: { id: string; at: number }) => ({
      ...this.base(),
      id: e.id,
      sittingId,
      at: e.at,
      receivedAt: now,
    });
    this.writes.insertMany(
      this.store.sittingReplay,
      fresh.flatMap((e) =>
        e.type === 'replay'
          ? [{ ...row(e), clientSessionId: e.clientSessionId, events: e.events }]
          : [],
      ),
    );
    const stored = fresh.flatMap((e) =>
      e.type === 'replay' ? [] : [{ ...row(e), type: e.type, payload: e.payload }],
    );
    // A timer read is only its head row (backend parity); runs, submits and notes keep their payloads too.
    this.writes.insertMany(
      this.store.sittingEvents,
      stored.filter((e) => e.type !== 'timer'),
    );
    this.writes.insertMany(
      this.store.sittingHeadRows,
      stored.flatMap((e) =>
        e.type === 'run' || e.type === 'submit' || e.type === 'note' || e.type === 'timer'
          ? [
              {
                ...row(e),
                ...headRowOf(sittingId, { id: e.id, type: e.type, at: e.at, payload: e.payload }),
              },
            ]
          : [],
      ),
    );
    if (events.some((e) => isHeadEvent(e.type))) this.refoldHead(sittingId);
    const bulk = events.filter((e) => !isHeadEvent(e.type));
    let live = this.sittingLiveOf(sittingId);
    if (bulk.length) {
      const base: SittingLive = live ?? {
        ...this.base(),
        id: sittingId,
        ...emptyLiveFields(sittingId),
      };
      live = this.writes.put(this.store.sittingLive, {
        ...bulk.reduce((l, e) => foldLive(l, e, now, freshIds.has(e.id)), base),
        updatedAt: now,
      });
    }
    return {
      accepted: fresh.length,
      duplicates: events.length - fresh.length,
      skipped,
      version: live?.version ?? 0,
      status: this.mustFind(this.store.sittings, sittingId).status,
    };
  }
  private refoldHead(id: string): void {
    const summary = summarizeHeadRows(
      this.alive(this.store.sittingHeadRows).filter((x) => x.sittingId === id),
    );
    const cur = this.mustFind(this.store.sittings, id);
    if (newerSummary(cur.summary, summary)) this.writes.patch(this.store.sittings, id, { summary });
  }
  async listSittings(range?: DateRange): Promise<Sitting[]> {
    return this.alive(this.store.sittings)
      .filter((x) => !range || (x.day >= range.from && x.day <= range.to))
      .sort((a, b) => b.startedAt - a.startedAt);
  }
  async getSitting(id: string): Promise<SittingDetail> {
    const sitting = this.mustFind(this.store.sittings, id);
    return {
      sitting,
      live: this.sittingLiveOf(id),
      events: this.alive(this.store.sittingEvents)
        .filter((e) => e.sittingId === id)
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)),
      problem:
        this.alive(this.store.leetcodeProblems).find((x) => x.slug === sitting.problemSlug) ?? null,
      liveReads: this.sittingReadsOf(id),
    };
  }
  private sittingReadsOf(id: string): number {
    return this.find(this.store.sittingReads, id)?.count ?? 0;
  }
  // Backend parity (pullLiveSitting): the gate's open sitting, counted only while it's open.
  async pullLiveSitting(): Promise<LiveSittingPull> {
    const now = this.now();
    const id = this.store.lcStartGate?.openSittingId ?? null;
    const head = id ? this.find(this.store.sittings, id) : undefined;
    if (head && isSittingOpen(head, now)) {
      const had = this.find(this.store.sittingReads, head.id);
      const liveReads = (had?.count ?? 0) + 1;
      this.writes.put(this.store.sittingReads, {
        ...(had ?? { ...this.baseAt(now), sittingId: head.id }),
        id: head.id,
        count: liveReads,
        updatedAt: now,
      });
      const judged = this.alive(this.store.sittingEvents).filter((e) => e.sittingId === head.id);
      return {
        sitting: head,
        live: this.sittingLiveOf(head.id),
        lastRun: newestOfType(judged, 'run'),
        lastSubmit: newestOfType(judged, 'submit'),
        liveReads,
        lastSitting: null,
      };
    }
    const last = (await this.listSittings())[0] ?? null;
    return {
      sitting: null,
      live: null,
      lastRun: null,
      lastSubmit: null,
      liveReads: last ? this.sittingReadsOf(last.id) : 0,
      lastSitting: last,
    };
  }
  async listSittingReplay(id: string): Promise<SittingReplayChunk[]> {
    this.mustFind(this.store.sittings, id);
    return this.alive(this.store.sittingReplay)
      .filter((c) => c.sittingId === id)
      .sort((a, b) => a.at - b.at);
  }
  async setSittingPrepTarget(id: string, prepTarget: string): Promise<Sitting> {
    const tag = normalizePrepTarget(prepTarget);
    return this.writes.patch(this.store.sittings, id, { prepTarget: tag });
  }
  async setSittingReview(id: string, review: SittingReviewInput): Promise<Sitting> {
    const r = normalizeSittingReview(review); // validates first, as the Lambda does
    this.mustFind(this.store.sittings, id);
    return this.writes.patch(this.store.sittings, id, {
      review: r && { ...r, updatedAt: this.now() },
    });
  }
  // Deterministic stand-in for the Haiku draft (same shape and rules, no model): one line per judged Run or
  // Submit that wasn't accepted, naming its failing case or error head.
  async draftSittingReview(id: string): Promise<ReviewDraft> {
    const { sitting, events } = await this.getSitting(id);
    const judged = timelineOf(sitting, events).flatMap((x) => (x.kind === 'judged' ? [x] : []));
    if (!judged.length) return { ok: false, reason: 'nothing-to-draft' };
    const lines = judged
      .filter((x) => x.verdict.verdict !== 'accepted')
      .map((x) => {
        const what = `${x.type === 'run' ? 'Run' : 'Submit'} ${x.n} (${x.verdict.statusMsg ?? x.verdict.verdict})`;
        const d = x.detail;
        // Only the halves captured: never "expected null".
        const got = [
          d.expected !== null ? `expected ${d.expected}` : null,
          d.output !== null ? `got ${d.output}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        const why =
          d.error ??
          (d.input && got ? `${d.input} → ${got}` : d.input || got || 'no case captured');
        return `${what}: ${why}`;
      });
    return { ok: true, mistakes: draftMistakes(lines) ?? [] }; // the backend's own fit: cut to 160, first 5
  }
  async deleteSitting(id: string): Promise<void> {
    if (!this.find(this.store.sittings, id)) return;
    for (const coll of [this.store.sittingEvents, this.store.sittingReplay] as const)
      for (const row of this.alive<SittingEvent | SittingReplayChunk>(coll).filter(
        (r) => r.sittingId === id,
      ))
        this.writes.softDelete(coll as (SittingEvent | SittingReplayChunk)[], row.id);
    for (const r of this.alive(this.store.sittingHeadRows).filter((r) => r.sittingId === id))
      this.writes.softDelete(this.store.sittingHeadRows, r.id);
    this.writes.softDelete(this.store.sittingLive, id);
    this.writes.softDelete(this.store.sittingReads, id);
    this.releaseStartGate(id);
    const { problemSlug } = this.mustFind(this.store.sittings, id);
    this.writes.softDelete(this.store.sittings, id);
    const problem = this.alive(this.store.leetcodeProblems).find((x) => x.slug === problemSlug);
    if (problem && !this.alive(this.store.sittings).some((x) => x.problemSlug === problemSlug))
      this.writes.softDelete(this.store.leetcodeProblems, problem.id);
  }
  // A rep's finish ends its open sitting (Done → done, else abandoned); its delete removes it.
  private endSittingsFor(task: Task, to: TaskStatus): void {
    if (!task.rollId || (to !== 'done' && to !== 'cancelled')) return;
    for (const x of this.alive(this.store.sittings))
      if (x.repTaskId === task.id && x.status === 'active')
        this.endSitting(x.id, to === 'done' ? 'done' : 'abandoned');
  }
  private endSitting(id: string, to: 'done' | 'abandoned', at = this.now()): void {
    this.refoldHead(id);
    const x = this.mustFind(this.store.sittings, id);
    if (x.status === 'active') this.writes.put(this.store.sittings, endedSitting(x, to, at));
    this.releaseStartGate(id);
  }
  private releaseStartGate(id: string): void {
    const g = this.store.lcStartGate;
    const next = g && releaseStart(g, id);
    if (next) this.store.lcStartGate = { ...next, updatedAt: this.now() };
  }

  // --- Flux sets -------------------------------------------------------------
  async recordFluxSet(input: RecordFluxSetInput): Promise<FluxSet> {
    if (stubFluxSaveFails()) throw new Error('Network unavailable (stub)');
    const err = fluxSetError(input);
    if (err) throw new Error(err);
    // Idempotent on the client's id (D47) — an outbox retry gets the stored row back, unchanged.
    const dup = this.store.fluxSets.find((f) => f.id === input.id);
    if (dup) return dup;
    const t = this.now();
    return this.writes.insert(this.store.fluxSets, {
      id: input.id,
      userId: USER_ID,
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
    });
  }
  async listFluxSets(filter?: FluxSetFilter): Promise<FluxSet[]> {
    const err = fluxFilterError(filter);
    if (err) throw new Error(err);
    return inRange(this.store.fluxSets, filter);
  }
  async deleteFluxSet(id: string): Promise<void> {
    // Like the backend: deleting a deleted set changes nothing (its deletedAt stays the first one).
    if (this.store.fluxSets.some((f) => f.id === id && f.deletedAt === null))
      this.writes.softDelete(this.store.fluxSets, id);
  }

  // The weekly note (D62): the deterministic line, cached by fingerprint like the Lambda's — the stub has
  // no model, so the line is the note. Null under two sets this week.
  async getFluxWeekNote(): Promise<FluxWeekNote | null> {
    const today = todayKey(this.dayStartHour(), this.now());
    const weekStart = fluxWeekStart(today);
    const sets = inRange(this.store.fluxSets);
    const summary = fluxWeekSummary(sets, weekStart);
    if (summary.totalSets < FLUX_NOTE_MIN_SETS) return null;
    const week = fluxWeekSets(sets, weekStart);
    const fingerprint = fluxNoteFingerprint(week);
    const stored = this.store.fluxNotes.find((x) => x.weekStart === weekStart);
    if (stored && stored.fingerprint === fingerprint) return fluxNoteOf(stored);
    const row: FluxWeekNoteRow = {
      weekStart,
      text: fluxWeekLine(summary),
      generatedAt: this.now(),
      fingerprint,
    };
    this.store.fluxNotes = [...this.store.fluxNotes.filter((x) => x.weekStart !== weekStart), row];
    this.persist();
    return fluxNoteOf(row);
  }

  // --- Story bank ----------------------------------------------------------
  async listStories(): Promise<Story[]> {
    return this.alive(this.store.stories).sort(
      (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
    );
  }
  async createStory(input: CreateStoryInput): Promise<Story> {
    return this.writes.insert(this.store.stories, {
      ...this.base(),
      title: input.title,
      competencyTags: input.competencyTags ?? [],
      situation: input.situation ?? '',
      action: input.action ?? '',
      result: input.result ?? '',
    });
  }
  async updateStory(id: string, patch: StoryPatch): Promise<Story> {
    const keyErr = patchKeyError('story', patch, STORY_PATCH_KEYS); // as the BFF: before any lookup
    if (keyErr) throw new Error(keyErr);
    return this.writes.patch(this.store.stories, id, patch); // patch throws on a tombstone
  }
  async deleteStory(id: string): Promise<void> {
    this.writes.softDelete(this.store.stories, id);
  }

  // --- Task attachments ----------------------------------------------------
  // The stub never handles bytes itself: uploadUrl/downloadUrl are `stub:<id>` sentinels the transport
  // module resolves against an in-memory Blob map, and a delete drops the blob (the backend's S3 delete).
  // Everything else — caps, pending→ready, tombstones — mirrors the backend exactly so the page-first
  // build validates the real behavior.
  async createAttachmentUploadUrl(
    input: CreateAttachmentInput,
  ): Promise<{ attachment: Attachment; uploadUrl: string }> {
    this.mustFind(this.store.tasks, input.taskId); // task must exist under this user
    const now = this.now();
    const liveCount = this.store.attachments.filter(
      (a) => a.taskId === input.taskId && countsTowardCap(a, now),
    ).length;
    assertAttachmentAllowed(input.size, liveCount);
    const b = this.base();
    const attachment = this.writes.insert(this.store.attachments, {
      ...b,
      taskId: input.taskId,
      filename: sanitizeFilename(input.filename),
      contentType: normalizeContentType(input.contentType),
      size: input.size,
      s3Key: `u/${USER_ID}/${input.taskId}/${b.id}`,
      status: 'pending' as const,
    });
    return { attachment, uploadUrl: `stub:${attachment.id}` };
  }
  async confirmAttachment(id: string): Promise<Attachment> {
    const existing = this.mustFind(this.store.attachments, id); // throws on missing/tombstoned
    if (existing.status === 'ready') return existing; // idempotent
    // Past the upload TTL the row has been discounted from the cap; confirming would bypass it (see backend).
    if (this.now() - existing.createdAt >= UPLOAD_URL_TTL_MS)
      throw new Error('Upload window expired; start the upload again.');
    return this.writes.patch(this.store.attachments, id, { status: 'ready' });
  }
  async listAttachments(taskId?: string): Promise<Attachment[]> {
    return this.alive(this.store.attachments)
      .filter((a) => a.status === 'ready' && (taskId === undefined || a.taskId === taskId))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async getAttachmentDownloadUrl(id: string): Promise<string> {
    this.mustFind(this.store.attachments, id); // throws on missing/tombstoned
    return `stub:${id}`;
  }
  async deleteAttachment(id: string): Promise<void> {
    if (!this.find(this.store.attachments, id)) return;
    forgetStubBlob(id);
    this.writes.softDelete(this.store.attachments, id);
  }

  // --- Tasks ---------------------------------------------------------------
  async listBacklog(): Promise<Task[]> {
    return this.alive(this.store.tasks)
      .filter((t) => t.status === 'backlog')
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async listTasks(): Promise<Task[]> {
    return this.alive(this.store.tasks).sort((a, b) => b.createdAt - a.createdAt);
  }
  async getTask(id: string): Promise<Task | null> {
    return this.find(this.store.tasks, id) ?? null;
  }
  async createTask(input: CreateTaskInput): Promise<Task> {
    return (await this.createTasks([input]))[0]!;
  }
  async createTasks(inputs: CreateTaskInput[]): Promise<Task[]> {
    const t = this.now();
    const tasks = inputs.map((input) => this.newTask(input, t)); // normalizes all first: one bad input writes nothing
    const all = this.alive(this.store.tasks);
    for (const task of tasks)
      if (task.parentId) assertCanBePart(null, this.mustFind(this.store.tasks, task.parentId), all);
    // A planned task taking its first part hands its spot on the plan to that part (the batch's first) —
    // an untimed one: a timed part is on its own day by its time (option 3).
    const landing = new Map<string, TaskPlan>(); // part id → the parent's row it takes over
    for (const task of tasks) {
      const parent = task.parentId ? this.mustFind(this.store.tasks, task.parentId) : null;
      if (!parent || parent.status !== 'planned' || hasParts(all, parent.id)) continue;
      if (tasks.find((t) => t.parentId === parent.id) !== task) continue;
      const day = followUpPlanDay(this.alive(this.store.plans), parent.id);
      const row = this.alive(this.store.plans).find((p) => p.taskId === parent.id && p.day === day);
      if (row && !task.dueTime) landing.set(task.id, row);
    }
    const out: Task[] = [];
    for (const task of tasks) {
      const row = landing.get(task.id);
      const part = this.writes.insert(
        this.store.tasks,
        row ? { ...task, status: 'planned' } : task,
      );
      const parent = task.parentId ? this.mustFind(this.store.tasks, task.parentId) : null;
      if (
        parent &&
        !hasParts(all, parent.id) &&
        tasks.find((t) => t.parentId === parent.id) === task
      )
        this.adoptAsParent(parent);
      if (row)
        this.writes.insert(this.store.plans, {
          ...this.base(),
          taskId: part.id,
          day: row.day,
          plannedMinutes: followUpPlanMinutes(part.estimateMin, part.bufferMin),
          order: row.order,
        });
      out.push(this.syncCalendar(null, part));
    }
    return out;
  }
  async setTaskParent(id: string, parentId: string | null): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
    if (parentId === null) {
      if (!task.parentId) return task; // not a part: nothing to detach (a parent keeps its marker)
      const part = this.writes.patch(this.store.tasks, id, { parentId: null });
      this.releaseParentState(task.parentId);
      return this.syncCalendar(task, part, false, { parent: false }); // its block loses the prefix
    }
    const parent = this.mustFind(this.store.tasks, parentId);
    const all = this.alive(this.store.tasks);
    assertCanBePart(task, parent, all);
    const first = !hasParts(all, parent.id);
    // An open part takes its parent's place; a finished one's is history. A detach (above) keeps it.
    const place = isFinished(task) ? task.place : parent.place;
    const part = this.writes.patch(this.store.tasks, id, { parentId, place });
    if (first) this.adoptAsParent(parent);
    if (task.parentId === parentId) return part; // already its part: nothing moved, nothing starts
    this.releaseParentState(task.parentId); // moved from another parent
    this.freezeLock(parentId, id); // attaching a started task can be its parent's first start
    // Its block is named after its new parent (a part has no parts of its own).
    return this.syncCalendar(task, part, false, { parent: false });
  }
  // Quick add, offline: the same flow as the Lambda (shared runQuickParse) with a heuristic standing in
  // for Haiku. STUB_FAIL_NEXT_PARSE_KEY (stubParse.ts) fails the next one, to see the raw-save path.
  async parseTask(text: string): Promise<ParseTaskResult> {
    if (typeof text !== 'string') throw new Error('text must be a string');
    const categories = this.alive(this.store.categories)
      .filter((c) => c.active)
      .map(({ id, label }) => ({ id, label }));
    const places = this.alive(this.store.places).map(({ slug, name }) => ({ slug, name }));
    const today = todayKey(this.dayStartHour(), this.now());
    const ctx = { categories, places, today, dayStartHour: this.dayStartHour() };
    return runQuickParse(text, ctx, async (line) =>
      takeStubParseFailure()
        ? { ok: false, reason: 'unavailable', detail: 'stub failNextParse' }
        : { ok: true, fields: heuristicParse(line, categories, today) },
    );
  }
  async setTaskEstimate(
    id: string,
    estimateMin: number | null,
    bufferMin: number | null,
  ): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
    if (hasParts(this.alive(this.store.tasks), id)) throw new Error(PARENT_NO_ESTIMATE_ERROR);
    const next = this.writes.put(
      this.store.tasks,
      withEstimate(task, estimateMin, bufferMin, this.now()),
    );
    return this.syncCalendar(task, next);
  }
  async setTaskCategory(id: string, categoryId: string | null): Promise<Task> {
    return this.writes.patch(this.store.tasks, id, { categoryId });
  }
  async setTaskDueDay(id: string, dueDay: string | null): Promise<Task> {
    return this.setTaskDue(id, { dueDay });
  }
  async setTaskDue(id: string, due: SetTaskDueInput): Promise<Task> {
    const prev = this.mustFind(this.store.tasks, id);
    const fields = normalizeDue(due.dueDay, due.dueTime, prev.dueTime); // throws before any write
    return this.syncCalendar(prev, this.writes.patch(this.store.tasks, id, fields));
  }
  async setTaskTitle(id: string, title: string): Promise<Task> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('Title is required');
    const prev = this.mustFind(this.store.tasks, id);
    const next = this.syncCalendar(
      prev,
      this.writes.patch(this.store.tasks, id, { title: trimmed }),
    );
    // A parent's name is in each of its parts' blocks: each linked open one is re-sent.
    for (const part of partsOf(this.alive(this.store.tasks), id))
      if (part.gcalEventId && part.status !== 'done' && part.status !== 'cancelled')
        this.syncCalendar(part, part);
    return this.find(this.store.tasks, id) ?? next;
  }
  async setTaskNotes(id: string, notes: string | null): Promise<Task> {
    return this.writes.patch(this.store.tasks, id, { notes: setNotesArg(notes) });
  }
  async setTaskReflection(id: string, reflection: string | null): Promise<Task> {
    return this.writes.patch(this.store.tasks, id, { reflection: setReflectionArg(reflection) });
  }
  async transitionTask(id: string, to: TaskStatus): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
    const parts = partsOf(this.alive(this.store.tasks), id);
    if (parts.length) return this.transitionParent(task, parts, to);
    const next = await this.transitionOne(task, to);
    this.endSittingsFor(task, to);
    // Its FIRST start only: a rolled-back part starting again isn't the parent's first start.
    const firstStart =
      task.startedAt === null &&
      (task.status === 'backlog' || task.status === 'planned') &&
      (to === 'in_progress' || to === 'done');
    if (!firstStart) return next;
    this.freezeLock(task.parentId, id);
    return this.find(this.store.tasks, id) ?? next;
  }
  // A parent is never worked on itself: it's marked done once its parts are dealt with (a hard block
  // otherwise; its due marker stays, as a done task's block does), and dropping it drops its open parts
  // first — each through the normal cancel path, so their calendar blocks go — then its marker.
  private async transitionParent(task: Task, parts: Task[], to: TaskStatus): Promise<Task> {
    if (to === 'done')
      return this.writes.put(this.store.tasks, completeParent(task, parts, this.now()));
    if (to === 'cancelled') {
      const { parent, parts: dropped } = cancelParent(task, parts, this.now());
      for (const p of dropped) await this.transitionOne(this.mustFind(this.store.tasks, p.id), to);
      this.writes.put(this.store.tasks, parent);
      return task.gcalEventId
        ? this.deleteCalendarEvent(task.id)
        : this.mustFind(this.store.tasks, task.id);
    }
    throw new Error(to === 'in_progress' ? PARENT_NO_START_ERROR : PARENT_NO_PLAN_ERROR);
  }
  private async transitionOne(task: Task, to: TaskStatus): Promise<Task> {
    const id = task.id;
    // Parity with the backend: a finish drops a failure note, but carries out an owed removal.
    const finished = to === 'done' || to === 'cancelled';
    const owed = task.gcalEventId && isPendingRemoval(task.gcalSyncError);
    const next = this.writes.put(this.store.tasks, {
      ...taskTransition(task, to, this.now()),
      ...(finished && task.gcalSyncError && !owed ? { gcalSyncError: null } : {}),
    });
    if (finished && owed) return this.syncCalendar(task, next);
    // Delete-on-cancel parity with the backend: dropping a task clears its calendar event pointers.
    if (to === 'cancelled' && task.gcalEventId) return this.deleteCalendarEvent(id);
    return next;
  }
  async setTaskActual(id: string, actualMin: number, reflection?: string | null): Promise<Task> {
    // Normalized before anything is read or written: an over-cap reflection lands nothing.
    const note = reflection === undefined ? {} : { reflection: normalizeReflection(reflection) };
    if (hasParts(this.alive(this.store.tasks), id)) throw new Error(PARENT_NO_ACTUAL_ERROR);
    assertActualAllowed(this.mustFind(this.store.tasks, id), actualMin);
    return this.writes.patch(this.store.tasks, id, { actualAccruedMin: actualMin, ...note });
  }
  async splitTask(
    id: string,
    input: SplitTaskInput,
  ): Promise<{ parent: Task; original: Task; followUp: Task }> {
    const task = this.mustFind(this.store.tasks, id);
    if (hasParts(this.alive(this.store.tasks), id)) throw new Error(PARENT_NO_SPLIT_ERROR);
    const standalone = !task.parentId;
    const shaped = splitOriginal(task, input, this.now(), standalone); // validates everything before any write
    // Split always yields parent + parts: a standalone task gets a new parent (its due marker is synced
    // last, once it has parts), a part splits under the parent it has.
    const parentId = standalone
      ? this.writes.insert(this.store.tasks, { ...this.base(), ...newParentFrom(task, input) }).id
      : task.parentId!;
    const edited = { ...shaped, parentId };
    const done = input.finish === 'done';
    // Parity with the backend: a done TIMED part hands its event to the follow-up; kept going, each part
    // owns its own block; any other linked event (a manual one on an untimed original) stays on it.
    const moveLink = done && !!task.dueDay && !!task.dueTime && !!task.gcalEventId;
    let original: Task;
    if (done) {
      const owed = !moveLink && !!task.gcalEventId && isPendingRemoval(task.gcalSyncError);
      original = this.writes.put(this.store.tasks, {
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
      if (!moveLink) original = this.syncCalendar(task, original);
    } else {
      original = this.syncCalendar(task, this.writes.put(this.store.tasks, edited));
    }
    // A timed original's follow-up isn't planned: it's on its day by its time (option 3).
    const day =
      !task.dueTime && (task.status === 'planned' || task.status === 'in_progress')
        ? followUpPlanDay(this.alive(this.store.plans), id)
        : null;
    const fields = splitFollowUp(task, input.followUp, day !== null, parentId);
    const created = this.writes.insert(this.store.tasks, {
      ...this.base(),
      ...fields,
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
      const dayPlans = this.alive(this.store.plans).filter((p) => p.day === day);
      const own = dayPlans.find((p) => p.taskId === id);
      const resized = rescopedPlanMinutes(input, original);
      if (own && resized !== null && resized !== own.plannedMinutes)
        this.writes.patch(this.store.plans, own.id, { plannedMinutes: resized });
      this.writes.insert(this.store.plans, {
        ...this.base(),
        taskId: created.id,
        day,
        plannedMinutes: followUpPlanMinutes(fields.estimateMin, fields.bufferMin),
        order: dayPlans.length,
      });
    }
    // No freeze here: a standalone split's parent IS the original's lock, and nothing started just now.
    const followUp = this.syncCalendar(null, created);
    const parent = standalone
      ? this.syncCalendar(null, this.mustFind(this.store.tasks, parentId), false, { parent: true })
      : this.mustFind(this.store.tasks, parentId);
    return { parent, original, followUp };
  }
  async deleteTask(id: string): Promise<void> {
    return this.deleteOne(id, true);
  }
  // `release`: a part's parent is left plain if this was its last part — not when the parent is going
  // too (its marker is deleted with it, not first turned back into a block).
  private async deleteOne(id: string, release: boolean): Promise<void> {
    const task = this.find(this.store.tasks, id);
    if (!task) return; // idempotent — already gone or never existed
    // A parent goes with every part — each through this same path (event, plans, attachments), first.
    for (const part of partsOf(this.alive(this.store.tasks), id))
      await this.deleteOne(part.id, false);
    // Calendar event before the tombstone: deleteCalendarEvent uses mustFind and clears the pointers.
    // (The backend deletes the files' bytes before all of this, because S3 can fail; a blob drop can't.)
    if (task.gcalEventId) await this.deleteCalendarEvent(id);
    for (const p of this.alive(this.store.plans).filter((p) => p.taskId === id))
      this.writes.softDelete(this.store.plans, p.id);
    for (const a of this.alive(this.store.attachments).filter((a) => a.taskId === id)) {
      forgetStubBlob(a.id);
      this.writes.softDelete(this.store.attachments, a.id);
    }
    if (task.rollId)
      for (const x of this.alive(this.store.sittings).filter((x) => x.repTaskId === id))
        await this.deleteSitting(x.id);
    this.writes.softDelete(this.store.tasks, id); // task last
    if (release) this.releaseParentState(task.parentId);
  }

  // --- Plans ---------------------------------------------------------------
  async listPlansForDay(day: string): Promise<TaskPlan[]> {
    return this.alive(this.store.plans)
      .filter((p) => p.day === day)
      .sort((a, b) => a.order - b.order);
  }
  async upsertPlan(input: UpsertPlanInput): Promise<TaskPlan> {
    if (hasParts(this.alive(this.store.tasks), input.taskId)) throw new Error(PARENT_NO_PLAN_ERROR);
    const task = this.find(this.store.tasks, input.taskId);
    if (task && isTimed(task)) throw new Error(TIMED_NO_PLAN_ERROR);
    if (input.id) {
      return this.writes.patch(this.store.plans, input.id, {
        taskId: input.taskId,
        day: input.day,
        plannedMinutes: input.plannedMinutes,
        order: input.order,
      });
    }
    // One alive row per (task, day) — an id-less insert for a task already on that day returns it.
    const dup = this.alive(this.store.plans).find(
      (p) => p.taskId === input.taskId && p.day === input.day,
    );
    if (dup) return dup;
    return this.writes.insert(this.store.plans, {
      ...this.base(),
      taskId: input.taskId,
      day: input.day,
      plannedMinutes: input.plannedMinutes,
      order: input.order,
    });
  }
  async removePlan(id: string): Promise<void> {
    this.writes.softDelete(this.store.plans, id);
  }

  // --- Series --------------------------------------------------------------
  async listSeries(): Promise<TaskSeries[]> {
    return this.alive(this.store.series);
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
    if (input.id) return this.writes.patch(this.store.series, input.id, fields);
    return this.writes.insert(this.store.series, { ...this.base(), ...fields });
  }
  async deactivateSeries(id: string): Promise<TaskSeries> {
    return this.writes.patch(this.store.series, id, { active: false });
  }
  async deleteSeries(id: string): Promise<void> {
    if (this.find(this.store.series, id)) this.writes.softDelete(this.store.series, id);
  }

  // --- Sessions ------------------------------------------------------------
  async startSession(input: StartSessionInput): Promise<PomodoroSession> {
    const t = this.now();
    // Multiple timers can run at once (parallel focus), but a given task gets at most one live
    // work block — re-focusing an already-running task returns the existing timer, not a duplicate.
    if (input.taskId && input.kind === 'work') {
      const existing = this.alive(this.store.sessions).find(
        (s) => s.status === 'running' && s.kind === 'work' && s.taskId === input.taskId,
      );
      if (existing) return existing;
    }
    const categoryId =
      input.categoryId ??
      (input.taskId ? (this.find(this.store.tasks, input.taskId)?.categoryId ?? null) : null);
    const wasWork = categoryId
      ? (this.find(this.store.categories, categoryId)?.isWork ?? false)
      : false;
    return this.writes.insert(this.store.sessions, {
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
  async heartbeatSession(id: string): Promise<PomodoroSession> {
    const session = this.mustFind(this.store.sessions, id);
    return this.writes.put(this.store.sessions, heartbeatSession(session, this.now()));
  }
  async resumeSession(id: string): Promise<PomodoroSession> {
    const session = this.mustFind(this.store.sessions, id);
    return this.writes.put(this.store.sessions, resumeSession(session, this.now()));
  }
  async extendSession(id: string, opts?: { capMin?: number }): Promise<PomodoroSession> {
    const session = this.mustFind(this.store.sessions, id);
    return this.writes.put(this.store.sessions, extendSession(session, this.now(), opts?.capMin));
  }
  async stopSession(
    id: string,
    status: 'completed' | 'discarded',
    opts?: { capMin?: number },
  ): Promise<PomodoroSession> {
    const session = this.mustFind(this.store.sessions, id);
    const next =
      status === 'completed'
        ? completeSession(session, this.now(), opts?.capMin)
        : discardSession(session, this.now());
    this.writes.put(this.store.sessions, next);
    if (status === 'completed') this.accrueToTask(next);
    return next;
  }
  async listSessionsForDay(day: string): Promise<PomodoroSession[]> {
    return this.alive(this.store.sessions).filter((s) => s.day === day);
  }
  async findRunningSession(): Promise<PomodoroSession | null> {
    return this.alive(this.store.sessions).find((s) => s.status === 'running') ?? null;
  }
  async listRunningSessions(): Promise<PomodoroSession[]> {
    return this.alive(this.store.sessions).filter((s) => s.status === 'running');
  }
  async resolveStaleSession(id: string, decision: 'keep' | 'discard'): Promise<PomodoroSession> {
    const session = this.mustFind(this.store.sessions, id);
    const next = resolveStaleSession(session, decision, this.now());
    this.writes.put(this.store.sessions, next);
    if (decision === 'keep') this.accrueToTask(next);
    return next;
  }
  // Denormalized accrual: only work sessions bump the task's actual, once, at close.
  private accrueToTask(session: PomodoroSession): void {
    if (session.kind !== 'work' || !session.taskId) return;
    const task = this.find(this.store.tasks, session.taskId);
    if (!task || !accruesTime(task)) return; // finished meanwhile: the session keeps its minutes, the task doesn't
    this.writes.put(this.store.tasks, {
      ...task,
      actualAccruedMin: task.actualAccruedMin + session.activeMinutes,
      updatedAt: this.now(),
    });
  }

  // --- Habits --------------------------------------------------------------
  async listHabits(): Promise<Habit[]> {
    return this.alive(this.store.habits).sort((a, b) => a.createdAt - b.createdAt);
  }
  async upsertHabit(input: UpsertHabitInput): Promise<Habit> {
    if (input.id) {
      return this.writes.patch(this.store.habits, input.id, {
        name: input.name,
        categoryId: input.categoryId,
        cadencePerWeek: input.cadencePerWeek,
        active: input.active ?? true,
      });
    }
    return this.writes.insert(this.store.habits, {
      ...this.base(),
      name: input.name,
      categoryId: input.categoryId,
      cadencePerWeek: input.cadencePerWeek,
      active: input.active ?? true,
    });
  }
  async checkHabit(habitId: string, date: string): Promise<HabitCheck> {
    const existing = this.alive(this.store.habitChecks).find(
      (c) => c.habitId === habitId && c.date === date,
    );
    if (existing) return existing;
    return this.writes.insert(this.store.habitChecks, { ...this.base(), habitId, date });
  }
  async uncheckHabit(habitId: string, date: string): Promise<void> {
    const existing = this.alive(this.store.habitChecks).find(
      (c) => c.habitId === habitId && c.date === date,
    );
    if (existing) this.writes.softDelete(this.store.habitChecks, existing.id);
  }
  async listHabitChecks(range: DateRange): Promise<HabitCheck[]> {
    return this.alive(this.store.habitChecks).filter(
      (c) => c.date >= range.from && c.date <= range.to,
    );
  }

  // --- Rolls ---------------------------------------------------------------
  async listRolls(): Promise<Roll[]> {
    return this.alive(this.store.rolls).sort((a, b) => a.createdAt - b.createdAt);
  }
  async upsertRoll(input: UpsertRollInput): Promise<Roll> {
    if (input.id) {
      return this.writes.patch(this.store.rolls, input.id, {
        name: input.name,
        categoryId: input.categoryId,
        estimateMin: input.estimateMin,
        active: input.active ?? true,
      });
    }
    return this.writes.insert(this.store.rolls, {
      ...this.base(),
      name: input.name,
      categoryId: input.categoryId,
      estimateMin: input.estimateMin,
      active: input.active ?? true,
    });
  }
  // Pick a roll for `day`: reuse the open rep if one exists (re-planning a rolled-back backlog one),
  // else spawn a fresh planned rep; then ensure it sits on that day's plan, appended like addToDay.
  async pickRollToday(rollId: string, day: string): Promise<{ task: Task; plan: TaskPlan }> {
    const roll = this.mustFind(this.store.rolls, rollId);
    const existing = findOpenRollTask(this.alive(this.store.tasks), rollId);
    if (existing && isTimed(existing)) throw new Error(TIMED_NO_PLAN_ERROR); // rolls.md D6
    const task = existing
      ? existing.status === 'backlog'
        ? this.writes.put(this.store.tasks, taskTransition(existing, 'planned', this.now()))
        : existing
      : this.writes.insert(this.store.tasks, { ...this.base(), ...rollRepFields(roll) });
    const existingPlan = this.alive(this.store.plans).find(
      (p) => p.taskId === task.id && p.day === day,
    );
    const plan =
      existingPlan ??
      this.writes.insert(this.store.plans, {
        ...this.base(),
        taskId: task.id,
        day,
        plannedMinutes: roll.estimateMin ?? ROLL_PLAN_FALLBACK_MIN,
        order: this.alive(this.store.plans).filter((p) => p.day === day).length,
      });
    return { task, plan };
  }

  // --- Ideas ---------------------------------------------------------------
  async listIdeas(status?: IdeaStatus): Promise<Idea[]> {
    return this.alive(this.store.ideas)
      .filter((i) => (status ? i.status === status : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async createIdea(text: string): Promise<Idea> {
    return this.writes.insert(this.store.ideas, { ...this.base(), text, status: 'open' });
  }
  async triageIdea(id: string, status: IdeaStatus): Promise<Idea> {
    return this.writes.patch(this.store.ideas, id, { status });
  }

  // --- Day (lazy recurrence + stale sweep on read) --------------------------
  async peekDay(day: string): Promise<Day | null> {
    if (!isDayKey(day)) throw new Error('Invalid day');
    return this.alive(this.store.days).find((d) => d.date === day) ?? null;
  }
  async getDay(day: string): Promise<Day> {
    // Lambda parity: a day after the client's app day is refused (its sweep would clear today's plan).
    if (!isDayKey(day)) throw new Error('Invalid day');
    if (day > todayKey(this.dayStartHour(), this.now())) throw new Error(FUTURE_DAY_ERROR);
    this.materializeDueSeries(day);
    this.sweepStalePlanned(day);
    const existing = this.alive(this.store.days).find((d) => d.date === day);
    if (existing) return existing;
    return this.writes.insert(this.store.days, {
      ...this.base(),
      date: day,
      capacityHours: null,
      intent: null,
      reflectionPrompt: null,
      reflectionText: null,
    });
  }
  // An occurrence is spawned once per (series, day) — identity by seriesDay (seriesHasOccurrence), so an
  // unplanned occurrence isn't respawned (recurring.md D4).
  private materializeDueSeries(day: string): void {
    const active = this.alive(this.store.series).filter((s) => s.active);
    if (active.length === 0) return;
    const tasks = this.alive(this.store.tasks);
    const plansOnDay = this.alive(this.store.plans).filter((p) => p.day === day);
    for (const series of active) {
      if (!seriesDueOn(series, day)) continue;
      if (seriesHasOccurrence(series, day, tasks, plansOnDay)) continue;
      const task = this.writes.insert(this.store.tasks, {
        ...this.base(),
        ...occurrenceFields(series, day),
      });
      this.writes.insert(this.store.plans, {
        ...this.base(),
        taskId: task.id,
        day,
        plannedMinutes: series.defaultEstimateMin ?? 0,
        order: 1000,
      });
    }
  }
  // Rule lives in the shared stalePlannedMoves (backend parity).
  private sweepStalePlanned(day: string): void {
    const tasks = this.alive(this.store.tasks);
    if (!tasks.some((t) => t.status === 'planned')) return;
    for (const { task, to } of stalePlannedMoves(tasks, this.alive(this.store.plans), day)) {
      this.writes.put(this.store.tasks, taskTransition(task, to, this.now()));
    }
  }
  async setDayCapacity(day: string, capacityHours: number | null): Promise<Day> {
    const d = await this.getDay(day);
    return this.writes.patch(this.store.days, d.id, { capacityHours });
  }
  async setDayIntent(day: string, intent: string): Promise<Day> {
    const d = await this.getDay(day);
    return this.writes.patch(this.store.days, d.id, { intent });
  }
  async setDayReflection(day: string, prompt: string, text: string): Promise<Day> {
    const d = await this.getDay(day);
    return this.writes.patch(this.store.days, d.id, {
      reflectionPrompt: prompt,
      reflectionText: text,
    });
  }

  // --- Categories ----------------------------------------------------------
  // A store row from before `area` has none; every read lists it as null (areas.ts), as the Lambda does.
  async listCategories(): Promise<Category[]> {
    return this.alive(this.store.categories)
      .map((c) => ({ ...c, area: c.area ?? null }))
      .sort((a, b) => a.order - b.order);
  }
  async upsertCategory(input: UpsertCategoryInput): Promise<Category> {
    if (input.area !== undefined) assertArea(input.area);
    if (input.id !== undefined) {
      // Every field patch-style, as the BFF: a rename racing a work flip can't revert it.
      const existing = this.mustFind(this.store.categories, input.id);
      return this.writes.patch(this.store.categories, input.id, {
        label: input.label ?? existing.label,
        isWork: input.isWork ?? existing.isWork,
        order: input.order ?? existing.order,
        active: input.active ?? existing.active,
        area: input.area === undefined ? (existing.area ?? null) : input.area,
      });
    }
    if (typeof input.label !== 'string' || typeof input.isWork !== 'boolean')
      throw new Error('upsertCategory: create needs label and isWork');
    return this.writes.insert(this.store.categories, {
      ...this.base(),
      label: input.label,
      isWork: input.isWork,
      order: input.order ?? this.alive(this.store.categories).length,
      active: input.active ?? true,
      area: input.area ?? null,
    });
  }
  async setCategoryArea(id: string, area: Area | null): Promise<Category> {
    assertArea(area); // refused before the lookup: nothing is written
    this.mustFind(this.store.categories, id);
    return this.writes.patch(this.store.categories, id, { area });
  }
  async setCategoryWork(
    id: string,
    isWork: boolean,
    backfillPast: boolean,
  ): Promise<{ category: Category; backfilled: number }> {
    const patched = this.writes.patch(this.store.categories, id, { isWork });
    const category = { ...patched, area: patched.area ?? null }; // a legacy row reads null, as listed
    let backfilled = 0;
    if (backfillPast) {
      for (const s of this.alive(this.store.sessions).filter((x) => x.categoryId === id)) {
        this.writes.put(this.store.sessions, { ...s, wasWork: isWork, updatedAt: this.now() });
        backfilled++;
      }
    }
    return { category, backfilled };
  }
  async deleteCategory(id: string, reassignToId: string | null): Promise<void> {
    const referrers = [
      ...this.alive(this.store.tasks).filter((t) => t.categoryId === id),
      ...this.alive(this.store.habits).filter((h) => h.categoryId === id),
      ...this.alive(this.store.series).filter((s) => s.categoryId === id),
      ...this.alive(this.store.rolls).filter((r) => r.categoryId === id),
    ];
    assertCategoryDeletable(referrers.length, reassignToId);
    for (const t of this.alive(this.store.tasks).filter((x) => x.categoryId === id)) {
      this.writes.patch(this.store.tasks, t.id, { categoryId: reassignToId });
    }
    for (const h of this.alive(this.store.habits).filter((x) => x.categoryId === id)) {
      this.writes.patch(this.store.habits, h.id, { categoryId: reassignToId });
    }
    for (const s of this.alive(this.store.series).filter((x) => x.categoryId === id)) {
      this.writes.patch(this.store.series, s.id, { categoryId: reassignToId });
    }
    for (const r of this.alive(this.store.rolls).filter((x) => x.categoryId === id)) {
      this.writes.patch(this.store.rolls, r.id, { categoryId: reassignToId });
    }
    this.writes.softDelete(this.store.categories, id);
  }

  // --- Places --------------------------------------------------------------
  async listPlaces(): Promise<Place[]> {
    return this.alive(this.store.places).sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    );
  }
  async upsertPlace(input: UpsertPlaceInput): Promise<Place> {
    const name = input.name.trim();
    const others = this.alive(this.store.places).filter((p) => p.id !== input.id);
    if (input.id) {
      const existing = this.mustFind(this.store.places, input.id);
      const slug = input.slug ?? existing.slug;
      const err = placeError(name, slug, others);
      if (err) throw new Error(err);
      // The slug is what tasks store, so a new one follows them.
      if (slug !== existing.slug)
        for (const t of this.alive(this.store.tasks).filter((x) => x.place === existing.slug))
          this.writes.patch(this.store.tasks, t.id, { place: slug });
      return this.writes.patch(this.store.places, input.id, { name, slug });
    }
    const slug = input.slug ?? slugify(name);
    const err = placeError(name, slug, others);
    if (err) throw new Error(err);
    return this.writes.insert(this.store.places, { ...this.base(), name, slug, lastReadAt: null });
  }
  async deletePlace(id: string, reassignToSlug: string | null): Promise<void> {
    const place = this.mustFind(this.store.places, id);
    if (reassignToSlug === place.slug)
      throw new Error('Move its errands to another place, or to no place');
    const to = this.knownPlace(reassignToSlug);
    // Off any list (null) takes only the open errands off; a finished one keeps the old slug as history,
    // so its calibration never flips. A move to another place takes them all — they stay placed.
    for (const t of this.alive(this.store.tasks).filter((x) => x.place === place.slug))
      if (to !== null || !isFinished(t)) this.writes.patch(this.store.tasks, t.id, { place: to });
    this.writes.softDelete(this.store.places, id);
  }
  // Open tasks only (PLACE_FINISHED_ERROR). A part follows its parent (PLACE_PART_ERROR); a parent carries
  // its open parts along — finished parts keep theirs.
  async setTaskPlace(id: string, place: string | null): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
    if (isFinished(task)) throw new Error(PLACE_FINISHED_ERROR);
    if (task.parentId) throw new Error(PLACE_PART_ERROR);
    const slug = this.knownPlace(place);
    for (const p of this.alive(this.store.tasks))
      if (p.parentId === id && !isFinished(p) && p.place !== slug)
        this.writes.patch(this.store.tasks, p.id, { place: slug });
    return this.writes.patch(this.store.tasks, id, { place: slug });
  }
  async listPlaceTasks(slug: string): Promise<PlaceDigest> {
    const place = this.alive(this.store.places).find((p) => p.slug === slug);
    if (!place) throw new Error(placeUnknownError(slug));
    return placeDigestOf(place, this.alive(this.store.tasks));
  }
  private placeTokenStatus(): PlaceTokenStatus {
    const t = this.store.placeToken;
    return t
      ? {
          active: true,
          createdAt: t.createdAt,
          lastUsedAt: null,
          hint: t.token.slice(-4),
          readsToday: 0,
        }
      : { active: false, createdAt: null, lastUsedAt: null, hint: null, readsToday: 0 };
  }
  async getPlaceTokenStatus(): Promise<PlaceTokenStatus> {
    return this.placeTokenStatus();
  }
  // 32 random bytes, base64url — the backend's shape, so the Settings reveal reads the same.
  async rotatePlaceToken(): Promise<{ token: string; status: PlaceTokenStatus }> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const b64 = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const token = `${PLACE_TOKEN_PREFIX}${b64}`;
    // A singleton credential, not a collection — set directly, like ensureSettings.
    this.store.placeToken = { token, createdAt: this.now() };
    this.persist();
    return { token, status: this.placeTokenStatus() };
  }
  async revokePlaceToken(): Promise<void> {
    this.store.placeToken = null;
    this.persist();
  }

  // --- Reminders (Web Push) ------------------------------------------------
  // Devices are keyed by endpoint (id = a sha256 prefix, the backend's shape), so re-subscribing the same
  // endpoint is an upsert — one removed (a tombstone, listed in removedDeviceIds so that device stops
  // re-adding itself) comes back under the same id. The stub has no poller: Send test stamps the heartbeat
  // and each device's last delivery itself, so the Settings health line moves as it would on a stage.
  private pushDevice = (s: PushSub): PushDevice => ({
    id: s.id,
    label: s.label,
    createdAt: s.createdAt,
    lastOkAt: s.lastOkAt,
    lastError: s.lastError,
    lastErrorAt: s.lastErrorAt,
  });
  // The backend's rules: parsePushInput's checks; createdAt / lastOkAt kept, even across a revive; the
  // last error kept unless the endpoint or keys changed or the device is revived.
  async subscribePush(given: SubscribePushInput): Promise<PushDevice> {
    const input = parsePushInput(given);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.endpoint));
    const id = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, PUSH_DEVICE_ID_LEN);
    const prev = this.store.pushSubs.find((x) => x.id === id);
    const same =
      !!prev &&
      prev.deletedAt === null &&
      prev.endpoint === input.endpoint &&
      prev.p256dh === input.keys.p256dh &&
      prev.auth === input.keys.auth;
    const t = this.now();
    return this.pushDevice(
      this.writes.put(this.store.pushSubs, {
        id,
        userId: USER_ID,
        createdAt: prev?.createdAt ?? t,
        updatedAt: t,
        deletedAt: null,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        label: input.label,
        lastOkAt: prev?.lastOkAt ?? null,
        lastError: same ? (prev?.lastError ?? null) : null,
        lastErrorAt: same ? (prev?.lastErrorAt ?? null) : null,
      }),
    );
  }
  // A tombstone, so the removal sticks; its endpoint and keys go — nothing will push to it again.
  async unsubscribePush(id: string): Promise<void> {
    if (typeof id !== 'string' || id === '') throw new Error(PUSH_UNKNOWN_DEVICE_ERROR);
    const s = this.find(this.store.pushSubs, id);
    if (!s) return; // removing twice, or an unknown id
    const t = this.now();
    this.writes.put(this.store.pushSubs, {
      ...s,
      endpoint: '',
      p256dh: '',
      auth: '',
      deletedAt: t,
      updatedAt: t,
    });
  }
  async getPushStatus(): Promise<PushStatus> {
    return {
      configured: true,
      vapidPublicKey: STUB_VAPID_PUBLIC_KEY,
      devices: this.alive(this.store.pushSubs)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .map(this.pushDevice),
      removedDeviceIds: this.store.pushSubs
        .filter((s) => s.deletedAt !== null)
        .map((s) => s.id)
        .sort(),
      poller: this.store.pushHealth,
    };
  }
  async sendTestPush(): Promise<void> {
    const subs = this.alive(this.store.pushSubs);
    if (subs.length === 0) throw new Error(PUSH_NO_DEVICE_ERROR);
    const t = this.now();
    for (const s of subs) this.writes.patch(this.store.pushSubs, s.id, { lastOkAt: t });
    // A singleton, not a collection — set directly, like ensureSettings.
    this.store.pushHealth = { ...this.store.pushHealth, lastRunAt: t, lastSentAt: t };
    this.persist();
  }

  // --- Settings ------------------------------------------------------------
  async getSettings(): Promise<Settings> {
    return this.ensureSettings();
  }
  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const keyErr = patchKeyError('settings', patch, SETTINGS_PATCH_KEYS);
    if (keyErr) throw new Error(keyErr);
    if (patch.fluxSets !== undefined) {
      const err = fluxSetsError(patch.fluxSets);
      if (err) throw new Error(err);
    }
    // As the BFF: a reminder toggle must be a real boolean — a string "false" would read as on.
    for (const k of Object.keys(REMINDER_SETTINGS_DEFAULTS)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined && typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
    }
    const current = this.ensureSettings();
    const next: Settings = { ...current, ...patch, updatedAt: this.now() };
    this.store.settings = next;
    this.persist();
    return next;
  }

  // --- Google Calendar (stub: an in-memory fake so the UI is exercisable page-first) ---------------
  // No OAuth here — connecting is a real-backend redirect (Phase 5). The stub reflects whatever
  // accounts settings hold (seeded for dev) and fabricates believable calendars + busy blocks so the
  // shape panel, calendar picker, and add-to-calendar dialog render against real-shaped data.
  async googleConnectUrl(): Promise<{ url: string }> {
    // The stub can't complete an OAuth redirect; the real consent URL is built by the backend.
    return { url: '#google-connect-unavailable-in-stub' };
  }
  async getGoogleStatus(): Promise<GoogleStatus> {
    return {
      accounts: this.ensureSettings().googleAccounts.map((a) => {
        const sync = this.find(this.store.gcalSyncStates, a.sub);
        return {
          sub: a.sub,
          email: a.email,
          connected: true,
          reconnectRequired: false,
          lastSyncedAt: sync?.lastSyncedAt ?? null,
          lastPullError: sync?.lastPullError ?? null,
        };
      }),
    };
  }
  async listGoogleCalendars(): Promise<GoogleCalendar[]> {
    // Primary-only parity with the backend: each account's primary (calendarId = email). We can't list
    // all calendars with the calendar.events scope (see backend.listGoogleCalendars).
    return this.ensureSettings().googleAccounts.map((a) => ({
      accountSub: a.sub,
      calendarId: a.email,
      summary: a.email,
      primary: true,
    }));
  }
  async getCalendarBusy(input: GetCalendarBusyInput): Promise<CalendarBusy> {
    if (this.ensureSettings().googleAccounts.length === 0) return { intervals: [], allDayCount: 0 };
    // Two fabricated blocks inside the window, deterministic relative to its start.
    const H = 60 * 60_000;
    const s = input.windowStartMs;
    const clamp = (ms: number) => Math.min(ms, input.windowEndMs);
    return {
      intervals: [
        { startMs: clamp(s + 2 * H), endMs: clamp(s + 3 * H) },
        { startMs: clamp(s + 5 * H), endMs: clamp(s + 6.5 * H) },
      ].filter((iv) => iv.endMs > iv.startMs),
      allDayCount: 1,
    };
  }
  async insertCalendarEvent(input: InsertCalendarEventInput): Promise<Task> {
    const task = this.mustFind(this.store.tasks, input.taskId);
    // Parity with the backend: no picked time on a timed task while auto-sync is on, one live event per
    // task, and only onto a connected account.
    const settings = this.ensureSettings();
    if (hasParts(this.alive(this.store.tasks), task.id)) throw new Error(PARENT_NO_EVENT_ERROR);
    if (eventWindow(task, localEpochFromDayTime) && autoSyncOn(settings))
      throw new Error(AUTO_PLACED_ERROR);
    if (task.gcalEventId) throw new Error('Task already has a calendar event');
    if (!settings.googleAccounts.some((a) => a.sub === input.accountSub))
      throw new Error(`No connected account: ${input.accountSub}`);
    return this.writes.patch(this.store.tasks, input.taskId, {
      gcalAccountId: input.accountSub,
      gcalCalendarId: input.calendarId,
      gcalEventId: `stub-event-${this.now()}`,
      gcalSeen: {
        title: input.title,
        startMs: input.startMs,
        endMs: input.endMs,
        updatedMs: this.now(),
      },
      gcalPulled: null, // a "Removed in Google Calendar" mark no longer holds
    });
  }
  async deleteCalendarEvent(taskId: string): Promise<Task> {
    this.mustFind(this.store.tasks, taskId);
    return this.clearCalendarPointers(taskId);
  }
  async syncCalendarEvent(taskId: string): Promise<Task> {
    return this.syncCalendar(null, this.mustFind(this.store.tasks, taskId), true);
  }
  // Two-way sync parity with the backend: the same planner, the same throttle and toggle, over the dev
  // queue (STUB_GCAL_EDITS_KEY) instead of an events.list delta. No first-pull baseline — the queue is
  // only ever deliberate edits.
  async pullCalendar(): Promise<PullCalendarResult> {
    const settings = this.ensureSettings();
    const idle: PullCalendarResult = { pulled: false, changedTaskIds: [], accounts: [] };
    if (settings.autoCalendar === false || settings.googleAccounts.length === 0) return idle;
    const now = this.now();
    const edits = takeStubGcalEdits();
    const states = settings.googleAccounts.map(
      (a): GcalSyncState =>
        this.find(this.store.gcalSyncStates, a.sub) ?? {
          ...this.base(),
          id: a.sub,
          sub: a.sub,
          calendarId: a.email,
          syncToken: null,
          lastPulledAt: null,
          lastSyncedAt: null,
          lastPullError: null,
          lastPullErrorAt: null,
        },
    );
    const due = states.filter(
      (st) => !st.lastPulledAt || now - st.lastPulledAt >= PULL_THROTTLE_MS,
    );
    if (due.length === 0 && edits.length === 0) return idle;
    const changed: string[] = [];
    const accounts = (edits.length ? states : due).map((st) => {
      const fail = edits.find((e) => e.failAccount === st.sub);
      if (fail) {
        const error = fail.error ?? 'stub failure';
        this.writes.put(this.store.gcalSyncStates, {
          ...st,
          lastPulledAt: now,
          lastPullError: error,
          lastPullErrorAt: now,
          updatedAt: now,
        });
        return { sub: st.sub, ok: false, error };
      }
      for (const edit of edits) {
        const found = edit.taskId ? this.find(this.store.tasks, edit.taskId) : undefined;
        if (!found?.gcalEventId || found.gcalAccountId !== st.sub) continue;
        if (found.gcalCalendarId !== st.calendarId) continue;
        // A linked task with no known event (seeded, or persisted before two-way sync) takes its own
        // block as the known one — the planner's later-delta fallback, prefilled because stubEvent
        // needs a base (the queue is only ever deliberate edits, never a first-sync baseline).
        const alive = this.alive(this.store.tasks);
        const parent = hasParts(alive, found.id);
        const parentTitle = parentOf(alive, found)?.title ?? null;
        const task = {
          ...found,
          gcalSeen:
            found.gcalSeen ??
            seenFromTask(found, syncWindow(found, localEpochFromDayTime, parent), parentTitle),
        };
        const action = calendarPullPlan(
          task,
          this.stubEvent(task, edit, now),
          { epoch: localEpochFromDayTime, clock: localDayTime },
          { firstSync: false, parent, parentTitle },
        );
        if (action.kind === 'none') continue;
        this.writes.patch(
          this.store.tasks,
          task.id,
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
                },
        );
        if (action.kind !== 'see') changed.push(task.id);
      }
      this.writes.put(this.store.gcalSyncStates, {
        ...st,
        syncToken: `stub-${now}`,
        lastPulledAt: now,
        lastSyncedAt: now,
        lastPullError: null,
        lastPullErrorAt: null,
        updatedAt: now,
      });
      return { sub: st.sub, ok: true, error: null };
    });
    return { pulled: true, changedTaskIds: changed, accounts };
  }
  // A queued edit as the event Google would now return: the known event with the edit's changes laid
  // over it (an `end` alone keeps the block's length).
  private stubEvent(
    task: Task & { gcalSeen: GcalSeen },
    edit: StubGcalEdit,
    now: number,
  ): PulledEvent {
    const known = task.gcalSeen;
    const endMs = edit.end
      ? localEpochFromDayTime(edit.end.slice(0, 10), edit.end.slice(11, 16))
      : known.endMs;
    const len =
      edit.durationMin ??
      (known.startMs !== null && known.endMs !== null
        ? (known.endMs - known.startMs) / 60_000
        : eventLengthMin(task));
    return {
      eventId: task.gcalEventId!,
      cancelled: !!edit.cancelled,
      recurring: false,
      title: edit.title ?? known.title ?? task.title,
      allDay: !!edit.allDay,
      startMs: edit.allDay || endMs === null ? null : endMs - len * 60_000,
      endMs: edit.allDay ? null : endMs,
      updatedMs: now,
    };
  }
  async disconnectGoogleAccount(accountSub: string): Promise<void> {
    const current = this.ensureSettings();
    const next: Settings = {
      ...current,
      googleAccounts: current.googleAccounts.filter((a) => a.sub !== accountSub),
      calendarShapeRefs: current.calendarShapeRefs.filter((r) => r.accountSub !== accountSub),
      calendarWriteDefault:
        current.calendarWriteDefault?.accountSub === accountSub
          ? null
          : current.calendarWriteDefault,
      updatedAt: this.now(),
    };
    this.store.settings = next;
    this.writes.softDelete(this.store.gcalSyncStates, accountSub); // a reconnect starts afresh
    this.persist();
  }

  // --- Finances (stub: Plaid is faked with the shared fixtures) -----------------------------------
  // Link is a FakeLinkDialog (environment 'stub'), the exchange "returns" the fixture BofA login, and a
  // sync replays fixture pages by cursor — the same pages the lambdas' InMemoryPlaid serves, through
  // the same reconcileSyncPage. Syncs run inline, so `syncing` is never observed here.
  private finToday(): string {
    return todayKey(this.dayStartHour(), this.now());
  }
  // Page through the fixture from the saved cursor until has_more=false; the cursor is saved last.
  // Only the accounts ticked at link time come through, like a real consented Item.
  private syncItem(itemId: string): void {
    const t = this.now();
    const state = this.find(this.store.financeSyncStates, itemId);
    if (!state) return;
    // A login that needs fixing keeps failing until update mode (completePlaidUpdate) fixes it — as
    // at Plaid, where every call on the item returns ITEM_LOGIN_REQUIRED.
    const loginNeeded = this.find(this.store.financeItems, itemId)?.status === 'login_required';
    const failure = loginNeeded ? 'ITEM_LOGIN_REQUIRED' : takeStubSyncFailure();
    if (failure) {
      // A failed run changes nothing but the error — the cursor and lastSyncedAt stay put.
      this.writes.put(this.store.financeSyncStates, {
        ...state,
        lastSyncError: failure,
        lastSyncErrorAt: t,
        updatedAt: t,
      });
      if (failure === 'ITEM_LOGIN_REQUIRED')
        this.writes.patch(this.store.financeItems, itemId, {
          status: 'login_required',
          errorCode: failure,
        });
      return;
    }
    const accountIds = new Set(
      this.alive(this.store.financeAccounts)
        .filter((a) => a.itemId === itemId)
        .map((a) => a.id),
    );
    const keep = <T extends { account_id: string }>(xs: T[]) =>
      xs.filter((x) => accountIds.has(x.account_id));
    const existing = new Map(this.store.financeTransactions.map((x) => [x.id, x]));
    const rules = this.alive(this.store.financeRules);
    let cursor = state.cursor;
    for (;;) {
      const page = fixturePageAfter(cursor, this.finToday());
      const rows = reconcileSyncPage({
        existing,
        page: { added: keep(page.added), modified: keep(page.modified), removed: page.removed },
        rules,
        now: t,
        itemId,
        userId: USER_ID,
      });
      for (const r of rows) this.writes.put(this.store.financeTransactions, r);
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    this.writes.put(this.store.financeSyncStates, {
      ...state,
      cursor,
      lastSyncedAt: t,
      lastSyncError: null,
      lastSyncErrorAt: null,
      updatedAt: t,
    });
  }
  // Link + first sync, shared by exchangePlaidPublicToken and the dev seed.
  private linkFixtureItem(input: ExchangePublicTokenInput): FinanceItem {
    const t = this.now();
    const ticked = new Set(input.accounts.map((a) => a.id));
    const stamp = { userId: USER_ID, createdAt: t, updatedAt: t, deletedAt: null };
    const item = this.writes.put(this.store.financeItems, {
      ...stamp,
      id: FIXTURE_ITEM_ID,
      institutionId: input.institution.id,
      institutionName: input.institution.name,
      status: 'ok',
      errorCode: null,
      consentExpiresAt: null,
      lastSuccessfulUpdateAt: t,
      lastFailedUpdateAt: null,
      consentedProducts: ['transactions'],
    });
    for (const a of FIXTURE_ACCOUNTS.filter((x) => ticked.has(x.account_id))) {
      const prev = this.store.financeAccounts.find((x) => x.id === a.account_id);
      this.writes.put(this.store.financeAccounts, {
        ...stamp,
        id: a.account_id,
        itemId: item.id,
        name: a.name,
        officialName: a.official_name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        isoCurrency: a.balances.iso_currency_code,
        currentCents: a.balances.current === null ? null : toCents(a.balances.current),
        availableCents: a.balances.available === null ? null : toCents(a.balances.available),
        balanceAt: t,
        signOverride: prev?.signOverride ?? 'auto',
        hidden: prev?.hidden ?? false,
      });
    }
    this.writes.put(this.store.financeSyncStates, {
      ...stamp,
      id: item.id,
      itemId: item.id,
      cursor: null,
      lastSyncedAt: null,
      lastSyncError: null,
      lastSyncErrorAt: null,
      syncRequestedAt: t,
      refreshRequestedAt: null,
      lastRefreshedAt: null,
      lockedUntil: null,
    });
    this.syncItem(item.id);
    return item;
  }
  // Dev seed: a linked BofA with three rules, both card payments marked, older history sorted, and
  // the recent weeks mostly not.
  private seedFinance(): void {
    for (const [pattern, bucket] of [
      ['spotify', 'i_pay'],
      ['netflix', 'i_pay'],
      ["trader joe's", 'parents_pay'],
    ] as const)
      this.writes.insert(this.store.financeRules, {
        ...this.base(),
        pattern,
        bucket,
        active: true,
      });
    this.linkFixtureItem({
      publicToken: 'seed',
      institution: FIXTURE_INSTITUTION,
      accounts: FIXTURE_LINK_ACCOUNTS,
    });
    for (const id of ['fx-ccpay-card-40', 'fx-ccpay-card-10'])
      this.writes.patch(this.store.financeTransactions, id, { startsPeriod: true });
    const cutoff = addDays(this.finToday(), -12);
    const sortedRecently = ['Chipotle', 'Blue Bottle Coffee'];
    for (const x of this.alive(this.store.financeTransactions)) {
      if (
        x.bucket !== null ||
        x.rawAmountCents <= 0 ||
        x.accountId !== FIXTURE_ACCOUNTS[2]!.account_id
      )
        continue;
      if (x.date >= cutoff && !sortedRecently.includes(x.merchantName ?? '')) continue;
      this.writes.patch(this.store.financeTransactions, x.id, {
        bucket: 'budget',
        bucketSetBy: 'user',
      });
    }
  }

  async getFinanceOverview(input: { today: string }): Promise<FinanceOverview> {
    const settings = this.ensureSettings();
    const from = addDays(input.today, -FINANCE_OVERVIEW_LOOKBACK_DAYS);
    return buildFinanceOverview({
      today: input.today,
      budgetCents: settings.financeBudgetCents,
      paymentDay: settings.financePaymentDay,
      items: this.alive(this.store.financeItems),
      accounts: this.alive(this.store.financeAccounts),
      syncStates: this.alive(this.store.financeSyncStates),
      txns: this.alive(this.store.financeTransactions).filter(
        (x) => x.date >= from && x.date <= input.today,
      ),
      environment: 'stub',
      now: this.now(),
    });
  }
  async listFinanceTransactions(range: DateRange): Promise<FinanceTransaction[]> {
    return this.alive(this.store.financeTransactions)
      .filter((x) => x.date >= range.from && x.date <= range.to)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }
  async setFinanceBucket(input: SetFinanceBucketInput): Promise<FinanceTransaction[]> {
    const bucketError = financeBucketError(input.bucket, { nullable: true });
    if (bucketError) throw new Error(bucketError);
    if (input.rule && input.bucket === null) throw new Error('A rule needs a bucket');
    for (const id of input.ids) this.mustFind(this.store.financeTransactions, id);
    const changed = new Map<string, FinanceTransaction>();
    for (const id of input.ids)
      changed.set(
        id,
        this.writes.patch(this.store.financeTransactions, id, {
          bucket: input.bucket,
          bucketSetBy: input.bucket ? 'user' : null,
          refundOfId: null, // sorting a refund yourself unlinks it
        }),
      );
    if (input.rule && input.bucket) {
      const rule = await this.upsertFinanceRule({
        pattern: input.rule.pattern,
        bucket: input.bucket,
      });
      for (const x of this.alive(this.store.financeTransactions)) {
        if (x.bucket !== null || x.refundOfId !== null || x.startsPeriod) continue;
        if (!applyRules([rule], x)) continue;
        changed.set(
          x.id,
          this.writes.patch(this.store.financeTransactions, x.id, {
            bucket: rule.bucket,
            bucketSetBy: 'rule',
          }),
        );
      }
    }
    return [...changed.values()];
  }
  async setFinancePeriodOverride(
    id: string,
    override: FinancePeriodOverride | null,
  ): Promise<FinanceTransaction> {
    return this.writes.patch(this.store.financeTransactions, id, {
      periodOverride: override,
      refundOfId: null, // moving a refund yourself unlinks it
    });
  }
  async linkFinanceRefund(refundId: string, chargeId: string | null): Promise<FinanceTransaction> {
    const refund = this.mustFind(this.store.financeTransactions, refundId);
    if (chargeId === null)
      return this.writes.patch(this.store.financeTransactions, refundId, { refundOfId: null });
    const charge = this.mustFind(this.store.financeTransactions, chargeId);
    const accounts = this.alive(this.store.financeAccounts);
    // Moves over the same window the overview reads, so pairing at the edge matches the page.
    const from = addDays(this.finToday(), -FINANCE_OVERVIEW_LOOKBACK_DAYS);
    const recent = this.alive(this.store.financeTransactions).filter((x) => x.date >= from);
    const error = refundLinkError({
      refund,
      refundAccount: accounts.find((a) => a.id === refund.accountId),
      charge,
      chargeAccount: accounts.find((a) => a.id === charge.accountId),
      moves: detectInternalMoves(recent, accounts),
    });
    if (error) throw new Error(error);
    return this.writes.patch(this.store.financeTransactions, refundId, {
      refundOfId: chargeId,
      bucket: null,
      bucketSetBy: null,
      periodOverride: null,
    });
  }
  async setFinanceNote(id: string, note: string | null): Promise<FinanceTransaction> {
    return this.writes.patch(this.store.financeTransactions, id, { note: note?.trim() || null });
  }
  async setFinancePeriodStart(id: string, marked: boolean): Promise<FinanceTransaction> {
    const txn = this.mustFind(this.store.financeTransactions, id);
    if (!marked)
      return this.writes.patch(this.store.financeTransactions, id, { startsPeriod: false });
    const account = this.store.financeAccounts.find((a) => a.id === txn.accountId);
    const error = periodStartError(txn, account);
    if (error) throw new Error(error);
    return this.writes.patch(this.store.financeTransactions, id, {
      startsPeriod: true,
      bucket: null, // it's a payment now
      bucketSetBy: null,
      periodOverride: null,
      refundOfId: null,
    });
  }
  async listFinanceRules(): Promise<FinanceRule[]> {
    return this.alive(this.store.financeRules).sort((a, b) => a.pattern.localeCompare(b.pattern));
  }
  // One live rule per pattern: saving an existing pattern updates it.
  async upsertFinanceRule(input: UpsertFinanceRuleInput): Promise<FinanceRule> {
    const bucketError = financeBucketError(input.bucket, { nullable: false });
    if (bucketError) throw new Error(bucketError);
    const pattern = normalizeRulePattern(input.pattern);
    if (!pattern) throw new Error('A rule needs a pattern');
    const fields = { pattern, bucket: input.bucket, active: input.active ?? true };
    const id =
      input.id ?? this.alive(this.store.financeRules).find((r) => r.pattern === pattern)?.id;
    if (id) return this.writes.patch(this.store.financeRules, id, fields);
    return this.writes.insert(this.store.financeRules, { ...this.base(), ...fields });
  }
  async deleteFinanceRule(id: string): Promise<void> {
    this.writes.softDelete(this.store.financeRules, id);
  }
  async updateFinanceAccount(id: string, patch: FinanceAccountPatch): Promise<FinanceAccount> {
    return this.writes.patch(this.store.financeAccounts, id, patch);
  }
  async createPlaidLinkToken(input: CreateLinkTokenInput): Promise<LinkTokenResult> {
    if (input.mode === 'update') this.mustFind(this.store.financeItems, input.itemId);
    return { linkToken: `link-stub-${this.ulid()}`, environment: 'stub' };
  }
  async exchangePlaidPublicToken(input: ExchangePublicTokenInput): Promise<FinanceItem> {
    const { financeItems, financeAccounts } = this.store;
    if (isDuplicateItem(financeItems, financeAccounts, input.institution.id, input.accounts))
      throw new Error(duplicateItemMessage(input.institution.name));
    return this.linkFixtureItem(input);
  }
  // Like the backend: the login is fixed, then a sync runs (which can fail again).
  async completePlaidUpdate(itemId: string): Promise<FinanceItem> {
    this.mustFind(this.store.financeItems, itemId);
    this.writes.patch(this.store.financeItems, itemId, { status: 'ok', errorCode: null });
    const state = this.find(this.store.financeSyncStates, itemId);
    if (state)
      this.writes.put(this.store.financeSyncStates, { ...state, syncRequestedAt: this.now() });
    this.syncItem(itemId);
    return this.mustFind(this.store.financeItems, itemId);
  }
  async removePlaidItem(itemId: string): Promise<void> {
    for (const a of this.alive(this.store.financeAccounts).filter((x) => x.itemId === itemId))
      this.writes.softDelete(this.store.financeAccounts, a.id);
    this.writes.softDelete(this.store.financeSyncStates, itemId);
    this.writes.softDelete(this.store.financeItems, itemId);
  }
  async requestFinanceSync(input: { refresh: boolean }): Promise<RequestFinanceSyncResult> {
    const t = this.now();
    const states = this.alive(this.store.financeSyncStates);
    if (states.length === 0) return { accepted: false, nextAllowedAt: null };
    if (input.refresh) {
      const last = Math.max(...states.map((s) => s.refreshRequestedAt ?? -Infinity));
      if (t - last < FINANCE_REFRESH_COOLDOWN_MS)
        return { accepted: false, nextAllowedAt: last + FINANCE_REFRESH_COOLDOWN_MS };
    }
    for (const s of states) {
      this.writes.put(this.store.financeSyncStates, {
        ...s,
        syncRequestedAt: t,
        refreshRequestedAt: input.refresh ? t : s.refreshRequestedAt,
        lastRefreshedAt: input.refresh ? t : s.lastRefreshedAt, // the inline sync "refreshes"
        updatedAt: t,
      });
      this.syncItem(s.itemId);
    }
    return {
      accepted: true,
      nextAllowedAt: input.refresh ? t + FINANCE_REFRESH_COOLDOWN_MS : null,
    };
  }

  // --- Calibration ---------------------------------------------------------
  async getCalibration(range: DateRange): Promise<CalibrationPoint[]> {
    const start = this.dayStartHour();
    const tasks = this.alive(this.store.tasks);
    return calibrationTasks(tasks)
      .filter((t) => t.completedAt !== null)
      .map((t) => ({
        taskId: t.id,
        day: dayKeyInZone(t.completedAt!, USER_TIME_ZONE, start),
        estimateLockedMin: t.estimateLockedMin!,
        estimateMin: t.estimateMin,
        estimateSource: t.estimateSource ?? null,
        actualAccruedMin: t.actualAccruedMin,
        categoryId: t.categoryId,
        reflection: t.reflection ?? null,
        parts: rollupParts(tasks, t.id),
      }))
      .filter((p) => p.day >= range.from && p.day <= range.to)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  // Enumerated, not spread. The spread silently tracked whatever Store happened to hold — which hid
  // two divergences from the backend: soft-deleted rows leaked in, and a virgin store exported
  // `settings: null`. Both are resolved here, and ExportBundle makes the key set a compile error.
  async exportData(): Promise<ExportBundle> {
    const bundle: ExportBundle = {
      exportedAt: this.now(),
      userId: USER_ID,
      logEntries: this.alive(this.store.logEntries),
      tasks: this.alive(this.store.tasks),
      plans: this.alive(this.store.plans),
      series: this.alive(this.store.series),
      ideas: this.alive(this.store.ideas),
      habits: this.alive(this.store.habits),
      habitChecks: this.alive(this.store.habitChecks),
      rolls: this.alive(this.store.rolls),
      sessions: this.alive(this.store.sessions),
      days: this.alive(this.store.days),
      categories: this.alive(this.store.categories),
      places: this.alive(this.store.places),
      sittings: this.alive(this.store.sittings),
      sittingLive: this.alive(this.store.sittingLive),
      // Head rows only (verdicts, timer reads) — payloads and the raw bulk stay out, as on the backend.
      sittingHeadRows: this.alive(this.store.sittingHeadRows).map(
        ({ id, sittingId, type, at, verdict, timer, deletedAt }) => ({
          id,
          sittingId,
          type,
          at,
          verdict,
          timer,
          deletedAt,
        }),
      ),
      leetcodeProblems: this.alive(this.store.leetcodeProblems),
      stories: this.alive(this.store.stories),
      fluxSets: this.alive(this.store.fluxSets),
      attachments: this.alive(this.store.attachments).filter((a) => a.status === 'ready'),
      financeItems: this.alive(this.store.financeItems),
      financeSyncStates: this.alive(this.store.financeSyncStates),
      financeAccounts: this.alive(this.store.financeAccounts),
      financeTransactions: this.alive(this.store.financeTransactions),
      financeRules: this.alive(this.store.financeRules),
      gcalSyncStates: this.alive(this.store.gcalSyncStates),
      settings: this.ensureSettings(),
    };
    // Store is the source of truth for what a full snapshot holds, so this is where a new collection
    // has to be noticed. The old `...this.store` spread did that for free — it picked up new keys
    // automatically, which made the contract's key-set assertion go red until the backend caught up.
    // Enumerating lost that signal, so assert coverage explicitly: add a collection to Store and this
    // stops compiling, which forces it into ExportBundle, which in turn breaks the backend's literal.
    // The Store keys left out on purpose: the place token and push subscriptions are credentials, the
    // poller's heartbeat is stage health, not your data, and the week-note cache is derived from the sets
    // (rebuilt on the next read). A sitting's
    // replay stays out like attachment bytes (bulk, and it expires); its capture budget, live-pull count and Start gate are internal, and its events' payloads stay out (the head rows carry
    // their verdicts).
    return bundle satisfies Record<
      Exclude<
        keyof Store,
        | 'placeToken'
        | 'pushSubs'
        | 'pushHealth'
        | 'fluxNotes'
        | 'sittingReplay'
        | 'sittingBudgets'
        | 'sittingReads'
        | 'sittingEvents'
        | 'lcStartGate'
      >,
      unknown
    >;
  }
}
