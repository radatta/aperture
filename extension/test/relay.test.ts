import { describe, expect, it } from 'vitest';
import { lib } from './load';

const tag = lib('tag');
const relayLib = lib('relay');

const raw = {
  url: 'https://leetcode.com/graphql/',
  page: '/problems/two-sum/description/',
  reqText: '{}',
  resText: null,
  reqAt: 1,
  resAt: 2,
};
async function handshake() {
  const nonce = tag.newNonce();
  const key = await tag.keyOf(nonce);
  const relay = relayLib.createRelay();
  expect(await relay.hello(JSON.stringify({ nonce }))).toBe(true);
  let seq = 0;
  const msg = async (fields: object = {}, opts: { seq?: number; key?: CryptoKey } = {}) => {
    const body = JSON.stringify({ v: 3, seq: opts.seq ?? ++seq, ...raw, ...fields });
    return JSON.stringify({ body, tag: await tag.signed(opts.key ?? key, body) });
  };
  return { relay, msg };
}
const active = { screenSlug: 'two-sum', binding: { questionId: '1', status: 'active' } };
const snapshot = { kind: 'snapshot', slug: null, questionId: '1', payload: { code: 'x' } };

describe('relay: a page message is accepted only when it’s ours, in order, for the open sitting on screen', () => {
  it('drops a page script’s message without the stamp, out of sequence, or malformed', async () => {
    const { relay, msg } = await handshake();
    expect(await relay.accept(await msg())).toEqual({ ok: true, raw });

    const forger = await tag.keyOf(tag.newNonce());
    expect(await relay.accept(await msg({}, { key: forger }))).toEqual({
      ok: false,
      reason: 'bad-tag',
    });
    expect(
      await relay.accept(JSON.stringify({ body: JSON.stringify({ v: 3, seq: 99, ...raw }) })),
    ).toEqual({
      ok: false,
      reason: 'bad-tag',
    });

    const replayed = await msg();
    expect((await relay.accept(replayed)).ok).toBe(true);
    expect(await relay.accept(replayed)).toEqual({ ok: false, reason: 'replayed-seq' });

    expect(await relay.accept(await msg({ v: 2 }))).toEqual({ ok: false, reason: 'version' });
    for (const bad of [
      { url: 7 },
      { reqText: { x: 1 } },
      { resText: 'x'.repeat(relayLib.RAW_MAX + 1) },
      { reqAt: 'now' },
      { page: 7 },
    ])
      expect(await relay.accept(await msg(bad))).toEqual({ ok: false, reason: 'raw-shape' });
    expect(await relay.accept({ not: 'a string' })).toEqual({ ok: false, reason: 'not-string' });
    expect(await relay.accept('x'.repeat(7 * 1024 * 1024))).toEqual({
      ok: false,
      reason: 'too-big',
    });
  });

  it('admits a problem doc or hint only for the problem on screen, and events only for its open sitting', () => {
    const { admit } = relayLib;
    expect(admit(snapshot, active)).toEqual({ ok: true });
    expect(admit({ ...snapshot, kind: 'note', slug: 'other' }, active)).toEqual({
      ok: false,
      reason: 'off-screen-slug',
    });
    expect(admit({ ...snapshot, questionId: '2' }, active)).toEqual({
      ok: false,
      reason: 'foreign-question',
    });
    const none = { screenSlug: 'two-sum', binding: null };
    expect(admit(snapshot, none)).toEqual({ ok: false, reason: 'no-sitting' });
    expect(
      admit(snapshot, { screenSlug: 'two-sum', binding: { questionId: '1', status: 'done' } }),
    ).toEqual({
      ok: false,
      reason: 'no-sitting',
    });
    expect(admit({ kind: 'problem', slug: 'two-sum', payload: {} }, none)).toEqual({ ok: true });
    expect(admit({ kind: 'problem', slug: 'next-one', payload: {} }, none)).toEqual({
      ok: false,
      reason: 'off-screen-slug',
    });
    expect(admit({ kind: 'problem', slug: null, payload: {} }, none)).toEqual({
      ok: false,
      reason: 'off-screen-slug',
    });
    expect(admit({ kind: 'hint', slug: null, questionId: '1' }, none)).toEqual({ ok: true });
    expect(
      admit({ kind: 'hint', slug: null, questionId: '1' }, { screenSlug: null, binding: null }),
    ).toEqual({
      ok: false,
      reason: 'off-problem',
    });
    expect(admit({ kind: 'start', slug: 'two-sum' }, active)).toEqual({
      ok: false,
      reason: 'kind',
    });
  });

  it('takes the first hello only, and nothing before it', async () => {
    const relay = relayLib.createRelay();
    expect(await relay.accept('{}')).toEqual({ ok: false, reason: 'no-handshake' });
    expect(relay.hello(JSON.stringify({ nonce: 'short' }))).toBeNull();
    const first = tag.newNonce();
    expect(await relay.hello(JSON.stringify({ nonce: first }))).toBe(true);
    expect(relay.hello(JSON.stringify({ nonce: tag.newNonce() }))).toBeNull();
    const key = await tag.keyOf(first);
    const body = JSON.stringify({ v: 3, seq: 1, ...raw });
    expect(
      (await relay.accept(JSON.stringify({ body, tag: await tag.signed(key, body) }))).ok,
    ).toBe(true);
  });

  it('reads the problem on screen from the path only', () => {
    expect(relayLib.slugOf('/problems/two-sum/description/')).toBe('two-sum');
    expect(relayLib.slugOf('/problems/two-sum')).toBe('two-sum');
    expect(relayLib.slugOf('/problemset/')).toBeNull();
    expect(relayLib.slugOf('/problems/Two_Sum/')).toBeNull();
  });
});
