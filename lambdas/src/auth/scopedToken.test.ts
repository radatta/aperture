import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryDoc } from '../ddb/DocClient';
import { pk, sk } from '../ddb/keys';
import { ScopedTokenStore } from '../ddb/scopedTokens';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { Repo } from '../ddb/repo';
import {
  CaptureBusyError,
  recordCaptureTask,
  reserveCapture,
  resolveScopedToken,
} from './scopedToken';

// F224: several captures at once through one token race on its row. A lost race backs off (full jitter) and
// tries again; only when every try lost is the answer "busy" — never a generic error.

async function setup() {
  const doc = new InMemoryDoc();
  const store = new ScopedTokenStore(doc, liveWrites(doc));
  const b = new BackendClient(new Repo(doc, liveWrites(doc), 'u1'), {
    userId: 'u1',
    scopedTokens: store,
  });
  const { token, info } = await b.mintScopedToken('capture', 'iPhone');
  const auth = await resolveScopedToken(store, `Bearer ${token}`, 'capture');
  // Another request lands first, `times` times: each putIf on the row finds it moved on.
  const lose = (times: number) => {
    let left = times;
    const key = [pk('u1'), sk.stoken(info.id)] as const;
    const rival = () => {
      const row = doc.snapshot().find((i) => i.PK === key[0] && i.SK === key[1])!;
      doc.putNow({ ...row, updatedAt: (row.updatedAt as number) + 1 });
      if (--left > 0) doc.interceptNextPutIf(...key, rival);
    };
    doc.interceptNextPutIf(...key, rival);
  };
  return { doc, store, auth, lose, id: info.id };
}

afterEach(() => vi.restoreAllMocks());

describe('the token row under a race (casRow)', () => {
  it('a few lost races back off and land', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { store, auth, lose, id } = await setup();
    lose(5);
    expect(await reserveCapture(store, auth, 'h1', Date.now())).toEqual({ kind: 'new' });
    expect((await store.row('u1', id))!.uses).toBe(1);
  });

  it('every try lost: busy, and nothing written', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { store, auth, lose, id } = await setup();
    lose(100);
    const err = await reserveCapture(store, auth, 'h1', Date.now()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureBusyError);
    expect((await store.row('u1', id))!.uses).toBe(0);
  });

  it('waits a jittered, capped while between tries', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const waits: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      return real(fn, 0);
    }) as typeof setTimeout);
    const { store, auth, lose } = await setup();
    lose(100);
    await reserveCapture(store, auth, 'h1', Date.now()).catch(() => {});
    expect(waits).toEqual([25, 50, 100, 200, 200, 200, 200]);
  });

  it('the bookkeeping after a save gives up after three tries, without the long tail', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { store, auth, lose, id } = await setup();
    await reserveCapture(store, auth, 'h1', Date.now());
    lose(3);
    const err = await recordCaptureTask(store, auth, 'h1', 't1', Date.now()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CaptureBusyError);
    expect((await store.row('u1', id))!.lastTaskId).toBeNull();
    lose(2);
    await recordCaptureTask(store, auth, 'h1', 't1', Date.now());
    expect((await store.row('u1', id))!.lastTaskId).toBe('t1');
  });
});
