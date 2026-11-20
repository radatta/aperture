import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_INSTITUTION, FIXTURE_LINK_ACCOUNTS } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

// Splits across buckets, refunds across charges, and split rules on the page (stub). The fixture bank's
// card charges are `fx-card-<daysAgo>`: $30.00 at 8, $15.00 at 6, $20.00 at 4, $10.00 at 2.
beforeEach(() => globalThis.localStorage?.clear());

async function linked(): Promise<ApiClient> {
  const api = createStubClient({ seed: false, storageKey: `fin-split-${Math.random()}` });
  await api.exchangePlaidPublicToken({
    publicToken: 'p',
    institution: FIXTURE_INSTITUTION,
    accounts: FIXTURE_LINK_ACCOUNTS,
  });
  for (const id of ['fx-ccpay-card-40', 'fx-ccpay-card-10'])
    await api.setFinancePeriodStart(id, true);
  return api;
}

const row = (id: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-txn-id="${id}"]`);
    if (!el) throw new Error(`no row ${id}`);
    return el;
  });

async function openDetail(id: string, name: RegExp) {
  const user = userEvent.setup();
  await user.click(await row(id));
  return { user, dialog: await screen.findByRole('dialog', { name }) };
}

describe('Splitting a charge across buckets', () => {
  it('opens half and half, refuses parts that don’t add up with the input kept, then saves', async () => {
    const api = await linked();
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-card-8', /Charge: Amazon/);
    await user.click(within(dialog).getByRole('button', { name: /Split across buckets/ }));
    const form = within(dialog).getByRole('form', { name: 'Split this charge' });
    // The first field is the first part's bucket — a select, so no keyboard pops on a phone.
    expect(document.activeElement).toBe(within(form).getByLabelText('Part 1 bucket'));
    expect((within(form).getByLabelText('Part 1 amount') as HTMLInputElement).value).toBe('15.00');
    expect((within(form).getByLabelText('Part 2 amount') as HTMLInputElement).value).toBe('15.00');
    expect(within(form).getByRole('status').textContent).toBe('Adds up to $30.00');

    // Typing one amount moves the untouched other one.
    await user.clear(within(form).getByLabelText('Part 1 amount'));
    await user.type(within(form).getByLabelText('Part 1 amount'), '18');
    expect((within(form).getByLabelText('Part 2 amount') as HTMLInputElement).value).toBe('12.00');

    // Both touched and over: refused, nothing written, every field kept.
    const spy = vi.spyOn(api, 'setFinanceSplit');
    await user.clear(within(form).getByLabelText('Part 2 amount'));
    await user.type(within(form).getByLabelText('Part 2 amount'), '20');
    expect(within(form).getByRole('status').textContent).toBe('$8.00 over the $30.00 charge');
    await user.click(within(form).getByRole('button', { name: 'Save split' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(
      /The parts add up to \$38\.00, \$8\.00 more than the \$30\.00 charge/,
    );
    expect(spy).not.toHaveBeenCalled();
    expect((within(form).getByLabelText('Part 2 amount') as HTMLInputElement).value).toBe('20');

    await user.clear(within(form).getByLabelText('Part 2 amount'));
    await user.type(within(form).getByLabelText('Part 2 amount'), '12');
    expect(within(dialog).queryByRole('alert')).toBeNull(); // an edit clears the refusal
    await user.selectOptions(within(form).getByLabelText('Part 2 bucket'), 'parents_pay');
    await user.click(within(form).getByRole('button', { name: 'Save split' }));
    const edit = await within(dialog).findByRole('button', { name: 'Edit split' });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(spy).toHaveBeenCalledWith('fx-card-8', [
      { bucket: 'budget', cents: 1800, period: null },
      { bucket: 'parents_pay', cents: 1200, period: null },
    ]);
    // No Bucket group while split: a single bucket would undo it.
    expect(within(dialog).queryByRole('radiogroup', { name: 'Bucket' })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    const r = await row('fx-card-8');
    expect(within(r).getByText('Split')).toBeTruthy();
    expect(r.textContent).toMatch(/Budget \$18\.00 · Covered \$12\.00/);
  });

  it('a next-period part waits outside the totals, and the header says so', async () => {
    const api = await linked();
    await api.setFinanceSplit('fx-card-8', [
      { bucket: 'budget', cents: 1000, period: null },
      { bucket: 'budget', cents: 2000, period: 'next' },
    ]);
    renderApp({ api, path: '/finances/all' });
    expect(await screen.findByText('$20.00 waiting for next period')).toBeTruthy();
    const { dialog } = await openDetail('fx-card-8', /Charge: Amazon/);
    expect(within(dialog).getByText('next period — waits until it starts')).toBeTruthy();
    expect((await row('fx-card-8')).textContent).toMatch(/Budget \$20\.00 \(next period\)/);
  });

  it('Remove split sends the row back to Unsorted with focus on the Bucket group', async () => {
    const api = await linked();
    await api.setFinanceSplit('fx-card-8', [
      { bucket: 'budget', cents: 1500, period: null },
      { bucket: 'i_pay', cents: 1500, period: null },
    ]);
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-card-8', /Charge: Amazon/);
    await user.click(within(dialog).getByRole('button', { name: 'Remove split' }));
    const unsorted = await within(dialog).findByRole('radio', { name: 'Unsorted' });
    await waitFor(() => expect(document.activeElement).toBe(unsorted));
    expect(unsorted.getAttribute('aria-checked')).toBe('true');
  });

  it('a server refusal shows why and keeps the draft', async () => {
    const api = await linked();
    vi.spyOn(api, 'setFinanceSplit').mockRejectedValue(
      new Error('Your edits and the sync collided'),
    );
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-card-8', /Charge: Amazon/);
    await user.click(within(dialog).getByRole('button', { name: /Split across buckets/ }));
    await user.selectOptions(within(dialog).getByLabelText('Part 1 period'), 'next');
    await user.click(within(dialog).getByRole('button', { name: 'Save split' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(
      /Couldn't save the split: Your edits and the sync collided/,
    );
    expect((within(dialog).getByLabelText('Part 1 period') as HTMLSelectElement).value).toBe(
      'next',
    );
  });

  it('Add part adds a third; Remove part puts focus on the part now in its place', async () => {
    const api = await linked();
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-card-8', /Charge: Amazon/);
    await user.click(within(dialog).getByRole('button', { name: /Split across buckets/ }));
    const form = within(dialog).getByRole('form', { name: 'Split this charge' });
    await user.clear(within(form).getByLabelText('Part 1 amount'));
    await user.type(within(form).getByLabelText('Part 1 amount'), '10');
    await user.clear(within(form).getByLabelText('Part 2 amount'));
    await user.type(within(form).getByLabelText('Part 2 amount'), '10');
    await user.click(within(form).getByRole('button', { name: 'Add part' }));
    // The new part takes what's left.
    expect((within(form).getByLabelText('Part 3 amount') as HTMLInputElement).value).toBe('10.00');
    await user.click(within(form).getByRole('button', { name: 'Remove part 3' }));
    expect(within(form).queryByLabelText('Part 3 amount')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(form).getByLabelText('Part 2 bucket')),
    );
  });

  it('the remainder is muted only beside the refusal that says the same thing', async () => {
    const api = await linked();
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-card-8', /Charge: Amazon/);
    await user.click(within(dialog).getByRole('button', { name: /Split across buckets/ }));
    const form = within(dialog).getByRole('form', { name: 'Split this charge' });
    const statusTone = () => within(form).getByRole('status').firstElementChild!.className;
    const amount = async (i: number, v: string) => {
      await user.clear(within(form).getByLabelText(`Part ${i} amount`));
      await user.type(within(form).getByLabelText(`Part ${i} amount`), v);
    };
    await amount(1, '18');
    await amount(2, '20'); // $8.00 over
    expect(statusTone()).toMatch(/text-danger/);
    await user.click(within(form).getByRole('button', { name: 'Save split' }));
    expect(within(form).getByRole('alert').textContent).toMatch(/more than the \$30\.00 charge/);
    expect(statusTone()).toMatch(/text-ink-muted/); // one red line, not two
    await amount(1, '0');
    await amount(2, '40'); // a zero part, and still $10.00 over
    await user.click(within(form).getByRole('button', { name: 'Save split' }));
    expect(within(form).getByRole('alert').textContent).toMatch(/above \$0\.00/);
    expect(statusTone()).toMatch(/text-danger/); // a different refusal: the "over" keeps its red
  });

  it('an overview from an older server (no upcoming key) still renders the page', async () => {
    const api = await linked();
    const real = api.getFinanceOverview.bind(api);
    vi.spyOn(api, 'getFinanceOverview').mockImplementation(async (q) => {
      const older: Partial<Awaited<ReturnType<typeof real>>> = await real(q);
      delete older.upcoming;
      return older as Awaited<ReturnType<typeof real>>;
    });
    renderApp({ api, path: '/finances/all' });
    expect(await screen.findByRole('searchbox', { name: 'Search transactions' })).toBeTruthy();
    expect(screen.queryByText(/waiting for next period/)).toBeNull();
  });

  it('a busy Save ignores a second click', async () => {
    const api = await linked();
    let release!: () => void;
    const real = api.setFinanceSplit.bind(api);
    const spy = vi.spyOn(api, 'setFinanceSplit').mockImplementation(async (id, parts) => {
      await new Promise<void>((r) => (release = r));
      return real(id, parts);
    });
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-card-8', /Charge: Amazon/);
    await user.click(within(dialog).getByRole('button', { name: /Split across buckets/ }));
    const save = within(dialog).getByRole('button', { name: 'Save split' });
    await user.click(save);
    await waitFor(() => expect(save.getAttribute('aria-disabled')).toBe('true'));
    await user.click(save);
    expect(spy).toHaveBeenCalledTimes(1);
    release();
    expect(await within(dialog).findByRole('button', { name: 'Edit split' })).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a split posted at a new amount asks again in Sort, saying why', async () => {
    const api = await linked();
    await api.setFinanceSplit('fx-pending-1', [
      { bucket: 'budget', cents: 1100, period: null },
      { bucket: 'i_pay', cents: 1100, period: null },
    ]);
    await api.requestFinanceSync({ refresh: false }); // posts at $26.00
    renderApp({ api, path: '/finances' });
    expect(await screen.findByText(/split no longer adds up \(was \$22\.00\)/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByText(/split no longer adds up/));
    const dialog = await screen.findByRole('dialog', { name: /Sweetgreen/ });
    expect(within(dialog).getByText(/changed from \$22\.00 to \$26\.00/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Fix the split' }));
    expect((within(dialog).getByLabelText('Part 1 amount') as HTMLInputElement).value).toBe(
      '11.00',
    );
  });

  it('Edit split on a rule split opens on the parts as they count at the posted amount', async () => {
    const api = createStubClient({ seed: false, storageKey: `fin-split-${Math.random()}` });
    await api.upsertFinanceRule({
      pattern: 'Sweetgreen',
      bucket: 'i_pay',
      split: [
        { bucket: 'budget', percent: 40 },
        { bucket: 'i_pay', percent: 60 },
      ],
    });
    await api.exchangePlaidPublicToken({
      publicToken: 'p',
      institution: FIXTURE_INSTITUTION,
      accounts: FIXTURE_LINK_ACCOUNTS,
    });
    for (const id of ['fx-ccpay-card-40', 'fx-ccpay-card-10'])
      await api.setFinancePeriodStart(id, true);
    await api.requestFinanceSync({ refresh: false }); // $22.00 pending posts at $26.00, split carried
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-posted-1', /Charge: Sweetgreen/);
    await user.click(within(dialog).getByRole('button', { name: 'Edit split' }));
    expect((within(dialog).getByLabelText('Part 1 amount') as HTMLInputElement).value).toBe(
      '10.40',
    );
    expect((within(dialog).getByLabelText('Part 2 amount') as HTMLInputElement).value).toBe(
      '15.60',
    );
  });

  it('the brush leaves a split row alone', async () => {
    const api = await linked();
    await api.setFinanceSplit('fx-card-8', [
      { bucket: 'budget', cents: 1500, period: null },
      { bucket: 'i_pay', cents: 1500, period: null },
    ]);
    renderApp({ api, path: '/finances/all' });
    const user = userEvent.setup();
    const r = await row('fx-card-8');
    const spy = vi.spyOn(api, 'setFinanceBucket');
    await user.keyboard('2');
    expect(r.getAttribute('aria-disabled')).toBe('true');
    await user.click(r);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('A refund across charges', () => {
  it('adds a second charge by search, saves, and unlinks one charge then all', async () => {
    const api = await linked();
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-reimburse', /Money in: Example Payer/);
    await user.click(within(dialog).getByRole('button', { name: 'Link as a refund' }));
    await user.click(within(dialog).getByRole('button', { name: /Link to Example Landlord/ }));
    await user.click(await within(dialog).findByRole('button', { name: /across another charge/ }));
    const form = within(dialog).getByRole('form', { name: 'Link to several charges' });
    // The single link's charge starts at what this refund counts there.
    expect(
      (within(form).getByLabelText(/Amount for Example Landlord/) as HTMLInputElement).value,
    ).toBe('800.00');
    await user.type(within(dialog).getByRole('searchbox'), 'amazon');
    await user.click((await within(dialog).findAllByRole('button', { name: /^Add Amazon/ }))[0]!);
    // What's left of the refund goes to the added charge.
    expect((within(form).getByLabelText(/Amount for Amazon/) as HTMLInputElement).value).toBe(
      '0.50',
    );
    await user.clear(within(form).getByLabelText(/Amount for Example Landlord/));
    await user.type(within(form).getByLabelText(/Amount for Example Landlord/), '770.50');
    await user.clear(within(form).getByLabelText(/Amount for Amazon/));
    await user.type(within(form).getByLabelText(/Amount for Amazon/), '30');
    expect(within(form).getByRole('status').textContent).toBe('All $800.50 linked');
    await user.click(within(form).getByRole('button', { name: 'Save links' }));
    expect(await within(dialog).findByText('Refund across 2 charges')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /^Unlink Amazon/ }));
    expect(await within(dialog).findByText('Refund across 1 charge')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Unlink all' }));
    // Back to the suggestions it was linked from (the Link-as-a-refund panel stays open).
    expect(
      await within(dialog).findByRole('searchbox', { name: 'Search charges to link' }),
    ).toBeTruthy();
  });

  it('the editor opens on its heading; Add and Remove keep focus on an amount, then Cancel', async () => {
    const api = await linked();
    await api.linkFinanceRefund('fx-reimburse', 'fx-rent');
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-reimburse', /Money in: Example Payer/);
    await user.click(within(dialog).getByRole('button', { name: /across another charge/ }));
    const form = within(dialog).getByRole('form', { name: 'Link to several charges' });
    // Not an amount field: a phone's keyboard would pop over the rows.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe('Link $800.50 across charges'),
    );
    await user.type(within(dialog).getByRole('searchbox'), 'amazon');
    await user.click((await within(dialog).findAllByRole('button', { name: /^Add Amazon/ }))[0]!);
    await waitFor(() =>
      expect(document.activeElement).toBe(within(form).getByLabelText(/Amount for Amazon/)),
    );
    await user.click(within(form).getByRole('button', { name: /^Remove Amazon/ }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(form).getByLabelText(/Amount for Example Landlord/),
      ),
    );
    await user.click(within(form).getByRole('button', { name: /^Remove Example Landlord/ }));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'Cancel' })),
    );
    expect(within(form).getByRole('status').textContent).toBe(
      'Add a charge below to link this refund to',
    );
  });

  it('Unlink one moves focus to the Unlink left; a partial allocation says what stays money in', async () => {
    const api = await linked();
    await api.setFinanceRefundParts('fx-reimburse', [
      { chargeId: 'fx-card-8', cents: 3000 },
      { chargeId: 'fx-card-6', cents: 1500 },
    ]);
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-reimburse', /Money in: Example Payer/);
    expect(
      within(dialog).getByText(
        /\$755\.50 of it isn.t linked — it stays money in, outside the budget/,
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /^Unlink Amazon/ }));
    expect(await within(dialog).findByText('Refund across 1 charge')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Unlink (?!Amazon)/),
    );
  });

  it('a refund across charges whose largest charge is older than both periods is listed once', async () => {
    const api = await linked();
    const rows = await api.listFinanceTransactions({ from: '2000-01-01', to: '2999-12-31' });
    const old = rows.find((t) => t.id === 'fx-card-58')!; // before both periods
    await api.setFinanceRefundParts('fx-reimburse', [
      { chargeId: 'fx-card-58', cents: old.rawAmountCents },
      { chargeId: 'fx-card-8', cents: 100 },
    ]);
    renderApp({ api, path: '/finances/all' });
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole('searchbox', { name: 'Search transactions' }),
      'example payer',
    );
    expect((await screen.findByText(/^\d+ rows? · /)).textContent).toMatch(/^1 row · /);
  });

  it('refuses more than what’s left of a charge, keeping the amounts', async () => {
    const api = await linked();
    await api.linkFinanceRefund('fx-reimburse', 'fx-rent');
    renderApp({ api, path: '/finances/all' });
    const { user, dialog } = await openDetail('fx-reimburse', /Money in: Example Payer/);
    await user.click(within(dialog).getByRole('button', { name: /across another charge/ }));
    const field = within(dialog).getByLabelText(/Amount for Example Landlord/);
    await user.clear(field);
    await user.type(field, '800.50');
    await user.click(within(dialog).getByRole('button', { name: 'Save links' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(
      /Only \$800\.00 is left to refund on Example Landlord/,
    );
    expect((field as HTMLInputElement).value).toBe('800.50');
  });

  it('offers charges that cover a refund together, linked in one click', async () => {
    const api = await linked();
    renderApp({ api, path: '/finances/all' });
    // A $15.00 card credit whose one same-merchant charge ($25.00) isn't an exact fit.
    const { user, dialog } = await openDetail('fx-refund-2', /Refund: Target/);
    expect(within(dialog).getByText('Or several charges together:')).toBeTruthy();
    const set = within(dialog).getAllByRole('button', { name: /^Link to .* \+ / })[0]!;
    // One merchant across the set ranks first: three $5.00 charges at the same coffee shop.
    expect(set.getAttribute('aria-label')).toMatch(
      /^Link to (Blue Bottle Coffee · \w{3} \d{1,2} \$5\.00( \+ )?){3}$/,
    );
    await user.click(set);
    expect(await within(dialog).findByText('Refund across 3 charges')).toBeTruthy();
    const saved = (
      await api.listFinanceTransactions({ from: '2000-01-01', to: '2999-12-31' })
    ).find((t) => t.id === 'fx-refund-2')!;
    expect(saved.refundParts!.reduce((n, p) => n + p.cents, 0)).toBe(1500);
  });
});

describe('Split rules', () => {
  it('saves a percent split, lists it, and refuses one that isn’t 100%', async () => {
    const api = await linked();
    renderApp({ api, path: '/finances/rules' });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('When the merchant contains'), 'store a');
    await user.selectOptions(screen.getByLabelText('Sort into'), 'split');
    await user.clear(screen.getByLabelText('Part 1 percent'));
    await user.type(screen.getByLabelText('Part 1 percent'), '70');
    expect(screen.getByText('20% over')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByRole('alert').textContent).toMatch(/The parts add up to 120%, not 100%/);
    expect((screen.getByLabelText('Part 1 percent') as HTMLInputElement).value).toBe('70');
    await user.clear(screen.getByLabelText('Part 2 percent'));
    await user.type(screen.getByLabelText('Part 2 percent'), '30');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(await screen.findByText('Budget 70% · Covered 30%')).toBeTruthy();
    const rules = await api.listFinanceRules();
    expect(rules.find((r) => r.pattern === 'store a')!.split).toEqual([
      { bucket: 'budget', percent: 70 },
      { bucket: 'parents_pay', percent: 30 },
    ]);
  });

  it('a split rule an older write retargeted shows as one-bucket, and Pause sends no split', async () => {
    const api = await linked();
    const rule = await api.upsertFinanceRule({ pattern: 'store a', bucket: 'parents_pay' });
    const stale = {
      ...rule,
      split: [
        { bucket: 'budget' as const, percent: 70 },
        { bucket: 'i_pay' as const, percent: 30 },
      ],
    };
    vi.spyOn(api, 'listFinanceRules').mockResolvedValue([stale]);
    const upsert = vi.spyOn(api, 'upsertFinanceRule');
    renderApp({ api, path: '/finances/rules' });
    const user = userEvent.setup();
    const select = (await screen.findByLabelText('Bucket for store a')) as HTMLSelectElement;
    expect(select.value).toBe('parents_pay');
    expect(screen.queryByText('Budget 70% · I pay 30%')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More actions for store a' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    // Pause sends no split: the server keeps the rule's split as it stands then, not this device's copy.
    await waitFor(() => expect(upsert).toHaveBeenCalled());
    const sent = upsert.mock.lastCall![0];
    expect([sent.bucket, sent.active, 'split' in sent]).toEqual(['parents_pay', false, false]);
  });

  it('Rules: Add and Remove part move focus to a part and clear a refusal; the sum refusal mutes "% over"', async () => {
    const api = await linked();
    renderApp({ api, path: '/finances/rules' });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('When the merchant contains'), 'store c');
    await user.selectOptions(screen.getByLabelText('Sort into'), 'split');
    await user.clear(screen.getByLabelText('Part 1 percent'));
    await user.type(screen.getByLabelText('Part 1 percent'), '80');
    await user.clear(screen.getByLabelText('Part 2 percent'));
    await user.type(screen.getByLabelText('Part 2 percent'), '40');
    const over = () => screen.getByText('20% over').className;
    expect(over()).toMatch(/text-danger/);
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByRole('alert').textContent).toMatch(/add up to 120%/);
    expect(over()).toMatch(/text-ink-muted/);
    await user.click(screen.getByRole('button', { name: 'Add part' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Part 3 percent')),
    );
    await user.click(screen.getByRole('button', { name: 'Remove part 2' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Part 2 bucket')),
    );
  });

  it('Add part adds a third percent, and an edit clears a refusal', async () => {
    const api = await linked();
    renderApp({ api, path: '/finances/rules' });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('When the merchant contains'), 'store b');
    await user.selectOptions(screen.getByLabelText('Sort into'), 'split');
    await user.click(screen.getByRole('button', { name: 'Add part' }));
    expect((screen.getByLabelText('Part 3 bucket') as HTMLSelectElement).value).toBe('i_pay');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByRole('alert').textContent).toMatch(/whole percent/);
    await user.type(screen.getByLabelText('Part 3 percent'), '1');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
