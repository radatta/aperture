import { financeSyncErrorMessage } from '@aperture/shared';
import type { FinanceOverview } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Text } from '../../components/Text';
import { fmtAgo, nowMs } from './ago';
import type { BankLink } from './useBankLink';
import type { SyncWatch } from './useSyncWatch';

// "Sync didn't finish" — what failed in plain words, what you're looking at, and the one next step:
// Reconnect when the bank wants a login, otherwise Try again.
export function SyncFailedDialog({
  watch,
  overview,
  link,
}: {
  watch: SyncWatch;
  overview: FinanceOverview;
  link: BankLink;
}) {
  if (!watch.failed) return null;
  const loginItem = overview.items.find((i) => i.status === 'login_required');
  const bank = loginItem?.institutionName ?? overview.items[0]?.institutionName;
  const { lastSyncedAt } = overview.sync;
  // It opened on its own (the button that started the sync was disabled meanwhile), so there's no
  // opener to hand focus back to — land on the banner's next step instead.
  const close = () => {
    watch.dismiss();
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-sync-next-step]')?.focus(),
    );
  };
  return (
    <Modal open onClose={close} label="Sync didn’t finish">
      <div className="flex flex-col gap-3">
        <Text as="h2" size="lg" weight="semibold">
          Sync didn’t finish
        </Text>
        <Text>{financeSyncErrorMessage(watch.failed, bank)}</Text>
        <Text size="sm" tone="muted">
          Nothing changed —{' '}
          {lastSyncedAt === null
            ? 'nothing has synced yet.'
            : `last synced ${fmtAgo(lastSyncedAt, nowMs())}.`}
        </Text>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button
            onClick={() => {
              watch.dismiss();
              if (loginItem) link.start({ mode: 'update', itemId: loginItem.id });
              else watch.retry();
            }}
          >
            {loginItem ? 'Reconnect' : 'Try again'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
