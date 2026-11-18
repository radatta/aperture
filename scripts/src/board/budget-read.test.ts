// The budget's board-dir reads and its append, on a temp board and a fake /proc (budget-read.ts).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { macStats } from '../lane/fakes.ts';
import {
  alive,
  boardLanes,
  budgetNow,
  liveSessions,
  liveSlots,
  logJobBudget,
  readLastSample,
  readTail,
} from './budget-read.ts';

const shipped = JSON.parse(
  readFileSync(new URL('../../board/limits.json', import.meta.url), 'utf8'),
);
const NOW = Date.parse('2026-11-18T12:00:00Z');
let board: string;
let proc: string;

const put = (p: string, text: string) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
// /proc/<pid>/stat with a state and a start tick (field 22), the shape parseStat reads
const ps = (pid: number, start = '777', state = 'S') =>
  put(
    join(proc, String(pid), 'stat'),
    `${pid} (claude) ${[state, ...Array.from({ length: 18 }, (_, i) => String(i + 1)), start, '0', '5'].join(' ')}\n`,
  );
const session = (pid: number, branch: string, o: object = {}) =>
  put(
    join(board, 'sessions', `${pid}.json`),
    JSON.stringify({
      v: 1,
      pid,
      pidStart: '777',
      name: branch || 'dispatch',
      branch,
      state: 'idle',
      ...o,
    }),
  );
const slot = (name: string, o: object) =>
  put(
    join(board, 'leases/heavy', `${name}.json`),
    JSON.stringify({ v: 1, label: 'x', startedAt: 'x', ...o }),
  );
const lane = (branch: string, phase: string) =>
  put(join(board, 'lanes', `${branch}.json`), JSON.stringify({ v: 1, branch, phase }));
const sampleLine = (t: number, sessions: object[]) =>
  JSON.stringify({
    t: new Date(t).toISOString(),
    sessions,
    cg: { psiCpuSome10: 33, cpuCores: 6.1, anonMiB: 9000 },
  });

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'budget-read-'));
  board = join(root, 'board');
  proc = join(root, 'proc');
  mkdirSync(join(board, 'history'), { recursive: true });
});

describe('reads', () => {
  it('readTail returns the last bytes, and "" for a missing file', () => {
    put(join(board, 'f'), 'a'.repeat(100) + 'END');
    expect(readTail(join(board, 'f'), 3)).toBe('END');
    expect(readTail(join(board, 'nope'))).toBe('');
  });

  it('readLastSample: today’s last whole line, else yesterday’s (just after UTC midnight)', () => {
    put(join(board, 'history/samples-2026-11-17.jsonl'), sampleLine(NOW - 86400_000, []) + '\n');
    expect(readLastSample(board, NOW)?.t).toBe('2026-11-17T12:00:00.000Z');
    put(
      join(board, 'history/samples-2026-11-18.jsonl'),
      sampleLine(NOW - 60_000, []) + '\n' + sampleLine(NOW - 30_000, []) + '\n{"t":"torn',
    );
    expect(readLastSample(board, NOW)?.t).toBe('2026-11-18T11:59:30.000Z');
  });

  it('alive: the same process only — zombie, reused, missing and an empty start are not', () => {
    ps(1);
    ps(2, '999');
    ps(3, '777', 'Z');
    expect(alive(proc, 1, '777')).toBe(true);
    expect(alive(proc, 1, undefined)).toBe(true); // no start to check
    expect(alive(proc, 1, '')).toBe(false); // as lane/state.ts: '' never matches
    expect(alive(proc, 2, '777')).toBe(false);
    expect(alive(proc, 3, '777')).toBe(false);
    expect(alive(proc, 4, '777')).toBe(false);
    expect(alive(proc, 'x', '777')).toBe(false);
  });

  it('liveSlots keeps a live wrapper’s slot with its cmd, never a dead one', () => {
    ps(10);
    slot('a', { pid: 1, class: 'ui', wrapperPid: 10, wrapperStart: '777', cmd: 'pnpm devcheck' });
    slot('b', { pid: 2, class: 'test', wrapperPid: 11, wrapperStart: '777' });
    expect(liveSlots(board, proc)).toEqual([{ pid: 1, class: 'ui', cmd: 'pnpm devcheck' }]);
  });

  it('liveSessions counts the hub (no branch) and skips gone and dead ones; boardLanes needs a session or a record', () => {
    for (const p of [1, 2, 3, 4]) ps(p);
    session(1, 'a');
    session(2, ''); // the hub
    session(3, 'gone-one', { state: 'gone' });
    session(5, 'dead'); // no /proc entry
    session(4, 'p');
    expect(liveSessions(board, proc)).toEqual(
      expect.arrayContaining([
        { pid: 1, branch: 'a' },
        { pid: 2, branch: null },
        { pid: 4, branch: 'p' },
      ]),
    );
    expect(liveSessions(board, proc)).toHaveLength(3);
    lane('a', 'gate'); // a live session
    lane('p', 'parked'); // parked: never
    lane('rec', 'review'); // a lifecycle record only
    put(join(board, 'lifecycle/rec.json'), '{}');
    lane('stale', 'build'); // neither
    put(join(board, 'lanes/torn.json'), '{"branch":');
    expect(
      boardLanes(board, new Set(['a', 'p'])).sort((x, y) => x.branch.localeCompare(y.branch)),
    ).toEqual([
      { branch: 'a', phase: 'gate' },
      { branch: 'rec', phase: 'review' },
    ]);
  });
});

describe('budgetNow', () => {
  it('sums what is live now, with k from mac-stats, into the status line', () => {
    ps(1);
    ps(10);
    session(1, 'a', { state: 'working' });
    lane('a', 'gate');
    slot('s', { pid: 1, class: 'test', wrapperPid: 10, wrapperStart: '777' });
    put(
      join(board, 'history/samples-2026-11-18.jsonl'),
      sampleLine(NOW - 10_000, [{ pid: 7, state: 'working' }]) + '\n',
    );
    put(join(board, 'mac-stats.json'), macStats(NOW, { source: 'battery', state: 'discharging' }));
    const b = budgetNow(board, shipped, proc, NOW)!;
    expect(b).toMatchObject({
      jobs: 3.8,
      lanes: 1.5,
      sessions: 1,
      k: 1.3,
      kWhy: 'battery',
      laneList: [{ branch: 'a', phase: 'gate' }],
    });
    expect(b.line).toBe(
      'budget (log-only): jobs 3.8/5 · lanes 1.5/3.46 · sessions 1/14 · k 1.3 battery',
    );
    expect(budgetNow(board, { ...shipped, budget: undefined }, proc, NOW)).toBeNull();
  });
});

describe('logJobBudget', () => {
  it('names the session from the registry and counts light lanes from a fresh sample', () => {
    session(42, 'lane-x');
    put(
      join(board, 'history/samples-2026-11-18.jsonl'),
      sampleLine(NOW - 5_000, [
        { pid: 42, state: 'working' }, // the requester: not light
        { pid: 7, state: 'working' },
        { pid: 8, state: 'idle' },
      ]) + '\n',
    );
    put(join(board, 'mac-stats.json'), macStats(NOW));
    logJobBudget(
      {
        limits: shipped,
        slots: [],
        req: { class: 'typecheck' },
        budget: { board, owner: 42, label: 'typecheck', cmd: 'pnpm typecheck' },
      },
      { verdict: 'grant', wait: false },
      NOW,
    );
    const [e] = readFileSync(join(board, 'history/events-2026-11-18.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(e).toMatchObject({
      t: '2026-11-18T12:00:00Z',
      kind: 'budget',
      scope: 'job',
      pid: 42,
      name: 'lane-x',
      branch: 'lane-x',
      committed: { light: 0.3, lightWorking: 1, lightKnown: true, sampleAgeSec: 5 },
      cg: { psiCpuSome10: 33, cpuCores: 6.1, anonMiB: 9000 },
      k: 1,
      kWhy: 'ac',
      would: 'admit',
      actual: { verdict: 'grant', wait: false },
    });
  });

  it('writes nothing without a budget block or a board', () => {
    logJobBudget(
      { limits: {}, req: { class: 'lint' }, budget: { board } },
      { verdict: 'grant', wait: false },
      NOW,
    );
    logJobBudget(
      { limits: shipped, req: { class: 'lint' }, budget: {} },
      { verdict: 'grant', wait: false },
      NOW,
    );
    expect(() => readFileSync(join(board, 'history/events-2026-11-18.jsonl'))).toThrow();
  });
});
