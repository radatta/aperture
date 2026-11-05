// The gated seam for Web Push sends (reminders.md) — like Google, Plaid and Anthropic, every external
// effect goes through a gateway, never a raw fetch in the logic: testMode gets `noopPush` (reads no key,
// sends nothing — a send throws), tests get `InMemoryPush`, and `createLivePush` (SSM key + fetch) is
// wired only in the poller's entrypoint (pushDispatch.ts). The BFF never holds one: it only queues
// candidates; the poller is the only sender. DynamoDB stamps stay on `writes`.

// Where a send goes: a stored subscription. The endpoint passed the host allowlist at subscribe.
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendOpts {
  topic: string; // the Topic header: a later message with the same topic replaces an undelivered one
  ttlSeconds: number;
  urgency: 'high' | 'normal';
}

// The push service's HTTP status — 201 is delivered to the service; 404/410 the subscription is gone; 0 is
// a timeout or a network failure (`reason` says which). Never a throw for a push-service answer.
export interface PushResult {
  status: number;
  reason?: 'timeout' | 'network' | 'keys';
}

// Whether this stage can send at all: it knows its app URL, the VAPID `sub` (`no-app-url` otherwise), and its
// VAPID private key is present (`no-key` otherwise) and is a P-256 key (`bad-key` otherwise). Read before any dedup row is written, so a stage that can't sign consumes no
// reminder.
export type PushReadiness = 'ok' | 'no-app-url' | 'no-key' | 'bad-key';

export interface PushGateway {
  readiness(): Promise<PushReadiness>;
  send(target: PushTarget, payload: string, opts: PushSendOpts): Promise<PushResult>;
}

export function noopPush(): PushGateway {
  return {
    // The selection logic still runs in a smoke tick; the send is where it stops.
    readiness: async () => 'ok',
    send: async () => {
      throw new Error('Push sends are disabled in testMode');
    },
  };
}

export interface RecordedSend {
  target: PushTarget;
  payload: unknown; // the parsed plaintext
  opts: PushSendOpts;
}

// The test double: records every send; `status` (per endpoint, or a function) is the answer to give.
export class InMemoryPush implements PushGateway {
  sends: RecordedSend[] = [];
  readyAs: PushReadiness = 'ok';
  status: number | ((target: PushTarget) => number | PushResult) = 201;
  async readiness(): Promise<PushReadiness> {
    return this.readyAs;
  }
  async send(target: PushTarget, payload: string, opts: PushSendOpts): Promise<PushResult> {
    this.sends.push({ target, payload: JSON.parse(payload) as unknown, opts });
    const out = typeof this.status === 'function' ? this.status(target) : this.status;
    return typeof out === 'number' ? { status: out } : out;
  }
}
