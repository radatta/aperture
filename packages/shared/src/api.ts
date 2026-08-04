// The ApiClient contract — the seam. ONE interface, implemented twice: the in-memory stub
// (Phase 1) and the real Lambda (Phase 10). The app only ever talks to this interface, so
// swapping stub → real is one module. Contract tests (Phase 10) run both against this shape.
//
// All methods are async (the real impl is a network call). Time/day bucketing is the impl's
// job — callers pass intent (text, ids), not timestamps.

import type {
  CalibrationPoint,
  Category,
  Day,
  Habit,
  HabitCheck,
  Idea,
  IdeaStatus,
  LogEntry,
  PomodoroSession,
  RecurrenceRule,
  SessionKind,
  Settings,
  Task,
  TaskPlan,
  TaskSeries,
  TaskStatus,
} from './types';

export interface CreateTaskInput {
  title: string;
  categoryId?: string | null;
  estimateMin?: number | null;
  bufferMin?: number | null;
}

export interface UpsertPlanInput {
  id?: string;
  taskId: string;
  day: string;
  plannedMinutes: number;
  order: number;
}

export interface UpsertSeriesInput {
  id?: string;
  title: string;
  categoryId: string | null;
  defaultEstimateMin: number | null;
  rule: RecurrenceRule;
  anchorDate: string;
  active?: boolean;
}

export interface StartSessionInput {
  taskId: string | null;
  categoryId: string | null;
  kind: SessionKind;
  label?: string | null; // freeform focus name for ad-hoc parallel work (e.g. "CC: refactor")
}

export interface UpsertHabitInput {
  id?: string;
  name: string;
  categoryId: string | null;
  cadencePerWeek: number;
  active?: boolean;
}

export interface UpsertCategoryInput {
  id?: string;
  label: string;
  isWork: boolean;
  order?: number;
  active?: boolean;
}

export interface DateRange {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
}

export type SettingsPatch = Partial<
  Pick<Settings, 'dayStartHour' | 'pomodoroWorkMin' | 'pomodoroBreakMin' | 'theme'>
>;

export interface ApiClient {
  // Log
  listLogEntries(day: string): Promise<LogEntry[]>;
  createLogEntry(text: string): Promise<LogEntry>;
  updateLogEntry(id: string, text: string): Promise<LogEntry>;

  // Tasks
  listBacklog(): Promise<Task[]>;
  // All live tasks (any status) — a task# prefix read; views filter by status client/Lambda-side.
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: CreateTaskInput): Promise<Task>;
  setTaskEstimate(id: string, estimateMin: number | null, bufferMin: number | null): Promise<Task>;
  // Category can change any time — labels resolve live and wasWork is snapshotted on sessions, so
  // there's no freeze constraint here (unlike the estimate).
  setTaskCategory(id: string, categoryId: string | null): Promise<Task>;
  transitionTask(id: string, to: TaskStatus): Promise<Task>;
  setTaskActual(id: string, actualMin: number): Promise<Task>;
  // Scope change: finish/cancel the original and spawn a follow-up (never edit a locked estimate).
  splitTask(
    id: string,
    finishStatus: 'done' | 'cancelled',
    followUpTitle: string,
  ): Promise<{ original: Task; followUp: Task }>;

  // Plans (scheduling)
  listPlansForDay(day: string): Promise<TaskPlan[]>;
  upsertPlan(input: UpsertPlanInput): Promise<TaskPlan>;
  removePlan(id: string): Promise<void>;

  // Series (recurrence)
  listSeries(): Promise<TaskSeries[]>;
  upsertSeries(input: UpsertSeriesInput): Promise<TaskSeries>;
  deactivateSeries(id: string): Promise<TaskSeries>;

  // Sessions (pomodoro)
  startSession(input: StartSessionInput): Promise<PomodoroSession>;
  heartbeatSession(id: string): Promise<PomodoroSession>; // also used to capture time up to a pause
  resumeSession(id: string): Promise<PomodoroSession>; // reset the clock after a pause (no accrual)
  stopSession(id: string, status: 'completed' | 'discarded'): Promise<PomodoroSession>;
  listSessionsForDay(day: string): Promise<PomodoroSession[]>;
  findRunningSession(): Promise<PomodoroSession | null>; // first running (kept for single-session callers)
  listRunningSessions(): Promise<PomodoroSession[]>; // ALL concurrently-running timers

  resolveStaleSession(id: string, decision: 'keep' | 'discard'): Promise<PomodoroSession>;

  // Habits
  listHabits(): Promise<Habit[]>;
  upsertHabit(input: UpsertHabitInput): Promise<Habit>;
  checkHabit(habitId: string, date: string): Promise<HabitCheck>;
  uncheckHabit(habitId: string, date: string): Promise<void>;
  listHabitChecks(range: DateRange): Promise<HabitCheck[]>;

  // Ideas (inbox)
  listIdeas(status?: IdeaStatus): Promise<Idea[]>;
  createIdea(text: string): Promise<Idea>;
  triageIdea(id: string, status: IdeaStatus): Promise<Idea>;

  // Day (singleton per date; getDay lazily materializes due recurrence)
  getDay(day: string): Promise<Day>;
  setDayCapacity(day: string, capacityHours: number | null): Promise<Day>;
  setDayIntent(day: string, intent: string): Promise<Day>;
  setDayReflection(day: string, prompt: string, text: string): Promise<Day>;

  // Categories
  listCategories(): Promise<Category[]>;
  upsertCategory(input: UpsertCategoryInput): Promise<Category>;
  // Flip isWork. wasWork is a snapshot on past sessions (immutable history) — backfillPast is the
  // explicit opt-in to reclassify them anyway; returns how many were changed.
  setCategoryWork(
    id: string,
    isWork: boolean,
    backfillPast: boolean,
  ): Promise<{ category: Category; backfilled: number }>;
  deleteCategory(id: string, reassignToId: string | null): Promise<void>;

  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;

  // Calibration (derived, read-only)
  getCalibration(range: DateRange): Promise<CalibrationPoint[]>;

  // Full data export (JSON) — the user owns their data. A snapshot of every entity.
  exportData(): Promise<unknown>;
}
