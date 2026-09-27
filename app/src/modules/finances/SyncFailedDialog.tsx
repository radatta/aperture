import { financeSyncErrorMessage } from '@aperture/shared';
import type { FinanceOverview } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { fmtAgo, nowMs } from './ago';
import type { BankLink } from './useBankLink';
import type { SyncWatch } from './useSyncWatch';

// "Sync didn't finish" — what failed in plain words, for which bank, what you're looking at, and the
// one next step: Reconnect when the bank wants a login, otherwise Try again.
export function SyncFailedDialog({
  watch,
  overview,
  link,
}: {
  watch: SyncWatch;
  overview: FinanceOverview;
  link: BankLink;
}) {
  const failed = watch.failed;
  const item = failed ? overview.items.find((i) => i.id === failed.itemId) : undefined;
  const itemSync = failed ? overview.sync.items.find((i) => i.itemId === failed.itemId) : undefined;
  const needsLogin = item?.status === 'login_required';
  // It opened on its own (the button that started the sync was disabled meanwhile), so there's no
  // opener to hand focus back to — land on the banner's next step instead.
  const close = () => {
    watch.dismiss();
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-sync-next-step]')?.focus(),
    );
  };
  if (!failed) return null;
  const syncedAt = itemSync?.lastSyncedAt ?? null;
  return (
    <Modal open onClose={close} label="Sync didn’t finish">
      <div className="flex flex-col gap-3">
        <Text as="h2" size="lg" weight="semibold">
          Sync didn’t finish
        </Text>
        <Text>{financeSyncErrorMessage(failed.code, item?.institutionName)}</Text>
        <Text size="sm" tone="muted">
          Nothing changed —{' '}
          {syncedAt === null
            ? 'nothing has synced yet.'
            : `last synced ${fmtAgo(syncedAt, nowMs())}.`}
        </Text>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button
            onClick={() => {
              close();
              if (needsLogin && item) link.start({ mode: 'update', itemId: item.id });
              else watch.retry();
            }}
          >
            {needsLogin ? 'Reconnect' : 'Try again'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
