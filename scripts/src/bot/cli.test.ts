import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { acquireLock, lockPerms, lockWait, main, parseSlot, tellingWhoToTell } from './cli.ts';
import { PERMS } from './token.ts';
import { fakeApi, fakeClock, ghError } from './fakes.ts';
import { LockHeld, MainPending } from './lock.ts';

const NOW = Date.parse('2026-10-13T20:00:00Z');
const holder = { branch: 'flux', sha: 'a'.repeat(40), expiresAt: '2026-10-13T20:30:00.000Z' };

const devlockRows = (dir: string) => {
  const h = join(dir, 'history');
  return (existsSync(h) ? readdirSync(h) : []).flatMap((f) =>
    readFileSync(join(h, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
};

function ctx(branch: () => string = () => 'ci-bot') {
  const dir = mkdtempSync(join(tmpdir(), 'bot-cli-'));
  const lines: string[] = [];
  return {
    dir,
    lines,
    c: {
      dir,
      branch,
      hub: () => 'dispatch',
      log: (s: string) => void lines.push(s),
      now: () => NOW,
    },
  };
}

describe('the refused acquire', () => {
  it('prints whom to tell, caches the holder, and rethrows the same error', async () => {
    const { dir, lines, c } = ctx();
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(
      join(dir, 'sessions', '1.json'),
      JSON.stringify({ branch: 'flux', name: 'flux-session', state: 'working' }),
    );
    const refused = new LockHeld(holder);
    const err = await tellingWhoToTell(c, () => Promise.reject(refused)).catch((e: unknown) => e);
    expect(err).toBe(refused);
    expect(lines[0]).toMatch(/^dev is locked — send these now, once each/);
    expect(lines[1]).toMatch(
      /^ {2}SendMessage dispatch: "\[lock\] ci-bot — queued behind flux \(flux-session\)/,
    );
    expect(lines[2]).toMatch(/^ {2}SendMessage flux-session: "Queued behind you/);
    expect(JSON.parse(readFileSync(join(dir, 'devlock.json'), 'utf8')).holder).toEqual(holder);
    // the wait starts at the refusal (lock-events.ts)
    expect(devlockRows(dir)).toEqual([
      expect.objectContaining({
        action: 'wait-start',
        branch: 'ci-bot',
        slots: ['dev'],
        behind: [{ slot: 'dev', branch: 'flux' }],
        via: 'refused',
      }),
    ]);
  });

  it('passes other errors and successes through untouched', async () => {
    const { lines, c } = ctx();
    const other = new Error('HEAD is behind origin/main');
    await expect(tellingWhoToTell(c, () => Promise.reject(other))).rejects.toBe(other);
    expect(await tellingWhoToTell(c, () => Promise.resolve(7))).toBe(7);
    expect(lines).toEqual([]);
  });

  it('still rethrows the refusal when the branch lookup fails', async () => {
    const { lines, c } = ctx(() => {
      throw new Error('detached HEAD');
    });
    const refused = new LockHeld(holder);
    await expect(tellingWhoToTell(c, () => Promise.reject(refused))).rejects.toBe(refused);
    expect(lines[1]).toMatch(/\[lock\] <your branch> — queued behind flux;/);
    expect(devlockRows(c.dir)).toEqual([]); // no branch, no wait to start
  });

  it('names both holders and caches each slot when both refused', async () => {
    const { dir, lines, c } = ctx();
    const lc = { branch: 'lc', sha: 'b'.repeat(40), expiresAt: '2026-10-13T20:20:00.000Z' };
    const refused = new LockHeld(holder, 'dev', [{ slot: 'devb', holder: lc }]);
    await expect(tellingWhoToTell(c, () => Promise.reject(refused))).rejects.toBe(refused);
    expect(lines[0]).toMatch(/^both dev slots are locked — .*`pnpm bot lock wait --any`/);
    expect(lines[1]).toMatch(/queued behind flux on dev and lc on devb; lock wait --any next/);
    expect(JSON.parse(readFileSync(join(dir, 'devlock.json'), 'utf8')).holder).toEqual(holder);
    expect(JSON.parse(readFileSync(join(dir, 'devlock.devb.json'), 'utf8')).holder).toEqual(lc);
  });

  it("names main's pending deploy beside the holder, with the wait that covers both", async () => {
    const { lines, c } = ctx();
    const refused = new MainPending([
      { slot: 'dev', holder: null, run: 'https://github.com/radatta/aperture/actions/runs/1' },
      { slot: 'devb', holder },
    ]);
    await expect(tellingWhoToTell(c, () => Promise.reject(refused))).rejects.toBe(refused);
    expect(lines[0]).toMatch(
      /^devb is locked \(and main's deploy is still to land on dev\) — .*`pnpm bot lock wait --any`/,
    );
    expect(lines[1]).toMatch(
      /queued behind flux on devb and main's deploy on dev; lock wait --any next/,
    );
    expect(devlockRows(c.dir)[0]).toMatchObject({
      slots: ['dev', 'devb'],
      behind: [{ slot: 'devb', branch: 'flux' }],
      main: ['dev'],
    });
  });

  it('still tells the hub when only main holds the slot up, and the holder main waits for', async () => {
    const { lines, c } = ctx();
    const alone = new MainPending([{ slot: 'dev', holder: null, run: 'u' }]);
    await expect(tellingWhoToTell(c, () => Promise.reject(alone))).rejects.toBe(alone);
    expect(lines).toEqual([
      "main's deploy is still to land on dev — send these now, once each, then `pnpm bot lock wait` in the background:",
      `  SendMessage dispatch: "[lock] ci-bot — queued behind main's deploy on dev; lock wait next."`,
    ]);
    const { lines: l2, c: c2 } = ctx();
    const behind = new MainPending([{ slot: 'dev', holder, run: 'u' }]);
    await expect(tellingWhoToTell(c2, () => Promise.reject(behind))).rejects.toBe(behind);
    expect(l2[0]).toMatch(/^dev is locked \(and main's deploy is still to land on dev\) — /);
    expect(l2[1]).toMatch(/queued behind flux, then main's deploy; lock wait next/);
  });
});

describe('--slot', () => {
  it('names a slot, or is misuse', () => {
    expect(parseSlot(undefined)).toBeUndefined();
    expect(parseSlot('dev')).toBe('dev');
    expect(parseSlot('devb')).toBe('devb');
    for (const bad of ['true', 'prod', 'devc', ''])
      expect(() => parseSlot(bad)).toThrow(/--slot must be/);
  });
});

// `pnpm bot` is plain node (type stripping, builtins only): an import past node: builtins, an extensionless one, or
// syntax Node can't strip dies here — the iOS routing reaches into the devcheck's glob and path list for this reason.
describe('the CLI under plain node', () => {
  it('loads and prints its usage', () => {
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const out = execFileSync(process.execPath, [cli, 'help'], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    expect(out).toMatch(/^pnpm bot <command>/);
  });
});

// The refusal goes to stderr, named: captured here (and asserted), so a green run prints nothing.
const refusal = async (argv: string[]) => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await main(argv);
    return { code, said: err.mock.calls.map((c) => String(c[0])).join('\n') };
  } finally {
    err.mockRestore();
  }
};

describe('prune-branches flags', () => {
  it.each([
    [['--dry-run=1'], '--dry-run takes no value'],
    [['--dryrun'], 'unknown flag --dryrun'],
    [['--dry-run', 'x'], '--dry-run takes no value'],
    [['--force'], 'unknown flag --force'],
    [['extra'], 'unexpected argument extra'],
  ])('refuses %j as a usage error, before any git call or delete', async (args, why) => {
    const r = await refusal(['prune-branches', ...args]);
    expect(r.code).toBe(2);
    expect(r.said).toContain(`prune-branches: ${why}`);
  });
});

describe('run flags', () => {
  it.each([
    [['cancel', '42', '--falied'], 'run cancel: unknown flag --falied'],
    [['rerun', '42', '--failed=1'], 'run rerun: --failed takes no value'],
    [['rerun', '42', 'extra'], 'run rerun: unexpected argument 42 extra'],
    [['rerun'], 'run takes cancel|rerun <run-id> [--failed]'],
    [['cancel', 'x42'], 'run takes cancel|rerun <run-id> [--failed]'],
    [['foo', '42'], 'unknown run subcommand "foo"'],
    [['cancel', '42', '--failed'], 'run cancel: unknown flag --failed'],
  ])('refuses %j as a usage error, before any token is minted', async (args, why) => {
    const r = await refusal(['run', ...args]);
    expect(r.code).toBe(2);
    expect(r.said).toContain(why);
  });
});

// The CLI's own wiring of main-pending.ts: `lock wait` doesn't wake on a slot main is still to land on, and
// `lock acquire` is refused it — the same guard deploy-dev carries.
describe('lock wait and lock acquire hold back for main', () => {
  const R = '/repos/radatta/aperture';
  // Slot A's lock is free; main's run has its wait-dev running until `untilMs`.
  const github = (clock: { now: () => number }, untilMs: number) =>
    fakeApi({
      [`GET ${R}/git/ref/locks/`]: () => {
        throw ghError(404);
      },
      [`GET ${R}/actions/workflows/deploy.yml/runs?`]: () => ({
        workflow_runs:
          clock.now() < untilMs
            ? [
                {
                  id: 9,
                  display_title: 'm',
                  created_at: '',
                  status: 'in_progress',
                  conclusion: null,
                  html_url: 'main-run',
                },
              ]
            : [],
      }),
      [`GET ${R}/actions/runs/9/jobs`]: () => ({
        jobs: [{ name: 'wait-dev', status: 'in_progress', conclusion: null, completed_at: null }],
      }),
    });
  const quietLog = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

  it('mints Actions read only for the subcommands that read main’s runs', () => {
    expect(lockPerms('acquire')).toBe(PERMS.lockAcquire);
    expect(lockPerms('wait')).toBe(PERMS.lockWait);
    expect(lockPerms('status')).toBe(PERMS.lockRead);
    expect(lockPerms('renew')).toBe(PERMS.lock);
    expect(lockPerms('release')).toBe(PERMS.lock);
  });

  it('lock wait sleeps through a free slot until main has landed', async () => {
    const log = quietLog();
    const clock = fakeClock(NOW);
    const g = github(clock, NOW + 90_000);
    expect(await lockWait(g.api, {}, null, () => undefined, 'ci-bot', clock)).toBe(0);
    expect(clock.t).toBe(NOW + 90_000);
    log.mockRestore();
  });

  it('lock wait logs the wait: its start at the first blocked read, its end with the outcome', async () => {
    const log = quietLog();
    const dir = mkdtempSync(join(tmpdir(), 'bot-cli-'));
    const clock = fakeClock(NOW);
    const g = github(clock, NOW + 90_000);
    expect(await lockWait(g.api, {}, dir, () => undefined, 'ci-bot', clock)).toBe(0);
    expect(devlockRows(dir)).toEqual([
      expect.objectContaining({
        action: 'wait-start',
        slots: ['dev'],
        behind: [],
        main: ['dev'],
        via: 'wait',
      }),
      expect.objectContaining({ action: 'wait-end', outcome: 'free', slot: 'dev', waitedSec: 90 }),
    ]);
    // a second wait on a free slot: the first closed nothing (no acquired), so it ends the same wait again
    const free = github(clock, 0);
    expect(await lockWait(free.api, {}, dir, () => undefined, 'ci-bot', clock)).toBe(0);
    expect(devlockRows(dir).map((r) => r.action)).toEqual(['wait-start', 'wait-end', 'wait-end']);
    log.mockRestore();
  });

  it('lock wait gives up naming main, never a missing holder', async () => {
    const log = quietLog();
    const clock = fakeClock(NOW);
    const g = github(clock, Infinity);
    expect(await lockWait(g.api, { max: '1' }, null, () => undefined, 'ci-bot', clock)).toBe(75);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(
      /^dev: main's Deploy run is still to land there after 1 min/,
    );
    log.mockRestore();
  });

  it('lock acquire is refused the slot, writing nothing', async () => {
    const clock = fakeClock(NOW);
    const g = github(clock, Infinity);
    const err = await acquireLock(g.api, 'ci-bot', 'a'.repeat(40), NOW, 'dev').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MainPending);
    expect((err as Error).message).toMatch(/main's deploy is still to land on dev \(main-run\)/);
    expect(g.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});
