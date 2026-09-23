// In-memory ApiClient implementation — the page-first stand-in. Persists to localStorage so a
// refresh keeps state. The real Lambda (Phase 10) implements the SAME interface; swapping is one
// module. Two things are deliberately faithful so this validates the product, not a toy:
//   - the WRITES-OBJECT seam: every mutation funnels through `writes` (single audit point), mirroring
//     the Lambda rule that guarantees no stray side effects.
//   - LAZY recurrence: due series occurrences materialize on getDay(), exactly like the Lambda will.
//   - LAZY stale sweep: getDay() also returns planned tasks with no plan row on/after the day to backlog.

import {
  assertAttachmentAllowed,
  assertCategoryDeletable,
  completeSession,
  countsTowardCap,
  createUlid,
  dayKey,
  dayKeyForOffset,
  discardSession,
  findOpenRollTask,
  heartbeatSession,
  normalizeContentType,
  normalizeVerdict,
  resolveStaleSession,
  resumeSession,
  ROLL_PLAN_FALLBACK_MIN,
  rollRepFields,
  sanitizeFilename,
  seriesDueOn,
  splitFollowUp,
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
  CreateTaskInput,
  DateRange,
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
    settings: null,
  };
}

export interface StubOptions {
  now?: () => number;
  storageKey?: string;
  seed?: boolean;
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
      if (opts.seed !== false) seedStore(this.store, this.now(), this.ulid);
      this.persist();
    }
  }

  // --- persistence ---------------------------------------------------------
  private load(): Store | null {
    try {
      const raw = globalThis.localStorage?.getItem(this.key);
      // Coalesce over emptyStore() so a pre-existing persisted store gains new collections (e.g.
      // leetcodeAttempts) without a wipe or an undefined.push crash.
      return raw ? { ...emptyStore(), ...(JSON.parse(raw) as Partial<Store>) } : null;
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
      dueDay: input.dueDay ?? null,
      seriesId: null,
      rollId: null,
      estimateMin: input.estimateMin ?? null,
      bufferMin: input.bufferMin ?? null,
      estimateLockedMin: null,
      actualAccruedMin: 0,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
    };
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
      dayFocusStart: 8,
      dayEndHour: 22,
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
    return this.writes.insert(this.store.tasks, this.newTask(input, this.now()));
  }
  async createTasks(inputs: CreateTaskInput[]): Promise<Task[]> {
    const t = this.now();
    return inputs.map((input) => this.writes.insert(this.store.tasks, this.newTask(input, t)));
  }
  async setTaskEstimate(
    id: string,
    estimateMin: number | null,
    bufferMin: number | null,
  ): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
    return this.writes.put(
      this.store.tasks,
      withEstimate(task, estimateMin, bufferMin, this.now()),
    );
  }
  async setTaskCategory(id: string, categoryId: string | null): Promise<Task> {
    return this.writes.patch(this.store.tasks, id, { categoryId });
  }
  async setTaskDueDay(id: string, dueDay: string | null): Promise<Task> {
    return this.writes.patch(this.store.tasks, id, { dueDay });
  }
  async setTaskTitle(id: string, title: string): Promise<Task> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('Title is required');
    return this.writes.patch(this.store.tasks, id, { title: trimmed });
  }
  async transitionTask(id: string, to: TaskStatus): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
    const next = this.writes.put(this.store.tasks, taskTransition(task, to, this.now()));
    // Delete-on-cancel parity with the backend: dropping a task clears its calendar event pointers.
    if (to === 'cancelled' && task.gcalEventId) return this.deleteCalendarEvent(id);
    return next;
  }
  async setTaskActual(id: string, actualMin: number): Promise<Task> {
    return this.writes.patch(this.store.tasks, id, { actualAccruedMin: actualMin });
  }
  async splitTask(
    id: string,
    finishStatus: 'done' | 'cancelled',
    followUpTitle: string,
  ): Promise<{ original: Task; followUp: Task }> {
    const task = this.mustFind(this.store.tasks, id);
    const original = this.writes.put(
      this.store.tasks,
      taskTransition(task, finishStatus, this.now()),
    );
    const followUp = this.writes.insert(this.store.tasks, {
      ...this.base(),
      ...splitFollowUp(task, followUpTitle),
    });
    return { original, followUp };
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
        seriesId: series.id,
        rollId: null,
        estimateMin: series.defaultEstimateMin,
        bufferMin: null,
        estimateLockedMin: null,
        actualAccruedMin: 0,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        gcalAccountId: null,
        gcalCalendarId: null,
        gcalEventId: null,
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
      accounts: this.ensureSettings().googleAccounts.map((a) => ({
        sub: a.sub,
        email: a.email,
        connected: true,
        reconnectRequired: false,
      })),
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
    });
  }
  async deleteCalendarEvent(taskId: string): Promise<Task> {
    this.mustFind(this.store.tasks, taskId);
    return this.writes.patch(this.store.tasks, taskId, {
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
    });
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
    this.persist();
  }

  // --- Calibration ---------------------------------------------------------
  async getCalibration(range: DateRange): Promise<CalibrationPoint[]> {
    const start = this.dayStartHour();
    return this.alive(this.store.tasks)
      .filter((t) => t.status === 'done' && t.estimateLockedMin !== null && t.completedAt !== null)
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
