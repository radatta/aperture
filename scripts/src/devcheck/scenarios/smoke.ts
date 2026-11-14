// Smoke (~2 min): the signed-in app renders its main pages with no console errors, and the API and MCP both
// answer a read as the test user. Writes nothing.
import { noConsoleErrors, type Scenario } from '../scenario';

export const smoke: Scenario = {
  id: 'smoke',
  title: 'Signed-in app renders; API read works',
  tiers: ['smoke', 'full'],
  // smoke proves the harness, not a feature, so it declares no rows.
  rows: [],
  steps: [
    {
      id: 'home',
      entry: 'ui',
      title: 'Home renders',
      async run(ctx) {
        await ctx.ui.goto('/');
        await ctx.shot('home');
      },
    },
    {
      id: 'tasks',
      entry: 'ui',
      title: 'Tasks renders',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.expectText('Backlog');
        await ctx.shot('tasks');
      },
    },
    {
      id: 'settings',
      entry: 'ui',
      title: 'Settings renders with the build stamp',
      async run(ctx) {
        await ctx.ui.goto('/settings');
        await ctx.ui.expectText(/^Build [0-9a-f]{7}$/);
        await ctx.shot('settings');
      },
    },
    {
      id: 'api-read',
      entry: 'api',
      title: 'API read as the test user',
      async run(ctx) {
        const cats = await ctx.api.reads.listCategories();
        if (!Array.isArray(cats))
          throw new Error(`listCategories returned ${JSON.stringify(cats)}`);
        ctx.log(`listCategories → ${cats.length}`);
      },
    },
    {
      id: 'mcp-read',
      entry: 'mcp',
      title: 'MCP read as the test user',
      // The MCP token names the same partition as the app's: both clients list the same backlog.
      async run(ctx) {
        const tools = await ctx.mcp.reads.toolsList();
        for (const name of ['delete_task', 'delete_attachment', 'create_task'])
          if (!tools.includes(name)) throw new Error(`tools/list has no ${name}`);
        const ids = (xs: { id: string }[]) =>
          xs
            .map((x) => x.id)
            .sort()
            .join();
        const [viaMcp, viaApi] = [
          await ctx.mcp.reads.listBacklog(),
          await ctx.api.reads.listBacklog(),
        ];
        if (ids(viaMcp) !== ids(viaApi))
          throw new Error(
            `MCP lists ${viaMcp.length} backlog tasks, the API ${viaApi.length} — not one partition`,
          );
        ctx.log(`mcp: ${tools.length} tools, backlog ${viaMcp.length} — same as the API`);
      },
    },
    noConsoleErrors,
  ],
};
