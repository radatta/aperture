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
import { describe, expect, it } from 'vitest';
import { LockHeld, MainPending } from './lock.ts';
import type { Holder } from './lock.ts';
import {
  OPEN_WAIT_MS,
  lastTakes,
  lockLog,
  openWait,
  readLockEvents,
  takeLine,
} from './lock-events.ts';

const T0 = Date.parse('2026-11-18T19:00:00Z');
const MIN = 60_000;
const SHA = 'a'.repeat(40);

function board() {
  const dir = mkdtempSync(join(tmpdir(), 'lock-events-'));
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(
    join(dir, 'sessions', '1.json'),
    JSON.stringify({ branch: 'mine', name: 'mine-session', state: 'working' }),
  );
  let t = T0;
  const clock = { now: () => t, at: (ms: number) => void (t = ms) };
  const rows = () =>
    (existsSync(join(dir, 'history')) ? readdirSync(join(dir, 'history')) : [])
      .sort()
      .flatMap((f) =>
        readFileSync(join(dir, 'history', f), 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l)];
            } catch {
              return []; // the torn-line fixture
            }
          }),
      );
  return { dir, clock, rows, log: lockLog(dir, clock.now) };
}

const held = (branch: string, takenMs: number, expiresMs = takenMs + 45 * MIN): Holder => ({
  branch,
  sha: SHA,
  takenAt: new Date(takenMs).toISOString(),
  expiresAt: new Date(expiresMs).toISOString(),
});
const other = held('other', T0 - 10 * MIN);

describe('devlock events', () => {
  it('a refusal starts the wait and the take closes it with the wait in seconds', () => {
    const { clock, rows, log } = board();
    log.refused('mine', new LockHeld(other, 'dev'), []);
    clock.at(T0 + 12 * MIN);
    log.changed(held('mine', T0 + 12 * MIN), 'dev');
    expect(rows()).toEqual([
      {
        v: 1,
        t: '2026-11-18T19:00:00Z',
        kind: 'devlock',
        name: 'mine-session',
        action: 'wait-start',
        branch: 'mine',
        slots: ['dev'],
        behind: [{ slot: 'dev', branch: 'other' }],
        main: [],
        via: 'refused',
      },
      {
        v: 1,
        t: '2026-11-18T19:12:00Z',
        kind: 'devlock',
        name: 'mine-session',
        action: 'acquired',
        branch: 'mine',
        slot: 'dev',
        sha: SHA,
        takenAt: '2026-11-18T19:12:00.000Z',
        waitSec: 720,
        waitFrom: '2026-11-18T19:00:00Z',
      },
    ]);
  });

  it('a take with no wait says waitSec 0, and a renew or a live re-take (same takenAt) writes nothing', () => {
    const { dir, clock, rows } = board();
    const h = held('mine', T0);
    lockLog(dir, clock.now).changed(h, 'devb');
    clock.at(T0 + 30 * MIN);
    const renewed = { ...h, expiresAt: new Date(T0 + 75 * MIN).toISOString() };
    lockLog(dir, clock.now).changed(renewed, 'devb'); // another process: found in history
    const one = lockLog(dir, clock.now);
    one.changed(renewed, 'devb');
    one.changed(renewed, 'devb');
    expect(rows().map((r) => [r.action, r.slot, r.waitSec, 'waitFrom' in r])).toEqual([
      ['acquired', 'devb', 0, false],
    ]);
  });

  it('a lapsed own lock re-taken is a new hold', () => {
    const { clock, rows, log } = board();
    log.changed(held('mine', T0), 'dev');
    clock.at(T0 + 50 * MIN);
    log.changed(held('mine', T0 + 50 * MIN), 'dev');
    expect(rows().map((r) => r.takenAt)).toEqual([
      '2026-11-18T19:00:00.000Z',
      '2026-11-18T19:50:00.000Z',
    ]);
  });

  it('an older bot’s lock (no takenAt) never reads as a new hold', () => {
    const { rows, log } = board();
    const old: Holder = { ...held('mine', T0) };
    delete old.takenAt;
    log.changed(old, 'dev');
    log.changed(old, 'dev');
    expect(rows()).toEqual([]);
  });

  it('one wait across a refusal, a lock wait that gave up and a second lock wait', () => {
    const { clock, rows, log } = board();
    log.refused('mine', new LockHeld(other, 'dev'), []);
    clock.at(T0 + MIN);
    const reads = [{ slot: 'dev' as const, cur: { holder: other, tagSha: 't' } }];
    log.blocked('mine', reads, [], ['dev']); // still open: no second start
    clock.at(T0 + 56 * MIN);
    log.waitEnd('mine', { outcome: 'gave-up', slot: 'dev' }, ['dev'], T0 + MIN);
    clock.at(T0 + 57 * MIN);
    log.blocked('mine', reads, [], ['dev']);
    clock.at(T0 + 100 * MIN); // 44 min after the last wait-end: still the same wait
    log.waitEnd('mine', { outcome: 'free', slot: 'dev' }, ['dev'], T0 + 57 * MIN);
    clock.at(T0 + 101 * MIN);
    log.changed(held('mine', T0 + 101 * MIN), 'dev');
    expect(rows().map((r) => [r.action, r.outcome ?? r.waitedSec ?? r.waitSec ?? null])).toEqual([
      ['wait-start', null],
      ['wait-end', 'gave-up'],
      ['wait-end', 'free'],
      ['acquired', 101 * 60],
    ]);
    expect(rows()[1].waitedSec).toBe(55 * 60);
  });

  it('a lock wait started late inside an open wait, running its full 55 min, keeps the wait whole', () => {
    const { clock, rows, log } = board();
    log.refused('mine', new LockHeld(other, 'dev'), []);
    const reads = [{ slot: 'dev' as const, cur: { holder: other, tagSha: 't' } }];
    clock.at(T0 + 10 * MIN); // the lane told the hub, then started the wait
    log.blocked('mine', reads, [], ['dev']);
    clock.at(T0 + 65 * MIN); // 65 min after the last written row, but the wait began inside the window
    log.waitEnd('mine', { outcome: 'gave-up', slot: 'dev' }, ['dev'], T0 + 10 * MIN);
    clock.at(T0 + 70 * MIN);
    log.blocked('mine', reads, [], ['dev']);
    clock.at(T0 + 100 * MIN);
    log.waitEnd('mine', { outcome: 'free', slot: 'dev' }, ['dev'], T0 + 70 * MIN);
    clock.at(T0 + 101 * MIN);
    log.changed(held('mine', T0 + 101 * MIN), 'dev');
    expect(rows().map((r) => r.action)).toEqual(['wait-start', 'wait-end', 'wait-end', 'acquired']);
    expect(rows().at(-1)).toMatchObject({ waitSec: 101 * 60, waitFrom: '2026-11-18T19:00:00Z' });
  });

  it('a wait silent past OPEN_WAIT_MS is abandoned: the take reports none, the next refusal starts afresh', () => {
    const { clock, rows, log } = board();
    log.refused('mine', new LockHeld(other, 'dev'), []);
    clock.at(T0 + OPEN_WAIT_MS + 1000);
    log.waitEnd('mine', { outcome: 'free', slot: 'dev' }, ['dev'], T0 + OPEN_WAIT_MS + 1000); // a lock wait begun after the window lapsed
    log.refused('mine', new LockHeld(other, 'dev'), []);
    clock.at(T0 + OPEN_WAIT_MS + 5 * MIN);
    log.changed(held('mine', T0 + OPEN_WAIT_MS + 5 * MIN), 'dev');
    expect(rows().map((r) => [r.action, r.waitSec ?? null])).toEqual([
      ['wait-start', null],
      ['wait-start', null],
      ['acquired', 299], // from the second start, 1 s past the cap
    ]);
  });

  it('pairs by branch: another branch’s wait never closes or lengthens ours', () => {
    const { clock, rows, log } = board();
    log.refused('mine', new LockHeld(other, 'dev'), []);
    log.refused('third', new LockHeld(other, 'dev'), []);
    clock.at(T0 + 3 * MIN);
    log.changed(held('third', T0 + 3 * MIN), 'dev');
    clock.at(T0 + 9 * MIN);
    log.changed(held('mine', T0 + 9 * MIN), 'devb');
    const acq = rows().filter((r) => r.action === 'acquired');
    expect(acq.map((r) => [r.branch, r.name, r.waitSec])).toEqual([
      ['third', null, 180],
      ['mine', 'mine-session', 540],
    ]);
  });

  it('a wait across UTC midnight is read back from yesterday’s file', () => {
    const { dir, clock, log } = board();
    const late = Date.parse('2026-11-18T23:59:59Z');
    clock.at(late);
    log.refused('mine', new LockHeld(other, 'dev'), []);
    clock.at(late + 2000);
    log.changed(held('mine', late + 2000), 'dev');
    expect(readdirSync(join(dir, 'history')).sort()).toEqual([
      'events-2026-11-18.jsonl',
      'events-2026-11-19.jsonl',
    ]);
    expect(readLockEvents(dir, late + 2000).at(-1)).toMatchObject({
      action: 'acquired',
      waitSec: 2,
    });
  });

  it('both slots refused, with main pending on one: slots, behind and main', () => {
    const { rows, log } = board();
    const err = new MainPending([
      { slot: 'dev', holder: null, run: 'u' },
      { slot: 'devb', holder: other },
    ]);
    log.refused('mine', err, ['dev']);
    expect(rows()[0]).toMatchObject({
      slots: ['dev', 'devb'],
      behind: [{ slot: 'devb', branch: 'other' }],
      main: ['dev'],
    });
  });

  it('lock wait: blocked names live holders only; ours writes no wait-end; no open wait, no wait-end', () => {
    const { clock, rows, log } = board();
    log.waitEnd('mine', { outcome: 'free', slot: 'dev' }, ['dev'], T0); // a lock wait on a free slot
    expect(rows()).toEqual([]);
    const lapsed = held('gone', T0 - 60 * MIN);
    log.blocked(
      'mine',
      [
        { slot: 'dev', cur: { holder: other, tagSha: 't' } },
        { slot: 'devb', cur: { holder: lapsed, tagSha: 'u' } },
      ],
      ['devb'],
      ['dev', 'devb'],
    );
    clock.at(T0 + MIN);
    log.waitEnd('mine', { outcome: 'ours', slot: 'dev' }, ['dev', 'devb'], T0);
    expect(rows()).toEqual([
      expect.objectContaining({
        action: 'wait-start',
        slots: ['dev', 'devb'],
        behind: [{ slot: 'dev', branch: 'other' }],
        main: ['devb'],
        via: 'wait',
      }),
    ]);
    log.waitEnd('mine', { outcome: 'gave-up', slot: 'devb', main: true }, ['dev', 'devb'], T0);
    expect(rows()[1]).toMatchObject({
      action: 'wait-end',
      outcome: 'gave-up',
      main: true,
      waitedSec: 60,
    });
  });

  it('released: heldSec from takenAt, capped at the expiry when lapsed, null for an older bot’s lock', () => {
    const { clock, rows, log } = board();
    clock.at(T0 + 20 * MIN);
    log.released(held('mine', T0), 'dev', 'release');
    clock.at(T0 + 90 * MIN);
    log.released(held('mine', T0), 'devb', 'release');
    const old: Holder = { ...held('mine', T0) };
    delete old.takenAt;
    log.released(old, 'dev', 'release');
    log.released(null, 'dev', 'release'); // no holder known: nothing
    expect(rows().map((r) => [r.slot, r.heldSec, r.lapsed ?? false, r.takenAt])).toEqual([
      ['dev', 1200, false, '2026-11-18T19:00:00.000Z'],
      ['devb', 2700, true, '2026-11-18T19:00:00.000Z'],
      ['dev', null, true, null],
    ]);
  });

  it("deploy-dev's onLock(null) releases the holder it last saw, once", () => {
    const { clock, rows, log } = board();
    log.changed(held('mine', T0), 'dev');
    clock.at(T0 + 8 * MIN);
    log.changed(null, 'dev');
    log.changed(null, 'dev');
    log.changed(null, 'devb'); // never held here
    expect(rows().map((r) => [r.action, r.heldSec ?? null, r.by ?? null])).toEqual([
      ['acquired', null, null],
      ['released', 480, 'deploy-dev'],
    ]);
  });

  it('never throws, never creates a board, and skips torn or foreign lines', () => {
    const gone = join(tmpdir(), `no-board-${process.pid}`);
    for (const d of [null, gone]) {
      const log = lockLog(d, () => T0);
      expect(() => {
        log.refused('mine', new LockHeld(other), []);
        log.changed(held('mine', T0), 'dev');
        log.released(held('mine', T0), 'dev', 'release');
      }).not.toThrow();
    }
    expect(existsSync(gone)).toBe(false);
    const { dir, rows, log } = board();
    mkdirSync(join(dir, 'history'));
    writeFileSync(
      join(dir, 'history', 'events-2026-11-18.jsonl'),
      [
        '{"v":1,"t":"2026-11-18T18:00:00Z","kind":"job","name":"x","branch":"mine"}',
        '{"v":1,"t":"2026-11-18T18:59:00Z","kind":"devlock","action":"wait-st',
        '{"v":1,"t":"2026-11-18T18:59:00Z","kind":"lease","lease":"dev","action":"devlock"}',
      ].join('\n') + '\n',
    );
    log.changed(held('mine', T0), 'dev');
    expect(rows().at(-1)).toMatchObject({ action: 'acquired', waitSec: 0 });
    // unwritable whoever runs it (root ignores modes): history is a file, so neither mkdir nor append can work
    const blocked = mkdtempSync(join(tmpdir(), 'lock-events-'));
    writeFileSync(join(blocked, 'history'), 'not a dir');
    const stuck = lockLog(blocked, () => T0);
    expect(() => {
      stuck.refused('mine', new LockHeld(other), []);
      stuck.changed(held('mine', T0), 'dev');
    }).not.toThrow();
    expect(readFileSync(join(blocked, 'history'), 'utf8')).toBe('not a dir');
  });

  it('lock status: the last take per slot, waited or not', () => {
    const { dir, clock, log } = board();
    log.refused('mine', new LockHeld(other, 'dev'), []);
    clock.at(T0 + 14 * MIN);
    log.changed(held('mine', T0 + 14 * MIN), 'dev');
    log.changed(held('other', T0 + 14 * MIN), 'devb');
    const takes = lastTakes(readLockEvents(dir, clock.now()));
    const hm = (ms: number) =>
      new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(takeLine(takes.dev, 'dev', clock.now())).toBe(
      `  last take of dev: mine at ${hm(T0 + 14 * MIN)} — waited 14 min`,
    );
    expect(takeLine(takes.devb, 'devb', clock.now())).toMatch(/— no wait$/);
    expect(takeLine(undefined, 'dev', clock.now())).toBeNull();
    // under a minute says seconds, never "0 min"; a take from another local day carries its date
    const short = { ...takes.dev!, waitSec: 20 };
    expect(takeLine(short, 'dev', clock.now())).toMatch(/— waited 20 s$/);
    const later = T0 + 2 * 86400_000;
    expect(takeLine(takes.dev, 'dev', later)).toMatch(
      new RegExp(
        `at ${new Date(T0 + 14 * MIN).toLocaleDateString('en-CA')} ${hm(T0 + 14 * MIN)} —`,
      ),
    );
    // only the last two UTC days are read: an older take shows no line, as the doc says
    expect(lastTakes(readLockEvents(dir, T0 + 3 * 86400_000)).dev).toBeUndefined();
    expect(openWait(readLockEvents(dir, clock.now()), 'mine', clock.now())).toBeNull();
  });
});
