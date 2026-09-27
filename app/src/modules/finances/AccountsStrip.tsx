import { useEffect, useRef, useState } from 'react';
import { financeSyncErrorMessage } from '@aperture/shared';
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
import { fmtAgo, fmtMinutesUntil, nowMs } from './ago';
import { fmtMoney } from './money';
import { ConnectButton } from './ConnectButton';
import type { BankLink } from './useBankLink';
import type { SyncWatch } from './useSyncWatch';

// Balances, sync freshness + Refresh, the reconnect and sync-failed banners, and per-account controls
// (flip the sign convention, hide from totals). Removing a bank lives here too, behind a confirm.
export function AccountsStrip({
  overview,
  link,
  watch,
}: {
  overview: FinanceOverview;
  link: BankLink;
  watch: SyncWatch;
}) {
  const needsLogin = overview.items.filter(
    (i) => i.status === 'login_required' || i.status === 'pending_disconnect',
  );
  // One banner per bank whose last run failed. A login error is the reconnect banner's job.
  const failed = overview.sync.syncing
    ? []
    : overview.sync.items.filter((s) => s.lastError && s.lastError !== 'ITEM_LOGIN_REQUIRED');
  return (
    <section aria-label="Accounts" className="flex flex-col gap-2">
      {failed.map((s) => (
        <div
          key={s.itemId}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-danger px-4 py-2"
        >
          <Text size="sm">
            {financeSyncErrorMessage(
              s.lastError!,
              overview.items.find((i) => i.id === s.itemId)?.institutionName,
            )}{' '}
            {s.lastSyncedAt === null
              ? 'Nothing has synced yet.'
              : `Last synced ${fmtAgo(s.lastSyncedAt, nowMs())}.`}
          </Text>
          <Button
            size="sm"
            variant="ghost"
            onClick={watch.retry}
            disabled={watch.retrying}
            data-sync-next-step
          >
            Try again
          </Button>
        </div>
      ))}
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
            data-sync-next-step
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
      <SyncLine overview={overview} link={link} watch={watch} />
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
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  // Bring the confirm clear of the dock (the root scroll-padding reserves it) as it opens.
  useEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [confirming]);
  // Cancel unmounts the strip; hand focus back to the menu trigger that opened it.
  function cancel() {
    setConfirming(false);
    requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus(),
    );
  }
  return (
    <div ref={rootRef} className="flex flex-col gap-1.5">
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
      {/* A wrapping grid, not a sideways scroller: each chip's ··· menu drops below it, and an
          overflow container would clip the menu and scroll the strip out from under it. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.map((a) => (
          <AccountChip key={a.id} account={a} />
        ))}
      </div>
      {/* Same alertdialog strip as other destructive actions — no UI undo, so it asks first. Unlike
          the others, focus starts on Cancel: removing a bank is irreversible AND spends a Plaid
          Trial slot, so a stray Enter must not do it. Escape cancels. */}
      {confirming && (
        <div
          ref={confirmRef}
          role="alertdialog"
          aria-label={`Remove ${item.institutionName}?`}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            cancel();
          }}
        >
          <Text size="sm" tone="muted">
            Remove {item.institutionName}? Syncing stops and its accounts leave your totals.
            Plaid&apos;s free plan doesn&apos;t give the slot back: relinking uses a new one (10
            total), and its charges come back as new, unsorted rows.
          </Text>
          <Button autoFocus variant="quiet" size="sm" onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant="gold"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(item.id)}
          >
            Remove
          </Button>
          {remove.isError && (
            <Text size="sm" tone="danger" className="basis-full">
              Couldn&apos;t remove it — try again.
            </Text>
          )}
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
        'flex min-w-0 items-start justify-between gap-2 rounded-2xl border border-line bg-panel px-3 py-2',
        a.hidden && 'border-dashed',
      )}
    >
      <div className="flex min-w-0 flex-col">
        {/* The name truncates, never the mask — the last four digits are how you tell accounts apart. */}
        <span className="flex min-w-0 items-baseline gap-1">
          <Text size="sm" className="truncate">
            {a.name}
          </Text>
          <Text size="sm" tone="muted" className="shrink-0">
            ••{a.mask}
          </Text>
        </span>
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
            label: flipped ? 'Un-flip amounts' : 'Flip amounts',
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

function SyncLine({
  overview,
  link,
  watch,
}: {
  overview: FinanceOverview;
  link: BankLink;
  watch: SyncWatch;
}) {
  const sync = useRequestFinanceSync();
  // A cooldown is information, a failure is an error — only the second is red.
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const { lastSyncedAt, syncing, environment } = overview.sync;
  const status = syncing
    ? 'Syncing…'
    : lastSyncedAt === null
      ? 'Not synced yet'
      : `Synced ${fmtAgo(lastSyncedAt, nowMs())}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Text size="xs" tone="muted" aria-live="polite">
        {status}
        {environment === 'sandbox' ? ' · Plaid Sandbox' : ''}
      </Text>
      <Button
        data-sync-home
        size="sm"
        variant="quiet"
        disabled={syncing || sync.isPending || watch.retrying}
        onClick={() => {
          watch.arm(); // before the request: the stub syncs inline, so the result can land first
          sync.mutate(true, {
            onSuccess: (r) => {
              if (!r.accepted) watch.disarm();
              setNote(
                r.accepted || r.nextAllowedAt === null
                  ? null
                  : {
                      text: `Asked the bank recently — try again in ${fmtMinutesUntil(r.nextAllowedAt, nowMs())}.`,
                      error: false,
                    },
              );
            },
            onError: () => {
              watch.disarm();
              setNote({ text: 'Couldn’t reach the server — try again.', error: true });
            },
          });
        }}
      >
        Refresh
      </Button>
      <ConnectButton environment={environment} link={link} label="Add a bank" variant="quiet" />
      {note && (
        <Text size="xs" tone={note.error ? 'danger' : 'muted'} className="basis-full">
          {note.text}
        </Text>
      )}
      {link.error && (
        <Text size="xs" tone="danger" className="basis-full">
          {link.error}
        </Text>
      )}
    </div>
  );
}
