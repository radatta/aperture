import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseQueue } from './queue.ts';
import { queuedLine, queuedView } from './queued.ts';

const q = (raw: Record<string, unknown>) =>
  parseQueue(JSON.stringify({ v: 1, updatedAt: '2026-11-18T12:00:00-08:00', devQueue: [], ...raw }))
    .data;
const entry = (branch: string, o: Record<string, unknown> = {}) => ({ branch, after: [], ...o });

describe('parseQueue: autoStart in full (autoQueue)', () => {
  it('keeps every field, a bad one as null; autoStart stays branch names', () => {
    const d = q({
      autoStart: [
        entry('a-lane', {
          order: 1,
          class: 'p0',
          note: 'n',
          approvedAt: '2026-11-18T12:00:00-08:00',
        }),
        entry('b-lane', { order: 'x', class: 'p9', after: ['a-lane', 7, ''] }),
        { order: 2 },
        entry('Bad Name'),
      ],
    })!;
    expect(d.autoStart).toEqual(['a-lane', 'b-lane']);
    expect(d.autoQueue).toEqual([
      {
        branch: 'a-lane',
        order: 1,
        cls: 'p0',
        after: [],
        note: 'n',
        approvedAt: Date.parse('2026-11-18T20:00:00Z'),
      },
      { branch: 'b-lane', order: null, cls: null, after: ['a-lane'], note: null, approvedAt: null },
    ]);
  });
  it('no autoStart key, an empty array or a non-array: none, and never a problem row', () => {
    for (const raw of [{}, { autoStart: [] }, { autoStart: 'x' }]) {
      const r = parseQueue(
        JSON.stringify({ v: 1, updatedAt: '2026-11-18T12:00:00-08:00', devQueue: [], ...raw }),
      );
      expect(r.data!.autoQueue).toEqual([]);
      expect(r.problems).toEqual([]);
    }
  });
});

describe('queuedView', () => {
  it('sorts by order, then p0 before p1, then file order; no order goes last', () => {
    const d = q({
      autoStart: [
        entry('e-lane'),
        entry('c-lane', { order: 3, class: 'p1' }),
        entry('d-lane', { order: 3, class: 'p0' }),
        entry('b-lane', { order: 1, class: 'p1' }),
        entry('f-lane', { order: 3, class: 'p1' }),
      ],
    });
    expect(queuedView(d, new Set()).map((x) => x.branch)).toEqual([
      'b-lane',
      'd-lane',
      'c-lane',
      'f-lane',
      'e-lane',
    ]);
  });
  it('ready, after a still-queued lane, or held by a LOW / HOLD note', () => {
    const d = q({
      devQueue: [{ branch: 'in-dev', state: 'building' }],
      autoStart: [
        entry('a', { order: 1, after: ['in-dev'] }),
        entry('b', { order: 2, after: ['a', 'gone-lane'] }),
        entry('c', { order: 3, after: ['gone-lane'] }),
        entry('d', { order: 4, note: 'LOW: when the box is calm' }),
        entry('e', { order: 5, note: 'HOLD until the design call', after: ['a'] }),
        entry('f', { order: 6, note: 'not HOLD at the start' }),
      ],
    });
    expect(queuedView(d, new Set()).map((x) => [x.branch, x.state, x.waitsOn])).toEqual([
      ['a', 'after', ['in-dev']],
      ['b', 'after', ['a']],
      ['c', 'ready', []],
      ['d', 'held', []],
      ['e', 'held', ['a']],
      ['f', 'ready', []],
    ]);
  });
  it('a started lane drops out (it shows in NOW), but its leftover autoStart entry still holds the lanes after it', () => {
    const d = q({ autoStart: [entry('a', { order: 1 }), entry('b', { order: 2, after: ['a'] })] });
    // a is still in autoStart, so b waits on it: the stale item tells dispatch to drop it
    expect(queuedView(d, new Set(['a'])).map((x) => [x.branch, x.state])).toEqual([['b', 'after']]);
    expect(queuedView(null, new Set())).toEqual([]);
  });
  it('queuedLine', () => {
    const rows = queuedView(
      q({
        devQueue: [{ branch: 'x-lane', state: 'building' }],
        autoStart: [
          entry('a', { order: 1, class: 'p0', after: ['x-lane'] }),
          entry('b', { note: 'HOLD: design' }),
          entry('c', { order: 2 }),
        ],
      }),
      new Set(),
    );
    expect(rows.map(queuedLine)).toEqual([
      '1 a p0 · after x-lane',
      '2 c · ready',
      '- b · HOLD: design',
    ]);
  });
  // On a well-formed queue. A malformed entry (a bad state, a branch that fails LANE_RE) is dropped by the parser but
  // still counted by the jq. The tower drops it silently by design (queue.test: never a problem row); pq-check, run
  // after every queue.json write, is what names it. So the two may disagree only on a queue pq-check already refused.
  it("matches pace-watch.sh's exit-6 ready rule on the same queue", () => {
    const raw = {
      v: 1,
      updatedAt: '2026-11-18T12:00:00-08:00',
      devQueue: [{ branch: 'in-dev', state: 'building' }],
      autoStart: [
        entry('a', { after: ['in-dev'] }),
        entry('b', { after: ['a'] }),
        entry('c', { after: ['gone'] }),
        entry('d', { note: 'LOW x' }),
        entry('e', { note: 'HOLD' }),
        entry('f'),
      ],
    };
    const src = readFileSync(join(import.meta.dirname, '../../../board/pace-watch.sh'), 'utf8');
    const prog = /ready=\$\(jq -r '([^']+)'/.exec(src)![1]!;
    const jq = execFileSync('jq', ['-r', prog], { input: JSON.stringify(raw), encoding: 'utf8' })
      .trim()
      .split(',');
    const ours = queuedView(parseQueue(JSON.stringify(raw)).data, new Set())
      .filter((x) => x.state === 'ready')
      .map((x) => x.branch);
    expect(ours).toEqual(jq);
  });
});

describe('the fixture board', () => {
  it('View.queued: the fixture autoStart in start order', async () => {
    const { build, parseArgs } = await import('./web/main.ts');
    const t = build(
      parseArgs([
        '--fixtures',
        join(import.meta.dirname, 'fixtures'),
        '--now',
        '2026-11-08T06:10:00Z',
      ]),
    );
    expect(t.view(false).queued.map((x) => [x.branch, x.state])).toEqual([
      ['november-branch', 'after'],
      ['papa-branch', 'held'],
      ['oscar-branch', 'ready'],
    ]);
  });
});
