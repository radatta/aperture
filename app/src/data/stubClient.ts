// In-memory ApiClient implementation — the page-first stand-in. Persists to localStorage so a
// refresh keeps state. The real Lambda (Phase 10) implements the SAME interface; swapping is one
// module. Two things are deliberately faithful so this validates the product, not a toy:
//   - the WRITES-OBJECT seam: every mutation funnels through `writes` (single audit point), mirroring
//     the Lambda rule that guarantees no stray side effects.
//   - LAZY recurrence: due series occurrences materialize on getDay(), exactly like the Lambda will.

import {
  assertCategoryDeletable,
  completeSession,
  createUlid,
  dayKey,
  dayKeyForOffset,
  discardSession,
  heartbeatSession,
  normalizeVerdict,
  resolveStaleSession,
  resumeSession,
  seriesDueOn,
  splitFollowUp,
  taskTransition,
  withEstimate,
} from '@aperture/shared';
import type {
  ApiClient,
  BaseEntity,
  CalibrationPoint,
  Category,
  CreateTaskInput,
  DateRange,
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
  sessions: PomodoroSession[];
  days: Day[];
  categories: Category[];
  leetcodeAttempts: LeetcodeAttempt[];
  stories: Story[];
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
    sessions: [],
    days: [],
    categories: [],
    leetcodeAttempts: [],
    stories: [],
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
  private base(): BaseEntity {
    const t = this.now();
    return { id: this.ulid(), userId: USER_ID, createdAt: t, updatedAt: t, deletedAt: null };
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
    return this.writes.insert(this.store.tasks, {
      ...this.base(),
      title: input.title,
      status: 'backlog',
      categoryId: input.categoryId ?? null,
      seriesId: null,
      estimateMin: input.estimateMin ?? null,
      bufferMin: input.bufferMin ?? null,
      estimateLockedMin: null,
      actualAccruedMin: 0,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
    });
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
  async transitionTask(id: string, to: TaskStatus): Promise<Task> {
    const task = this.mustFind(this.store.tasks, id);
    return this.writes.put(this.store.tasks, taskTransition(task, to, this.now()));
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

  // --- Day (lazy recurrence on read) ---------------------------------------
  async getDay(day: string): Promise<Day> {
    this.materializeDueSeries(day);
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
        seriesId: series.id,
        estimateMin: series.defaultEstimateMin,
        bufferMin: null,
        estimateLockedMin: null,
        actualAccruedMin: 0,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
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
      return this.writes.patch(this.store.categories, input.id, {
        label: input.label,
        isWork: input.isWork,
        order: input.order ?? 0,
        active: input.active ?? true,
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
      sessions: this.alive(this.store.sessions),
      days: this.alive(this.store.days),
      categories: this.alive(this.store.categories),
      leetcodeAttempts: this.alive(this.store.leetcodeAttempts),
      stories: this.alive(this.store.stories),
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
