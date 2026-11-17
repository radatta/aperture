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
  FluxDelegate,
  FluxSet,
  FluxSide,
  GcalSyncState,
  Habit,
  HabitCheck,
  Idea,
  IdeaStatus,
  LeetcodeProblem,
  LogEntry,
  Place,
  PomodoroSession,
  RecurrenceRule,
  Roll,
  SessionKind,
  Settings,
  Sitting,
  SittingEvent,
  SittingHeadRow,
  SittingLive,
  SittingReplayChunk,
  Story,
  Task,
  TaskPlan,
  TaskSeries,
  TaskStatus,
  FluxWeekNote,
} from './types';
import type { Area } from './areas';
import type { CompetencyTag } from './stories';
import type { CalendarBusy } from './calendar';
import type { Condition, Euler, ExerciseKind } from './flux/types';
import type { ParseTaskResult } from './quickParse';
import type {
  ReviewDraft,
  SittingEventsInput,
  SittingEventsResult,
  SittingReviewInput,
  SittingStartInput,
  SittingStartResult,
} from './sittings';
import type { PlaceDigest, PlaceTokenStatus, UpsertPlaceInput } from './places';
import type { ScopedTokenInfo, TokenScope } from './capture';
import type { PushDevice, PushStatus, SubscribePushInput } from './reminders';
import type {
  CreateLinkTokenInput,
  ExchangePublicTokenInput,
  FinanceAccount,
  FinanceAccountPatch,
  FinanceItem,
  FinanceOverview,
  FinancePeriodOverride,
  FinanceRule,
  FinanceSyncState,
  FinanceTransaction,
  LinkTokenResult,
  RequestFinanceSyncResult,
  SetFinanceBucketInput,
  UpsertFinanceRuleInput,
} from './finance';

export interface CreateTaskInput {
  title: string;
  categoryId?: string | null;
  estimateMin?: number | null;
  bufferMin?: number | null;
  dueDay?: string | null; // day-granular deadline; honored by both creates — bulk-add and capture tokens set it
  dueTime?: string | null; // "HH:MM" on dueDay; requires dueDay (normalizeDue). A timed task auto-syncs to gcal
  notes?: string | null; // normalized like setTaskNotes; createTasks rejects the whole batch if any is over the cap
  parentId?: string | null; // a part of that task (parts.ts); createTasks validates every one before any write
  // A Place slug (places.ts); an unknown slug is refused — createTasks before any write. A part takes its
  // parent's place: omitted/null inherits it, a different slug is refused (PLACE_PART_ERROR).
  place?: string | null;
}

// The deadline as one write. Object-shaped (not positional) so an OMITTED dueTime survives JSON: absent
// = keep the task's current time; null = clear it. dueDay null always clears the time too.
export interface SetTaskDueInput {
  dueDay: string | null;
  dueTime?: string | null;
}

// A split (split.ts): this part finishes ('done') or keeps going ('keep'), and the rest becomes a new part.
// Object-shaped like SetTaskDueInput — an omitted title/estimate keeps the original's. A standalone task
// becomes Part 1 under a NEW parent (titled parentTitle, else the task's own title), so its title defaults to
// STANDALONE_PART_TITLE; a part just gains a sibling.
export interface SplitTaskInput {
  finish: 'done' | 'keep';
  title?: string;
  estimateMin?: number | null;
  bufferMin?: number | null;
  actualMin?: number; // 'done' only — this part's actual; omitted keeps what accrued
  parentTitle?: string; // standalone only — the new parent's title
  followUp: { title: string; estimateMin: number | null; bufferMin?: number | null };
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
  dueOffsetDays?: number | null; // omitted = none (recurring.md D1); an integer ≥ 0 or it throws before any write
  until?: string | null; // omitted = open-ended (D2); a day key or it throws before any write
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

// Rolls: create/edit/archive in one call (mirrors upsertHabit). estimateMin is required in the form but
// nullable in the type (series parity); archive is active:false.
export interface UpsertRollInput {
  id?: string;
  name: string;
  categoryId: string | null;
  estimateMin: number | null;
  active?: boolean;
}

// Create (no id): label + isWork required; order defaults per impl, active to true, area to Personal.
// Update (id set): every field is patch-style — omitted keeps the current value — so a rename racing a work
// flip can't revert it, nor un-retire or clear the area. Callers send only what they change.
export interface CreateCategoryInput {
  id?: undefined;
  label: string;
  isWork: boolean;
  order?: number;
  active?: boolean;
  area?: Area | null; // create: null/omitted = Personal; off the set → refused
}
export interface UpdateCategoryInput {
  id: string;
  label?: string;
  isWork?: boolean;
  order?: number;
  active?: boolean;
  area?: Area | null; // null clears; off the set → refused
}
export type UpsertCategoryInput = CreateCategoryInput | UpdateCategoryInput;

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
// The patch keys are a runtime allowlist too: the server refuses any other key off the wire (patchKeyError).
export const STORY_PATCH_KEYS = [
  'title',
  'competencyTags',
  'situation',
  'action',
  'result',
] as const satisfies readonly (keyof Story)[];
export type StoryPatch = Partial<Pick<Story, (typeof STORY_PATCH_KEYS)[number]>>;

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
// getSitting: the head plus everything but the replay (events at asc; the problem doc when captured).
export interface SittingDetail {
  sitting: Sitting;
  live: SittingLive | null;
  events: SittingEvent[];
  problem: LeetcodeProblem | null;
  liveReads: number; // how many times Claude pulled it live (pullLiveSitting)
}

// pullLiveSitting: the sitting open right now with its live row and newest Run and Submit (full payloads), or —
// with nothing open — the most recent sitting. `liveReads` counts this pull. The one read that writes (the
// count); the app never calls it — a pull is Claude watching (live_sitting).
export interface LiveSittingPull {
  sitting: Sitting | null; // open: active and inside its window
  live: SittingLive | null;
  lastRun: SittingEvent | null;
  lastSubmit: SittingEvent | null;
  liveReads: number; // the open sitting's after this pull; else lastSitting's
  lastSitting: Sitting | null; // when nothing is open: the newest by startedAt, any status
}

// A finished Flux set, as the stage hands it over (FluxSetDraft plus the three keys). The id and day
// are the client's (D47): the id is the idempotency key, so an outbox retry returns the stored row.
export interface RecordFluxSetInput {
  id: string; // ULID
  day: string; // YYYY-MM-DD
  exerciseId: string;
  kind: ExerciseKind;
  side: FluxSide | null;
  condition: Condition | null;
  count: number;
  avgPeakDeg?: number | null;
  avgErrorDeg?: number | null;
  rom: Euler;
  calibrated: boolean;
  delegate: FluxDelegate | null;
  durationSec: number;
  completedAt: number;
  repTaskId: string | null;
  stoppedEarly: boolean;
  planned: number | null;
}

// One object, so omitted keys survive JSON (positional undefined doesn't). from/to: both or neither.
export interface FluxSetFilter {
  from?: string;
  to?: string;
  exerciseId?: string;
}

// The full export snapshot. Every collection is REQUIRED, and that's the point: the two ApiClient
// impls build this differently (the stub from its in-memory store, the backend from enumerated repo
// reads), and a missing collection used to be invisible — leetcodeAttempts shipped absent from the
// real export while the stub looked fine. With both returning an object literal typed as this,
// omitting a key AND adding a stray one are compile errors.
//
// Soft-deleted rows are EXCLUDED (see the export contract test). That's the right call while the
// export is a one-way download; if an import/restore path ever lands it will need tombstones for
// merge, plus a versioned envelope.
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
  rolls: Roll[];
  sessions: PomodoroSession[];
  days: Day[];
  categories: Category[];
  places: Place[]; // the place token (pointer + lookup row) is a credential and is never exported
  // LeetCode sittings: heads, live rows, head rows and problems. The raw payloads and the replay are left out
  // (bulk; the export is one Lambda response) — like attachment bytes.
  sittings: Sitting[];
  sittingLive: SittingLive[];
  sittingHeadRows: SittingHeadRow[]; // runs/submits/notes/timer as verdicts — their raw payloads stay in the table
  leetcodeProblems: LeetcodeProblem[];
  stories: Story[];
  attachments: Attachment[]; // metadata only — the bytes stay in S3, not in the export
  fluxSets: FluxSet[];
  // Finances. Access tokens never leave SSM, so they're never exported.
  financeItems: FinanceItem[];
  financeSyncStates: FinanceSyncState[];
  financeAccounts: FinanceAccount[];
  financeTransactions: FinanceTransaction[];
  financeRules: FinanceRule[];
  gcalSyncStates: GcalSyncState[]; // calendar two-way sync cursors (no credentials — those stay in SSM)
  settings: Settings; // always materialised — never the stub's nullable storage state
}

// googleAccounts is deliberately absent — the connected-account list is mutated server-side only (the
// OAuth callback adds, disconnectGoogleAccount removes), never patched directly by the client.
export const SETTINGS_PATCH_KEYS = [
  'dayStartHour',
  'pomodoroWorkMin',
  'pomodoroBreakMin',
  'theme',
  'calendarShapeRefs',
  'calendarWriteDefault',
  'autoCalendar',
  'dayFocusStart',
  'dayEndHour',
  'financeBudgetCents',
  'financePaymentDay',
  'fluxRollId',
  'leetcodeRollId',
  'fluxDisclaimerAckAt',
  'fluxSets',
  'remindTimed',
  'remindDueDay',
  'remindPlanned',
] as const satisfies readonly (keyof Settings)[];
export type SettingsPatch = Partial<Pick<Settings, (typeof SETTINGS_PATCH_KEYS)[number]>>;

// A patch off the wire must be a plain object holding only its type's keys — a spread would otherwise
// store whatever it carries (id, userId, deletedAt, googleAccounts…). The refusal text, or null if it's fine.
export function patchKeyError(
  what: string,
  patch: unknown,
  keys: readonly string[],
): string | null {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
    return `${what} patch must be an object`;
  const bad = Object.keys(patch).filter((k) => !keys.includes(k));
  return bad.length > 0 ? `Unknown ${what} field: ${bad.join(', ')}` : null;
}

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
  // Two-way sync health (GcalSyncState): the last pull that finished, and the last attempt's error (null
  // after a success). Older clients/stubs may omit them.
  lastSyncedAt?: number | null;
  lastPullError?: string | null;
}
// pullCalendar: Google → task changes. `pulled` false = toggle off, no accounts, or throttled (≤ 1/min).
// `changedTaskIds` = tasks written (applied or unlinked) — the app refetches tasks iff non-empty.
export interface PullCalendarResult {
  pulled: boolean;
  changedTaskIds: string[];
  accounts: { sub: string; ok: boolean; error: string | null }[];
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
// Manual event write, routed to the target calendar's owning account. The start/end feed the event only;
// a task's own deadline clock is dueTime (auto-sync derives the event window from it — calendarSync.ts).
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
  createLogEntry(text: string, day: string, opts?: { private?: boolean }): Promise<LogEntry>;
  updateLogEntry(id: string, text: string): Promise<LogEntry>; // keeps `private`
  // Alive entries with from <= day <= to (either bound optional), oldest first; one bounded read — the
  // MCP log tools' input. A malformed day is 'Invalid day'; from > to is 'Invalid range'.
  listLogRange(range: Partial<DateRange>): Promise<LogEntry[]>;
  // A tombstone; a second delete is a no-op. No UI and no MCP tool: the dev check cleans its seeds by id.
  deleteLogEntry(id: string): Promise<void>;
  setLogEntryPrivate(id: string, isPrivate: boolean): Promise<LogEntry>;

  // Tasks
  listBacklog(): Promise<Task[]>;
  // All live tasks (any status) — a task# prefix read; views filter by status client/Lambda-side.
  listTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  createTask(input: CreateTaskInput): Promise<Task>;
  // Bulk create — every input lands as an unlocked backlog task, in the given order (one createdAt
  // stamp for the batch so they sort together). Best-effort over batchPut; empty input writes nothing.
  createTasks(inputs: CreateTaskInput[]): Promise<Task[]>;
  // Quick add: one natural-language line → createTask fields, parsed by Claude Haiku against the user's
  // active categories and day start (quickParse.ts). Writes nothing. A ' | ' line takes the strict
  // grammar instead. Never throws for a parse failure — `ok: false` means save the line raw.
  parseTask(text: string): Promise<ParseTaskResult>;
  // The working estimate — any open status; rejects done/cancelled and never touches estimateLockedMin. The
  // one exception: a done task with no baseline takes one retro estimate, which becomes it (machines.ts).
  setTaskEstimate(id: string, estimateMin: number | null, bufferMin: number | null): Promise<Task>;
  // Category can change any time — labels resolve live and wasWork is snapshotted on sessions, so
  // there's no freeze constraint here (unlike the estimate).
  setTaskCategory(id: string, categoryId: string | null): Promise<Task>;
  // Deadline metadata (day-granular). Settable at ANY status — a moved deadline is not a scope
  // change, so this never touches estimateLockedMin.
  // Day-only form, kept for back-compat (cached app shells, older callers): = setTaskDue(id, { dueDay }),
  // so it keeps the current time unless the day is cleared.
  setTaskDueDay(id: string, dueDay: string | null): Promise<Task>;
  // Day + optional clock time in one write (and one calendar sync). Any status; never touches the lock.
  setTaskDue(id: string, due: SetTaskDueInput): Promise<Task>;
  // Rename. Display text, not part of the estimate lock or calibration (points carry taskId, not title)
  // — so it's settable at ANY status, like the deadline. Trims; rejects an empty/whitespace title.
  // Renames a linked calendar event when auto-sync is on (calendarSync.ts).
  setTaskTitle(id: string, title: string): Promise<Task>;
  // Notes (light markdown). Like the title, settable at ANY status and never touches the estimate lock.
  // Trims; empty/whitespace or null clears to null; over TASK_NOTES_MAX rejects and writes nothing.
  setTaskNotes(id: string, notes: string | null): Promise<Task>;
  // The reflection (taskNotes.ts), at ANY status, never the lock. Missing is an error; null clears.
  setTaskReflection(id: string, reflection: string | null): Promise<Task>;
  transitionTask(id: string, to: TaskStatus): Promise<Task>;
  // reflection rides the same write: undefined KEEPS the current one (an older caller sends two params),
  // null clears, a string is normalized — over the cap rejects and writes nothing, the actual included.
  setTaskActual(id: string, actualMin: number, reflection?: string | null): Promise<Task>;
  // Split always yields parent + parts (split.ts): the original finishes or keeps going, the rest becomes a
  // new part on the original's plan day (else backlog). A standalone original becomes Part 1 under a NEW
  // parent that takes its title, deadline and lock; a part gains a sibling. Never cancels, never edits a lock.
  splitTask(
    id: string,
    input: SplitTaskInput,
  ): Promise<{ parent: Task; original: Task; followUp: Task }>;
  // Attach to a parent, or detach (null) — parts.ts assertCanBePart. The task keeps its plan rows and status;
  // a parent's first part clears its estimate and plan rows, and a started part freezes the parent's lock.
  setTaskParent(id: string, parentId: string | null): Promise<Task>;
  // Permanent delete (distinct from cancel, which keeps the row as history). Tombstones the task, its
  // plan rows, and its attachment metadata; hard-deletes the calendar event via the cancel path; deletes
  // each attachment's S3 bytes first (a failure throws, task left alive and retryable). No-op if the
  // task is absent/already gone.
  deleteTask(id: string): Promise<void>;

  // Plans (scheduling)
  listPlansForDay(day: string): Promise<TaskPlan[]>;
  upsertPlan(input: UpsertPlanInput): Promise<TaskPlan>;
  removePlan(id: string): Promise<void>;

  // Series (recurrence)
  listSeries(): Promise<TaskSeries[]>;
  upsertSeries(input: UpsertSeriesInput): Promise<TaskSeries>;
  deactivateSeries(id: string): Promise<TaskSeries>;
  // Tombstones the series row — its occurrences stay (each is a real task). No UI or MCP surface: the dev
  // check's cleanup by recorded id (recurring.md D7). Idempotent.
  deleteSeries(id: string): Promise<void>;

  // Sessions (pomodoro)
  startSession(input: StartSessionInput): Promise<PomodoroSession>;
  heartbeatSession(id: string): Promise<PomodoroSession>; // also used to capture time up to a pause
  resumeSession(id: string): Promise<PomodoroSession>; // reset the clock after a pause (no accrual)
  // capMin caps what the final beat credits (a block that sat on "done": the target less what's already
  // counted; a paused one: 0). Omitted = uncapped, as a phone on older JS sends.
  stopSession(
    id: string,
    status: 'completed' | 'discarded',
    opts?: { capMin?: number },
  ): Promise<PomodoroSession>;
  // Again on a timer on "done": one more block; capMin as on a stop, and the clock restarts.
  extendSession(id: string, opts?: { capMin?: number }): Promise<PomodoroSession>;
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

  // Rolls (deadline-free ongoing efforts). list includes archived (UI filters, like habits). Picking a
  // roll for `day` creates a planned rep task tagged with the roll and puts it on that day's plan — if a
  // live rep already exists it's reused + ensured on the plan (never duplicated). `day` is the client's
  // local day-key (the server is UTC). The rep flows into the daytime home; completing it IS the rep.
  listRolls(): Promise<Roll[]>;
  upsertRoll(input: UpsertRollInput): Promise<Roll>;
  pickRollToday(rollId: string, day: string): Promise<{ task: Task; plan: TaskPlan }>;

  // Ideas (inbox)
  listIdeas(status?: IdeaStatus): Promise<Idea[]>;
  createIdea(text: string): Promise<Idea>;
  triageIdea(id: string, status: IdeaStatus): Promise<Idea>;

  // Day (singleton per date). `day` is the client's CURRENT day: getDay lazily materializes due
  // recurrence and sweeps stale planned tasks (no plan row on/after `day`) back to backlog — both
  // relative to it. A day after the user's app day is refused (`FUTURE_DAY_ERROR`; a malformed key is
  // 'Invalid day'); read another day's plan with listPlansForDay. Past days are allowed.
  getDay(day: string): Promise<Day>;
  // The stored row, untouched — no recurrence, sweep or create (null when the day has no row). Any day.
  peekDay(day: string): Promise<Day | null>;
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
  // The category's life area (areas.ts). A value off the set is refused with nothing written; a retired
  // category keeps its area. Nothing is snapshotted, so there is no backfill to ask about.
  setCategoryArea(id: string, area: Area | null): Promise<Category>;
  deleteCategory(id: string, reassignToId: string | null): Promise<void>;

  // Places (errand lists — places.ts). list is alive, oldest first (the order you added them). A slug
  // change on upsert rewrites all that place's tasks; delete moves its alive tasks to `reassignToSlug`
  // (another place — finished ones too) or takes its open ones off any list (null — a finished task keeps
  // the old slug, so its calibration never flips), then tombstones it. setTaskPlace refuses a finished task
  // (PLACE_FINISHED_ERROR), a part (PLACE_PART_ERROR — a part's place is always its parent's) and an
  // unknown slug (placeUnknownError); on a parent it moves its open parts too (finished parts keep theirs).
  // setTaskParent's attach gives an open part its parent's place; a detach keeps it. listPlaceTasks is the
  // Shortcut's digest as a pure read (no heartbeat) — it lists items (placeTasks).
  listPlaces(): Promise<Place[]>;
  upsertPlace(input: UpsertPlaceInput): Promise<Place>;
  deletePlace(id: string, reassignToSlug: string | null): Promise<void>;
  setTaskPlace(id: string, place: string | null): Promise<Task>;
  listPlaceTasks(slug: string): Promise<PlaceDigest>;
  // The Shortcut's token: one per user. rotate mints a new one (the old stops working) and returns the
  // plaintext exactly once; the server keeps only its hash. revoke kills it. Either refuses when the
  // other ran meanwhile on another device (PLACE_TOKEN_RACE_ERROR) — the caller retries.
  getPlaceTokenStatus(): Promise<PlaceTokenStatus>;
  rotatePlaceToken(): Promise<{ token: string; status: PlaceTokenStatus }>;
  revokePlaceToken(): Promise<void>;
  // Scoped device tokens (capture.ts) — named, at most SCOPED_TOKENS_MAX live per scope, each good for its
  // scope's one route and no RPC method. mint returns the plaintext exactly once (the server keeps only its
  // hash) and refuses a name scopedTokenNameError rejects; revoke kills it at once (an unknown id is a
  // no-op). list is the scope's live tokens, oldest first.
  listScopedTokens(scope: TokenScope): Promise<ScopedTokenInfo[]>;
  mintScopedToken(
    scope: TokenScope,
    name: string,
  ): Promise<{ token: string; info: ScopedTokenInfo }>;
  revokeScopedToken(id: string): Promise<void>;

  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;

  // Reminders (reminders.ts) — Web Push to this user's devices; the push-dispatch poller is the only
  // sender. subscribe upserts by endpoint (one device per endpoint) and refuses a host off
  // PUSH_ENDPOINT_HOSTS (PUSH_ENDPOINT_ERROR) or a stage with no VAPID key (PUSH_UNCONFIGURED_ERROR);
  // unsubscribe removes the caller's device and remembers it in status.removedDeviceIds, so that device
  // stops instead of re-adding itself on launch (an unknown id is a no-op). Status never carries a
  // subscription's keys. sendTestPush queues a test the poller sends on its next tick (within a minute),
  // so it proves the whole chain; it refuses with no devices.
  subscribePush(input: SubscribePushInput): Promise<PushDevice>;
  unsubscribePush(id: string): Promise<void>;
  getPushStatus(): Promise<PushStatus>;
  sendTestPush(): Promise<void>;

  // Google Calendar (multi-account). Connect is a browser redirect (GET /api/google/callback, outside
  // this RPC surface); these are the RPC methods. Every read/write is gated (noop in testMode) so a
  // smoke run touches no real token, event, or SSM param.
  googleConnectUrl(): Promise<{ url: string }>; // consent URL w/ signed state — Connect AND Add-account
  getGoogleStatus(): Promise<GoogleStatus>; // per-account connected / reconnectRequired
  listGoogleCalendars(): Promise<GoogleCalendar[]>; // calendarList across all connected accounts
  getCalendarBusy(input: GetCalendarBusyInput): Promise<CalendarBusy>; // raw intervals; client computes shape
  insertCalendarEvent(input: InsertCalendarEventInput): Promise<Task>; // creates the event, stores pointers
  deleteCalendarEvent(taskId: string): Promise<Task>; // delete-on-cancel; clears the pointers
  // Retry for a failed auto-sync (task.gcalSyncError): creates or patches the event to match the task now.
  syncCalendarEvent(taskId: string): Promise<Task>;
  // Two-way sync: pull edits made in Google to Aperture's events back onto their tasks (calendarPull.ts).
  // Called on app open/foreground; never throws for a Google failure (it lands on the account status).
  pullCalendar(): Promise<PullCalendarResult>;
  disconnectGoogleAccount(accountSub: string): Promise<void>; // drop the token + settings entry

  // Calibration (derived, read-only)
  getCalibration(range: DateRange): Promise<CalibrationPoint[]>;

  // LeetCode sittings (sittings.ts; docs/areas/recruiting). The two ingest methods take the device token
  // or the user's JWT (LC_INGEST_METHODS); everything else is JWT only.
  // Start opens a sitting as a rep of settings.leetcodeRollId (LC_ROLL_UNLINKED_ERROR when unset): it
  // attaches the open rep when no sitting holds it, else spawns a fresh one, refusing while another
  // sitting is still open (SITTING_ACTIVE_ERROR); the rep goes in_progress and is titled after the
  // problem. Idempotent on clientSittingId (resumed: true — also for an ended sitting, returned as ended: the
  // extension mints a new id). Events are idempotent per event id, refused with nothing written once the
  // sitting has ended or is over a cap. A sitting ends through its rep — Done → done, Drop → abandoned — or as
  // stale at a later Start; deleting the rep deletes it.
  lcSittingStart(input: SittingStartInput): Promise<SittingStartResult>;
  lcSittingEvents(input: SittingEventsInput): Promise<SittingEventsResult>;
  listSittings(range?: DateRange): Promise<Sitting[]>; // heads, startedAt desc, by `day`
  getSitting(id: string): Promise<SittingDetail>; // never the replay — that's listSittingReplay
  pullLiveSitting(): Promise<LiveSittingPull>; // Claude's live read (live_sitting) — counts itself
  listSittingReplay(id: string): Promise<SittingReplayChunk[]>; // at asc; empty once the raw bulk expired
  setSittingPrepTarget(id: string, prepTarget: string): Promise<Sitting>;
  // The user's review, whole-replaced (normalizeSittingReview; all-empty clears it to null). On the head, at any status.
  setSittingReview(id: string, review: SittingReviewInput): Promise<Sitting>;
  // Claude's draft of mistake lines from the sitting's runs, submits and code (one Haiku call). Never automatic —
  // the form's button — and it writes nothing: only the lines the user ticks reach the review, through setSittingReview.
  draftSittingReview(id: string): Promise<ReviewDraft>;
  // Tombstones the sitting and every child row. No UI: the dev check's cleanup, and deleteTask's cascade.
  deleteSitting(id: string): Promise<void>;

  // Flux — one row per finished set (D47). record is idempotent on the client's id (a retry returns the
  // stored row) and refuses per fluxSetError; list is alive, completedAt desc, from/to both or neither;
  // delete is a soft-delete and leaves the Roll rep the set counted toward alone (D53).
  recordFluxSet(input: RecordFluxSetInput): Promise<FluxSet>;
  listFluxSets(filter?: FluxSetFilter): Promise<FluxSet[]>;
  deleteFluxSet(id: string): Promise<void>;
  // The weekly note (D62): this week's cached line, or null under two sets this week. A read that may
  // write (the first call after a set changes rebuilds and stores it) — never a model call per request.
  getFluxWeekNote(): Promise<FluxWeekNote | null>;

  // Behavioral story bank — STAR stories authored in-app, tagged by competency. list is alive-filtered,
  // updatedAt desc; delete is a soft-delete (tombstoned, filtered from list).
  listStories(): Promise<Story[]>;
  createStory(input: CreateStoryInput): Promise<Story>;
  updateStory(id: string, patch: StoryPatch): Promise<Story>;
  deleteStory(id: string): Promise<void>;

  // Task attachments — bytes never cross the BFF. The Lambda mints presigned URLs; the browser PUTs the
  // file to S3, then confirms (pending → ready). Downloads are minted per view, short-lived. delete
  // deletes the S3 object (the versioned bucket keeps it 30 days as a noncurrent version), then
  // tombstones the metadata.
  createAttachmentUploadUrl(
    input: CreateAttachmentInput,
  ): Promise<{ attachment: Attachment; uploadUrl: string }>;
  confirmAttachment(id: string): Promise<Attachment>; // pending → ready; idempotent
  listAttachments(taskId?: string): Promise<Attachment[]>; // ready + alive; all tasks when omitted
  getAttachmentDownloadUrl(id: string): Promise<string>; // short-lived, minted per view
  deleteAttachment(id: string): Promise<void>;

  // Finances — the three-bucket budget (plus Not spending) over Plaid-synced bank data (finance.ts). `today` is the client's
  // day-key; the overview reads FINANCE_OVERVIEW_LOOKBACK_DAYS back from it. Every Plaid call is gated
  // (noop in testMode). Plaid-owned rows use Plaid's ids.
  getFinanceOverview(input: { today: string }): Promise<FinanceOverview>;
  listFinanceTransactions(range: DateRange): Promise<FinanceTransaction[]>; // alive, date desc
  // Batch bucket set (null = unsort; not_spending = sorted, in no total; an unknown bucket is refused
  // with financeBucketError's text). With `rule`, also saves the rule and applies it to every
  // currently-unsorted match; returns every row it changed.
  setFinanceBucket(input: SetFinanceBucketInput): Promise<FinanceTransaction[]>;
  setFinancePeriodOverride(
    id: string,
    override: FinancePeriodOverride | null,
  ): Promise<FinanceTransaction>;
  setFinanceNote(id: string, note: string | null): Promise<FinanceTransaction>;
  // Mark / unmark the card-side payment (money in on a credit account) that ends a billing period; the
  // next period starts the day after it. Marking throws per periodStartError and clears the row's own
  // bucket / override / refund link (it's a payment now). Unmarking never throws for an alive row.
  setFinancePeriodStart(id: string, marked: boolean): Promise<FinanceTransaction>;
  // Tie money coming in (a card credit or a checking/savings deposit) to the charge it reverses (null =
  // unlink). The refund then takes the charge's bucket and period and leaves the sort queue. Throws per
  // refundLinkError (both on shown card/bank accounts, no payment or transfer, charge ≤ refund + 3
  // days, refund ≤ charge). Linking clears the refund's own bucket/override;
  // sorting or moving a linked refund yourself (setFinanceBucket / setFinancePeriodOverride) unlinks it —
  // which is also how a refund whose charge dropped out of view gets sorted.
  linkFinanceRefund(refundId: string, chargeId: string | null): Promise<FinanceTransaction>;
  listFinanceRules(): Promise<FinanceRule[]>; // alive, pattern asc
  upsertFinanceRule(input: UpsertFinanceRuleInput): Promise<FinanceRule>;
  deleteFinanceRule(id: string): Promise<void>; // soft-delete
  updateFinanceAccount(id: string, patch: FinanceAccountPatch): Promise<FinanceAccount>;
  createPlaidLinkToken(input: CreateLinkTokenInput): Promise<LinkTokenResult>;
  // Refuses a duplicate login BEFORE exchanging (Trial slots never come back), stores the item and
  // its accounts, then starts the first sync.
  exchangePlaidPublicToken(input: ExchangePublicTokenInput): Promise<FinanceItem>;
  // After Link update mode (re-login / account selection): re-reads accounts + item health, no exchange.
  completePlaidUpdate(itemId: string): Promise<FinanceItem>;
  // /item/remove, drop the stored token, tombstone the item + its accounts + sync state. Transactions
  // stay as history but drop out of the overview with their accounts.
  removePlaidItem(itemId: string): Promise<void>;
  // refresh=false: sync what Plaid already has. refresh=true: ask the bank for new data first (cooldown
  // FINANCE_REFRESH_COOLDOWN_MS; a refused request returns accepted:false + when to retry).
  requestFinanceSync(input: { refresh: boolean }): Promise<RequestFinanceSyncResult>;

  // Full data export (JSON) — the user owns their data. A snapshot of every entity.
  exportData(): Promise<ExportBundle>;
}
