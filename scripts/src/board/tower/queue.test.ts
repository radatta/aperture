import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDS } from '../../identifiers.ts';
import {
  firedAt,
  firedFollowups,
  LANE_STATES,
  parseQueue,
  planAt,
  refFiredAt,
  queueAgeTone,
  sinceTime,
  staleFollowups,
} from './queue.ts';

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
    expect(q.data!.plan.map((p) => p.kind)).toEqual(['dev', 'maintainer', 'merge', 'dev', 'ci']);
    // the plan-table fields, one of each
    expect(q.data!.plan[0]).toMatchObject({
      done: true,
      doneAt: Date.parse('2026-11-08T05:48:00Z'),
    });
    expect(q.data!.plan[2]).toMatchObject({
      you: '2 min',
      lane: 'charlie-branch',
      eta: { source: 'measured' },
    });
    expect(q.data!.planNotes).toHaveLength(1);
    expect(q.data!.planAt).toBe(Date.parse('2026-11-08T06:00:00Z'));
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
    expect(q.data!.plan.map(({ at, what, kind, who }) => ({ at, what, kind, who }))).toEqual([
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

  it('reads the plan table fields: you, eta, lane, done, planNotes, planAt', () => {
    const q = parseQueue(
      JSON.stringify({
        v: 1,
        updatedAt: '2026-11-08T06:00:00Z',
        planAt: '2026-11-08T05:55:00Z',
        planNotes: ['bravo slips 15 min', 'golf moved to tomorrow'],
        plan: [
          {
            at: '2026-11-08T06:30:00Z',
            what: 'merge bravo',
            kind: 'merge',
            you: '2 min',
            lane: 'bravo-branch',
            eta: {
              from: '2026-11-08T06:30:00Z',
              to: '2026-11-08T06:45:00Z',
              source: 'measured',
            },
          },
          { at: '2026-11-08T05:00:00Z', what: 'done flag', kind: 'dev', done: true },
          {
            at: '2026-11-08T05:10:00Z',
            what: 'done at',
            kind: 'dev',
            done: '2026-11-08T05:25:00Z',
          },
          { at: '2026-11-08T05:20:00Z', what: 'not done', kind: 'dev', done: false },
        ],
      }),
    );
    expect(q.problems).toEqual([]);
    expect(q.data!.planNotes).toEqual(['bravo slips 15 min', 'golf moved to tomorrow']);
    expect(q.data!.planAt).toBe(Date.parse('2026-11-08T05:55:00Z'));
    const [a, b, c, d] = q.data!.plan;
    expect(a).toMatchObject({ what: 'done flag', done: true, doneAt: null, you: null, eta: null });
    expect(b).toMatchObject({ done: true, doneAt: Date.parse('2026-11-08T05:25:00Z') });
    expect(c).toMatchObject({ done: false, doneAt: null });
    expect(d).toEqual({
      at: Date.parse('2026-11-08T06:30:00Z'),
      what: 'merge bravo',
      kind: 'merge',
      who: null,
      you: '2 min',
      lane: 'bravo-branch',
      eta: {
        from: Date.parse('2026-11-08T06:30:00Z'),
        to: Date.parse('2026-11-08T06:45:00Z'),
        source: 'measured',
      },
      done: false,
      doneAt: null,
    });
  });

  it('names a bad plan-table field and drops it, keeping the row', () => {
    const q = parseQueue(
      JSON.stringify({
        v: 1,
        updatedAt: '2026-11-08T06:00:00Z',
        planAt: 'tonight',
        planNotes: ['ok', 7],
        plan: [
          { what: 'loose eta', kind: 'dev', eta: { from: '06:30', to: '06:45', source: 'guess' } },
          {
            what: 'backwards eta',
            kind: 'dev',
            eta: { from: '2026-11-08T07:00:00Z', to: '2026-11-08T06:00:00Z', source: 'guess' },
          },
          {
            what: 'odd source',
            kind: 'dev',
            eta: { from: '2026-11-08T06:00:00Z', to: '2026-11-08T07:00:00Z', source: 'hunch' },
          },
          { what: 'bad done', kind: 'dev', done: 'yes' },
          { what: 'bad lane', kind: 'dev', lane: 'Not A Branch' },
          { what: 'bad you', kind: 'dev', you: 5 },
        ],
      }),
    );
    expect(q.status).toBe('bad');
    expect(q.problems).toEqual([
      'plan[0]: eta wants from and to as ISO times',
      'plan[1]: eta ends before it starts',
      'plan[2]: eta source "hunch"',
      'plan[3]: done wants true or an ISO time',
      'plan[4]: lane is not a branch name',
      'plan[5]: you is not text',
      'planNotes[1]: not text',
      'planAt is not an ISO time',
    ]);
    expect(q.data!.plan).toHaveLength(6);
    expect(q.data!.plan.every((p) => p.eta === null && p.lane === null && !p.done)).toBe(true);
    expect(q.data!.planNotes).toEqual(['ok']);
    expect(q.data!.planAt).toBeNull();
  });

  it('says so when planNotes is not an array', () => {
    const q = parseQueue('{"v":1,"updatedAt":"2026-11-08T06:00:00Z","planNotes":"one note"}');
    expect(q.problems).toEqual(['planNotes is not an array']);
  });

  it('knows pr-open, between building and ready', () => {
    expect(LANE_STATES.indexOf('pr-open')).toBe(LANE_STATES.indexOf('building') + 1);
    expect(LANE_STATES.indexOf('ready')).toBe(LANE_STATES.indexOf('pr-open') + 1);
    const q = parseQueue(
      '{"v":1,"updatedAt":"2026-11-08T06:00:00Z","devQueue":[{"branch":"x","state":"pr-open","pr":7}]}',
    );
    expect(q.problems).toEqual([]);
    expect(q.data!.devQueue[0]).toMatchObject({ branch: 'x', state: 'pr-open', pr: 7 });
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
        planNotes: [],
        planAt: null,
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
    expect(firedAt('Sat 11-14 (demo day)', merged, now)).toBe(new Date(2026, 10, 14).getTime());
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
      'audit goes green',
      'lane kilo-branch (before the cutover)',
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

describe('tower-current: autoStart and merge references', () => {
  it('reads autoStart branches leniently: a bad entry is skipped, never a problem', () => {
    const q = parseQueue(
      JSON.stringify({
        v: 1,
        updatedAt: '2026-11-17T05:00:00Z',
        autoStart: [{ branch: 'echo', order: 1, class: 'p1' }, { branch: 'Bad Name' }, 7, null],
      }),
    );
    expect(q.problems).toEqual([]);
    expect(q.data!.autoStart).toEqual(['echo']);
  });
  it('refFiredAt reads only the merge half: a date never fires', () => {
    const merged = [{ branch: 'echo', number: 9, mergedAt: 1000 }];
    expect(refFiredAt('echo merges', merged)).toBe(1000);
    expect(refFiredAt('PR 9 + 1 day', merged)).toBe(1000 + 86400e3);
    expect(refFiredAt('2026-11-17', merged)).toBeNull();
    expect(refFiredAt('fox merges', merged)).toBeNull();
    // a reused name: a branch merge counts only when it fires at or after the cut; a PR number always
    expect(refFiredAt('echo merges', merged, 2000)).toBeNull();
    // a waitingOn cuts on when it fires; a follow-up on the merge itself
    expect(refFiredAt('echo merges + 1 day', merged, 2000, 'fire')).toBe(1000 + 86400e3);
    expect(refFiredAt('echo merges + 1 day', merged, 2000)).toBeNull();
    expect(refFiredAt('PR 9', merged, 2000)).toBe(1000);
    // a follow-up written after the namesake's merge doesn't fire from it
    expect(firedAt('echo merges', merged, 5000, 3000)).toBeNull();
    expect(firedAt('echo merges', merged, 5000, 500)).toBe(1000);
  });
  it('a follow-up dated by day alone counts a merge from the evening before', () => {
    const { at: since, day } = sinceTime('2026-11-18'); // that day's end
    const evening = since! - 24 * 3600e3 - 30 * 60e3; // 11-17, 23:30
    const merged = [{ branch: 'echo', number: 9, mergedAt: evening }];
    const f = {
      id: 'F1',
      what: 'w',
      owner: 'lane',
      after: 'echo merges',
      status: 'open',
      source: null,
      since,
      sinceDay: day,
    };
    expect(firedFollowups([f], merged, since!).map((x) => x.firedAt)).toEqual([evening]);
    // a merge days before is a namesake's
    const old = [{ ...merged[0]!, mergedAt: since! - 4 * 86400e3 }];
    expect(firedFollowups([f], old, since!)).toEqual([]);
    // an offset reference cuts on the merge too: an old namesake + 1 week never fires it
    expect(
      firedFollowups([{ ...f, after: 'echo merges + 1 week' }], old, since! + 7 * 86400e3),
    ).toEqual([]);
  });
});

describe('asks[] (dispatch asks the maintainer, answered by letter)', () => {
  const doc = (asks: unknown, extra: Record<string, unknown> = {}) =>
    parseQueue(JSON.stringify({ v: 1, updatedAt: '2026-11-18T20:00:00Z', asks, ...extra }));
  const ok = {
    id: 'd1',
    asked: '2026-11-18T19:00:00Z',
    text: 'Cache key?',
    options: ['branch', 'lockfile'],
    pick: 'b',
    status: 'open',
  };

  it('reads a good ask, its pick and lane, and askSeq', () => {
    const q = doc([{ ...ok, lane: 'warm-caches' }], { askSeq: 4 });
    expect(q.problems).toEqual([]);
    expect(q.data!.askSeq).toBe(4);
    expect(q.data!.asks![0]).toMatchObject({
      id: 'd1',
      pick: 'b',
      lane: 'warm-caches',
      needsPane: false,
      pane: null,
      status: 'open',
    });
  });
  it('the seed example and the fixture carry asks that parse', () => {
    expect(parseQueue(example).data!.asks!.length).toBeGreaterThan(0);
    const fx = readFileSync(join(import.meta.dirname, 'fixtures/board/queue.json'), 'utf8');
    const q = parseQueue(fx);
    expect(q.problems).toEqual([]);
    expect(q.data!.asks!.map((a) => a.status)).toEqual(['open', 'open', 'answered']);
  });
  it('drops an entry missing what it must have, and names it', () => {
    const q = doc([
      { ...ok, id: undefined },
      { ...ok, id: 'D2' },
      { ...ok, id: 'd0' },
      ok,
      { ...ok }, // duplicate d1: the later one goes, so an answer is never ambiguous
      { ...ok, id: 'd3', status: 'maybe' },
      { ...ok, id: 'd4', options: ['x', 7] },
      { ...ok, id: 'd5', options: ['only one'], pick: 'a' },
      { ...ok, id: 'd6', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
      { ...ok, id: 'd7', options: 'a,b' },
      null,
    ]);
    expect(q.data!.asks!.map((a) => a.id)).toEqual(['d1']);
    expect(q.problems).toEqual([
      'asks[0]: no id or text',
      'asks[1]: id "D2" is not d<n>',
      'asks[2]: id "d0" is not d<n>',
      'asks[4]: duplicate id d1',
      'asks[5]: status "maybe"',
      'asks[6]: options is not a list of text',
      'asks[7]: wants 2 to 6 options (has 1)',
      'asks[8]: wants 2 to 6 options (has 7)',
      'asks[9]: options is not a list of text',
      'asks[10]: no id or text',
    ]);
  });
  it('keeps an entry with a bad optional field, read the safe way', () => {
    const q = doc([
      { ...ok, id: 'd1', asked: 'soon' },
      { ...ok, id: 'd2', pick: 'c' },
      { ...ok, id: 'd3', lane: 'Bad Lane' },
      { ...ok, id: 'd4', needsPane: 'yes', pane: 'dispatch' },
      { ...ok, id: 'd5', needsPane: true, lane: 'warm-caches' },
      { ...ok, id: 'd6', answer: 'z' },
    ]);
    const a = q.data!.asks!;
    expect(a.map((x) => x.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
    expect(a[0]!.asked).toBeNull();
    expect(a[1]!.pick).toBeNull(); // so `ok` skips it
    expect(a[2]!.lane).toBeNull();
    expect(a[3]!.needsPane).toBe(true); // a garbled needsPane fails closed
    expect(a[4]!.pane).toBe('warm-caches'); // falls back to the lane
    expect(a[5]!.answer).toBeNull();
    expect(q.problems).toEqual([
      'asks[0]: asked is not an ISO time',
      'asks[1]: pick "c" is not one of its options',
      'asks[2]: lane is not a branch name',
      'asks[3]: needsPane is not true or false',
      'asks[4]: needsPane with no pane',
      'asks[5]: answer "z" is not one of its options',
    ]);
  });
  it('a pane ask may have no options', () => {
    const q = doc([
      {
        id: 'd9',
        asked: ok.asked,
        text: 'Apply the skills patch',
        needsPane: true,
        pane: 'dispatch',
        go: 'go 1a2b3c4d',
        status: 'open',
      },
    ]);
    expect(q.problems).toEqual([]);
    expect(q.data!.asks![0]).toMatchObject({
      needsPane: true,
      pane: 'dispatch',
      go: 'go 1a2b3c4d',
      options: [],
    });
  });
  it('a non-array asks and a bad askSeq are problems; no asks key reads as none', () => {
    expect(doc({}).problems).toEqual(['asks is not an array']);
    expect(doc([], { askSeq: -1 }).problems).toEqual(['askSeq is not a whole number']);
    expect(doc([], { askSeq: 1.5 }).problems).toEqual(['askSeq is not a whole number']);
    const none = parseQueue(JSON.stringify({ v: 1, updatedAt: '2026-11-18T20:00:00Z' }));
    expect(none.problems).toEqual([]);
    expect(none.data!.asks).toEqual([]);
    expect(none.data!.askSeq).toBeNull();
  });
});
