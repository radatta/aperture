// Entity types — storage-agnostic. The single source of truth for the data model,
// shared by the stub (app) and the eventual Lambda. Physical DynamoDB keys are derived
// from these later; nothing here assumes DynamoDB.

import type { AttachmentStatus } from './attachments';
import type { Area } from './areas';
import type { ExerciseId } from './flux/definitions';
import type { CompetencyTag } from './stories';
import type { Difficulty, PatternId } from './neetcode150';
import type { Condition, Euler, ExerciseKind } from './flux/types';

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
  // Kept out of every MCP read (docs/areas/log). Rows written before the field read back undefined = public.
  // A reserved word as an identifier — never destructure it; locals use `isPrivate`.
  private?: boolean;
}

// --- Tasks -----------------------------------------------------------------
export type TaskStatus = 'backlog' | 'planned' | 'in_progress' | 'done' | 'cancelled';
export type EstimateSource = 'planned' | 'revised' | 'retro';

export interface Task extends BaseEntity {
  title: string;
  status: TaskStatus;
  categoryId: string | null;
  seriesId: string | null; // set when spawned from a recurring series
  // The day the series spawned this occurrence for — its identity within the series (recurrence.ts
  // seriesHasOccurrence): getDay never spawns a second occurrence for a (series, day) that has one, whatever
  // happened to its plan row. Occurrences spawned before this field read back undefined (docs/areas/tasks/recurring.md D4).
  seriesDay?: string | null;
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
  // The look back written at completion (what went well, what to do differently, where the time went) —
  // same markdown subset as notes, capped at TASK_REFLECTION_MAX (taskNotes.ts). Editable at any status,
  // never part of the estimate lock; every spawn path (split follow-up, series, roll rep) starts it null.
  // Pre-existing rows read back undefined, so readers use `!reflection`.
  reflection: string | null;
  // The WORKING estimate: editable at any open status (not done/cancelled) — rescoping mid-task is fine.
  estimateMin: number | null;
  bufferMin: number | null;
  // The calibration baseline, frozen on first exit from planning; calibration = actualAccruedMin vs this.
  // Never edited after — a later estimate edit moves estimateMin only. The one exception: a parent whose
  // last part goes is plain again, and the lock frozen for its parts goes with them (parts.ts releaseParent).
  estimateLockedMin: number | null;
  // How the headline number came to be, set once at done (machines.ts): planned = the lock is the estimate;
  // revised = rescoped after start; retro = no lock until the finish, so hindsight. A parent, an errand and
  // any row older than the done gate have none (undefined on read).
  estimateSource?: EstimateSource | null;
  // The task this one is a part of (parts.ts): the parent holds the deadline, its parts hold the work. One
  // level — a parent can't have a parent, a part can't have parts. Parenthood is derived (some task points
  // here), never stored. Pre-existing rows read back undefined → `!parentId`.
  parentId: string | null;
  // The errand list this task is on (places.ts): a Place's slug, or null. A placed task is an errand —
  // never a calibration point (contributesCalibration). Pre-existing rows read back undefined → `!place`.
  place: string | null;
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
  // The cadence: an occurrence spawns planned on its day, due `dueOffsetDays` later (0 = the same day, 1 = the
  // next day …), untimed. null = no due date. Rows from before read back undefined → `?? null`.
  dueOffsetDays?: number | null;
  // The last day the series spawns (inclusive, YYYY-MM-DD); null = open-ended. Past it the series stays
  // `active` and its row reads "ended …" until stopped. Rows from before read back undefined → `?? null`.
  until?: string | null;
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
  blocks?: number; // the blocks this timer runs to, raised by Again; absent = 1
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
// area (areas.ts) is the life area the category belongs to — a live grouping, never snapshotted; null
// reads as Personal (areaOf). Rows from before the field read back undefined → both impls list it as null.
export interface Category extends BaseEntity {
  label: string;
  isWork: boolean;
  order: number;
  active: boolean;
  area: Area | null;
}

// --- Places (errand lists) -------------------------------------------------
// A store you run errands at (places.ts). Tasks reference it by slug — the word in `@slug`, the Shortcut's
// URL and the lens link — so a slug edit rewrites its tasks. No address: the geofence lives in the iPhone's
// Shortcuts automation, never here. lastReadAt = the last Shortcut read (the setup's heartbeat).
export interface Place extends BaseEntity {
  name: string;
  slug: string;
  lastReadAt: number | null;
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
// marker: the look Aperture last sent (a parent's due marker, or false once turned back into a block);
// absent = never sent one (a plain block keeps whatever colour it has). Never read back from Google.
export interface GcalSeen {
  title: string | null;
  startMs: number | null;
  endMs: number | null;
  updatedMs: number;
  marker?: boolean;
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
  // Connected Google accounts (up to two). Written server-side at connect/disconnect; [] when none.
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
  financeBudgetCents: number; // default 50000
  financePaymentDay: number; // default 1
  // Flux: the Roll whose daily rep a Flux session counts toward (docs/areas/flux), and when the
  // disclaimer was accepted. Synced, so it's accepted once, not once per device. null → unset.
  fluxRollId: string | null; // default null
  fluxDisclaimerAckAt: number | null; // default null
  // The sets stepper's opening count per exercise — learned, written on Start when it differs from the
  // stored one (D61). Absent → the stepper's default. Whole numbers 1–5 (fluxSetsError).
  fluxSets: Partial<Record<ExerciseId, number>>; // default {}
  // LeetCode: the Roll whose rep a sitting is (docs/areas/recruiting). Unset → the extension's Start is
  // refused (LC_ROLL_UNLINKED_ERROR). Rows from before read back undefined → `?? null`.
  leetcodeRollId: string | null; // default null
  // LeetCode Premium: the coach may pick Premium problems. Rows from before read back undefined → the default.
  leetcodePremium: boolean; // default true
  // Reminders (reminders.ts): which kinds ping this user's devices. Rows from before read back undefined
  // and count as on (reminderEnabled).
  remindTimed: boolean; // default true — a deadline with a clock time, at that time
  remindDueDay: boolean; // default true — a day-only deadline, at 09:00
  remindPlanned: boolean; // default true — a task planned for the day, at 09:00
  // LeetCode coach: Opus picks the day's problems from the rules' candidates (coachAi.ts). Rows from before read
  // back undefined and count as on (coachAiPickOn). Off → the rule plan, no call.
  coachAiPick: boolean; // default true
  // LeetCode coach: the plan's slot mix (coach.md → Plan mode). Rows from before read back undefined and count as
  // 'auto' (coachPlanModeOf).
  coachPlanMode: CoachPlanMode; // default 'auto'
}

// One device's Web Push subscription (reminders.ts). Never exported or returned: endpoint + p256dh + auth
// let anyone push to the device. id = a sha256(endpoint) prefix, so re-subscribing is an upsert.
export interface PushSub extends BaseEntity {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string; // "iPhone · Safari"
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

// Flux's weekly note (D62): one cached line per week, written by the model from this week's sets (or the
// deterministic line when it can't be), rebuilt when the week's sets change. `fingerprint` is the
// server's cache key; the API hands back the rest.
export interface FluxWeekNote {
  weekStart: string; // Monday, YYYY-MM-DD
  text: string; // at most 140 characters
  generatedAt: number; // epoch ms
}
export interface FluxWeekNoteRow extends FluxWeekNote {
  fingerprint: string;
}

// --- Calibration (derived, read-only) -------------------------------------
export interface CalibrationPoint {
  taskId: string;
  day: string; // completion day
  estimateLockedMin: number; // the headline: frozen at start
  estimateMin: number | null; // the working estimate at the finish ("est 30 → 60"); null on a parent
  estimateSource: EstimateSource | null; // null: a parent, or a row older than the done gate
  actualAccruedMin: number;
  categoryId: string | null;
  reflection: string | null; // the task's reflection, so a calibration read carries the why with the delta
  // > 0 = a done parent's rollup (parts.ts), over this many parts not dropped (the card's "2/2") — each
  // already a point of its own, so the headline skips it to count the work once.
  parts: number;
}

// --- Recruiting: LeetCode verdicts -----------------------------------------
// A judged Run or Submit's outcome, normalized server-side from LeetCode's raw status (normalizeVerdict).
export type LeetcodeVerdict =
  | 'accepted'
  | 'wrong_answer'
  | 'time_limit'
  | 'runtime_error'
  | 'compile_error'
  | 'memory_limit'
  | 'other';

// --- Recruiting: LeetCode sittings ------------------------------------------
// A sitting is one go at one problem (docs/areas/recruiting): the extension's Start opens it, Done on its
// rep task ends it. Everything it captures is LeetCode's own traffic, kept raw; the counts and metrics
// are folds over it (sittings.ts) so the stub and the Lambda can't drift.
export type SittingStatus = 'active' | 'done' | 'abandoned';

// A judged Run or Submit, as the fold keeps it (the raw response stays on the event).
export interface SittingVerdict {
  verdict: LeetcodeVerdict;
  statusMsg: string | null;
  passed: number | null; // total_correct
  total: number | null; // total_testcases
  at: number; // epoch ms — the event's `at`
}

// LeetCode's top-bar timer as last read from its localStorage (QD_TIMER_STATE). Semantics are inferred
// from one capture (lcTimerElapsedMs); `raw` keeps the whole value for when they're confirmed.
export interface LcTimerState {
  mode: string | null; // 'reverse' = countdown; the stopwatch's name isn't captured yet
  status: string | null; // 'pause' | running …
  elapsedMs: number | null;
  at: number;
  raw: unknown;
}

// The head's fold: only Runs, Submits, timer and note events move it (snapshots and replay fold into
// SittingLive instead, so the frequent writes stay small).
export interface SittingSummary {
  runs: number;
  submits: number;
  notes: number;
  lastRun: SittingVerdict | null;
  lastSubmit: SittingVerdict | null;
  firstSubmit: SittingVerdict | null;
  firstAcceptedAt: number | null;
  submitsBeforeAccepted: number | null; // null until an accepted submit
  runsBeforeFirstSubmit: number;
  lcTimer: LcTimerState | null;
  lastEventAt: number | null;
  headEvents: number; // how many head rows this summary folds — a recompute never writes over a larger one
  coach?: SittingCoach; // only once a coach event folds: read it as `summary.coach ?? null`
  firstJudgedAt?: number | null; // the first Run's or Submit's `at`; absent on summaries folded before it
  // The trace (docs/areas/recruiting/index.md → The trace comment): `traced` when a snapshot before the first Run or
  // Submit held a trace comment, `none` once judged without one; absent until then and on sittings folded before it.
  commentTrace?: 'traced' | 'none';
}

// The user's LeetCode Start gate (one row): the day it counts (the user's zone, never the client's), that
// day's Start attempts and Starts, and the open sitting it last let through with when — the single decision
// point that keeps parallel Starts to one open sitting and the caps. Internal — never exported.
export interface LcStartGate extends BaseEntity {
  day: string;
  attempts: number;
  starts: number;
  openSittingId: string | null;
  openClaimedAt: number | null;
}

// A head event as the summary reads it: its type, time and the verdict, timer state or coach mark taken
// from its payload at write. Small (the summary's recompute reads every one); the run's, submit's, note's or
// coach event's full payload is kept beside it as a SittingEvent.
export interface SittingHeadRow {
  id: string;
  sittingId: string;
  // `trace-comment` is the server's own row (traceCommentRow), never an extension event.
  type: 'run' | 'submit' | 'note' | 'timer' | 'coach' | 'trace-comment';
  at: number;
  verdict: SittingVerdict | null; // runs and submits
  timer: LcTimerState | null; // timer reads
  coach?: CoachMark | null; // coach events; absent on rows written before them
  deletedAt: number | null;
}

// The extension's coaching, as events of type 'coach' (docs/areas/recruiting/index.md → _Coach events_).
// The payload is the extension's; the server reads it defensively (coachMarkOf) and keeps it verbatim. Any other
// kind (a pre-2.2 build's trace card events among them) is stored with `kind: null` and folds nothing.
export type CoachEventKind = 'config' | 'nudge-shown';
export type CoachEventPayload =
  | { kind: 'config'; nudge: boolean } // once per sitting: whether the resubmit note is on
  | { kind: 'nudge-shown'; gapMs: number }; // a resubmit within ~60 s of a failed one
// What a coach event's head row keeps: its kind (null when unknown — stored, folds nothing) and a config's switch.
export interface CoachMark {
  kind: CoachEventKind | null;
  config: { nudge: boolean } | null;
}
// The sitting's coaching, folded from its coach rows.
export interface SittingCoach {
  config: { nudge: boolean } | null;
  nudges: number;
}

// A sitting's capture budget: every event the extension sends is reserved here (a CAS increment) before
// anything is written, duplicates included, so the per-sitting caps hold under retries and parallel calls.
// Internal — never exported or returned.
export interface SittingBudget extends BaseEntity {
  sittingId: string;
  events: number;
  bytes: number;
}

export interface Sitting extends BaseEntity {
  day: string; // YYYY-MM-DD — startedAt bucketed by the client's tz offset + dayStartHour
  startedAt: number; // server clock at Start — the sitting clock
  clientStartedAt: number; // the Start click by the extension's clock — the clock its events' times are on
  endedAt: number | null; // set when its rep finishes (Done, Drop), by a later Start ending it as stale, or by an idle close
  status: SittingStatus;
  // Set when a read found it idle (sittings.ts SITTING_IDLE_MS) and closed it at its last activity + a tail; cleared
  // by a reopen, kept when its rep is Done after. Absent on heads from before — read as `closedBy ?? null`.
  closedBy?: 'idle' | null;
  reopenedAt?: number | null; // the newest reopen of an idle-closed sitting (activity on the server clock)
  idleMs?: number; // the gaps its reopens bridged, left out of its minutes (sittingElapsedMs)
  clientSittingId: string; // the extension's idempotency key for Start
  problemSlug: string;
  problemTitle: string;
  questionId: string | null;
  frontendId: string | null;
  difficulty: string | null;
  topicTags: string[] | null;
  lang: string;
  repTaskId: string;
  rollId: string;
  prepTarget: string; // 'General' until the company UI exists
  lcSolveSessionId: string | null; // LeetCode's own qd_solve_session id at Start (context only)
  // The extension build that opened it (its manifest version, x.y.z), set at creation only — Settings → LeetCode
  // compares the newest with the app's (extension/README.md → Versions). Absent on sittings before 2.2.0.
  extensionVersion?: string | null;
  // When the new sitting's rep was fully shaped (titled, noted, planned, started). Until then a repeat Start
  // shapes it fully — a Start that died after making the rep still finishes; after, a resume only starts it.
  shapedAt: number | null;
  summary: SittingSummary;
  // The user's review (setSittingReview), on the head so the list and list_sittings read it free; a refold spreads the
  // head, so it survives ingest. Absent on heads written before reviews existed — read it as `review ?? null`.
  review?: SittingReview | null;
  // Claude's own notes on how the sitting went (set_claude_notes), never mixed into the user's review. Absent on
  // heads from before them; null once cleared.
  claudeNotes?: ClaudeNotes | null;
}
export interface ClaudeNotes {
  text: string; // ≤ CLAUDE_NOTES_MAX, newlines kept
  updatedAt: number;
}

// How much help a sitting took: none, a hint (a nudge, a topic), or the solution read.
export type HelpLevel = 'none' | 'hint' | 'solution';
// A sitting's review — the user's words; a Claude draft only ever proposes mistake lines they tick (draftUsed).
export interface SittingReview {
  insight: string | null; // the one-liner
  help: HelpLevel;
  mistakes: string[];
  howItWent: string | null;
  tags: string[]; // their own pattern tags: lowercased, deduped, order kept
  draftUsed: boolean; // a Claude draft line was ticked into `mistakes` (kept while any mistake remains)
  // The coach's one cause tag (coach.ts CAUSE_TAGS) and the test-sitting flag. Absent on reviews written before
  // the coach — read as `cause ?? null`, `test === true`.
  cause?: CauseTag | null;
  test?: boolean;
  updatedAt: number;
}

// --- Recruiting: the LeetCode coach (docs/areas/recruiting/coach.md) ---
// Only the user's decisions are stored; the plan, the queue and every problem record are derived on read.
// Why a problem went wrong, one tag per sitting.
export type CauseTag = 'no-trace' | 'api-slip' | 'boundary' | 'off-by-one' | 'quit-early';
// A clean first-submit accept; accepted otherwise (later submit or a hint); never accepted, or the solution read.
export type AttemptOutcome = 'clean' | 'solved' | 'failed';
// An attempt made outside the extension (paper, an editor, a mock), or a peeked problem seeded from the thread.
export interface CoachAttempt extends BaseEntity {
  slug: string;
  title: string | null;
  day: string; // the user's day it counts on
  at: number; // when it was logged
  outcome: AttemptOutcome;
  help: HelpLevel;
  cause: CauseTag | null;
  minutes: number | null;
  note: string | null;
  source: 'manual' | 'peek-seed';
  historical?: true; // a solve from before the coach (log_attempt historical): seen, never scheduled or counted
  // An off-catalog problem's difficulty as logged; absent on rows from before. The catalog's wins.
  difficulty?: Difficulty | null;
  // Accepted that day even though the outcome is failed (a peek after an accept): absent → outcome !== 'failed'.
  accepted?: boolean;
}
// The plan's slot mix (coach.md → Plan mode): balanced is one of each kind; catch-up fills with re-solves; auto
// switches between them on the due count, with hysteresis.
export type CoachPlanMode = 'auto' | 'balanced' | 'catch-up';
// A legacy (day, slug) group's stored void state (coach.md → Legacy history): every group counts until `void: true`;
// `void: false` counts it again. id = `<day>#<slug>`.
export interface CoachVoid extends BaseEntity {
  day: string;
  slug: string;
  void: boolean;
}
// One submission the pre-sittings extension captured (until PR 147, 2026-11-10), under the legacy `lc#` SK.
// Read-only: nothing writes these any more; the coach folds them as `legacy` attempts (coach.ts legacyAttempts).
export interface LegacyLeetcodeAttempt extends BaseEntity {
  day: string; // YYYY-MM-DD, bucketed via dayStartHour + the client's reported tz offset
  problemSlug: string;
  problemTitle: string;
  verdict: LeetcodeVerdict;
  submittedAt: number; // epoch ms from LeetCode
  lang: string;
  runtimeMs: number | null;
  memory: number | null; // bytes
  leetcodeSubmissionId: string;
  frontendId: string | null;
  difficulty: string | null; // 'Easy' | 'Medium' | 'Hard' | null
  topicTags: string[] | null;
}
export type SlotKind = 'carry-over' | 'new' | 're-solve' | 'stretch';
// One change the user made to a day's plan: a slot (by the engine's pick, `from`) swapped to `to`, or skipped.
export interface CoachSlotChange {
  kind: SlotKind;
  action: 'swap' | 'skip';
  from: string;
  to: string | null;
  at: number;
}
// A day's decisions, id = the day: the floor choice and the slot changes (one per slot, the newest kept).
export interface CoachDay extends BaseEntity {
  day: string;
  floor: boolean;
  changes: CoachSlotChange[];
  ai?: CoachDayAi; // the day's AI pick (coachAi.ts); absent on rows from before it, and on a day with none
}
// Why a day's AI pick fell back to the rules. `invalid` is a guardrail's refusal (`detail` names it).
export type CoachAiReason =
  'unavailable' | 'timeout' | 'network' | 'api' | 'bad-json' | 'refusal' | 'invalid';
export interface CoachAiPick {
  slug: string;
  kind: SlotKind; // the candidate's kind, so the slot's coaching rules are the engine's
  why: string; // the model's one line, cut to AI_WHY_MAX
}
// One claim, one call, one result a day (docs/areas/recruiting/coach.md → The AI pick). `claimId` fences the
// worker's writes to the claim that invoked it; a `pending` older than AI_PICK_STALE_MS reads as a timeout.
export interface CoachDayAi {
  status: 'pending' | 'ok' | 'fallback';
  claimId: string;
  claimedAt: number;
  startedAt: number | null; // the worker began; set once, so a redelivered event never calls twice
  settledAt: number | null;
  model: string | null;
  picks: CoachAiPick[]; // in the model's order; [] unless ok
  note: string | null;
  focus: { from: PatternId; to: PatternId; why: string } | null;
  oldestDue: string | null; // the oldest due re-solve when picked — tomorrow's guardrail reads it
  // The plan mode's mix the pick kept (coach.md → Plan mode); absent on picks from before it, which were balanced.
  mode?: 'balanced' | 'catch-up';
  reason: CoachAiReason | null;
  detail: string | null; // a guardrail code or an HTTP status, never model text
  usage: { input: number; output: number } | null;
  ms: number | null;
}
// The focus override (one row): the pattern held from `sinceDay`, the anchor the focus replay starts from.
// `ai`: the day's AI pick moved it (a top-3 ranked pattern only).
export interface CoachFocus extends BaseEntity {
  pattern: PatternId;
  sinceDay: string;
  source: 'override' | 'ai';
}

// What the extension's replay stream says about how the sitting went, folded at ingest so it outlives the
// raw replay's expiry. `focus` is LeetCode's type-3 event as [at, val] pairs, capped: its meaning (focus?
// visibility?) is unconfirmed, so it's kept raw rather than turned into "time away" on a guess.
export interface SittingFacts {
  firstEditAt: number | null;
  lastEditAt: number | null;
  edits: number;
  longestStallMs: number; // the longest gap between consecutive editor changes
  rewrites: number; // a snapshot under half the longest code so far (a restart), counted once each
  maxCodeLength: number;
  focus: [number, boolean][];
}

// The live row: the newest code (kept forever — it's the final code once the sitting ends), the snapshot
// version Claude's live read reports, and the facts. One per sitting, id = the sitting's id.
export interface SittingLive extends BaseEntity {
  sittingId: string;
  version: number; // snapshot count
  code: string | null;
  lang: string | null;
  codeAt: number | null; // the newest snapshot's `at`
  receivedAt: number | null; // when the server last got a snapshot or replay — staleness
  snapshots: number;
  replayChunks: number;
  bytes: number;
  facts: SittingFacts;
}

export type SittingEventType =
  'snapshot' | 'run' | 'submit' | 'submitDetails' | 'note' | 'timer' | 'coach';
// One captured moment, payload kept verbatim. Snapshots and submitDetails carry expiresAt in the table
// (they're raw bulk); runs, submits, notes, timer reads and coach events are kept forever.
export interface SittingEvent extends BaseEntity {
  sittingId: string;
  type: SittingEventType;
  at: number; // when it happened, by the extension's clock
  receivedAt: number;
  payload: unknown;
}

// One PracticeReplayUploadEvents body, raw (its `events` is LeetCode's JSON string). Expires with the raw bulk.
export interface SittingReplayChunk extends BaseEntity {
  sittingId: string;
  at: number;
  receivedAt: number;
  clientSessionId: string | null;
  events: string;
}

// LeetCode's questionDetail for a problem, raw, upserted once per slug (shared by every sitting on it).
export interface LeetcodeProblem extends BaseEntity {
  slug: string;
  questionId: string | null;
  frontendId: string | null;
  title: string;
  difficulty: string | null;
  topicTags: string[] | null;
  raw: unknown;
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

// --- Flux: saved sets ------------------------------------------------------
// One row per finished Flux set (docs/areas/flux, D47). The client mints the id (an outbox retry can't
// double-save) and the day (fixed at set time, so a set retried tomorrow keeps its day). `side` is the
// stored mirror ('a' = the definition's own sign); its Right/Left label is per exercise (sideLabel, D48).
export type FluxSide = 'a' | 'b';
export type FluxDelegate = 'GPU' | 'CPU';

export interface FluxSet extends BaseEntity {
  day: string; // YYYY-MM-DD — the client's day for completedAt (dayStartHour)
  exerciseId: string; // catalog id (@aperture/shared/flux)
  kind: ExerciseKind;
  side: FluxSide | null; // the sided stretches only
  condition: Condition | null; // the library chip when the set was done
  count: number; // reps / holds / trials / cycles
  avgPeakDeg: number | null;
  avgErrorDeg: number | null;
  rom: Euler; // range since the neutral, at set end
  calibrated: boolean;
  delegate: FluxDelegate | null;
  durationSec: number;
  completedAt: number; // epoch ms
  repTaskId: string | null; // the Roll rep this set counted toward
  stoppedEarly: boolean; // ended before its prescription — Stop, Back, leaving, an error (D55)
  planned: number | null; // the count it was going for, at set time (bilateral ×2); null when timed
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
