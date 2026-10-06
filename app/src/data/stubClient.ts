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
  assertCategoryDeletable,
  calendarPullPlan,
  calendarSyncPlan,
  seenAfter,
  syncedFieldsChanged,
  completeSession,
  countsTowardCap,
  createUlid,
  dayKey,
  dayKeyForOffset,
  discardSession,
  eventLengthMin,
  eventWindow,
  isPendingRemoval,
  localDayTime,
  localEpochFromDayTime,
  PULL_THROTTLE_MS,
  normalizeDue,
  findOpenRollTask,
  heartbeatSession,
  normalizeContentType,
  normalizeNotes,
  normalizeVerdict,
  resolveStaleSession,
  resumeSession,
  ROLL_PLAN_FALLBACK_MIN,
  rollRepFields,
  sanitizeFilename,
  seriesDueOn,
  setNotesArg,
  followUpPlanDay,
  followUpPlanMinutes,
  calibrationTasks,
  splitFollowUp,
  rescopedPlanMinutes,
  splitOriginal,
  stalePlannedMoves,
  taskTransition,
  UPLOAD_URL_TTL_MS,
  withEstimate,
} from '@aperture/shared';
import type {
  ApiClient,
  Attachment,
  BaseEntity,
  CalendarBusy,
  CalibrationPoint,
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
  PullCalendarResult,
  PulledEvent,
  RequestFinanceSyncResult,
  SetFinanceBucketInput,
  SetTaskDueInput,
  SplitTaskInput,
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
  LeetcodeAttempt,
  LogEntry,
  PomodoroSession,
  RecordLeetcodeAttemptInput,
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
  UpsertPlanInput,
  UpsertRollInput,
  UpsertSeriesInput,
} from '@aperture/shared';
import { seedStore } from './seed';

const USER_ID = 'local';
const FINANCE_SETTINGS_DEFAULTS = {
  financeBudgetCents: FINANCE_DEFAULT_BUDGET_CENTS,
  financePaymentDay: FINANCE_DEFAULT_PAYMENT_DAY,
};
const STORAGE_KEY = 'aperture.stub.v1';

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
  leetcodeAttempts: LeetcodeAttempt[];
  stories: Story[];
  attachments: Attachment[];
  financeItems: FinanceItem[];
  financeSyncStates: FinanceSyncState[];
  financeAccounts: FinanceAccount[];
  financeTransactions: FinanceTransaction[];
  financeRules: FinanceRule[];
  gcalSyncStates: GcalSyncState[];
  settings: Settings | null;
}

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
    leetcodeAttempts: [],
    stories: [],
    attachments: [],
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
      // leetcodeAttempts) without a wipe or an undefined.push crash.
      if (!raw) return null;
      const store = { ...emptyStore(), ...(JSON.parse(raw) as Partial<Store>) };
      // Settings gain fields over time; a persisted row from before them reads the defaults.
      if (store.settings) {
        store.settings = { ...FINANCE_SETTINGS_DEFAULTS, ...store.settings };
        delete (store.settings as { financeCycleDay?: number }).financeCycleDay; // → financePaymentDay
      }
      // Rows persisted before refund linking / period marks existed read as unlinked and unmarked.
      store.financeTransactions = store.financeTransactions.map((t) => ({
        ...t,
        refundOfId: t.refundOfId ?? null,
        startsPeriod: t.startsPeriod ?? false,
      }));
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
    return {
      ...this.baseAt(t),
      title: input.title,
      status: 'backlog',
      categoryId: input.categoryId ?? null,
      ...normalizeDue(input.dueDay ?? null, input.dueTime ?? null),
      notes: normalizeNotes(input.notes),
      seriesId: null,
      rollId: null,
      estimateMin: input.estimateMin ?? null,
      bufferMin: input.bufferMin ?? null,
      estimateLockedMin: null,
      splitFromId: null,
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
  // Calendar auto-sync parity with the backend: the same shared planner, executed against a fake event
  // id (no Google here). The browser's clock is the user's, so the local epoch is the right one.
  private syncCalendar(prev: Task | null, task: Task, ensure = false): Task {
    if (!task.dueTime && !task.gcalEventId && !task.gcalSyncError) return task; // nothing to sync
    const settings = this.ensureSettings();
    const action = calendarSyncPlan(prev, task, settings, localEpochFromDayTime, { ensure });
    // A linked task's synced edit stamps gcalEditedAt (the conflict tiebreak) and retires a superseded
    // "updated from Google" note — whether or not it pushes.
    const edited = !!prev && !!task.gcalEventId && syncedFieldsChanged(prev, task);
    const editStamp = edited
      ? { gcalEditedAt: this.now(), gcalPulledAt: null, gcalPulledNote: null }
      : {};
    if (action.kind === 'none') {
      const moot =
        task.gcalSyncError &&
        ((!task.gcalEventId && !eventWindow(task, localEpochFromDayTime)) ||
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
    // A create or patch is Aperture's latest word on the event (gcalTouchedAt, the latest-wins clock);
    // a moved window makes a manual block the auto-synced one.
    if (action.kind === 'patch')
      return this.writes.patch(this.store.tasks, task.id, {
        gcalSyncError: null,
        gcalSeen: seenAfter(action, task.gcalSeen),
        gcalTouchedAt: this.now(),
        ...editStamp,
        ...(action.endMs !== undefined && { gcalManual: null }),
      });
    return this.writes.patch(this.store.tasks, task.id, {
      gcalAccountId: action.target.accountSub,
      gcalCalendarId: action.target.calendarId,
      gcalEventId: `stub-event-${this.ulid()}`,
      gcalSyncError: null,
      gcalManual: null,
      gcalSeen: seenAfter(action, null),
      gcalPulledAt: null, // a "Removed in Google Calendar" mark no longer holds
      gcalPulledNote: null,
      gcalTouchedAt: this.now(),
    });
  }
  private clearCalendarPointers(taskId: string): Task {
    return this.writes.patch(this.store.tasks, taskId, {
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
      gcalSyncError: null,
      gcalManual: null,
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
  private ensureSettings(): Settings {
    if (this.store.settings) return this.store.settings;
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
  async createLogEntry(text: string, day: string): Promise<LogEntry> {
    return this.writes.insert(this.store.logEntries, {
      ...this.base(),
      day,
      text,
    });
  }
  async updateLogEntry(id: string, text: string): Promise<LogEntry> {
    return this.writes.patch(this.store.logEntries, id, { text });
  }

  // --- Recruiting (LeetCode) -----------------------------------------------
  async recordLeetcodeAttempt(input: RecordLeetcodeAttemptInput): Promise<LeetcodeAttempt> {
    const dup = this.alive(this.store.leetcodeAttempts).find(
      (a) => a.leetcodeSubmissionId === input.leetcodeSubmissionId,
    );
    if (dup) return dup; // idempotent — mirrors backend
    return this.writes.insert(this.store.leetcodeAttempts, {
      ...this.base(),
      day: dayKeyForOffset(input.submittedAt, input.tzOffsetMinutes, this.dayStartHour()),
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
    return this.alive(this.store.leetcodeAttempts)
      .filter((a) => !range || (a.day >= range.from && a.day <= range.to))
      .sort((a, b) => b.submittedAt - a.submittedAt);
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
    return this.writes.patch(this.store.stories, id, patch); // patch throws on a tombstone
  }
  async deleteStory(id: string): Promise<void> {
    this.writes.softDelete(this.store.stories, id);
  }

  // --- Task attachments ----------------------------------------------------
  // The stub never touches bytes: uploadUrl/downloadUrl are `stub:<id>` sentinels the transport module
  // resolves against an in-memory Blob map. Everything else — caps, pending→ready, tombstones — mirrors
  // the backend exactly so the page-first build validates the real behavior.
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
    return this.syncCalendar(
      null,
      this.writes.insert(this.store.tasks, this.newTask(input, this.now())),
    );
  }
  async createTasks(inputs: CreateTaskInput[]): Promise<Task[]> {
    const t = this.now();
    const tasks = inputs.map((input) => this.newTask(input, t)); // normalizes all first: one bad input writes nothing
    return tasks.map((task) => this.syncCalendar(null, this.writes.insert(this.store.tasks, task)));
  }
  async setTaskEstimate(
    id: string,
    estimateMin: number | null,
    bufferMin: number | null,
  ): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
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
    return this.syncCalendar(prev, this.writes.patch(this.store.tasks, id, { title: trimmed }));
  }
  async setTaskNotes(id: string, notes: string | null): Promise<Task> {
    return this.writes.patch(this.store.tasks, id, { notes: setNotesArg(notes) });
  }
  async transitionTask(id: string, to: TaskStatus): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
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
  async setTaskActual(id: string, actualMin: number): Promise<Task> {
    return this.writes.patch(this.store.tasks, id, { actualAccruedMin: actualMin });
  }
  async splitTask(id: string, input: SplitTaskInput): Promise<{ original: Task; followUp: Task }> {
    const task = this.mustFind(this.store.tasks, id);
    const edited = splitOriginal(task, input, this.now()); // validates everything before any write
    const done = input.finish === 'done';
    // Parity with the backend: a done TIMED part hands its event to the follow-up; kept going, each part
    // owns its own block; any other linked event stays on the original.
    // A manual block (gcalManual — a picked time, often the work just done) is "any other" event too.
    const moveLink =
      done && !!task.dueDay && !!task.dueTime && !!task.gcalEventId && !task.gcalManual;
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
              gcalManual: null,
              gcalPulledAt: null, // the follow-up owns the event a pulled note would describe
              gcalPulledNote: null,
            }
          : {}),
        gcalSyncError: owed ? task.gcalSyncError : null,
      });
      // Through the sync path whenever the event stays: an owed removal is carried out, and a rename
      // stamps the edit clock (calendarPull.ts) like any edit on a done task.
      if (!moveLink) original = this.syncCalendar(task, original);
    } else {
      original = this.syncCalendar(task, this.writes.put(this.store.tasks, edited));
    }
    const day =
      task.status === 'planned' || task.status === 'in_progress'
        ? followUpPlanDay(this.alive(this.store.plans), id)
        : null;
    const fields = splitFollowUp(task, input.followUp, day !== null);
    const created = this.writes.insert(this.store.tasks, {
      ...this.base(),
      ...fields,
      ...(moveLink
        ? {
            gcalAccountId: task.gcalAccountId,
            gcalCalendarId: task.gcalCalendarId,
            gcalEventId: task.gcalEventId,
            gcalSeen: task.gcalSeen ?? null,
            gcalTouchedAt: task.gcalTouchedAt ?? null,
            gcalEditedAt: this.now(), // its title/estimate are a new Aperture edit, made now
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
    return { original, followUp: this.syncCalendar(null, created) };
  }
  async deleteTask(id: string): Promise<void> {
    const task = this.find(this.store.tasks, id);
    if (!task) return; // idempotent — already gone or never existed
    // Calendar event before the tombstone: deleteCalendarEvent uses mustFind and clears the pointers.
    if (task.gcalEventId) await this.deleteCalendarEvent(id);
    for (const p of this.alive(this.store.plans).filter((p) => p.taskId === id))
      this.writes.softDelete(this.store.plans, p.id);
    for (const a of this.alive(this.store.attachments).filter((a) => a.taskId === id))
      this.writes.softDelete(this.store.attachments, a.id);
    this.writes.softDelete(this.store.tasks, id); // task last
  }

  // --- Plans ---------------------------------------------------------------
  async listPlansForDay(day: string): Promise<TaskPlan[]> {
    return this.alive(this.store.plans)
      .filter((p) => p.day === day)
      .sort((a, b) => a.order - b.order);
  }
  async upsertPlan(input: UpsertPlanInput): Promise<TaskPlan> {
    if (input.id) {
      return this.writes.patch(this.store.plans, input.id, {
        taskId: input.taskId,
        day: input.day,
        plannedMinutes: input.plannedMinutes,
        order: input.order,
      });
    }
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
    if (input.id) {
      return this.writes.patch(this.store.series, input.id, {
        title: input.title,
        categoryId: input.categoryId,
        defaultEstimateMin: input.defaultEstimateMin,
        rule: input.rule,
        anchorDate: input.anchorDate,
        active: input.active ?? true,
      });
    }
    return this.writes.insert(this.store.series, {
      ...this.base(),
      title: input.title,
      categoryId: input.categoryId,
      defaultEstimateMin: input.defaultEstimateMin,
      rule: input.rule,
      anchorDate: input.anchorDate,
      active: input.active ?? true,
    });
  }
  async deactivateSeries(id: string): Promise<TaskSeries> {
    return this.writes.patch(this.store.series, id, { active: false });
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
  async stopSession(id: string, status: 'completed' | 'discarded'): Promise<PomodoroSession> {
    const session = this.mustFind(this.store.sessions, id);
    const next =
      status === 'completed'
        ? completeSession(session, this.now())
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
    if (!task) return;
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
  async getDay(day: string): Promise<Day> {
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
  private materializeDueSeries(day: string): void {
    for (const series of this.alive(this.store.series).filter((s) => s.active)) {
      if (!seriesDueOn(series, day)) continue;
      const already = this.alive(this.store.plans).some(
        (p) => p.day === day && this.find(this.store.tasks, p.taskId)?.seriesId === series.id,
      );
      if (already) continue;
      const task = this.writes.insert(this.store.tasks, {
        ...this.base(),
        title: series.title,
        status: 'planned',
        categoryId: series.categoryId,
        dueDay: null,
        dueTime: null,
        notes: null,
        seriesId: series.id,
        rollId: null,
        estimateMin: series.defaultEstimateMin,
        bufferMin: null,
        estimateLockedMin: null,
        splitFromId: null,
        actualAccruedMin: 0,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        gcalAccountId: null,
        gcalCalendarId: null,
        gcalEventId: null,
        gcalSyncError: null,
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
  async listCategories(): Promise<Category[]> {
    return this.alive(this.store.categories).sort((a, b) => a.order - b.order);
  }
  async upsertCategory(input: UpsertCategoryInput): Promise<Category> {
    if (input.id) {
      const existing = this.mustFind(this.store.categories, input.id);
      return this.writes.patch(this.store.categories, input.id, {
        label: input.label,
        isWork: input.isWork,
        order: input.order ?? existing.order,
        active: input.active ?? existing.active,
      });
    }
    return this.writes.insert(this.store.categories, {
      ...this.base(),
      label: input.label,
      isWork: input.isWork,
      order: input.order ?? this.alive(this.store.categories).length,
      active: input.active ?? true,
    });
  }
  async setCategoryWork(
    id: string,
    isWork: boolean,
    backfillPast: boolean,
  ): Promise<{ category: Category; backfilled: number }> {
    const category = this.writes.patch(this.store.categories, id, { isWork });
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

  // --- Settings ------------------------------------------------------------
  async getSettings(): Promise<Settings> {
    return this.ensureSettings();
  }
  async updateSettings(patch: SettingsPatch): Promise<Settings> {
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
    // Parity with the backend: one live event per task, and only onto a connected account.
    if (task.gcalEventId) throw new Error('Task already has a calendar event');
    if (!this.ensureSettings().googleAccounts.some((a) => a.sub === input.accountSub))
      throw new Error(`No connected account: ${input.accountSub}`);
    return this.writes.patch(this.store.tasks, input.taskId, {
      gcalAccountId: input.accountSub,
      gcalCalendarId: input.calendarId,
      gcalEventId: `stub-event-${this.now()}`,
      gcalManual: true, // a picked time maps to no task field — a pull syncs its title only
      gcalSeen: { title: input.title, startMs: input.startMs, endMs: input.endMs },
      gcalTouchedAt: this.now(),
      gcalPulledAt: null, // a "Removed in Google Calendar" mark no longer holds
      gcalPulledNote: null,
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
        // Stub-only: a linked task with no known event (seeded, or persisted before two-way sync) takes
        // its own block as the known one — the queue is only ever deliberate edits, so the backend's
        // first-sighting "just remember it" would swallow them.
        const task = { ...found, gcalSeen: found.gcalSeen ?? this.knownEvent(found) };
        const action = calendarPullPlan(task, this.stubEvent(task, edit, now), {
          epoch: localEpochFromDayTime,
          clock: localDayTime,
        });
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
                  gcalPulledAt: now,
                  gcalPulledNote: action.note,
                }
              : {
                  gcalAccountId: null,
                  gcalCalendarId: null,
                  gcalEventId: null,
                  gcalSyncError: null,
                  gcalManual: null,
                  gcalSeen: null,
                  gcalPulledAt: now,
                  gcalPulledNote: action.note,
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
  private knownEvent(task: Task): GcalSeen {
    const win = eventWindow(task, localEpochFromDayTime);
    return { title: task.title, startMs: win?.startMs ?? null, endMs: win?.endMs ?? null };
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
    return calibrationTasks(this.alive(this.store.tasks))
      .filter((t) => t.completedAt !== null)
      .map((t) => ({
        taskId: t.id,
        day: dayKey(t.completedAt!, start),
        estimateLockedMin: t.estimateLockedMin!,
        actualAccruedMin: t.actualAccruedMin,
        categoryId: t.categoryId,
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
      leetcodeAttempts: this.alive(this.store.leetcodeAttempts),
      stories: this.alive(this.store.stories),
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
    return bundle satisfies Record<keyof Store, unknown>;
  }
}
