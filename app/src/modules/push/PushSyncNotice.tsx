import { Link } from 'react-router';
import { Button } from '../../components/Button';
import { Text } from '../../components/Text';
import { usePushStamp } from '../../data/hooks/usePush';
import { deviceIdHere, dismissSyncError, syncErrorUndismissed } from './browserPush';

export const PUSH_SYNC_NOTICE_COPY = 'Reminders couldn’t refresh on this device —';

// Home's line when this device's launch resync failed (usePushSync): reminders may not be reaching it,
// and Settings › Notifications says why. Laid out like LoadError. Clears when a later resync succeeds;
// a dismissal holds until a new failure. `enabled`: http mode only — the only place the resync runs.
export function PushSyncNotice({ enabled }: { enabled: boolean }) {
  const optedIn = usePushStamp(deviceIdHere) !== null;
  const error = usePushStamp(syncErrorUndismissed);
  if (!enabled || !optedIn || error === null) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2">
      <Text tone="danger" size="sm">
        {PUSH_SYNC_NOTICE_COPY}{' '}
        <Link to="/settings#notifications" className="text-teal underline-offset-2 hover:underline">
          open Settings
        </Link>
      </Text>
      <Button variant="quiet" size="sm" onClick={dismissSyncError}>
        Dismiss
      </Button>
    </div>
  );
}
