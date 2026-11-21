import { createHash } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { pushEndpointOk } from '@aperture/shared';
import type { PushGateway, PushReadiness, PushResult, PushSendOpts, PushTarget } from './gateway';
import { encryptAes128Gcm, publicKeyOf, PushKeysError, vapidAuthorization } from './webpush';

// The live push gateway: one POST per device to its stored endpoint, encrypted (RFC 8291) and signed
// (RFC 8292) with the stage's VAPID private key from SSM SecureString
// `/aperture/<stage>/push/vapid_private_key`, held for the warm container and dropped on a 403 (a rotated
// key). Wired only in pushDispatch.ts; testMode never reaches it. One attempt per call (the poller's
// retries are its own, push/deliver.ts), a 10 s cap — FCM asks for at least 10 s, and a shorter abort
// turns more slow-but-accepted sends into retries (U6) — and redirects are never followed: the POST goes to
// the allowlisted host or nowhere.

export const SEND_TIMEOUT_MS = 10_000;
// A refusal's body is read for its reason (D26) up to this many bytes and this long: past either, no
// detail. 10 s for the answer plus this stays inside the tick's 12 s send margin (TICK_SAFETY_MS).
export const BODY_CAP = 2048;
export const BODY_READ_MS = 500;
const DETAIL_MAX = 80;

// The Topic header for a logical tag (D25): base64url(sha256(tag)), its first 24 characters — 18 octets
// with no leftover bits, inside RFC 8030's 32, the same for the same tag, so a retry still replaces an
// undelivered first copy. Apple refused raw tags whose length is 1 more than a multiple of 4
// (`ritualMorning`, `b<minute>`), which no base64url decoder can decode (inference: 2026-11-21).
export const wireTopic = (tag: string): string =>
  createHash('sha256').update(tag).digest('base64url').slice(0, 24);

// Untrusted text bound for a log line and Settings: a short ASCII phrase. Anything else is a space, so it
// can't forge the error text's `(…)` wrapper, the health line's ` · ` or a newline.
const clean = (s: string): string | undefined =>
  s
    .replace(/[^A-Za-z0-9 _.:,/'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX)
    .trim() || undefined;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

// The reason a push service gave, from its error body: Apple `{"reason"}` (served as text/plain), Mozilla
// autopush `{code, errno, error, message}`, Google `{"error": {status, message}}` or a string `error`, or
// plain text. An HTML page or an empty body says nothing.
export function serviceDetail(text: string | null): string | undefined {
  if (text === null) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const t = text.trim();
    return t && !t.startsWith('<') ? clean(t) : undefined;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  const reason = str(o.reason) ?? mozilla(o) ?? google(o.error) ?? str(o.error);
  return reason === undefined ? undefined : clean(reason);
}
function mozilla(o: Record<string, unknown>): string | undefined {
  const message = str(o.message);
  if (!message) return undefined;
  return typeof o.errno === 'number' ? `errno ${o.errno} ${message}` : message;
}
function google(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const o = e as Record<string, unknown>;
  return str(o.status) ?? str(o.message);
}

// The body as text, at most BODY_CAP bytes within BODY_READ_MS; null past either, or on any failure.
// Cancelled either way, so the connection is freed.
export async function readCapped(res: Response, ms = BODY_READ_MS): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), ms)));
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === 'late') return null;
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BODY_CAP) return null;
      chunks.push(next.value);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

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
      value = res.Parameter?.Value?.trim() || null; // a pasted newline is no part of the key
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
      if (!cfg.appUrl) return 'no-app-url';
      if ((await privateKey()) !== null) return 'ok';
      return bad ? 'bad-key' : 'no-key';
    },
    async send(target: PushTarget, payload: string, opts: PushSendOpts): Promise<PushResult> {
      // The allowlist gate ran at subscribe; checked again here so a row that never passed it (written
      // by hand, or before the check) still can't aim the poller anywhere else.
      if (!pushEndpointOk(target.endpoint)) throw new Error('Push endpoint off the allowlist');
      const k = await privateKey();
      if (!cfg.appUrl) throw new Error('Push has no APP_URL on this stage (the VAPID sub)');
      if (!k) throw new Error('Push is not configured on this stage');
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
            topic: wireTopic(opts.topic),
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        return { status: 0, reason: isTimeout(err) ? 'timeout' : 'network' };
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => {}); // delivered: the status is the answer
        return { status: res.status };
      }
      const detail = serviceDetail(await readCapped(res));
      // A rotated or revoked key: re-read SSM on the next send, not a recycle away.
      if (res.status === 403) key = null;
      return { status: res.status, ...(detail ? { detail } : {}) };
    },
  };
}
