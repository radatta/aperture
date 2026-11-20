// A charge split across buckets (with part periods), a refund across charges, and percent split rules — on
// the fixture bank (finance.ts's rows and gate). Every change is recorded before the click or call that makes
// it, so cleanup clears it by id: a split by `finance-split:<run>:<row>` (setFinanceSplit null), an allocation by
// the row's `finance-link` (linkFinanceRefund null clears it too), a rule by its id. Nothing here creates a row.
import { needsYou, noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import {
  FIXTURE_HELP,
  allTab,
  closeDetail,
  fixtureRows,
  focusedText,
  fontSizeOf,
  openRow,
  wait,
} from './finance';

const GROCER = /devcheck grocer/i; // the $42.17 card charge that gets split
const COFFEE = /devcheck coffee #2/i; // a $6.50 card charge, before the payback
const DINNER = /devcheck dinner/i; // the $30.00 checking debit…
const PAYBACK = /devcheck payback/i; // …and the $30.00 deposit, allocated across charges
const SPEND = ['parents_pay', 'budget', 'i_pay'] as const;

const fail = (msg: string): never => {
  throw new Error(msg);
};
// The fixture rows by bank text — needs-you when one is missing (the gate step says why).
async function rows(ctx: Ctx) {
  const { find } = await fixtureRows(ctx);
  const get = (re: RegExp) =>
    find(re) ?? needsYou(`fixture row ${re.source} is missing: re${FIXTURE_HELP}`);
  return { grocer: get(GROCER), coffee: get(COFFEE), dinner: get(DINNER), payback: get(PAYBACK) };
}
// Polls the server until `ok` holds for the row (the browser's write may still be in flight).
async function until(
  ctx: Ctx,
  id: string,
  ok: (t: Awaited<ReturnType<Ctx['api']['reads']['getFinanceTransaction']>>) => boolean,
  what: string,
) {
  for (let i = 0; ; i++) {
    if (ok(await ctx.api.reads.getFinanceTransaction(id))) return;
    if (i >= 40) fail(`${what} never landed on the server`);
    await wait(250);
  }
}
const totals = async (ctx: Ctx) => {
  const o = await ctx.api.reads.getFinanceOverview(ctx.dates.today);
  return {
    o,
    bucket: Object.fromEntries(SPEND.map((b) => [b, o.buckets[b].totalCents])) as Record<
      (typeof SPEND)[number],
      number
    >,
    upcoming: o.upcoming?.totalCents ?? fail('the overview has no upcoming (an old server?)'),
  };
};
// Which of the overview's windows a date falls in.
const windowOf = (o: Awaited<ReturnType<typeof totals>>['o'], date: string) =>
  date >= o.period.start && date <= o.period.end
    ? 'current'
    : date >= o.period.previous.start && date <= o.period.previous.end
      ? 'previous'
      : 'outside';

// What the split steps compare against: the totals before the grocer was split.
let before: Awaited<ReturnType<typeof totals>> | null = null;

export const financeSplits: Scenario = {
  id: 'finance-splits',
  title: 'Splits across buckets, refunds across charges, split rules',
  tiers: ['full'],
  order: 275, // just after finance (270): the same fixture rows, which finance leaves as it found them
  rows: [
    {
      id: 'split-two-buckets',
      entry: 'ui',
      kind: 'nominal',
      what: 'Split the grocer charge across Budget and Covered, both This period: the row lists both parts, survives reload; the neighbour coffee row is unchanged',
    },
    {
      id: 'split-totals-api',
      entry: 'api',
      kind: 'nominal',
      what: 'The overview’s Budget and Covered totals move by exactly each part',
    },
    {
      id: 'split-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The MCP row has split: true, bucket null and parts with periods; the overview buckets include the parts; an unsplit row has no parts',
    },
    {
      id: 'split-refused',
      entry: 'ui',
      kind: 'edge',
      what: 'Parts that don’t add up: Save shows the named reason, the input stays, nothing is written',
    },
    {
      id: 'split-refused-api',
      entry: 'api',
      kind: 'edge',
      what: 'One part, parts not adding up, an unknown bucket, a deposit, an unknown id: each refused with its reason, the row unchanged',
    },
    {
      id: 'split-cancel-repeat',
      entry: 'ui',
      kind: 'edge',
      what: 'Cancel leaves the split as it was; saving it unchanged is a no-op; Remove split returns the row to Unsorted with focus on Bucket',
    },
    {
      id: 'split-next-period',
      entry: 'ui',
      kind: 'nominal',
      what: 'A part set to Next period is labelled so in the list and the header says what waits',
    },
    {
      id: 'split-next-period-api',
      entry: 'api',
      kind: 'nominal',
      what: 'A Next part on a this-period charge waits in upcoming, out of its bucket; on a last-period charge it counts now',
    },
    {
      id: 'split-next-lands',
      entry: 'api',
      kind: 'edge',
      what: 'Marking a later payment moves the waiting part into the current totals',
      offDev: {
        file: 'packages/shared/src/financeSplits.test.ts',
        test: 'a next-period part waits in upcoming, then lands when a new payment is marked',
        why: 'moving the test user’s period boundary changes what every other finance row asserts in the same run',
      },
    },
    {
      id: 'split-brush-sort',
      entry: 'ui',
      kind: 'edge',
      what: 'With the brush armed, a split row is inert',
    },
    {
      id: 'split-sort-refused-api',
      entry: 'api',
      kind: 'edge',
      what: 'setFinanceBucket on a split row is refused, naming the split',
    },
    {
      id: 'split-amount-change',
      entry: 'ui',
      kind: 'edge',
      what: 'A split posted at a new amount asks again in Sort, saying why',
      offDev: {
        file: 'app/src/pages/Finances/FinanceSplits.test.tsx',
        test: 'a split posted at a new amount asks again in Sort, saying why',
        why: 'the fixture bank never re-posts a row at a new amount',
      },
    },
    {
      id: 'refund-two-charges',
      entry: 'ui',
      kind: 'nominal',
      what: 'The payback deposit linked across the grocer and coffee charges by search; the detail lists both; it survives reload',
    },
    {
      id: 'refund-two-charges-api',
      entry: 'api',
      kind: 'nominal',
      what: 'The deposit’s refundParts hold both charges and sum to the deposit',
    },
    {
      id: 'refund-two-charges-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The MCP lists the deposit’s refundParts; the coffee charge reads fully refunded',
    },
    {
      id: 'refund-over',
      entry: 'ui',
      kind: 'edge',
      what: 'An amount above what’s left of a charge: refused with the reason, the amounts kept',
    },
    {
      id: 'refund-over-api',
      entry: 'api',
      kind: 'edge',
      what: 'Over a charge’s remaining, and a sum over the refund: each refused with its reason',
    },
    {
      id: 'refund-unlink-one-all',
      entry: 'ui',
      kind: 'nominal',
      what: 'Unlink one charge and the other stays; Unlink all returns the deposit to unlinked',
    },
    {
      id: 'single-link-unchanged',
      entry: 'ui',
      kind: 'nominal',
      what: 'Linking the payback to the dinner the old way reads as before: “it follows the charge”, no refundParts',
    },
    {
      id: 'single-link-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The single link’s MCP row: linkedChargeId set, no refundParts',
    },
    {
      id: 'refund-set-suggestion',
      entry: 'ui',
      kind: 'edge',
      what: 'Charges that add up to a refund are offered together and linked in one click',
      offDev: {
        file: 'app/src/pages/Finances/FinanceSplits.test.tsx',
        test: 'offers charges that cover a refund together, linked in one click',
        why: 'no set of fixture charges adds up to a fixture refund, and changing the fixture needs a relink',
      },
    },
    {
      id: 'refund-cap-multi',
      entry: 'mcp',
      kind: 'edge',
      what: 'Two refunds on one charge (the payback’s part, then the earlier-dated rebate linked to it) net it to exactly $0: the earlier refund counts first, the later counts what is left ($0)',
    },
    {
      id: 'split-rule-save',
      entry: 'ui',
      kind: 'nominal',
      what: 'Rules tab: a 70/30 split rule saves and lists its percents; a total over 100% is refused with the input kept',
    },
    {
      id: 'split-rule-mcp',
      entry: 'mcp',
      kind: 'nominal',
      what: 'list_finance_rules shows the split’s percents; one-bucket rules read split: null',
    },
    {
      id: 'split-rule-applies',
      entry: 'api',
      kind: 'edge',
      what: 'A new matching charge arrives split by the rule’s percents',
      offDev: {
        file: 'packages/shared/src/financeSplits.test.ts',
        test: 'a new matching charge arrives split by the rule’s percents; a card credit takes its bucket',
        why: 'the fixture bank issues no new row on demand',
      },
    },
    {
      id: 'busy-save',
      entry: 'ui',
      kind: 'edge',
      what: 'A second click on a busy Save split writes nothing more',
      offDev: {
        file: 'app/src/pages/Finances/FinanceSplits.test.tsx',
        test: 'a busy Save ignores a second click',
        why: 'the harness has no way to hold a request open',
      },
    },
    {
      id: 'phone-fields',
      entry: 'ui',
      kind: 'nominal',
      what: 'At phone width the split editor’s amount, bucket and period fields compute to 16px or more',
    },
    {
      id: 'iphone-keypad',
      entry: 'ios',
      kind: 'edge',
      what: 'Tapping an amount field brings the decimal keypad and doesn’t zoom',
      needsYou: 'only iOS Safari zooms or shows its keypad, and no finance Simulator plan exists',
    },
  ],
  steps: [
    {
      id: 'fixture',
      entry: 'ui',
      title:
        'The fixture bank’s grocer, coffee, dinner and payback rows are on the All tab, untouched',
      async run(ctx) {
        before = null; // module state: a second run in one process starts clean
        const r = await rows(ctx);
        // Every row the steps use must be in this period or the last (the MCP and the All tab list those).
        const { o } = await totals(ctx);
        for (const [name, t] of Object.entries(r))
          if (windowOf(o, t.date) === 'outside')
            needsYou(`the fixture's ${name} row has aged past the two periods: re${FIXTURE_HELP}`);
        if (r.grocer.bucket || r.grocer.splits)
          needsYou(
            'the devcheck grocer charge is sorted or split (by hand?): set it back to Unsorted in the app',
          );
        if (r.payback.refundOfId || r.payback.refundParts)
          needsYou('the devcheck payback is linked (by hand?): unlink it in the app');
        await allTab(ctx, 'devcheck grocer');
        const ok = await ctx.page
          .getByRole('button', { name: GROCER })
          .first()
          .waitFor({ timeout: 15_000 })
          .then(
            () => true,
            () => false,
          );
        if (!ok)
          needsYou(
            `the fixture's rows have aged past the two periods the All tab lists: re${FIXTURE_HELP}`,
          );
      },
    },
    {
      id: 'split-refusals-api',
      entry: 'api',
      proves: ['split-refused-api'],
      title: 'setFinanceSplit refusals: one part, short, unknown bucket, a deposit, an unknown id',
      async run(ctx) {
        const { grocer, payback } = await rows(ctx);
        const w = ctx.api.writes;
        const cases: [string, Promise<string | null>, RegExp][] = [
          [
            'one part',
            w.refuseFinanceSplit(grocer.id, [{ bucket: 'budget', cents: 4217, period: null }]),
            /at least two parts/,
          ],
          [
            'short',
            w.refuseFinanceSplit(grocer.id, [
              { bucket: 'budget', cents: 1000, period: null },
              { bucket: 'i_pay', cents: 1000, period: null },
            ]),
            /\$22\.17 is left to assign/,
          ],
          [
            'unknown bucket',
            w.refuseFinanceSplit(grocer.id, [
              { bucket: 'snacks', cents: 2117, period: null },
              { bucket: 'i_pay', cents: 2100, period: null },
            ]),
            /bucket/i,
          ],
          [
            'a deposit',
            w.refuseFinanceSplit(payback.id, [
              { bucket: 'budget', cents: 1500, period: null },
              { bucket: 'i_pay', cents: 1500, period: null },
            ]),
            /Only a charge can be split/,
          ],
          [
            'unknown id',
            w.refuseFinanceSplit(`devcheck-none-${ctx.nonce}`, [
              { bucket: 'budget', cents: 100, period: null },
              { bucket: 'i_pay', cents: 100, period: null },
            ]),
            /gone|not found/i,
          ],
        ];
        for (const [what, p, re] of cases) {
          const msg = await p;
          if (msg === null) fail(`a split with ${what} was taken`);
          if (!re.test(msg!)) fail(`a split with ${what} was refused with "${msg}"`);
        }
        const after = await ctx.api.reads.getFinanceTransaction(grocer.id);
        if (after?.splits) fail('a refused split left parts on the grocer charge');
      },
    },
    {
      id: 'split-ui',
      entry: 'ui',
      proves: ['split-refused', 'split-two-buckets', 'phone-fields'],
      title:
        'Grocer → Split across buckets → 16px fields → $50 refused, kept → Budget $20.00 + Covered $22.17, This period → reload',
      async run(ctx) {
        const { grocer, coffee } = await rows(ctx);
        before = await totals(ctx);
        const dialog = await openRow(ctx, GROCER, /^Charge: /);
        await dialog.getByRole('button', { name: /Split across buckets/ }).click();
        const form = dialog.getByRole('form', { name: 'Split this charge' });
        await form.waitFor({ timeout: 10_000 });
        for (const sel of [
          'input[aria-label="Part 1 amount"]',
          'select[aria-label="Part 1 bucket"]',
          'select[aria-label="Part 1 period"]',
        ]) {
          const px = await fontSizeOf(ctx, sel);
          if (px < 16) fail(`${sel} is ${px}px`);
        }
        await ctx.shot('split-editor');
        // A third part, then removed: focus lands on the part now in its place, never the page.
        await form.getByRole('button', { name: 'Add part' }).click();
        await form.getByRole('button', { name: 'Remove part 3' }).click();
        await wait(300);
        const afterRemove = await focusedText(ctx);
        if (afterRemove !== 'Part 2 bucket')
          fail(`after Remove part, focus is on "${afterRemove}"`);
        ctx.api.writes.recordFinanceSplit(grocer.id); // before any Save: cleanup unsplits by id
        await form.getByLabel('Part 1 amount').fill('50');
        await form.getByLabel('Part 2 amount').fill('22.17');
        await form.getByRole('button', { name: 'Save split' }).click();
        const alert = dialog.getByRole('alert');
        await alert.waitFor({ timeout: 10_000 });
        if (!/more than the \$42\.17 charge/.test((await alert.textContent()) ?? ''))
          fail(`the refusal reads "${await alert.textContent()}"`);
        if ((await form.getByLabel('Part 1 amount').inputValue()) !== '50')
          fail('the refused amount was not kept');
        await ctx.shot('split-refused');
        if ((await ctx.api.reads.getFinanceTransaction(grocer.id))?.splits)
          fail('a refused split was written');
        await form.getByLabel('Part 1 amount').fill('20');
        await form.getByLabel('Part 1 bucket').selectOption({ label: 'Budget' });
        await form.getByLabel('Part 2 bucket').selectOption({ label: 'Covered' });
        await form.getByLabel('Part 1 period').selectOption({ label: 'This period' });
        await form.getByLabel('Part 2 period').selectOption({ label: 'This period' });
        await form.getByRole('button', { name: 'Save split' }).click();
        await dialog.getByRole('button', { name: 'Edit split' }).waitFor({ timeout: 10_000 });
        await until(ctx, grocer.id, (t) => t?.splits?.length === 2, 'the split');
        await ctx.shot('split-summary');
        await closeDetail(ctx);
        await ctx.page.reload();
        await allTab(ctx, 'devcheck grocer');
        const row = ctx.page.getByRole('button', { name: GROCER }).first();
        await row.waitFor({ timeout: 15_000 });
        const text = (await row.textContent()) ?? '';
        if (!/Budget \$20\.00 \(this period\) · Covered \$22\.17 \(this period\)/.test(text))
          fail(`after reload the row reads "${text}"`);
        await ctx.shot('split-row');
        const neighbour = await ctx.api.reads.getFinanceTransaction(coffee.id);
        if (neighbour?.splits || neighbour?.bucket !== coffee.bucket)
          fail('the coffee row changed with the grocer split');
      },
    },
    {
      id: 'split-totals',
      entry: 'api',
      proves: ['split-totals-api'],
      title: 'Overview: Budget +$20.00, Covered +$22.17',
      async run(ctx) {
        if (!before) fail('split-ui never read the totals before');
        const now = await totals(ctx);
        if (now.bucket.budget - before!.bucket.budget !== 2000)
          fail(`Budget moved by ${now.bucket.budget - before!.bucket.budget}¢`);
        if (now.bucket.parents_pay - before!.bucket.parents_pay !== 2217)
          fail(`Covered moved by ${now.bucket.parents_pay - before!.bucket.parents_pay}¢`);
        if (now.bucket.i_pay !== before!.bucket.i_pay)
          fail('I pay moved with a split that has no I-pay part');
      },
    },
    {
      id: 'split-mcp',
      entry: 'mcp',
      proves: ['split-mcp'],
      title:
        'MCP: the grocer row’s parts and periods; the coffee row has none; the overview includes the parts',
      async run(ctx) {
        const { grocer, coffee } = await rows(ctx);
        const out = await ctx.mcp.reads.financeTransactions({ merchant: 'devcheck' });
        const g =
          out.transactions.find((t) => t.id === grocer.id) ??
          fail('the grocer row is not in the MCP list');
        if (g.split !== true || g.bucket !== null)
          fail(`the MCP grocer row reads split ${g.split}, bucket ${g.bucket}`);
        const parts = JSON.stringify(g.parts?.map((p) => [p.bucket, p.amountUsd, p.pinned]));
        if (
          parts !==
          JSON.stringify([
            ['budget', 20, 'current'],
            ['parents_pay', 22.17, 'current'],
          ])
        )
          fail(`the MCP parts read ${parts}`);
        const c =
          out.transactions.find((t) => t.id === coffee.id) ??
          fail('the coffee row is not on the MCP');
        if ('parts' in c || 'split' in c) fail('an unsplit row carries parts on the MCP');
        const o = await ctx.mcp.reads.financeOverview();
        const api = await totals(ctx);
        if (Math.round(o.buckets.budget!.totalUsd * 100) !== api.bucket.budget)
          fail('the MCP Budget total differs from the overview');
        if (!o.nextPeriod) fail('the MCP overview has no nextPeriod');
      },
    },
    {
      id: 'split-next',
      entry: 'ui',
      proves: ['split-next-period'],
      title:
        'Edit split → Covered part to Next period → the row and the header say it waits (when the charge is this period’s)',
      async run(ctx) {
        const { grocer } = await rows(ctx);
        const dialog = await openRow(ctx, GROCER, /^Charge: /);
        await dialog.getByRole('button', { name: 'Edit split' }).click();
        await dialog.getByLabel('Part 2 period').selectOption({ label: 'Next period' });
        await dialog.getByRole('button', { name: 'Save split' }).click();
        await dialog.getByRole('button', { name: 'Edit split' }).waitFor({ timeout: 10_000 });
        await until(
          ctx,
          grocer.id,
          (t) => t?.splits?.[1]?.period === 'next',
          'the Next period part',
        );
        await closeDetail(ctx);
        // The row labels a part by where it lands: on this period's charge a Next part waits (and the
        // header says so); on last period's it already counts in this one.
        const current = windowOf((await totals(ctx)).o, grocer.date) === 'current';
        await allTab(ctx, 'devcheck grocer');
        const row = ctx.page.getByRole('button', { name: GROCER }).first();
        await row.waitFor({ timeout: 15_000 });
        const want = current
          ? /Covered \$22\.17 \(next period\)/
          : /Covered \$22\.17 \(this period\)/;
        if (!want.test((await row.textContent()) ?? ''))
          fail(`the row reads "${await row.textContent()}"`);
        if (current)
          await ctx.page
            .getByText(/waiting for next period/)
            .first()
            .waitFor({ timeout: 10_000 });
        await ctx.shot('split-next');
      },
    },
    {
      id: 'split-next-api',
      entry: 'api',
      proves: ['split-next-period-api'],
      title:
        'Overview: a Next part waits in upcoming on a this-period charge, counts now on a last-period one',
      async run(ctx) {
        const { grocer } = await rows(ctx);
        if (!before) fail('split-ui never read the totals before');
        const now = await totals(ctx);
        const covered = now.bucket.parents_pay - before!.bucket.parents_pay;
        const waiting = now.upcoming - before!.upcoming;
        if (windowOf(now.o, grocer.date) === 'current') {
          if (covered !== 0 || waiting !== 2217)
            fail(`a this-period Next part moved Covered ${covered}¢ and upcoming ${waiting}¢`);
        } else if (covered !== 2217 || waiting !== 0)
          fail(`a last-period Next part moved Covered ${covered}¢ and upcoming ${waiting}¢`);
      },
    },
    {
      id: 'split-brush',
      entry: 'ui',
      proves: ['split-brush-sort'],
      title: 'All tab → arm the Budget brush → the split grocer row is aria-disabled',
      async run(ctx) {
        const { grocer } = await rows(ctx);
        await allTab(ctx, 'devcheck grocer');
        const row = ctx.page.locator(`[data-txn-id="${grocer.id}"]`);
        await row.waitFor({ timeout: 15_000 });
        await ctx.page.evaluate('document.activeElement && document.activeElement.blur()');
        await ctx.page.keyboard.press('2');
        await wait(300);
        if ((await row.getAttribute('aria-disabled')) !== 'true')
          fail('the split row takes the brush');
        await ctx.shot('split-brush');
        await ctx.page.keyboard.press('Escape');
      },
    },
    {
      id: 'split-sort-refused',
      entry: 'api',
      proves: ['split-sort-refused-api'],
      title: 'setFinanceBucket on the split grocer row is refused',
      async run(ctx) {
        const { grocer } = await rows(ctx);
        const msg = await ctx.api.writes.refuseFinanceBucket(grocer.id, 'budget');
        if (msg === null) fail('a bucket on a split row was taken');
        if (!/is split — change it from its detail/.test(msg!)) fail(`refused with "${msg}"`);
        if (!(await ctx.api.reads.getFinanceTransaction(grocer.id))?.splits)
          fail('the refusal cleared the split');
      },
    },
    {
      id: 'split-cancel-remove',
      entry: 'ui',
      proves: ['split-cancel-repeat'],
      title:
        'Edit split → change → Cancel: unchanged → Save unchanged: same parts → Remove split → Unsorted, focused',
      async run(ctx) {
        const { grocer } = await rows(ctx);
        const was = JSON.stringify((await ctx.api.reads.getFinanceTransaction(grocer.id))?.splits);
        const dialog = await openRow(ctx, GROCER, /^Charge: /);
        await dialog.getByRole('button', { name: 'Edit split' }).click();
        await dialog.getByLabel('Part 1 amount').fill('1');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.getByRole('button', { name: 'Edit split' }).click();
        if ((await dialog.getByLabel('Part 1 amount').inputValue()) !== '20.00')
          fail('Cancel kept the edit');
        await dialog.getByRole('button', { name: 'Save split' }).click();
        await dialog.getByRole('button', { name: 'Edit split' }).waitFor({ timeout: 10_000 });
        await wait(500);
        if (JSON.stringify((await ctx.api.reads.getFinanceTransaction(grocer.id))?.splits) !== was)
          fail('saving the split unchanged changed it');
        await dialog.getByRole('button', { name: 'Remove split' }).click();
        const unsorted = dialog
          .getByRole('radiogroup', { name: 'Bucket' })
          .getByRole('radio', { name: 'Unsorted' });
        await unsorted.waitFor({ timeout: 10_000 });
        let focused = '';
        for (let i = 0; i < 20 && focused !== 'Unsorted'; i++) {
          await wait(150);
          focused = await focusedText(ctx);
        }
        if (focused !== 'Unsorted') fail(`after Remove split, focus is on "${focused}"`);
        await until(ctx, grocer.id, (t) => !t?.splits && !t?.bucket, 'Remove split');
        await ctx.shot('split-removed');
        await closeDetail(ctx);
      },
    },
    {
      id: 'refund-two',
      entry: 'ui',
      proves: ['refund-two-charges', 'refund-over'],
      title:
        'Payback → link the grocer by search → across another charge → add coffee #2 → $7.00 refused → $23.50 + $6.50 → reload',
      async run(ctx) {
        const { payback } = await rows(ctx);
        const dialog = await openRow(ctx, PAYBACK, /^Money in: /);
        await dialog.getByRole('button', { name: 'Link as a refund' }).click();
        ctx.api.writes.recordFinanceLink(payback.id); // before the click: cleanup unlinks by id
        await dialog
          .getByRole('searchbox', { name: 'Search charges to link' })
          .fill('devcheck grocer');
        await dialog
          .getByRole('button', { name: /^Link to .*devcheck grocer/i })
          .first()
          .click();
        await dialog.getByRole('button', { name: /across another charge/ }).click();
        const form = dialog.getByRole('form', { name: 'Link to several charges' });
        await form.waitFor({ timeout: 10_000 });
        await dialog
          .getByRole('searchbox', { name: 'Search charges to link' })
          .fill('devcheck coffee #2');
        await dialog
          .getByRole('button', { name: /^Add .*devcheck coffee #2/i })
          .first()
          .click();
        const grocerAmt = form.getByLabel(/Amount for .*devcheck grocer/i);
        const coffeeAmt = form.getByLabel(/Amount for .*devcheck coffee #2/i);
        await coffeeAmt.waitFor({ timeout: 10_000 });
        const px = await fontSizeOf(ctx, 'input[aria-label^="Amount for"]');
        if (px < 16) fail(`the linker's amount field is ${px}px`);
        // Short of the refund: the rest says it stays money in.
        await grocerAmt.fill('20');
        await coffeeAmt.fill('6.50');
        const status = (await form.getByRole('status').first().textContent()) ?? '';
        if (!/\$3\.50 not linked — it stays money in/.test(status))
          fail(`the remainder reads "${status}"`);
        await grocerAmt.fill('23');
        await coffeeAmt.fill('7');
        await form.getByRole('button', { name: 'Save links' }).click();
        const alert = dialog.getByRole('alert');
        await alert.waitFor({ timeout: 10_000 });
        if (!/Only \$6\.50 is left to refund/.test((await alert.textContent()) ?? ''))
          fail(`the refusal reads "${await alert.textContent()}"`);
        if ((await coffeeAmt.inputValue()) !== '7') fail('the refused amount was not kept');
        await ctx.shot('refund-over');
        await grocerAmt.fill('23.50');
        await coffeeAmt.fill('6.50');
        await form.getByRole('button', { name: 'Save links' }).click();
        await dialog.getByText('Refund across 2 charges').waitFor({ timeout: 10_000 });
        await until(ctx, payback.id, (t) => t?.refundParts?.length === 2, 'the allocation');
        await ctx.shot('refund-two');
        await closeDetail(ctx);
        await ctx.page.reload();
        const again = await openRow(ctx, PAYBACK, /^Money in: /);
        await again.getByText('Refund across 2 charges').waitFor({ timeout: 10_000 });
        await closeDetail(ctx);
      },
    },
    {
      id: 'refund-two-api',
      entry: 'api',
      proves: ['refund-two-charges-api', 'refund-over-api'],
      title: 'refundParts: grocer $23.50 + coffee $6.50; over a charge and over the refund refused',
      async run(ctx) {
        const { payback, grocer, coffee } = await rows(ctx);
        const parts =
          (await ctx.api.reads.getFinanceTransaction(payback.id))?.refundParts ??
          fail('no refundParts');
        const by = new Map(parts.map((p) => [p.chargeId, p.cents]));
        if (by.get(grocer.id) !== 2350 || by.get(coffee.id) !== 650)
          fail(`refundParts read ${JSON.stringify(parts)}`);
        const w = ctx.api.writes;
        const over = await w.refuseFinanceRefundParts(payback.id, [
          { chargeId: grocer.id, cents: 2000 },
          { chargeId: coffee.id, cents: 1000 },
        ]);
        if (!over || !/Only \$6\.50 is left to refund/.test(over)) fail(`over a charge: ${over}`);
        const sum = await w.refuseFinanceRefundParts(payback.id, [
          { chargeId: grocer.id, cents: 2500 },
          { chargeId: coffee.id, cents: 650 },
        ]);
        if (!sum || !/more than the \$30\.00 refund/.test(sum)) fail(`over the refund: ${sum}`);
        const still = (await ctx.api.reads.getFinanceTransaction(payback.id))?.refundParts;
        if (JSON.stringify(still) !== JSON.stringify(parts))
          fail('a refused allocation changed the saved one');
      },
    },
    {
      id: 'refund-two-mcp',
      entry: 'mcp',
      proves: ['refund-two-charges-mcp'],
      title: 'MCP: the deposit’s refundParts; the coffee charge refunded $6.50',
      async run(ctx) {
        const { payback, grocer, coffee } = await rows(ctx);
        const out = await ctx.mcp.reads.financeTransactions({ merchant: 'devcheck' });
        const dep =
          out.transactions.find((t) => t.id === payback.id) ??
          fail('the payback is not in the MCP list');
        const got = JSON.stringify(dep.refundParts?.map((p) => [p.chargeId, p.allocatedUsd]));
        if (
          got !==
          JSON.stringify([
            [grocer.id, -23.5],
            [coffee.id, -6.5],
          ])
        )
          fail(`the MCP refundParts read ${got}`);
        if (dep.linkedChargeId !== grocer.id)
          fail(`linkedChargeId is ${dep.linkedChargeId}, not the largest part`);
        const c = out.transactions.find((t) => t.id === coffee.id);
        if (c?.refundedUsd !== 6.5) fail(`the coffee charge reads refundedUsd ${c?.refundedUsd}`);
      },
    },
    {
      id: 'refund-cap',
      entry: 'mcp',
      proves: ['refund-cap-multi'],
      title:
        'The rebate linked (API) to coffee #2, which the payback’s part covers: the earlier rebate counts $6.50, the payback’s coffee part $0, the coffee stays refunded $6.50',
      async run(ctx) {
        const { coffee } = await rows(ctx);
        const rebate =
          (await fixtureRows(ctx)).find(/devcheck rebate/i) ??
          needsYou(`fixture row devcheck rebate is missing: re${FIXTURE_HELP}`);
        await ctx.api.writes.linkFinanceRefund(rebate.id, coffee.id); // ledgered: cleanup unlinks it
        const out = await ctx.mcp.reads.financeTransactions({ merchant: 'devcheck' });
        const r =
          out.transactions.find((t) => t.id === rebate.id) ?? fail('the rebate is not on the MCP');
        if (r.linkedChargeId !== coffee.id) fail(`the rebate links ${r.linkedChargeId}`);
        // The cap counts a charge's refunds in date order: the rebate (dated first) takes all of it.
        if (r.countedUsd !== -6.5) fail(`the rebate counts ${r.countedUsd}, not -6.5`);
        const { payback } = await rows(ctx);
        const dep = out.transactions.find((t) => t.id === payback.id);
        const part = dep?.refundParts?.find((x) => x.chargeId === coffee.id);
        if (part?.countedUsd !== 0) fail(`the payback's coffee part counts ${part?.countedUsd}, not 0`);
        const c = out.transactions.find((t) => t.id === coffee.id);
        if (c?.refundedUsd !== 6.5) fail(`the coffee reads refundedUsd ${c?.refundedUsd}, not 6.5`);
      },
    },
    {
      id: 'refund-unlink',
      entry: 'ui',
      proves: ['refund-unlink-one-all'],
      title: 'Payback → Unlink coffee → across 1 charge → Unlink all → Link as a refund',
      async run(ctx) {
        const { payback } = await rows(ctx);
        const dialog = await openRow(ctx, PAYBACK, /^Money in: /);
        await dialog.getByRole('button', { name: /^Unlink .*devcheck coffee #2/i }).click();
        await dialog.getByText('Refund across 1 charge').waitFor({ timeout: 10_000 });
        await wait(300);
        if ((await focusedText(ctx)) === '<body>') fail('after Unlink one, focus fell to the page');
        await dialog.getByRole('button', { name: 'Unlink all' }).click();
        await until(ctx, payback.id, (t) => !t?.refundParts && !t?.refundOfId, 'Unlink all');
        await wait(300);
        if ((await focusedText(ctx)) === '<body>') fail('after Unlink all, focus fell to the page');
        await ctx.shot('refund-unlinked');
        await closeDetail(ctx);
      },
    },
    {
      id: 'single-link',
      entry: 'ui',
      proves: ['single-link-unchanged'],
      title:
        'Payback → Link as a refund → Link to the dinner: “it follows the charge”, no refundParts',
      async run(ctx) {
        const { payback, dinner } = await rows(ctx);
        const dialog = await openRow(ctx, PAYBACK, /^Money in: /);
        ctx.api.writes.recordFinanceLink(payback.id); // before the click: cleanup unlinks by id
        const start = dialog.getByRole('button', { name: 'Link as a refund' });
        if (await start.isVisible()) await start.click();
        await dialog
          .getByRole('button', { name: /^Link to .*devcheck dinner/i })
          .first()
          .click();
        await dialog.getByText(/it follows the charge/).waitFor({ timeout: 10_000 });
        await until(ctx, payback.id, (t) => t?.refundOfId === dinner.id, 'the single link');
        if ((await ctx.api.reads.getFinanceTransaction(payback.id))?.refundParts)
          fail('a single link wrote refundParts');
        await closeDetail(ctx);
      },
    },
    {
      id: 'single-link-mcp',
      entry: 'mcp',
      proves: ['single-link-mcp'],
      title: 'MCP: the single link reads linkedChargeId = the dinner, no refundParts',
      async run(ctx) {
        const { payback, dinner } = await rows(ctx);
        const out = await ctx.mcp.reads.financeTransactions({ merchant: 'devcheck' });
        const dep =
          out.transactions.find((t) => t.id === payback.id) ??
          fail('the payback is not in the MCP list');
        if (dep.linkedChargeId !== dinner.id || 'refundParts' in dep)
          fail(`the MCP single link reads ${JSON.stringify(dep)}`);
      },
    },
    {
      id: 'rule-split',
      entry: 'ui',
      proves: ['split-rule-save'],
      title:
        'Rules tab → Split by percent → 70/50 refused, kept → 70/30 → listed as Budget 70% · Covered 30%',
      async run(ctx) {
        const pattern = `devcheck-split-${ctx.nonce}`.toLowerCase();
        await ctx.ui.goto('/finances/rules');
        const field = ctx.page.getByLabel('When the merchant contains');
        await field.waitFor({ timeout: 15_000 });
        await field.fill(pattern);
        await ctx.page.getByLabel('Sort into').selectOption({ label: 'Split by percent…' });
        for (const sel of [
          'input[aria-label="Part 1 percent"]',
          'select[aria-label="Part 1 bucket"]',
        ]) {
          const px = await fontSizeOf(ctx, sel);
          if (px < 16) fail(`the rule's ${sel} is ${px}px`);
        }
        await ctx.page.getByLabel('Part 1 percent').fill('70');
        // Before the first click: a 70/50 that wrongly lands, or a crash before it's recorded, is reported.
        ctx.api.writes.recordFinanceRuleIntent(pattern);
        await ctx.page.getByRole('button', { name: 'Add rule' }).click();
        const alert = ctx.page.getByRole('alert');
        await alert.waitFor({ timeout: 10_000 });
        if (!/120%, not 100%/.test((await alert.textContent()) ?? ''))
          fail(`the refusal reads "${await alert.textContent()}"`);
        if ((await ctx.page.getByLabel('Part 1 percent').inputValue()) !== '70')
          fail('the refused percent was not kept');
        await ctx.page.getByLabel('Part 2 percent').fill('30');
        await ctx.page.getByRole('button', { name: 'Add rule' }).click();
        let rule = null;
        for (let i = 0; !rule; i++) {
          if (i >= 40) fail('the split rule never reached the server');
          await wait(250);
          rule =
            (await ctx.api.reads.listFinanceRules()).find((r) => r.pattern === pattern) ?? null;
        }
        ctx.api.writes.recordFinanceRule(rule!); // cleanup deletes it by id
        // This run's rule row, not a leftover's.
        await ctx.page
          .locator(`li:has-text("${pattern}")`)
          .getByText('Budget 70% · Covered 30%')
          .waitFor({ timeout: 10_000 });
        await ctx.shot('rule-split');
      },
    },
    {
      id: 'rule-split-mcp',
      entry: 'mcp',
      proves: ['split-rule-mcp'],
      title: 'MCP list_finance_rules: the 70/30 split; every rule carries a split field',
      async run(ctx) {
        const pattern = `devcheck-split-${ctx.nonce}`.toLowerCase();
        const rules = await ctx.mcp.reads.financeRules();
        const r =
          rules.find((x) => x.pattern === pattern) ?? fail('the split rule is not on the MCP');
        const got = JSON.stringify(r.split?.map((p) => [p.bucket, p.percent]));
        if (
          got !==
          JSON.stringify([
            ['budget', 70],
            ['parents_pay', 30],
          ])
        )
          fail(`the MCP split reads ${got}`);
        for (const x of rules)
          if ((x as { split?: unknown }).split === undefined)
            fail(`rule ${x.pattern} has no split field`);
      },
    },
    noConsoleErrors,
  ],
};
