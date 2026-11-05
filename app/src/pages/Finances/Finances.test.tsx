import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import {
  FINANCE_BUCKETS,
  FIXTURE_INSTITUTION,
  FIXTURE_LINK_ACCOUNTS,
  todayKey,
} from '@aperture/shared';
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

// screen.findAllByRole('button', { name }) narrowed to list rows: the same role + name + visibility check,
// run per <li> whose text matches instead of across the page, which re-ran on every poll (~70–100ms a scan
// on the All tab). Checked identical to the page-wide query at every call site here (2026-10-12).
const findRows = (name: RegExp) =>
  waitFor(
    () => {
      const rows = [...document.querySelectorAll('li')]
        .filter((li) => (li.textContent ?? '').search(name) >= 0)
        .flatMap((li) => within(li).queryAllByRole('button', { name }));
      if (!rows.length) throw new Error(`Unable to find a row button named ${name}`);
      return rows;
    },
    { container: document.body },
  );

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

  it('pressing 4 files a group as Not spending: it leaves the queue, and the budget doesn’t move', async () => {
    const user = userEvent.setup();
    const api = await linked();
    renderApp({ api, path: '/finances' });
    const inv = await group(/^Brokerage, /);
    const before = screen.getByRole('link', { name: /to sort ·/ }).textContent;
    inv.focus();
    await user.keyboard('4');
    await waitFor(() => expect(screen.queryByRole('group', { name: /^Brokerage, / })).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /to sort ·/ }).textContent).not.toBe(before),
    );
    expect(screen.getByText('$600 left')).toBeTruthy();
    const all = await api.listFinanceTransactions({ from: '2000-01-01', to: '2100-01-01' });
    expect(all.find((t) => t.id === 'fx-brokerage')!.bucket).toBe('not_spending');
  });

  it('All lists Not-spending rows under their chip; picking Unsorted in the detail sends one back', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.setFinanceBucket({ ids: ['fx-brokerage'], bucket: 'not_spending' });
    renderApp({ api, path: '/finances/all' });
    const show = await screen.findByRole('group', { name: 'Show' });
    await user.click(within(show).getByRole('button', { name: 'Not spending', pressed: false }));
    const row = await screen.findByRole('button', { name: /Brokerage/ });
    expect(within(row).getByText('Not spending')).toBeTruthy();
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: /Brokerage/ });
    expect(
      within(dialog).getByRole('radio', { name: 'Not spending' }).getAttribute('aria-checked'),
    ).toBe('true');
    await user.click(within(dialog).getByRole('radio', { name: 'Unsorted' }));
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(async () => {
      const all = await api.listFinanceTransactions({ from: '2000-01-01', to: '2100-01-01' });
      expect(all.find((t) => t.id === 'fx-brokerage')!.bucket).toBeNull();
    });
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

  it('a refund of a Not-spending charge says it’s outside every total', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.linkFinanceRefund('fx-refund-1', 'fx-card-8');
    await api.setFinanceBucket({ ids: ['fx-card-8'], bucket: 'not_spending' });
    renderApp({ api, path: '/finances/all' });
    await findRows(/Amazon/);
    await user.click(document.querySelector('[data-txn-id="fx-refund-1"]') as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/Not spending, like its charge — outside every total/),
    ).toBeTruthy();
  });

  it('a transfer-tagged deposit offers Link as a refund, finds the smaller charge, and nets the budget', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.setFinanceBucket({ ids: ['fx-rent'], bucket: 'budget' });
    renderApp({ api, path: '/finances/all' });
    expect(await screen.findByText('$400 over')).toBeTruthy(); // $1,000.00 of rent in Budget
    await user.click((await findRows(/Family/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Money in: Family/ });
    await user.click(within(dialog).getByRole('button', { name: 'Link as a refund' }));
    expect(within(dialog).getByText(/No Family charge found/)).toBeTruthy();
    expect(within(dialog).getByText(/\$0\.50 more than what's left of the charge/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /Link to Roommate/ }));
    expect(await within(dialog).findByText(/Only \$1,000\.00 of it counts/)).toBeTruthy();
    expect(await screen.findByText('$600 left')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    const row = document.querySelector<HTMLElement>('[data-txn-id="fx-reimburse"]')!;
    expect(within(row).getByText(/counts \$1,000\.00/)).toBeTruthy();
    // The charge's detail lists the refund with what it counts.
    const rentRow = (await findRows(/Roommate/)).find((el) => el.dataset.txnId === 'fx-rent')!;
    await user.click(rentRow);
    const charge = await screen.findByRole('dialog', { name: /Roommate/ });
    expect(within(charge).getByText(/Refunded \$1,000\.00 of \$1,000\.00/)).toBeTruthy();
    expect(within(charge).getByText(/\(counts \$1,000\.00\)/)).toBeTruthy();
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
    const row = (await findRows(/Chipotle/))[0]!;
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
    const refundRow = (await findRows(/Amazon.*\+\$34\.99/))[0]!;
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

    const payment = (await findRows(/\+\$745\.18/))[0]!;
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
    const payroll = (await findRows(/Acme Corp/))[0]!;
    await user.click(payroll);
    const dialog = await screen.findByRole('dialog', { name: /^Money in: Acme Corp/ });
    expect(within(dialog).queryByRole('radiogroup', { name: 'Bucket' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Link to/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Link as a refund' }));
    expect(
      await within(dialog).findByText(
        /No likely charge found — search for it above, or it stays money in/,
      ),
    ).toBeTruthy();
  });

  it('a checking refund links to its debit charge and nets the budget', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.setFinanceBucket({ ids: ['fx-safeway'], bucket: 'budget' });
    renderApp({ api, path: '/finances/all' });
    expect(await screen.findByText('$561 left')).toBeTruthy(); // $600 − $38.61
    const refundRow = (await findRows(/Safeway.*\+\$38\.61/))[0]!;
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
    await user.click((await findRows(/Amazon.*\+\$34\.99/))[0]!);
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
    // The Reconnect that opened Link is gone; focus lands on the page's next step, not <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' })),
    );
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
    const row = (await findRows(/Chipotle/))[0]!;
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

  it('Enter in the note saves it and closes, without reopening the row', async () => {
    const user = userEvent.setup();
    const api = await linked();
    const save = vi.spyOn(api, 'setFinanceNote');
    renderApp({ api, path: '/finances/all' });
    const row = (await findRows(/Chipotle/))[0]!;
    const id = row.getAttribute('data-txn-id')!;
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: /Chipotle/ });
    await user.type(within(dialog).getByLabelText('Note'), 'split{Enter}');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-txn-id')).toBe(id));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog', { name: /Chipotle/ })).toBeNull();
    expect(save.mock.calls).toEqual([[id, 'split']]);
  });

  it('closing a detail whose note you didn’t touch never writes the note', async () => {
    const user = userEvent.setup();
    const api = await linked();
    renderApp({ api, path: '/finances/all' });
    const row = (await findRows(/Chipotle/))[0]!;
    const id = row.getAttribute('data-txn-id')!;
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: /Chipotle/ });
    const field = within(dialog).getByLabelText('Note') as HTMLInputElement;
    await api.setFinanceNote(id, 'from elsewhere'); // e.g. an earlier save landing late
    const save = vi.spyOn(api, 'setFinanceNote');
    // Any save refetches the list; the untouched field follows the server.
    await user.click(within(dialog).getByRole('radio', { name: 'I pay' }));
    await waitFor(() => expect(field.value).toBe('from elsewhere'));
    await user.click(within(dialog).getByRole('button', { name: 'Done' })); // Escape runs the same close()
    expect(save).not.toHaveBeenCalled();
    const range = { from: '2000-01-01', to: '2100-01-01' };
    expect((await api.listFinanceTransactions(range)).find((t) => t.id === id)?.note).toBe(
      'from elsewhere',
    );
  });

  // Re-render the list the way a poll or window refocus does: refetch after a change on the server.
  async function refetchAfter(api: ApiClient, change: () => Promise<unknown>) {
    const list = vi.spyOn(api, 'listFinanceTransactions');
    await change();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    focusManager.setFocused(undefined);
  }

  it('after closing, a tap elsewhere ends the row’s claim on focus (Safari focuses nothing)', async () => {
    const user = userEvent.setup();
    const api = await linked();
    renderApp({ api, path: '/finances/all' });
    const row = (await findRows(/Chipotle/))[0]!;
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: /Chipotle/ });
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.activeElement).toBe(row));
    fireEvent.pointerDown(document.body);
    act(() => row.blur());
    const other = (await findRows(/Uber/))[0]!;
    await refetchAfter(api, () => api.setFinanceNote(other.getAttribute('data-txn-id')!, 'x'));
    expect(document.activeElement).not.toBe(row);
  });

  it('a return-to row that can’t take focus hands it to the list', async () => {
    const user = userEvent.setup();
    const api = await linked();
    renderApp({ api, path: '/finances/all' });
    const row = (await findRows(/Chipotle/))[0]!;
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: /Chipotle/ });
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.activeElement).toBe(row));
    act(() => {
      row.blur(); // no tap: the row still claims focus back
      row.setAttribute('disabled', ''); // as when a change makes it a transfer
    });
    const other = (await findRows(/Uber/))[0]!;
    await refetchAfter(api, () => api.setFinanceNote(other.getAttribute('data-txn-id')!, 'x'));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Transactions' }));
  });

  it('arrow presses in the detail save one after another, and the last press is what stays', async () => {
    const user = userEvent.setup();
    const api = await linked();
    const real = api.setFinanceBucket.bind(api);
    const gates: (() => void)[] = [];
    const save = vi.spyOn(api, 'setFinanceBucket').mockImplementation(async (input) => {
      await new Promise<void>((r) => gates.push(r));
      return real(input);
    });
    renderApp({ api, path: '/finances/all' });
    const row = (await findRows(/Uber/))[0]!;
    const id = row.getAttribute('data-txn-id')!;
    await user.click(row);
    const dialog = await screen.findByRole('dialog', { name: /Uber/ });
    const unsorted = within(dialog).getByRole('radio', { name: 'Unsorted' });
    await waitFor(() => expect(document.activeElement).toBe(unsorted));
    await user.keyboard('{ArrowRight}{ArrowRight}'); // wraps to Parents pay, then Budget
    const budget = within(dialog).getByRole('radio', { name: 'Budget' });
    expect(budget.getAttribute('aria-checked')).toBe('true'); // shown at once
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(save).toHaveBeenCalledTimes(1); // the second waits for the first
    gates.shift()!();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(budget.getAttribute('aria-checked')).toBe('true'); // no flash back to Parents pay
    gates.shift()!();
    const range = { from: '2000-01-01', to: '2100-01-01' };
    await waitFor(async () =>
      expect((await api.listFinanceTransactions(range)).find((t) => t.id === id)?.bucket).toBe(
        'budget',
      ),
    );
    await waitFor(() => expect(budget.getAttribute('aria-checked')).toBe('true'));
  });

  it('the detail opens on the checked bucket, and arrow keys move and select', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    await user.click((await findRows(/Uber/))[0]!);
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

  it('against a backend still syncing, a banner Try again leaves focus on a busy Refresh', async () => {
    const user = userEvent.setup();
    const api = await linked();
    // The real backend syncs later, so the page sees `syncing: true` first. The stub syncs inline;
    // hold the overview in that state once Try again is pressed.
    let hold = false;
    const real = api.getFinanceOverview.bind(api);
    vi.spyOn(api, 'getFinanceOverview').mockImplementation(async (a) => {
      const o = await real(a);
      return hold ? { ...o, sync: { ...o.sync, syncing: true } } : o;
    });
    renderApp({ api, path: '/finances' });
    await screen.findByText(/since your .* payment/);
    localStorage.setItem(STUB_FAIL_NEXT_SYNC_KEY, 'INSTITUTION_NOT_RESPONDING');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync didn’t finish' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    const again = await screen.findByRole('button', { name: 'Try again' });
    await waitFor(() => expect(document.activeElement).toBe(again));
    hold = true;
    await user.click(again);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    await waitFor(() => expect(document.activeElement).toBe(refresh));
    expect(refresh.getAttribute('aria-disabled')).toBe('true');
    const ask = vi.spyOn(api, 'requestFinanceSync');
    await user.click(refresh); // busy: does nothing
    expect(ask).not.toHaveBeenCalled();
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
    expect(document.activeElement).toBe(input);
    await user.selectOptions(screen.getByLabelText('Sort into'), 'budget');
    expect(screen.queryByText(/already sorts/)).toBeNull(); // the note no longer describes the form
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

describe('Refund link search', () => {
  const searchBox = (dialog: HTMLElement) =>
    within(dialog).getByRole('searchbox', { name: 'Search charges to link' });

  it('the search box sits above the list, so typing never moves it', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    await user.click((await findRows(/Amazon.*\+\$34\.99/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Refund: Amazon/ });
    const box = searchBox(dialog);
    expect(within(dialog).getByText(/Refund of which Amazon charge/)).toBeTruthy();
    expect(box.previousElementSibling).toBeNull(); // nothing above it that typing could remove
    await user.type(box, 'chip');
    expect(within(dialog).queryByText(/Refund of which Amazon charge/)).toBeNull();
    expect(box.previousElementSibling).toBeNull();
  });

  it('a card credit links to a charge the suggestions never offered', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    await user.click((await findRows(/Amazon.*\+\$34\.99/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Refund: Amazon/ });
    expect(
      within(dialog).getAllByRole('button', { name: /Link to Amazon/ }).length,
    ).toBeGreaterThan(0);
    await user.type(searchBox(dialog), 'chipotle');
    // The suggestions give way to the results; a $12.45 charge is far past the 10% the suggestions allow.
    expect(within(dialog).queryByRole('button', { name: /Link to Amazon/ })).toBeNull();
    const chipotle = within(dialog).getAllByRole('button', { name: /Link to Chipotle .*\$12\.45/ });
    expect(within(dialog).getAllByText(/\$22\.54 more than what's left of the charge/).length).toBe(
      chipotle.length,
    );
    await user.click(chipotle[0]!);
    expect(await within(dialog).findByText(/it follows the charge/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(await within(dialog).findByRole('radiogroup', { name: 'Bucket' })).toBeTruthy();
  });

  it('a deposit links past the 10% bound and counts only the charge', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.setFinanceBucket({ ids: ['fx-safeway'], bucket: 'budget' });
    renderApp({ api, path: '/finances/all' });
    expect(await screen.findByText('$561 left')).toBeTruthy(); // $600 − $38.61
    await user.click((await findRows(/Family/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Money in: Family/ });
    await user.click(within(dialog).getByRole('button', { name: 'Link as a refund' }));
    expect(within(dialog).queryByRole('button', { name: /Link to Safeway/ })).toBeNull();
    await user.type(searchBox(dialog), 'SAFEWAY');
    await user.click(within(dialog).getByRole('button', { name: /Link to Safeway/ }));
    expect(await within(dialog).findByText(/Only \$38\.61 of it counts/)).toBeTruthy();
    expect(await screen.findByText('$600 left')).toBeTruthy();
  });

  it('Escape clears the search and brings the suggestions back without taking focus from the box', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    await user.click((await findRows(/Family/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Money in: Family/ });
    // Opened by hand, so its best Link takes focus — and would again when the suggestions come back.
    await user.click(within(dialog).getByRole('button', { name: 'Link as a refund' }));
    const box = searchBox(dialog);
    await user.type(box, 'zzz');
    expect(within(dialog).getByText('No charge matches “zzz”.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Link to/ })).toBeNull();
    await user.keyboard('{Escape}');
    expect((box as HTMLInputElement).value).toBe('');
    expect(within(dialog).getByRole('button', { name: /Link to Roommate/ })).toBeTruthy();
    expect(document.activeElement).toBe(box);
    // That the dialog stays open is a browser check: jsdom never turns Escape into a dialog cancel.
  });

  it('a charge a linked deposit already paid back in full is not offered', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.linkFinanceRefund('fx-reimburse', 'fx-safeway');
    renderApp({ api, path: '/finances/all' });
    await user.click((await findRows(/Amazon.*\+\$34\.99/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Refund: Amazon/ });
    await user.type(searchBox(dialog), 'safeway');
    expect(within(dialog).getByText('No charge matches “safeway”.')).toBeTruthy();
  });

  it('money in with no likely charge can still search, by name or amount, and Cancel', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    await user.click((await findRows(/Acme Corp/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Money in: Acme Corp/ });
    const trigger = within(dialog).getByRole('button', { name: 'Link as a refund' });
    await user.click(trigger);
    expect(within(dialog).getByText(/No likely charge found/)).toBeTruthy();
    await user.type(searchBox(dialog), 'target');
    expect(within(dialog).getByText(/^\d+ charges?$/)).toBeTruthy();
    const targets = within(dialog).getAllByRole('button', { name: /^Link to/ });
    expect(targets.every((b) => /^Link to Target /.test(b.getAttribute('aria-label')!))).toBe(true);
    await user.clear(searchBox(dialog));
    await user.type(searchBox(dialog), '$26.89');
    expect(
      within(dialog)
        .getAllByRole('button', { name: /^Link to/ })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(targets.map((b) => b.getAttribute('aria-label')));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: 'Link as a refund' }),
      ),
    );
  });

  it('Unlink on a card credit with no suggestions focuses Bucket', async () => {
    const user = userEvent.setup();
    const api = await linked();
    await api.linkFinanceRefund('fx-refund-2', 'fx-card-12'); // the $10 Target credit, on a Target charge
    // Seen as −$5,000 nothing has that much left, so neither pass offers a charge: by merchant or by size.
    const list = api.listFinanceTransactions.bind(api);
    api.listFinanceTransactions = async (range) =>
      (await list(range)).map((t) =>
        t.id === 'fx-refund-2' ? { ...t, rawAmountCents: -500_000 } : t,
      );
    renderApp({ api, path: '/finances/all' });
    await user.click((await findRows(/Target.*\+\$5,000/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Refund: Target/ });
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    const bucket = await within(dialog).findByRole('radiogroup', { name: 'Bucket' });
    expect(within(dialog).getByText(/No likely charge found/)).toBeTruthy();
    // No Link row and no Cancel: focus lands on the checked option, not <body> and not the search box.
    const unsorted = within(bucket).getByRole('radio', { name: 'Unsorted' });
    await waitFor(() => expect(document.activeElement).toBe(unsorted));
    await user.keyboard('{ArrowRight}'); // wraps to the first bucket — the next thing you'd do
    await waitFor(async () =>
      expect(
        (await list({ from: '2000-01-01', to: '2100-01-01' })).find((t) => t.id === 'fx-refund-2')!
          .bucket,
      ).toBe(FINANCE_BUCKETS[0]),
    );
  });

  it('a search row keeps the merchant on one line and the bucket on its own', async () => {
    const user = userEvent.setup();
    const api = await linked();
    // Every Target charge in Budget, the newest with $10 of it already refunded — the first search row.
    const targets = (await api.listFinanceTransactions({ from: '2000-01-01', to: '2100-01-01' }))
      .filter((t) => t.merchantName === 'Target' && t.rawAmountCents > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
    await api.setFinanceBucket({ ids: targets.map((t) => t.id), bucket: 'budget' });
    await api.linkFinanceRefund('fx-refund-2', targets[0]!.id);
    renderApp({ api, path: '/finances/all' });
    await user.click((await findRows(/Amazon.*\+\$34\.99/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Refund: Amazon/ });
    await user.type(searchBox(dialog), 'target');
    const first = within(dialog).getAllByRole('button', { name: /^Link to Target/ })[0]!;
    const row = first.closest('li')!;
    expect(within(row).getByText('Target').textContent).toBe('Target'); // the merchant alone
    const meta = within(row).getByText('Budget · $10.00 already refunded');
    expect(meta.className).toMatch(/\bw-full\b/); // its own line under the merchant
  });

  it('a broad search shows eight and says how many more', async () => {
    const user = userEvent.setup();
    renderApp({ api: await linked(), path: '/finances/all' });
    await user.click((await findRows(/Amazon.*\+\$34\.99/))[0]!);
    const dialog = await screen.findByRole('dialog', { name: /^Refund: Amazon/ });
    await user.type(searchBox(dialog), 'a');
    expect(within(dialog).getByText(/^Showing 8 of \d+ — add a word to narrow it\.$/)).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: /^Link to/ })).toHaveLength(8);
  });
});

describe('All tab: sort into and search', () => {
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-txn-id="${id}"]`);
  const ids = () =>
    [...document.querySelectorAll<HTMLElement>('[data-txn-id]')].map((el) => el.dataset.txnId);
  const brushBtn = (name: string) =>
    within(screen.getByRole('group', { name: 'Sort into' })).getByRole('button', {
      name: new RegExp(name),
    });
  const showChip = (name: string) =>
    within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name });
  const bucketOnServer = async (api: ApiClient, id: string) =>
    (await api.listFinanceTransactions({ from: '2000-01-01', to: '2100-01-01' })).find(
      (t) => t.id === id,
    )!.bucket;
  const openAll = async (prepare?: (api: ApiClient) => Promise<unknown>) => {
    const api = await linked();
    await prepare?.(api);
    renderApp({ api, path: '/finances/all' });
    await screen.findByRole('group', { name: 'Sort into' });
    return api;
  };

  it('arming a bucket makes a tap sort the row instead of opening it', async () => {
    const user = userEvent.setup();
    const api = await openAll();
    await user.click(brushBtn('Budget'));
    expect(brushBtn('Budget').getAttribute('aria-pressed')).toBe('true');
    expect(showChip('Budget').getAttribute('aria-pressed')).toBe('false'); // a different control
    expect(document.getElementById('ledger-brush-hint')?.textContent).toMatch(
      /^Sorting into Budget/,
    );
    await user.click(row('fx-card-2')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(async () => expect(await bucketOnServer(api, 'fx-card-2')).toBe('budget'));
    expect(within(row('fx-card-2')!).getByText('Budget')).toBeTruthy();
  });

  it('painted rows stay put under an Unsorted filter until you stop', async () => {
    const user = userEvent.setup();
    const api = await openAll();
    await user.click(showChip('Unsorted'));
    await user.keyboard('2');
    const before = ids();
    await user.click(row('fx-card-2')!);
    await user.click(row('fx-card-4')!);
    await waitFor(async () => expect(await bucketOnServer(api, 'fx-card-4')).toBe('budget'));
    expect(ids()).toEqual(before);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(row('fx-card-2')).toBeNull());
    expect(row('fx-card-4')).toBeNull();
    expect(brushBtn('Budget').getAttribute('aria-pressed')).toBe('false');
  });

  it('Enter paints the focused row; Escape stops and keeps focus on a row', async () => {
    const user = userEvent.setup();
    const api = await openAll();
    await user.click(showChip('Unsorted'));
    await user.keyboard('3');
    row('fx-card-2')!.focus();
    await user.keyboard('{Enter}');
    await waitFor(async () => expect(await bucketOnServer(api, 'fx-card-2')).toBe('i_pay'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(row('fx-card-2')).toBeNull());
    expect(document.activeElement?.hasAttribute('data-txn-id')).toBe(true);
  });

  it('rows that can’t take a bucket go inert while armed', async () => {
    const user = userEvent.setup();
    const api = await openAll();
    const spy = vi.spyOn(api, 'setFinanceBucket');
    await user.click(brushBtn('Parents pay'));
    const payroll = row('fx-pay-3')!;
    expect(payroll.getAttribute('aria-disabled')).toBe('true');
    await user.click(payroll);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('tapping a row again with the same brush sets it back to Unsorted', async () => {
    const user = userEvent.setup();
    const api = await openAll();
    await user.click(brushBtn('Budget'));
    await user.click(row('fx-card-2')!);
    await user.click(row('fx-card-2')!);
    await waitFor(async () => expect(await bucketOnServer(api, 'fx-card-2')).toBeNull());
    expect(within(row('fx-card-2')!).getByText('Unsorted')).toBeTruthy();
  });

  it('number keys toggle the brush, but not while typing in search', async () => {
    const user = userEvent.setup();
    await openAll();
    await user.keyboard('3');
    expect(brushBtn('I pay').getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('3');
    expect(brushBtn('I pay').getAttribute('aria-pressed')).toBe('false');
    await user.keyboard('12');
    expect(brushBtn('Budget').getAttribute('aria-pressed')).toBe('true');
    expect(brushBtn('Parents pay').getAttribute('aria-pressed')).toBe('false');
    await user.keyboard('{Escape}');
    const search = screen.getByRole('searchbox', { name: 'Search transactions' });
    await user.type(search, 'chipotle 2');
    expect((search as HTMLInputElement).value).toBe('chipotle 2');
    expect(brushBtn('Budget').getAttribute('aria-pressed')).toBe('false');
  });

  it('"/" focuses search here, not capture; Escape clears it, then stops the brush', async () => {
    const user = userEvent.setup();
    await openAll();
    const search = screen.getByRole('searchbox', { name: 'Search transactions' });
    await user.keyboard('1');
    await user.keyboard('/');
    expect(document.activeElement).toBe(search);
    await user.keyboard('uber');
    await user.keyboard('{Escape}');
    expect((search as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(search);
    expect(brushBtn('Parents pay').getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{Escape}');
    expect(brushBtn('Parents pay').getAttribute('aria-pressed')).toBe('false');
  });

  it('search matches merchant, bank text and note, combines with Show, and sums what’s shown', async () => {
    const user = userEvent.setup();
    const api = await openAll((a) => a.setFinanceNote('fx-card-6', 'split with sam'));
    const search = screen.getByRole('searchbox', { name: 'Search transactions' });
    expect(screen.queryByText(/\d+ rows? · /)).toBeNull(); // nothing narrowed, no summary
    await user.type(search, 'chipotle');
    const shown = ids();
    expect(shown).toContain('fx-card-2'); // merchant
    expect(shown.some((id) => id !== undefined && /^fx-card-(b-)?\d+$/.test(id))).toBe(true);
    const txns = await api.listFinanceTransactions({ from: '2000-01-01', to: '2100-01-01' });
    // DoorDash's descriptor is "DD *DOORDASH CHIPOTLE" — the bank text matches too.
    const doordash = txns.filter((t) => t.merchantName === 'DoorDash').map((t) => t.id);
    expect(shown.some((id) => doordash.includes(id!))).toBe(true);
    expect(screen.getByText(new RegExp(`^${shown.length} rows · \\$`))).toBeTruthy();
    await user.click(showChip('Budget'));
    await waitFor(() => expect(ids()).toEqual([]));
    await user.click(showChip('All'));
    await user.clear(search);
    await waitFor(() => expect(row('fx-card-6')).toBeTruthy());
    await user.type(search, 'sam');
    await waitFor(() => expect(ids()).toEqual(['fx-card-6']));
    expect(screen.getByText(/^1 row · /)).toBeTruthy();
  });

  it('a refund linked to a charge from before last period stays listed, and can be unlinked', async () => {
    const user = userEvent.setup();
    // fx-card-50 is from before last period: the deposit follows it out of both period lists.
    await openAll((a) => a.linkFinanceRefund('fx-reimburse', 'fx-card-50'));
    const followed = await screen.findByRole('region', { name: 'Linked to older charges' });
    expect(within(followed).getByText(/Family/)).toBeTruthy();
    // Only what was moved out — not every older row.
    expect(row('fx-card-50')).toBeNull();
    // The Show chip and the search narrow it like any section, and it counts in the summary.
    await user.click(showChip('Budget'));
    await waitFor(() => expect(row('fx-reimburse')).toBeNull());
    await user.click(showChip('All'));
    await user.type(screen.getByRole('searchbox', { name: 'Search transactions' }), 'family');
    await waitFor(() => expect(ids()).toEqual(['fx-reimburse']));
    expect(screen.getByText(/^1 row · /)).toBeTruthy();
    await user.click(row('fx-reimburse')!);
    const dialog = await screen.findByRole('dialog', { name: /^Money in: Family/ });
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(await within(dialog).findByRole('button', { name: 'Link as a refund' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    // Unlinked, it's back in its own period.
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Linked to older charges' })).toBeNull(),
    );
    expect(row('fx-reimburse')).toBeTruthy();
  });

  it('changing the search ends the painted rows’ stay, and the detail opens again once stopped', async () => {
    const user = userEvent.setup();
    const api = await openAll();
    await user.click(showChip('Unsorted'));
    await user.click(brushBtn('Budget'));
    await user.click(row('fx-card-2')!);
    await waitFor(async () => expect(await bucketOnServer(api, 'fx-card-2')).toBe('budget'));
    await user.type(screen.getByRole('searchbox', { name: 'Search transactions' }), 'c');
    await waitFor(() => expect(row('fx-card-2')).toBeNull());
    // jsdom focuses a clicked button, so Done hands focus to its toggle here; Safari focuses nothing on
    // a tap, so there the plan never runs and focus stays where the tap left it.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(brushBtn('Budget'));
    await user.click(row('fx-card-4')!);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('All tab: a failed paint', () => {
  it('still alerts after the row left the list, and the row goes back to what’s saved', async () => {
    const user = userEvent.setup();
    const api = await linked();
    let reject!: (e: Error) => void;
    vi.spyOn(api, 'setFinanceBucket').mockImplementation(
      () => new Promise((_, rej) => (reject = rej)),
    );
    renderApp({ api, path: '/finances/all' });
    const show = await screen.findByRole('group', { name: 'Show' });
    await user.click(within(show).getByRole('button', { name: 'Unsorted' }));
    await user.keyboard('2');
    const painted = document.querySelector<HTMLElement>('[data-txn-id="fx-card-2"]')!;
    await user.click(painted);
    await user.keyboard('{Escape}'); // the brush is down: the painted row leaves the Unsorted list
    await waitFor(() => expect(document.querySelector('[data-txn-id="fx-card-2"]')).toBeNull());
    await act(async () => reject(new Error('offline')));
    expect(await screen.findByText(/Couldn.t save that sort/)).toBeTruthy();
    // The refetch puts it back where the server has it: unsorted, so listed again.
    await waitFor(() => expect(document.querySelector('[data-txn-id="fx-card-2"]')).toBeTruthy());
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
