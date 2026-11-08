import {
  accruesTime,
  completeSession,
  discardSession,
  extendSession,
  heartbeatSession,
  resolveStaleSession,
  resumeSession,
} from '@aperture/shared';
import type { BaseEntity, PomodoroSession, StartSessionInput } from '@aperture/shared';
import type { Repo } from './ddb/repo';

export interface SessionServiceDeps {
  repo: Repo;
  now: () => number;
  base: () => BaseEntity;
}

// The pomodoro-session half of the BackendClient — the SAME behaviour as the stub (the shared contract
// suite runs both), over the Repo. Its only writes are the repo's putSession and putTask.
export class SessionService {
  constructor(private readonly d: SessionServiceDeps) {}

  private get repo(): Repo {
    return this.d.repo;
  }
  private now(): number {
    return this.d.now();
  }
  private base(): BaseEntity {
    return this.d.base();
  }

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
  // Every caller writes the row back, so the read is consistent: a stop right after a pause's beat must
  // see that beat, or it completes the pre-pause copy and counts the pause as work.
  private async mustSession(id: string): Promise<PomodoroSession> {
    const s = await this.repo.getRunningSession(id, { consistent: true });
    if (!s) throw new Error(`Not found: ${id}`);
    return s;
  }
  async heartbeatSession(id: string): Promise<PomodoroSession> {
    return this.repo.putSession(heartbeatSession(await this.mustSession(id), this.now()));
  }
  async resumeSession(id: string): Promise<PomodoroSession> {
    return this.repo.putSession(resumeSession(await this.mustSession(id), this.now()));
  }
  async stopSession(
    id: string,
    status: 'completed' | 'discarded',
    opts?: { capMin?: number },
  ): Promise<PomodoroSession> {
    const session = await this.mustSession(id);
    const next =
      status === 'completed'
        ? completeSession(session, this.now(), opts?.capMin)
        : discardSession(session, this.now());
    await this.repo.putSession(next);
    if (status === 'completed') await this.accrueToTask(next);
    return next;
  }
  async extendSession(id: string, opts?: { capMin?: number }): Promise<PomodoroSession> {
    const session = await this.mustSession(id);
    return this.repo.putSession(extendSession(session, this.now(), opts?.capMin));
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
    const task = await this.repo.getTask(session.taskId, { consistent: true }); // written back below
    if (!task || !accruesTime(task)) return; // finished meanwhile: the session keeps its minutes, the task doesn't
    await this.repo.putTask({
      ...task,
      actualAccruedMin: task.actualAccruedMin + session.activeMinutes,
      updatedAt: this.now(),
    });
  }
}
