import { useState } from 'react';
import type { FinanceAccount, FinanceItem, FinanceOverview } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Menu } from '../../components/Menu';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import {
  useRemovePlaidItem,
  useRequestFinanceSync,
  useUpdateFinanceAccount,
} from '../../data/hooks/useFinances';
import { fmtAgo } from './ago';
import { fmtMoney } from './money';
import { ConnectButton } from './ConnectButton';
import type { useBankLink } from './useBankLink';

type BankLink = ReturnType<typeof useBankLink>;

// Balances, sync freshness + Refresh, the reconnect banner, and per-account controls (flip the sign
// convention, hide from totals). Removing a bank lives here too, behind a confirm.
export function AccountsStrip({ overview, link }: { overview: FinanceOverview; link: BankLink }) {
  const needsLogin = overview.items.filter(
    (i) => i.status === 'login_required' || i.status === 'pending_disconnect',
  );
  return (
    <section aria-label="Accounts" className="flex flex-col gap-2">
      {needsLogin.map((item) => (
        <div
          key={item.id}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-gold bg-gold-soft px-4 py-2"
        >
          <Text size="sm">
            {item.institutionName} needs you to sign in again — syncing is paused until you do.
          </Text>
          <Button
            size="sm"
            variant="gold"
            disabled={link.busy}
            onClick={() => link.start({ mode: 'update', itemId: item.id })}
          >
            Reconnect
          </Button>
        </div>
      ))}
      {overview.items.map((item) => (
        <ItemAccounts
          key={item.id}
          item={item}
          accounts={overview.accounts.filter((a) => a.itemId === item.id)}
          link={link}
        />
      ))}
      <SyncLine overview={overview} link={link} />
    </section>
  );
}

function ItemAccounts({
  item,
  accounts,
  link,
}: {
  item: FinanceItem;
  accounts: FinanceAccount[];
  link: BankLink;
}) {
  const remove = useRemovePlaidItem();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Text size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
          {item.institutionName}
        </Text>
        <Menu
          label={`More actions for ${item.institutionName}`}
          items={[
            {
              label: 'Add or remove accounts',
              onSelect: () => link.start({ mode: 'update', itemId: item.id }),
            },
            {
              label: `Remove ${item.institutionName}…`,
              onSelect: () => setConfirming(true),
              tone: 'danger',
            },
          ]}
        />
      </div>
      <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5">
        {accounts.map((a) => (
          <AccountChip key={a.id} account={a} />
        ))}
      </div>
      {/* Same alertdialog strip as other destructive actions — no UI undo, so it asks first. */}
      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Remove ${item.institutionName}?`}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
        >
          <Text size="sm" tone="muted">
            Remove {item.institutionName}? Syncing stops and its accounts leave your totals; sorted
            history is kept. Plaid&apos;s free plan doesn&apos;t give the slot back — relinking uses
            a new one (10 total).
          </Text>
          <Button
            autoFocus
            variant="gold"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(item.id)}
          >
            Remove
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function AccountChip({ account: a }: { account: FinanceAccount }) {
  const update = useUpdateFinanceAccount();
  const credit = a.type === 'credit';
  const flipped = a.signOverride === 'flip';
  return (
    <div
      className={cx(
        'flex min-w-[11rem] shrink-0 items-start justify-between gap-2 rounded-2xl border border-line bg-panel px-3 py-2',
        a.hidden && 'border-dashed',
      )}
    >
      <div className="flex min-w-0 flex-col">
        <Text size="sm" className="truncate">
          {a.name} <Text tone="muted">••{a.mask}</Text>
        </Text>
        <Text size="sm" tabular tone={a.hidden ? 'muted' : 'ink'}>
          {a.currentCents === null ? '—' : fmtMoney(a.currentCents)}
          {credit && a.currentCents !== null ? ' owed' : ''}
        </Text>
        {(a.hidden || flipped) && (
          <Text size="xs" tone="muted">
            {[a.hidden && 'hidden from totals', flipped && 'amounts flipped']
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
      </div>
      <Menu
        label={`More actions for ${a.name}`}
        items={[
          {
            label: flipped ? 'Un-flip amounts' : 'Flip amounts (charges show as income)',
            onSelect: () =>
              update.mutate({ id: a.id, patch: { signOverride: flipped ? 'auto' : 'flip' } }),
          },
          {
            label: a.hidden ? 'Show in totals' : 'Hide from totals',
            onSelect: () => update.mutate({ id: a.id, patch: { hidden: !a.hidden } }),
          },
        ]}
      />
    </div>
  );
}

function SyncLine({ overview, link }: { overview: FinanceOverview; link: BankLink }) {
  const sync = useRequestFinanceSync();
  const [note, setNote] = useState<string | null>(null);
  const { lastSyncedAt, syncing, lastError, environment } = overview.sync;
  const status = syncing
    ? 'Syncing…'
    : lastSyncedAt === null
      ? 'Not synced yet'
      : `Synced ${fmtAgo(lastSyncedAt, Date.now())}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Text size="xs" tone="muted" aria-live="polite">
        {status}
        {lastError && !syncing ? ` · last attempt failed (${lastError})` : ''}
        {environment === 'sandbox' ? ' · Plaid Sandbox' : ''}
      </Text>
      <Button
        size="sm"
        variant="quiet"
        disabled={syncing || sync.isPending}
        onClick={async () => {
          const r = await sync.mutateAsync(true);
          setNote(
            r.accepted || r.nextAllowedAt === null
              ? null
              : `Asked the bank recently — try again in ${Math.max(1, Math.ceil((r.nextAllowedAt - Date.now()) / 60_000))} min.`,
          );
        }}
      >
        Refresh
      </Button>
      <ConnectButton environment={environment} link={link} label="Add a bank" variant="quiet" />
      {(note ?? link.error) && (
        <Text size="xs" tone="danger" className="basis-full">
          {note ?? link.error}
        </Text>
      )}
    </div>
  );
}
