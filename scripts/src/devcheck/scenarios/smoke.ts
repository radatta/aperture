// Smoke (~2 min): the signed-in app renders its main pages with no console errors, and the API answers a
// read as the test user. Writes nothing.
import type { Scenario } from '../scenario';

export const smoke: Scenario = {
  id: 'smoke',
  title: 'Signed-in app renders; API read works',
  tiers: ['smoke', 'full'],
  steps: [
    {
      id: 'home',
      title: 'Home renders',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.shot('home');
      },
    },
    {
      id: 'tasks',
      title: 'Tasks renders',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.expectText('Backlog');
        await ctx.shot('tasks');
      },
    },
    {
      id: 'settings',
      title: 'Settings renders with the build stamp',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(/^Build [0-9a-f]{7}$/);
        await ctx.shot('settings');
      },
    },
    {
      id: 'api-read',
      title: 'API read as the test user',
      async run(ctx) {
        const cats = await ctx.api.reads.listCategories();
        if (!Array.isArray(cats))
          throw new Error(`listCategories returned ${JSON.stringify(cats)}`);
        ctx.log(`listCategories → ${cats.length}`);
      },
    },
    {
      id: 'no-console-errors',
      title: 'No console errors on the way',
      async run(ctx) {
        const errors = ctx.consoleErrors();
        if (errors.length) throw new Error(`${errors.length} console error(s): ${errors[0]}`);
      },
    },
  ],
};
