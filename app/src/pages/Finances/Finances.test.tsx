import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_INSTITUTION, FIXTURE_LINK_ACCOUNTS, todayKey } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient, STUB_FAIL_NEXT_SYNC_KEY } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

const fresh = () => createStubClient({ seed: false, storageKey: `fin-${Math.random()}` });

async function linkedBare(): Promise<ApiClient> {
  const api = fresh();
  await api.exchangePlaidPublicToken({
    publicToken: 'p',
    institution: FIXTURE_INSTITUTION,
    accounts: FIXTURE_LINK_ACCOUNTS,
  });
  return api;
}

// Both fixture card payments marked, so the period is today−8 onward whatever the calendar says.
async function linked(): Promise<ApiClient> {
  const api = await linkedBare();
  for (const id of ['fx-ccpay-card-40', 'fx-ccpay-card-10'])
    await api.setFinancePeriodStart(id, true);
  return api;
}

const group = async (name: RegExp) => (await screen.findAllByRole('group', { name }))[0]!;

describe('Finances page', () => {
  it('is reachable from the nav', async () => {
    renderApp({ path: '/' });
    expect(await screen.findByRole('link', { name: 'Finances' })).toBeTruthy();
  });

  it('shows the connect empty state with no bank, and links through the fake Link', async () => {
    const user = userEvent.setup();
    renderApp({ api: fresh(), path: '/finances' });
    expect(await screen.findByText('No bank connected.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Connect a bank' }));
    const dialog = await screen.findByRole('dialog', { name: /Connect a bank/ });
    // Untick savings — only the ticked accounts should come through.
    await user.click(within(dialog).getByRole('checkbox', { name: /Advantage Savings/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/left$/)).toBeTruthy();
    const accounts = screen.getByRole('region', { name: 'Accounts' });
    expect(within(accounts).getByText(/Adv Plus Banking/)).toBeTruthy();
    expect(within(accounts).queryByText(/Advantage Savings/)).toBeNull();
  });

  it('shows "$X left of $600" and the unsorted count', async () => {
    renderApp({ api: await linked(), path: '/finances' });
    expect(await screen.findByText('$600 left')).toBeTruthy();
    expect(screen.getByText('of $600 budget')).toBeTruthy();
    expect(screen.getByText(/since your .* payment/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /to sort ·/ })).toBeTruthy();
  });

  it('pressing 2 on a focused group files it under Budget and moves focus to the next group', async () => {
    const user = userEvent.setup();
    const api = await linked();
    renderApp({ api, path: '/finances' });
    const first = await group(/charges?, \$/);
    const label = first.getAttribute('aria-label')!;
    const before = screen.getByRole('link', { name: /to sort ·/ }).textContent;
    first.focus();
    await user.keyboard('2');
    await waitFor(() => expect(screen.queryByRole('group', { name: label })).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toMatch(/charges?, \$/),
    );
    // The header's unsorted count moved with it.
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /to sort ·/ }).textContent).not.toBe(before),
    );
    const sorted = (
      await api.listFinanceTransactions({ from: '2000-01-01', to: '2100-01-01' })
    ).filter((t) => t.bucket === 'budget');
    expect(sorted.length).toBeGreaterThan(0);
  });

  it('clicking a charge in the sort queue opens its detail, and sorting there clears the group', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances' });
    const uber = await group(/^Uber, /);
    const label = uber.getAttribute('aria-label')!;
    const rows = within(uber).getAllByRole('button', { name: /UBER/ });
    await user.click(rows[0]!);
    const dialog = await screen.findByRole('dialog', { name: /Uber/ });
    await user.click(within(dialog).getByRole('radio', { name: 'I pay' }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    if (rows.length === 1)
      await waitFor(() => expect(screen.queryByRole('group', { name: label })).toBeNull());
    else await waitFor(() => expect(screen.getByRole('group', { name: /^Uber, / })).toBeTruthy());
  });

  it('a failed sort says so instead of silently snapping back', async () => {
    const user = userEvent.setup();
    const api = await linked();
    vi.spyOn(api, 'setFinanceBucket').mockRejectedValue(new Error('offline'));
    renderApp({ api, path: '/finances' });
    const first = await group(/charges?, \$/);
    first.focus();
    await user.keyboard('1');
    expect(await screen.findByText(/Couldn.t save that sort/)).toBeTruthy();
  });

  it('"Always" saves a rule for the merchant', async () => {
    const user = userEvent.setup();
    const api = await linked();
    renderApp({ api, path: '/finances' });
    const uber = await group(/^Uber, /);
    await user.click(within(uber).getByRole('checkbox', { name: 'Always' }));
    expect(within(uber).getByText(/anything matching “uber”/)).toBeTruthy();
    await user.click(within(uber).getByRole('button', { name: /I pay/ }));
    await waitFor(async () =>
      expect((await api.listFinanceRules()).map((r) => r.pattern)).toEqual(['uber']),
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: /^Uber, / })).toBeNull());
  });

  it('a period override in the detail changes the header total', async () => {
    const user = userEvent.setup();
    const api = await linked();
    const o = await api.getFinanceOverview({ today: todayKey(4) });
    const txns = await api.listFinanceTransactions({ from: o.period.start, to: o.period.end });
    const target = txns.find((t) => t.merchantName === 'Chipotle')!;
    await api.setFinanceBucket({ ids: [target.id], bucket: 'budget' });
    renderApp({ api, path: '/finances/all' });
    expect(await screen.findByText('$587 left')).toBeTruthy(); // $600 - $12.45
    const row = (await screen.findAllByRole('button', { name: /Chipotle/ }))[0]!;
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: /Chipotle/ });
    await user.click(within(dialog).getByRole('radio', { name: 'Last period' }));
    expect(await screen.findByText('$600 left')).toBeTruthy();
  });

  it('shows the reconnect banner when the bank needs a login', async () => {
    const api = await linked();
    const o = await api.getFinanceOverview({ today: todayKey(4) });
    // The stub has no failure path through the interface, so make the overview report one.
    const patched = {
      ...o,
      items: o.items.map((i) => ({ ...i, status: 'login_required' as const })),
    };
    api.getFinanceOverview = async () => patched;
    renderApp({ api, path: '/finances' });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/needs you to sign in again/)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('links a refund to its charge from the detail, and unlinks it back into the queue', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.setFinanceBucket({ ids: ['fx-card-8'], bucket: 'budget' });
    renderApp({ api, path: '/finances/all' });
    expect(await screen.findByText('$565 left')).toBeTruthy(); // $600 − $34.99
    const refundRow = (await screen.findAllByRole('button', { name: /Amazon.*\+\$34\.99/ }))[0]!;
    await user.click(refundRow);
    const dialog = await screen.findByRole('dialog', { name: /Refund: Amazon/ });
    // The best match is the $34.99 Amazon charge — one click.
    const best = within(dialog).getAllByRole('button', { name: /Link to Amazon/ })[0]!;
    expect(best.getAttribute('aria-label')).toMatch(/\$34\.99/);
    await user.click(best);
    expect(await within(dialog).findByText(/it follows the charge/)).toBeTruthy();
    expect(within(dialog).queryByRole('radiogroup', { name: 'Bucket' })).toBeNull();
    expect(await screen.findByText('$600 left')).toBeTruthy(); // netted
    expect(await screen.findByText(/refunded \$34\.99/)).toBeTruthy(); // the charge's row

    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(await within(dialog).findByRole('radiogroup', { name: 'Bucket' })).toBeTruthy();
    expect(await screen.findByText('$565 left')).toBeTruthy();
  });

  it('with no mark, uses the payment day and offers the last card payment as a one-click start', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linkedBare(), path: '/finances/all' });
    expect(await screen.findByText(/using your payment day \(the 20th\)/)).toBeTruthy();
    expect(
      await screen.findByText(/Looks like you paid the card on .* \(\+\$745\.18\)/),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start the period there' }));
    expect(await screen.findByText(/Day 9 · .* since your .* payment/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start the period there' })).toBeNull();

    const payment = (await screen.findAllByRole('button', { name: /\+\$745\.18/ }))[0]!;
    expect(payment.textContent).toMatch(/starts period/);
    await user.click(payment);
    const dialog = await screen.findByRole('dialog', { name: /^Payment: / });
    expect(within(dialog).getByText(/This payment starts a period/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Unmark' }));
    expect(
      await within(dialog).findByRole('button', { name: 'Start the period here' }),
    ).toBeTruthy();
    expect(await screen.findByText(/using your payment day/)).toBeTruthy();
  });

  it('money into checking opens with a collapsed "Link as a refund"', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    const payroll = (await screen.findAllByRole('button', { name: /Acme Corp/ }))[0]!;
    await user.click(payroll);
    const dialog = await screen.findByRole('dialog', { name: /^Money in: Acme Corp/ });
    expect(within(dialog).queryByRole('radiogroup', { name: 'Bucket' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Link to/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Link as a refund' }));
    expect(
      await within(dialog).findByText(/Nothing it could reverse — it stays money in/),
    ).toBeTruthy();
  });

  it('a checking refund links to its debit charge and nets the budget', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.setFinanceBucket({ ids: ['fx-safeway'], bucket: 'budget' });
    renderApp({ api, path: '/finances/all' });
    expect(await screen.findByText('$561 left')).toBeTruthy(); // $600 − $38.61
    const refundRow = (await screen.findAllByRole('button', { name: /Safeway.*\+\$38\.61/ }))[0]!;
    await user.click(refundRow);
    const dialog = await screen.findByRole('dialog', { name: /^Money in: Safeway/ });
    await user.click(within(dialog).getByRole('button', { name: 'Link as a refund' }));
    await user.click(
      (await within(dialog).findAllByRole('button', { name: /Link to Safeway/ }))[0]!,
    );
    expect(await screen.findByText('$600 left')).toBeTruthy();
    expect(await screen.findByText(/refunded \$38\.61/)).toBeTruthy();
  });

  it('a card credit can be marked as the period start from its detail, and unmarked', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    await user.click((await screen.findAllByRole('button', { name: /Amazon.*\+\$34\.99/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Refund: Amazon/ });
    await user.click(
      within(dialog).getByRole('button', { name: /card payment — start the period here/ }),
    );
    const unmark = await within(dialog).findByRole('button', { name: 'Unmark' });
    await waitFor(() => expect(document.activeElement).toBe(unmark));
    expect(within(dialog).queryByRole('radiogroup', { name: 'Bucket' })).toBeNull();
    expect(await screen.findByText(/since your .* payment/)).toBeTruthy();
    await user.click(unmark);
    // Unmarked, it's a card credit again: the refund controls and the mark option come back.
    expect(
      await within(dialog).findByRole('button', { name: /card payment — start the period here/ }),
    ).toBeTruthy();
    expect(within(dialog).getByRole('radiogroup', { name: 'Bucket' })).toBeTruthy();
  });

  it('a linked refund leaves the sort queue and nets its group', async () => {
    const api = await linked();
    await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
    renderApp({ api, path: '/finances' });
    // The refund rides on its charge, and the charge it cancels in full nets to $0 — neither is asked
    // about. The older Amazon charge (last period) still is.
    const amazon = await group(/^Amazon, 1 charge,/);
    expect(within(amazon).queryByText(/\+\$34\.99/)).toBeNull();
    expect(within(amazon).queryByText(/refunded/)).toBeNull();
  });

  it('a Refresh that fails pops "Sync didn’t finish", and Try again clears it', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances' });
    await screen.findByText(/since your .* payment/);
    localStorage.setItem(STUB_FAIL_NEXT_SYNC_KEY, 'INSTITUTION_NOT_RESPONDING');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync didn’t finish' });
    expect(within(dialog).getByText('Bank of America isn’t responding right now.')).toBeTruthy();
    expect(within(dialog).getByText(/Nothing changed — last synced/)).toBeTruthy();
    // The banner carries it behind the dialog, too.
    const banner = screen
      .getAllByRole('alert')
      .find((a) => /isn’t responding/.test(a.textContent ?? ''));
    expect(banner).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Sync didn/ })).toBeNull());
    await waitFor(() => expect(screen.queryByText(/isn’t responding/)).toBeNull());
  });

  it('a failure you didn’t start shows only the banner', async () => {
    const api = await linked();
    localStorage.setItem(STUB_FAIL_NEXT_SYNC_KEY, 'INSTITUTION_DOWN');
    await api.requestFinanceSync({ refresh: false }); // a scheduled run, as far as the page knows
    renderApp({ api, path: '/finances' });
    expect(await screen.findByText(/Bank of America is down right now\. Last synced/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: /Sync didn/ })).toBeNull();
  });

  it('a login failure offers Reconnect, which fixes the login and syncs', async () => {
    const user = userEvent.setup();
    const api = await linked();
    renderApp({ api, path: '/finances' });
    await screen.findByText(/since your .* payment/);
    localStorage.setItem(STUB_FAIL_NEXT_SYNC_KEY, 'ITEM_LOGIN_REQUIRED');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync didn’t finish' });
    expect(within(dialog).getByText('Bank of America needs you to sign in again.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Reconnect' }));
    const link = await screen.findByRole('dialog', { name: /Connect a bank/ });
    await user.click(within(link).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.queryByText(/needs you to sign in again/)).toBeNull());
    expect((await api.getFinanceOverview({ today: todayKey(4) })).items[0]!.status).toBe('ok');
  });

  it('a first sync that fails right after connecting says nothing has synced yet', async () => {
    const user = userEvent.setup();
    renderApp({ api: fresh(), path: '/finances' });
    await user.click(await screen.findByRole('button', { name: 'Connect a bank' }));
    const link = await screen.findByRole('dialog', { name: /Connect a bank/ });
    localStorage.setItem(STUB_FAIL_NEXT_SYNC_KEY, 'INSTITUTION_NOT_RESPONDING');
    await user.click(within(link).getByRole('button', { name: 'Continue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync didn’t finish' });
    expect(within(dialog).getByText(/nothing has synced yet/)).toBeTruthy();
  });

  it('closing an All-tab detail puts focus back on its row — even after it moves section', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    const row = (await screen.findAllByRole('button', { name: /Chipotle/ }))[0]!;
    const id = row.getAttribute('data-txn-id');
    await user.click(row);
    let dialog = await screen.findByRole('dialog', { name: /Chipotle/ });
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('data-txn-id')).toBe(id));

    await user.click(document.activeElement as HTMLElement);
    dialog = await screen.findByRole('dialog', { name: /Chipotle/ });
    await user.click(within(dialog).getByRole('radio', { name: 'Last period' }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('data-txn-id')).toBe(id));
    const previous = screen.getByRole('region', { name: /^Last period/ });
    expect(previous.contains(document.activeElement)).toBe(true);
  });

  it('the detail opens on the checked bucket, and arrow keys move and select', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    await user.click((await screen.findAllByRole('button', { name: /Uber/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /Uber/ });
    const unsorted = within(dialog).getByRole('radio', { name: 'Unsorted' });
    await waitFor(() => expect(document.activeElement).toBe(unsorted));
    expect(
      within(dialog)
        .getAllByRole('radio')
        .filter((r) => r.tabIndex === 0)
        .map((r) => r.textContent),
    ).toEqual(['Unsorted', 'By date']); // one tab stop per group
    await user.keyboard('{ArrowRight}'); // wraps to the first
    const parents = within(dialog).getByRole('radio', { name: 'Parents pay' });
    await waitFor(() => expect(parents.getAttribute('aria-checked')).toBe('true'));
    expect(document.activeElement).toBe(parents);
  });

  it('the Remove-bank confirm starts on Cancel, and Escape backs out to the menu', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances' });
    await user.click(
      await screen.findByRole('button', { name: 'More actions for Bank of America' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /Remove Bank of America/ }));
    const confirm = await screen.findByRole('alertdialog', { name: /Remove Bank of America/ });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'More actions for Bank of America',
      ),
    );
  });

  it('a banner Try again that works hands focus to Refresh, not the page', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances' });
    await screen.findByText(/since your .* payment/);
    localStorage.setItem(STUB_FAIL_NEXT_SYNC_KEY, 'INSTITUTION_NOT_RESPONDING');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync didn’t finish' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    const again = await screen.findByRole('button', { name: 'Try again' });
    await waitFor(() => expect(document.activeElement).toBe(again));
    await user.click(again);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' })),
    );
  });

  it('adding a rule with the button keeps focus in the pattern field', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/rules' });
    const input = await screen.findByLabelText('When the merchant contains');
    await user.type(input, 'Netflix');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    await screen.findByText('“netflix”');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('adding a pattern that already has a rule says what changed (or that nothing did)', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.upsertFinanceRule({ pattern: 'netflix', bucket: 'i_pay' });
    renderApp({ api, path: '/finances/rules' });
    const input = await screen.findByLabelText('When the merchant contains');
    await user.type(input, 'Netflix');
    await user.selectOptions(screen.getByLabelText('Sort into'), 'i_pay');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(await screen.findByText('“netflix” already sorts into I pay.')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Sort into'), 'budget');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(await screen.findByText('Updated “netflix”: Budget (was I pay).')).toBeTruthy();
    expect((await api.listFinanceRules()).map((r) => r.bucket)).toEqual(['budget']);
  });

  it('rules tab adds and lists a rule', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/rules' });
    expect(await screen.findByText('No rules yet.')).toBeTruthy();
    await user.type(screen.getByLabelText('When the merchant contains'), 'Netflix');
    await user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(await screen.findByText('“netflix”')).toBeTruthy();
  });
});

describe('Finance glance on the home', () => {
  it('shows the one-line strip in the morning and the sort count at night', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/' });
    await user.click(await screen.findByRole('button', { name: 'Morning' }));
    expect(await screen.findByText(/\$600 left of \$600 · \d+ to sort/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Night' }));
    expect(await screen.findByText(/\d+ charges to sort/)).toBeTruthy();
  });

  it('renders nothing without a bank', async () => {
    const user = userEvent.setup();
    renderApp({ api: fresh(), path: '/' });
    await user.click(await screen.findByRole('button', { name: 'Morning' }));
    await screen.findByText('Intent');
    expect(screen.queryByText(/left of \$/)).toBeNull();
  });
});
