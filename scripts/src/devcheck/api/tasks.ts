// The dev check’s BFF client (api.ts), tasks: tasks, plans, sessions, habits, days, settings, categories and
// series.
// Its internals come from core.ts under the names the bodies use.
import { AUTH_HEADER, assertDevOrigin, targetOrigin } from '../config';
import type { Reads } from '../api';
import {
  CATEGORY_VIA,
  type Core,
  type CreateSeriesInput,
  type CreateTaskInput,
  type DevCalibrationPoint,
  type DevCategory,
  type DevDay,
  type DevHabit,
  type DevHabitCheck,
  type DevParseResult,
  type DevPlan,
  type DevSeries,
  type DevSession,
  type DevSettings,
  type DevTask,
  HABIT_VIA,
  SERIES_VIA,
  bffError,
} from './core';

export function tasksReads(c: Core) {
  const { call } = c;
  const reads = {
    listTasks: () => call<DevTask[]>('listTasks', []),
    listBacklog: () => call<DevTask[]>('listBacklog', []),
    getTask: (id: string) => call<DevTask | null>('getTask', [id]),
    listCategories: () => call<DevCategory[]>('listCategories', []),
    parseTask: (text: string) => call<DevParseResult>('parseTask', [text]), // the real model; writes nothing
    listPlansForDay: (day: string) => call<DevPlan[]>('listPlansForDay', [day]),
    listHabits: () => call<DevHabit[]>('listHabits', []),
    listHabitChecks: (range: { from: string; to: string }) =>
      call<DevHabitCheck[]>('listHabitChecks', [range]),
    // The app's own day read (it materializes due series and sweeps the day) — today, as the app; or
    // yesterday, which the BFF allows (Night at 2am), for the recurring scenario's due-day rows.
    getDay: (day: string) => call<DevDay>('getDay', [day]),
    // The day boundary the app files a set under (a Flux set's `day` is the app's day, not the calendar's).
    getSettings: () => call<DevSettings>('getSettings', []),
    listRunningSessions: () => call<DevSession[]>('listRunningSessions', []),
    listSessionsForDay: (day: string) => call<DevSession[]>('listSessionsForDay', [day]),
    // Every alive series, stopped ones included (a deleted one reads as gone).
    listSeries: () => call<DevSeries[]>('listSeries', []),
    getCalibration: (range: { from: string; to: string }) =>
      call<DevCalibrationPoint[]>('getCalibration', [range]),
  };
  return reads;
}

export function tasksWrites(c: Core, reads: Reads) {
  const { fetch, token, ledger, run, backoff, call, assertLedger, assertLedgerTask } = c;
  const writes = {
    // An RPC posted raw — a body string as sent (malformed on purpose, or carrying testMode), with the test
    // user's JWT or none — returning the status and parsed body so a step can assert a refusal. Here, not in
    // reads: it can name a write method. Only for calls the BFF must refuse before it writes anything, each
    // carrying a value that would change nothing if a regression took it (bff-hardening). A 429 carrying the BFF's own
    // `{error}` is returned as is; any other is Lambda throttling, backed off like call()'s.
    async rpcRaw(
      method: string,
      rawBody: string,
      auth: 'jwt' | 'none',
    ): Promise<{ status: number; body: unknown }> {
      const url = `${targetOrigin()}/api/${method}`;
      assertDevOrigin(url);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (auth === 'jwt') headers[AUTH_HEADER] = `Bearer ${token()}`;
      const { status, text } = await backoff(
        () => fetch(url, { method: 'POST', headers, body: rawBody, redirect: 'error' }),
        (s, t) => s === 429 && !bffError(t),
      );
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        return { status, body: text.slice(0, 200) };
      }
    },
    // The test user's own settings row — not ledgered; a step that changes it puts it back in its `finally`
    // (a 1-minute block for the capped-stop row, 25 again after), and a killed run's next run does (pipeline).
    updateSettings: (patch: Partial<DevSettings>) => call<DevSettings>('updateSettings', [patch]),
    // Only for a stop the server must refuse (a bad cap), or to end a timer a step staged crediting nothing
    // (capMin 0: pulse-tracking): the app stops its timers through the UI.
    stopSession: (id: string, status: 'completed', opts: { capMin: number }) =>
      call<DevSession>('stopSession', [id, status, opts]),
    // A createTask the BFF must refuse (bff-shapes' wrong shapes), ledgered like a create: a 4xx resolves
    // the intent as `refused`; a create a regression let through — titled or not — is recorded by its id
    // and cleaned like any other. `args` go as given; returns the raw answer for the step to read.
    async createTaskExpectingRefusal(
      args: unknown[],
      title: string,
    ): Promise<{ status: number; body: unknown }> {
      ledger.append({ run, op: 'intent', via: 'api:createTask', title });
      const got = await writes.rpcRaw('createTask', JSON.stringify({ args }), 'jwt');
      const id = (got.body as { id?: unknown } | null)?.id;
      if (got.status === 200 && typeof id === 'string')
        ledger.append({ run, op: 'created', id, via: 'api:createTask', title });
      // Only a 4xx is a refusal before any write; a 5xx may have landed, so its intent stays open.
      else if (got.status >= 400 && got.status < 500)
        ledger.append({ run, op: 'refused', via: 'api:createTask', title });
      return got;
    },
    async createTask(input: CreateTaskInput): Promise<DevTask> {
      ledger.append({ run, op: 'intent', via: 'api:createTask', title: input.title });
      const task = await call<DevTask>('createTask', [input]);
      ledger.append({ run, op: 'created', id: task.id, via: 'api:createTask', title: input.title });
      return task;
    },
    // A run's own task re-dated (timed-reminders moves its reminder on a minute when a tick ran late).
    async setTaskDue(
      id: string,
      due: { dueDay: string | null; dueTime?: string | null },
    ): Promise<DevTask> {
      assertLedgerTask(id);
      return call<DevTask>('setTaskDue', [id, due]);
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
    async setTaskEstimate(
      id: string,
      estimateMin: number | null,
      bufferMin: number | null,
    ): Promise<DevTask> {
      assertLedgerTask(id);
      return call<DevTask>('setTaskEstimate', [id, estimateMin, bufferMin]);
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
    // A rep's finish, which ends its sitting (Done needs the actual first: setTaskActual).
    async finishTask(id: string, to: 'done' | 'cancelled'): Promise<DevTask> {
      assertLedgerTask(id);
      return call<DevTask>('transitionTask', [id, to]);
    },
    // Cleanup's "delete": the API has none for habits, so the recorded habit is archived (HABIT_VIA).
    async archiveHabit(id: string): Promise<void> {
      assertLedger(id, 'habit');
      const habit = (await reads.listHabits()).find((h) => h.id === id);
      if (!habit) return; // never there, or gone some other way — nothing to archive
      const { name, categoryId, cadencePerWeek } = habit;
      await call<DevHabit>('upsertHabit', [
        { id, name, categoryId, cadencePerWeek, active: false },
      ]);
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
    // Its tasks move to `reassignToId`, or to no category (null) — cleanup passes null. The server refuses
    // while a task, habit, series or roll is on it, so cleanup and the sweep remove categories after every
    // other kind (pipeline.ts categoriesLast).
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
    // An upsertSeries the BFF must refuse (a bad due time, recurring.md D8), ledgered like a create: a 4xx
    // resolves the intent as `refused`; one a regression let through is recorded by its id and cleaned.
    async createSeriesExpectingRefusal(
      input: CreateSeriesInput,
      anchorDate: string,
    ): Promise<{ status: number; body: unknown }> {
      ledger.append({ run, op: 'intent', via: SERIES_VIA, title: input.title });
      const args = [{ categoryId: null, defaultEstimateMin: null, ...input, anchorDate }];
      const got = await writes.rpcRaw('upsertSeries', JSON.stringify({ args }), 'jwt');
      const id = (got.body as { id?: unknown } | null)?.id;
      if (got.status === 200 && typeof id === 'string')
        ledger.append({ run, op: 'created', id, via: SERIES_VIA, title: input.title });
      else if (got.status >= 400 && got.status < 500)
        ledger.append({ run, op: 'refused', via: SERIES_VIA, title: input.title });
      return got;
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
  };
  return writes;
}
