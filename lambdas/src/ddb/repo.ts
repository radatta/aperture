import type {
  Attachment,
  BaseEntity,
  Category,
  FinanceAccount,
  FinanceItem,
  FinanceRule,
  FinanceSyncState,
  FinanceTransaction,
  FluxSet,
  Day,
  Habit,
  HabitCheck,
  Idea,
  LeetcodeAttempt,
  LogEntry,
  Place,
  PomodoroSession,
  Roll,
  GcalSyncState,
  Settings,
  Story,
  Task,
  TaskPlan,
  TaskSeries,
} from '@aperture/shared';
import { ConditionFailedError } from './DocClient';
import type { DocClient, Item } from './DocClient';
import type { Writes } from './writes';
import type { PlaceTokenPointer } from './placeTokens';
import { gsi1, pk, sk } from './keys';
import {
  entityItem,
  financeTxnItem,
  taskItem,
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
  private async scanById(prefix: string, id: string): Promise<Item | null> {
    const rows = await this.doc.query(this.p(), prefix);
    return rows.find((r) => r.id === id) ?? null;
  }

  // --- Log ---
  async listLog(day: string): Promise<LogEntry[]> {
    return alive(
      (await this.doc.query(this.p(), sk.logPrefix(day))).map((i) => toEntity<LogEntry>(i)),
    );
  }
  async listAllLog(): Promise<LogEntry[]> {
    return alive(
      (await this.doc.query(this.p(), sk.logAllPrefix())).map((i) => toEntity<LogEntry>(i)),
    );
  }
  async findLog(id: string): Promise<LogEntry | null> {
    const it = await this.scanById(sk.logAllPrefix(), id);
    return it ? toEntity<LogEntry>(it) : null;
  }
  async putLog(e: LogEntry): Promise<LogEntry> {
    await this.writes.put(entityItem(this.userId, sk.log(e.day, e.id), e));
    return e;
  }

  // --- LeetCode attempts ---
  async listLeetcodeAttempts(): Promise<LeetcodeAttempt[]> {
    return alive(
      (await this.doc.query(this.p(), sk.lcAllPrefix())).map((i) => toEntity<LeetcodeAttempt>(i)),
    );
  }
  // TODO(scale): prefix scan for dedup — matches findLog/findPlan single-user tolerance.
  // Before a high-volume deploy, add a `lcsub#<id>` pointer item so this is a direct read.
  async findLeetcodeBySubmissionId(submissionId: string): Promise<LeetcodeAttempt | null> {
    return (
      (await this.listLeetcodeAttempts()).find((a) => a.leetcodeSubmissionId === submissionId) ??
      null
    );
  }
  async putLeetcodeAttempt(a: LeetcodeAttempt): Promise<LeetcodeAttempt> {
    await this.writes.put(entityItem(this.userId, sk.lc(a.day, a.id), a));
    return a;
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
  async putTask(t: Task): Promise<Task> {
    await this.writes.put(taskItem(this.userId, t));
    return t;
  }
  async putTasks(tasks: Task[]): Promise<Task[]> {
    await this.writes.batchPut(tasks.map((t) => taskItem(this.userId, t)));
    return tasks;
  }
  async doneTasksInWindow(fromMs: number, toMs: number): Promise<Task[]> {
    const rows = await this.doc.queryIndex(gsi1.donePk(this.userId), { from: fromMs, to: toMs });
    return alive(rows.map((i) => toEntity<Task>(i)));
  }

  // --- Plans ---
  async listPlans(day: string): Promise<TaskPlan[]> {
    return alive(
      (await this.doc.query(this.p(), sk.planPrefix(day))).map((i) => toEntity<TaskPlan>(i)),
    );
  }
  async listAllPlans(opts?: { consistent?: boolean }): Promise<TaskPlan[]> {
    return alive(
      (await this.doc.query(this.p(), sk.planAllPrefix(), opts)).map((i) => toEntity<TaskPlan>(i)),
    );
  }
  async findPlan(id: string): Promise<TaskPlan | null> {
    const it = await this.scanById(sk.planAllPrefix(), id);
    return it ? toEntity<TaskPlan>(it) : null;
  }
  async putPlan(p: TaskPlan, previous?: TaskPlan): Promise<TaskPlan> {
    // Order/day live in the SK, so a moved plan lands at a new key — drop the old row first.
    const nextSk = sk.plan(p.day, p.order, p.id);
    if (previous) {
      const prevSk = sk.plan(previous.day, previous.order, previous.id);
      if (prevSk !== nextSk) await this.writes.delete(this.p(), prevSk);
    }
    await this.writes.put(entityItem(this.userId, nextSk, p));
    return p;
  }

  // --- Series ---
  async listSeries(): Promise<TaskSeries[]> {
    return alive(
      (await this.doc.query(this.p(), sk.seriesPrefix())).map((i) => toEntity<TaskSeries>(i)),
    );
  }
  async getSeries(id: string): Promise<TaskSeries | null> {
    const it = await this.doc.get(this.p(), sk.series(id));
    return it ? toEntity<TaskSeries>(it) : null;
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
  async getStory(id: string): Promise<Story | null> {
    const it = await this.doc.get(this.p(), sk.story(id));
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
  async getRoll(id: string): Promise<Roll | null> {
    const it = await this.doc.get(this.p(), sk.roll(id));
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
  async findAttachment(id: string): Promise<Attachment | null> {
    const it = await this.scanById(sk.attachAllPrefix(), id);
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
  async getRunningSession(id: string): Promise<PomodoroSession | null> {
    const it = await this.doc.get(this.p(), sk.sessionRunning(id));
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
  async getHabit(id: string): Promise<Habit | null> {
    const it = await this.doc.get(this.p(), sk.habit(id));
    return it ? toEntity<Habit>(it) : null;
  }
  async putHabit(h: Habit): Promise<Habit> {
    await this.writes.put(entityItem(this.userId, sk.habit(h.id), h));
    return h;
  }

  // --- Habit checks (composite date+habit key → direct read/delete, no scan) ---
  async getCheck(date: string, habitId: string): Promise<HabitCheck | null> {
    const it = await this.doc.get(this.p(), sk.hcheck(date, habitId));
    const c = it ? toEntity<HabitCheck>(it) : null;
    return c && c.deletedAt === null ? c : null;
  }
  async putCheck(c: HabitCheck, date: string, habitId: string): Promise<HabitCheck> {
    await this.writes.put(entityItem(this.userId, sk.hcheck(date, habitId), c));
    return c;
  }
  async deleteCheck(date: string, habitId: string): Promise<void> {
    await this.writes.delete(this.p(), sk.hcheck(date, habitId));
  }
  async listChecks(fromDate: string, toDate: string): Promise<HabitCheck[]> {
    const rows = await this.doc.query(this.p(), sk.hcheckAllPrefix());
    return alive(rows.map((i) => toEntity<HabitCheck>(i))).filter(
      (c) => c.date >= fromDate && c.date <= toDate,
    );
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
  async getIdea(id: string): Promise<Idea | null> {
    const it = await this.doc.get(this.p(), sk.idea(id));
    return it ? toEntity<Idea>(it) : null;
  }
  async putIdea(i: Idea): Promise<Idea> {
    await this.writes.put(entityItem(this.userId, sk.idea(i.id), i));
    return i;
  }

  // --- Day singleton ---
  async getDayRow(date: string): Promise<Day | null> {
    const it = await this.doc.get(this.p(), sk.day(date));
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
  async listCategories(): Promise<Category[]> {
    return alive(
      (await this.doc.query(this.p(), sk.catPrefix())).map((i) => toEntity<Category>(i)),
    );
  }
  async getCategory(id: string): Promise<Category | null> {
    const it = await this.doc.get(this.p(), sk.cat(id));
    return it ? toEntity<Category>(it) : null;
  }
  async putCategory(c: Category): Promise<Category> {
    await this.writes.put(entityItem(this.userId, sk.cat(c.id), c));
    return c;
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
    if (!it) return null;
    const r = toEntity<PlaceTokenPointer>(it);
    return {
      hash: r.hash ?? null,
      createdAt: r.createdAt ?? null,
      hint: r.hint ?? null,
      retiring: r.retiring ?? [],
      updatedAt: r.updatedAt,
    };
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

  // --- Settings singleton ---
  // --- Calendar two-way sync cursor (one row per Google account) ---
  async getGcalSyncState(sub: string): Promise<GcalSyncState | null> {
    const it = await this.doc.get(this.p(), sk.gcalSync(sub));
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

  async getSettingsRow(): Promise<Settings | null> {
    const it = await this.doc.get(this.p(), sk.settings());
    return it ? toEntity<Settings>(it) : null;
  }
  async putSettings(s: Settings): Promise<Settings> {
    await this.writes.put(entityItem(this.userId, sk.settings(), s));
    return s;
  }
}
