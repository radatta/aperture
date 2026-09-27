import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_INSTITUTION, FIXTURE_LINK_ACCOUNTS, todayKey } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());

const fresh = () => createStubClient({ seed: false, storageKey: `fin-${Math.random()}` });

async function linked(): Promise<ApiClient> {
  const api = fresh();
  await api.exchangePlaidPublicToken({
    publicToken: 'p',
    institution: FIXTURE_INSTITUTION,
    accounts: FIXTURE_LINK_ACCOUNTS,
  });
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
    expect(screen.getByText(/since the last card payment/)).toBeTruthy();
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
