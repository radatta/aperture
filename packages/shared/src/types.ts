// Entity types — storage-agnostic. The single source of truth for the data model,
// shared by the stub (app) and the eventual Lambda. Physical DynamoDB keys are derived
// from these later; nothing here assumes DynamoDB.

import type { AttachmentStatus } from './attachments';
import type { CompetencyTag } from './stories';

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
  // The Roll this task is a "rep" of, when picked from a Roll (see rolls.ts). Nullable — most tasks
  // aren't reps, and pre-existing rows read back as undefined, so readers compare `=== id` / `!rollId`,
  // never `=== null`. The contact-sheet momentum is DERIVED from done tasks carrying this (no counter).
  rollId: string | null;
  // "YYYY-MM-DD" — when it's DUE, distinct from taskPlans.day (when I'll work it). Free metadata,
  // set in the scope pass, editable at any status, never part of the estimate lock.
  dueDay: string | null;
  // "HH:MM" 24h local wall-clock — the deadline's clock time on dueDay. Only ever set WITH dueDay (clearing
  // the day clears it; see due.ts normalizeDue). Pre-existing rows read back undefined, so readers use `!dueTime`.
  dueTime: string | null;
  // Free-form light markdown (see taskNotes.ts), capped at TASK_NOTES_MAX. Editable at any status, never
  // part of the estimate lock. Empty is null; pre-existing rows read back undefined, so readers use `!notes`.
  notes: string | null;
  // The WORKING estimate: editable at any open status (not done/cancelled) — rescoping mid-task is fine.
  estimateMin: number | null;
  bufferMin: number | null;
  // The calibration baseline, frozen on first exit from planning; calibration = actualAccruedMin vs this.
  // Never edited after — a later estimate edit moves estimateMin only. The one exception: a parent whose
  // last part goes is plain again, and the lock frozen for its parts goes with them (parts.ts releaseParent).
  estimateLockedMin: number | null;
  // The task this one is a part of (parts.ts): the parent holds the deadline, its parts hold the work. One
  // level — a parent can't have a parent, a part can't have parts. Parenthood is derived (some task points
  // here), never stored. Pre-existing rows read back undefined → `!parentId`.
  parentId: string | null;
  actualAccruedMin: number; // denormalized; bumped when a work session closes
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  // Google Calendar event pointer — set when "add to calendar" creates a real event, cleared on
  // delete-on-cancel. All three are needed to delete: the event lives on gcalCalendarId, owned by the
  // account gcalAccountId (whose token deletes it). Null when the task has no linked event.
  gcalAccountId: string | null;
  gcalCalendarId: string | null;
  gcalEventId: string | null;
  // The last calendar auto-sync failure, shown on the task with a retry; null once a sync succeeds. The
  // task write itself never fails on gcal (calendarSync.ts). Pre-existing rows read back undefined.
  gcalSyncError: string | null;
  // Two-way sync bookkeeping (calendarPull.ts) — OPTIONAL, unlike the domain fields above: sync state,
  // not task data, so old rows and literals simply lack it (readers use `?? null` / `!x`).
  // gcalSeen: the linked event as Aperture last knew it (what it pushed, or last pulled), with Google's
  // `updated` for that state — the base of a three-way merge. A pull takes from Google only what changed
  // since (a state older than the base is stale); a push sends what the task has that the event doesn't
  // yet (a failed, skipped or toggle-off change). A field both sides changed keeps Aperture's unsent
  // value. Null/absent = not known yet.
  gcalSeen?: GcalSeen | null;
  // gcalPulled: the last change Google made to this task — or kept out of it — and one line saying what.
  // The task shows it until the next day rollover (isPullFresh) or your own edit.
  gcalPulled?: GcalPulled | null;
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

// --- Rolls -----------------------------------------------------------------
// A deadline-free ongoing effort you keep returning to (LeetCode daily, study, work on Aperture) —
// no finish line, no cadence target. Distinct from a Habit (a binary behavior you tap): a Roll is
// timed WORK, and a "rep" is a completed Task tagged with the roll (so calibration rides it). Momentum
// is the forgiving "contact sheet" — DERIVED from those done tasks, never a stored counter or streak.
export interface Roll extends BaseEntity {
  name: string;
  categoryId: string | null; // the rep task inherits it → sessions snapshot wasWork, time budget works
  estimateMin: number | null; // default estimate stamped on each rep task; the form requires it
  active: boolean; // archive = active:false; hidden from pickers, history kept (habits parity)
}

// --- Pomodoro --------------------------------------------------------------
export type SessionKind = 'work' | 'break'; // only `work` accrues to task time + budget
export type SessionStatus = 'running' | 'completed' | 'discarded';

export interface PomodoroSession extends BaseEntity {
  taskId: string | null;
  categoryId: string | null; // follows the task when taskId is set; manual for freeform focus
  label: string | null; // freeform focus name (e.g. "CC: refactor") — how you tell concurrent timers apart
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

// --- Google Calendar accounts (multi-account) ------------------------------
// A connected Google account. `sub` (Google's stable subject id from the id_token) is the account key —
// survives an email change; `email` is display only. The refresh token lives in SSM keyed by `sub`.
export interface GoogleAccount {
  sub: string;
  email: string;
}
// Points at one calendar within one connected account. Used for the shape-read set and the write target.
export interface CalendarRef {
  accountSub: string;
  calendarId: string;
}
// The event's title and window (instants) as Aperture last knew them; times null when not known/all-day.
// updatedMs: Google's `updated` for that state — an event state older than it predates the base.
export interface GcalSeen {
  title: string | null;
  startMs: number | null;
  endMs: number | null;
  updatedMs: number;
}
// The "updated from Google" mark: when, and one short line saying what.
export interface GcalPulled {
  at: number;
  note: string;
}
// Two-way sync cursor, one per connected account (id = sub): the events.list syncToken for its primary
// calendar plus pull health. Exported (like financeSyncStates) — no credentials; a null token means a
// full resync.
export interface GcalSyncState extends BaseEntity {
  sub: string;
  calendarId: string;
  syncToken: string | null;
  lastPulledAt: number | null; // stamped at the START of every attempt — the throttle counts failures
  lastSyncedAt: number | null; // the last pull that finished; null = never
  lastPullError: string | null; // null after a success
  lastPullErrorAt: number | null;
}

// --- Settings (singleton) --------------------------------------------------
export interface Settings extends BaseEntity {
  dayStartHour: number; // default 4 — the day-rollover boundary, NOT the waking window
  pomodoroWorkMin: number; // default 25
  pomodoroBreakMin: number; // default 5
  theme: 'auto' | 'light' | 'dark'; // auto follows home mode
  // Connected Google accounts (personal + school). Written server-side at connect/disconnect; [] when none.
  googleAccounts: GoogleAccount[];
  // Calendars whose events feed the morning shape read, across accounts. [] → shape falls back to manual.
  calendarShapeRefs: CalendarRef[];
  // Default calendar "add to calendar" writes to; per-event override lives in the dialog. null → user picks.
  calendarWriteDefault: CalendarRef | null;
  // Timed tasks auto-create + edit-sync an event on calendarWriteDefault. Off → existing events stay, no syncing.
  autoCalendar: boolean; // default true
  // Waking-window bounds (hours 0–23) for the shape read — SEPARATE from dayStartHour's 4am rollover.
  dayFocusStart: number; // default 8
  dayEndHour: number; // default 22
  // Finances: the budget bucket's limit per billing period, and the card payment day the period falls
  // back to (starting the day after) until you mark a payment (see finance.ts computeFinancePeriod).
  financeBudgetCents: number; // default 60000
  financePaymentDay: number; // default 20
}

// --- Calibration (derived, read-only) -------------------------------------
export interface CalibrationPoint {
  taskId: string;
  day: string; // completion day
  estimateLockedMin: number;
  actualAccruedMin: number;
  categoryId: string | null;
  // > 0 = a done parent's rollup (parts.ts), over this many parts not dropped (the card's "2/2") — each
  // already a point of its own, so the headline skips it to count the work once.
  parts: number;
}

// --- Recruiting: LeetCode attempts -----------------------------------------
// One row per submission, captured by the browser extension. Accepted AND wrong verdicts.
// attempt-count is DERIVED at read time (count per problemSlug) — never a stored counter.
export type LeetcodeVerdict =
  | 'accepted'
  | 'wrong_answer'
  | 'time_limit'
  | 'runtime_error'
  | 'compile_error'
  | 'memory_limit'
  | 'other';

export interface LeetcodeAttempt extends BaseEntity {
  day: string; // YYYY-MM-DD, bucketed via dayStartHour + the client's reported tz offset
  problemSlug: string;
  problemTitle: string;
  verdict: LeetcodeVerdict;
  submittedAt: number; // epoch ms from LeetCode (task_finish_time)
  lang: string;
  runtimeMs: number | null;
  memory: number | null; // bytes
  leetcodeSubmissionId: string; // idempotent dedup key
  frontendId: string | null;
  difficulty: string | null; // 'Easy' | 'Medium' | 'Hard' | null
  topicTags: string[] | null;
}

// --- Recruiting: behavioral story bank -------------------------------------
// A STAR story (Situation/Action/Result), tagged by competency, authored in-app. Structured-at-entry is
// deliberate here — unlike capture elsewhere, a story is a slowly-tightened artifact reused across
// interviews. The tag set is fixed (see COMPETENCY_TAGS); S/A/R may be empty (a title-only stub you fill
// in later is valid).
export interface Story extends BaseEntity {
  title: string;
  competencyTags: CompetencyTag[];
  situation: string;
  action: string;
  result: string;
}

// --- Task attachments ------------------------------------------------------
// A file attached to a task. The bytes live in S3 (never DynamoDB); this is metadata + the pointer.
// `status` is pending at presign and flips to ready once the browser confirms the PUT — a row is never
// listed until its bytes exist. The filename is a display value only; it is NOT part of `s3Key`.
export interface Attachment extends BaseEntity {
  taskId: string;
  filename: string; // sanitized display name
  contentType: string; // normalized; set on the object and forced on the GET response
  size: number; // bytes; signed into the PUT (content-length), so the cap can't be exceeded
  s3Key: string; // u/<userId>/<taskId>/<id>
  status: AttachmentStatus;
}
