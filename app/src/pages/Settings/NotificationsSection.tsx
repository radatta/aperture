import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';
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
  usePushStamp,
  usePushStatus,
  useSendTestPush,
  useSubscribePush,
  useUnsubscribePush,
} from '../../data/hooks/usePush';
import {
  deniedCopy,
  deviceIdHere,
  dismissRemovedElsewhere,
  notificationPermission,
  PUSH_INSTALL_COPY,
  PUSH_UNSUPPORTED_COPY,
  pushSupport,
  removedElsewhereHere,
  subscribeHere,
  syncErrorHere,
} from '../../modules/push/browserPush';
import { deviceLines, pollerLines, testPending } from '../../modules/push/health';
import type { HealthLine } from '../../modules/push/health';

// "Removed from another device", worded for what this browser can do next — never pointing at an Enable
// button the state doesn't show.
export const REMOVED_ELSEWHERE_COPY =
  'Removed from another device — tap Enable to turn reminders back on here.';
export const REMOVED_ELSEWHERE_DENIED_COPY =
  'Removed from another device — allow notifications for Aperture, then tap Enable to turn reminders back on here.';
export const REMOVED_ELSEWHERE_INSTALL_COPY =
  'Removed from another device — open Aperture from your Home Screen to turn reminders back on here.';
export const REMOVED_ELSEWHERE_UNSUPPORTED_COPY =
  'Removed from another device — reminders can’t be turned back on in this browser.';

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
  const { hash } = useLocation();
  const sectionRef = useRef<HTMLElement>(null);
  const loaded = !!settings;
  // Home's "couldn't refresh" line links to /settings#notifications; the sections above load first and
  // move it, so the browser's own anchor jump misses (as FluxSection's #flux).
  useEffect(() => {
    if (loaded && hash === '#notifications')
      sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [loaded, hash]);
  return (
    <section ref={sectionRef} id="notifications" className="flex flex-col gap-3">
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
        <div role="alert">
          <Text size="xs" tone="danger">
            Couldn&apos;t save that — try again.
          </Text>
        </div>
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
      {/* A refresh that fails after a good read: said here, so a page that can't read isn't taken for a
          poller that stopped. */}
      {statusQ.isError && s && (
        <LoadError size="xs" onRetry={() => void statusQ.refetch()}>
          Couldn’t refresh reminder status.
        </LoadError>
      )}
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
          <SendTest hasDevices={s.devices.length > 0} lastSentAt={s.poller.lastSentAt} now={now} />
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
  // This device's stamps (localStorage), re-read whenever the resync or a status read writes one.
  const hereId = usePushStamp(deviceIdHere);
  const onHere = hereId !== null && status.devices.some((d) => d.id === hereId);
  const syncError = usePushStamp(syncErrorHere);
  // Set when a status read found this device removed on another one (usePushStatus): the removal sticks,
  // and the note says so until Enable or Dismiss.
  const removedElsewhere = usePushStamp(removedElsewhereHere);

  // Run straight from the tap: subscribeHere asks for permission before it awaits anything.
  function enable() {
    if (!status.vapidPublicKey) return;
    dismissRemovedElsewhere();
    setError(null);
    setAsking(true);
    subscribeHere(status.vapidPublicKey)
      .then((input) => subscribe.mutateAsync(input))
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setAsking(false));
  }

  // Shown whatever this browser can do now — a removal elsewhere is news even where Enable can't run.
  // Dismiss sits under the note, its label pulled onto the note's left edge (the button's own padding).
  const removedNote = removedElsewhere && !onHere && (
    <div role="status" className="flex flex-col items-start">
      <Text size="sm" tone="gold">
        {support === 'install'
          ? REMOVED_ELSEWHERE_INSTALL_COPY
          : support === 'unsupported'
            ? REMOVED_ELSEWHERE_UNSUPPORTED_COPY
            : permission === 'denied'
              ? REMOVED_ELSEWHERE_DENIED_COPY
              : REMOVED_ELSEWHERE_COPY}
      </Text>
      <Button variant="quiet" size="sm" className="-ml-3" onClick={dismissRemovedElsewhere}>
        Dismiss
      </Button>
    </div>
  );
  if (support !== 'ok' || permission === 'denied')
    return (
      <div className="flex flex-col gap-1.5">
        {removedNote}
        <Text as="p" size="sm" tone="gold">
          {support === 'install'
            ? PUSH_INSTALL_COPY
            : support === 'unsupported'
              ? PUSH_UNSUPPORTED_COPY
              : deniedCopy()}
        </Text>
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5">
      {removedNote}
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
      <div role="alert">
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
      </div>
    </div>
  );
}

function DeviceList({ devices, now }: { devices: PushDevice[]; now: number }) {
  const hereId = usePushStamp(deviceIdHere);
  if (devices.length === 0)
    return (
      <Text as="p" size="sm" tone="muted">
        No devices yet — enable reminders on your iPhone from the Home Screen app.
      </Text>
    );
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

function SendTest({
  hasDevices,
  lastSentAt,
  now,
}: {
  hasDevices: boolean;
  lastSentAt: number | null;
  now: number;
}) {
  const send = useSendTestPush();
  // When the last queued test was tapped: "Sending…" holds until a send lands after it, or it lapses.
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const queue = () => {
    const at = Date.now();
    send.mutate(undefined, { onSuccess: () => setQueuedAt(at) });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="sm" disabled={!hasDevices || send.isPending} onClick={queue}>
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
        ) : queuedAt !== null && testPending(queuedAt, lastSentAt, now) ? (
          <Text size="xs" tone="teal">
            Sending within a minute…
          </Text>
        ) : null}
      </span>
    </div>
  );
}
