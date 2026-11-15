import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDS } from '../../identifiers.ts';
import { firedAt, parseQueue, planAt, queueAgeTone, sinceTime, staleFollowups } from './queue.ts';

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
      'on-dev',
      'next',
      'waiting',
      'building',
      'ready',
      'needs-you',
    ]);
    expect(q.data!.devQueue[0]!.eta).toBe(Date.parse('2026-11-08T06:37:00Z'));
    expect(q.data!.devQueue.map((l) => l.slot)).toEqual([
      'dev',
      'devb',
      'dev',
      'dev',
      'dev',
      'dev',
      'dev',
    ]);
    expect(q.data!.devQueue[3]!.waitingOn).toBe('you: merge PR 41');
    expect(q.data!.maintainer).toHaveLength(2);
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
    expect(q.data!.plan.map((p) => p.kind)).toEqual(['maintainer', 'merge', 'dev', 'ci']);
  });

  it('sorts the plan by time, the unscheduled last in file order', () => {
    const q = parseQueue(
      JSON.stringify({
        v: 1,
        updatedAt: '2026-11-08T06:00:00Z',
        plan: [
          { what: 'ci later', kind: 'ci' },
          { at: '2026-11-08T07:00:00Z', what: 'second', kind: 'dev', who: 'auto-1' },
          { what: 'maintainer later', kind: 'maintainer' },
          { at: '2026-11-08T06:30:00Z', what: 'first', kind: 'merge' },
          { at: '2026-11-08T07:00:00-00:00', what: 'tied, later in file', kind: 'ci' },
        ],
      }),
    );
    expect(q.status).toBe('ok');
    expect(q.data!.plan).toEqual([
      { at: Date.parse('2026-11-08T06:30:00Z'), what: 'first', kind: 'merge', who: null },
      { at: Date.parse('2026-11-08T07:00:00Z'), what: 'second', kind: 'dev', who: 'auto-1' },
      {
        at: Date.parse('2026-11-08T07:00:00Z'),
        what: 'tied, later in file',
        kind: 'ci',
        who: null,
      },
      { at: null, what: 'ci later', kind: 'ci', who: null },
      { at: null, what: 'maintainer later', kind: 'maintainer', who: null },
    ]);
  });

  it('needs only v and updatedAt', () => {
    const q = parseQueue('{"v":1,"updatedAt":"2026-11-08T06:00:00Z","extra":true}');
    expect(q).toMatchObject({
      status: 'ok',
      data: {
        devQueue: [],
        maintainer: [],
        wave: null,
        deadRows: null,
        plan: [],
        followups: [],
        mergeOrder: [],
      },
    });
  });

  it('says so when the to-dos sit under the old per-person key; other extra lists pass', () => {
    const old = IDS.maintainer.name.split(' ')[0]!.toLowerCase();
    const q = parseQueue(
      JSON.stringify({
        v: 1,
        updatedAt: '2026-11-08T06:00:00Z',
        [old]: ['merge PR 41'],
        mergeOrder: ['a'],
        notes: ['an unknown list'],
      }),
    );
    expect(q.data!.maintainer).toEqual([]);
    expect(q.data!.mergeOrder).toEqual([{ branch: 'a', pr: null, note: null }]); // a bare branch name
    expect(q.problems).toEqual([
      'the to-dos sit under an old key — rename it to "maintainer" (docs/ops/TOWER.md)',
    ]);
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
          { branch: 'e', state: 'on-dev', slot: 'devb' },
          { branch: 'f', state: 'on-dev', slot: 'devc' },
        ],
        plan: [
          { what: 'ok', kind: 'dev' },
          { what: 'x', kind: 'deploy' },
          { kind: 'merge' },
          { at: 'soon', what: 'kept, unscheduled', kind: 'ci' },
          { at: '22:40', what: 'a bare time', kind: 'merge' },
          { at: '2026-11-08', what: 'a bare date', kind: 'merge' },
        ],
        maintainer: ['plain text works', { since: '2026-11-08' }],
        wave: { items: [{ branch: 'c', state: 'done' }] },
      }),
    );
    expect(q.status).toBe('bad');
    expect(q.data!.devQueue.map((l) => [l.branch, l.slot])).toEqual([
      ['a', 'dev'], // no slot: slot A
      ['e', 'devb'],
    ]);
    expect(q.data!.maintainer).toEqual([{ text: 'plain text works', since: null }]);
    expect(q.data!.wave).toEqual({ name: 'Wave', items: [] });
    expect(q.data!.plan.map((p) => [p.what, p.at])).toEqual([
      ['ok', null],
      ['kept, unscheduled', null],
      ['a bare time', null],
      ['a bare date', null],
    ]);
    expect(q.problems).toEqual([
      'devQueue[1]: state "sleeping"',
      'devQueue[2]: no branch',
      'devQueue[3]: state "pr-check"',
      'devQueue[5]: slot "devc"',
      'maintainer[1]: no text',
      'wave.items[0]: state "done"',
      'plan[1]: kind "deploy"',
      'plan[2]: no what',
      'plan[3]: at is not an ISO time',
      'plan[4]: at is not an ISO time',
      'plan[5]: at is not an ISO time',
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

  it('takes a plan time only as a whole, real ISO date-time', () => {
    for (const ok of [
      '2026-11-08T22:40Z',
      '2026-11-08T22:40:00-08:00',
      '2026-11-08T22:40:00+0530',
      '2026-11-08T22:40:00',
      '2028-02-29T10:00Z',
    ])
      expect(planAt(ok)).toBe(Date.parse(ok));
    for (const bad of [
      '22:40',
      '2026-11-08',
      '2026-11-08T22:40:00 PST',
      '2026-11-08T22:40:00+01',
      '2026-11-08T22:40:00.500Z',
      '2026-11-08T22:40:00Z tomorrow',
      '2026-11-08T24:00',
      '2026-11-31T10:00',
      '2026-02-30T10:00Z',
      '2026-13-01T10:00Z',
      42,
    ])
      expect(planAt(bad)).toBeNull();
  });

  it('is missing when there is no file', () => {
    expect(parseQueue(null)).toEqual({ status: 'missing', data: null, problems: [] });
  });

  it('turns amber past 30 min and red past 2 h', () => {
    expect([60, 1801, 7201].map(queueAgeTone)).toEqual(['dim', 'warn', 'bad']);
  });
});

describe('hold and followups (the web tower)', () => {
  const q = (extra: object) =>
    parseQueue(JSON.stringify({ v: 1, updatedAt: '2026-11-13T20:00:00Z', ...extra }));
  it("reads a lane's hold reason", () => {
    const r = q({
      devQueue: [
        { branch: 'a', state: 'ready', hold: 'after the Safari pass' },
        { branch: 'b', state: 'ready' },
      ],
    });
    expect(r.data!.devQueue.map((l) => l.hold)).toEqual(['after the Safari pass', null]);
  });
  it("reads followups with pq-check's rules and says what is wrong", () => {
    const f = (o: object) => ({
      id: 'F1',
      what: 'w',
      owner: 'lane',
      after: 'now',
      status: 'open',
      source: 's',
      since: '2026-11-10',
      ...o,
    });
    const r = q({
      followups: [
        f({}),
        f({ id: 'F2', status: 'maybe' }),
        f({ id: 'F3', owner: 'bob' }),
        f({}),
        f({ id: 'F5', since: 'soon' }),
        { id: 'F6' },
      ],
    });
    expect(r.data!.followups.map((x) => x.id)).toEqual(['F1', 'F1', 'F5']);
    expect(r.problems).toEqual([
      'followups[1]: status "maybe"',
      'followups[2]: owner "bob"',
      'followups[3]: duplicate id F1',
      'followups[4]: since is not a date',
      'followups[5]: no id, what or after',
    ]);
    expect(r.status).toBe('bad');
  });
  it('STALE: open, due now, older than 24 h; one definition for the tower and pq-check', () => {
    const now = Date.parse('2026-11-13T20:00:00Z');
    const base = { what: 'w', owner: 'lane', source: null };
    const fu = [
      { ...base, id: 'old', after: 'now', status: 'open', since: now - 24 * 3600e3 - 1 },
      { ...base, id: 'young', after: 'now', status: 'open', since: now - 24 * 3600e3 + 1 },
      { ...base, id: 'later', after: 'wave 4', status: 'open', since: 0 },
      { ...base, id: 'tracked', after: 'now', status: 'tracked', since: 0 },
      { ...base, id: 'undated', after: 'now', status: 'open', since: null },
    ];
    expect(staleFollowups(fu, now).map((f) => f.id)).toEqual(['old']);
  });
});

describe('unread devQueue lanes (round 4)', () => {
  const base = { v: 1, updatedAt: '2026-11-08T05:00:00Z' };
  it('a lane with an unknown state or slot is named in unread; one with no branch makes it all', () => {
    const q = parseQueue(
      JSON.stringify({
        ...base,
        devQueue: [
          { branch: 'a', state: 'building' },
          { branch: 'b', state: 'brand-new' },
          { branch: 'c', state: 'next', slot: 'devz' },
        ],
      }),
    );
    expect(q.unread).toEqual(['b', 'c']);
    expect(q.data!.devQueue.map((l) => l.branch)).toEqual(['a']);
    expect(parseQueue(JSON.stringify({ ...base, devQueue: [{ state: 'next' }] })).unread).toBe(
      'all',
    );
    expect(parseQueue(JSON.stringify({ ...base, devQueue: {} })).unread).toBe('all');
  });
  it('an unreadable file is all unread, its last good data kept; a clean file has no unread', () => {
    expect(parseQueue('{nope').unread).toBe('all');
    expect(parseQueue(JSON.stringify({ ...base, devQueue: [] })).unread).toBeUndefined();
  });
});

describe('mergeOrder, bare dates and fired triggers (2026-11-14)', () => {
  const q = (extra: object) =>
    parseQueue(JSON.stringify({ v: 1, updatedAt: '2026-11-14T08:00:00Z', ...extra }));
  it('mergeOrder keeps file order; pr and note are optional', () => {
    const r = q({ mergeOrder: [{ branch: 'b', pr: 7, note: 'first' }, { branch: 'a' }] });
    expect(r).toMatchObject({ status: 'ok', problems: [] });
    expect(r.data!.mergeOrder).toEqual([
      { branch: 'b', pr: 7, note: 'first' },
      { branch: 'a', pr: null, note: null },
    ]);
  });
  it('a bad mergeOrder is a problem, never a throw; a duplicate keeps the first', () => {
    expect(q({ mergeOrder: 'x' })).toMatchObject({ problems: ['mergeOrder is not an array'] });
    expect(q({ mergeOrder: 'x' }).data!.mergeOrder).toEqual([]);
    const r = q({ mergeOrder: [{ pr: 3 }, null, { branch: 'a', pr: 1 }, { branch: 'a', pr: 2 }] });
    expect(r.problems).toEqual([
      'mergeOrder[0]: no branch',
      'mergeOrder[1]: no branch',
      'mergeOrder[3]: duplicate branch a',
    ]);
    expect(r.data!.mergeOrder).toEqual([{ branch: 'a', pr: 1, note: null }]);
    expect(r.unread).toBeUndefined(); // never touches the holds
  });
  it('a bare-date since is the end of that local day; an ISO time is itself', () => {
    expect(sinceTime('2026-11-13')).toEqual({
      at: new Date(2026, 10, 14).getTime() - 1,
      day: '11-13',
    });
    expect(sinceTime('2026-11-13T05:00:00Z')).toEqual({
      at: Date.parse('2026-11-13T05:00:00Z'),
      day: null,
    });
    expect(sinceTime(null)).toEqual({ at: null, day: null });
    for (const bad of ['2026-13-01', '2026-11-99', '2026-02-31'])
      expect(sinceTime(bad)).toEqual({ at: null, day: null }); // a problem, never a rolled-over date
    const f = q({
      followups: [
        { id: 'F1', what: 'w', owner: 'lane', after: 'now', status: 'open', since: '2026-11-13' },
      ],
    });
    expect(f.data!.followups[0]).toMatchObject({
      since: new Date(2026, 10, 14).getTime() - 1,
      sinceDay: '11-13',
    });
  });
  it('a trigger fires on a merged branch or PR (plus an offset), or once its date begins; free text never', () => {
    const now = new Date(2026, 10, 14, 1, 0).getTime();
    const merged = [{ branch: 'tower-web', number: 160, mergedAt: now - 86400e3 }];
    expect(firedAt('tower-web', merged, now)).toBe(now - 86400e3);
    expect(firedAt('tower-web merge', merged, now)).toBe(now - 86400e3);
    expect(firedAt('tower-web merges (with F51)', merged, now)).toBe(now - 86400e3);
    expect(firedAt('tower-web merge + 1 week', merged, now)).toBe(now + 6 * 86400e3);
    expect(firedAt('PR 160', merged, now)).toBe(now - 86400e3);
    expect(firedAt('lc-polish merge', merged, now)).toBeNull(); // not merged
    expect(firedAt('2026-11-20', merged, now)).toBe(new Date(2026, 10, 20).getTime());
    expect(firedAt('2026-11-14 ~19:30 PT (board-limits)', merged, now)).toBe(
      new Date(2026, 10, 14, 19, 30).getTime(),
    );
    expect(firedAt('2026-11-14 (after a trial)', merged, now)).toBe(
      new Date(2026, 10, 14).getTime(),
    );
    expect(firedAt('Sat 11-14 (flip day)', merged, now)).toBe(new Date(2026, 10, 14).getTime());
    expect(firedAt('11-01', merged, now)).toBe(new Date(2026, 10, 1).getTime()); // two weeks back: this year
    // written in December for early January: next year's, not eleven months ago
    expect(firedAt('01-05 (new year)', merged, new Date(2026, 11, 20).getTime())).toBe(
      new Date(2027, 0, 5).getTime(),
    );
    // written in early January for late December: last year's (fired), not eleven months away
    expect(firedAt('Mon 12-29 (year end)', merged, new Date(2027, 0, 3).getTime())).toBe(
      new Date(2026, 11, 29).getTime(),
    );
    expect(firedAt('2026-11-14T09:00:00Z', merged, now)).toBe(Date.parse('2026-11-14T09:00:00Z'));
    for (const a of [
      'wave 4',
      'repo goes public',
      'lane deploy-log-mask (before the flip)',
      'next CI lane',
      '1-2 days after tower merge',
      '2-3 merges',
      '13-40',
      '2026-02-31',
      '2026-11-14 ~25:00',
    ])
      expect(firedAt(a, merged, now)).toBeNull();
  });
});
