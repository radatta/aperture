// The day-plan server guards on the deployed BFF: one plan row per (task, day) (an id-less insert
// returns the existing row), getDay refuses a day after the user's app day (400) and a malformed one,
// the stale sweep's bounded range read (the live proof of the BETWEEN expression), and a habit uncheck
// that tombstones. Tasks and the habit come from the API (ledger-recorded); the habit is ARCHIVED at
// cleanup, not deleted — the API has no habit delete — so one archived habit per run stays on the test
// user (DEV-CHECK.md → habit kind). "Today" is the app's day: before 4am LA the app is still on yesterday.
import type { DevHabit, DevPlan, DevTask } from '../api';
import { datesFor, noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck ${ctx.nonce} ${what}`;
const OFF_DEV =
  'dev’s DynamoDB never lags or mis-ranges on demand; the shape is modelled on the in-memory doc';

// Scenario-scoped, set by the API steps (an API create is never in createdIds — that's the browser's).
const made: Record<string, DevTask> = {};
let habit: DevHabit | undefined;

async function days(ctx: Ctx) {
  const { dayStartHour } = await ctx.api.reads.getSettings();
  const { today, tomorrow } = datesFor(new Date(Date.now() - dayStartHour * 3_600_000));
  const yesterday = datesFor(new Date(Date.now() - (dayStartHour + 24) * 3_600_000)).today;
  return { today, tomorrow, yesterday };
}
const rowsOf = async (ctx: Ctx, day: string, task: DevTask) =>
  (await ctx.api.reads.listPlansForDay(day)).filter((p) => p.taskId === task.id);
const statusOf = async (ctx: Ctx, task: DevTask) => (await ctx.api.reads.getTask(task.id))?.status;

export const dayGuards: Scenario = {
  id: 'day-guards',
  title: 'Day-plan server guards',
  tiers: ['full'],
  rows: [
    {
      id: 'dedupe-api',
      entry: 'api',
      kind: 'nominal',
      what: 'Two id-less inserts for one task today → one row, both calls return its id',
    },
    {
      id: 'dedupe-edit',
      entry: 'api',
      kind: 'edge',
      what: 'Insert with id + 45 min → one row at 45; a neighbour task’s row untouched',
    },
    {
      id: 'dedupe-readd',
      entry: 'api',
      kind: 'edge',
      what: 'Remove, insert again → one new alive row',
    },
    {
      id: 'dedupe-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'Backlog lens, “+ Today” twice fast → Today shows it once; reload → once',
    },
    {
      id: 'dedupe-lag',
      entry: 'api',
      kind: 'edge',
      what: 'A second insert straight after the first sees the row though the plain list lags',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'a second insert straight after the first sees the row though the plain list lags',
        why: OFF_DEV,
      },
    },
    {
      id: 'future-refused',
      entry: 'api',
      kind: 'edge',
      what: 'getDay(tomorrow) → 400 “future”; a task planned today stays planned, its row intact',
    },
    {
      id: 'today-ok',
      entry: 'api',
      kind: 'nominal',
      what: 'getDay(today) → 200; a planned task with no rows → backlog',
    },
    {
      id: 'invalid-day',
      entry: 'api',
      kind: 'edge',
      what: 'getDay(“2026-13-01”) → 400 Invalid day',
    },
    {
      id: 'past-ok',
      entry: 'api',
      kind: 'edge',
      what: 'A past day is still allowed (getDay(yesterday) → 200)',
    },
    {
      id: 'sweep-yesterday',
      entry: 'api',
      kind: 'nominal',
      what: 'A row yesterday only, task planned → getDay(today) → backlog; one planned today stays',
    },
    {
      id: 'sweep-later',
      entry: 'api',
      kind: 'edge',
      what: 'Rows yesterday and tomorrow → stays planned',
    },
    { id: 'sweep-removed', entry: 'api', kind: 'edge', what: 'Today’s row removed → swept' },
    {
      id: 'sweep-shape',
      entry: 'api',
      kind: 'edge',
      what: 'The sweep reads only plan rows dated today or later',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'the sweep reads only plan rows dated today or later, consistently',
        why: OFF_DEV,
      },
    },
    {
      id: 'habit-ui',
      entry: 'ui',
      kind: 'nominal',
      what: 'Habits: tap → checked; tap → unchecked; reload → unchecked; tap → checked again',
    },
    {
      id: 'habit-twice',
      entry: 'api',
      kind: 'edge',
      what: 'uncheckHabit twice, and on a never-checked date → no error, no row',
    },
    {
      id: 'habit-neighbour',
      entry: 'api',
      kind: 'edge',
      what: 'Unchecking day D leaves D−1’s check for the same habit',
    },
    {
      id: 'habit-tombstone',
      entry: 'api',
      kind: 'edge',
      what: 'The row survives as a tombstone; a re-check is a fresh alive row',
      offDev: {
        file: 'lambdas/src/backend.test.ts',
        test: 'uncheck keeps the row as a tombstone — gone from every list, kept in the table; a re-check is a fresh alive row',
        why: 'no API method can tell a tombstone from a delete (TECH.md → Hard-deletes)',
      },
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title:
        'Tasks for each case (API): dedupe A + neighbour N, backlog G, sweep B/C/D, planned E/F',
      async run(ctx) {
        const { today, tomorrow, yesterday } = await days(ctx);
        for (const what of ['A', 'N', 'G', 'B', 'C', 'D', 'E', 'F'])
          made[what] = await ctx.api.writes.createTask({ title: name(ctx, what), estimateMin: 15 });
        const plan = (what: string, day: string, order = 0) =>
          ctx.api.writes.upsertPlan({ taskId: made[what]!.id, day, plannedMinutes: 15, order });
        await plan('B', yesterday);
        await plan('C', yesterday);
        await plan('C', tomorrow);
        const d = await plan('D', today, 5);
        await plan('F', today, 6);
        for (const what of ['B', 'C', 'D', 'E', 'F'])
          await ctx.api.writes.transitionTask(made[what]!.id, 'planned');
        await ctx.api.writes.removePlan(d); // D: unplanned, still "planned" until the sweep
      },
    },
    {
      id: 'dedupe-api',
      entry: 'api',
      proves: ['dedupe-api', 'dedupe-edit', 'dedupe-readd'],
      title: 'upsertPlan twice → one row; an id write edits it; remove then insert → a new row',
      async run(ctx) {
        const { today } = await days(ctx);
        const row = { taskId: made.A!.id, day: today, plannedMinutes: 15, order: 1 };
        const first = await ctx.api.writes.upsertPlan(row);
        const again = await ctx.api.writes.upsertPlan({ ...row, plannedMinutes: 60, order: 3 });
        if (again.id !== first.id || again.plannedMinutes !== 15)
          throw new Error(`second insert: ${JSON.stringify(again)}`);
        const n = await ctx.api.writes.upsertPlan({ ...row, taskId: made.N!.id, order: 2 });
        const one = async (task: DevTask, min: number): Promise<DevPlan> => {
          const rows = await rowsOf(ctx, today, task);
          if (rows.length !== 1 || rows[0]!.plannedMinutes !== min)
            throw new Error(`${task.title}: ${JSON.stringify(rows)}`);
          return rows[0]!;
        };
        await one(made.A!, 15);
        const edited = await ctx.api.writes.upsertPlan({
          ...row,
          id: first.id,
          plannedMinutes: 45,
        });
        if (edited.id !== first.id) throw new Error('an id write minted a row');
        await one(made.A!, 45);
        const neighbour = await one(made.N!, 15);
        if (neighbour.id !== n.id || neighbour.order !== 2) throw new Error('the neighbour moved');
        await ctx.api.writes.removePlan(edited);
        const readded = await ctx.api.writes.upsertPlan(row);
        if (readded.id === first.id) throw new Error('re-add returned the removed row');
        await one(made.A!, 15);
      },
    },
    {
      id: 'dedupe-ui',
      entry: 'ui',
      proves: ['dedupe-ui'],
      title: 'Backlog: “+ Today” twice fast on G; Today shows it once, and after a reload',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=backlog');
        const add = ctx.page.getByRole('button', { name: `Add ${name(ctx, 'G')} to today` });
        await add.waitFor({ state: 'visible', timeout: 15_000 });
        await add.click();
        await add.click({ timeout: 1_500 }).catch(() => undefined); // gone or disabled once the first lands: fine
        await ctx.ui.goto('/tasks');
        await ctx.ui.expectText(name(ctx, 'G'), 15_000);
        const count = () => ctx.page.getByText(name(ctx, 'G'), { exact: true }).count();
        if ((await count()) !== 1) throw new Error(`Today shows G ${await count()} times`);
        await ctx.page.reload();
        await ctx.ui.expectText(name(ctx, 'G'), 15_000);
        if ((await count()) !== 1)
          throw new Error(`after reload Today shows G ${await count()} times`);
        await ctx.shot('dedupe-today');
      },
    },
    {
      id: 'dedupe-ui-server',
      entry: 'api',
      proves: ['dedupe-ui'],
      title: 'G has one plan row today',
      async run(ctx) {
        const { today } = await days(ctx);
        const rows = await rowsOf(ctx, today, made.G!);
        if (rows.length !== 1) throw new Error(`G rows: ${JSON.stringify(rows)}`);
      },
    },
    {
      id: 'future-refused',
      entry: 'api',
      proves: ['future-refused', 'invalid-day'],
      title: 'getDay(tomorrow) and getDay(“2026-13-01”) → 400; F still planned with its row',
      async run(ctx) {
        const { today, tomorrow } = await days(ctx);
        const refused = async (day: string, words: RegExp) => {
          try {
            await ctx.api.reads.getDay(day);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/HTTP 400/.test(msg) || !words.test(msg))
              throw new Error(`getDay(${day}): ${msg}`, { cause: err });
            return;
          }
          throw new Error(`getDay(${day}) was served`);
        };
        await refused(tomorrow, /future day/);
        await refused('2026-13-01', /Invalid day/);
        if ((await statusOf(ctx, made.F!)) !== 'planned')
          throw new Error('F was swept by a refused call');
        if ((await rowsOf(ctx, today, made.F!)).length !== 1) throw new Error('F lost its row');
      },
    },
    {
      id: 'sweep',
      entry: 'api',
      proves: ['past-ok', 'today-ok', 'sweep-yesterday', 'sweep-later', 'sweep-removed'],
      title:
        'getDay(yesterday) → 200 (past days allowed); getDay(today) → 200; E (no rows), B (yesterday only), D (row removed) → backlog; C (tomorrow) and F (today) stay planned',
      async run(ctx) {
        const { today, yesterday } = await days(ctx);
        const day = await ctx.api.reads.getDay(today);
        if (day.date !== today) throw new Error(`getDay returned ${JSON.stringify(day)}`);
        const want: Record<string, string> = {
          E: 'backlog',
          B: 'backlog',
          D: 'backlog',
          C: 'planned',
          F: 'planned',
          A: 'backlog',
        };
        const got: Record<string, string | undefined> = {};
        for (const what of Object.keys(want)) got[what] = await statusOf(ctx, made[what]!);
        const wrong = Object.keys(want).filter((w) => got[w] !== want[w]);
        if (wrong.length) throw new Error(`after the sweep: ${JSON.stringify(got)}`);
        // Then a past day: served (its sweep, relative to yesterday, moves nothing today's didn't).
        if ((await ctx.api.reads.getDay(yesterday)).date !== yesterday)
          throw new Error('yesterday was refused');
      },
    },
    {
      id: 'habit-setup',
      entry: 'api',
      title: 'A habit (API, ledgered; archived at cleanup)',
      async run(ctx) {
        habit = await ctx.api.writes.upsertHabit({
          name: name(ctx, 'habit'),
          categoryId: null,
          cadencePerWeek: 3,
        });
      },
    },
    {
      id: 'habit-ui',
      entry: 'ui',
      proves: ['habit-ui'],
      title: 'Habits: tap → checked, tap → unchecked, reload → unchecked, tap → checked',
      async run(ctx) {
        await ctx.ui.goto('/habits');
        // The page is a 4-week grid, one button per (habit, day) named "<habit> on <day>"; future days
        // are disabled, so today's cell is the last enabled one in document order.
        const button = () =>
          ctx.page
            .getByRole('button', {
              name: new RegExp(`^${name(ctx, 'habit')} on `),
              disabled: false,
            })
            .last();
        const pressed = async (want: string) => {
          for (let i = 0; (await button().getAttribute('aria-pressed')) !== want; i++) {
            if (i > 40)
              throw new Error(
                `aria-pressed is ${await button().getAttribute('aria-pressed')}, wanted ${want}`,
              );
            await new Promise((r) => setTimeout(r, 250));
          }
        };
        await button().waitFor({ state: 'visible', timeout: 15_000 });
        await pressed('false');
        await button().click();
        await pressed('true');
        await button().click();
        await pressed('false');
        await ctx.page.reload();
        await button().waitFor({ state: 'visible', timeout: 15_000 });
        await pressed('false');
        await button().click();
        await pressed('true');
        await ctx.shot('habit-checked');
      },
    },
    {
      id: 'habit-api',
      entry: 'api',
      proves: ['habit-ui', 'habit-twice', 'habit-neighbour'],
      title:
        'Today’s check is on the server; uncheck twice + a never-checked date are no-ops; yesterday’s check stays',
      async run(ctx) {
        const { today, yesterday } = await days(ctx);
        const checks = async () =>
          (await ctx.api.reads.listHabitChecks({ from: yesterday, to: today })).filter(
            (c) => c.habitId === habit!.id,
          );
        if ((await checks()).map((c) => c.date).join() !== today)
          throw new Error(`checks: ${JSON.stringify(await checks())}`);
        await ctx.api.writes.checkHabit(habit!.id, yesterday);
        await ctx.api.writes.uncheckHabit(habit!.id, today);
        await ctx.api.writes.uncheckHabit(habit!.id, today);
        await ctx.api.writes.uncheckHabit(habit!.id, '2026-01-01');
        const left = (await checks()).map((c) => c.date);
        if (left.join() !== yesterday) throw new Error(`after the unchecks: ${left.join(', ')}`);
        await ctx.api.writes.uncheckHabit(habit!.id, yesterday); // leave only tombstones behind the archive
        if ((await checks()).length) throw new Error('yesterday’s check did not uncheck');
      },
    },
    noConsoleErrors,
  ],
};
