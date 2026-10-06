import {
  assertAttachmentAllowed,
  assertCategoryDeletable,
  calendarSyncPlan,
  completeSession,
  countsTowardCap,
  createUlid,
  dayKey,
  dayKeyForOffset,
  discardSession,
  eventWindow,
  gcalSyncMessage,
  isPendingRemoval,
  FINANCE_DEFAULT_BUDGET_CENTS,
  FINANCE_DEFAULT_PAYMENT_DAY,
  findOpenRollTask,
  heartbeatSession,
  normalizeContentType,
  normalizeDue,
  normalizeNotes,
  normalizeVerdict,
  resolveStaleSession,
  resumeSession,
  ROLL_PLAN_FALLBACK_MIN,
  rollRepFields,
  sanitizeFilename,
  seriesDueOn,
  setNotesArg,
  followUpPlanDay,
  followUpPlanMinutes,
  calibrationTasks,
  splitFollowUp,
  splitOriginal,
  stalePlannedMoves,
  taskTransition,
  UPLOAD_URL_TTL_MS,
  USER_TIME_ZONE,
  viewableInline,
  withEstimate,
  zonedEpoch,
} from '@aperture/shared';
import type {
  ApiClient,
  Attachment,
  BaseEntity,
  BusyInterval,
  CalendarBusy,
  CalibrationPoint,
  Category,
  CreateAttachmentInput,
  CreateLinkTokenInput,
  CreateTaskInput,
  DateRange,
  Day,
  GetCalendarBusyInput,
  GoogleCalendar,
  GoogleStatus,
  InsertCalendarEventInput,
  ExchangePublicTokenInput,
  ExportBundle,
  FinanceAccount,
  FinanceAccountPatch,
  FinanceItem,
  FinanceOverview,
  FinancePeriodOverride,
  FinanceRule,
  FinanceTransaction,
  LinkTokenResult,
  RequestFinanceSyncResult,
  SetFinanceBucketInput,
  SetTaskDueInput,
  SplitTaskInput,
  UpsertFinanceRuleInput,
  Habit,
  HabitCheck,
  Idea,
  IdeaStatus,
  LeetcodeAttempt,
  LogEntry,
  PomodoroSession,
  RecordLeetcodeAttemptInput,
  Roll,
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
  UpsertRollInput,
  UpsertSeriesInput,
} from '@aperture/shared';
import type { Repo } from './ddb/repo';
import { FinanceService } from './finance/service';
import { noopInvoker } from './finance/invoker';
import type { FinanceSyncInvoker } from './finance/invoker';
import { noopPlaid } from './plaid/gateway';
import type { PlaidGateway } from './plaid/gateway';
import { EventGoneError, noopGoogle } from './google/gateway';
import type { GoogleGateway } from './google/gateway';
import { signState } from './google/state';
import type { Presigner } from './s3/presigner';

export interface BackendOptions {
  userId?: string;
  now?: () => number;
  google?: GoogleGateway; // gated external calendar seam; defaults to the inert noop
  stateSecret?: string; // HMAC key for the OAuth state (derived from ORIGIN_SECRET in prod)
  presigner?: Presigner;
  plaid?: PlaidGateway; // gated Plaid seam; defaults to the inert noop
  financeInvoker?: FinanceSyncInvoker; // starts a finance sync; defaults to nothing
}

// Non-attachment methods never touch it, so a missing presigner is only an error if an attachment method
// is actually called (e.g. a smoke run, or a misconfigured handler).
const unconfiguredPresigner: Presigner = {
  putUrl: () => {
    throw new Error('Attachments unavailable: no presigner configured.');
  },
  getUrl: () => {
    throw new Error('Attachments unavailable: no presigner configured.');
  },
};

// The server-side ApiClient — the SAME contract as the stub, over the DynamoDB Repo. Business rules
// come straight from the shared machines (taskTransition/withEstimate/split/heartbeat/…), so lifecycle
// behavior is identical to the stub by construction. The one thing SK order doesn't give for free is
// the stub's explicit list sorts, so each list method re-applies them for byte-for-byte parity.
// Calendar inserts in flight at once for a bulk create (createTasks), and how long — measured from the
// call's start, so the task writes count — new ones may start for. Worst case: budget (3 s) + one
// sync's two Google fetches at GOOGLE_TIMEOUT_MS each (token refresh + insert, liveGoogle.ts) = 11 s,
// plus the uncapped-but-fast SSM token read and a few DynamoDB writes — inside the 15 s Lambda timeout.
const SYNC_CONCURRENCY = 4;
const BULK_SYNC_BUDGET_MS = 3_000;

export class BackendClient implements ApiClient {
  private readonly userId: string;
  private readonly now: () => number;
  private readonly ulid: () => string;
  private readonly google: GoogleGateway;
  private readonly stateSecret: string;
  private readonly presigner: Presigner;
  private readonly finance: FinanceService;

  constructor(
    private readonly repo: Repo,
    opts: BackendOptions = {},
  ) {
    this.userId = opts.userId ?? 'local';
    this.now = opts.now ?? (() => Date.now());
    this.ulid = createUlid(this.now);
    this.google = opts.google ?? noopGoogle();
    this.stateSecret = opts.stateSecret ?? 'dev-state-secret';
    this.presigner = opts.presigner ?? unconfiguredPresigner;
    this.finance = new FinanceService({
      repo,
      userId: this.userId,
      now: this.now,
      ulid: this.ulid,
      plaid: opts.plaid ?? noopPlaid(),
      invoker: opts.financeInvoker ?? noopInvoker(),
      settings: () => this.ensureSettings(),
    });
  }

  private baseAt(t: number): BaseEntity {
    return { id: this.ulid(), userId: this.userId, createdAt: t, updatedAt: t, deletedAt: null };
  }
  private base(): BaseEntity {
    return this.baseAt(this.now());
  }
  // The task literal, shared by createTask and createTasks. `t` is the createdAt stamp — a batch passes
  // one value for every task so they tie on createdAt and render as a block in ULID (paste) order.
  private newTask(input: CreateTaskInput, t: number): Task {
    return {
      ...this.baseAt(t),
      title: input.title,
      status: 'backlog',
      categoryId: input.categoryId ?? null,
      ...normalizeDue(input.dueDay ?? null, input.dueTime ?? null),
      notes: normalizeNotes(input.notes),
      seriesId: null,
      rollId: null,
      estimateMin: input.estimateMin ?? null,
      bufferMin: input.bufferMin ?? null,
      estimateLockedMin: null,
      splitFromId: null,
      actualAccruedMin: 0,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
      gcalSyncError: null,
    };
  }
  private async ensureSettings(): Promise<Settings> {
    const def: Settings = {
      ...this.base(),
      dayStartHour: 4,
      pomodoroWorkMin: 25,
      pomodoroBreakMin: 5,
      theme: 'auto',
      googleAccounts: [],
      calendarShapeRefs: [],
      calendarWriteDefault: null,
      autoCalendar: true,
      dayFocusStart: 8,
      dayEndHour: 22,
      financeBudgetCents: FINANCE_DEFAULT_BUDGET_CENTS,
      financePaymentDay: FINANCE_DEFAULT_PAYMENT_DAY,
    };
    const row = await this.repo.getSettingsRow();
    // Backfill defaults over an existing row: fields added later (the calendar set) read as their
    // default, not undefined, on settings written before those fields existed.
    if (row) return { ...def, ...row };
    await this.repo.putSettings(def);
    return def;
  }
  // The Lambda's clock is UTC — a task's wall-clock deadline is resolved in the user's zone, never locally.
  private readonly dueEpoch = (day: string, hhmm: string): number =>
    zonedEpoch(day, hhmm, USER_TIME_ZONE);

  // Calendar auto-sync after a task write (shared calendarSyncPlan decides; docs/areas/calendar →
  // Auto-sync). The task is already saved: a Google failure never fails the write — it lands on the
  // task as gcalSyncError (shown with a retry) and is logged, and a failed remove keeps the event linked
  // so the retry can finish it. Returns the task as it now stands.
  private async syncCalendar(
    prev: Task | null,
    task: Task,
    ensure = false,
    known?: Settings, // a batch reads settings once
  ): Promise<Task> {
    // Most writes are on untimed, unlinked tasks — nothing to sync, so don't even read settings.
    if (!task.dueTime && !task.gcalEventId && !task.gcalSyncError) return task;
    const settings = known ?? (await this.ensureSettings());
    const action = calendarSyncPlan(prev, task, settings, this.dueEpoch, { ensure });
    if (action.kind === 'none') {
      // A stale failure note goes once nothing is left to sync: no event and no time, sync turned off,
      // or the task finished — otherwise it'd sit there with a Retry that can't do anything.
      const moot =
        task.gcalSyncError &&
        ((!task.gcalEventId && !eventWindow(task, this.dueEpoch)) ||
          settings.autoCalendar === false ||
          task.status === 'done' ||
          task.status === 'cancelled');
      return moot ? this.putGcal(task, { gcalSyncError: null }) : task;
    }
    const unlinked = {
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
      gcalSyncError: null,
    };
    try {
      if (action.kind === 'create') {
        const { eventId } = await this.google.insertEvent({
          sub: action.target.accountSub,
          calendarId: action.target.calendarId,
          title: action.title,
          startMs: action.startMs,
          endMs: action.endMs,
        });
        return this.putGcal(task, {
          gcalAccountId: action.target.accountSub,
          gcalCalendarId: action.target.calendarId,
          gcalEventId: eventId,
          gcalSyncError: null,
        });
      }
      if (!task.gcalAccountId || !task.gcalCalendarId || !task.gcalEventId) return task;
      const ref = {
        sub: task.gcalAccountId,
        calendarId: task.gcalCalendarId,
        eventId: task.gcalEventId,
      };
      // Not via deleteCalendarEvent: that swallows Google errors (right for cancel/delete, where the
      // task is going away) — here a failed remove must surface. An already-gone event is a success.
      if (action.kind === 'delete') {
        await this.google.deleteEvent(ref).catch((e: unknown) => {
          if (!(e instanceof EventGoneError)) throw e;
        });
        return this.putGcal(task, unlinked);
      }
      try {
        await this.google.patchEvent({
          ...ref,
          title: action.title,
          startMs: action.startMs,
          endMs: action.endMs,
        });
      } catch (e) {
        if (!(e instanceof EventGoneError)) throw e;
        // Deleted in Google on purpose — drop the dead pointer, don't resurrect it. A later time change
        // creates a fresh one.
        return this.putGcal(task, unlinked);
      }
      return task.gcalSyncError ? this.putGcal(task, { gcalSyncError: null }) : task;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.log(
        JSON.stringify({ event: 'gcal_sync_failed', taskId: task.id, kind: action.kind, detail }),
      );
      return this.putGcal(task, { gcalSyncError: gcalSyncMessage(action.kind, detail) });
    }
  }
  // Write only the calendar fields, onto a FRESH read: the sync spans a Google round-trip, and a
  // concurrent write (a session closing, an edit from another device) must not be overwritten by it.
  // (No row — a testMode write that never landed — falls back to the task in hand.)
  private async putGcal(
    task: Task,
    fields: Partial<
      Pick<Task, 'gcalAccountId' | 'gcalCalendarId' | 'gcalEventId' | 'gcalSyncError'>
    >,
  ): Promise<Task> {
    const fresh = (await this.repo.getTask(task.id)) ?? task;
    return this.repo.putTask({ ...fresh, ...fields, updatedAt: this.now() });
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
    // Extension is passive; metadata is DOM-scraped client-side (docs/areas/recruiting/index.md → Design
    // decisions). Log `metaCaptured` per ingest for the Logs Insights hit-rate query — deliberately no
    // custom metric (same doc → Watching an ingest).
    const metaCaptured =
      input.difficulty != null || (Array.isArray(input.topicTags) && input.topicTags.length > 0);
    console.log(
      JSON.stringify({ event: 'leetcode_ingest', problemSlug: input.problemSlug, metaCaptured }),
    );
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

  // --- Story bank ---
  private async mustStory(id: string): Promise<Story> {
    const s = await this.repo.getStory(id);
    if (!s) throw new Error(`Not found: ${id}`);
    return s;
  }
  async listStories(): Promise<Story[]> {
    // Same sort the stub applies (SK order doesn't give updatedAt-desc for free).
    return (await this.repo.listStories()).sort(
      (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
    );
  }
  async createStory(input: CreateStoryInput): Promise<Story> {
    return this.repo.putStory({
      ...this.base(),
      title: input.title,
      competencyTags: input.competencyTags ?? [],
      situation: input.situation ?? '',
      action: input.action ?? '',
      result: input.result ?? '',
    });
  }
  async updateStory(id: string, patch: StoryPatch): Promise<Story> {
    return this.repo.putStory({ ...(await this.mustStory(id)), ...patch, updatedAt: this.now() });
  }
  async deleteStory(id: string): Promise<void> {
    const existing = await this.repo.getStory(id);
    if (existing)
      await this.repo.putStory({ ...existing, deletedAt: this.now(), updatedAt: this.now() });
  }

  // --- Task attachments ---
  private async mustAttachment(id: string): Promise<Attachment> {
    const a = await this.repo.findAttachment(id); // null on missing OR tombstoned
    if (!a) throw new Error(`Not found: ${id}`);
    return a;
  }
  async createAttachmentUploadUrl(
    input: CreateAttachmentInput,
  ): Promise<{ attachment: Attachment; uploadUrl: string }> {
    await this.mustTask(input.taskId); // must exist under this user's partition (cross-user impossible)
    const now = this.now();
    const liveCount = (await this.repo.listAttachmentsForTask(input.taskId)).filter((a) =>
      countsTowardCap(a, now),
    ).length;
    assertAttachmentAllowed(input.size, liveCount); // size/type/count enforced server-side, pre-signing
    const b = this.base();
    const attachment: Attachment = {
      ...b,
      taskId: input.taskId,
      filename: sanitizeFilename(input.filename),
      contentType: normalizeContentType(input.contentType),
      size: input.size,
      s3Key: `u/${this.userId}/${input.taskId}/${b.id}`, // scoped by the JWT sub, never the filename
      status: 'pending',
    };
    await this.repo.putAttachment(attachment);
    const uploadUrl = await this.presigner.putUrl(
      attachment.s3Key,
      attachment.contentType,
      attachment.size,
    );
    return { attachment, uploadUrl };
  }
  async confirmAttachment(id: string): Promise<Attachment> {
    const a = await this.mustAttachment(id);
    if (a.status === 'ready') return a; // idempotent
    // Past the upload TTL the presigned PUT can't have succeeded, and countsTowardCap has already freed
    // the slot — confirming here would resurrect a discounted row (cap bypass) and mark a byte-less object
    // ready. Reject; the client re-requests a fresh upload URL.
    if (this.now() - a.createdAt >= UPLOAD_URL_TTL_MS)
      throw new Error('Upload window expired; start the upload again.');
    return this.repo.putAttachment({ ...a, status: 'ready', updatedAt: this.now() });
  }
  async listAttachments(taskId?: string): Promise<Attachment[]> {
    const rows =
      taskId === undefined
        ? await this.repo.listAllAttachments()
        : await this.repo.listAttachmentsForTask(taskId);
    return rows
      .filter((a) => a.status === 'ready')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async getAttachmentDownloadUrl(id: string): Promise<string> {
    const a = await this.mustAttachment(id);
    // Browser-renderable, script-free types (image/PDF/text/audio/video) open inline; HTML, SVG/+xml,
    // and unknown binaries are forced to a download so nothing active runs from the S3 origin.
    const disposition = viewableInline(a.contentType)
      ? 'inline'
      : `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`;
    return this.presigner.getUrl(a.s3Key, a.contentType, disposition);
  }
  async deleteAttachment(id: string): Promise<void> {
    const a = await this.repo.findAttachment(id);
    if (a) await this.repo.putAttachment({ ...a, deletedAt: this.now(), updatedAt: this.now() });
    // The S3 object is intentionally orphaned (no bytes-cleanup path in v1).
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
    return this.syncCalendar(null, await this.repo.putTask(this.newTask(input, this.now())));
  }
  async createTasks(inputs: CreateTaskInput[]): Promise<Task[]> {
    if (inputs.length === 0) return [];
    const t = this.now();
    const tasks = inputs.map((input) => this.newTask(input, t)); // normalizes all first: one bad input writes nothing
    const deadline = Date.now() + BULK_SYNC_BUDGET_MS; // from the start: the writes below spend it too
    const saved = await this.repo.putTasks(tasks);
    if (!saved.some((t) => t.dueTime)) return saved;
    // Timed tasks get their events a few at a time, inside a time budget: the tasks are already saved,
    // so the Lambda timing out now would report a failed paste (and invite a duplicating resubmit). No
    // new Google call starts after the budget, or once one has failed (Google is likely down for all
    // of them) — the rest are marked for Retry instead. Worst case: budget + one sync's timeouts.
    const settings = await this.ensureSettings();
    let tripped = false;
    const out = [...saved];
    const skipped: number[] = [];
    let next = 0;
    const worker = async () => {
      while (next < out.length) {
        const i = next++;
        const task = out[i]!;
        if (!task.dueTime) continue;
        if (tripped || Date.now() > deadline) {
          skipped.push(i);
          continue;
        }
        out[i] = await this.syncCalendar(null, task, false, settings);
        if (out[i]!.gcalSyncError) tripped = true;
      }
    };
    await Promise.all(Array.from({ length: SYNC_CONCURRENCY }, worker));
    // Mark the skipped rows for Retry — in parallel, each onto a fresh read (putGcal): they've been
    // listable since putTasks, so another device may have touched one meanwhile.
    const note = gcalSyncMessage('create', 'not attempted — retry');
    await Promise.all(
      skipped.map(async (i) => (out[i] = await this.putGcal(out[i]!, { gcalSyncError: note }))),
    );
    return out;
  }
  async setTaskEstimate(
    id: string,
    estimateMin: number | null,
    bufferMin: number | null,
  ): Promise<Task> {
    const prev = await this.mustTask(id);
    const next = await this.repo.putTask(withEstimate(prev, estimateMin, bufferMin, this.now()));
    return this.syncCalendar(prev, next);
  }
  async setTaskCategory(id: string, categoryId: string | null): Promise<Task> {
    const t = await this.mustTask(id);
    return this.repo.putTask({ ...t, categoryId, updatedAt: this.now() });
  }
  async setTaskDueDay(id: string, dueDay: string | null): Promise<Task> {
    return this.setTaskDue(id, { dueDay });
  }
  async setTaskDue(id: string, due: SetTaskDueInput): Promise<Task> {
    const prev = await this.mustTask(id);
    const fields = normalizeDue(due.dueDay, due.dueTime, prev.dueTime); // throws before any write
    const next = await this.repo.putTask({ ...prev, ...fields, updatedAt: this.now() });
    return this.syncCalendar(prev, next);
  }
  async setTaskTitle(id: string, title: string): Promise<Task> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('Title is required');
    const prev = await this.mustTask(id);
    const next = await this.repo.putTask({ ...prev, title: trimmed, updatedAt: this.now() });
    return this.syncCalendar(prev, next);
  }
  async setTaskNotes(id: string, notes: string | null): Promise<Task> {
    const normalized = setNotesArg(notes); // throws (missing, over the cap) before any read or write
    const t = await this.mustTask(id);
    return this.repo.putTask({ ...t, notes: normalized, updatedAt: this.now() });
  }
  async transitionTask(id: string, to: TaskStatus): Promise<Task> {
    const task = await this.mustTask(id);
    // A finished task has nothing left to sync, so a failure note (and its Retry) goes with it — unless
    // it's an owed removal, which the finish carries out (reporting, not swallowing, a failure).
    const finished = to === 'done' || to === 'cancelled';
    const owed = task.gcalEventId && isPendingRemoval(task.gcalSyncError);
    const next = await this.repo.putTask({
      ...taskTransition(task, to, this.now()),
      ...(finished && task.gcalSyncError && !owed ? { gcalSyncError: null } : {}),
    });
    if (finished && owed) return this.syncCalendar(task, next);
    // Delete-on-cancel: dropping a task removes its calendar event (via the owning account) and clears
    // the pointers. Guarded by gcalEventId, so tasks without an event are unaffected.
    if (to === 'cancelled' && task.gcalEventId) return this.deleteCalendarEvent(id);
    return next;
  }
  async setTaskActual(id: string, actualMin: number): Promise<Task> {
    const t = await this.mustTask(id);
    return this.repo.putTask({ ...t, actualAccruedMin: actualMin, updatedAt: this.now() });
  }
  async splitTask(id: string, input: SplitTaskInput): Promise<{ original: Task; followUp: Task }> {
    const task = await this.mustTask(id);
    const edited = splitOriginal(task, input, this.now()); // validates everything before any write
    const done = input.finish === 'done';
    // A TIMED task's event is the block before its deadline. A done part has no future there, so the link
    // moves to the follow-up (which re-titles/re-times it — no delete + re-create). Kept going, each part
    // owns its own block: the original keeps its event, and the follow-up gets one from the planner (it
    // gains a time). Any other linked event (a manual one, a record of work done) stays on the original.
    const moveLink = done && !!task.dueDay && !!task.dueTime && !!task.gcalEventId;
    let original: Task;
    if (done) {
      // A finish drops a failure note, but carries out an owed removal (reporting, like transitionTask).
      const owed = !moveLink && !!task.gcalEventId && isPendingRemoval(task.gcalSyncError);
      original = await this.repo.putTask({
        ...edited,
        ...(moveLink ? { gcalAccountId: null, gcalCalendarId: null, gcalEventId: null } : {}),
        gcalSyncError: owed ? task.gcalSyncError : null,
      });
      if (owed) original = await this.syncCalendar(task, original);
    } else {
      original = await this.syncCalendar(task, await this.repo.putTask(edited));
    }
    // The follow-up lands on the original's plan day (planned), else in the backlog. Task before row: a
    // planned task whose row never landed is what getDay's stale sweep moves back to backlog.
    const day =
      task.status === 'planned' || task.status === 'in_progress'
        ? followUpPlanDay(await this.repo.listAllPlans(), id)
        : null;
    const fields = splitFollowUp(task, input.followUp, day !== null);
    const created = await this.repo.putTask({
      ...this.base(),
      ...fields,
      ...(moveLink
        ? {
            gcalAccountId: task.gcalAccountId,
            gcalCalendarId: task.gcalCalendarId,
            gcalEventId: task.gcalEventId,
          }
        : {}),
    });
    if (day !== null)
      await this.repo.putPlan({
        ...this.base(),
        taskId: created.id,
        day,
        plannedMinutes: followUpPlanMinutes(fields.estimateMin, fields.bufferMin),
        order: (await this.repo.listPlans(day)).length,
      });
    return { original, followUp: await this.syncCalendar(null, created) };
  }
  async deleteTask(id: string): Promise<void> {
    const task = await this.repo.getTask(id);
    if (!task) return; // idempotent — already tombstoned or never existed
    // Calendar event FIRST (deleteCalendarEvent uses mustTask, so it must run before the tombstone).
    // Build the tombstone from the RETURNED task: it has the gcal pointers nulled, so we don't re-put
    // stale pointers onto the tombstone.
    const cleared = task.gcalEventId ? await this.deleteCalendarEvent(id) : task;
    const now = this.now();
    for (const p of (await this.repo.listAllPlans()).filter((p) => p.taskId === id))
      await this.repo.putPlan({ ...p, deletedAt: now, updatedAt: now }, p);
    for (const a of await this.repo.listAttachmentsForTask(id))
      await this.repo.putAttachment({ ...a, deletedAt: now, updatedAt: now });
    await this.repo.putTask({ ...cleared, deletedAt: now, updatedAt: now }); // task LAST
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

  // --- Rolls ---
  async listRolls(): Promise<Roll[]> {
    return (await this.repo.listRolls()).sort((a, b) => a.createdAt - b.createdAt);
  }
  async upsertRoll(input: UpsertRollInput): Promise<Roll> {
    const fields = {
      name: input.name,
      categoryId: input.categoryId,
      estimateMin: input.estimateMin,
      active: input.active ?? true,
    };
    if (input.id) {
      const existing = await this.repo.getRoll(input.id);
      if (!existing) throw new Error(`Not found: ${input.id}`);
      return this.repo.putRoll({ ...existing, ...fields, updatedAt: this.now() });
    }
    return this.repo.putRoll({ ...this.base(), ...fields });
  }
  // Reuse the open rep if one exists (re-planning a rolled-back backlog one), else spawn a fresh planned
  // rep; then ensure it sits on `day`'s plan, appended like addToDay. Mirrors the stub exactly.
  async pickRollToday(rollId: string, day: string): Promise<{ task: Task; plan: TaskPlan }> {
    const roll = await this.repo.getRoll(rollId);
    if (!roll) throw new Error(`Not found: ${rollId}`);
    const existing = findOpenRollTask(await this.repo.listTasks(), rollId);
    const task = existing
      ? existing.status === 'backlog'
        ? await this.repo.putTask(taskTransition(existing, 'planned', this.now()))
        : existing
      : await this.repo.putTask({ ...this.base(), ...rollRepFields(roll) });
    const dayPlans = await this.repo.listPlans(day);
    const existingPlan = dayPlans.find((p) => p.taskId === task.id);
    const plan =
      existingPlan ??
      (await this.repo.putPlan({
        ...this.base(),
        taskId: task.id,
        day,
        plannedMinutes: roll.estimateMin ?? ROLL_PLAN_FALLBACK_MIN,
        order: dayPlans.length,
      }));
    return { task, plan };
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

  // --- Day (lazy recurrence + stale sweep on read) ---
  async getDay(day: string): Promise<Day> {
    await this.materializeDueSeries(day);
    await this.sweepStalePlanned(day);
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
        dueDay: null,
        dueTime: null,
        notes: null,
        seriesId: series.id,
        rollId: null,
        estimateMin: series.defaultEstimateMin,
        bufferMin: null,
        estimateLockedMin: null,
        splitFromId: null,
        actualAccruedMin: 0,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        gcalAccountId: null,
        gcalCalendarId: null,
        gcalEventId: null,
        gcalSyncError: null,
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
  // Rule lives in the shared stalePlannedMoves (stub parity). Plans are read only when something is
  // planned. Each move re-reads the task first: a sweep races the user's own writes (e.g. starting the
  // task), and writing back the list-time copy would undo them.
  private async sweepStalePlanned(day: string): Promise<void> {
    const tasks = await this.repo.listTasks();
    if (!tasks.some((t) => t.status === 'planned')) return;
    for (const { task, to } of stalePlannedMoves(tasks, await this.repo.listAllPlans(), day)) {
      const fresh = await this.repo.getTask(task.id);
      if (fresh?.status !== 'planned') continue;
      // Gained a calendar event since the list read → backlog, never an orphaned event.
      await this.repo.putTask(
        taskTransition(fresh, fresh.gcalEventId ? 'backlog' : to, this.now()),
      );
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
        order: input.order ?? existing.order,
        active: input.active ?? existing.active,
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
    const rolls = (await this.repo.listRolls()).filter((r) => r.categoryId === id);
    assertCategoryDeletable(
      tasks.length + habits.length + series.length + rolls.length,
      reassignToId,
    );
    for (const t of tasks)
      await this.repo.putTask({ ...t, categoryId: reassignToId, updatedAt: this.now() });
    for (const h of habits)
      await this.repo.putHabit({ ...h, categoryId: reassignToId, updatedAt: this.now() });
    for (const s of series)
      await this.repo.putSeries({ ...s, categoryId: reassignToId, updatedAt: this.now() });
    for (const r of rolls)
      await this.repo.putRoll({ ...r, categoryId: reassignToId, updatedAt: this.now() });
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

  // --- Google Calendar (multi-account) ---
  // Every external effect (SSM token get/put, Google fetch) goes through the gated `this.google`, so a
  // testMode/smoke run makes zero real calls. Settings + task-pointer writes go through the repo Writes.

  async googleConnectUrl(): Promise<{ url: string }> {
    const state = signState(this.userId, this.stateSecret, this.now());
    return { url: await this.google.buildConsentUrl(state) };
  }

  // Called by the browser-driven callback route (NOT via RPC), after index.ts verified the state and
  // built this backend with the state's userId. Exchanges the code, stores the token, records the account.
  async completeGoogleConnect(code: string): Promise<void> {
    const { sub, email, refreshToken } = await this.google.exchangeCode(code);
    await this.google.storeRefreshToken(sub, refreshToken);
    const settings = await this.ensureSettings();
    const others = settings.googleAccounts.filter((a) => a.sub !== sub);
    // Default the account's primary calendar (id = email) into the shape set on connect, so a freshly
    // connected account contributes to the day shape without a manual picker step; set it as the write
    // default if none is set yet. Dedup so a reconnect doesn't double-add.
    const primaryRef = { accountSub: sub, calendarId: email };
    const hasRef = settings.calendarShapeRefs.some(
      (r) => r.accountSub === sub && r.calendarId === email,
    );
    await this.repo.putSettings({
      ...settings,
      googleAccounts: [...others, { sub, email }],
      calendarShapeRefs: hasRef
        ? settings.calendarShapeRefs
        : [...settings.calendarShapeRefs, primaryRef],
      calendarWriteDefault: settings.calendarWriteDefault ?? primaryRef,
      updatedAt: this.now(),
    });
  }

  async getGoogleStatus(): Promise<GoogleStatus> {
    const settings = await this.ensureSettings();
    const accounts = await Promise.all(
      settings.googleAccounts.map(async (a) => {
        // Per-account resilience (the Cognito model): a transient probe failure for one account must
        // not sink the whole status read — degrade that one to reconnect-required.
        const state = await this.google
          .getAccountState(a.sub)
          .catch(() => ({ connected: true, reconnectRequired: true }));
        return {
          sub: a.sub,
          email: a.email,
          connected: state.connected,
          reconnectRequired: state.reconnectRequired,
        };
      }),
    );
    return { accounts };
  }

  async listGoogleCalendars(): Promise<GoogleCalendar[]> {
    // Primary-only: each account's PRIMARY calendar, whose calendarId is the account email. We do NOT
    // call calendarList.list — the `calendar.events` scope does not grant it (403 "insufficient scopes";
    // listing all calendars would need calendar.readonly / calendar.calendarlist.readonly). events.list
    // and events.insert both work on the primary with the scope we have. If a non-primary picker is ever
    // wanted, add that scope and restore the gateway's listCalendars (still on the interface).
    const settings = await this.ensureSettings();
    return settings.googleAccounts.map((a) => ({
      accountSub: a.sub,
      calendarId: a.email,
      summary: a.email,
      primary: true,
    }));
  }

  async getCalendarBusy(input: GetCalendarBusyInput): Promise<CalendarBusy> {
    const settings = await this.ensureSettings();
    const intervals: BusyInterval[] = [];
    let allDayCount = 0;
    // One account's dead token must not sink the whole read (the Cognito resilience model): swallow a
    // per-account failure; the reconnect prompt surfaces via getGoogleStatus.
    await Promise.all(
      settings.calendarShapeRefs.map(async (ref) => {
        try {
          const res = await this.google.listBusy(
            ref.accountSub,
            ref.calendarId,
            input.windowStartMs,
            input.windowEndMs,
          );
          intervals.push(...res.intervals);
          allDayCount += res.allDayCount;
        } catch {
          /* per-account failure is recoverable; see getGoogleStatus */
        }
      }),
    );
    return { intervals, allDayCount };
  }

  async insertCalendarEvent(input: InsertCalendarEventInput): Promise<Task> {
    const task = await this.mustTask(input.taskId);
    // One live event per task — a second insert would orphan the first (edit-sync is a later PR).
    if (task.gcalEventId) throw new Error('Task already has a calendar event');
    // Two-system write: the event is created before its pointer is stored. If putTask below fails, a
    // real event is left with no stored id (a retry double-books). Accepted for this PR — reconciliation
    // lands with edit-sync; see docs/areas/calendar/index.md.
    const { eventId } = await this.google.insertEvent({
      sub: input.accountSub,
      calendarId: input.calendarId,
      title: input.title,
      startMs: input.startMs,
      endMs: input.endMs,
    });
    return this.repo.putTask({
      ...task,
      gcalAccountId: input.accountSub,
      gcalCalendarId: input.calendarId,
      gcalEventId: eventId,
      updatedAt: this.now(),
    });
  }

  async deleteCalendarEvent(taskId: string): Promise<Task> {
    const task = await this.mustTask(taskId);
    // Blast-radius safety: only ever delete an event whose id WE stored, on its owning account+calendar.
    if (task.gcalEventId && task.gcalAccountId && task.gcalCalendarId) {
      await this.google
        .deleteEvent({
          sub: task.gcalAccountId,
          calendarId: task.gcalCalendarId,
          eventId: task.gcalEventId,
        })
        .catch(() => {}); // an already-gone event shouldn't block clearing the pointer
    }
    return this.repo.putTask({
      ...task,
      gcalAccountId: null,
      gcalCalendarId: null,
      gcalEventId: null,
      gcalSyncError: null,
      updatedAt: this.now(),
    });
  }

  async syncCalendarEvent(taskId: string): Promise<Task> {
    return this.syncCalendar(null, await this.mustTask(taskId), true);
  }

  async disconnectGoogleAccount(accountSub: string): Promise<void> {
    await this.google.removeAccount(accountSub);
    const settings = await this.ensureSettings();
    await this.repo.putSettings({
      ...settings,
      googleAccounts: settings.googleAccounts.filter((a) => a.sub !== accountSub),
      calendarShapeRefs: settings.calendarShapeRefs.filter((r) => r.accountSub !== accountSub),
      calendarWriteDefault:
        settings.calendarWriteDefault?.accountSub === accountSub
          ? null
          : settings.calendarWriteDefault,
      updatedAt: this.now(),
    });
  }

  // --- Calibration ---
  // Parity with the stub: done+locked tasks outside a split family (split.ts), by completion DAY
  // (dayStartHour offset).
  // TODO(scale): swap the full task scan for `repo.doneTasksInWindow` over the GSI once the
  // day-range → epoch-window mapping (with the offset) is nailed down.
  async getCalibration(range: DateRange): Promise<CalibrationPoint[]> {
    const start = (await this.ensureSettings()).dayStartHour;
    return calibrationTasks(await this.repo.listTasks())
      .filter((t) => t.completedAt !== null)
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

  async exportData(): Promise<ExportBundle> {
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
      rolls: await this.repo.listRolls(),
      sessions: await this.repo.listAllSessions(),
      days: await this.repo.listAllDays(),
      categories: await this.repo.listCategories(),
      leetcodeAttempts: await this.repo.listLeetcodeAttempts(),
      stories: await this.repo.listStories(),
      attachments: (await this.repo.listAllAttachments()).filter((a) => a.status === 'ready'),
      ...(await this.finance.exportCollections()),
      settings: await this.ensureSettings(),
    };
  }

  // --- Finances (finance/service.ts) ---
  getFinanceOverview(input: { today: string }): Promise<FinanceOverview> {
    return this.finance.getFinanceOverview(input);
  }
  listFinanceTransactions(range: DateRange): Promise<FinanceTransaction[]> {
    return this.finance.listFinanceTransactions(range);
  }
  setFinanceBucket(input: SetFinanceBucketInput): Promise<FinanceTransaction[]> {
    return this.finance.setFinanceBucket(input);
  }
  setFinancePeriodOverride(
    id: string,
    override: FinancePeriodOverride | null,
  ): Promise<FinanceTransaction> {
    return this.finance.setFinancePeriodOverride(id, override);
  }
  setFinanceNote(id: string, note: string | null): Promise<FinanceTransaction> {
    return this.finance.setFinanceNote(id, note);
  }
  setFinancePeriodStart(id: string, marked: boolean): Promise<FinanceTransaction> {
    return this.finance.setFinancePeriodStart(id, marked);
  }
  linkFinanceRefund(refundId: string, chargeId: string | null): Promise<FinanceTransaction> {
    return this.finance.linkFinanceRefund(refundId, chargeId);
  }
  listFinanceRules(): Promise<FinanceRule[]> {
    return this.finance.listFinanceRules();
  }
  upsertFinanceRule(input: UpsertFinanceRuleInput): Promise<FinanceRule> {
    return this.finance.upsertFinanceRule(input);
  }
  deleteFinanceRule(id: string): Promise<void> {
    return this.finance.deleteFinanceRule(id);
  }
  updateFinanceAccount(id: string, patch: FinanceAccountPatch): Promise<FinanceAccount> {
    return this.finance.updateFinanceAccount(id, patch);
  }
  createPlaidLinkToken(input: CreateLinkTokenInput): Promise<LinkTokenResult> {
    return this.finance.createPlaidLinkToken(input);
  }
  exchangePlaidPublicToken(input: ExchangePublicTokenInput): Promise<FinanceItem> {
    return this.finance.exchangePlaidPublicToken(input);
  }
  completePlaidUpdate(itemId: string): Promise<FinanceItem> {
    return this.finance.completePlaidUpdate(itemId);
  }
  removePlaidItem(itemId: string): Promise<void> {
    return this.finance.removePlaidItem(itemId);
  }
  requestFinanceSync(input: { refresh: boolean }): Promise<RequestFinanceSyncResult> {
    return this.finance.requestFinanceSync(input);
  }
}
