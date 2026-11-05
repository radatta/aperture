import { useId, useState } from 'react';
import {
  DAY_REMINDER_TIME,
  fmtClock12,
  PUSH_NO_DEVICE_ERROR,
  PUSH_UNCONFIGURED_ERROR,
} from '@aperture/shared';
import type { PushDevice, PushStatus, ReminderSettingKey, Settings } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { LoadError } from '../../components/LoadError';
import { Text } from '../../components/Text';
import { useNow } from '../../lib/useNow';
import { useSettings, useUpdateSettings } from '../../data/hooks/useSettings';
import {
  usePushStatus,
  useSendTestPush,
  useSubscribePush,
  useUnsubscribePush,
} from '../../data/hooks/usePush';
import {
  deniedCopy,
  deviceIdHere,
  notificationPermission,
  PUSH_INSTALL_COPY,
  PUSH_UNSUPPORTED_COPY,
  pushSupport,
  subscribeHere,
  syncErrorHere,
} from '../../modules/push/browserPush';
import { deviceLines, pollerLines } from '../../modules/push/health';
import type { HealthLine } from '../../modules/push/health';

const errText = (e: unknown) =>
  e instanceof Error ? e.message : 'Something went wrong — try again.';

const AT = fmtClock12(DAY_REMINDER_TIME);
const KINDS: { key: ReminderSettingKey; label: string; hint: string }[] = [
  { key: 'remindTimed', label: 'Timed deadlines', hint: 'At the due time.' },
  { key: 'remindDueDay', label: `Day-only deadlines at ${AT}`, hint: 'On the due day.' },
  {
    key: 'remindPlanned',
    label: `Planned tasks at ${AT}`,
    hint: 'On the day you planned them for.',
  },
];

// Settings › Notifications (docs/areas/tasks/reminders.md): which reminders ping, which devices get them,
// and whether it's all working — the poller's heartbeat, its last send or error, each device's (D6).
// Send test proves the whole chain: it queues a ping the poller sends on its next tick.
export function NotificationsSection() {
  const { data: settings } = useSettings();
  return (
    <section id="notifications" className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Notifications
      </Text>
      {settings && <KindToggles settings={settings} />}
      <DevicesCard />
    </section>
  );
}

function KindToggles({ settings }: { settings: Settings }) {
  const update = useUpdateSettings();
  const id = useId();
  return (
    <Card className="flex flex-col gap-3">
      <Text size="sm" tone="muted">
        Remind me about:
      </Text>
      {KINDS.map((k) => (
        // The hint sits outside the <label>, so each toggle's name is just its kind.
        <div key={k.key} className="flex flex-col">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              // A row from before the toggles reads undefined: on (reminderEnabled).
              checked={settings[k.key] !== false}
              disabled={update.isPending}
              aria-describedby={`${id}-${k.key}`}
              onChange={(e) => update.mutate({ [k.key]: e.target.checked })}
            />
            <Text size="sm">{k.label}</Text>
          </label>
          <Text size="xs" tone="muted" id={`${id}-${k.key}`} className="pl-6">
            {k.hint}
          </Text>
        </div>
      ))}
      {update.isError && (
        <p role="alert" className="text-xs text-danger">
          Couldn&apos;t save that — try again.
        </p>
      )}
    </Card>
  );
}

const Lines = ({ lines }: { lines: HealthLine[] }) =>
  lines.map((l) => (
    <Text key={l.text} as="p" size="xs" tone={l.tone} className="break-words">
      {l.text}
    </Text>
  ));

function DevicesCard() {
  const statusQ = usePushStatus({ poll: true });
  const now = useNow();
  const s = statusQ.data;
  return (
    <Card className="flex flex-col gap-3">
      <Text weight="medium">Devices</Text>
      {statusQ.isError && !s ? (
        <LoadError size="xs" onRetry={() => void statusQ.refetch()}>
          Couldn’t load reminder status.
        </LoadError>
      ) : !s ? (
        <Text size="sm" tone="muted">
          Loading…
        </Text>
      ) : !s.configured ? (
        <Text size="sm" tone="gold">
          {PUSH_UNCONFIGURED_ERROR}
        </Text>
      ) : (
        <>
          <div aria-label="Reminder health" role="group">
            <Lines lines={pollerLines(s.poller, now)} />
          </div>
          <ThisDevice status={s} />
          <DeviceList devices={s.devices} now={now} />
          <SendTest hasDevices={s.devices.length > 0} />
        </>
      )}
    </Card>
  );
}

// This browser: why it can't take reminders, or the button that asks.
function ThisDevice({ status }: { status: PushStatus }) {
  const subscribe = useSubscribePush();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const support = pushSupport();
  const permission = notificationPermission();
  const hereId = deviceIdHere();
  const onHere = hereId !== null && status.devices.some((d) => d.id === hereId);
  const syncError = syncErrorHere();

  // Run straight from the tap: subscribeHere asks for permission before it awaits anything.
  function enable() {
    if (!status.vapidPublicKey) return;
    setError(null);
    setAsking(true);
    subscribeHere(status.vapidPublicKey)
      .then((input) => subscribe.mutateAsync(input))
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setAsking(false));
  }

  if (support !== 'ok')
    return (
      <Text as="p" size="sm" tone="gold">
        {support === 'install' ? PUSH_INSTALL_COPY : PUSH_UNSUPPORTED_COPY}
      </Text>
    );
  if (permission === 'denied')
    return (
      <Text as="p" size="sm" tone="gold">
        {deniedCopy()}
      </Text>
    );
  return (
    <div className="flex flex-col gap-1.5">
      {onHere ? (
        <Text as="p" size="sm" tone="teal">
          On for this device.
        </Text>
      ) : (
        <div>
          <Button size="sm" disabled={asking} onClick={enable}>
            {asking ? 'Enabling…' : 'Enable on this device'}
          </Button>
        </div>
      )}
      <span role="alert">
        {error && (
          <Text as="p" size="xs" tone="danger" className="break-words">
            {error}
          </Text>
        )}
        {!error && syncError && (
          <Text as="p" size="xs" tone="danger" className="break-words">
            Couldn’t refresh this device’s subscription on launch: {syncError}
          </Text>
        )}
      </span>
    </div>
  );
}

function DeviceList({ devices, now }: { devices: PushDevice[]; now: number }) {
  if (devices.length === 0)
    return (
      <Text as="p" size="sm" tone="muted">
        No devices yet — enable reminders on your iPhone from the Home Screen app.
      </Text>
    );
  const hereId = deviceIdHere();
  return (
    <ul className="flex flex-col gap-2">
      {devices.map((d) => (
        <DeviceRow key={d.id} device={d} here={d.id === hereId} now={now} />
      ))}
    </ul>
  );
}

function DeviceRow({ device, here, now }: { device: PushDevice; here: boolean; now: number }) {
  const remove = useUnsubscribePush();
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-line px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <Text size="sm">
          {device.label}
          {here ? ' (this device)' : ''}
        </Text>
        <Lines lines={deviceLines(device, now)} />
        {remove.isError && (
          <Text as="p" size="xs" tone="danger" className="break-words">
            Couldn’t remove it: {errText(remove.error)}
          </Text>
        )}
      </div>
      <Button
        variant="quiet"
        size="sm"
        aria-label={`Remove ${device.label}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate(device.id)}
      >
        Remove
      </Button>
    </li>
  );
}

function SendTest({ hasDevices }: { hasDevices: boolean }) {
  const send = useSendTestPush();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={!hasDevices || send.isPending}
        onClick={() => send.mutate()}
      >
        Send test
      </Button>
      <span role="status">
        {!hasDevices ? (
          <Text size="xs" tone="muted">
            {PUSH_NO_DEVICE_ERROR}.
          </Text>
        ) : send.isError ? (
          <Text size="xs" tone="danger" className="break-words">
            Couldn’t send a test: {errText(send.error)}
          </Text>
        ) : send.isSuccess ? (
          <Text size="xs" tone="teal">
            Sending within a minute…
          </Text>
        ) : null}
      </span>
    </div>
  );
}
