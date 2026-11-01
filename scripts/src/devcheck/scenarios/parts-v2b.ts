// Option 3 on the deployed app: a timed task is on Today on its day, by its time ("By time"), never
// planned. Tasks are made through the API (ledger-recorded, so cleanup deletes them). The test user has
// no Google account, so a timed create writes nothing to any calendar. Run before 4am LA, the app's day
// is still yesterday (dayStartHour), and "today" here would be tomorrow there — run it in the day.
import type { Ctx, Scenario } from '../scenario';

const name = (ctx: Ctx, what: string) => `devcheck ${ctx.nonce} ${what}`;

export const partsV2b: Scenario = {
  id: 'parts-v2b',
  title: 'A timed task’s day is its time',
  tiers: ['full'],
  steps: [
    {
      id: 'setup',
      title: 'A timed task and a timed part due today, a timed task later this week (API)',
      async run(ctx) {
        await ctx.api.writes.createTask({
          title: name(ctx, 'OA'),
          dueDay: ctx.dates.today,
          dueTime: '23:58',
        });
        const p = await ctx.api.writes.createTask({ title: name(ctx, 'P') });
        await ctx.api.writes.createTask({
          title: name(ctx, 'read'),
          parentId: p.id,
          dueDay: ctx.dates.today,
          dueTime: '23:57',
        });
        await ctx.api.writes.createTask({
          title: name(ctx, 'later'),
          dueDay: ctx.dates.tomorrow,
          dueTime: '10:00',
        });
      },
    },
    {
      id: 'today-by-time',
      title: 'Today shows them under “By time”, by clock, with no Unplan',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.expectText('By time', 15_000);
        await ctx.ui.expectText(name(ctx, 'OA'));
        await ctx.ui.expectText(name(ctx, 'read'));
        const all = await ctx.page.getByRole('button', { name: /devcheck .* (read|OA)$/ }).count();
        if (all < 2) throw new Error(`expected both timed rows on Today, saw ${all}`);
        await ctx.shot('today-by-time');
      },
    },
    {
      id: 'week-no-add',
      title: 'A timed task on Week offers no “+ Today”',
      async run(ctx) {
        await ctx.ui.goto('/tasks?lens=week');
        await ctx.ui.expectText(name(ctx, 'later'), 15_000);
        const add = ctx.page.getByRole('button', { name: `Add ${name(ctx, 'later')} to today` });
        if ((await add.count()) > 0) throw new Error('a timed task offered “+ Today”');
        await ctx.shot('week-no-add');
      },
    },
    {
      id: 'server-copy',
      title: 'None of them is planned',
      async run(ctx) {
        const mine = (await ctx.api.reads.listTasks()).filter((t) =>
          t.title.startsWith(`devcheck ${ctx.nonce} `),
        );
        const planned = mine.filter((t) => t.status === 'planned').map((t) => t.title);
        if (planned.length) throw new Error(`planned: ${planned.join(', ')}`);
        const errors = ctx.consoleErrors();
        if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`);
      },
    },
  ],
};
