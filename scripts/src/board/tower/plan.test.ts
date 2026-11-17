import { describe, expect, it } from 'vitest';
import type { LaneEta } from './lanes.ts';
import { nextAsk, planSoon, planTable, type PlanPr } from './plan.ts';
import type { PlanItem } from './queue.ts';

const T = (hm: string) => Date.parse(`2026-11-16T${hm}:00Z`);
const NOW = T('19:00');
const row = (p: Partial<PlanItem> & { what: string }): PlanItem => ({
  at: null,
  kind: 'dev',
  who: null,
  you: null,
  eta: null,
  lane: null,
  done: false,
  doneAt: null,
  ...p,
});
const noEta = () => null;
const noPr = (): PlanPr => null;

describe('planTable', () => {
  it('strikes a row marked done, and a merge row whose lane PR merged; est vs actual in minutes', () => {
    const { rows } = planTable(
      [
        row({ at: T('17:00'), what: 'a', done: true, doneAt: T('17:20') }),
        row({ at: T('17:30'), what: 'b', done: true }),
        row({ at: T('18:00'), what: 'c', kind: 'merge', lane: 'x' }),
        row({
          at: T('18:10'),
          what: 'd',
          eta: { from: T('18:10'), to: T('18:40'), source: 'measured' },
          done: true,
          doneAt: T('18:30'),
        }),
      ],
      noEta,
      (b) => (b === 'x' ? { state: 'MERGED', mergedAt: T('17:55') } : null),
      NOW,
    );
    expect(rows.map((r) => [r.what, r.done, r.deltaMin])).toEqual([
      ['a', true, 20],
      ['b', true, null],
      ['c', true, -5],
      ['d', true, -10], // due is the eta's end
    ]);
    expect(rows.every((r) => !r.overdue && r.slip === null)).toBe(true);
  });

  it('slips a row when its lane ETA ends after its due: a merge against the PR ETA, others against next', () => {
    const eta: LaneEta = {
      next: { lo: T('19:10'), hi: T('19:40') },
      pr: { lo: T('20:00'), hi: T('20:30') },
      source: 'measured',
    };
    const { rows } = planTable(
      [
        row({ at: T('19:20'), what: 'dev', lane: 'x' }),
        row({ at: T('20:10'), what: 'merge', kind: 'merge', lane: 'x' }),
        row({ at: T('19:50'), what: 'in time', lane: 'x' }),
      ],
      (b) => (b === 'x' ? eta : null),
      noPr,
      NOW,
    );
    expect(rows.map((r) => [r.what, r.slip])).toEqual([
      ['dev', T('19:40')],
      ['merge', T('20:30')],
      ['in time', null],
    ]);
  });

  it('no slip with an open PR, with no lane ETA, or once done; overdue only when nothing says when', () => {
    const eta: LaneEta = { next: { lo: T('19:30'), hi: T('19:45') }, pr: null, source: 'guess' };
    const { rows } = planTable(
      [
        row({ at: T('18:00'), what: 'open pr', lane: 'x' }),
        row({ at: T('18:10'), what: 'no file', lane: 'nobody' }),
        row({ at: T('18:20'), what: 'done', lane: 'y', done: true }),
        row({ at: T('18:30'), what: 'slips', lane: 'y' }),
        row({ at: T('18:40'), what: 'merge, no pr eta', kind: 'merge', lane: 'y' }),
      ],
      (b) => (b === 'x' || b === 'y' ? eta : null),
      (b) => (b === 'x' ? { state: 'OPEN', mergedAt: null } : null),
      NOW,
    );
    expect(rows.map((r) => [r.what, r.slip, r.overdue])).toEqual([
      ['open pr', null, true],
      ['no file', null, true],
      ['done', null, false],
      ['slips', T('19:45'), false],
      ['merge, no pr eta', null, true],
    ]);
  });

  it('puts the now-line before the first row still ahead; undated rows sit after it', () => {
    const at = (hms: string[]) =>
      planTable(
        hms.map((h, k) => row({ at: h ? T(h) : null, what: String(k) })),
        noEta,
        noPr,
        NOW,
      ).nowIndex;
    expect(at(['19:30', '20:00'])).toBe(0);
    expect(at(['18:00', '19:00', '19:30'])).toBe(2); // a row at now has started
    expect(at(['17:00', '18:00'])).toBe(2);
    expect(at(['18:00', ''])).toBe(1);
    expect(at([])).toBe(0);
  });

  it('a slip whose time has passed too is late, and its ask is late', () => {
    const eta: LaneEta = { next: null, pr: { lo: T('18:00'), hi: T('18:30') }, source: 'measured' };
    const { rows } = planTable(
      [row({ at: T('17:00'), what: 'merge x', kind: 'merge', lane: 'x' })],
      () => eta,
      noPr,
      NOW,
    );
    expect(rows[0]).toMatchObject({ slip: T('18:30'), overdue: true });
    expect(nextAsk(rows, [], NOW)).toMatchObject({ hi: T('18:30'), late: true });
  });
});

describe('planSoon', () => {
  it('the next rows not done, a slipping or recent late one first; long-past rows drop off', () => {
    const { rows } = planTable(
      [
        row({ at: T('15:00'), what: 'long past' }),
        row({ at: T('18:30'), what: 'late' }),
        row({ at: T('18:40'), what: 'done', done: true }),
        row({ at: T('19:30'), what: 'next' }),
        row({ at: T('20:00'), what: 'then' }),
        row({ at: T('21:00'), what: 'later' }),
      ],
      noEta,
      noPr,
      NOW,
    );
    expect(planSoon(rows, NOW).map((r) => r.what)).toEqual(['late', 'next', 'then']);
  });
});

describe('nextAsk', () => {
  const lane = (branch: string, lo: string, hi: string, prOpen = false) => ({
    branch,
    eta: { next: null, pr: { lo: T(lo), hi: T(hi) }, source: 'measured' as const },
    prOpen,
  });
  it('a lane PR due before the next maintainer row wins', () => {
    const { rows } = planTable(
      [row({ at: T('20:00'), what: 'talk', kind: 'maintainer' })],
      noEta,
      noPr,
      NOW,
    );
    expect(nextAsk(rows, [lane('x', '19:30', '19:50')], NOW)).toEqual({
      lo: T('19:30'),
      hi: T('19:50'),
      what: 'x PR',
      branch: 'x',
      source: 'lane',
      late: false,
    });
    expect(nextAsk(rows, [lane('x', '20:30', '20:50')], NOW)).toMatchObject({
      lo: T('20:00'),
      hi: T('20:00'),
      what: 'talk',
      source: 'plan',
    });
  });
  it('a lane with its PR open asks nothing here; a late lane is due now; nothing is null', () => {
    expect(nextAsk([], [lane('x', '19:30', '19:50', true)], NOW)).toBeNull();
    expect(nextAsk([], [lane('x', '18:00', '18:30')], NOW)).toMatchObject({ late: true });
    // a late ask never hides one still ahead
    expect(
      nextAsk([], [lane('x', '18:00', '18:30'), lane('y', '19:30', '19:50')], NOW),
    ).toMatchObject({ branch: 'y', late: false });
    expect(nextAsk([], [], NOW)).toBeNull();
  });
  it('a slipping merge row asks at its slip; dev rows and done or passed rows never ask', () => {
    const { rows } = planTable(
      [
        row({ at: T('18:00'), what: 'passed', kind: 'maintainer' }),
        row({ at: T('19:10'), what: 'dev', kind: 'dev' }),
        row({ at: T('19:20'), what: 'done', kind: 'merge', done: true }),
        row({ at: T('19:30'), what: 'merge y', kind: 'merge', lane: 'y' }),
      ],
      (b) =>
        b === 'y' ? { next: null, pr: { lo: T('19:40'), hi: T('20:05') }, source: 'guess' } : null,
      noPr,
      NOW,
    );
    // the ask is the lane's window, not a moment
    expect(nextAsk(rows, [], NOW)).toMatchObject({
      lo: T('19:40'),
      hi: T('20:05'),
      what: 'merge y',
      branch: 'y',
    });
  });
});
