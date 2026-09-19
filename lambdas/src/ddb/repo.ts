import type {
  Attachment,
  Category,
  Day,
  Habit,
  HabitCheck,
  Idea,
  LeetcodeAttempt,
  LogEntry,
  PomodoroSession,
  Settings,
  Story,
  Task,
  TaskPlan,
  TaskSeries,
} from '@aperture/shared';
import type { DocClient, Item } from './DocClient';
import type { Writes } from './writes';
import { gsi1, pk, sk } from './keys';
import { entityItem, taskItem, toEntity } from './mapping';

type Deletable = { deletedAt: number | null };
const alive = <T extends Deletable>(rows: T[]): T[] => rows.filter((r) => r.deletedAt === null);

// The persistence facade the routes sit on: reads go straight to the DocClient, every write goes
// through `writes` (the single audit point). Entities keyed as `type#<id>` get a direct read; the few
// that bucket day/order into the SK (log, plan, session) fall back to a prefix scan to resolve an id.
//
// TODO(scale, pre-deploy): `findSessionById` scans the whole `sess#` prefix, which the pomodoro
// heartbeat hits often. Fine at single-user volume for Phase 10 (in-memory), but before the Phase 12
// deploy, move running sessions under a `sess#running#` prefix so the hot path is a direct read.
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
  // TODO(scale, pre-deploy): prefix scan for dedup — matches findLog/findPlan single-user tolerance.
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

  // --- Tasks ---
  async listTasks(): Promise<Task[]> {
    return alive((await this.doc.query(this.p(), sk.taskPrefix())).map((i) => toEntity<Task>(i)));
  }
  async getTask(id: string): Promise<Task | null> {
    const it = await this.doc.get(this.p(), sk.task(id));
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
  async listAllPlans(): Promise<TaskPlan[]> {
    return alive(
      (await this.doc.query(this.p(), sk.planAllPrefix())).map((i) => toEntity<TaskPlan>(i)),
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
    return alive(
      (await this.doc.query(this.p(), sk.storyPrefix())).map((i) => toEntity<Story>(i)),
    );
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

  // --- Task attachments (metadata; bytes live in S3) ---
  async listAttachmentsForTask(taskId: string): Promise<Attachment[]> {
    return alive(
      (await this.doc.query(this.p(), sk.attachTaskPrefix(taskId))).map((i) =>
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

  // --- Settings singleton ---
  async getSettingsRow(): Promise<Settings | null> {
    const it = await this.doc.get(this.p(), sk.settings());
    return it ? toEntity<Settings>(it) : null;
  }
  async putSettings(s: Settings): Promise<Settings> {
    await this.writes.put(entityItem(this.userId, sk.settings(), s));
    return s;
  }
}
