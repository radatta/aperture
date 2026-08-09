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
  Task,
  TaskPlan,
  TaskSeries,
  TaskStatus,
  UpsertCategoryInput,
  UpsertHabitInput,
  UpsertPlanInput,
  UpsertSeriesInput,
} from '@aperture/shared';
import type { Repo } from './ddb/repo';

export interface BackendOptions {
  userId?: string;
  now?: () => number;
}

// The server-side ApiClient — the SAME contract as the stub, over the DynamoDB Repo. Business rules
// come straight from the shared machines (taskTransition/withEstimate/split/heartbeat/…), so lifecycle
// behavior is identical to the stub by construction. The one thing SK order doesn't give for free is
// the stub's explicit list sorts, so each list method re-applies them for byte-for-byte parity.
export class BackendClient implements ApiClient {
  private readonly userId: string;
  private readonly now: () => number;
  private readonly ulid: () => string;

  constructor(
    private readonly repo: Repo,
    opts: BackendOptions = {},
  ) {
    this.userId = opts.userId ?? 'local';
    this.now = opts.now ?? (() => Date.now());
    this.ulid = createUlid(this.now);
  }

  private base(): BaseEntity {
    const t = this.now();
    return { id: this.ulid(), userId: this.userId, createdAt: t, updatedAt: t, deletedAt: null };
  }
  private async ensureSettings(): Promise<Settings> {
    const row = await this.repo.getSettingsRow();
    if (row) return row;
    const def: Settings = {
      ...this.base(),
      dayStartHour: 4,
      pomodoroWorkMin: 25,
      pomodoroBreakMin: 5,
      theme: 'auto',
    };
    await this.repo.putSettings(def);
    return def;
  }
  private async mustTask(id: string): Promise<Task> {
    const t = await this.repo.getTask(id);
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
    const e = await this.repo.findLog(id);
    if (!e) throw new Error(`Not found: ${id}`);
    return this.repo.putLog({ ...e, text, updatedAt: this.now() });
  }

  // --- Recruiting (LeetCode) ---
  async recordLeetcodeAttempt(input: RecordLeetcodeAttemptInput): Promise<LeetcodeAttempt> {
    // The extension queries LeetCode's /graphql/ (problem metadata) once per captured submission — the
    // one ToS-sensitive call. Log every ingest so we can count how often it happens via a Logs Insights
    // query. CloudWatch Logs is free at our scale; a custom metric ($0.30/mo) would be the biggest cost
    // in the project, so we deliberately don't emit one.
    console.log(JSON.stringify({ event: 'leetcode_graphql_query', problemSlug: input.problemSlug }));
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
    return this.repo.putTask({
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
    return this.repo.putTask(
      withEstimate(await this.mustTask(id), estimateMin, bufferMin, this.now()),
    );
  }
  async setTaskCategory(id: string, categoryId: string | null): Promise<Task> {
    const t = await this.mustTask(id);
    return this.repo.putTask({ ...t, categoryId, updatedAt: this.now() });
  }
  async transitionTask(id: string, to: TaskStatus): Promise<Task> {
    return this.repo.putTask(taskTransition(await this.mustTask(id), to, this.now()));
  }
  async setTaskActual(id: string, actualMin: number): Promise<Task> {
    const t = await this.mustTask(id);
    return this.repo.putTask({ ...t, actualAccruedMin: actualMin, updatedAt: this.now() });
  }
  async splitTask(
    id: string,
    finishStatus: 'done' | 'cancelled',
    followUpTitle: string,
  ): Promise<{ original: Task; followUp: Task }> {
    const task = await this.mustTask(id);
    const original = await this.repo.putTask(taskTransition(task, finishStatus, this.now()));
    const followUp = await this.repo.putTask({
      ...this.base(),
      ...splitFollowUp(task, followUpTitle),
    });
    return { original, followUp };
  }

  // --- Plans ---
  async listPlansForDay(day: string): Promise<TaskPlan[]> {
    return (await this.repo.listPlans(day)).sort((a, b) => a.order - b.order);
  }
  async upsertPlan(input: UpsertPlanInput): Promise<TaskPlan> {
    const fields = {
      taskId: input.taskId,
      day: input.day,
      plannedMinutes: input.plannedMinutes,
      order: input.order,
    };
    if (input.id) {
      const existing = await this.repo.findPlan(input.id);
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putPlan({ ...existing, ...fields, updatedAt: this.now() }, existing);
    }
    return this.repo.putPlan({ ...this.base(), ...fields });
  }
  async removePlan(id: string): Promise<void> {
    const existing = await this.repo.findPlan(id);
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
    };
    if (input.id) {
      const existing = await this.repo.getSeries(input.id);
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putSeries({ ...existing, ...fields, updatedAt: this.now() });
    }
    return this.repo.putSeries({ ...this.base(), ...fields });
  }
  async deactivateSeries(id: string): Promise<TaskSeries> {
    const existing = await this.repo.getSeries(id);
    if (!existing) throw new Error(`Not found: ${id}`);
    return this.repo.putSeries({ ...existing, active: false, updatedAt: this.now() });
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
    const task = await this.repo.getTask(session.taskId);
    if (!task) return;
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
      const existing = await this.repo.getHabit(input.id);
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putHabit({ ...existing, ...fields, updatedAt: this.now() });
    }
    return this.repo.putHabit({ ...this.base(), ...fields });
  }
  async checkHabit(habitId: string, date: string): Promise<HabitCheck> {
    const existing = await this.repo.getCheck(date, habitId);
    if (existing) return existing;
    return this.repo.putCheck({ ...this.base(), habitId, date }, date, habitId);
  }
  async uncheckHabit(habitId: string, date: string): Promise<void> {
    const existing = await this.repo.getCheck(date, habitId);
    if (existing) await this.repo.deleteCheck(date, habitId);
  }
  async listHabitChecks(range: DateRange): Promise<HabitCheck[]> {
    return this.repo.listChecks(range.from, range.to);
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
    const existing = await this.repo.getIdea(id);
    if (!existing) throw new Error(`Not found: ${id}`);
    return this.repo.putIdea({ ...existing, status, updatedAt: this.now() });
  }

  // --- Day (lazy recurrence on read) ---
  async getDay(day: string): Promise<Day> {
    await this.materializeDueSeries(day);
    const existing = await this.repo.getDayRow(day);
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
  private async materializeDueSeries(day: string): Promise<void> {
    const active = (await this.repo.listSeries()).filter((s) => s.active);
    if (active.length === 0) return;
    const plans = await this.repo.listPlans(day);
    const seriesIdsOnDay = new Set<string>();
    for (const p of plans) {
      const t = await this.repo.getTask(p.taskId);
      if (t?.seriesId) seriesIdsOnDay.add(t.seriesId);
    }
    for (const series of active) {
      if (!seriesDueOn(series, day)) continue;
      if (seriesIdsOnDay.has(series.id)) continue;
      const task = await this.repo.putTask({
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
      await this.repo.putPlan({
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
    return this.repo.putDay({ ...d, capacityHours, updatedAt: this.now() });
  }
  async setDayIntent(day: string, intent: string): Promise<Day> {
    const d = await this.getDay(day);
    return this.repo.putDay({ ...d, intent, updatedAt: this.now() });
  }
  async setDayReflection(day: string, prompt: string, text: string): Promise<Day> {
    const d = await this.getDay(day);
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
      const existing = await this.repo.getCategory(input.id);
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putCategory({
        ...existing,
        label: input.label,
        isWork: input.isWork,
        order: input.order ?? 0,
        active: input.active ?? true,
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
    const existing = await this.repo.getCategory(id);
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
    const tasks = (await this.repo.listTasks()).filter((t) => t.categoryId === id);
    const habits = (await this.repo.listHabits()).filter((h) => h.categoryId === id);
    const series = (await this.repo.listSeries()).filter((s) => s.categoryId === id);
    assertCategoryDeletable(tasks.length + habits.length + series.length, reassignToId);
    for (const t of tasks)
      await this.repo.putTask({ ...t, categoryId: reassignToId, updatedAt: this.now() });
    for (const h of habits)
      await this.repo.putHabit({ ...h, categoryId: reassignToId, updatedAt: this.now() });
    for (const s of series)
      await this.repo.putSeries({ ...s, categoryId: reassignToId, updatedAt: this.now() });
    const cat = await this.repo.getCategory(id);
    if (cat) await this.repo.putCategory({ ...cat, deletedAt: this.now(), updatedAt: this.now() });
  }

  // --- Settings ---
  async getSettings(): Promise<Settings> {
    return this.ensureSettings();
  }
  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const current = await this.ensureSettings();
    return this.repo.putSettings({ ...current, ...patch, updatedAt: this.now() });
  }

  // --- Calibration ---
  // Parity with the stub: filter done+locked tasks by their completion DAY (dayStartHour offset).
  // TODO(scale, pre-deploy): swap the full task scan for `repo.doneTasksInWindow` over the GSI once the
  // day-range → epoch-window mapping (with the offset) is nailed down.
  async getCalibration(range: DateRange): Promise<CalibrationPoint[]> {
    const start = (await this.ensureSettings()).dayStartHour;
    return (await this.repo.listTasks())
      .filter((t) => t.status === 'done' && t.estimateLockedMin !== null && t.completedAt !== null)
      .map((t) => ({
        taskId: t.id,
        day: dayKey(t.completedAt as number, start),
        estimateLockedMin: t.estimateLockedMin as number,
        actualAccruedMin: t.actualAccruedMin,
        categoryId: t.categoryId,
      }))
      .filter((p) => p.day >= range.from && p.day <= range.to)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  async exportData(): Promise<unknown> {
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
      sessions: await this.repo.listAllSessions(),
      days: await this.repo.listAllDays(),
      categories: await this.repo.listCategories(),
      settings: await this.ensureSettings(),
    };
  }
}
