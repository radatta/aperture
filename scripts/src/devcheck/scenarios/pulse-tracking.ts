// Pulse tracking over MCP on dev (docs/areas/mcp/pulse.md): the test user's Claude pulses tasks this run made and the
// server times them — a session from the first pulse, extended by the next, ended by a switch, a done, a timer
// started on its task, or a LeetCode sitting that times it. Every task, roll and sitting is ledgered from a response
// and cleaned by id. Pulse sessions are session rows, which have no delete (as timers): each run leaves its few
// completed ones in the test user's history, on tasks the cleanup deletes; the user's one pulse state row is left
// holding the slow step's session when that step ran (the next run's first pulse settles it), and empty otherwise
// (the scenario's blocked pulses clear it). Notes are synthetic text, and no step prints one. The window lapse is a
// real 15.5-min wait, so it is a slow step (deferred unless --feature names this scenario or the branch touches the
// pulse code: slowPaths).
// Order 375, after the coach scenarios: it links its own LeetCode roll for one step and unlinks it before the next.
import type { DevSittingStart } from '../api';
import { McpRpcError, PARAM_ERROR, type DevPulseResult } from '../mcp';
import { laDay, noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { devUlid } from './flux-history';

// The server's constant (packages/shared/src/pulse.ts PULSE_GRACE_MIN — scripts can't import shared).
const GRACE = 3;
const WINDOW_MIN = 15; // PULSE_WINDOW_MIN.personal — the run's tasks have no category
const WAIT_S = 20;

const fail = (msg: string): never => {
  throw new Error(msg);
};
const expect = (ok: boolean, what: string, got: unknown) => {
  if (!ok) fail(`${what}: ${JSON.stringify(got)}`);
};
// Every answer but its message (which may quote nothing private, but stays out of the report anyway).
const shown = (r: DevPulseResult) => ({ ...r, message: r.message ? '…' : undefined });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The app's day: before the day start an hour belongs to yesterday.
const appDay = async (ctx: Ctx) => {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  return laDay(new Date(Date.now() - dayStartHour * 3_600_000));
};
const expectParamError = async (what: string, call: () => Promise<unknown>) => {
  try {
    await call();
  } catch (err) {
    if (err instanceof McpRpcError && err.code === PARAM_ERROR) return;
    throw err;
  }
  fail(`${what}: expected a param error (-32602), got a result`);
};
const title = (ctx: Ctx, what: string) => `devcheck pulse ${what} ${ctx.nonce}`;
const taskOf = async (ctx: Ctx, id: string) =>
  (await ctx.mcp.reads.listTasks()).find((t) => t.id === id) ?? fail(`list_tasks has no ${id}`);
const pulseRow = async (ctx: Ctx, taskId: string) =>
  (await ctx.api.reads.listSessionsForDay(await appDay(ctx))).find(
    (s) => s.source === 'pulse' && s.taskId === taskId,
  );

// Session rows are read eventually consistent (listAllSessions): a read straight after a pulse can see the row
// before it. Retry a few times until `ok` holds.
const settledRow = async (
  ctx: Ctx,
  taskId: string,
  ok: (row: NonNullable<Awaited<ReturnType<typeof pulseRow>>>) => boolean,
) => {
  for (let i = 0; ; i++) {
    const row = await pulseRow(ctx, taskId);
    if ((row && ok(row)) || i === 4) return row;
    await sleep(1000);
  }
};

// capMin 0: a staged timer ends crediting nothing; the cleanup deletes its task beneath it.
const stopTimerOn = async (ctx: Ctx, taskId: string) => {
  const timer = (await ctx.api.reads.listRunningSessions()).find((s) => s.taskId === taskId);
  if (timer) await ctx.api.writes.stopSession(timer.id, 'completed', { capMin: 0 });
};

// What this run made, shared across steps (a scenario's steps run in order, one run at a time).
const made = { a: '', b: '', c: '', d: '', e: '', f: '', firstMin: 0 };
const slowPaths = [
  'packages/shared/src/pulse.ts',
  'lambdas/src/pulse.ts',
  'scripts/src/devcheck/scenarios/pulse-tracking.ts',
];

export const pulseTracking: Scenario = {
  id: 'pulse-tracking',
  title: 'Pulse tracking: Claude names the task each reply was for; the server times it',
  order: 375,
  tiers: ['full'],
  slowPaths,
  rows: [
    {
      id: 'tools-listed',
      entry: 'mcp',
      kind: 'nominal',
      what: 'tools/list has pulse, annotated as a write that is not destructive',
    },
    {
      id: 'start',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A pulse on a backlog task starts it (baseline frozen) and opens a session at zero',
    },
    {
      id: 'extend',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A pulse 20 s later extends the same session by the gap',
    },
    {
      id: 'repeat',
      entry: 'mcp',
      kind: 'edge',
      what: 'Two pulses back to back: one session, two more pulses, no time added',
    },
    {
      id: 'survives-reload',
      entry: 'api',
      kind: 'nominal',
      what: 'The session reads back as a completed pulse row, never as a running timer',
    },
    {
      id: 'note-max',
      entry: 'mcp',
      kind: 'edge',
      what: 'A 400-character, multi-line note is kept as one line of 140; a pulse with no note works',
    },
    {
      id: 'switch',
      entry: 'mcp',
      kind: 'nominal',
      what: 'A pulse for another task ends the current session now and opens its own',
    },
    {
      id: 'neighbour',
      entry: 'mcp',
      kind: 'edge',
      what: 'A third task is untouched: still backlog, no minutes',
    },
    {
      id: 'invalid',
      entry: 'mcp',
      kind: 'edge',
      what: 'No taskId, a non-string note, a non-boolean done or an unknown key: a param error, nothing written',
    },
    {
      id: 'unknown',
      entry: 'mcp',
      kind: 'edge',
      what: 'A task id no task has: Not found, and the open session is untouched',
    },
    {
      id: 'ownership',
      entry: 'mcp',
      kind: 'edge',
      what: "Another user's task id reads as Not found",
      offDev: {
        file: 'lambdas/src/backend.pulse.test.ts',
        test: "another user's task id is Not found, and nothing is written",
        why: "same path as unknown (proven on dev): a task is read in the caller's own partition, so another user's id is one this user has no row for; the named test pulses a real second user's task",
      },
    },
    {
      id: 'done-task',
      entry: 'mcp',
      kind: 'edge',
      what: 'A pulse on a task already finished by complete_task is refused; its actual stays',
    },
    {
      id: 'cancelled-task',
      entry: 'mcp',
      kind: 'edge',
      what: 'A pulse on a cancelled task is refused',
    },
    {
      id: 'parent',
      entry: 'mcp',
      kind: 'edge',
      what: 'A pulse on a parent is refused, naming the part to pulse; the part takes it',
    },
    {
      id: 'done',
      entry: 'mcp',
      kind: 'nominal',
      what: 'done: true on an estimated task marks it done with the tracked time plus the grace, a calibration point',
    },
    {
      id: 'done-no-estimate',
      entry: 'mcp',
      kind: 'edge',
      what: 'done: true with no estimate answers needs estimate and keeps it open; with one set, done',
    },
    {
      id: 'timer-yield',
      entry: 'api',
      kind: 'edge',
      what: 'A work timer started on the task mid-session settles the pulse session now (only the seconds that passed)',
    },
    {
      id: 'timer-same',
      entry: 'mcp',
      kind: 'edge',
      what: 'With a timer running on the task a pulse counts nothing (reason timer), and done is the app’s',
    },
    {
      id: 'sitting-rep',
      entry: 'mcp',
      kind: 'edge',
      what: 'A LeetCode sitting’s rep is sitting-timed: a pulse counts nothing (reason sitting), and done is the app’s',
    },
    {
      id: 'api-shape',
      entry: 'api',
      kind: 'edge',
      what: '/api/pulseTask with a wrong shape is refused 400 before any write',
    },
    {
      id: 'window-lapse',
      entry: 'mcp',
      kind: 'edge',
      what: 'After the window passes with no pulse, the next one opens a new session; the old one gets its whole grace',
    },
    {
      id: 'area-windows',
      entry: 'mcp',
      kind: 'edge',
      what: 'The window follows the task’s life area (recruiting 20, school 25, else 15 min)',
      offDev: {
        file: 'lambdas/src/backend.pulse.test.ts',
        test: 'reads the window from the life area of the task category',
        why: 'same path as extend (proven on dev): only the constant read differs, and telling 18 min from 15 needs the wall-clock wait',
      },
    },
    {
      id: 'race',
      entry: 'mcp',
      kind: 'edge',
      what: 'Two pulses at once: the second re-reads the state the first wrote and plans on it',
      offDev: {
        file: 'lambdas/src/backend.pulse.test.ts',
        test: 'a rival pulse landing first is re-read: this pulse plans on it (a switch), not on what it read',
        why: "dev can't force the interleave between a read and the conditional write",
      },
    },
    {
      id: 'prompt-free',
      entry: 'mcp',
      kind: 'nominal',
      what: 'claude.ai runs pulse with no per-call approval once it is set to Always allow',
      needsYou:
        'claude.ai’s approval prompt: reconnect the connector, set pulse to Always allow, and watch one thread',
    },
    {
      id: 'every-reply',
      entry: 'mcp',
      kind: 'nominal',
      what: 'In the recruiting project, Claude pulses every reply and links or asks for the task',
      needsYou: 'model behaviour in a real claude.ai project — the week’s test after merge',
    },
  ],
  steps: [
    {
      id: 'tools-listed',
      title: 'tools/list has pulse with its annotations',
      entry: 'mcp',
      proves: ['tools-listed'],
      async run(ctx) {
        const pulse = (await ctx.mcp.reads.toolSchemas()).find((t) => t.name === 'pulse');
        expect(
          pulse?.annotations?.destructiveHint === false && pulse.annotations.readOnlyHint === false,
          'pulse annotations',
          pulse?.annotations ?? null,
        );
      },
    },
    {
      id: 'start',
      title: 'A first pulse starts a backlog task and opens a session',
      entry: 'mcp',
      proves: ['start'],
      async run(ctx) {
        const mk = (what: string, estimateMin?: number) =>
          ctx.mcp.writes.createTask({ title: title(ctx, what), estimateMin });
        made.a = (await mk('A', 30)).id;
        made.b = (await mk('B', 30)).id;
        made.c = (await mk('C', 30)).id;
        const r = await ctx.mcp.writes.pulse(made.a, { note: 'devcheck outline' });
        expect(
          r.counted &&
            r.opened &&
            r.pulses === 1 &&
            r.sessionMin === 0 &&
            r.task.status === 'in_progress',
          'first pulse',
          shown(r),
        );
        const a = await taskOf(ctx, made.a);
        expect(a.estimateLockedMin === 30 && a.actualAccruedMin === 0, 'started task', a);
      },
    },
    {
      id: 'extend',
      title: `A pulse ${WAIT_S} s later extends it; two more back to back add nothing`,
      entry: 'mcp',
      proves: ['extend', 'repeat'],
      async run(ctx) {
        await sleep(WAIT_S * 1000);
        const r = await ctx.mcp.writes.pulse(made.a);
        const lo = (WAIT_S - 2) / 60;
        const hi = (WAIT_S + 15) / 60;
        expect(
          !r.opened && r.pulses === 2 && r.sessionMin >= lo - 0.05 && r.sessionMin <= hi + 0.05,
          'extend',
          shown(r),
        );
        const again = await ctx.mcp.writes.pulse(made.a);
        const third = await ctx.mcp.writes.pulse(made.a);
        expect(
          !third.opened &&
            third.pulses === 4 &&
            third.sessionMin - r.sessionMin <= 0.2 &&
            !again.opened,
          'repeat',
          { second: shown(r), fourth: shown(third) },
        );
        made.firstMin = third.sessionMin;
      },
    },
    {
      id: 'reload',
      title: 'The API reads it as a completed pulse session, not a timer',
      entry: 'api',
      proves: ['survives-reload'],
      async run(ctx) {
        const row = await settledRow(ctx, made.a, (x) => x.pulses === 4);
        expect(
          !!row && row.status === 'completed' && row.pulses === 4 && row.endedAt !== null,
          'pulse row',
          row ? { ...row, pulseNotes: undefined } : null,
        );
        const running = (await ctx.api.reads.listRunningSessions()).filter(
          (s) => s.taskId === made.a,
        );
        expect(running.length === 0, 'a running row for a pulsed task', running);
      },
    },
    {
      id: 'note-max',
      title: 'A long, multi-line note is kept as one line of 140',
      entry: 'mcp',
      proves: ['note-max'],
      async run(ctx) {
        const r = await ctx.mcp.writes.pulse(made.a, {
          note: `devcheck line one\nline two ${'x'.repeat(400)}`,
        });
        expect(r.counted && !r.opened, 'long-note pulse', shown(r));
        type Noted = { pulseNotes?: { text: string }[] };
        const notes = (
          (await settledRow(ctx, made.a, (x) => (x as Noted).pulseNotes?.length === 2)) as
            Noted | undefined
        )?.pulseNotes;
        const last = notes?.at(-1)?.text ?? '';
        // Lengths and shape only: a note's text is never printed.
        expect(
          last.length === 140 &&
            !last.includes('\n') &&
            last.startsWith('devcheck line one line two'),
          'kept note',
          {
            length: last.length,
            count: notes?.length ?? 0,
          },
        );
      },
    },
    {
      id: 'switch',
      title: 'A pulse for B ends A now; C is untouched',
      entry: 'mcp',
      proves: ['switch', 'neighbour'],
      async run(ctx) {
        const r = await ctx.mcp.writes.pulse(made.b);
        expect(r.opened && r.closed?.taskId === made.a && r.sessionMin === 0, 'switch', shown(r));
        const a = await taskOf(ctx, made.a);
        // A's session ended at this pulse: its last pulse, not its grace (WAIT_S plus the steps between).
        expect(
          Math.abs((a.actualAccruedMin ?? -1) - r.closed!.minutes) < 0.06 &&
            r.closed!.minutes < GRACE,
          'A after the switch',
          { actual: a.actualAccruedMin, closed: r.closed },
        );
        const c = await taskOf(ctx, made.c);
        expect(c.status === 'backlog' && c.actualAccruedMin === 0, 'neighbour C', c);
      },
    },
    {
      id: 'invalid',
      title: 'Bad arguments are param errors; an unknown id is Not found; B is untouched',
      entry: 'mcp',
      proves: ['invalid', 'unknown'],
      async run(ctx) {
        const before = await taskOf(ctx, made.b);
        await expectParamError('no taskId', () => ctx.mcp.writes.pulseRefused({}));
        await expectParamError('note 5', () =>
          ctx.mcp.writes.pulseRefused({ taskId: made.b, note: 5 }),
        );
        await expectParamError('done "yes"', () =>
          ctx.mcp.writes.pulseRefused({ taskId: made.b, done: 'yes' }),
        );
        await expectParamError('minutes', () =>
          ctx.mcp.writes.pulseRefused({ taskId: made.b, minutes: 10 }),
        );
        const unknown = await ctx.mcp.writes.pulseRefused({ taskId: `unknown:${ctx.nonce}` });
        expect(unknown.isError && /Not found/.test(unknown.text), 'unknown id', unknown);
        const after = await taskOf(ctx, made.b);
        expect(after.actualAccruedMin === before.actualAccruedMin, 'B after the refusals', {
          before,
          after,
        });
        const next = await ctx.mcp.writes.pulse(made.b);
        expect(!next.opened && next.pulses === 2, 'B still open after the refusals', shown(next));
      },
    },
    {
      id: 'done',
      title: 'done: true marks B done with its tracked time plus the grace, a calibration point',
      entry: 'mcp',
      proves: ['done'],
      async run(ctx) {
        const r = await ctx.mcp.writes.pulse(made.b, { done: true });
        expect(
          r.done === true && r.task.status === 'done' && r.taskActualMin >= GRACE,
          'done pulse',
          shown(r),
        );
        const b = await taskOf(ctx, made.b);
        expect(
          b.status === 'done' && Math.abs((b.actualAccruedMin ?? 0) - r.taskActualMin) < 0.06,
          'B done',
          b,
        );
        const day = await appDay(ctx);
        const points = await ctx.mcp.reads.getCalibration({ from: day, to: day });
        expect(
          points.some((p) => p.taskId === made.b),
          'a calibration point for B',
          points.length,
        );
      },
    },
    {
      id: 'done-no-estimate',
      title: 'done with no estimate needs one; set it, pulse done again',
      entry: 'mcp',
      proves: ['done-no-estimate'],
      async run(ctx) {
        made.e = (await ctx.mcp.writes.createTask({ title: title(ctx, 'E') })).id;
        await ctx.mcp.writes.pulse(made.e);
        const refused = await ctx.mcp.writes.pulse(made.e, { done: true });
        expect(
          refused.done === false && refused.needs === 'estimate' && refused.counted,
          'refused done',
          shown(refused),
        );
        expect((await taskOf(ctx, made.e)).status === 'in_progress', 'E still open', made.e);
        await ctx.mcp.writes.updateTask(made.e, { estimateMin: 15 });
        const ok = await ctx.mcp.writes.pulse(made.e, { done: true });
        expect(
          ok.done === true && !ok.opened && ok.task.status === 'done',
          'done after the estimate',
          shown(ok),
        );
      },
    },
    {
      id: 'done-task',
      title: 'A finished, a cancelled or a parent task refuses a pulse; the part takes it',
      entry: 'mcp',
      proves: ['done-task', 'cancelled-task', 'parent'],
      async run(ctx) {
        const mk = (what: string, more: { estimateMin?: number; parentId?: string } = {}) =>
          ctx.mcp.writes.createTask({ title: title(ctx, what), ...more });
        made.d = (await mk('D', { estimateMin: 10 })).id;
        await ctx.mcp.writes.completeTask(made.d, 12);
        const r = await ctx.mcp.writes.pulseRefused({ taskId: made.d });
        expect(r.isError && /already done/.test(r.text), 'pulse on a done task', r);
        const d = await taskOf(ctx, made.d);
        expect(d.actualAccruedMin === 12, 'D actual', d);

        const dropped = (await mk('dropped', { estimateMin: 10 })).id;
        await ctx.api.writes.finishTask(dropped, 'cancelled');
        const c = await ctx.mcp.writes.pulseRefused({ taskId: dropped });
        expect(c.isError && /already cancelled/.test(c.text), 'pulse on a cancelled task', c);

        const parent = (await mk('parent')).id;
        const part = (await mk('part', { estimateMin: 20, parentId: parent })).id;
        const p = await ctx.mcp.writes.pulseRefused({ taskId: parent });
        expect(p.isError && /pulse the part/.test(p.text), 'pulse on a parent', p);
        const q = await ctx.mcp.writes.pulse(part);
        expect(
          q.counted && q.opened && q.task.status === 'in_progress',
          'pulse on the part',
          shown(q),
        );
      },
    },
    {
      id: 'timer-yield',
      title: 'A timer started on F mid-session settles its pulse session now',
      entry: 'api',
      proves: ['timer-yield'],
      async run(ctx) {
        made.f = (await ctx.mcp.writes.createTask({ title: title(ctx, 'F'), estimateMin: 30 })).id;
        await ctx.mcp.writes.pulse(made.f);
        await sleep(3000);
        await ctx.api.writes.startSession(made.f, await appDay(ctx));
        try {
          const f = await ctx.api.reads.getTask(made.f);
          const got = f?.actualAccruedMin ?? -1;
          expect(
            got > 0 && got < 0.5,
            'F after the timer started (only the seconds that passed)',
            got,
          );
        } catch (err) {
          await stopTimerOn(ctx, made.f); // timer-same's finally won't run once this step fails
          throw err;
        }
      },
    },
    {
      id: 'timer-same',
      title: 'With the timer running, a pulse on F counts nothing and done is the app’s',
      entry: 'mcp',
      proves: ['timer-same'],
      async run(ctx) {
        const before = (await taskOf(ctx, made.f)).actualAccruedMin;
        try {
          const r = await ctx.mcp.writes.pulse(made.f);
          expect(
            !r.counted && r.reason === 'timer' && !r.opened && r.sessionMin === 0,
            'timed pulse',
            shown(r),
          );
          const d = await ctx.mcp.writes.pulse(made.f, { done: true });
          expect(d.done === false && d.needs === 'app', 'done under a timer', shown(d));
          expect(
            (await taskOf(ctx, made.f)).actualAccruedMin === before,
            'F actual under a timer',
            before,
          );
        } finally {
          await stopTimerOn(ctx, made.f);
        }
      },
    },
    {
      id: 'sitting-rep',
      title: 'A LeetCode sitting’s rep is sitting-timed',
      entry: 'mcp',
      proves: ['sitting-rep'],
      async run(ctx) {
        const roll = await ctx.api.writes.upsertRoll({ name: title(ctx, 'roll'), estimateMin: 45 });
        await ctx.api.writes.linkLeetcodeRoll(roll.id);
        let rep = '';
        try {
          const start: DevSittingStart = {
            clientSittingId: devUlid(),
            problemSlug: `devcheck-pulse-${ctx.nonce.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            problemTitle: title(ctx, 'problem'),
            difficulty: 'Easy',
            topicTags: ['Array'],
            lang: 'python3',
            startedAt: Date.now(),
            tzOffsetMinutes: 480,
          };
          const { sitting } = await ctx.api.writes.lcSittingStart(start);
          // A resume is another sitting's (one left open before this run): not this run's to pulse or end.
          if (sitting.id !== start.clientSittingId)
            fail(
              `the Start resumed an open sitting ${sitting.id}: one was left open before this step`,
            );
          rep = sitting.repTaskId;
          const r = await ctx.mcp.writes.pulse(rep);
          expect(!r.counted && r.reason === 'sitting' && !r.opened, 'pulse on a rep', shown(r));
          const d = await ctx.mcp.writes.pulse(rep, { done: true });
          expect(d.done === false && d.needs === 'app', 'done on a rep', shown(d));
          expect((await pulseRow(ctx, rep)) === undefined, 'a pulse row on a rep', rep);
        } finally {
          if (rep) await ctx.api.writes.finishTask(rep, 'cancelled'); // ends its sitting (abandoned)
          await ctx.api.writes.linkLeetcodeRoll(null);
        }
      },
    },
    {
      id: 'api-shape',
      title: '/api/pulseTask refuses a wrong shape 400',
      entry: 'api',
      proves: ['api-shape'],
      async run(ctx) {
        // On D, finished: a regression that took the call would still be refused, so it changes nothing.
        for (const args of [
          [{ taskId: made.d, done: 1 }],
          [{ taskId: made.d, extra: true }],
          [made.d],
        ]) {
          const got = await ctx.api.writes.rpcRaw('pulseTask', JSON.stringify({ args }), 'jwt');
          // The shape check's own refusal, not the domain's: D's "already done" is a 400 too.
          const error = (got.body as { error?: unknown } | null)?.error;
          expect(
            got.status === 400 &&
              typeof error === 'string' &&
              /must be true or false|Unknown pulse field|must be an object/.test(error) &&
              !/already done|Not found/.test(error),
            `pulseTask ${JSON.stringify(args)}`,
            got,
          );
        }
      },
    },
    {
      id: 'window-lapse',
      title: `${WINDOW_MIN} min of silence: the next pulse settles the old session with its grace and opens anew`,
      entry: 'mcp',
      proves: ['window-lapse'],
      cost: 'slow',
      async run(ctx) {
        const g = (await ctx.mcp.writes.createTask({ title: title(ctx, 'G'), estimateMin: 30 })).id;
        await ctx.mcp.writes.pulse(g);
        await sleep((WINDOW_MIN * 60 + 30) * 1000);
        const r = await ctx.mcp.writes.pulse(g);
        // One pulse, then silence: the old session is exactly its grace.
        expect(
          r.opened && r.pulses === 1 && r.closed?.taskId === g && r.closed.minutes === GRACE,
          'pulse after the window',
          shown(r),
        );
        const t = await taskOf(ctx, g);
        expect(t.actualAccruedMin === GRACE, 'G actual after the lapse', t.actualAccruedMin);
      },
    },
    noConsoleErrors,
  ],
};
