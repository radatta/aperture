// The ApiClient contract — the seam. ONE interface, implemented twice: the in-memory stub
// (Phase 1) and the real Lambda (Phase 10). The app only ever talks to this interface, so
// swapping stub → real is one module. Contract tests (Phase 10) run both against this shape.
//
// All methods are async (the real impl is a network call). Time/day bucketing is the impl's
// job — callers pass intent (text, ids), not timestamps.

import type {
  Attachment,
  CalibrationPoint,
  Category,
  Day,
  Habit,
  HabitCheck,
  Idea,
  IdeaStatus,
  LeetcodeAttempt,
  LogEntry,
  PomodoroSession,
  RecurrenceRule,
  SessionKind,
  Settings,
  Story,
  Task,
  TaskPlan,
  TaskSeries,
  TaskStatus,
} from './types';
import type { CompetencyTag } from './stories';
import type { CalendarBusy } from './calendar';

export interface CreateTaskInput {
  title: string;
  categoryId?: string | null;
  estimateMin?: number | null;
  bufferMin?: number | null;
  dueDay?: string | null; // day-granular deadline; honored by both creates — bulk-add sets it, no single-create caller does yet
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
  day: string; // client's local day-key. The client owns "today" — the server runs in UTC and must not derive it.
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

// Story bank: create takes a title (required — it's the list row); S/A/R and tags default to empty, so a
// title-only stub is valid. Update is a whole-object patch (the editor saves the form at once), never
// per-field setters.
export interface CreateStoryInput {
  title: string;
  competencyTags?: CompetencyTag[];
  situation?: string;
  action?: string;
  result?: string;
}
export type StoryPatch = Partial<
  Pick<Story, 'title' | 'competencyTags' | 'situation' | 'action' | 'result'>
>;

// Task attachments: the client declares the file's shape (name/type/size) and the server mints a
// presigned PUT scoped to exactly that size + type. The bytes go browser→S3 directly; nothing here
// carries binary. size/contentType are what get signed, so the server — not the client — is authoritative.
export interface CreateAttachmentInput {
  taskId: string;
  filename: string;
  contentType: string;
  size: number;
}

// The browser extension ships raw signals; the server owns verdict normalization + day bucketing.
// tzOffsetMinutes = the client's getTimezoneOffset() — the server owns dayStartHour, so a foreign
// client can't compute the final day-key itself (why this isn't the createLogEntry(day) shape).
export interface RecordLeetcodeAttemptInput {
  leetcodeSubmissionId: string; // idempotent dedup key
  problemSlug: string;
  problemTitle: string;
  statusCode?: number | null; // raw LeetCode status_code (primary verdict signal)
  statusMsg?: string | null; // raw status_msg (fallback)
  submittedAt: number; // epoch ms (LeetCode task_finish_time)
  tzOffsetMinutes: number;
  lang: string;
  runtimeMs?: number | null;
  memory?: number | null; // bytes
  frontendId?: string | null;
  difficulty?: string | null;
  topicTags?: string[] | null;
}

// The full export snapshot. Every collection is REQUIRED, and that's the point: the two ApiClient
// impls build this differently (the stub from its in-memory store, the backend from enumerated repo
// reads), and a missing collection used to be invisible — leetcodeAttempts shipped absent from the
// real export while the stub looked fine. With both returning an object literal typed as this,
// omitting a key AND adding a stray one are compile errors.
//
// Soft-deleted rows are EXCLUDED (see the export contract test). That's the right call while the
// export is a one-way download; if an import/restore path ever lands it will need tombstones for
// merge, plus a versioned envelope — revisit here at that point, not before.
export interface ExportBundle {
  exportedAt: number;
  userId: string;
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
  attachments: Attachment[]; // metadata only — the bytes stay in S3, not in the export
  settings: Settings; // always materialised — never the stub's nullable storage state
}

// googleAccounts is deliberately absent — the connected-account list is mutated server-side only (the
// OAuth callback adds, disconnectGoogleAccount removes), never patched directly by the client.
export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'dayStartHour'
    | 'pomodoroWorkMin'
    | 'pomodoroBreakMin'
    | 'theme'
    | 'calendarShapeRefs'
    | 'calendarWriteDefault'
    | 'dayFocusStart'
    | 'dayEndHour'
  >
>;

// --- Google Calendar DTOs --------------------------------------------------
// One calendar in the picker, tagged with the account it belongs to (calendarList.list per account).
export interface GoogleCalendar {
  accountSub: string;
  calendarId: string;
  summary: string;
  primary: boolean;
}
// Per-account connection health. `connected` = a token exists; `reconnectRequired` = the token exists
// but last failed with invalid_grant (mirrors the Cognito renewal model — a recoverable expected state).
export interface GoogleAccountStatus {
  sub: string;
  email: string;
  connected: boolean;
  reconnectRequired: boolean;
}
export interface GoogleStatus {
  accounts: GoogleAccountStatus[];
}
// Shape read: the client computes and sends the window bounds (epoch ms) — the Lambda is UTC and does
// no date math. `day` is the client's local day-key, for logging/parity with other day-scoped reads.
export interface GetCalendarBusyInput {
  day: string;
  windowStartMs: number;
  windowEndMs: number;
}
// Event write, routed to the target calendar's owning account. Time feeds the event ONLY — never
// denormalized onto the task (the task stays day-granular; gcal is the source of record for the clock).
export interface InsertCalendarEventInput {
  taskId: string;
  accountSub: string;
  calendarId: string;
  title: string;
  startMs: number;
  endMs: number;
}

export interface ApiClient {
  // Log
  listLogEntries(day: string): Promise<LogEntry[]>;
  // day = client's local day-key; the server is UTC and must bucket by the value the client reads back with.
  createLogEntry(text: string, day: string): Promise<LogEntry>;
  updateLogEntry(id: string, text: string): Promise<LogEntry>;

  // Tasks
  listBacklog(): Promise<Task[]>;
  // All live tasks (any status) — a task# prefix read; views filter by status client/Lambda-side.
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: CreateTaskInput): Promise<Task>;
  // Bulk create — every input lands as an unlocked backlog task, in the given order (one createdAt
  // stamp for the batch so they sort together). Best-effort over batchPut; empty input writes nothing.
  createTasks(inputs: CreateTaskInput[]): Promise<Task[]>;
  setTaskEstimate(id: string, estimateMin: number | null, bufferMin: number | null): Promise<Task>;
  // Category can change any time — labels resolve live and wasWork is snapshotted on sessions, so
  // there's no freeze constraint here (unlike the estimate).
  setTaskCategory(id: string, categoryId: string | null): Promise<Task>;
  // Deadline metadata (day-granular). Settable at ANY status — a moved deadline is not a scope
  // change, so this never touches estimateLockedMin.
  setTaskDueDay(id: string, dueDay: string | null): Promise<Task>;
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

  // Google Calendar (multi-account). Connect is a browser redirect (GET /api/google/callback, outside
  // this RPC surface); these are the RPC methods. Every read/write is gated (noop in testMode) so a
  // smoke run touches no real token, event, or SSM param.
  googleConnectUrl(): Promise<{ url: string }>; // consent URL w/ signed state — Connect AND Add-account
  getGoogleStatus(): Promise<GoogleStatus>; // per-account connected / reconnectRequired
  listGoogleCalendars(): Promise<GoogleCalendar[]>; // calendarList across all connected accounts
  getCalendarBusy(input: GetCalendarBusyInput): Promise<CalendarBusy>; // raw intervals; client computes shape
  insertCalendarEvent(input: InsertCalendarEventInput): Promise<Task>; // creates the event, stores pointers
  deleteCalendarEvent(taskId: string): Promise<Task>; // delete-on-cancel; clears the pointers
  disconnectGoogleAccount(accountSub: string): Promise<void>; // drop the token + settings entry

  // Calibration (derived, read-only)
  getCalibration(range: DateRange): Promise<CalibrationPoint[]>;

  // Recruiting (LeetCode) — attempts captured by the browser extension (device-token auth on the write).
  // Idempotent on leetcodeSubmissionId; listLeetcodeAttempts is derived/read-only, reverse-chron.
  recordLeetcodeAttempt(input: RecordLeetcodeAttemptInput): Promise<LeetcodeAttempt>;
  listLeetcodeAttempts(range?: DateRange): Promise<LeetcodeAttempt[]>;

  // Behavioral story bank — STAR stories authored in-app, tagged by competency. list is alive-filtered,
  // updatedAt desc; delete is a soft-delete (tombstoned, filtered from list).
  listStories(): Promise<Story[]>;
  createStory(input: CreateStoryInput): Promise<Story>;
  updateStory(id: string, patch: StoryPatch): Promise<Story>;
  deleteStory(id: string): Promise<void>;

  // Task attachments — bytes never cross the BFF. The Lambda mints presigned URLs; the browser PUTs the
  // file to S3, then confirms (pending → ready). Downloads are minted per view, short-lived. delete is a
  // soft-delete of the metadata; the S3 object is orphaned (no bytes-cleanup path in v1).
  createAttachmentUploadUrl(
    input: CreateAttachmentInput,
  ): Promise<{ attachment: Attachment; uploadUrl: string }>;
  confirmAttachment(id: string): Promise<Attachment>; // pending → ready; idempotent
  listAttachments(taskId?: string): Promise<Attachment[]>; // ready + alive; all tasks when omitted
  getAttachmentDownloadUrl(id: string): Promise<string>; // short-lived, minted per view
  deleteAttachment(id: string): Promise<void>;

  // Full data export (JSON) — the user owns their data. A snapshot of every entity.
  exportData(): Promise<ExportBundle>;
}
