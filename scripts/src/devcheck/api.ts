// The dev check's own BFF client — signed in as the test user, so it sees exactly the partition the browser
// wrote to (the MCP agent token is pinned to the user's partition and can't). Same discipline as the BFF:
// every write is declared in the one `writes` object below and nowhere else, and the only reads are the
// `reads` object. Every request asserts the dev origin; a delete must name a ledger id. The one exception to
// the origin is a presigned URL the dev BFF minted for an attachment, under assertPresignedDevUrl.
import { AUTH_HEADER, assertDevOrigin, assertPresignedDevUrl, targetOrigin } from './config';
import { DevcheckError } from './errors';
import { pendingIds, type Ledger, type LedgerEntry } from './ledger';

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
const REMINDER_SETTING_KEYS = new Set(['remindTimed', 'remindDueDay', 'remindPlanned']);

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
}

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
// A place this harness created (through the API, or the browser's upsertPlace create — recorder.ts).
export const PLACE_VIA = 'api:upsertPlace';
export const UI_PLACE_VIA = 'ui:upsertPlace';
// A category this harness created — through the API (upsertCategory with no id), Settings' Add (the browser's
// upsertCategory create, recorder.ts) or MCP create_category. Cleaned by deleteCategory on the recorded id
// (newest-first, so after the run's tasks on it); never an existing category of the test user's.
export const CATEGORY_VIA = 'api:upsertCategory';
export const UI_CATEGORY_VIA = 'ui:upsertCategory';
export const MCP_CATEGORY_VIA = 'mcp:create_category';
// A habit this harness created. The API has no habit delete, so cleanup ARCHIVES it (`active: false`) and
// "exists" means listed and active — archived `devcheck …` habits stay on the test user, by design, until
// a tombstoning deleteHabit lands (day-guards' follow-up).
export const HABIT_VIA = 'api:upsertHabit';
// The test user's Shortcut token. It has no id, so a rotate records `place-token:<run>` — before the call, like
// a Flux set: a crash mid-call still leaves a token for the next run's sweep to revoke.
// A recurring series this harness created — through the API, the browser's upsertSeries create (recorder.ts)
// or MCP's create_series. Cleanup deletes its occurrences (tasks with that seriesId, which getDay spawned
// server-side, so no create response ever named them) and then the series, by this one recorded id.
export const SERIES_VIA = 'api:upsertSeries';
export const UI_SERIES_VIA = 'ui:upsertSeries';
export const MCP_SERIES_VIA = 'mcp:create_series';
const SERIES_VIAS: readonly string[] = [SERIES_VIA, UI_SERIES_VIA, MCP_SERIES_VIA];
export const PLACE_TOKEN_VIA = 'api:rotatePlaceToken';
export const placeTokenId = (run: string): string => `place-token:${run}`;
// A push device this harness subscribed — by the id the server answered with (a sha256(endpoint) prefix) —
// through the API, or Settings' Enable (the browser's subscribePush response, recorder.ts).
export const PUSH_SUB_VIA = 'api:subscribePush';
export const UI_PUSH_SUB_VIA = 'ui:subscribePush';
// The test user's reminder toggles, flipped by a run: like the place token, no id of its own, so
// `reminder-toggles:<run>` is recorded before the first flip (API or Settings) — a run that dies mid-way
// still leaves the next run's sweep to switch them back on. It exists while any toggle reads off.
export const REMINDER_TOGGLES_VIA = 'api:setReminderSettings';
export const reminderTogglesId = (run: string): string => `reminder-toggles:${run}`;
export const REMINDERS_ON = { remindTimed: true, remindDueDay: true, remindPlanned: true } as const;

// A bucket set or a refund link on a fixture bank row. Neither has an id of its own, so, like the token, a run
// records `finance-bucket:<run>:<row>` / `finance-link:<run>:<row>` — before the click that sets it (the
// browser does the write), run-scoped so two runs on the same row never resolve each other's entry. Cleanup
// clears the bucket / the link; the row itself is the fixture's and stays. A rule the run adds is its own
// row with an id, recorded from the create response like a place.
export const FINANCE_BUCKET_VIA = 'ui:setFinanceBucket';
export const FINANCE_LINK_VIA = 'ui:linkFinanceRefund';
export const FINANCE_RULE_VIA = 'api:upsertFinanceRule';
export const financeBucketId = (run: string, row: string): string => `finance-bucket:${run}:${row}`;
export const financeLinkId = (run: string, row: string): string => `finance-link:${run}:${row}`;
// The row a finance-bucket / finance-link ledger id names — after the last colon (a ULID has none).
export const financeRowOf = (id: string): string => id.slice(id.lastIndexOf(':') + 1);

// What a ledger id names, by the `via` it was created with — each kind is read and deleted its own way.
export type LedgerKind =
  | 'task'
  | 'flux'
  | 'place'
  | 'placeToken'
  | 'category'
  | 'habit'
  | 'financeBucket'
  | 'financeLink'
  | 'financeRule'
  | 'pushsub'
  | 'reminderToggles'
  | 'series';
export function ledgerKind(entries: LedgerEntry[], id: string): LedgerKind {
  const via = entries.find((e) => e.op === 'created' && e.id === id)?.via;
  if (via === FLUX_SET_VIA) return 'flux';
  if (via !== undefined && SERIES_VIAS.includes(via)) return 'series';
  if (via === PLACE_VIA || via === UI_PLACE_VIA) return 'place';
  if (via === CATEGORY_VIA || via === UI_CATEGORY_VIA || via === MCP_CATEGORY_VIA)
    return 'category';
  if (via === HABIT_VIA) return 'habit';
  if (via === FINANCE_BUCKET_VIA) return 'financeBucket';
  if (via === FINANCE_LINK_VIA) return 'financeLink';
  if (via === FINANCE_RULE_VIA) return 'financeRule';
  if (via === PUSH_SUB_VIA || via === UI_PUSH_SUB_VIA) return 'pushsub';
  if (via === REMINDER_TOGGLES_VIA) return 'reminderToggles';
  return via === PLACE_TOKEN_VIA ? 'placeToken' : 'task';
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    redirect?: 'error'; // presigned requests and the place route: a 3xx must never leave the checked host
  },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ApiDeps {
  fetch: FetchLike;
  token: () => string; // read per call — the browser session may have renewed it
  ledger: Ledger;
  run: string;
  sleep?: (ms: number) => Promise<void>;
}

// Every finance row the server keeps: the fixture's rows shift once at link and then stand still (DEV-CHECK.md
// → One-time setup), so a read-back by id can't assume a window.
const FINANCE_ANY_RANGE = { from: '2000-01-01', to: '2100-01-01' };

// A 429 is Lambda refusing to start the function (the account's concurrency limit — the app's own page load
// fires many requests at once), so the call never ran: retrying is safe for every method, createTask too.
const THROTTLE_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

// The BFF's own refusal body, `{error: '…'}` — as against Lambda's throttle, which the function never wrote.
function bffError(text: string): boolean {
  try {
    const v = JSON.parse(text) as unknown;
    return !!v && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string';
  } catch {
    return false;
  }
}

export function createApiClient({
  fetch,
  token,
  ledger,
  run,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}: ApiDeps) {
  // `retry(status, text)` says whether this answer is a throttle to back off from.
  async function backoff(
    send: () => ReturnType<FetchLike>,
    retry: (status: number, text: string) => boolean = (status) => status === 429,
  ): Promise<{ status: number; text: string }> {
    let res = await send();
    let text = await res.text();
    for (const wait of THROTTLE_BACKOFF_MS) {
      if (!retry(res.status, text)) break;
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

  const reads = {
    listTasks: () => call<DevTask[]>('listTasks', []),
    listBacklog: () => call<DevTask[]>('listBacklog', []),
    getTask: (id: string) => call<DevTask | null>('getTask', [id]),
    listCategories: () => call<DevCategory[]>('listCategories', []),
    listPlansForDay: (day: string) => call<DevPlan[]>('listPlansForDay', [day]),
    listHabits: () => call<DevHabit[]>('listHabits', []),
    listHabitChecks: (range: { from: string; to: string }) =>
      call<DevHabitCheck[]>('listHabitChecks', [range]),
    // The app's own day read (it materializes due series and sweeps the day) — today only, as the app.
    getDay: (day: string) => call<DevDay>('getDay', [day]),
    // The day boundary the app files a set under (a Flux set's `day` is the app's day, not the calendar's).
    getSettings: () => call<DevSettings>('getSettings', []),
    listRunningSessions: () => call<DevSession[]>('listRunningSessions', []),
    listSessionsForDay: (day: string) => call<DevSession[]>('listSessionsForDay', [day]),
    listFluxSets: () => call<DevFluxSet[]>('listFluxSets', [{}]),
    // The weekly note (D62): a read that may write the cached row — the app's own read, not a scenario write.
    getFluxWeekNote: () =>
      call<{ weekStart: string; text: string; generatedAt: number } | null>('getFluxWeekNote', []),
    // Alive only — a deleted set reads as gone, like getTask.
    getFluxSet: async (id: string) =>
      (await call<DevFluxSet[]>('listFluxSets', [{}])).find((f) => f.id === id) ?? null,
    listAttachments: (taskId: string) => call<DevAttachment[]>('listAttachments', [taskId]),
    getAttachmentDownloadUrl: (id: string) => call<string>('getAttachmentDownloadUrl', [id]),
    // Every alive series, stopped ones included (a deleted one reads as gone).
    listSeries: () => call<DevSeries[]>('listSeries', []),
    // GET a BFF-minted presigned URL and return only its status (200 while the bytes exist, 403/404 after).
    // Gone is 403 or 404 — see isGone.
    async probePresigned(url: string): Promise<number> {
      assertPresignedDevUrl(url);
      const res = await fetch(url, { method: 'GET', headers: {}, redirect: 'error' });
      await res.text(); // drain
      return res.status;
    },
    listPlaces: () => call<DevPlace[]>('listPlaces', []),
    // The digest as an RPC read — no heartbeat, no count (the Shortcut route below is the one that counts).
    listPlaceTasks: (slug: string) => call<DevPlaceDigest>('listPlaceTasks', [slug]),
    getPlaceTokenStatus: () => call<DevPlaceTokenStatus>('getPlaceTokenStatus', []),
    // Devices (never their endpoint or keys), the removed list, and the poller's health line.
    getPushStatus: () => call<DevPushStatus>('getPushStatus', []),
    getCalibration: (range: { from: string; to: string }) =>
      call<DevCalibrationPoint[]>('getCalibration', [range]),
    listFinanceTransactions: (range: { from: string; to: string }) =>
      call<DevFinanceTransaction[]>('listFinanceTransactions', [range]),
    // One row by id, anywhere the server keeps it (there is no get-by-id RPC) — null when gone.
    getFinanceTransaction: async (id: string) =>
      (await call<DevFinanceTransaction[]>('listFinanceTransactions', [FINANCE_ANY_RANGE])).find(
        (t) => t.id === id,
      ) ?? null,
    listFinanceRules: () => call<DevFinanceRule[]>('listFinanceRules', []),
    // The iPhone Shortcut's route, raw: GET /api/places/<slug>/tasks with the place token (never the session
    // JWT) in the BFF header, or none — the status and parsed body, whatever they are, so a step can assert a
    // refusal. A 200 bumps the token's count and the place's lastReadAt server-side, as the Shortcut does;
    // every other answer writes nothing (lambdas/src/index.ts) and carries `{error, text}` — never a 404,
    // which CloudFront would rewrite to the app shell. `method` is GET but for proving the 405. A 429
    // carrying the BFF's own `{error}` is the daily cap, returned as is; any other 429 is Lambda throttling
    // and is backed off like call()'s.
    async placeDigestRaw(
      slug: string,
      placeToken: string | null,
      method: 'GET' | 'POST' = 'GET',
    ): Promise<{ status: number; body: unknown }> {
      const url = `${targetOrigin()}/api/places/${encodeURIComponent(slug)}/tasks`;
      assertDevOrigin(url);
      const headers: Record<string, string> = placeToken
        ? { [AUTH_HEADER]: `Bearer ${placeToken}` }
        : {};
      const { status, text } = await backoff(
        () => fetch(url, { method, headers, redirect: 'error' }),
        (s, t) => s === 429 && !bffError(t),
      );
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        return { status, body: text.slice(0, 200) };
      }
    },
  };

  const writes = {
    // The test user's own settings row — not ledgered; a step that changes it puts it back in its `finally`
    // (a 1-minute block for the capped-stop row, 25 again after), and a killed run's next run does (pipeline).
    updateSettings: (patch: Partial<DevSettings>) => call<DevSettings>('updateSettings', [patch]),
    // Only for a stop the server must refuse (a bad cap): the app stops its timers through the UI.
    stopSession: (id: string, status: 'completed', opts: { capMin: number }) =>
      call<DevSession>('stopSession', [id, status, opts]),
    async createTask(input: CreateTaskInput): Promise<DevTask> {
      ledger.append({ run, op: 'intent', via: 'api:createTask', title: input.title });
      const task = await call<DevTask>('createTask', [input]);
      ledger.append({ run, op: 'created', id: task.id, via: 'api:createTask', title: input.title });
      return task;
    },
    // The id is known before the call (the client mints it), so `created` is recorded first: a crash
    // mid-call still leaves the id for the next run's sweep.
    async recordFluxSet(input: DevFluxSetInput): Promise<DevFluxSet> {
      const title = `flux ${input.exerciseId}`;
      if (!pendingIds(ledger.read()).includes(input.id))
        ledger.append({ run, op: 'created', id: input.id, via: FLUX_SET_VIA, title });
      return call<DevFluxSet>('recordFluxSet', [input]);
    },
    async deleteFluxSet(id: string): Promise<void> {
      const recorded = ledger
        .read()
        .some((e) => e.op === 'created' && e.id === id && e.via === FLUX_SET_VIA);
      if (!recorded)
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete Flux set ${id} — the ledger never recorded it`,
        );
      await call<null>('deleteFluxSet', [id]);
    },
    // The reflection scenario's direct BFF call (its over-cap refusal), on a task this harness created.
    async setTaskActual(
      id: string,
      actualMin: number,
      reflection?: string | null,
    ): Promise<DevTask> {
      assertLedgerTask(id);
      return call<DevTask>(
        'setTaskActual',
        reflection === undefined ? [id, actualMin] : [id, actualMin, reflection],
      );
    },
    async deleteTask(id: string): Promise<void> {
      assertLedgerTask(id);
      await call<null>('deleteTask', [id]);
    },
    // A plan row on a task this harness created; deleting the task removes its plans.
    async upsertPlan(input: {
      id?: string;
      taskId: string;
      day: string;
      plannedMinutes: number;
      order: number;
    }): Promise<DevPlan> {
      assertLedgerTask(input.taskId);
      return call<DevPlan>('upsertPlan', [input]);
    },
    // The row itself, so the guard can see whose task it is (plan ids are never ledgered).
    async removePlan(plan: DevPlan): Promise<void> {
      assertLedgerTask(plan.taskId);
      await call<null>('removePlan', [plan.id]);
    },
    async transitionTask(
      id: string,
      status: 'backlog' | 'planned' | 'in_progress',
    ): Promise<DevTask> {
      assertLedgerTask(id);
      return call<DevTask>('transitionTask', [id, status]);
    },
    // A running work timer on a task this harness created, as the dock's Focus would start one. Sessions
    // have no delete, so none is ledgered (failed-reads' ad-hoc timer, likewise): the scenario's rows stop
    // it through the UI; one a failed step leaves running is cleared through the dock by the next timer
    // scenario's clearTimers (timer-credit, later in the run).
    async startSession(taskId: string, day: string): Promise<DevSession> {
      assertLedgerTask(taskId);
      return call<DevSession>('startSession', [
        { taskId, categoryId: null, kind: 'work', label: null, day },
      ]);
    },
    // Create (no id) is ledgered like a category; an update must name a habit the ledger recorded.
    async upsertHabit(input: {
      id?: string;
      name: string;
      categoryId: string | null;
      cadencePerWeek: number;
      active?: boolean;
    }): Promise<DevHabit> {
      if (input.id) {
        assertLedger(input.id, 'habit');
        return call<DevHabit>('upsertHabit', [input]);
      }
      ledger.append({ run, op: 'intent', via: HABIT_VIA, title: input.name });
      const habit = await call<DevHabit>('upsertHabit', [input]);
      ledger.append({ run, op: 'created', id: habit.id, via: HABIT_VIA, title: input.name });
      return habit;
    },
    // Cleanup's "delete": the API has none for habits, so the recorded habit is archived (HABIT_VIA).
    async archiveHabit(id: string): Promise<void> {
      assertLedger(id, 'habit');
      const habit = (await reads.listHabits()).find((h) => h.id === id);
      if (!habit) return; // never there, or gone some other way — nothing to archive
      await call<DevHabit>('upsertHabit', [{ ...habit, active: false }]);
    },
    checkHabit: (habitId: string, date: string) => {
      assertLedger(habitId, 'habit');
      return call<DevHabitCheck>('checkHabit', [habitId, date]);
    },
    uncheckHabit: (habitId: string, date: string) => {
      assertLedger(habitId, 'habit');
      return call<null>('uncheckHabit', [habitId, date]);
    },
    // The test user's own day row — a singleton, nothing to ledger; a step that sets it puts the prior
    // values back (parts-v2b-reads).
    setDayCapacity: (day: string, capacityHours: number | null) =>
      call<DevDay>('setDayCapacity', [day, capacityHours]),
    setDayIntent: (day: string, intent: string) => call<DevDay>('setDayIntent', [day, intent]),
    // Create (no id) is ledgered like a place — intent, then the server's id; an update must name a
    // category the ledger recorded.
    async upsertCategory(input: {
      id?: string;
      label: string;
      isWork: boolean;
      order?: number;
      active?: boolean;
      area?: DevCategory['area']; // the areas scenario; omitted = none (reads as Personal)
    }): Promise<DevCategory> {
      if (input.id) {
        assertLedger(input.id, 'category');
        return call<DevCategory>('upsertCategory', [input]);
      }
      ledger.append({ run, op: 'intent', via: CATEGORY_VIA, title: input.label });
      const cat = await call<DevCategory>('upsertCategory', [input]);
      ledger.append({ run, op: 'created', id: cat.id, via: CATEGORY_VIA, title: input.label });
      return cat;
    },
    // Its tasks move to `reassignToId`, or to no category (null) — cleanup passes null. Cleanup runs
    // newest-first: a run task on a run category is fine when the category was made first (the areas
    // scenario — its tasks go before it), and refused when the task was made first, so a scenario that
    // makes the category last puts no task on it.
    async deleteCategory(id: string, reassignToId: string | null): Promise<void> {
      assertLedger(id, 'category');
      await call<null>('deleteCategory', [id, reassignToId]);
    },
    // A series counts from the app's today (getSettings' day boundary), as the Recurring tab does.
    async createSeries(input: CreateSeriesInput, anchorDate: string): Promise<DevSeries> {
      ledger.append({ run, op: 'intent', via: SERIES_VIA, title: input.title });
      const s = await call<DevSeries>('upsertSeries', [
        { categoryId: null, defaultEstimateMin: null, ...input, anchorDate },
      ]);
      ledger.append({ run, op: 'created', id: s.id, via: SERIES_VIA, title: input.title });
      return s;
    },
    // A recorded series goes with every occurrence it spawned: those tasks were made server-side by getDay
    // (no create response named them), so the series id is their record. deleteTask is the BFF's — the app's
    // and MCP's delete refuse an occurrence only because the series would respawn it, which the tombstone ends.
    async deleteSeries(id: string): Promise<void> {
      assertLedger(id, 'series');
      for (const t of (await reads.listTasks()).filter((t) => t.seriesId === id))
        await call<null>('deleteTask', [t.id]);
      await call<null>('deleteSeries', [id]);
    },
    // The area write (setCategoryArea). `area` is sent as given — a step proving the refusal passes a bad one.
    async setCategoryArea(id: string, area: string | null): Promise<DevCategory> {
      assertLedger(id, 'category');
      return call<DevCategory>('setCategoryArea', [id, area]);
    },
    // Mint an upload URL, PUT the bytes to S3 as the app does, then confirm — or leave it pending
    // (confirm: false), as an abandoned upload would.
    async createAttachment(
      taskId: string,
      file: { filename: string; contentType: string; text: string; confirm?: boolean },
    ): Promise<DevAttachment> {
      assertLedgerTask(taskId);
      const bytes = new TextEncoder().encode(file.text);
      const { attachment, uploadUrl } = await call<{
        attachment: DevAttachment;
        uploadUrl: string;
      }>('createAttachmentUploadUrl', [
        { taskId, filename: file.filename, contentType: file.contentType, size: bytes.byteLength },
      ]);
      attachmentIds.add(attachment.id);
      assertPresignedDevUrl(uploadUrl);
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': attachment.contentType }, // the server-normalised type
        body: bytes,
        redirect: 'error',
      });
      if (res.status !== 200) throw new Error(`attachment PUT → HTTP ${res.status}`);
      if (file.confirm === false) return attachment;
      return call<DevAttachment>('confirmAttachment', [attachment.id]);
    },
    async deleteAttachment(taskId: string, id: string): Promise<void> {
      assertLedgerTask(taskId);
      if (!attachmentIds.has(id))
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete attachment ${id} — not this run's`,
        );
      await call<null>('deleteAttachment', [id]);
    },
    // Create (no id) is ledgered like createTask — intent, then the server's id; an update must name a place
    // the ledger recorded.
    async upsertPlace(input: { id?: string; name: string; slug?: string }): Promise<DevPlace> {
      if (input.id) {
        assertLedger(input.id, 'place');
        return call<DevPlace>('upsertPlace', [input]);
      }
      ledger.append({ run, op: 'intent', via: PLACE_VIA, title: input.name });
      const place = await call<DevPlace>('upsertPlace', [input]);
      ledger.append({ run, op: 'created', id: place.id, via: PLACE_VIA, title: input.name });
      return place;
    },
    // Its alive tasks move to `reassignToSlug`, or off any list (null) — cleanup passes null.
    async deletePlace(id: string, reassignToSlug: string | null): Promise<void> {
      assertLedger(id, 'place');
      await call<null>('deletePlace', [id, reassignToSlug]);
    },
    // The plaintext comes back once; it lives in the step's memory only — never logged, never ledgered.
    async rotatePlaceToken(): Promise<{ token: string; status: DevPlaceTokenStatus }> {
      recordTokenMint();
      return call<{ token: string; status: DevPlaceTokenStatus }>('rotatePlaceToken', []);
    },
    // The ledger half alone, for Settings' Generate / Rotate: called before the click, so a token the
    // browser mints is recorded like one rotated here. Writes nothing to dev.
    recordPlaceTokenMint: (): void => recordTokenMint(),
    // The ledger half of a bucket set / refund link the browser is about to make on a fixture row: called
    // before the click, so a crash mid-step still leaves it for the next run's sweep to clear. Writes
    // nothing to dev; recorded once a run per row.
    recordFinanceBucket(row: string): void {
      const id = financeBucketId(run, row);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({
          run,
          op: 'created',
          id,
          via: FINANCE_BUCKET_VIA,
          title: `bucket on ${row}`,
        });
    },
    recordFinanceLink(row: string): void {
      const id = financeLinkId(run, row);
      if (!pendingIds(ledger.read()).includes(id))
        ledger.append({ run, op: 'created', id, via: FINANCE_LINK_VIA, title: `link on ${row}` });
    },
    // Cleanup's halves: clear what a recorded entry set — never a row the ledger doesn't name.
    async unsetFinanceBucket(id: string): Promise<void> {
      assertLedger(id, 'financeBucket');
      await call<unknown>('setFinanceBucket', [{ ids: [financeRowOf(id)], bucket: null }]);
    },
    async unlinkFinanceRefund(id: string): Promise<void> {
      assertLedger(id, 'financeLink');
      await call<unknown>('linkFinanceRefund', [financeRowOf(id), null]);
    },
    // A rule, recorded from the create response like a place; deleted only when recorded.
    async upsertFinanceRule(input: { pattern: string; bucket: string }): Promise<DevFinanceRule> {
      ledger.append({ run, op: 'intent', via: FINANCE_RULE_VIA, title: input.pattern });
      const rule = await call<DevFinanceRule>('upsertFinanceRule', [input]);
      ledger.append({
        run,
        op: 'created',
        id: rule.id,
        via: FINANCE_RULE_VIA,
        title: input.pattern,
      });
      return rule;
    },
    async deleteFinanceRule(id: string): Promise<void> {
      assertLedger(id, 'financeRule');
      await call<null>('deleteFinanceRule', [id]);
    },
    // Only while the ledger holds a token a run minted and nothing has resolved yet: the test user's token
    // is the harness's to revoke only when the harness made it.
    async revokePlaceToken(): Promise<void> {
      const entries = ledger.read();
      if (!pendingIds(entries).some((id) => ledgerKind(entries, id) === 'placeToken'))
        throw new DevcheckError(
          'LEDGER_GUARD',
          'refusing to revoke the place token — no run recorded minting it',
        );
      await call<null>('revokePlaceToken', []);
    },
    // Reminders. A subscribe is ledgered like createTask — intent, then the server's id — so cleanup removes
    // the device by id; a device the poller already dropped (a 404/410 from the push service) reads as gone.
    async subscribePush(input: DevSubscribePushInput): Promise<DevPushDevice> {
      ledger.append({ run, op: 'intent', via: PUSH_SUB_VIA, title: input.label });
      const device = await call<DevPushDevice>('subscribePush', [input]);
      ledger.append({ run, op: 'created', id: device.id, via: PUSH_SUB_VIA, title: input.label });
      return device;
    },
    // The SSRF row: a subscribe the BFF must refuse (HTTP 400), so nothing is ledgered first — an intent
    // with no create would read as a leak. Answers the refusal's message. Should it land after all, its id
    // is recorded (cleanup removes it) and the call throws.
    async subscribePushExpectingRefusal(input: DevSubscribePushInput): Promise<string> {
      const url = `${DEV_ORIGIN}/api/subscribePush`;
      assertDevOrigin(url);
      const { status, text } = await backoff(() =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [AUTH_HEADER]: `Bearer ${token()}` },
          body: JSON.stringify({ args: [input] }),
        }),
      );
      if (status === 200) {
        const id = (JSON.parse(text) as { id?: unknown }).id;
        if (typeof id === 'string')
          ledger.append({ run, op: 'created', id, via: PUSH_SUB_VIA, title: input.label });
        throw new Error(`subscribePush accepted ${input.endpoint} — it should have refused`);
      }
      if (status !== 400 || !bffError(text))
        throw new Error(`subscribePush → HTTP ${status}: ${text.slice(0, 200)}`);
      return (JSON.parse(text) as { error: string }).error;
    },
    async unsubscribePush(id: string): Promise<void> {
      assertLedger(id, 'pushsub');
      await call<null>('unsubscribePush', [id]);
    },
    // Queues a test on the test user's devices — all of them this harness's (the test user has no phone).
    sendTestPush: () => call<null>('sendTestPush', []),
    // Only the three reminder toggles, recorded before the write (`reminder-toggles:<run>`) so cleanup
    // switches them back on whatever happens; cleanup's own restore goes through here too.
    async setReminderSettings(patch: DevReminderSettings): Promise<void> {
      for (const k of Object.keys(patch))
        if (!REMINDER_SETTING_KEYS.has(k))
          throw new DevcheckError(
            'LEDGER_GUARD',
            `refusing to write setting ${k} — reminder toggles only`,
          );
      recordToggles();
      await call<unknown>('updateSettings', [patch]);
    },
    // The ledger half alone, for a Settings toggle click: called before it. Writes nothing to dev.
    recordReminderToggles: (): void => recordToggles(),
  };

  return { reads, writes };
}

export type ApiClient = ReturnType<typeof createApiClient>;
