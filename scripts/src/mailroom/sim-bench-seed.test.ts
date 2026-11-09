// `pnpm sim-bench:seed` against fakes: the slot-A lock around the seed, the ledger as the only cleanup key, and a
// failed seed freeing dev again. docs/ops/SIM-BENCH.md → Seed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevcheckError } from '../devcheck/errors';
import { openLedger, pendingIds, type Ledger } from '../devcheck/ledger';
import {
  clean,
  pendingSeeds,
  seed,
  SEED_RUN,
  type SeedApi,
  type SeedDeps,
} from './sim-bench-seed.ts';

const SEED = { title: 'devcheck-ios simben', estimateMin: 15, status: 'in_progress' };

describe('sim-bench seed', () => {
  let dir: string;
  let ledger: Ledger;
  let tasks: Map<string, { id: string; title: string; status: string }>;
  let calls: string[];
  let held: 'none' | 'ours' | 'other';
  let n: number;
  let failCreate: boolean;
  let runBusy: boolean;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seed-'));
    ledger = openLedger(join(dir, 'ledger.dev.jsonl'));
    tasks = new Map();
    calls = [];
    held = 'none';
    n = 0;
    failCreate = false;
    runBusy = false;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (): SeedDeps => ({
    pick: async () => {
      if (held === 'other') throw new DevcheckError('NO_LOCK', 'another-lane is testing on dev');
      return held === 'ours'
        ? { slot: 'dev', held: true, why: 'm1-sim-bench holds the dev lock' }
        : { slot: 'dev', held: false, why: 'm1-sim-bench holds no dev lock — dev (slot A), free' };
    },
    acquire: async () => {
      calls.push('acquire');
      held = 'ours';
      return '2026-11-09T16:45:00.000Z';
    },
    release: async () => {
      calls.push('release');
      held = 'none';
    },
    runLock: () => {
      if (runBusy) throw new Error('another dev check (pid 42) holds run.lock — wait for it');
      calls.push('runLock');
      return () => calls.push('runUnlock');
    },
    ledger,
    signIn: async (run) => {
      calls.push('signIn');
      // the devcheck API client ledgers its creates; deletes are the caller's to record
      const api: SeedApi = {
        reads: { getTask: async (id) => tasks.get(id) ?? null },
        writes: {
          createTask: async (input) => {
            if (failCreate) throw new Error('500 from the BFF');
            const id = `t${++n}`;
            ledger.append({ run, op: 'created', id, via: 'api:createTask', title: input.title });
            tasks.set(id, { id, title: input.title, status: 'backlog' });
            return { id };
          },
          transitionTask: async (id, status) => void (tasks.get(id)!.status = status),
          deleteTask: async (id) => void tasks.delete(id),
        },
      };
      return { api, close: async () => void calls.push('close') };
    },
    seed: SEED,
    now: () => new Date('2026-11-09T16:00:00Z'),
    log: () => {},
  });

  it('takes the dev lock, then creates the seed in progress, ledgered under the seed run', async () => {
    const r = await seed(deps());
    expect(r).toEqual({ id: 't1', expiresAt: '2026-11-09T16:45:00.000Z', reused: false });
    expect(tasks.get('t1')).toEqual({ id: 't1', title: SEED.title, status: 'in_progress' });
    expect(calls).toEqual(['runLock', 'acquire', 'signIn', 'close', 'runUnlock']);
    expect(held).toBe('ours'); // held through the bench, until --clean
    expect(pendingSeeds(ledger)).toEqual(['t1']);
    expect(
      ledger
        .read()
        .find((e) => e.id === 't1')!
        .run.startsWith(SEED_RUN),
    ).toBe(true);
  });

  it('reuses a seed still in place rather than adding a second', async () => {
    await seed(deps());
    const r = await seed(deps());
    expect(r.reused).toBe(true);
    expect(r.id).toBe('t1');
    expect(tasks.size).toBe(1);
  });

  it('refuses while another branch tests on dev, before any lock or write', async () => {
    held = 'other';
    await expect(seed(deps())).rejects.toThrow('another-lane is testing on dev');
    expect(calls).toEqual(['runLock', 'runUnlock']);
    expect(tasks.size).toBe(0);
  });

  it('refuses while a devcheck runs, before taking the dev lock (none leaks)', async () => {
    runBusy = true;
    await expect(seed(deps())).rejects.toThrow('holds run.lock');
    expect(calls).toEqual([]);
    expect(held).toBe('none');
  });

  it('a failed seed frees the dev lock it took', async () => {
    failCreate = true;
    await expect(seed(deps())).rejects.toThrow('500 from the BFF');
    expect(calls).toContain('release');
    expect(held).toBe('none');
    expect(calls.at(-1)).toBe('runUnlock');
  });

  it('an acquire that fails after taking the lock (an answer it could not parse) still frees dev', async () => {
    const d = deps();
    d.acquire = async () => {
      held = 'ours';
      throw new Error('pnpm bot lock acquire said: something new');
    };
    await expect(seed(d)).rejects.toThrow('something new');
    expect(held).toBe('none');
  });

  it('a failed seed keeps a lock the branch held before it (its own dev test)', async () => {
    held = 'ours';
    failCreate = true;
    await expect(seed(deps())).rejects.toThrow();
    expect(calls).not.toContain('release');
  });

  it('--clean deletes only seed ids, by ledger id, records them, and frees dev', async () => {
    ledger.append({
      run: '2026-11-09T01-00-00-full',
      op: 'created',
      id: 'other',
      via: 'api:createTask',
      title: SEED.title,
    });
    tasks.set('other', { id: 'other', title: SEED.title, status: 'in_progress' });
    await seed(deps());
    const r = await clean(deps());
    expect(r).toEqual({ deleted: ['t1'], gone: [], failed: [] });
    expect(tasks.has('other')).toBe(true); // same title, another run's id: never touched
    expect(pendingIds(ledger.read())).toEqual(['other']);
    expect(held).toBe('none');
  });

  it('--clean whose sign-in dies still frees dev, keeps the seed pending, and fails', async () => {
    await seed(deps());
    const d = deps();
    d.signIn = async () => {
      throw new Error('browserType.launch: Target page, context or browser has been closed');
    };
    await expect(clean(d)).rejects.toThrow('browser has been closed');
    expect(held).toBe('none');
    expect(pendingSeeds(ledger)).toEqual(['t1']);
    expect(calls.at(-1)).toBe('release');
  });

  it('--clean refused by another branch on dev releases nothing', async () => {
    held = 'other';
    await expect(clean(deps())).rejects.toThrow('another-lane is testing on dev');
    expect(calls).not.toContain('release');
  });

  it('--clean records a seed already gone and still frees dev', async () => {
    await seed(deps());
    tasks.clear();
    expect(await clean(deps())).toEqual({ deleted: [], gone: ['t1'], failed: [] });
    expect(pendingSeeds(ledger)).toEqual([]);
    expect(held).toBe('none');
  });
});
