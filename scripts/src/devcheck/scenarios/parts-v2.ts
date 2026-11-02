// Parts v2a on the deployed app: the task modal's unsaved-changes guard across a parent and its parts,
// and Add parts' plain-words errors. The tasks are made through the API (ledger-recorded, so cleanup
// deletes them); nothing is added through the UI. The calendar half (part block titles, the due marker)
// needs a Google account the test user doesn't have — that stays a Claude-in-Chrome check.
import type { Ctx, Scenario } from '../scenario';

const parentTitle = (nonce: string) => `devcheck ${nonce} P2`;
const partTitle = (nonce: string) => `devcheck ${nonce} read`;
const confirmName = 'Discard unsaved changes?';

async function openPart(ctx: Ctx) {
  await ctx.ui.goto('/tasks');
  await ctx.page.getByRole('button', { name: 'Backlog', exact: true }).click();
  await ctx.page
    .getByRole('button', { name: partTitle(ctx.nonce), exact: true })
    .first()
    .click();
  await ctx.page
    .getByRole('dialog', { name: `Task: ${partTitle(ctx.nonce)}` })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

const dialog = (ctx: Ctx, title: string) =>
  ctx.page.getByRole('dialog', { name: `Task: ${title}` });

export const partsV2: Scenario = {
  id: 'parts-v2',
  title: 'Parts: the modal guard and Add parts errors',
  tiers: ['full'],
  rows: [
    {
      id: 'switch-guard',
      entry: 'ui',
      kind: 'edge',
      what: 'Switching to the parent with an unsaved title asks; Keep editing keeps it',
    },
    { id: 'fast-esc', entry: 'ui', kind: 'edge', what: 'Esc right after typing still asks' },
    {
      id: 'add-parts-errors',
      entry: 'ui',
      kind: 'edge',
      what: 'Add parts says what’s wrong in plain words; unsent lines ask before a section swap',
    },
    {
      id: 'calendar-titles',
      entry: 'ui',
      kind: 'nominal',
      what: 'Part block titles and the due marker on Google Calendar',
      needsYou: 'needs a Google account the test user doesn’t have',
    },
  ],
  steps: [
    {
      id: 'setup',
      entry: 'api',
      title: 'A parent with two parts (API)',
      async run(ctx) {
        const p = await ctx.api.writes.createTask({ title: parentTitle(ctx.nonce) });
        await ctx.api.writes.createTask({ title: partTitle(ctx.nonce), parentId: p.id });
        await ctx.api.writes.createTask({ title: `devcheck ${ctx.nonce} draft`, parentId: p.id });
      },
    },
    {
      id: 'switch-guard',
      entry: 'ui',
      proves: ['switch-guard'],
      title: 'Switching to the parent with an unsaved title asks; Keep editing keeps it',
      async run(ctx) {
        await openPart(ctx);
        const d = dialog(ctx, partTitle(ctx.nonce));
        await d.getByLabel('Title').fill(`${partTitle(ctx.nonce)} edited`);
        await d.getByRole('button', { name: parentTitle(ctx.nonce), exact: true }).click();
        const confirm = ctx.page.getByRole('dialog', { name: confirmName });
        await confirm.waitFor({ state: 'visible', timeout: 5_000 });
        await ctx.shot('switch-confirm');
        await confirm.getByRole('button', { name: 'Keep editing' }).click();
        const kept = await d.getByLabel('Title').inputValue();
        if (!kept.endsWith('edited')) throw new Error(`Title after Keep editing: ${kept}`);
        await d.getByRole('button', { name: parentTitle(ctx.nonce), exact: true }).click();
        await confirm.getByRole('button', { name: 'Discard' }).click();
        await dialog(ctx, parentTitle(ctx.nonce)).waitFor({ state: 'visible', timeout: 5_000 });
        await ctx.shot('parent-after-discard');
        await ctx.page.keyboard.press('Escape');
      },
    },
    {
      id: 'fast-esc',
      entry: 'ui',
      proves: ['fast-esc'],
      title: 'Esc right after typing still asks',
      async run(ctx) {
        await openPart(ctx);
        const d = dialog(ctx, partTitle(ctx.nonce));
        await d.getByLabel('Title').fill(`${partTitle(ctx.nonce)} x`);
        await ctx.page.keyboard.press('Escape');
        const confirm = ctx.page.getByRole('dialog', { name: confirmName });
        await confirm.waitFor({ state: 'visible', timeout: 5_000 });
        await confirm.getByRole('button', { name: 'Discard' }).click();
        await d.waitFor({ state: 'hidden', timeout: 5_000 });
      },
    },
    {
      id: 'add-parts-errors',
      entry: 'ui',
      proves: ['add-parts-errors'],
      title: 'Add parts says what’s wrong in plain words; unsent lines ask before a section swap',
      async run(ctx) {
        await ctx.ui.goto('/tasks');
        await ctx.page.getByRole('button', { name: 'Backlog', exact: true }).click();
        await ctx.page
          .getByRole('button', { name: parentTitle(ctx.nonce), exact: true })
          .first()
          .click();
        const d = dialog(ctx, parentTitle(ctx.nonce));
        await d.waitFor({ state: 'visible', timeout: 10_000 });
        await d.getByRole('button', { name: 'Add parts…' }).click();
        await d.getByLabel(/Add parts/).fill('x | soon');
        await ctx.ui.expectText(/“soon” isn’t something a part takes/);
        await ctx.shot('add-parts-error');
        await d.getByRole('button', { name: 'Delete task…' }).click();
        const confirm = ctx.page.getByRole('dialog', { name: confirmName });
        await confirm.waitFor({ state: 'visible', timeout: 5_000 });
        await ctx.ui.expectText(
          'What you typed hasn’t been added yet. Switching sections loses it.',
        );
        await ctx.shot('swap-confirm');
        await confirm.getByRole('button', { name: 'Keep editing' }).click();
        await d.getByRole('button', { name: 'Cancel' }).first().click();
        await ctx.page.keyboard.press('Escape');
        await d.waitFor({ state: 'hidden', timeout: 5_000 });
      },
    },
    {
      id: 'server-copy',
      entry: 'api',
      proves: ['switch-guard', 'fast-esc', 'add-parts-errors'],
      title: 'Nothing discarded reached the server',
      async run(ctx) {
        // Exact titles: the run's other scenarios share the nonce (capture-task's "devcheck <nonce>").
        const want = [
          `devcheck ${ctx.nonce} P2`,
          `devcheck ${ctx.nonce} draft`,
          `devcheck ${ctx.nonce} read`,
        ];
        const titles = (await ctx.api.reads.listTasks())
          .map((t) => t.title)
          .filter((t) => t.startsWith(`devcheck ${ctx.nonce} `))
          .sort();
        if (JSON.stringify(titles) !== JSON.stringify(want))
          throw new Error(`server has ${JSON.stringify(titles)}`);
        const errors = ctx.consoleErrors();
        if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`);
      },
    },
  ],
};
