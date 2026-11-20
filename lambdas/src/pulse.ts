import {
  PULSE_PARENT_ERROR,
  PULSE_STATE_ID,
  USER_TIME_ZONE,
  accruesTime,
  dayKeyInZone,
  decidePulse,
  hasParts,
  normalizePulseNote,
  pulseResultOf,
  pulseSessionRow,
  pulseWindowMs,
  yieldPulse,
} from '@aperture/shared';
import type {
  BaseEntity,
  OpenPulse,
  PulseBlock,
  PulseInput,
  PulsePlan,
  PulseResult,
  PulseRowChange,
  PulseState,
  Task,
  TaskStatus,
} from '@aperture/shared';
import type { Repo } from './ddb/repo';

export interface PulseServiceDeps {
  repo: Repo;
  userId: string;
  now: () => number;
  ulid: () => string;
  base: () => BaseEntity;
  dayStartHour: () => Promise<number>;
  // The backend's own transition (parts' locks, sittings' ends, calendar): a pulse starts and finishes a
  // task exactly as the app's buttons do.
  transitionTask: (id: string, to: TaskStatus) => Promise<Task>;
}

// The pulse half of the BackendClient — the SAME behaviour as the stub (the shared contract suite runs
// both), over the Repo. The decision is shared (pulse.ts decidePulse); this reads, writes and orders.
// Writes, in order: the task's start, the state row (the one conditional decision point), each session row
// it changes, each task's minutes (conditional too), then a done. A crash between them under-counts by at
// most one window and never double-counts: the next pulse rewrites the session row from the state row.
export class PulseService {
  constructor(private readonly d: PulseServiceDeps) {}

  async pulse(input: PulseInput): Promise<PulseResult> {
    const { repo } = this.d;
    const note = normalizePulseNote(input.note);
    const now = this.d.now();
    let task = await repo.getTask(input.taskId, { consistent: true });
    if (!task) throw new Error(`Not found: ${input.taskId}`);
    if (!accruesTime(task)) throw new Error(`Task is already ${task.status}`);
    const category = task.categoryId ? await repo.getCategory(task.categoryId) : null;
    const windowMs = pulseWindowMs(category);
    const open = (await repo.getPulseState({ consistent: true }))?.open ?? null;
    const extending = open?.taskId === task.id && now - open.lastPulseAt <= windowMs;
    // A part has no parts of its own, so only a possible parent pays for the list read, and only on a new session.
    if (
      !extending &&
      !task.parentId &&
      hasParts(await repo.listTasks({ consistent: true }), task.id)
    )
      throw new Error(PULSE_PARENT_ERROR);
    const blocked = await this.blockOf(task);
    if (task.status === 'backlog' || task.status === 'planned')
      task = await this.d.transitionTask(task.id, 'in_progress'); // freezes the estimate lock

    const started = task;
    const day = dayKeyInZone(now, USER_TIME_ZONE, await this.d.dayStartHour());
    const done = input.done === true;
    let decided!: ReturnType<typeof decidePulse>;
    const decide = (fresh: OpenPulse | null) => {
      decided = decidePulse({
        open: fresh,
        task: started,
        wasWork: category?.isWork ?? false,
        windowMs,
        day,
        now,
        note,
        blocked,
        newId: this.d.ulid,
        done,
      });
      return decided.plan.open;
    };
    await repo.casUpdate<PulseState>(
      repo.pulseStateShape(),
      PULSE_STATE_ID,
      (fresh) => {
        const next = decide(fresh.open);
        return next === null && fresh.open === null ? null : { ...fresh, open: next };
      },
      now,
      {
        create: () => ({ ...this.d.base(), id: PULSE_STATE_ID, open: decide(null) }),
        consistent: true,
      },
    );
    const { plan, needs } = decided;
    task = (await this.writeRows(plan.rows, now, task.id)) ?? task;
    if (done && !needs) task = await this.d.transitionTask(task.id, 'done');
    return pulseResultOf(task, plan, { blocked, done, needs });
  }

  // A work timer started on a task: its open pulse session ends now (startSession's half of the interplay).
  async yieldTo(taskId: string): Promise<void> {
    const { repo } = this.d;
    const now = this.d.now();
    let row: PulseRowChange | null = null;
    const state = await repo.getPulseState({ consistent: true });
    if (state?.open?.taskId !== taskId) return; // the common case: no extra write on a timer start
    await repo.casUpdate<PulseState>(
      repo.pulseStateShape(),
      PULSE_STATE_ID,
      (fresh) => {
        const y = yieldPulse(fresh.open, taskId, now);
        row = y?.row ?? null;
        return y ? { ...fresh, open: null } : null;
      },
      now,
    );
    if (row) await this.writeRows([row], now, taskId);
  }

  // Each changed session row, then its task's minutes. Returns `taskId`'s task as it ends up, when it moved.
  private async writeRows(
    rows: PulsePlan['rows'],
    now: number,
    taskId: string,
  ): Promise<Task | null> {
    let mine: Task | null = null;
    for (const r of rows) {
      await this.d.repo.putPulseSession(pulseSessionRow(r.session, this.d.userId, now));
      const t = await this.d.repo.accrueTaskMinutes(r.session.taskId, r.deltaMin, now);
      if (t && r.session.taskId === taskId) mine = t;
    }
    return mine;
  }

  // Something else times this task: a running work timer (at any heartbeat age — a locked phone's timer
  // credits the whole gap on its next beat), or a LeetCode sitting (only a Roll rep can have one).
  private async blockOf(task: Task): Promise<PulseBlock | null> {
    const timers = await this.d.repo.listRunningSessions();
    if (timers.some((s) => s.kind === 'work' && s.taskId === task.id)) return 'timer';
    if (!task.rollId) return null;
    const sittings = await this.d.repo.listSittings({ consistent: true });
    return sittings.some((s) => s.repTaskId === task.id) ? 'sitting' : null;
  }
}
