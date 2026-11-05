import { describe, expect, it, vi } from 'vitest';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { createLivePush } from './livePush';
import { createPublicKeyReader } from './publicKey';
import { publicKeyOf } from './webpush';

// The live gateway over a stubbed fetch and SSM — no network, no AWS. Keys are RFC 8291's vector keys.
const PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const target = {
  endpoint: 'https://web.push.apple.com/abc',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const opts = { topic: '01J0000000000000000000000T', ttlSeconds: 3600, urgency: 'high' as const };
const notFound = () => Object.assign(new Error('nope'), { name: 'ParameterNotFound' });

function ssmWith(value: () => string | Error) {
  const calls: { Name?: string; WithDecryption?: boolean }[] = [];
  const ssm = {
    send: async (cmd: { input: { Name?: string; WithDecryption?: boolean } }) => {
      calls.push(cmd.input);
      const v = value();
      if (v instanceof Error) throw v;
      return { Parameter: { Value: v } };
    },
  } as unknown as SSMClient;
  return { ssm, calls };
}
function live(
  over: { status?: number; fetch?: typeof fetch; key?: () => string | Error; appUrl?: string } = {},
) {
  const { ssm, calls } = ssmWith(over.key ?? (() => PRIVATE));
  const sent: { url: string; init: RequestInit }[] = [];
  const doFetch =
    over.fetch ??
    (vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(null, { status: over.status ?? 201 });
    }) as unknown as typeof fetch);
  const gw = createLivePush({
    stage: 'dev',
    appUrl: over.appUrl ?? 'https://dev.example',
    fetch: doFetch,
    ssm,
    now: () => 1_700_000_000_000,
  });
  return { gw, sent, ssmCalls: calls };
}

describe('live push gateway', () => {
  it('POSTs the encrypted body to the endpoint with the D14 headers, no redirects, a timeout', async () => {
    const { gw, sent, ssmCalls } = live();
    expect(await gw.readiness()).toBe('ok');
    expect(await gw.send(target, '{"web_push":8030}', opts)).toEqual({ status: 201 });
    const [{ url, init }] = sent as [{ url: string; init: RequestInit }];
    expect(url).toBe(target.endpoint);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = init.headers as Record<string, string>;
    expect(h).toMatchObject({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '3600',
      urgency: 'high',
      topic: opts.topic,
    });
    expect(h.authorization).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${publicKeyOf(PRIVATE)}$`),
    );
    expect((init.body as Buffer).length).toBe(86 + 17 + 1 + 16);
    // The private key, decrypted, read once for the warm container.
    await gw.send(target, '{}', opts);
    expect(ssmCalls).toEqual([
      { Name: '/aperture/dev/push/vapid_private_key', WithDecryption: true },
    ]);
  });

  it('a 403 drops the cached key, so the next send re-reads SSM (a rotation)', async () => {
    const { gw, ssmCalls } = live({ status: 403 });
    expect(await gw.send(target, '{}', opts)).toEqual({ status: 403 });
    await gw.send(target, '{}', opts);
    expect(ssmCalls).toHaveLength(2);
  });

  it('a timeout or a network failure is a status-0 answer, never a throw', async () => {
    const timeout = live({
      fetch: (async () => {
        throw Object.assign(new Error('t'), { name: 'TimeoutError' });
      }) as unknown as typeof fetch,
    });
    expect(await timeout.gw.send(target, '{}', opts)).toEqual({ status: 0, reason: 'timeout' });
    const net = live({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(await net.gw.send(target, '{}', opts)).toEqual({ status: 0, reason: 'network' });
  });

  it('keys that can never work answer `keys` without a request', async () => {
    const { gw, sent } = live();
    expect(await gw.send({ ...target, p256dh: 'BPk-p256dh-sample' }, '{}', opts)).toEqual({
      status: 0,
      reason: 'keys',
    });
    expect(sent).toHaveLength(0);
  });

  it('never POSTs off the allowlist, even from a stored row', async () => {
    const { gw, sent } = live();
    for (const endpoint of ['https://evil.example/x', 'http://web.push.apple.com/x'])
      await expect(gw.send({ ...target, endpoint }, '{}', opts)).rejects.toThrow(/allowlist/);
    expect(sent).toHaveLength(0);
  });

  it('is not configured without the key parameter or an app URL; other SSM failures throw', async () => {
    expect(await live({ key: notFound }).gw.readiness()).toBe('no-key');
    expect(await live({ appUrl: '' }).gw.readiness()).toBe('no-key');
    await expect(live({ key: () => new Error('AccessDenied') }).gw.readiness()).rejects.toThrow(
      'AccessDenied',
    );
    await expect(live({ key: notFound }).gw.send(target, '{}', opts)).rejects.toThrow(
      /not configured/,
    );
  });

  // A value that isn't a P-256 private key is the stage's fault, read as such before any send — never a
  // "network error" — and never cached, so a fixed parameter works on the next tick.
  it('a malformed private key reads as bad-key, sends nothing, and is re-read until fixed', async () => {
    let value: string | Error = 'not-a-key';
    const { gw, sent, ssmCalls } = live({ key: () => value });
    expect(await gw.readiness()).toBe('bad-key');
    await expect(gw.send(target, '{}', opts)).rejects.toThrow(/not configured/);
    expect(sent).toHaveLength(0);
    value = Buffer.alloc(33, 7).toString('base64url'); // 33 octets: not a P-256 scalar
    expect(await gw.readiness()).toBe('bad-key');
    value = PRIVATE;
    expect(await gw.readiness()).toBe('ok');
    expect(await gw.send(target, '{}', opts)).toEqual({ status: 201 });
    expect(ssmCalls).toHaveLength(4); // every read until it's good (the send's too), then held
  });

  it('signs before the request: a signing fault throws, it is not a network error', async () => {
    const { gw, sent } = live();
    // An endpoint the allowlist admits but whose origin can't be signed for can't occur, so break `now`.
    const broken = createLivePush({
      stage: 'dev',
      appUrl: 'https://dev.example',
      fetch: (async () => new Response(null, { status: 201 })) as unknown as typeof fetch,
      ssm: ssmWith(() => PRIVATE).ssm,
      now: () => {
        throw new RangeError('clock');
      },
    });
    await expect(broken.send(target, '{}', opts)).rejects.toThrow('clock');
    expect(await gw.send(target, '{}', opts)).toEqual({ status: 201 });
    expect(sent).toHaveLength(1);
  });
});

describe('BFF public key reader', () => {
  it('reads the public parameter (never the private one), holds it, and re-reads after the cache', async () => {
    let clock = 0;
    const { ssm, calls } = ssmWith(() => 'BPUB');
    const read = createPublicKeyReader({ stage: 'prod', ssm, now: () => clock });
    expect(await read()).toBe('BPUB');
    expect(await read()).toBe('BPUB');
    expect(calls).toEqual([{ Name: '/aperture/prod/push/vapid_public_key' }]);
    clock += 10 * 60_000;
    await read();
    expect(calls).toHaveLength(2);
  });

  it('no parameter → null (unconfigured), re-read on the next call; other failures throw', async () => {
    let v: string | Error = notFound();
    const { ssm, calls } = ssmWith(() => v);
    const read = createPublicKeyReader({ stage: 'dev', ssm });
    expect(await read()).toBeNull();
    v = 'BPUB';
    expect(await read()).toBe('BPUB');
    expect(calls).toHaveLength(2);
    const failing = createPublicKeyReader({
      stage: 'dev',
      ssm: ssmWith(() => new Error('Throttled')).ssm,
    });
    await expect(failing()).rejects.toThrow('Throttled');
  });
});
