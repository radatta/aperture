// The dev check's BFF client's shared half (api.ts composes the client): the types it reads and writes, the
// ledger kinds and their vias, and makeCore — the transport (origin check, 429 backoff) and the ledger guards
// every area's reads and writes go through.
import { createHash } from 'node:crypto';
import { AUTH_HEADER, assertDevOrigin, targetOrigin } from '../config';
import { DevcheckError } from '../errors';
import { pendingIds, type Ledger, type LedgerEntry } from '../ledger';

// After a delete S3 answers a presigned GET with 403, not 404: the roles have no s3:ListBucket, so S3 hides
// NoSuchKey behind AccessDenied. 404 still counts as gone.
export const isGone = (status: number): boolean => status === 403 || status === 404;

// The slice of @aperture/shared's Task the check reads (scripts doesn't depend on shared; the contract
// tests on both sides own the full shape).
export interface DevTask {
  id: string;
  title: string;
  estimateMin?: number | null;
  status?: string;
  categoryId?: string | null; // the category-suggest scenario
  parentId?: string | null;
  place?: string | null; // a place slug — an errand (the places scenario)
  estimateLockedMin?: number | null;
  actualAccruedMin?: number;
  reflection?: string | null; // the reflection scenario
  seriesId?: string | null; // the recurring scenario: an occurrence of that series
  seriesDay?: string | null;
  dueDay?: string | null;
  dueTime?: string | null; // plan-write-refetch: a planned task given a time
}

// The slice of a recurring series the check reads and writes (packages/shared/src/types.ts TaskSeries).
export interface DevSeries {
  id: string;
  title: string;
  rule: { kind: string; daysOfWeek?: number[]; interval?: number };
  categoryId?: string | null; // what a refused deleteCategory names (pipeline.ts referencesOf)
  active: boolean;
  anchorDate: string;
  dueOffsetDays?: number | null;
  until?: string | null;
}
export interface CreateSeriesInput {
  title: string;
  rule: {
    kind: 'daily' | 'weekdays' | 'weekly' | 'everyN';
    daysOfWeek?: number[];
    interval?: number;
  };
  defaultEstimateMin?: number | null;
  dueOffsetDays?: number | null;
  until?: string | null;
}

export interface CreateTaskInput {
  title: string;
  estimateMin?: number | null;
  dueDay?: string | null;
  dueTime?: string | null; // HH:MM on dueDay (the option-3 scenario; the test user has no Google account)
  notes?: string | null;
  parentId?: string | null; // a part of that task (the parts scenario)
  place?: string | null; // a place slug (the places scenario)
  categoryId?: string | null; // one of this run's categories (the areas and category-suggest scenarios)
}

// The slices of a category, a plan row and the day row the check reads (the parts-v2b-reads scenario:
// a write-back straight after another keeps both).
export interface DevCategory {
  id: string;
  label: string;
  isWork: boolean;
  order: number;
  active: boolean;
  // The life area (packages/shared/src/areas.ts AREAS — scripts doesn't depend on shared) or null; a row
  // from before the field lists as null (the areas scenario).
  area: 'school' | 'aperture' | 'recruiting' | 'personal' | null;
}
// What parseTask / parse_task answer (shared quickParse.ts ParseTaskResult) — the fields the check reads. It
// writes nothing.
export type DevParseResult =
  | {
      ok: true;
      input: {
        title: string;
        categoryId?: string;
        dueDay?: string;
        dueTime?: string;
        estimateMin?: number;
        notes?: string;
      };
      categoryLabel: string | null;
    }
  | { ok: false; reason: string; detail?: string };
export interface DevPlan {
  id: string;
  taskId: string;
  day: string;
  plannedMinutes: number;
  order: number;
}
export interface DevDay {
  date: string;
  capacityHours: number | null;
  intent: string | null;
}
// The slices of a habit and a check the day-guards scenario reads.
export interface DevHabit {
  id: string;
  name: string;
  categoryId: string | null;
  cadencePerWeek: number;
  active: boolean;
}
export interface DevHabitCheck {
  id: string;
  habitId: string;
  date: string;
}

// The slices of @aperture/shared's places contract the check reads (packages/shared/src/places.ts).
export interface DevPlace {
  id: string;
  name: string;
  slug: string;
  lastReadAt: number | null;
}
export interface DevPlaceDigest {
  place: string;
  slug: string;
  count: number;
  titles: string[];
  text: string;
}
export interface DevPlaceTokenStatus {
  active: boolean;
  createdAt: number | null;
  lastUsedAt: number | null;
  hint: string | null;
  readsToday: number;
}
// The slices of @aperture/shared's capture contract the check reads (packages/shared/src/capture.ts): a scoped
// token as Settings lists it (never the token or its hash — `hint` is its last 4), and the capture route's answer.
export interface DevScopedToken {
  id: string;
  scope: string;
  name: string;
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  usedToday: number;
}
export interface DevCaptureResult {
  id: string | null;
  say: string;
  detail: string;
  raw: boolean;
  duplicate: boolean;
  due: { day: string; time: string | null } | null;
}
// The slices of @aperture/shared's reminders contract the check reads (packages/shared/src/reminders.ts).
// A device never carries its endpoint or keys back; the check's own subscription input is the only place
// they exist, in the step's memory.
export interface DevPushDevice {
  id: string;
  label: string;
  createdAt: number;
  lastOkAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}
export interface DevPushStatus {
  configured: boolean;
  vapidPublicKey: string | null;
  devices: DevPushDevice[];
  removedDeviceIds: string[];
  poller: {
    lastRunAt: number | null;
    lastSentAt: number | null;
    lastError: string | null;
    lastErrorAt: number | null;
  };
}
export interface DevSubscribePushInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
}
// The three reminder toggles — the only settings the check may write, so a restore can't touch the rest.
export type DevReminderSettings = Partial<
  Record<'remindTimed' | 'remindDueDay' | 'remindPlanned', boolean>
>;
export const REMINDER_SETTING_KEYS = new Set(['remindTimed', 'remindDueDay', 'remindPlanned']);

export interface DevCalibrationPoint {
  taskId: string;
  day: string;
  estimateLockedMin: number;
  estimateMin: number | null;
  estimateSource: 'planned' | 'revised' | 'retro' | null;
  actualAccruedMin: number;
}

// The slice of a saved Flux set the check writes and reads (docs/areas/flux D47). Its id is minted here,
// like the app's — the server keys the idempotent write on it — and recorded before the call.
export interface DevFluxSetInput {
  id: string;
  day: string;
  exerciseId: string;
  kind: string;
  side: 'a' | 'b' | null;
  condition: null;
  count: number;
  avgPeakDeg: number | null;
  avgErrorDeg: number | null;
  rom: { pitch: number; yaw: number; roll: number };
  calibrated: boolean;
  delegate: 'GPU' | 'CPU' | null;
  durationSec: number;
  completedAt: number;
  repTaskId: null;
  stoppedEarly: boolean;
  planned: number | null;
}
export interface DevStory {
  id: string;
  title: string;
  situation: string;
  competencyTags?: string[];
}
export interface DevLogEntry {
  id: string;
  day: string;
  text: string;
  createdAt: number;
  private?: boolean; // docs/areas/log
}

export interface DevFluxSet {
  id: string;
  day: string;
  exerciseId: string;
  count: number;
}

// The slices of the finance contract the check reads (packages/shared/src/finance.ts) — the fixture bank's
// rows (DEV-CHECK.md → One-time setup), never created here: a run only sorts and links them, and clears that.
export interface DevFinanceTransaction {
  id: string;
  accountId: string;
  date: string;
  name: string;
  merchantName: string | null;
  rawAmountCents: number; // Plaid's sign: positive = money out
  bucket: string | null;
  refundOfId: string | null;
  startsPeriod: boolean;
}
export interface DevFinanceRule {
  id: string;
  pattern: string;
  bucket: string;
}

// The slice of an attachment the check reads. Attachments are never ledgered: each lives on a ledgered
// task, and that task's delete cascade removes it (and its bytes).
export interface DevAttachment {
  id: string;
  taskId: string;
  s3Key: string;
  contentType: string;
  status: string;
}

// The settings the check reads and, for one row, writes back.
export interface DevSettings extends Required<DevReminderSettings> {
  dayStartHour: number;
  pomodoroWorkMin: number;
  fluxSets: Record<string, number>;
  leetcodeRollId?: string | null; // the lc-sittings scenario links its own roll, and unlinks it after
  // The coach's AI pick (absent = on). Every run turns it off after the sweep (pipeline.ts) so no other scenario's
  // read starts the day's one pick; lc-coach-ai turns it on for its own steps and off again in their `finally`.
  coachAiPick?: boolean;
  leetcodePremium?: boolean; // lc-coach's progress step switches it off and back on (absent = on)
  // The coach's plan mode (absent = auto). coach-fixes sets it for its own steps and puts the prior one back.
  coachPlanMode?: DevCoachPlanMode;
}

// The slices of a Roll and a LeetCode sitting the lc-sittings scenario writes and reads
// (packages/shared/src/types.ts Roll, Sitting, SittingLive; sittings.ts for the inputs).
export interface DevRoll {
  id: string;
  name: string;
  categoryId: string | null;
  estimateMin: number | null;
  active: boolean;
}
// An upsert takes the input's keys only — the BFF refuses a stored row's others (userId, createdAt…).
export const rollInput = (r: DevRoll, active: boolean) => ({
  id: r.id,
  name: r.name,
  categoryId: r.categoryId,
  estimateMin: r.estimateMin,
  active,
});
export interface DevVerdict {
  verdict: string;
  passed: number | null;
  total: number | null;
  at: number;
}
export interface DevSitting {
  id: string;
  day: string;
  extensionVersion?: string | null; // the extension build its Start came from (absent before 2.2.0)
  status: 'active' | 'done' | 'abandoned';
  repTaskId: string;
  rollId: string;
  problemSlug: string;
  problemTitle: string;
  prepTarget: string;
  startedAt: number;
  endedAt: number | null;
  closedBy?: 'idle' | null; // idle close — absent on heads from before it
  reopenedAt?: number | null;
  idleMs?: number;
  review?: (DevSittingReview & { cause?: string | null; test?: boolean }) | null; // PR C — absent on heads from before reviews; `test` is the void
  summary: {
    runs: number;
    submits: number;
    notes: number;
    firstSubmit: DevVerdict | null;
    lastSubmit: DevVerdict | null;
    lastRun: DevVerdict | null;
    submitsBeforeAccepted: number | null;
    runsBeforeFirstSubmit: number;
    headEvents: number;
    // lc-coach C0 — absent until a coach event folds; the resubmit note's switch and count (the card is retired)
    coach?: { config: { nudge: boolean } | null; nudges: number };
    commentTrace?: 'traced' | 'none'; // coach-fixes: the trace comment before the first judged event
  };
  claudeNotes?: { text: string; updatedAt: number } | null; // coach-fixes: Claude's notes, beside the review
}
export interface DevSittingReview {
  insight: string | null;
  help?: 'none' | 'hint' | 'solution'; // absent keeps the stored help (the coach's peek)
  mistakes: string[];
  howItWent: string | null;
  tags: string[];
  draftUsed: boolean;
}
export type DevReviewDraft =
  { ok: true; mistakes: string[]; cause?: string | null } | { ok: false; reason: string };
export interface DevSittingDetail {
  sitting: DevSitting;
  live: {
    version: number;
    code: string | null;
    facts: { edits: number; longestStallMs: number; focus: [number, boolean][] };
  } | null;
  events: { id: string; type: string; at: number; payload?: unknown }[];
  problem: { slug: string } | null;
  liveReads: number; // live_sitting pulls (PR B)
}
// What getCoachToday / leetcode_today answer — the fields the scenario reads.
export interface DevCoachSlot {
  n?: number;
  kind: 'carry-over' | 'new' | 're-solve' | 'stretch';
  slug: string;
  title: string;
  reason: string;
  capMin: number;
  status: 'open' | 'in-progress' | 'done' | 'skipped';
  sittingId: string | null;
  outcome: string | null;
  swappedFrom: string | null;
  alternatives?: { slug: string }[];
  aiWhy?: string | null; // the AI pick's "why today"; null on a rule slot
}
// The plan's view of the day's AI pick (packages/shared/src/coach.ts CoachAiView).
export interface DevCoachAiView {
  status: 'due' | 'pending' | 'ok' | 'fallback';
  source: 'ai' | 'rules';
  notice: string | null;
  reason: string | null;
  note: string | null;
  focusChange: { from: string; to: string; why: string } | null;
  model: string | null;
  pickedAt: number | null;
}
// packages/shared/src/coach.ts AI_PICK_NOTICE (scripts doesn't depend on shared; api.test.ts pins the copy).
export const DEV_AI_PICK_NOTICE = 'AI pick unavailable today, using the rules';
// The stored day row's pick (packages/shared/src/types.ts CoachDayAi), as exportData answers it.
export interface DevCoachDayAi {
  status: 'pending' | 'ok' | 'fallback';
  claimId: string;
  claimedAt: number;
  startedAt: number | null;
  settledAt: number | null;
  model: string | null;
  picks: { slug: string; kind: string; why: string }[];
  note: string | null;
  focus: { from: string; to: string; why: string } | null;
  reason: string | null;
  detail: string | null;
  usage: { input: number; output: number } | null;
}
export interface DevCoachDay {
  id: string;
  day: string;
  floor: boolean;
  changes?: { action: string; from: string; to: string | null }[]; // today's slot changes (a restore removes one)
  ai?: DevCoachDayAi;
}
// One attempt for logCoachAttempts (packages/shared/src/coach.ts CoachAttemptInput).
export interface DevCoachAttemptInput {
  slug: string;
  day?: string;
  outcome: 'clean' | 'solved' | 'failed';
  minutes?: number | null;
  note?: string | null;
  title?: string | null; // a problem off the roadmap (coach-fixes)
  difficulty?: 'Easy' | 'Medium' | 'Hard';
}
export interface DevCoachToday {
  day: string;
  mode: string;
  focus: { pattern: string; day: number; of: number; source: string };
  slots: DevCoachSlot[];
  floor: { slug: string; on: boolean; done: boolean } | null;
  offPlan: { sittingId: string; slug: string }[];
  due: { slug: string; dueDay: string; track?: string }[];
  next48h: { slug: string; dueDay: string; track?: string }[];
  momentum: { activeDays: number; lastActiveDay: string | null };
  unreviewed: { sittingId: string; slug: string }[];
  ai?: DevCoachAiView | null; // null: the AI pick is off, or nothing to pick from
  // coach-fixes: ended sittings with no Claude's notes yet, and the day's slot mix.
  unnoted?: { sittingId: string; slug: string; title: string; day: string }[];
  planMode?: DevCoachPlanModeView;
  mock?: DevMockView; // lc-coach-e: the week's mock line and the planned ones in the next 48 hours
}
// A mock interview (packages/shared/src/types.ts Mock) and the day's view of mocks (coach.ts CoachMockView).
export interface DevMockScores {
  code: number;
  solve: number;
  communicate?: number;
}
export interface DevMock {
  id: string;
  day: string;
  status: 'planned' | 'done';
  kind: string;
  partner: string | null;
  sittingId: string | null;
  problemSlug: string | null;
  scores: DevMockScores | null;
  notes: string | null;
}
export interface DevMockView {
  thisWeek: 'done' | 'planned' | 'none';
  last: { id: string; day: string; scores: DevMockScores | null } | null;
  doneCount: number;
  upcoming: { id: string; day: string; kind: string; partner: string | null }[];
  unlogged: { id: string; day: string; kind: string; partner: string | null }[];
  line: string;
}
// The coach's plan mode (packages/shared/src/coach.ts CoachPlanMode, CoachPlanModeView).
export type DevCoachPlanMode = 'auto' | 'balanced' | 'catch-up';
export interface DevCoachPlanModeView {
  setting: DevCoachPlanMode;
  mode: 'balanced' | 'catch-up';
  due: number;
  line: string; // "Catch-up: 10 due · auto"
}
// A legacy group's stored void state (packages/shared/src/types.ts CoachVoid), as exportData answers it.
export interface DevCoachVoid {
  id: string; // `${day}#${slug}`
  day: string;
  slug: string;
  void: boolean;
}
// What getCoachStats answers — the fields the Patterns tab's steps read.
export interface DevCoachStats {
  attempts: number;
  firstTry: { hit: number; of: number };
  resolve: { hit: number; of: number };
  ranking: string[];
  patterns: { pattern: string; attempts: number; firstTry: { hit: number; of: number } }[];
}
export interface DevCoachAttempt {
  id: string;
  slug: string;
  day: string;
  outcome: string;
  help: string;
}
export interface DevProblemRecord {
  slug: string;
  title: string;
  pattern?: string;
  difficulty?: string | null;
  everAccepted?: boolean;
  inCatalog?: boolean;
  lastDay: string;
  sittingIds: string[];
  peeked: boolean;
  schedule: { track: string; step?: number; dueDay: string; graduated: boolean } | null;
  historical?: { tries: number; firstDay: string; lastDay: string } | null;
  lists?: string[];
}
// The full LeetCode catalog's import status (packages/shared/src/lcCatalog.ts CatalogStatus).
export interface DevCatalogStatus {
  state: 'absent' | 'staging' | 'running' | 'ready' | 'partial' | 'failed';
  sha: string | null;
  count: number;
  premium: number;
  by: Record<'neetcode' | 'rule' | 'model' | 'tags', number> | null;
  importedAt: number | null;
  staged: { have: number; of: number } | null;
  costUsd: number;
  lastError: string | null;
  modelError: string | null;
  badClasses: number;
}
export interface DevSittingStart {
  clientSittingId: string;
  problemSlug: string;
  problemTitle: string;
  difficulty?: string | null;
  topicTags?: string[] | null;
  lang: string;
  startedAt: number;
  tzOffsetMinutes: number;
  problem?: unknown;
  extensionVersion?: string | null; // the extension's manifest version, as its background stamps it
}
export type DevSittingEvent =
  | {
      id: string;
      type: 'snapshot' | 'run' | 'submit' | 'submitDetails' | 'note' | 'timer' | 'coach';
      at: number;
      payload: unknown;
    }
  | { id: string; type: 'replay'; at: number; clientSessionId?: string | null; events: string };

// The test user's work block. A step may shorten it; the step's `finally` and each run's start put it back.
export const DEV_WORK_MIN = 25;

// The slice of a Pomodoro session the check reads. The harness's API client writes one only to stage a
// running timer on a task it created (startSession, below; the app's UI stops it), or with a stop it
// expects refused (stopSession, below).
export interface DevSession {
  id: string;
  taskId: string | null;
  blocks?: number;
  status: string;
  startedAt: number;
  endedAt: number | null;
  activeMinutes: number;
}

// The ledger's `via` for a Flux set — cleanup reads it to delete the right kind of row.
export const FLUX_SET_VIA = 'api:recordFluxSet';
// A log entry this harness created (through the API, or the capture bar's createLogEntry — recorder.ts).
export const LOG_VIA = 'api:createLogEntry';
// A Recruiting story this harness created (bff-hardening's legal patch); cleaned by deleteStory (a tombstone).
export const STORY_VIA = 'api:createStory';
export const UI_LOG_VIA = 'ui:createLogEntry';
// A place this harness created (through the API, or the browser's upsertPlace create — recorder.ts).
export const PLACE_VIA = 'api:upsertPlace';
export const UI_PLACE_VIA = 'ui:upsertPlace';
// A category this harness created — through the API (upsertCategory with no id), Settings' Add (the browser's
// upsertCategory create, recorder.ts) or MCP create_category. Cleaned by deleteCategory on the recorded id
// (after every other kind, so after the run's tasks on it); never an existing category of the test user's.
export const CATEGORY_VIA = 'api:upsertCategory';
export const UI_CATEGORY_VIA = 'ui:upsertCategory';
export const MCP_CATEGORY_VIA = 'mcp:create_category';
// A habit this harness created. The API has no habit delete, so cleanup ARCHIVES it (`active: false`) and
// "exists" means listed and active — archived `devcheck …` habits stay on the test user, by design, until
// a tombstoning deleteHabit lands (day-guards' follow-up).
export const HABIT_VIA = 'api:upsertHabit';
// A roll this harness created (the lc-sittings scenario's LeetCode roll). Like habits, no delete: cleanup
// archives it, and "exists" means listed and active.
export const ROLL_VIA = 'api:upsertRoll';
// A sitting this harness started, and the rep task its Start spawned (a task, deleted like one — which
// removes the sitting too). Both recorded from the Start's response.
export const SITTING_VIA = 'api:lcSittingStart';
export const SITTING_REP_VIA = 'api:lcSittingStart:rep';
// The test user's LeetCode-roll link: no id of its own, so `lc-roll-link:<run>` is recorded before the
// first link — it exists while the setting names a roll, and removing it unlinks.
export const LC_ROLL_LINK_VIA = 'api:linkLeetcodeRoll';
export const lcRollLinkId = (run: string): string => `lc-roll-link:${run}`;
// The LeetCode coach (docs/areas/recruiting/coach.md). A manual or peek attempt is recorded by the id its log
// returns and deleted by deleteCoachAttempt. A slot change has no id: `coach-slot:<run>:<day>:<slug>` is recorded
// before the call; it exists while that day is today and its slot is still changed, and a restore removes it (a
// change left on a past day only moves that day's plan, which nothing reads again).
export const COACH_ATTEMPT_VIA = 'coach:attempt';
export const COACH_SLOT_VIA = 'coach:slot';
// A mock interview (lc-coach-e), recorded by the id its create answered — log_mock's (MCP) or the app's upsertMock
// with no id (the browser's response, recorder.ts) — and deleted by deleteMock. A write naming an id edits a mock
// already recorded, so it records nothing.
export const MOCK_VIA = 'coach:mock';
export const UI_MOCK_VIA = 'ui:upsertMock';
export const coachSlotId = (run: string, day: string, slug: string): string =>
  `coach-slot:${run}:${day}:${slug}`;
// The floor choice and the focus override have no id either: `coach-floor:<run>:<day>` exists while that day is today
// and its floor is on (removing turns it off); `coach-focus:<run>` while an override holds (removing clears it).
export const COACH_FLOOR_VIA = 'coach:floor';
export const COACH_FOCUS_VIA = 'coach:focus';
export const coachFloorId = (run: string, day: string): string => `coach-floor:${run}:${day}`;
export const coachFocusId = (run: string): string => `coach-focus:${run}`;
export const coachSlotOf = (id: string): { day: string; slug: string } => {
  const [day = '', slug = ''] = id.split(':').slice(-2);
  return { day, slug };
};
// The test user's Shortcut token. It has no id, so a rotate records `place-token:<run>` — before the call, like
// a Flux set: a crash mid-call still leaves a token for the next run's sweep to revoke.
// A recurring series this harness created — through the API, the browser's upsertSeries create (recorder.ts)
// or MCP's create_series. Cleanup deletes its occurrences (tasks with that seriesId, which getDay spawned
// server-side, so no create response ever named them) and then the series, by this one recorded id.
export const SERIES_VIA = 'api:upsertSeries';
export const UI_SERIES_VIA = 'ui:upsertSeries';
export const MCP_SERIES_VIA = 'mcp:create_series';
export const SERIES_VIAS: readonly string[] = [SERIES_VIA, UI_SERIES_VIA, MCP_SERIES_VIA];
export const PLACE_TOKEN_VIA = 'api:rotatePlaceToken';
export const placeTokenId = (run: string): string => `place-token:${run}`;
// A capture token (capture.md → Token) this harness minted — through the API, or Settings › Capture's Make
// token (the browser's mintScopedToken response, recorder.ts) — by the id the mint answered with, never the
// token. Cleanup revokes it by that id; one already revoked (or never listed) reads as gone.
export const SCOPED_TOKEN_VIA = 'api:mintScopedToken';
export const UI_SCOPED_TOKEN_VIA = 'ui:mintScopedToken';
// A task the capture route made (POST /api/capture, recorded from its 200's `id`) — a task like any other.
export const CAPTURE_VIA = 'api:capture';
// A push device this harness subscribed — by the id the server answered with (a sha256(endpoint) prefix) —
// through the API, or Settings' Enable (the browser's subscribePush response, recorder.ts).
export const PUSH_SUB_VIA = 'api:subscribePush';
export const UI_PUSH_SUB_VIA = 'ui:subscribePush';
// The harness's push devices sit on fixed endpoints (one per slot, never issued by Apple), so a device's
// id — the BFF's sha256(endpoint) prefix, lambdas/src/backend.ts pushDeviceId — repeats run to run and a
// live one is known as the harness's own whatever the ledger says.
export const HARNESS_PUSH_SLOTS = ['e2e', 'b', 'c', 'r', 'dup', 'banner'] as const;
export type HarnessPushSlot = (typeof HARNESS_PUSH_SLOTS)[number];
export const harnessPushEndpoint = (slot: HarnessPushSlot): string =>
  `https://web.push.apple.com/devcheck-${slot}`;
export const harnessPushId = (slot: HarnessPushSlot): string =>
  createHash('sha256').update(harnessPushEndpoint(slot)).digest('hex').slice(0, 16);
export const HARNESS_PUSH_IDS = new Set(HARNESS_PUSH_SLOTS.map(harnessPushId));
export const isHarnessPushId = (id: string): boolean => HARNESS_PUSH_IDS.has(id);
// The test user's reminder toggles, flipped by a run: like the place token, no id of its own, so
// `reminder-toggles:<run>` is recorded before the first flip (API or Settings) — a run that dies mid-way
// still leaves the next run's sweep to switch them back on. It exists while any toggle reads off.
export const REMINDER_TOGGLES_VIA = 'api:setReminderSettings';
export const reminderTogglesId = (run: string): string => `reminder-toggles:${run}`;
export const REMINDERS_ON = { remindTimed: true, remindDueDay: true, remindPlanned: true } as const;

// A bucket set, a refund link or a period mark on a fixture bank row. None has an id of its own, so, like the
// token, a run records `finance-bucket:<run>:<row>` / `finance-link:<run>:<row>` / `finance-mark:<run>:<row>`
// — before the click that sets it (the browser does the write), run-scoped so two runs on the same row never
// resolve each other's entry. Cleanup clears the bucket / the link / the mark; the row itself is the
// fixture's and stays. A rule the run adds is its own
// row with an id, recorded from the create response like a place.
export const FINANCE_BUCKET_VIA = 'ui:setFinanceBucket';
export const FINANCE_LINK_VIA = 'ui:linkFinanceRefund';
export const FINANCE_MARK_VIA = 'ui:setFinancePeriodStart';
export const FINANCE_RULE_VIA = 'api:upsertFinanceRule';
export const financeBucketId = (run: string, row: string): string => `finance-bucket:${run}:${row}`;
export const financeLinkId = (run: string, row: string): string => `finance-link:${run}:${row}`;
export const financeMarkId = (run: string, row: string): string => `finance-mark:${run}:${row}`;
// The row a finance-bucket / -link / -mark ledger id names — after the last colon (a ULID has none).
export const financeRowOf = (id: string): string => id.slice(id.lastIndexOf(':') + 1);

// What a ledger id names, by the `via` it was created with — each kind is read and deleted its own way.
export type LedgerKind =
  | 'task'
  | 'story'
  | 'flux'
  | 'log'
  | 'place'
  | 'placeToken'
  | 'category'
  | 'habit'
  | 'financeBucket'
  | 'financeLink'
  | 'financeMark'
  | 'financeRule'
  | 'pushsub'
  | 'reminderToggles'
  | 'series'
  | 'roll'
  | 'sitting'
  | 'lcRollLink'
  | 'scopedToken'
  | 'coachAttempt'
  | 'coachSlot'
  | 'coachFloor'
  | 'coachFocus'
  | 'mock';
export function ledgerKind(entries: LedgerEntry[], id: string): LedgerKind {
  const via = entries.find((e) => e.op === 'created' && e.id === id)?.via;
  if (via === FLUX_SET_VIA) return 'flux';
  if (via === LOG_VIA || via === UI_LOG_VIA) return 'log';
  if (via === STORY_VIA) return 'story';
  if (via !== undefined && SERIES_VIAS.includes(via)) return 'series';
  if (via === PLACE_VIA || via === UI_PLACE_VIA) return 'place';
  if (via === CATEGORY_VIA || via === UI_CATEGORY_VIA || via === MCP_CATEGORY_VIA)
    return 'category';
  if (via === HABIT_VIA) return 'habit';
  if (via === ROLL_VIA) return 'roll';
  if (via === SITTING_VIA) return 'sitting';
  if (via === LC_ROLL_LINK_VIA) return 'lcRollLink';
  if (via === COACH_ATTEMPT_VIA) return 'coachAttempt';
  if (via === COACH_SLOT_VIA) return 'coachSlot';
  if (via === COACH_FLOOR_VIA) return 'coachFloor';
  if (via === COACH_FOCUS_VIA) return 'coachFocus';
  if (via === MOCK_VIA || via === UI_MOCK_VIA) return 'mock';
  if (via === FINANCE_BUCKET_VIA) return 'financeBucket';
  if (via === FINANCE_LINK_VIA) return 'financeLink';
  if (via === FINANCE_MARK_VIA) return 'financeMark';
  if (via === FINANCE_RULE_VIA) return 'financeRule';
  if (via === PUSH_SUB_VIA || via === UI_PUSH_SUB_VIA) return 'pushsub';
  if (via === REMINDER_TOGGLES_VIA) return 'reminderToggles';
  if (via === SCOPED_TOKEN_VIA || via === UI_SCOPED_TOKEN_VIA) return 'scopedToken';
  return via === PLACE_TOKEN_VIA ? 'placeToken' : 'task';
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    redirect?: 'error'; // presigned requests and the place route: a 3xx must never leave the checked host
    signal?: AbortSignal; // login.ts cachedState: a launch renew past its timeout is cancelled, not abandoned
  },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ApiDeps {
  fetch: FetchLike;
  token: () => string; // read per call — the browser session may have renewed it
  // Awaited before every request: every request goes through `backoff`, which runs this first, so a session
  // near expiry is renewed before `token()` is read.
  fresh?: () => Promise<void>;
  ledger: Ledger;
  run: string;
  sleep?: (ms: number) => Promise<void>;
  onAnswer?: (method: string, status: number, text: string) => void; // every answer, before it's checked
}

// Every finance row the server keeps: the fixture's rows shift once at link and then stand still (DEV-CHECK.md
// → One-time setup), so a read-back by id can't assume a window.
export const FINANCE_ANY_RANGE = { from: '2000-01-01', to: '2100-01-01' };

// A 429 is Lambda refusing to start the function (the account's concurrency limit — the app's own page load
// fires many requests at once), so the call never ran: retrying is safe for every method, createTask too.
export const THROTTLE_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

// The BFF's own refusal body, `{error: '…'}` — as against Lambda's throttle, which the function never wrote.
export function bffError(text: string): boolean {
  try {
    const v = JSON.parse(text) as unknown;
    return !!v && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string';
  } catch {
    return false;
  }
}

export function makeCore({
  fetch,
  token,
  fresh,
  ledger,
  run,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onAnswer,
}: ApiDeps) {
  let throttled = 0; // 429s answered so far, each retried below: a call that succeeded may still have been throttled
  // `retry(status, text)` says whether this answer is a throttle to back off from.
  async function backoff(
    send: () => ReturnType<FetchLike>,
    retry: (status: number, text: string) => boolean = (status) => status === 429,
  ): Promise<{ status: number; text: string }> {
    await fresh?.(); // once a request: the retries total well under the margin
    let res = await send();
    let text = await res.text();
    for (const wait of THROTTLE_BACKOFF_MS) {
      if (!retry(res.status, text)) break;
      if (res.status === 429) throttled++;
      await sleep(wait);
      res = await send();
      text = await res.text();
    }
    return { status: res.status, text };
  }

  async function call<T>(method: string, args: unknown[]): Promise<T> {
    const url = `${targetOrigin()}/api/${method}`;
    assertDevOrigin(url);
    const { status, text } = await backoff(() =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${token()}` },
        body: JSON.stringify({ args }),
      }),
    );
    onAnswer?.(method, status, text);
    if (status !== 200) throw new Error(`${method} → HTTP ${status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  // A write may only touch a row this harness created, through its own kind's methods.
  function assertLedger(id: string, kind: LedgerKind): void {
    if (!ledger.has(id) || ledgerKind(ledger.read(), id) !== kind)
      throw new DevcheckError(
        'LEDGER_GUARD',
        `refusing to touch ${id} — the ledger never recorded it as a ${kind}`,
      );
  }
  const assertLedgerTask = (id: string) => assertLedger(id, 'task');
  // `place-token:<run>`, once a run, before any mint (API or browser): a crash mid-call still leaves it
  // for the next run's sweep to revoke.
  function recordTokenMint(): void {
    const id = placeTokenId(run);
    if (!pendingIds(ledger.read()).includes(id))
      ledger.append({ run, op: 'created', id, via: PLACE_TOKEN_VIA, title: 'place token' });
  }
  function recordToggles(): void {
    const id = reminderTogglesId(run);
    if (!pendingIds(ledger.read()).includes(id))
      ledger.append({
        run,
        op: 'created',
        id,
        via: REMINDER_TOGGLES_VIA,
        title: 'reminder toggles',
      });
  }
  // Attachments this client created; deleteAttachment refuses any other id.
  const attachmentIds = new Set<string>();
  // Task ids captureRaw has recorded: the cap's 200 calls answer the same id, and the shared ledger is too big
  // to re-read per call.
  const capturedIds = new Set<string>();

  return {
    fetch,
    token,
    fresh,
    ledger,
    run,
    sleep,
    backoff,
    call,
    assertLedger,
    assertLedgerTask,
    recordTokenMint,
    recordToggles,
    attachmentIds,
    capturedIds,
    throttles: () => throttled,
  };
}

export type Core = ReturnType<typeof makeCore>;
