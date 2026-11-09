import { describe, expect, it } from 'vitest';
import { lib } from './load';

const tag = lib('tag');
const relayLib = lib('relay');

async function handshake() {
  const nonce = tag.newNonce();
  const key = await tag.keyOf(nonce);
  const relay = relayLib.createRelay();
  expect(await relay.hello(JSON.stringify({ nonce }))).toBe(true);
  let seq = 0;
  const msg = async (fields: object, opts: { seq?: number; key?: CryptoKey } = {}) => {
    const body = JSON.stringify({ v: 2, seq: opts.seq ?? ++seq, at: 1, ...fields });
    return JSON.stringify({ body, tag: await tag.sign(opts.key ?? key, body) });
  };
  return { relay, msg, nonce };
}
const active = { screenSlug: 'two-sum', binding: { questionId: '1', status: 'active' } };
const snapshot = { kind: 'snapshot', slug: null, questionId: '1', payload: { code: 'x' } };

describe('relay: a page message is accepted only when it’s ours, in order, for the open sitting on screen', () => {
  it('drops a page script’s event without the stamp, out of sequence, or for another slug', async () => {
    const { relay, msg } = await handshake();
    expect(await relay.accept(await msg(snapshot), active)).toMatchObject({ ok: true });

    const forger = await tag.keyOf(tag.newNonce());
    expect(await relay.accept(await msg(snapshot, { key: forger }), active)).toEqual({ ok: false, reason: 'bad-tag' });
    expect(await relay.accept(JSON.stringify({ body: JSON.stringify({ v: 2, seq: 99, ...snapshot }) }), active)).toEqual({
      ok: false,
      reason: 'bad-tag',
    });

    const replayed = await msg(snapshot);
    expect((await relay.accept(replayed, active)).ok).toBe(true);
    expect(await relay.accept(replayed, active)).toEqual({ ok: false, reason: 'replayed-seq' });

    expect(await relay.accept(await msg({ ...snapshot, kind: 'note', slug: 'other' }), active)).toEqual({
      ok: false,
      reason: 'off-screen-slug',
    });
    expect(await relay.accept(await msg({ ...snapshot, questionId: '2' }), active)).toEqual({
      ok: false,
      reason: 'foreign-question',
    });
    expect(await relay.accept({ not: 'a string' }, active)).toEqual({ ok: false, reason: 'not-string' });
  });

  it('drops events when no sitting is open for the problem on screen, but still caches problem docs and hints', async () => {
    const { relay, msg } = await handshake();
    const none = { screenSlug: 'two-sum', binding: null };
    expect(await relay.accept(await msg(snapshot), none)).toEqual({ ok: false, reason: 'no-sitting' });
    const ended = { screenSlug: 'two-sum', binding: { questionId: '1', status: 'done' } };
    expect(await relay.accept(await msg(snapshot), ended)).toEqual({ ok: false, reason: 'no-sitting' });
    expect((await relay.accept(await msg({ kind: 'problem', slug: 'next-one', payload: {} }), none)).ok).toBe(true);
    expect((await relay.accept(await msg({ kind: 'hint', slug: null, questionId: '1' }), none)).ok).toBe(true);
    expect(await relay.accept(await msg({ kind: 'start', slug: 'two-sum' }), active)).toEqual({ ok: false, reason: 'kind' });
  });

  it('takes the first hello only, and nothing before it', async () => {
    const relay = relayLib.createRelay();
    expect(await relay.accept('{}', active)).toEqual({ ok: false, reason: 'no-handshake' });
    expect(relay.hello(JSON.stringify({ nonce: 'short' }))).toBeNull();
    const first = tag.newNonce();
    expect(await relay.hello(JSON.stringify({ nonce: first }))).toBe(true);
    expect(relay.hello(JSON.stringify({ nonce: tag.newNonce() }))).toBeNull();
    const key = await tag.keyOf(first);
    const body = JSON.stringify({ v: 2, seq: 1, ...snapshot });
    expect((await relay.accept(JSON.stringify({ body, tag: await tag.sign(key, body) }), active)).ok).toBe(true);
  });

  it('reads the problem on screen from the path only', () => {
    expect(relayLib.slugOf('/problems/two-sum/description/')).toBe('two-sum');
    expect(relayLib.slugOf('/problems/two-sum')).toBe('two-sum');
    expect(relayLib.slugOf('/problemset/')).toBeNull();
    expect(relayLib.slugOf('/problems/Two_Sum/')).toBeNull();
  });
});
