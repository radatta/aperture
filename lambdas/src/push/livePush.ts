import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { pushEndpointOk } from '@aperture/shared';
import type { PushGateway, PushReadiness, PushResult, PushSendOpts, PushTarget } from './gateway';
import { encryptAes128Gcm, publicKeyOf, PushKeysError, vapidAuthorization } from './webpush';

// The live push gateway: one POST per device to its stored endpoint, encrypted (RFC 8291) and signed
// (RFC 8292) with the stage's VAPID private key from SSM SecureString
// `/aperture/<stage>/push/vapid_private_key`, held for the warm container and dropped on a 403 (a rotated
// key). Wired only in pushDispatch.ts; testMode never reaches it. One attempt, no retries (fail-closed,
// D3), a 5 s cap, and redirects are never followed — the POST goes to the allowlisted host or nowhere.

const SEND_TIMEOUT_MS = 5000;

type SsmLike = Pick<SSMClient, 'send'>;

export interface LivePushConfig {
  stage: string;
  appUrl: string; // the VAPID `sub` (D13); none → this stage can't send
  fetch?: typeof fetch;
  ssm?: SsmLike;
  now?: () => number;
}

export function createLivePush(cfg: LivePushConfig): PushGateway {
  const doFetch = cfg.fetch ?? fetch;
  const ssm: SsmLike = cfg.ssm ?? new SSMClient({});
  const now = cfg.now ?? Date.now;
  const keyParam = `/aperture/${cfg.stage}/push/vapid_private_key`;
  let key: string | null = null; // only ever a key that derives a public one
  let bad = false; // the last read found a value that isn't a P-256 private key

  // A missing parameter is "not set up" (null); a value that isn't a P-256 key is held as `bad` (never
  // cached as the key, so a fixed parameter is read on the next tick); any other SSM failure throws — the
  // tick fails loudly.
  async function privateKey(): Promise<string | null> {
    if (key) return key;
    bad = false;
    let value: string | null = null;
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: keyParam, WithDecryption: true }));
      value = res.Parameter?.Value || null;
    } catch (err) {
      if (!(err instanceof Error && err.name === 'ParameterNotFound')) throw err;
    }
    if (value === null) return null;
    try {
      publicKeyOf(value);
      key = value;
    } catch {
      bad = true;
    }
    return key;
  }
  const isTimeout = (err: unknown) => ['TimeoutError', 'AbortError'].includes((err as Error).name);

  return {
    async readiness(): Promise<PushReadiness> {
      if (!cfg.appUrl) return 'no-key';
      if ((await privateKey()) !== null) return 'ok';
      return bad ? 'bad-key' : 'no-key';
    },
    async send(target: PushTarget, payload: string, opts: PushSendOpts): Promise<PushResult> {
      // The allowlist gate ran at subscribe; checked again here so a row that never passed it (written
      // by hand, or before the check) still can't aim the poller anywhere else.
      if (!pushEndpointOk(target.endpoint)) throw new Error('Push endpoint off the allowlist');
      const k = await privateKey();
      if (!k || !cfg.appUrl) throw new Error('Push is not configured on this stage');
      let body: Buffer;
      try {
        body = encryptAes128Gcm(Buffer.from(payload), target.p256dh, target.auth);
      } catch (err) {
        if (err instanceof PushKeysError) return { status: 0, reason: 'keys' };
        throw err;
      }
      // Signed before the request: a signing fault is never mistaken for the network's.
      const authorization = vapidAuthorization(target.endpoint, k, cfg.appUrl, now());
      let res: Response;
      try {
        res = await doFetch(target.endpoint, {
          method: 'POST',
          headers: {
            authorization,
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: String(opts.ttlSeconds),
            urgency: opts.urgency,
            topic: opts.topic,
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        return { status: 0, reason: isTimeout(err) ? 'timeout' : 'network' };
      }
      await res.body?.cancel().catch(() => {}); // the answer is the status; free the connection
      // A rotated or revoked key: re-read SSM on the next send, not a recycle away.
      if (res.status === 403) key = null;
      return { status: res.status };
    },
  };
}
