// Capture a task through the bar and prove it landed: receipt, Backlog, and the server's copy. The line is a
// grammar line (space, pipe, space) so it never reaches the model — no Haiku spend, deterministic fields.
import type { Scenario } from '../scenario';

const title = (nonce: string) => `devcheck ${nonce}`;

export const captureTask: Scenario = {
  id: 'capture-task',
  title: 'Capture a task from the bar',
  tiers: ['full'],
  steps: [
    {
      id: 'capture',
      title: 'Task mode, grammar line, Enter → "Task added"',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.ui.captureTask(`${title(ctx.nonce)} | ~15`);
        await ctx.shot('receipt');
      },
    },
    {
      id: 'in-backlog',
      title: 'It shows in the Backlog',
      async run(ctx) {
        await ctx.page.getByRole('button', { name: 'Backlog', exact: true }).click();
        await ctx.ui.expectText(title(ctx.nonce), 15_000);
        await ctx.shot('backlog');
      },
    },
    {
      id: 'server-copy',
      title: 'The server has it: title and 15 min',
      async run(ctx) {
        const id = ctx.createdIds().at(-1);
        if (!id) throw new Error('the create response never reached the ledger');
        const task = await ctx.api.reads.getTask(id);
        if (task?.title !== title(ctx.nonce) || task.estimateMin !== 15)
          throw new Error(`server has ${JSON.stringify(task)}`);
      },
    },
  ],
};
