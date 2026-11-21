import { describe, expect, it, vi } from 'vitest';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { catchUpTag, reminderTag } from '@aperture/shared';
import { BODY_CAP, createLivePush, readCapped, serviceDetail, wireTopic } from './livePush';
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
type Body = ConstructorParameters<typeof Response>[0]; // no DOM lib in lambdas: no BodyInit
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
  over: {
    status?: number;
    body?: () => Body;
    fetch?: typeof fetch;
    key?: () => string | Error;
    appUrl?: string;
  } = {},
) {
  const { ssm, calls } = ssmWith(over.key ?? (() => PRIVATE));
  const sent: { url: string; init: RequestInit }[] = [];
  const doFetch =
    over.fetch ??
    (vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(over.body?.() ?? null, { status: over.status ?? 201 });
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
      topic: wireTopic(opts.topic),
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
    expect(await live({ appUrl: '' }).gw.readiness()).toBe('no-app-url');
    await expect(live({ appUrl: '' }).gw.send(target, '{}', opts)).rejects.toThrow(/no APP_URL/);
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

  it('trims the parameter: a pasted trailing newline is no part of the key', async () => {
    const { gw } = live({ key: () => `${PRIVATE}\n` });
    expect(await gw.readiness()).toBe('ok');
    expect(await gw.send(target, '{}', opts)).toEqual({ status: 201 });
    const { ssm } = ssmWith(() => ' BPUB\n');
    expect(await createPublicKeyReader({ stage: 'dev', ssm })()).toBe('BPUB');
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

// D25: the Topic header is derived from the logical tag. Apple refused raw tags of length 4k+1
// (`ritualMorning`, `b<minute>`): no base64url decoder takes them (inference, 2026-11-21).
describe('wire Topic', () => {
  const minute = Date.UTC(2026, 10, 21, 17, 0);
  const cand = (over: object) => ({
    kind: 'dueDay' as const,
    fireAt: minute,
    taskId: null,
    title: 't',
    dueTime: null,
    ...over,
  });
  const tags = [
    reminderTag([cand({ taskId: '01J0000000000000000000000T' })]),
    reminderTag([cand({ kind: 'test' })]),
    reminderTag([cand({ kind: 'ritualMorning' })]),
    reminderTag([cand({ kind: 'ritualNight' })]),
    reminderTag([cand({}), cand({})]),
    catchUpTag(minute),
  ];

  it('is 24 base64url characters for every tag kind — a multiple of 4, inside RFC 8030 32', () => {
    expect(tags).toEqual([
      '01J0000000000000000000000T',
      'test',
      'ritualMorning',
      'ritualNight',
      'b29921340',
      'c29921340',
    ]);
    for (const tag of tags) expect(wireTopic(tag)).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it('is the same for the same tag (a retry still replaces its first copy) and distinct across tags', () => {
    expect(tags.map(wireTopic)).toEqual(tags.map(wireTopic));
    expect(new Set(tags.map(wireTopic)).size).toBe(tags.length);
    expect(wireTopic('test')).toBe('n4bQgYhMfWWaL-qgxVrQFaO_'); // pinned: a change would orphan nothing, but say so
  });
});

// D26: a refusal's reason, read from its body. Untrusted text bound for a log and Settings.
describe('push service reason', () => {
  const refused = async (status: number, body: () => Body) =>
    live({ status, body }).gw.send(target, '{}', opts);

  it("reads Apple's JSON reason, served as text/plain", async () => {
    expect(await refused(400, () => '{"reason":"BadWebPushTopic"}')).toEqual({
      status: 400,
      detail: 'BadWebPushTopic',
    });
  });

  it('reads Mozilla autopush and Google error shapes, and a plain-text body', async () => {
    const moz = JSON.stringify({
      code: 400,
      errno: 113,
      error: 'Bad Request',
      message: 'Invalid Topic header',
    });
    expect((await refused(400, () => moz)).detail).toBe('errno 113 Invalid Topic header');
    const fcm = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'x' } });
    expect((await refused(400, () => fcm)).detail).toBe('INVALID_ARGUMENT');
    expect(serviceDetail(JSON.stringify({ error: { message: 'bad header' } }))).toBe('bad header');
    expect(serviceDetail(JSON.stringify({ error: 'UnauthorizedRegistration' }))).toBe(
      'UnauthorizedRegistration',
    );
    expect((await refused(400, () => 'Invalid request\n')).detail).toBe('Invalid request');
  });

  it('an empty, HTML, oversize or shapeless body gives the status alone', async () => {
    expect(await refused(400, () => null)).toEqual({ status: 400 });
    expect(await refused(400, () => '')).toEqual({ status: 400 });
    expect(await refused(502, () => '<html><body>Bad Gateway</body></html>')).toEqual({
      status: 502,
    });
    const big = JSON.stringify({ reason: 'BadWebPushTopic', pad: 'x'.repeat(BODY_CAP) });
    expect(await refused(400, () => big)).toEqual({ status: 400 });
    for (const body of [
      '[]',
      'null',
      '42',
      '{}',
      '{"reason":7}',
      '{"reason":{"a":1}}',
      '{"reason":["x"]}',
      '{"reason":"  "}',
    ])
      expect(await refused(400, () => body)).toEqual({ status: 400 });
  });

  it("is sanitised: it can't forge the error text's wrapper, the health separator or a log line", () => {
    const hostile = 'Bad")\n{"event":"push_sent"} · — 🎉\u0000(x)';
    const d = serviceDetail(JSON.stringify({ reason: hostile }))!;
    expect(d).toMatch(/^[A-Za-z0-9 _.:,/'-]+$/);
    expect(d).not.toMatch(/[()"\n·—]/);
    expect(serviceDetail(JSON.stringify({ reason: 'A'.repeat(500) }))).toHaveLength(80);
    expect(serviceDetail(JSON.stringify({ reason: '🎉 · —' }))).toBeUndefined();
  });

  it('a body that errors mid-read or never ends gives the status alone, never a throw', async () => {
    const erroring = () =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"reason":"Bad'));
          c.error(new Error('reset'));
        },
      });
    expect(await refused(400, erroring)).toEqual({ status: 400 });
    let cancelled = false;
    const endless = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"reason":"BadWebPushTopic"'));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readCapped(new Response(endless, { status: 400 }), 20)).toBeNull();
    expect(cancelled).toBe(true);
  });

  it('a 403 with a reason still drops the cached key; a 2xx body is never read', async () => {
    const { gw, ssmCalls } = live({ status: 403, body: () => '{"reason":"BadJwtToken"}' });
    expect(await gw.send(target, '{}', opts)).toEqual({ status: 403, detail: 'BadJwtToken' });
    await gw.send(target, '{}', opts);
    expect(ssmCalls).toHaveLength(2);
    expect(await refused(201, () => '{"reason":"BadWebPushTopic"}')).toEqual({ status: 201 });
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
