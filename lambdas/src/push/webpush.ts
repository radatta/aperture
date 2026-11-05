import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto';

// Web Push, hand-rolled on node:crypto (reminders.md → D11): the message encryption of RFC 8291 (the
// aes128gcm content coding of RFC 8188, one record) and the VAPID authorization of RFC 8292 (an ES256
// JWT). Pinned by RFC 8291 Appendix A's exact bytes (webpush.test.ts), so a wrong byte fails a test, not
// a phone. No dependency: `web-push` is the fallback only if a push service rejects what passes the vector.

const RECORD_SIZE = 4096;
// RFC 8291 §4: a 4096-octet message less the 86-octet header, the padding delimiter and the 16-octet tag.
export const PUSH_PLAINTEXT_MAX = 3993;
// RFC 8292 §2: at most 24 h; half that leaves room for clock skew between us and the push service.
const VAPID_TTL_S = 12 * 3600;

// A subscription whose keys can't be encrypted to (not a P-256 point, or not a 16-octet secret): no
// retry will ever reach that device.
export class PushKeysError extends Error {
  constructor() {
    super('Push subscription keys are malformed');
    this.name = 'PushKeysError';
  }
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');
const hmac = (key: Uint8Array, data: Uint8Array): Buffer =>
  createHmac('sha256', key).update(data).digest();

// A P-256 key pair from its raw 32-byte private scalar (base64url, as stored in SSM).
function p256(privateKeyB64: string) {
  const raw = unb64u(privateKeyB64);
  if (raw.length === 0 || raw.length > 32) throw new Error('VAPID private key is not a P-256 key');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(32 - raw.length), raw]));
  return ecdh;
}

// The 65-octet uncompressed public point (base64url) — what the browser takes as applicationServerKey.
export const publicKeyOf = (privateKeyB64: string): string =>
  b64u(p256(privateKeyB64).getPublicKey());

export interface EncryptOpts {
  salt?: Uint8Array; // 16 random octets per message; fixed only by the RFC vector test
  ephemeralPrivateKey?: string; // base64url; the sender's one-message key pair, likewise
}

// RFC 8291 §3.4 + RFC 8188: the whole request body for one push message. `uaPublic` / `authSecret` are
// the subscription's p256dh / auth (base64url). Throws on a subscription whose keys aren't a P-256 point
// and a 16-octet secret, and on a plaintext too large for one 4 KB message.
export function encryptAes128Gcm(
  plaintext: Uint8Array,
  uaPublicB64: string,
  authSecretB64: string,
  opts: EncryptOpts = {},
): Buffer {
  if (plaintext.length > PUSH_PLAINTEXT_MAX) throw new Error('Push payload too large');
  const uaPublic = unb64u(uaPublicB64);
  const authSecret = unb64u(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04 || authSecret.length !== 16)
    throw new PushKeysError();
  const salt = opts.salt ? Buffer.from(opts.salt) : randomBytes(16);
  if (salt.length !== 16) throw new Error('Push salt must be 16 octets');

  const as = createECDH('prime256v1');
  if (opts.ephemeralPrivateKey) as.setPrivateKey(unb64u(opts.ephemeralPrivateKey));
  else as.generateKeys();
  const asPublic = as.getPublicKey();
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = as.computeSecret(uaPublic);
  } catch {
    throw new PushKeysError(); // a point that isn't on the curve
  }

  // HKDF (RFC 5869) written out as in RFC 8291 §3.4: every output here is ≤ 32 octets, one HMAC block.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  // One record, the last: plaintext + the 0x02 delimiter, no padding. The sequence number is 0, so the
  // nonce is used as derived.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// RFC 8292: the Authorization header for one request to `endpoint` — `vapid t=<ES256 JWT>, k=<public
// key>`. `aud` is the endpoint's origin, `sub` our contact (the app's https URL, D13).
export function vapidAuthorization(
  endpoint: string,
  privateKeyB64: string,
  sub: string,
  nowMs: number,
): string {
  const ecdh = p256(privateKeyB64);
  const pub = ecdh.getPublicKey();
  const key = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64u(ecdh.getPrivateKey()),
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
  });
  const part = (v: object) => b64u(Buffer.from(JSON.stringify(v)));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + VAPID_TTL_S,
    sub,
  };
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`;
  // JWS wants r‖s (64 octets), not DER.
  const sig = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${b64u(pub)}`;
}
