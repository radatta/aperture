import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseQueue, queueAgeTone } from './queue.ts';

const example = readFileSync(
  join(import.meta.dirname, '../../../board/queue.example.json'),
  'utf8',
);

describe('parseQueue', () => {
  it('reads the seed example', () => {
    const q = parseQueue(example);
    expect(q.status).toBe('ok');
    expect(q.problems).toEqual([]);
    expect(q.data!.devQueue.map((l) => l.state)).toEqual([
      'on-dev',
      'next',
      'waiting',
      'building',
      'ready',
      'needs-you',
    ]);
    expect(q.data!.devQueue[0]!.eta).toBe(Date.parse('2026-11-08T06:37:00Z'));
    expect(q.data!.devQueue[2]!.waitingOn).toBe('Rahul: merge PR 41');
    expect(q.data!.rahul).toHaveLength(2);
    expect(q.data!.wave!.items.map((i) => i.state)).toEqual([
      'merged',
      'in-flight',
      'open',
      'in-flight',
      'not-started',
    ]);
    expect(q.data!.deadRows).toEqual({
      since: Date.parse('2026-11-08T00:00:00Z'),
      target: 12,
      excludedRuns: [],
    });
    expect(q.data!.plan.map((p) => p.kind)).toEqual(['rahul', 'merge', 'dev', 'ci']);
  });

  it('sorts the plan by time, the unscheduled last in file order', () => {
    const q = parseQueue(
      JSON.stringify({
        v: 1,
        updatedAt: '2026-11-08T06:00:00Z',
        plan: [
          { what: 'ci later', kind: 'ci' },
          { at: '2026-11-08T07:00:00Z', what: 'second', kind: 'dev', who: 'auto-1' },
          { what: 'rahul later', kind: 'rahul' },
          { at: '2026-11-08T06:30:00Z', what: 'first', kind: 'merge' },
        ],
      }),
    );
    expect(q.status).toBe('ok');
    expect(q.data!.plan).toEqual([
      { at: Date.parse('2026-11-08T06:30:00Z'), what: 'first', kind: 'merge', who: null },
      { at: Date.parse('2026-11-08T07:00:00Z'), what: 'second', kind: 'dev', who: 'auto-1' },
      { at: null, what: 'ci later', kind: 'ci', who: null },
      { at: null, what: 'rahul later', kind: 'rahul', who: null },
    ]);
  });

  it('needs only v and updatedAt', () => {
    const q = parseQueue('{"v":1,"updatedAt":"2026-11-08T06:00:00Z","extra":true}');
    expect(q).toMatchObject({
      status: 'ok',
      data: { devQueue: [], rahul: [], wave: null, deadRows: null, plan: [] },
    });
  });

  it('says what is wrong and keeps the last good parse', () => {
    const good = parseQueue(example).data;
    for (const [text, problem] of [
      ['{"v":1,', /not JSON/],
      ['[]', /not an object/],
      ['{"v":2,"updatedAt":"2026-11-08T06:00:00Z"}', /v is 2/],
      ['{"v":1,"updatedAt":"soon"}', /updatedAt/],
    ] as const) {
      const q = parseQueue(text, good);
      expect(q.status).toBe('bad');
      expect(q.problems[0]).toMatch(problem);
      expect(q.data).toBe(good);
    }
  });

  it('drops a bad entry, keeps the rest, and names it', () => {
    const q = parseQueue(
      JSON.stringify({
        v: 1,
        updatedAt: '2026-11-08T06:00:00Z',
        devQueue: [
          { branch: 'a', state: 'on-dev' },
          { branch: 'b', state: 'sleeping' },
          { state: 'next' },
          { branch: 'd', state: 'pr-check' },
        ],
        plan: [
          { what: 'ok', kind: 'dev' },
          { what: 'x', kind: 'deploy' },
          { kind: 'merge' },
          { at: 'soon', what: 'kept, unscheduled', kind: 'ci' },
        ],
        rahul: ['plain text works', { since: '2026-11-08' }],
        wave: { items: [{ branch: 'c', state: 'done' }] },
      }),
    );
    expect(q.status).toBe('bad');
    expect(q.data!.devQueue.map((l) => l.branch)).toEqual(['a']);
    expect(q.data!.rahul).toEqual([{ text: 'plain text works', since: null }]);
    expect(q.data!.wave).toEqual({ name: 'Wave', items: [] });
    expect(q.data!.plan.map((p) => [p.what, p.at])).toEqual([
      ['ok', null],
      ['kept, unscheduled', null],
    ]);
    expect(q.problems).toEqual([
      'devQueue[1]: state "sleeping"',
      'devQueue[2]: no branch',
      'devQueue[3]: state "pr-check"',
      'rahul[1]: no text',
      'wave.items[0]: state "done"',
      'plan[1]: kind "deploy"',
      'plan[2]: no what',
      'plan[3]: at is not an ISO time',
    ]);
  });

  it('cleans what it quotes from a bad file', () => {
    const q = parseQueue('{"v":1,\x1b[31m\n}');
    expect(q.problems[0]).toMatch(/^not JSON/);
    expect([...q.problems[0]!].some((ch) => ch.charCodeAt(0) < 0x20)).toBe(false);
    expect(
      parseQueue(
        '{"v":1,"updatedAt":"2026-11-08T06:00:00Z","devQueue":[{"branch":"a","state":"🚀"}]}',
      ).problems,
    ).toEqual(['devQueue[0]: state "?"']);
  });

  it('is missing when there is no file', () => {
    expect(parseQueue(null)).toEqual({ status: 'missing', data: null, problems: [] });
  });

  it('turns amber past 30 min and red past 2 h', () => {
    expect([60, 1801, 7201].map(queueAgeTone)).toEqual(['dim', 'warn', 'bad']);
  });
});
