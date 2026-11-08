import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encryptAes128Gcm,
  PUSH_PLAINTEXT_MAX,
  publicKeyOf,
  PushKeysError,
  vapidAuthorization,
} from './webpush';

// RFC 8291 Appendix A (https://www.rfc-editor.org/rfc/rfc8291.txt, fetched 2026-11-04), copied verbatim;
// each value is base64url, split where the RFC wraps it (the RFC: "whitespace that can be removed").
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg' + 'Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-' +
    'JvLexhqUzORcx' +
    'aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  // "The salt, record size of 4096, and application server public key produce an 86-octet header of:"
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z' +
    '9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz' +
    'AC8wEqKK6PBru3jl7A8',
  // "The plaintext is then encrypted with AES-GCM, which emits ciphertext of:"
  ciphertext:
    '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd' + 'irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs' + 'bI_0LpXMuGvnzQ',
  // §5: "The header and ciphertext are concatenated and produce the result shown in Section 5."
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const bytes = (s: string) => Buffer.from(s, 'base64url');

const rfcEncrypt = (plaintext = bytes(RFC.plaintext)) =>
  encryptAes128Gcm(plaintext, RFC.uaPublic, RFC.authSecret, {
    salt: bytes(RFC.salt),
    ephemeralPrivateKey: RFC.asPrivate,
  });

describe('RFC 8291 message encryption (aes128gcm)', () => {
  it('reproduces Appendix A byte for byte', () => {
    expect(bytes(RFC.plaintext).toString()).toBe('When I grow up, I want to be a watermelon');
    const out = rfcEncrypt();
    expect(out.subarray(0, 86).toString('base64url')).toBe(RFC.header);
    expect(out.subarray(86).toString('base64url')).toBe(RFC.ciphertext);
    expect(out.toString('base64url')).toBe(RFC.body);
    expect(out.length).toBe(86 + 41 + 1 + 16); // header, plaintext, delimiter, tag
  });

  it('the vector key pairs are what the RFC says they are', () => {
    expect(publicKeyOf(RFC.asPrivate)).toBe(RFC.asPublic);
    expect(publicKeyOf(RFC.uaPrivate)).toBe(RFC.uaPublic);
  });

  // The receiver's side, written from the RFC independently of encryptAes128Gcm: a fresh salt and key
  // pair per message still decrypts with only the user agent's private key and auth secret.
  it('a random-salt message decrypts on the receiving side', () => {
    const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
    const msg = Buffer.from('{"web_push":8030}');
    const out = encryptAes128Gcm(msg, RFC.uaPublic, RFC.authSecret);
    const salt = out.subarray(0, 16);
    expect(out.readUInt32BE(16)).toBe(4096);
    expect(out[20]).toBe(65);
    const asPublic = out.subarray(21, 86);
    expect(asPublic.toString('base64url')).not.toBe(RFC.asPublic); // a new key per message
    const ua = createECDH('prime256v1');
    ua.setPrivateKey(bytes(RFC.uaPrivate));
    const prkKey = hmac(bytes(RFC.authSecret), ua.computeSecret(asPublic));
    const info = Buffer.concat([
      Buffer.from('WebPush: info\0'),
      bytes(RFC.uaPublic),
      asPublic,
      Buffer.from([1]),
    ]);
    const prk = hmac(salt, hmac(prkKey, info));
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const record = out.subarray(86);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
    expect(plain.toString()).toBe('{"web_push":8030}\x02');
  });

  it('refuses a payload past one 4 KB message, and malformed subscription keys', () => {
    expect(rfcEncrypt(Buffer.alloc(PUSH_PLAINTEXT_MAX)).length).toBe(4096);
    expect(() => rfcEncrypt(Buffer.alloc(PUSH_PLAINTEXT_MAX + 1))).toThrow(
      'Push payload too large',
    );
    for (const [p256dh, auth] of [
      ['BPk-p256dh-sample', RFC.authSecret], // not a 65-octet point
      [RFC.uaPublic, 'auth-sample'], // not 16 octets
      [`A${RFC.uaPublic.slice(1)}`, RFC.authSecret], // no 0x04 prefix
    ])
      expect(() => encryptAes128Gcm(Buffer.from('x'), p256dh!, auth!)).toThrow(/malformed/);
    // 65 octets starting 0x04, but not a point on the curve.
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    expect(() => encryptAes128Gcm(Buffer.from('x'), offCurve, RFC.authSecret)).toThrow(
      PushKeysError,
    );
  });
});

describe('RFC 8292 VAPID', () => {
  const NOW = Date.UTC(2026, 10, 4, 22, 0, 0);
  const endpoint = 'https://web.push.apple.com/QGdev-1?x=y';
  const parse = (header: string) => {
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    if (!m) throw new Error(`not a vapid header: ${header}`);
    const [h, c, s] = m[1]!.split('.') as [string, string, string];
    return { jwt: m[1]!, h, c, s, k: m[2]!, json: (p: string) => JSON.parse(bytes(p).toString()) };
  };

  it('signs an ES256 JWT that verifies against the public key it names', () => {
    const v = parse(vapidAuthorization(endpoint, RFC.asPrivate, 'https://aperture.example', NOW));
    expect(v.k).toBe(RFC.asPublic);
    expect(v.json(v.h)).toEqual({ typ: 'JWT', alg: 'ES256' });
    const pub = bytes(v.k);
    const key = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url'),
      },
    });
    const sig = bytes(v.s);
    expect(sig.length).toBe(64); // r‖s, not DER
    const signed = Buffer.from(`${v.h}.${v.c}`);
    expect(verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
    expect(
      verify('sha256', Buffer.from(`${v.h}.${v.c}x`), { key, dsaEncoding: 'ieee-p1363' }, sig),
    ).toBe(false);
  });

  it('aud is the endpoint origin, exp within 24 h, sub the app URL', () => {
    const v = parse(vapidAuthorization(endpoint, RFC.asPrivate, 'https://aperture.example', NOW));
    const claims = v.json(v.c) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.sub).toBe('https://aperture.example');
    expect(claims.exp).toBeGreaterThan(NOW / 1000);
    expect(claims.exp).toBeLessThanOrEqual(NOW / 1000 + 24 * 3600);
  });

  it('signs with a key whose first octet is zero (the JWK takes the validated 32 octets)', () => {
    // A key whose first octet is zero (1 in 256): getPrivateKey may hand back 31 octets for it.
    const zeroLed = (): string => {
      for (;;) {
        const e = createECDH('prime256v1');
        e.generateKeys();
        const raw = e.getPrivateKey();
        const full = Buffer.concat([Buffer.alloc(32 - raw.length), raw]);
        if (full[0] === 0) return full.toString('base64url');
      }
    };
    const priv = zeroLed();
    const v = parse(vapidAuthorization(endpoint, priv, 'https://aperture.example', NOW));
    const pub = bytes(v.k);
    const key = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url'),
      },
    });
    const signed = Buffer.from(`${v.h}.${v.c}`);
    expect(verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, bytes(v.s))).toBe(true);
  });

  it('derives the public key from a stored private key, refusing one that is not P-256', () => {
    const e = createECDH('prime256v1');
    e.generateKeys();
    const raw = e.getPrivateKey();
    const priv = Buffer.concat([Buffer.alloc(32 - raw.length), raw]).toString('base64url');
    expect(publicKeyOf(priv)).toBe(e.getPublicKey().toString('base64url'));
    for (const bad of [
      '',
      'not-a-key', // decodes to 6 octets
      Buffer.alloc(33, 1).toString('base64url'),
      Buffer.alloc(31, 1).toString('base64url'),
      `${priv.slice(0, 20)}!${priv.slice(21)}`, // a stray character Buffer would skip
      Buffer.alloc(32, 0).toString('base64url'), // the zero scalar
      Buffer.alloc(32, 0xff).toString('base64url'), // past the curve order
    ])
      expect(() => publicKeyOf(bad), bad).toThrow(/P-256/);
  });
});
