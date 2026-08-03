// Entity types — storage-agnostic. The single source of truth for the data model,
// shared by the stub (app) and the eventual Lambda. Physical DynamoDB keys are derived
// from these later; nothing here assumes DynamoDB.

// Every stored item carries these. `deletedAt` is a soft-delete tombstone — we never hard-delete.
// `updatedAt` is the last-write-wins clock for multi-device conflict resolution.
export interface BaseEntity {
  id: string; // ULID
  userId: string;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms — last-write-wins
  deletedAt: number | null; // tombstone; queries filter these out
}

// --- Log -------------------------------------------------------------------
export interface LogEntry extends BaseEntity {
  day: string; // YYYY-MM-DD, bucketed via the day-start offset
  text: string;
}

// --- Tasks -----------------------------------------------------------------
export type TaskStatus = 'backlog' | 'planned' | 'in_progress' | 'done' | 'cancelled';

export interface Task extends BaseEntity {
  title: string;
  status: TaskStatus;
  categoryId: string | null;
  seriesId: string | null; // set when spawned from a recurring series
  // estimateMin / bufferMin are editable ONLY while backlog|planned.
  estimateMin: number | null;
  bufferMin: number | null;
  // Frozen on first exit from planning; calibration = actualAccruedMin vs this. Never edited after.
  estimateLockedMin: number | null;
  actualAccruedMin: number; // denormalized; bumped when a work session closes
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
}

// Scheduling (the *when*), separate from the task (the *what*) → multi-day + ordering.
export interface TaskPlan extends BaseEntity {
  taskId: string;
  day: string;
  plannedMinutes: number;
  order: number;
}

export type RecurrenceRule =
  | { kind: 'daily' }
  | { kind: 'weekdays' } // Mon–Fri
  | { kind: 'weekly'; daysOfWeek: number[] } // 0=Sun … 6=Sat
  | { kind: 'everyN'; interval: number }; // every N days from the anchor

// Recurrence template. Each occurrence is a real Task with seriesId → its own calibration point.
export interface TaskSeries extends BaseEntity {
  title: string;
  categoryId: string | null;
  defaultEstimateMin: number | null;
  rule: RecurrenceRule;
  active: boolean;
  anchorDate: string; // YYYY-MM-DD the rule counts from
}

// --- Ideas (inbox) ---------------------------------------------------------
export type IdeaStatus = 'open' | 'triaged' | 'discarded';
export interface Idea extends BaseEntity {
  text: string;
  status: IdeaStatus;
}

// --- Habits ----------------------------------------------------------------
// Recurring *behaviors*, binary, no estimate — distinct from recurring tasks.
export interface Habit extends BaseEntity {
  name: string;
  categoryId: string | null;
  cadencePerWeek: number; // e.g. 3 = "3×/week"
  active: boolean;
}
export interface HabitCheck extends BaseEntity {
  habitId: string;
  date: string; // YYYY-MM-DD; unique per (habitId, date)
}

// --- Pomodoro --------------------------------------------------------------
export type SessionKind = 'work' | 'break'; // only `work` accrues to task time + budget
export type SessionStatus = 'running' | 'completed' | 'discarded';

export interface PomodoroSession extends BaseEntity {
  taskId: string | null;
  categoryId: string | null; // follows the task when taskId is set; manual for freeform focus
  wasWork: boolean; // snapshot of the category's isWork at write time — immutable history
  kind: SessionKind;
  startedAt: number;
  endedAt: number | null;
  day: string;
  activeMinutes: number; // un-paused time only
  status: SessionStatus;
  lastHeartbeatAt: number; // running sessions persist a heartbeat → no orphans
}

// --- Day (per-day singleton) ----------------------------------------------
export interface Day extends BaseEntity {
  date: string; // YYYY-MM-DD (the key)
  capacityHours: number | null; // v1: a manual number, not calendar-derived
  intent: string | null;
  reflectionPrompt: string | null;
  reflectionText: string | null;
}

// --- Categories ------------------------------------------------------------
// Referenced by id; labels resolve live (renames propagate). isWork is snapshotted onto sessions.
export interface Category extends BaseEntity {
  label: string;
  isWork: boolean;
  order: number;
  active: boolean;
}

// --- Settings (singleton) --------------------------------------------------
export interface Settings extends BaseEntity {
  dayStartHour: number; // default 4
  pomodoroWorkMin: number; // default 25
  pomodoroBreakMin: number; // default 5
  theme: 'auto' | 'light' | 'dark'; // auto follows home mode
}

// --- Calibration (derived, read-only) -------------------------------------
export interface CalibrationPoint {
  taskId: string;
  day: string; // completion day
  estimateLockedMin: number;
  actualAccruedMin: number;
  categoryId: string | null;
}
