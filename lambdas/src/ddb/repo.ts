import type {
  Attachment,
  BaseEntity,
  Category,
  FinanceAccount,
  FinanceItem,
  FinanceRule,
  FinanceSyncState,
  FinanceTransaction,
  CoachAttempt,
  CoachDay,
  CoachFocus,
  FluxSet,
  Day,
  Habit,
  HabitCheck,
  Idea,
  LeetcodeProblem,
  Sitting,
  SittingBudget,
  SittingEvent,
  SittingHeadRow,
  SittingLive,
  LcStartGate,
  SittingReplayChunk,
  LogEntry,
  Place,
  PomodoroSession,
  PushSub,
  Roll,
  GcalSyncState,
  Settings,
  Story,
  Task,
  TaskPlan,
  TaskSeries,
  FluxWeekNoteRow,
} from '@aperture/shared';
import { headRowOf, isHeadEvent } from '@aperture/shared';
import { ConditionFailedError, SK_END } from './DocClient';
import type { DocClient, Item, QueryOpts } from './DocClient';
import type { Writes } from './writes';
import { pointerOf } from './placeTokens';
import type { PlaceTokenPointer } from './placeTokens';
import { gsi1, pk, sk } from './keys';
import {
  entityItem,
  financeTxnItem,
  planItem,
  planRemindAt,
  REMIND_ARMED_AT,
  remindArm,
  taskItem,
  taskRemindAt,
  toEntity,
  toFinanceSyncState,
  toFinanceTxn,
} from './mapping';
import { mapLimit } from '../util/mapLimit';

type Deletable = { deletedAt: number | null };
const alive = <T extends Deletable>(rows: T[]): T[] => rows.filter((r) => r.deletedAt === null);

// A conditional write kept losing — another writer is hammering the row. Surfaces to the caller.
export class ConflictError extends Error {
  readonly code = 'CONFLICT';
  constructor() {
    super('Conflict — try again');
    this.name = 'ConflictError';
  }
}
export const CAS_ATTEMPTS = 4;
const FIN_CONCURRENCY = 25;

// A row on the remind index (gsi1.remindPk), told apart by its SK: an open task at its deadline, a plan
// at its day's reminder time, or a Send-test candidate. `fireAt` is the index's SK as written — the
// poller re-reads the task and drops a row whose fire time has since moved.
export type RemindRow =
  | { kind: 'task'; fireAt: number; task: Task }
  | { kind: 'plan'; fireAt: number; sk: string; plan: TaskPlan }
  | { kind: 'test'; fireAt: number; id: string };

// What a candidate must have been armed by (reminders.md → §3): its own row's remindArmedAt — when its
// current fire time was set — and, for each kind, when that toggle was last switched back on.
export interface PushArmRow {
  remindTimed?: number;
  remindDueDay?: number;
  remindPlanned?: number;
  updatedAt: number;
}

// A Send-test candidate (sendTestPush): sent by the poller's next tick, then deleted.
export interface PushTestRow {
  id: string;
  createdAt: number;
}
// One reminder sent (or, fail-closed, about to be): the dedup row, written before the send.
export interface PushSentRow {
  fireAt: number;
  key: string; // the task id, or `test-<id>`
  sentAt: number;
}
// The hidden daily guard's counter for one LA day; `updatedAt` is its conditional-write cursor.
export interface PushCountRow {
  day: string;
  count: number;
  updatedAt: number;
}
// This user's last send and last error, as Settings' health line shows them.
export interface PushUserHealth {
  lastSentAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  updatedAt: number;
}

// One casUpdate target: how to read the row and how to write it back.
interface CasShape<T> {
  sk: string;
  read: (item: Item) => T;
  toItem: (t: T) => Item;
}

// The persistence facade the routes sit on: reads go straight to the DocClient, every write goes
// through `writes` (the single audit point). Entities keyed as `type#<id>` get a direct read; the few
// that bucket day/order into the SK (log, plan, session) fall back to a prefix scan to resolve an id.
//
// Running sessions are a direct read under `sess#running#` (the heartbeat's hot path); day-bucketed
// session history is a prefix scan.
export class Repo {
  constructor(
    private readonly doc: DocClient,
    private readonly writes: Writes,
    private readonly userId: string,
  ) {}

  private p(): string {
    return pk(this.userId);
  }
  private async scanById(
    prefix: string,
    id: string,
    opts?: { consistent?: boolean },
  ): Promise<Item | null> {
    const rows = await this.doc.query(this.p(), prefix, opts);
    return rows.find((r) => r.id === id) ?? null;
  }

  // --- Log ---
  async listLog(day: string, opts?: { consistent?: boolean }): Promise<LogEntry[]> {
    return alive(
      (await this.doc.query(this.p(), sk.logPrefix(day), opts)).map((i) => toEntity<LogEntry>(i)),
    );
  }
  async listAllLog(): Promise<LogEntry[]> {
    return alive(
      (await this.doc.query(this.p(), sk.logAllPrefix())).map((i) => toEntity<LogEntry>(i)),
    );
  }
  // One range read (the SK sorts by day): `log#<from>#` … the end of `log#<to>#`; an open bound reads to
  // that end of the log. The MCP search and list tools' input — a personal log, never a scan.
  async listLogRange(
    from?: string,
    to?: string,
    opts?: { consistent?: boolean },
  ): Promise<LogEntry[]> {
    const rows = await this.doc.query(this.p(), sk.logAllPrefix(), {
      ...opts,
      from: from === undefined ? undefined : sk.logPrefix(from),
      to: to === undefined ? undefined : sk.logPrefix(to) + SK_END,
    });
    return alive(rows.map((i) => toEntity<LogEntry>(i)));
  }
  async findLog(id: string, opts?: { consistent?: boolean }): Promise<LogEntry | null> {
    const it = await this.scanById(sk.logAllPrefix(), id, opts);
    return it ? toEntity<LogEntry>(it) : null;
  }
  async putLog(e: LogEntry): Promise<LogEntry> {
    await this.writes.put(entityItem(this.userId, sk.log(e.day, e.id), e));
    return e;
  }

  // --- LeetCode sittings (keys.ts → sitting*) ---
  // Heads, tombstones filtered. A scan of `lcsit#`: a few dozen a month, read at Start and on the page.
  async listSittings(opts?: { consistent?: boolean }): Promise<Sitting[]> {
    return alive(
      (await this.doc.query(this.p(), sk.sittingPrefix(), opts)).map((i) => toEntity<Sitting>(i)),
    );
  }
  async getSitting(id: string, opts?: { consistent?: boolean }): Promise<Sitting | null> {
    const it = await this.doc.get(this.p(), sk.sitting(id), opts);
    const s = it ? toEntity<Sitting>(it) : null;
    return s && s.deletedAt === null ? s : null;
  }
  // Write only if absent: the head's key is the Start's idempotency key, so a concurrent repeat loses.
  async putSittingIfAbsent(s: Sitting): Promise<boolean> {
    try {
      await this.writes.putIf(entityItem(this.userId, sk.sitting(s.id), s), null);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  sittingShape(id: string): CasShape<Sitting> {
    return {
      sk: sk.sitting(id),
      read: (i) => toEntity<Sitting>(i),
      toItem: (s) => entityItem(this.userId, sk.sitting(id), s),
    };
  }
  async getSittingLive(id: string, opts?: { consistent?: boolean }): Promise<SittingLive | null> {
    const it = await this.doc.get(this.p(), sk.sittingLive(id), opts);
    const l = it ? toEntity<SittingLive>(it) : null;
    return l && l.deletedAt === null ? l : null;
  }
  sittingLiveShape(id: string): CasShape<SittingLive> {
    return {
      sk: sk.sittingLive(id),
      read: (i) => toEntity<SittingLive>(i),
      toItem: (l) => entityItem(this.userId, sk.sittingLive(id), l),
    };
  }
  sittingBudgetShape(id: string): CasShape<SittingBudget> {
    return {
      sk: sk.sittingBudget(id),
      read: (i) => toEntity<SittingBudget>(i),
      toItem: (x) => entityItem(this.userId, sk.sittingBudget(id), x),
    };
  }
  // An event or replay chunk, written only if absent (idempotent per id). A head event is two rows: its compact
  // head row under `hd#` (what the summary reads) and its full payload under `jd#`; a timer read is only its row.
  // `expiresAt` (epoch s) marks the raw bulk for DynamoDB's TTL — the one row kind stamped on prod.
  async putSittingEventIfAbsent(e: SittingEvent, expiresAt: number | null): Promise<boolean> {
    if (!isHeadEvent(e.type))
      return this.putChildIfAbsent(sk.sittingEvent(e.sittingId, e.id), e, expiresAt);
    const row = headRowOf(e.sittingId, e as Parameters<typeof headRowOf>[1]);
    const fresh = await this.putChildIfAbsent(
      sk.sittingHeadRow(e.sittingId, e.id),
      { ...row, userId: e.userId, createdAt: e.createdAt, updatedAt: e.updatedAt },
      null,
    );
    if (e.type !== 'timer')
      await this.putChildIfAbsent(sk.sittingJudged(e.sittingId, e.id), e, null);
    return fresh;
  }
  async putSittingReplayIfAbsent(c: SittingReplayChunk, expiresAt: number): Promise<boolean> {
    return this.putChildIfAbsent(sk.sittingReplay(c.sittingId, c.id), c, expiresAt);
  }
  private async putChildIfAbsent(
    skStr: string,
    row: object,
    expiresAt: number | null,
  ): Promise<boolean> {
    const item = entityItem(this.userId, skStr, row);
    try {
      await this.writes.putIf(expiresAt === null ? item : { ...item, expiresAt }, null);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  // A sitting's head rows (what its summary is recomputed from), strongly consistent: the call that just wrote
  // one must see it. Compact, so the recompute stays cheap however large the payloads.
  async listSittingHeadRows(id: string): Promise<SittingHeadRow[]> {
    return alive(
      (await this.doc.query(this.p(), sk.sittingHeadRowPrefix(id), { consistent: true })).map((i) =>
        toEntity<SittingHeadRow>(i),
      ),
    );
  }
  // Every stored event of a sitting with its payload — runs, submits, notes, and the raw bulk — for its detail read.
  async listSittingEvents(id: string): Promise<SittingEvent[]> {
    const [judged, bulk] = await Promise.all([
      this.doc.query(this.p(), sk.sittingJudgedPrefix(id), { consistent: true }),
      this.doc.query(this.p(), sk.sittingEventPrefix(id), { consistent: true }),
    ]);
    return alive([...judged, ...bulk].map((i) => toEntity<SittingEvent>(i)));
  }
  // One judged event's full payload by id (strongly consistent): the live pull's newest Run and Submit.
  async getSittingJudged(id: string, eventId: string): Promise<SittingEvent | null> {
    const it = await this.doc.get(this.p(), sk.sittingJudged(id, eventId), { consistent: true });
    const e = it ? toEntity<SittingEvent>(it) : null;
    return e && e.deletedAt === null ? e : null;
  }
  // Claude's live pulls of a sitting (keys.ts → sittingReads): an atomic add, so a pull never contends with
  // ingest's head writes. Returns the count after this pull; under noopWrites, the stored count.
  async bumpSittingReads(id: string, now: number): Promise<number> {
    const n = await this.writes.add(
      this.p(),
      sk.sittingReads(id),
      'count',
      1,
      { id, sittingId: id, userId: this.userId, createdAt: now, deletedAt: null },
      { updatedAt: now },
    );
    // A pull racing deleteSitting can land its add after the sweep and leave a live count row whose sitting is
    // gone. Nothing reads it (getSitting needs the head); a few hundred bytes, not worth a transaction.
    return n ?? (await this.getSittingReads(id));
  }
  async getSittingReads(id: string, opts?: { consistent?: boolean }): Promise<number> {
    const it = await this.doc.get(this.p(), sk.sittingReads(id), opts);
    return it && it.deletedAt === null && typeof it.count === 'number' ? it.count : 0;
  }
  async listSittingReplay(id: string): Promise<SittingReplayChunk[]> {
    return alive(
      (await this.doc.query(this.p(), sk.sittingReplayPrefix(id))).map((i) =>
        toEntity<SittingReplayChunk>(i),
      ),
    );
  }
  // What the export carries of every sitting: live rows and head rows (verdicts, timer reads). The payloads,
  // the raw bulk and the replay stay out (bulk; the export is one Lambda response).
  async listAllSittingChildren(): Promise<{ live: SittingLive[]; heads: SittingHeadRow[] }> {
    const rows = await this.doc.query(this.p(), sk.sittingChildAllPrefix());
    const of = <T extends { deletedAt: number | null }>(pred: (skStr: string) => boolean) =>
      alive(rows.filter((r) => pred(r.SK)).map((r) => toEntity<T>(r)));
    return {
      live: of<SittingLive>((x) => x.endsWith('#live')),
      heads: of<SittingHeadRow>((x) => x.includes('#hd#')),
    };
  }
  // Tombstones a sitting and every child row in one batch (deleteSitting; deleteTask's cascade). A tombstone
  // keeps only what a reader needs to skip it — not a payload rewritten just to stamp deletedAt — and keeps a
  // raw row's expiresAt, so it still expires.
  async tombstoneSitting(id: string, now: number): Promise<void> {
    const rows = [
      ...(await this.doc.query(this.p(), sk.sittingChildPrefix(id), { consistent: true })),
      ...[await this.doc.get(this.p(), sk.sitting(id), { consistent: true })].filter(
        (r): r is Item => !!r,
      ),
    ].filter((r) => r.deletedAt === null);
    await this.writes.batchPut(
      rows.map((r) => ({
        PK: r.PK,
        SK: r.SK,
        id: r.id,
        sittingId: r.sittingId ?? id,
        deletedAt: now,
        updatedAt: Math.max(now, (typeof r.updatedAt === 'number' ? r.updatedAt : 0) + 1),
        ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
      })),
    );
  }
  async tombstoneLeetcodeProblem(slug: string, now: number): Promise<void> {
    const p = await this.getLeetcodeProblem(slug);
    if (p)
      await this.writes.put({
        PK: this.p(),
        SK: sk.lcProblem(slug),
        id: p.id,
        slug,
        deletedAt: now,
        updatedAt: Math.max(now, p.updatedAt + 1),
      });
  }
  // The rep a sitting spawns, written only if absent: two racing Starts for one sitting make one rep.
  async putTaskIfAbsent(t: Task): Promise<boolean> {
    try {
      await this.writes.putIf(await this.taskItemArmed(t), null);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  // The Start gate, read only: which sitting is open, for the live pull.
  async getLcStart(opts?: { consistent?: boolean }): Promise<LcStartGate | null> {
    const it = await this.doc.get(this.p(), sk.lcStart(), opts);
    return it ? toEntity<LcStartGate>(it) : null;
  }
  lcStartShape(): CasShape<LcStartGate> {
    return {
      sk: sk.lcStart(),
      read: (i) => toEntity<LcStartGate>(i),
      toItem: (g) => entityItem(this.userId, sk.lcStart(), g),
    };
  }

  async getLeetcodeProblem(slug: string): Promise<LeetcodeProblem | null> {
    const it = await this.doc.get(this.p(), sk.lcProblem(slug));
    const p = it ? toEntity<LeetcodeProblem>(it) : null;
    return p && p.deletedAt === null ? p : null;
  }
  async putLeetcodeProblem(p: LeetcodeProblem): Promise<LeetcodeProblem> {
    await this.writes.put(entityItem(this.userId, sk.lcProblem(p.slug), p));
    return p;
  }
  async listLeetcodeProblems(): Promise<LeetcodeProblem[]> {
    return alive(
      (await this.doc.query(this.p(), sk.lcProblemPrefix())).map((i) =>
        toEntity<LeetcodeProblem>(i),
      ),
    );
  }

  // --- The LeetCode coach (keys.ts → coach*) ---
  async listCoachDays(opts?: { consistent?: boolean }): Promise<CoachDay[]> {
    return alive(
      (await this.doc.query(this.p(), sk.coachDayPrefix(), opts)).map((i) => toEntity<CoachDay>(i)),
    );
  }
  coachDayShape(day: string): CasShape<CoachDay> {
    return {
      sk: sk.coachDay(day),
      read: (i) => toEntity<CoachDay>(i),
      toItem: (d) => entityItem(this.userId, sk.coachDay(day), d),
    };
  }
  async listCoachAttempts(opts?: { consistent?: boolean }): Promise<CoachAttempt[]> {
    return alive(
      (await this.doc.query(this.p(), sk.coachAttemptPrefix(), opts)).map((i) =>
        toEntity<CoachAttempt>(i),
      ),
    );
  }
  async getCoachAttempt(id: string, opts?: { consistent?: boolean }): Promise<CoachAttempt | null> {
    const it = await this.doc.get(this.p(), sk.coachAttempt(id), opts);
    const a = it ? toEntity<CoachAttempt>(it) : null;
    return a && a.deletedAt === null ? a : null;
  }
  coachAttemptShape(id: string): CasShape<CoachAttempt> {
    return {
      sk: sk.coachAttempt(id),
      read: (i) => toEntity<CoachAttempt>(i),
      toItem: (a) => entityItem(this.userId, sk.coachAttempt(id), a),
    };
  }
  coachFocusShape(): CasShape<CoachFocus> {
    return {
      sk: sk.coachFocus(),
      read: (i) => toEntity<CoachFocus>(i),
      toItem: (f) => entityItem(this.userId, sk.coachFocus(), f),
    };
  }
  async putCoachAttempt(a: CoachAttempt): Promise<CoachAttempt> {
    await this.writes.put(entityItem(this.userId, sk.coachAttempt(a.id), a));
    return a;
  }
  async getCoachFocus(opts?: { consistent?: boolean }): Promise<CoachFocus | null> {
    const it = await this.doc.get(this.p(), sk.coachFocus(), opts);
    const f = it ? toEntity<CoachFocus>(it) : null;
    return f && f.deletedAt === null ? f : null;
  }
  async putCoachFocus(f: CoachFocus): Promise<CoachFocus> {
    await this.writes.put(entityItem(this.userId, sk.coachFocus(), f));
    return f;
  }

  // --- Flux sets ---
  // Tombstones included: the backend filters (inRange), and an outbox retry of a deleted set must find it.
  async listAllFluxSets(opts?: { consistent?: boolean }): Promise<FluxSet[]> {
    return (await this.doc.query(this.p(), sk.fluxAllPrefix(), opts)).map((i) =>
      toEntity<FluxSet>(i),
    );
  }
  async findFluxSet(id: string, opts?: { consistent?: boolean }): Promise<FluxSet | null> {
    return (await this.listAllFluxSets(opts)).find((f) => f.id === id) ?? null;
  }
  // Write only if absent (D47): a concurrent retry of the same set loses the race instead of overwriting.
  async putFluxSetIfAbsent(f: FluxSet): Promise<boolean> {
    try {
      await this.writes.putIf(entityItem(this.userId, sk.flux(f.day, f.id), f), null);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  async putFluxSet(f: FluxSet): Promise<FluxSet> {
    await this.writes.put(entityItem(this.userId, sk.flux(f.day, f.id), f));
    return f;
  }

  // --- Flux weekly note (D62) ---
  // Consistent: the decision to re-ask the model is taken straight after the previous request's put.
  async getFluxWeekNote(weekStart: string): Promise<FluxWeekNoteRow | null> {
    const it = await this.doc.get(this.p(), sk.fluxNote(weekStart), { consistent: true });
    return it ? toEntity<FluxWeekNoteRow>(it) : null;
  }
  async putFluxWeekNote(n: FluxWeekNoteRow): Promise<FluxWeekNoteRow> {
    await this.writes.put(entityItem(this.userId, sk.fluxNote(n.weekStart), n));
    return n;
  }

  // --- Tasks ---
  // `consistent` for a decision taken straight after a task write (parts: freeze, release, adopt).
  async listTasks(opts?: { consistent?: boolean }): Promise<Task[]> {
    return alive(
      (await this.doc.query(this.p(), sk.taskPrefix(), opts)).map((i) => toEntity<Task>(i)),
    );
  }
  async getTask(id: string, opts?: { consistent?: boolean }): Promise<Task | null> {
    const it = await this.doc.get(this.p(), sk.task(id), opts);
    const t = it ? toEntity<Task>(it) : null;
    return t && t.deletedAt === null ? t : null;
  }
  // A write that puts a reminder on the index keeps the stored row's arm time when the fire time didn't
  // move, else arms it now (remindArm) — one consistent read, only for a task that can fire.
  private async armFor(
    skStr: string,
    fire: number | null,
    now: number,
  ): Promise<number | undefined> {
    if (fire === null) return undefined;
    return remindArm(
      await this.doc.get(this.p(), skStr, { consistent: true }),
      this.userId,
      fire,
      now,
    );
  }
  private async taskItemArmed(t: Task): Promise<Item> {
    return taskItem(this.userId, t, await this.armFor(sk.task(t.id), taskRemindAt(t), t.updatedAt));
  }
  async putTask(t: Task): Promise<Task> {
    await this.writes.put(await this.taskItemArmed(t));
    return t;
  }
  async putTasks(tasks: Task[]): Promise<Task[]> {
    await this.writes.batchPut(await mapLimit(tasks, 8, (t) => this.taskItemArmed(t)));
    return tasks;
  }
  // A task as the poller re-reads it, strongly, with its arm time (rows from before the stamp: updatedAt).
  async getTaskForRemind(id: string): Promise<{ task: Task; armedAt: number } | null> {
    const it = await this.doc.get(this.p(), sk.task(id), { consistent: true });
    const task = it ? toEntity<Task>(it) : null;
    if (!it || !task || task.deletedAt !== null) return null;
    const armed = it[REMIND_ARMED_AT];
    return { task, armedAt: typeof armed === 'number' ? armed : task.updatedAt };
  }
  async doneTasksInWindow(fromMs: number, toMs: number): Promise<Task[]> {
    const rows = await this.doc.queryIndex(gsi1.donePk(this.userId), { from: fromMs, to: toMs });
    return alive(rows.map((i) => toEntity<Task>(i)));
  }

  // --- Plans ---
  // A plan's order and day live in its key, so a move is two writes and a read can catch both copies, or
  // one a failed delete left behind. Every plan read goes through here: one row per id, the newest, chosen
  // before the alive filter so a tombstone beats an older copy.
  private async planRows(prefix: string, opts?: QueryOpts): Promise<TaskPlan[]> {
    const newest = new Map<string, TaskPlan>();
    for (const item of await this.doc.query(this.p(), prefix, opts)) {
      const row = toEntity<TaskPlan>(item);
      const seen = newest.get(row.id);
      if (!seen || row.updatedAt > seen.updatedAt) newest.set(row.id, row);
    }
    return [...newest.values()];
  }
  // `consistent` for upsertPlan's dedupe: "+ Today" twice in one second must see the first row.
  async listPlans(day: string, opts?: { consistent?: boolean }): Promise<TaskPlan[]> {
    return alive(await this.planRows(sk.planPrefix(day), opts));
  }
  async listAllPlans(opts?: { consistent?: boolean }): Promise<TaskPlan[]> {
    return alive(await this.planRows(sk.planAllPrefix(), opts));
  }
  // Alive rows dated `day` or later, one range read (the SK sorts by day): the stale sweep's input —
  // rows before `day` never decide a move, and plan history only grows.
  async listPlansFrom(day: string, opts?: { consistent?: boolean }): Promise<TaskPlan[]> {
    return alive(await this.planRows(sk.planAllPrefix(), { ...opts, from: sk.planPrefix(day) }));
  }
  // `consistent` for a read whose copy is written back (upsertPlan, removePlan) — a second reorder must
  // not resurrect the row the first one just moved.
  async findPlan(id: string, opts?: { consistent?: boolean }): Promise<TaskPlan | null> {
    return (await this.planRows(sk.planAllPrefix(), opts)).find((r) => r.id === id) ?? null;
  }
  // A moved plan lands at a new key. The new key goes first, so no read misses the row and a failed write
  // never loses it. An update's `updatedAt` is always past the copy it replaces (on the same clock tick too),
  // so the reads above tell any two copies apart.
  async putPlan(p: TaskPlan, previous?: TaskPlan): Promise<TaskPlan> {
    const row = previous ? { ...p, updatedAt: Math.max(p.updatedAt, previous.updatedAt + 1) } : p;
    const nextSk = sk.plan(row.day, row.order, row.id);
    // The arm time comes from the row as it was (a reorder within the day keeps it; a new day re-arms).
    const fromSk = previous ? sk.plan(previous.day, previous.order, previous.id) : nextSk;
    const armed = await this.armFor(fromSk, planRemindAt(row), row.updatedAt);
    await this.writes.put(planItem(this.userId, row, armed));
    if (previous) {
      const prevSk = sk.plan(previous.day, previous.order, previous.id);
      if (prevSk !== nextSk) await this.writes.delete(this.p(), prevSk);
    }
    return row;
  }
  // A plan row by its SK (a remind-index hit carries it), strongly consistent: a plan moved or deleted a
  // moment ago must not ping. With its arm time, like getTaskForRemind.
  async getPlanForRemind(skStr: string): Promise<{ plan: TaskPlan; armedAt: number } | null> {
    const it = await this.doc.get(this.p(), skStr, { consistent: true });
    const plan = it ? toEntity<TaskPlan>(it) : null;
    if (!it || !plan || plan.deletedAt !== null) return null;
    const armed = it[REMIND_ARMED_AT];
    return { plan, armedAt: typeof armed === 'number' ? armed : plan.updatedAt };
  }

  // --- Series ---
  async listSeries(): Promise<TaskSeries[]> {
    return alive(
      (await this.doc.query(this.p(), sk.seriesPrefix())).map((i) => toEntity<TaskSeries>(i)),
    );
  }
  async getSeries(id: string, opts?: { consistent?: boolean }): Promise<TaskSeries | null> {
    const it = await this.doc.get(this.p(), sk.series(id), opts);
    const s = it ? toEntity<TaskSeries>(it) : null;
    return s && s.deletedAt === null ? s : null; // a deleteSeries tombstone reads as gone, like a task
  }
  async putSeries(s: TaskSeries): Promise<TaskSeries> {
    await this.writes.put(entityItem(this.userId, sk.series(s.id), s));
    return s;
  }

  // --- Stories ---
  async listStories(): Promise<Story[]> {
    return alive((await this.doc.query(this.p(), sk.storyPrefix())).map((i) => toEntity<Story>(i)));
  }
  // getTask-style (re-filter tombstones → null), so updateStory on a deleted row throws — parity with
  // the stub's `patch`, which refuses a tombstoned id.
  async getStory(id: string, opts?: { consistent?: boolean }): Promise<Story | null> {
    const it = await this.doc.get(this.p(), sk.story(id), opts);
    const s = it ? toEntity<Story>(it) : null;
    return s && s.deletedAt === null ? s : null;
  }
  async putStory(s: Story): Promise<Story> {
    await this.writes.put(entityItem(this.userId, sk.story(s.id), s));
    return s;
  }

  // --- Rolls ---
  async listRolls(): Promise<Roll[]> {
    return alive((await this.doc.query(this.p(), sk.rollPrefix())).map((i) => toEntity<Roll>(i)));
  }
  // getStory-style (re-filter tombstones → null) so upsert on a deleted roll throws — stub parity.
  async getRoll(id: string, opts?: { consistent?: boolean }): Promise<Roll | null> {
    const it = await this.doc.get(this.p(), sk.roll(id), opts);
    const r = it ? toEntity<Roll>(it) : null;
    return r && r.deletedAt === null ? r : null;
  }
  async putRoll(r: Roll): Promise<Roll> {
    await this.writes.put(entityItem(this.userId, sk.roll(r.id), r));
    return r;
  }

  // --- Task attachments (metadata; bytes live in S3) ---
  async listAttachmentsForTask(
    taskId: string,
    opts?: { consistent?: boolean },
  ): Promise<Attachment[]> {
    return alive(
      (await this.doc.query(this.p(), sk.attachTaskPrefix(taskId), opts)).map((i) =>
        toEntity<Attachment>(i),
      ),
    );
  }
  async listAllAttachments(): Promise<Attachment[]> {
    return alive(
      (await this.doc.query(this.p(), sk.attachAllPrefix())).map((i) => toEntity<Attachment>(i)),
    );
  }
  // getStory-style (re-filter tombstones → null) so confirm/download on a deleted attachment throws.
  async findAttachment(id: string, opts?: { consistent?: boolean }): Promise<Attachment | null> {
    const it = await this.scanById(sk.attachAllPrefix(), id, opts);
    const a = it ? toEntity<Attachment>(it) : null;
    return a && a.deletedAt === null ? a : null;
  }
  async putAttachment(a: Attachment): Promise<Attachment> {
    await this.writes.put(entityItem(this.userId, sk.attach(a.taskId, a.id), a));
    return a;
  }

  // --- Sessions ---
  // Running timers: `sess#running#<id>` (direct GetItem for the heartbeat, small prefix for the running
  // set). On stop/discard a session moves to its day bucket `sess#<day>#<id>` for history. `sess#`
  // begins-with spans both, for the all-sessions reads (export, category backfill).
  async listAllSessions(): Promise<PomodoroSession[]> {
    return alive(
      (await this.doc.query(this.p(), sk.sessionPrefix())).map((i) => toEntity<PomodoroSession>(i)),
    );
  }
  async listRunningSessions(): Promise<PomodoroSession[]> {
    return alive(
      (await this.doc.query(this.p(), sk.sessionRunningPrefix())).map((i) =>
        toEntity<PomodoroSession>(i),
      ),
    );
  }
  async getRunningSession(
    id: string,
    opts?: { consistent?: boolean },
  ): Promise<PomodoroSession | null> {
    const it = await this.doc.get(this.p(), sk.sessionRunning(id), opts);
    return it ? toEntity<PomodoroSession>(it) : null;
  }
  async putSession(s: PomodoroSession): Promise<PomodoroSession> {
    if (s.status === 'running') {
      await this.writes.put(entityItem(this.userId, sk.sessionRunning(s.id), s));
    } else {
      await this.writes.delete(this.p(), sk.sessionRunning(s.id)); // drop the running copy on stop
      await this.writes.put(entityItem(this.userId, sk.session(s.day, s.id), s));
    }
    return s;
  }

  // --- Habits ---
  async listHabits(): Promise<Habit[]> {
    return alive((await this.doc.query(this.p(), sk.habitPrefix())).map((i) => toEntity<Habit>(i)));
  }
  async getHabit(id: string, opts?: { consistent?: boolean }): Promise<Habit | null> {
    const it = await this.doc.get(this.p(), sk.habit(id), opts);
    return it ? toEntity<Habit>(it) : null;
  }
  async putHabit(h: Habit): Promise<Habit> {
    await this.writes.put(entityItem(this.userId, sk.habit(h.id), h));
    return h;
  }

  // --- Habit checks (composite date+habit key → direct read/delete, no scan) ---
  async getCheck(
    date: string,
    habitId: string,
    opts?: { consistent?: boolean },
  ): Promise<HabitCheck | null> {
    const it = await this.doc.get(this.p(), sk.hcheck(date, habitId), opts);
    const c = it ? toEntity<HabitCheck>(it) : null;
    return c && c.deletedAt === null ? c : null;
  }
  async putCheck(c: HabitCheck, date: string, habitId: string): Promise<HabitCheck> {
    await this.writes.put(entityItem(this.userId, sk.hcheck(date, habitId), c));
    return c;
  }
  // One range read (the SK sorts by date): `hcheck#<from>#` … the end of `hcheck#<to>#`.
  async listChecks(fromDate: string, toDate: string): Promise<HabitCheck[]> {
    const rows = await this.doc.query(this.p(), sk.hcheckAllPrefix(), {
      from: sk.hcheckPrefix(fromDate),
      to: sk.hcheckPrefix(toDate) + SK_END,
    });
    return alive(rows.map((i) => toEntity<HabitCheck>(i)));
  }
  async listAllChecks(): Promise<HabitCheck[]> {
    return alive(
      (await this.doc.query(this.p(), sk.hcheckAllPrefix())).map((i) => toEntity<HabitCheck>(i)),
    );
  }

  // --- Ideas ---
  async listIdeas(): Promise<Idea[]> {
    return alive((await this.doc.query(this.p(), sk.ideaPrefix())).map((i) => toEntity<Idea>(i)));
  }
  async getIdea(id: string, opts?: { consistent?: boolean }): Promise<Idea | null> {
    const it = await this.doc.get(this.p(), sk.idea(id), opts);
    return it ? toEntity<Idea>(it) : null;
  }
  async putIdea(i: Idea): Promise<Idea> {
    await this.writes.put(entityItem(this.userId, sk.idea(i.id), i));
    return i;
  }

  // --- Day singleton ---
  async getDayRow(date: string, opts?: { consistent?: boolean }): Promise<Day | null> {
    const it = await this.doc.get(this.p(), sk.day(date), opts);
    return it ? toEntity<Day>(it) : null;
  }
  async putDay(d: Day): Promise<Day> {
    await this.writes.put(entityItem(this.userId, sk.day(d.date), d));
    return d;
  }
  async listAllDays(): Promise<Day[]> {
    return alive((await this.doc.query(this.p(), sk.dayPrefix())).map((i) => toEntity<Day>(i)));
  }

  // --- Categories ---
  // A row from before `area` has none; every read lists it as null (areas.ts), so a copy written back
  // carries null too — one state for "no area", whichever path returns the row.
  private category(i: Item): Category {
    const c = toEntity<Category>(i);
    return { ...c, area: c.area ?? null };
  }
  async listCategories(): Promise<Category[]> {
    return alive((await this.doc.query(this.p(), sk.catPrefix())).map((i) => this.category(i)));
  }
  async getCategory(id: string, opts?: { consistent?: boolean }): Promise<Category | null> {
    const it = await this.doc.get(this.p(), sk.cat(id), opts);
    return it ? this.category(it) : null;
  }
  async putCategory(c: Category): Promise<Category> {
    await this.writes.put(entityItem(this.userId, sk.cat(c.id), c));
    return c;
  }
  // Every write to an existing category: a conditional put on the row as read, re-merged on a lost race
  // (casUpdate), so a rename and a work flip landing on two instances at once can't revert each other.
  async updateCategory(
    id: string,
    fn: (fresh: Category) => Category | null, // null: nothing to write (the fresh row comes back)
    now: number,
    opts: { allowDeleted?: boolean } = {},
  ): Promise<Category> {
    const shape: CasShape<Category> = {
      sk: sk.cat(id),
      read: (i) => this.category(i),
      toItem: (t) => entityItem(this.userId, sk.cat(t.id), t),
    };
    return this.casUpdate(shape, id, fn, now, { ...opts, consistent: true });
  }

  // --- Places (errand lists) ---
  async listPlaces(opts?: { consistent?: boolean }): Promise<Place[]> {
    return alive(
      (await this.doc.query(this.p(), sk.placePrefix(), opts)).map((i) => toEntity<Place>(i)),
    );
  }
  // getStory-style (re-filter tombstones → null): a deleted place can't be renamed or deleted again.
  async getPlace(id: string, opts?: { consistent?: boolean }): Promise<Place | null> {
    const it = await this.doc.get(this.p(), sk.place(id), opts);
    const p = it ? toEntity<Place>(it) : null;
    return p && p.deletedAt === null ? p : null;
  }
  async putPlace(p: Place): Promise<Place> {
    await this.writes.put(entityItem(this.userId, sk.place(p.id), p));
    return p;
  }
  // The Shortcut read's heartbeat: one conditional write on the row as read, so a rename that landed
  // meanwhile is never flattened (a lost race re-reads — casUpdate). A tombstoned place throws Not found.
  async touchPlace(place: Place, now: number): Promise<Place> {
    const stamped = { ...place, lastReadAt: now, updatedAt: Math.max(now, place.updatedAt + 1) };
    try {
      await this.writes.putIf(
        entityItem(this.userId, sk.place(place.id), stamped),
        place.updatedAt,
      );
      return stamped;
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
      const shape: CasShape<Place> = {
        sk: sk.place(place.id),
        read: (i) => toEntity<Place>(i),
        toItem: (t) => entityItem(this.userId, sk.place(t.id), t),
      };
      return this.casUpdate(shape, place.id, (fresh) => ({ ...fresh, lastReadAt: now }), now);
    }
  }

  // --- Place token pointer (the user's live Shortcut token: its hash, never the token) ---
  // Consistent: rotate/revoke write it back conditionally on the version read here.
  async getPlaceTokenPointer(): Promise<PlaceTokenPointer | null> {
    const it = await this.doc.get(this.p(), sk.ptoken(), { consistent: true });
    return it ? pointerOf(it) : null; // PlaceTokenPointerError on a row with no numeric updatedAt
  }
  // Lands only while the stored pointer is still at `expectedUpdatedAt` (null: none yet) —
  // ConditionFailedError otherwise.
  async putPlaceTokenPointer(
    ptr: PlaceTokenPointer,
    expectedUpdatedAt: number | null,
  ): Promise<void> {
    await this.writes.putIf({ PK: this.p(), SK: sk.ptoken(), ...ptr }, expectedUpdatedAt);
  }

  // --- Finances ---
  // Every write to an existing finance row is a casUpdate: read → change → conditional put on the
  // updatedAt it read, retried on a lost race — so a sync never clobbers a bucket set mid-run and a
  // user edit never writes back a stale Plaid amount. Brand-new transaction rows batch (the sync lock
  // is the only writer that can create them).

  // Read `fresh`, apply `fn`, write only if nobody changed the row in between; retry (strongly
  // consistent) on a lost race. `fn` returning null means "nothing to do" (the fresh row is returned
  // as-is); it always sees the freshest row, so its checks re-run each attempt. A missing row throws
  // `Not found`, or is created from `create()` when given (itself conditional — absent only). A
  // tombstoned row throws unless `allowDeleted`. updatedAt is bumped strictly past the read value, so
  // two writes in the same millisecond (or under a frozen test clock) can't both pass the condition.
  // `consistent` makes the FIRST read strongly consistent too — for decisions taken on a read that
  // may never be written back (fn → null), like "is the sync lock held?".
  async casUpdate<T extends BaseEntity>(
    shape: CasShape<T>,
    id: string,
    fn: (fresh: T) => T | null,
    now: number,
    opts: { allowDeleted?: boolean; create?: () => T; consistent?: boolean } = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const item = await this.doc.get(this.p(), shape.sk, {
        consistent: attempt > 0 || opts.consistent === true,
      });
      if (!item) {
        if (!opts.create) throw new Error(`Not found: ${id}`);
        const created = opts.create();
        try {
          await this.writes.putIf(shape.toItem(created), null);
          return created;
        } catch (err) {
          if (err instanceof ConditionFailedError) continue;
          throw err;
        }
      }
      const fresh = shape.read(item);
      if (fresh.deletedAt !== null && !opts.allowDeleted) throw new Error(`Not found: ${id}`);
      const next = fn(fresh);
      if (next === null) return fresh;
      const stamped = { ...next, updatedAt: Math.max(now, fresh.updatedAt + 1) };
      try {
        await this.writes.putIf(shape.toItem(stamped), fresh.updatedAt);
        return stamped;
      } catch (err) {
        if (err instanceof ConditionFailedError) continue;
        throw err;
      }
    }
    throw new ConflictError();
  }

  finItemShape(id: string): CasShape<FinanceItem> {
    return {
      sk: sk.finItem(id),
      read: (i) => toEntity<FinanceItem>(i),
      toItem: (t) => entityItem(this.userId, sk.finItem(t.id), t),
    };
  }
  finSyncShape(itemId: string): CasShape<FinanceSyncState> {
    return {
      sk: sk.finSync(itemId),
      read: toFinanceSyncState,
      toItem: (t) => entityItem(this.userId, sk.finSync(t.itemId), t),
    };
  }
  finAcctShape(id: string): CasShape<FinanceAccount> {
    return {
      sk: sk.finAcct(id),
      read: (i) => toEntity<FinanceAccount>(i),
      toItem: (t) => entityItem(this.userId, sk.finAcct(t.id), t),
    };
  }
  finTxnShape(id: string): CasShape<FinanceTransaction> {
    return {
      sk: sk.finTxn(id),
      read: toFinanceTxn,
      toItem: (t) => financeTxnItem(this.userId, t),
    };
  }
  finRuleShape(id: string): CasShape<FinanceRule> {
    return {
      sk: sk.finRule(id),
      read: (i) => toEntity<FinanceRule>(i),
      toItem: (t) => entityItem(this.userId, sk.finRule(t.id), t),
    };
  }

  // Tombstones included: callers decide (a removed item is a no-op; a returning account revives).
  async getFinanceItem(id: string, opts?: { consistent?: boolean }): Promise<FinanceItem | null> {
    const it = await this.doc.get(this.p(), sk.finItem(id), opts);
    return it ? toEntity<FinanceItem>(it) : null;
  }
  async listFinanceItems(): Promise<FinanceItem[]> {
    return alive(
      (await this.doc.query(this.p(), sk.finItemPrefix())).map((i) => toEntity<FinanceItem>(i)),
    );
  }
  async getFinanceSyncState(
    itemId: string,
    opts?: { consistent?: boolean },
  ): Promise<FinanceSyncState | null> {
    const it = await this.doc.get(this.p(), sk.finSync(itemId), opts);
    return it ? toFinanceSyncState(it) : null;
  }
  async listFinanceSyncStates(): Promise<FinanceSyncState[]> {
    return alive((await this.doc.query(this.p(), sk.finSyncPrefix())).map(toFinanceSyncState));
  }
  // Tombstones included (the sync revives a returning account, keeping its flip/hide).
  async listFinanceAccountsAll(): Promise<FinanceAccount[]> {
    return (await this.doc.query(this.p(), sk.finAcctPrefix())).map((i) =>
      toEntity<FinanceAccount>(i),
    );
  }
  async listFinanceAccounts(): Promise<FinanceAccount[]> {
    return alive(await this.listFinanceAccountsAll());
  }
  async getFinanceAccount(
    id: string,
    opts?: { consistent?: boolean },
  ): Promise<FinanceAccount | null> {
    const it = await this.doc.get(this.p(), sk.finAcct(id), opts);
    return it ? toEntity<FinanceAccount>(it) : null;
  }
  // Alive rows dated in [from, to] (inclusive; `to` omitted = no upper bound) — the GSI date index.
  async listFinanceTxnsInRange(from: string, to?: string): Promise<FinanceTransaction[]> {
    const rows = await this.doc.queryIndex(gsi1.finTxnPk(this.userId), {
      from: gsi1.finTxnSk(from),
      to: to === undefined ? undefined : gsi1.finTxnSk(to),
    });
    return alive(rows.map(toFinanceTxn));
  }
  async listAllFinanceTxns(): Promise<FinanceTransaction[]> {
    return alive((await this.doc.query(this.p(), sk.finTxnPrefix())).map(toFinanceTxn));
  }
  async getFinanceTxn(
    id: string,
    opts?: { consistent?: boolean },
  ): Promise<FinanceTransaction | null> {
    const it = await this.doc.get(this.p(), sk.finTxn(id), opts);
    return it ? toFinanceTxn(it) : null;
  }
  // Each id's row, tombstones included (a posted row inherits from an already-removed pending one).
  async getFinanceTxns(
    ids: string[],
    opts?: { consistent?: boolean },
  ): Promise<Map<string, FinanceTransaction>> {
    const rows = await mapLimit(ids, FIN_CONCURRENCY, (id) => this.getFinanceTxn(id, opts));
    const out = new Map<string, FinanceTransaction>();
    for (const r of rows) if (r) out.set(r.id, r);
    return out;
  }
  // A row the caller believes is new: written only if absent. If it turns out to exist (a read that
  // missed it, a write that landed meanwhile), `merge(fresh)` decides the write instead, via casUpdate —
  // so a blind insert can never flatten a user's edit.
  async insertFinanceTxn(
    row: FinanceTransaction,
    merge: (fresh: FinanceTransaction) => FinanceTransaction,
  ): Promise<FinanceTransaction> {
    try {
      await this.writes.putIf(financeTxnItem(this.userId, row), null);
      return row;
    } catch (err) {
      if (!(err instanceof ConditionFailedError)) throw err;
      return this.casUpdate(this.finTxnShape(row.id), row.id, merge, row.updatedAt, {
        allowDeleted: true,
        consistent: true,
      });
    }
  }
  async listFinanceRules(): Promise<FinanceRule[]> {
    return alive(
      (await this.doc.query(this.p(), sk.finRulePrefix())).map((i) => toEntity<FinanceRule>(i)),
    );
  }
  async getFinanceRule(id: string): Promise<FinanceRule | null> {
    const it = await this.doc.get(this.p(), sk.finRule(id));
    return it ? toEntity<FinanceRule>(it) : null;
  }
  // casUpdate a batch of rows, a bounded number at a time.
  async casMany<T extends BaseEntity, U>(
    items: readonly U[],
    each: (u: U) => Promise<T>,
  ): Promise<T[]> {
    return mapLimit(items, FIN_CONCURRENCY, each);
  }

  // --- Reminders (reminders.md) ---
  // Rows written before the remind index existed carry no keys: re-put one as read (same body, same
  // updatedAt) so it lands on the index. Conditional on that updatedAt — a write since already keyed it,
  // so a lost race is nothing to do. false = lost.
  private async rekey(item: Item, updatedAt: number): Promise<boolean> {
    try {
      await this.writes.putIf(item, updatedAt);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  // Armed at `armedAt` (the backfill's own time: what fell due before it stays quiet).
  async rekeyTask(t: Task, armedAt: number): Promise<boolean> {
    return this.rekey(taskItem(this.userId, t, armedAt), t.updatedAt);
  }
  async rekeyPlan(p: TaskPlan, armedAt: number): Promise<boolean> {
    return this.rekey(planItem(this.userId, p, armedAt), p.updatedAt);
  }

  // A device's subscription carries its keys (a credential): the BFF strips them before anything leaves.
  // A device the user removed is a tombstone with its endpoint and keys cleared (removal sticks: its own
  // launch-time resync reads it and stops) — alive ones only here, every row in listAllPushSubs.
  async listPushSubs(opts?: { consistent?: boolean }): Promise<PushSub[]> {
    return alive(await this.listAllPushSubs(opts));
  }
  async listAllPushSubs(opts?: { consistent?: boolean }): Promise<PushSub[]> {
    return (await this.doc.query(this.p(), sk.pushSubPrefix(), opts)).map((i) =>
      toEntity<PushSub>(i),
    );
  }
  // Tombstones included: a re-subscribe revives one, a second remove finds it already gone.
  async getPushSub(id: string): Promise<PushSub | null> {
    const it = await this.doc.get(this.p(), sk.pushSub(id), { consistent: true });
    return it ? toEntity<PushSub>(it) : null;
  }
  async putPushSub(s: PushSub): Promise<PushSub> {
    await this.writes.put(entityItem(this.userId, sk.pushSub(s.id), s));
    return s;
  }
  // The poller's stamp, only on the row it read: a re-subscribe that landed meanwhile wins. false = lost.
  async putPushSubIf(s: PushSub, expectedUpdatedAt: number): Promise<boolean> {
    try {
      await this.writes.putIf(entityItem(this.userId, sk.pushSub(s.id), s), expectedUpdatedAt);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  // Only the version read: a removal (tombstone) or a revive that landed since wins. false = lost.
  async deletePushSubIf(id: string, expectedUpdatedAt: number): Promise<boolean> {
    try {
      await this.writes.deleteIf(this.p(), sk.pushSub(id), expectedUpdatedAt);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }

  async getPushArm(): Promise<PushArmRow | null> {
    const it = await this.doc.get(this.p(), sk.pushArm(), { consistent: true });
    return it ? toEntity<PushArmRow>(it) : null;
  }
  async putPushArm(row: PushArmRow): Promise<void> {
    await this.writes.put(entityItem(this.userId, sk.pushArm(), row));
  }

  // The remind index in [from, to], ascending by fire time. Eventually consistent (a GSI is never
  // anything else), so the poller re-reads what it acts on.
  async remindRowsInWindow(fromMs: number, toMs: number): Promise<RemindRow[]> {
    const rows = await this.doc.queryIndex(gsi1.remindPk(this.userId), { from: fromMs, to: toMs });
    const out: RemindRow[] = [];
    for (const it of rows) {
      const fireAt = it.GSI1SK as number;
      if (it.SK.startsWith(sk.taskPrefix()))
        out.push({ kind: 'task', fireAt, task: toEntity<Task>(it) });
      else if (it.SK.startsWith(sk.planAllPrefix()))
        out.push({ kind: 'plan', fireAt, sk: it.SK, plan: toEntity<TaskPlan>(it) });
      else if (it.SK.startsWith(sk.pushTestPrefix()))
        out.push({ kind: 'test', fireAt, id: toEntity<PushTestRow>(it).id });
    }
    return out;
  }

  // Send test: on the remind index at the moment it was queued, so the next tick finds it.
  async putPushTest(t: PushTestRow): Promise<void> {
    await this.writes.put({
      ...entityItem(this.userId, sk.pushTest(t.id), t),
      GSI1PK: gsi1.remindPk(this.userId),
      GSI1SK: gsi1.remindSk(t.createdAt),
    });
  }
  async listPushTests(opts?: { consistent?: boolean }): Promise<PushTestRow[]> {
    return (await this.doc.query(this.p(), sk.pushTestPrefix(), opts)).map((i) =>
      toEntity<PushTestRow>(i),
    );
  }
  async deletePushTest(id: string): Promise<void> {
    await this.writes.delete(this.p(), sk.pushTest(id));
  }

  // Dedup: written only if absent, before the send. false = this reminder already went (or is going).
  async putPushSentIf(row: PushSentRow): Promise<boolean> {
    try {
      await this.writes.putIf(entityItem(this.userId, sk.pushSent(row.fireAt, row.key), row), null);
      return true;
    } catch (err) {
      if (err instanceof ConditionFailedError) return false;
      throw err;
    }
  }
  async listPushSent(): Promise<PushSentRow[]> {
    return (await this.doc.query(this.p(), sk.pushSentPrefix())).map((i) =>
      toEntity<PushSentRow>(i),
    );
  }
  async deletePushSent(row: Pick<PushSentRow, 'fireAt' | 'key'>): Promise<void> {
    await this.writes.delete(this.p(), sk.pushSent(row.fireAt, row.key));
  }

  // The guard's counter — consistent, since the conditional write that follows is on the version read.
  async getPushCount(day: string): Promise<PushCountRow | null> {
    const it = await this.doc.get(this.p(), sk.pushCount(day), { consistent: true });
    return it ? toEntity<PushCountRow>(it) : null;
  }
  // Lands only while the stored row is still at `expectedUpdatedAt` (null: none yet) — ConditionFailedError
  // otherwise.
  async putPushCountIf(row: PushCountRow, expectedUpdatedAt: number | null): Promise<void> {
    await this.writes.putIf(entityItem(this.userId, sk.pushCount(row.day), row), expectedUpdatedAt);
  }
  async listPushCounts(): Promise<PushCountRow[]> {
    return (await this.doc.query(this.p(), sk.pushCountPrefix())).map((i) =>
      toEntity<PushCountRow>(i),
    );
  }
  async deletePushCount(day: string): Promise<void> {
    await this.writes.delete(this.p(), sk.pushCount(day));
  }

  async getPushUserHealth(): Promise<PushUserHealth | null> {
    const it = await this.doc.get(this.p(), sk.pushHealth(), { consistent: true });
    return it ? toEntity<PushUserHealth>(it) : null;
  }
  async putPushUserHealth(h: PushUserHealth): Promise<void> {
    await this.writes.put(entityItem(this.userId, sk.pushHealth(), h));
  }

  // --- Settings singleton ---
  // --- Calendar two-way sync cursor (one row per Google account) ---
  async getGcalSyncState(
    sub: string,
    opts?: { consistent?: boolean },
  ): Promise<GcalSyncState | null> {
    const it = await this.doc.get(this.p(), sk.gcalSync(sub), opts);
    const s = it ? toEntity<GcalSyncState>(it) : null;
    return s && s.deletedAt === null ? s : null;
  }
  async putGcalSyncState(s: GcalSyncState): Promise<GcalSyncState> {
    await this.writes.put(entityItem(this.userId, sk.gcalSync(s.sub), s));
    return s;
  }
  async listGcalSyncStates(): Promise<GcalSyncState[]> {
    return alive(
      (await this.doc.query(this.p(), sk.gcalSyncPrefix())).map(toEntity<GcalSyncState>),
    );
  }

  async getSettingsRow(opts?: { consistent?: boolean }): Promise<Settings | null> {
    const it = await this.doc.get(this.p(), sk.settings(), opts);
    return it ? toEntity<Settings>(it) : null;
  }
  async putSettings(s: Settings): Promise<Settings> {
    await this.writes.put(entityItem(this.userId, sk.settings(), s));
    return s;
  }
}
