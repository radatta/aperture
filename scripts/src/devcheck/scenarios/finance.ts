// Finances on dev, against the fixture bank (DEV-CHECK.md → One-time setup): a Plaid Sandbox `user_custom`
// login the user linked once as the test user, with fixed `DEVCHECK …` rows. The steps sort and link those
// rows through the UI and record each change before the click (ctx.api.writes.recordFinance…), so cleanup
// clears it by id; nothing here creates a row. Until the bank is linked — or once its rows have aged past
// the two periods the All tab lists (they shift once, at link) — the fixture step says needs-you and the
// rows read so, never fail (scenario.ts needsYou).
// This PR's follow-ups (task 01M65RSAXN9XW9Q7YA5Q36G8BD): Unlink with nothing else to focus lands on the
// Bucket option, bucket + "already refunded" on their own line in refund rows, two fields at 16px.
import { PHONE } from '../browser';
import { needsYou, noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { clearTimers } from './failed-reads';

// The fixture's rows, by the start of their bank text (localNotes/plaid-fixture.json in the branch that
// built it; the JSON is pasted into Link, never synced from the repo).
const REBATE = /devcheck rebate/i; // a card credit no charge fits: no suggestions
const BOOKS_CHARGE = /devcheck books/i; // a card charge the search can link the rebate to
const GROCER = /devcheck grocer/i; // a long merchant, for the row's truncation
const DINNER = /devcheck dinner/i; // a checking debit…
const PAYBACK = /devcheck payback/i; // …and the deposit that reverses it: money in with one suggestion
const FIXTURE_HELP =
  'link the Plaid Sandbox fixture as the devcheck test user (docs/ops/DEV-CHECK.md → One-time setup 3)';

const allTab = async (ctx: Ctx, search: string) => {
  await ctx.ui.goto('/finances/all');
  const box = ctx.page.getByRole('searchbox', { name: 'Search transactions' });
  await box.waitFor({ timeout: 15_000 });
  await box.fill(search);
};
// Opens a row's detail from the All tab, searched down to it.
async function openRow(ctx: Ctx, name: RegExp, title: RegExp) {
  await allTab(ctx, name.source.replace(/\\/g, ''));
  const row = ctx.page.getByRole('button', { name }).first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  const dialog = ctx.page.getByRole('dialog', { name: title });
  await dialog.waitFor({ timeout: 10_000 });
  return dialog;
}
// Escape clears a search box that has text before it closes the detail (LedgerControls' SearchBox), so a
// second press may be needed.
const closeDetail = async (ctx: Ctx) => {
  const dialog = ctx.page.getByRole('dialog');
  for (let i = 0; i < 2 && (await dialog.isVisible()); i++) {
    await ctx.page.keyboard.press('Escape');
    await wait(300);
  }
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
};
const focusedText = (ctx: Ctx) =>
  ctx.page.evaluate<string>(
    '(document.activeElement && document.activeElement !== document.body) ? (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent || document.activeElement.tagName) : "<body>"',
  );
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The computed font-size of the one element a CSS selector names, in px.
const fontSizeOf = (ctx: Ctx, selector: string) =>
  ctx.page.evaluate<number>(
    `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).fontSize)`,
  );

// The fixture's rows on the server, by bank text; `fixtureRow` throws needs-you when one is missing.
async function fixtureRows(ctx: Ctx) {
  const rows = await ctx.api.reads.listFinanceTransactions({
    from: '2000-01-01',
    to: '2100-01-01',
  });
  const find = (re: RegExp) => rows.find((t) => re.test(t.name) || re.test(t.merchantName ?? ''));
  return { rows, find };
}

export const finance: Scenario = {
  id: 'finance',
  title: 'Refund link follow-ups: Unlink focus, row layout, 16px fields',
  tiers: ['full'],
  rows: [
    {
      id: 'unlink-focus',
      entry: 'ui',
      kind: 'nominal',
      what: 'A card credit with no suggestions: link by search, Unlink → focus on the checked Bucket option, a key sorts it, survives reload',
    },
    {
      id: 'money-in-unlink',
      entry: 'ui',
      kind: 'edge',
      what: 'Money in: link, Unlink still focuses a Link row (neighbour unaffected); Esc closes the detail',
    },
    {
      id: 'row-layout',
      entry: 'ui',
      kind: 'nominal',
      what: 'A refund-search row: merchant on its line, bucket under it, amount and Link readable at phone width',
    },
    {
      id: 'field-size',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Rules bucket select and the pomodoro New focus input render at 16px or more',
    },
    {
      id: 'iphone-zoom',
      entry: 'ios',
      kind: 'edge',
      what: 'Tapping the Rules bucket select or the New focus input doesn’t zoom iOS Safari; a real card credit opens on Bucket with no keyboard flash',
      needsYou: 'only iOS Safari zooms — headless Chromium never does',
    },
    {
      id: 'guard',
      entry: 'ui',
      kind: 'edge',
      what: 'No app input, select or textarea carries text-sm / text-xs',
      offDev: {
        file: 'app/src/styles/fieldSize.test.ts',
        test: 'no field under 16px',
        why: 'a source scan: dev can’t produce a future field under 16px, and Chromium never zooms',
      },
    },
    {
      id: 'unlink-focus-jsdom',
      entry: 'ui',
      kind: 'edge',
      what: 'The no-suggestions Unlink path, with a refund too big for any charge (fails without the Segmented ref)',
      offDev: {
        file: 'app/src/pages/Finances/Finances.test.tsx',
        test: 'Unlink on a card credit with no suggestions focuses Bucket',
        why: 'same path as unlink-focus (proven on dev): the same RefundSuggestions → Segmented hand-off, on a stub row sized past every charge',
      },
    },
    {
      id: 'fixture-aged',
      entry: 'ui',
      kind: 'edge',
      what: 'The fixture bank missing or aged out reports needs-you for these rows, never a fail',
      offDev: {
        file: 'scripts/src/devcheck/pipeline.test.ts',
        test: 'a step that says needs-you leaves the run green: it and the rest of its scenario read needs-you, the rows too',
        why: 'dev can’t unlink the fixture on demand; the pipeline’s own test drives the needs-you path',
      },
    },
  ],
  steps: [
    {
      id: 'fixture',
      entry: 'ui', // reads the server, then looks for the rows on the All tab
      title: 'The fixture bank is linked and its rows are on the All tab',
      async run(ctx) {
        const { rows, find } = await fixtureRows(ctx);
        if (!rows.some((t) => /^devcheck/i.test(t.name)))
          needsYou(`no fixture bank: ${FIXTURE_HELP}`);
        for (const re of [REBATE, BOOKS_CHARGE, GROCER, DINNER, PAYBACK])
          if (!find(re)) needsYou(`fixture row ${re.source} is missing: re${FIXTURE_HELP}`);
        // On screen too: the All tab lists this period and last, and the rows stand still after the link.
        await allTab(ctx, 'devcheck rebate');
        const row = ctx.page.getByRole('button', { name: REBATE }).first();
        if (
          !(await row.waitFor({ timeout: 15_000 }).then(
            () => true,
            () => false,
          ))
        )
          needsYou(
            `the fixture's rows have aged past the two periods the All tab lists: re${FIXTURE_HELP}`,
          );
      },
    },
    {
      id: 'unlink-focus',
      entry: 'ui',
      proves: ['unlink-focus'],
      title:
        'Rebate → search “devcheck books” → Link → Unlink → Bucket focused → ArrowRight sorts → reload',
      async run(ctx) {
        const { find } = await fixtureRows(ctx);
        const rebate = find(REBATE)!;
        let dialog = await openRow(ctx, REBATE, /^Refund: /);
        await dialog.getByText(/No likely charge found/).waitFor({ timeout: 10_000 });
        ctx.api.writes.recordFinanceLink(rebate.id); // before the click: cleanup unlinks by id
        await dialog
          .getByRole('searchbox', { name: 'Search charges to link' })
          .fill('devcheck books');
        await dialog
          .getByRole('button', { name: /^Link to .*devcheck books/i })
          .first()
          .click();
        await dialog.getByText(/it follows the charge/).waitFor({ timeout: 10_000 });
        ctx.api.writes.recordFinanceBucket(rebate.id); // the ArrowRight below sorts it
        await dialog.getByRole('button', { name: 'Unlink' }).click();
        const unsorted = dialog
          .getByRole('radiogroup', { name: 'Bucket' })
          .getByRole('radio', { name: 'Unsorted' });
        await unsorted.waitFor({ timeout: 10_000 });
        await wait(300); // the hand-off runs after the suggestions mount
        const focused = await focusedText(ctx);
        if (focused !== 'Unsorted') throw new Error(`after Unlink, focus is on "${focused}"`);
        await ctx.shot('unlink-focus');
        await ctx.page.keyboard.press('ArrowRight'); // the group wraps to the first bucket
        for (let i = 0; ; i++) {
          const t = await ctx.api.reads.getFinanceTransaction(rebate.id);
          if (t?.bucket) break;
          if (i >= 40) throw new Error('ArrowRight never sorted it on the server');
          await wait(250);
        }
        await closeDetail(ctx);
        await ctx.page.reload();
        dialog = await openRow(ctx, REBATE, /^Refund: /);
        const checked = dialog
          .getByRole('radiogroup', { name: 'Bucket' })
          .getByRole('radio', { checked: true });
        const label = await checked.textContent();
        if (!label || label === 'Unsorted')
          throw new Error(`after reload the bucket reads "${label}"`);
        await closeDetail(ctx);
      },
    },
    {
      id: 'money-in',
      entry: 'ui',
      proves: ['money-in-unlink'],
      title: 'Payback → Link as a refund → Link → Unlink keeps focus on a Link row → Esc closes',
      async run(ctx) {
        const { find } = await fixtureRows(ctx);
        const payback = find(PAYBACK)!;
        const dialog = await openRow(ctx, PAYBACK, /^Money in: /);
        await dialog.getByRole('button', { name: 'Link as a refund' }).click();
        ctx.api.writes.recordFinanceLink(payback.id);
        const link = dialog.getByRole('button', { name: /^Link to .*devcheck dinner/i }).first();
        await link.waitFor({ timeout: 10_000 });
        await link.click();
        await dialog.getByText(/it follows the charge/).waitFor({ timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Unlink' }).click();
        await dialog
          .getByRole('button', { name: /^Link to /i })
          .first()
          .waitFor({ timeout: 10_000 });
        await wait(300);
        const focused = await focusedText(ctx);
        if (!/^Link to /.test(focused)) throw new Error(`after Unlink, focus is on "${focused}"`);
        await ctx.shot('money-in-unlink');
        await closeDetail(ctx);
      },
    },
    {
      id: 'row-layout',
      entry: 'ui',
      proves: ['row-layout'],
      title: 'Rebate → search “devcheck grocer”: merchant line, bucket line, amount + Link in view',
      async run(ctx) {
        const dialog = await openRow(ctx, REBATE, /^Refund: /);
        await dialog
          .getByRole('searchbox', { name: 'Search charges to link' })
          .fill('devcheck grocer');
        const link = dialog.getByRole('button', { name: /^Link to .*devcheck grocer/i }).first();
        await link.waitFor({ timeout: 10_000 });
        const row = link.locator('xpath=ancestor::li[1]');
        const merchant = await row.getByText(GROCER).first().boundingBox();
        const bucket = await row
          .getByText(/^(Unsorted|Budget|I pay|Parents pay|Not spending)/)
          .first()
          .boundingBox();
        const button = await link.boundingBox();
        const width = PHONE.width;
        if (!merchant || !bucket || !button) throw new Error('row parts not laid out');
        if (bucket.y < merchant.y + merchant.height - 1)
          throw new Error(`the bucket sits beside the merchant (y ${bucket.y} vs ${merchant.y})`);
        if (button.x + button.width > width + 1) throw new Error('Link is off the right edge');
        await ctx.shot('row-layout');
        await closeDetail(ctx);
      },
    },
    {
      id: 'field-size',
      entry: 'ui',
      proves: ['field-size'],
      title: 'Rules bucket select and New focus input: computed font-size ≥ 16px',
      async run(ctx) {
        const rule = await ctx.api.writes.upsertFinanceRule({
          pattern: `devcheck-${ctx.nonce}`,
          bucket: 'budget',
        });
        await ctx.ui.goto('/finances/rules');
        const select = ctx.page.getByRole('combobox', { name: `Bucket for ${rule.pattern}` });
        await select.waitFor({ timeout: 15_000 });
        const selectPx = await fontSizeOf(ctx, `select[aria-label="Bucket for ${rule.pattern}"]`);
        if (selectPx < 16) throw new Error(`the rule’s bucket select is ${selectPx}px`);
        // The New focus row lives in the running timer's bar: start a focus from the dock's idle Focus
        // (a leftover one cleared first, as failed-reads does), open the row, measure, Cancel it, Stop the
        // timer. Like failed-reads, this leaves a seconds-long completed session in the test user's history.
        await clearTimers(ctx);
        await ctx.page.getByRole('button', { name: 'Focus', exact: true }).first().click();
        const open = ctx.page.getByRole('button', { name: '+ New focus', exact: true });
        await open.waitFor({ timeout: 15_000 });
        await open.click();
        const input = ctx.page.getByLabel('New focus label');
        await input.waitFor({ timeout: 10_000 });
        const inputPx = await fontSizeOf(ctx, 'input[aria-label="New focus label"]');
        if (inputPx < 16) throw new Error(`the New focus input is ${inputPx}px`);
        await ctx.shot('field-size');
        await ctx.page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
        await ctx.page.getByRole('button', { name: 'Stop', exact: true }).first().click();
        for (let i = 0; (await ctx.api.reads.listRunningSessions()).length; i++) {
          if (i >= 40) throw new Error('the focus timer never stopped on the server');
          await wait(250);
        }
      },
    },
    noConsoleErrors,
  ],
};
