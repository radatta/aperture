import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decideDev,
  decideHeavy,
  devLease,
  leaseFor,
  RAMP_SEC,
  type DevLease,
  type DevRequest,
} from './lease.ts';
import { classCost, parseLimits, thresholds } from './limits.ts';

const now = new Date('2026-10-13T18:00:00Z');
const req = (patch: Partial<DevRequest> = {}): DevRequest => ({
  pid: 200,
  start: 's200',
  name: 'session-board',
  branch: 'session-board',
  ttlSec: 2700,
  ...patch,
});
const held = (patch: Partial<DevLease> = {}): DevLease => ({
  ...devLease(
    req({ pid: 100, start: 's100', name: 'flux', branch: 'flux' }),
    new Date('2026-10-13T17:50:00Z'),
  ),
  ...patch,
});
const alive = () => true;
const dead = () => false;

describe('decideDev', () => {
  it('grants a free lease and renews for its own holder', () => {
    expect(decideDev(null, req(), now, alive)).toEqual({ kind: 'grant' });
    expect(decideDev(held(), req({ pid: 100, start: 's100' }), now, alive)).toEqual({
      kind: 'renew',
    });
  });

  it('makes others wait while the holder is alive and in date', () => {
    expect(decideDev(held(), req(), now, alive)).toEqual({ kind: 'wait', holder: held() });
  });

  it('treats a reused pid (different start time) as someone else', () => {
    expect(decideDev(held(), req({ pid: 100, start: 'other' }), now, alive).kind).toBe('wait');
  });

  it('takes over an expired lease, even from a live holder', () => {
    const d = decideDev(held({ expiresAt: '2026-10-13T17:59:59Z' }), req(), now, alive);
    expect(d).toMatchObject({
      kind: 'takeover',
      reason: 'expired',
      previous: { holderName: 'flux' },
    });
  });

  it('takes over from a dead holder at once, but a gone holder keeps it until TTL', () => {
    expect(decideDev(held(), req(), now, dead)).toMatchObject({ kind: 'takeover', reason: 'dead' });
    expect(decideDev(held({ holderGone: true }), req(), now, dead).kind).toBe('wait');
  });

  it("hands a gone holder's lease to the restarted session on the same branch", () => {
    const gone = held({ holderGone: true });
    expect(decideDev(gone, req({ branch: 'flux', name: 'flux' }), now, dead)).toMatchObject({
      kind: 'takeover',
      reason: 'resumed',
      previous: gone,
    });
    expect(decideDev(gone, req(), now, dead).kind).toBe('wait'); // another branch still waits for the TTL
    expect(decideDev(held(), req({ branch: 'flux' }), now, alive).kind).toBe('wait'); // live holder: no
  });

  it('honours --force, logged as a takeover', () => {
    expect(decideDev(held(), req({ force: true }), now, alive)).toMatchObject({
      kind: 'takeover',
      reason: 'forced',
    });
  });

  it('a resumed lease keeps its original acquiredAt and note; a new --note wins', () => {
    const gone = held({ holderGone: true, note: 'dev-test round 1' });
    const back = req({ branch: 'flux', name: 'flux' });
    const d = decideDev(gone, back, now, dead);
    expect(leaseFor(d, back, now)).toMatchObject({
      holderPid: 200,
      acquiredAt: gone.acquiredAt,
      expiresAt: '2026-10-13T18:45:00Z',
      note: 'dev-test round 1',
    });
    expect(leaseFor(d, back, now, 'round 2')?.note).toBe('round 2');
    // any other takeover starts a fresh lease
    const expired = decideDev(
      held({ expiresAt: '2026-10-13T17:59:59Z', note: 'x' }),
      req(),
      now,
      alive,
    );
    expect(leaseFor(expired, req(), now)).toEqual(devLease(req(), now));
    expect(leaseFor({ kind: 'renew' }, req(), now)).toBeUndefined();
  });

  it('builds the lease with the TTL', () => {
    expect(devLease(req(), now, 'dev-test round 1')).toEqual({
      v: 1,
      holderPid: 200,
      holderStart: 's200',
      holderName: 'session-board',
      branch: 'session-board',
      acquiredAt: '2026-10-13T18:00:00Z',
      expiresAt: '2026-10-13T18:45:00Z',
      ttlSec: 2700,
      note: 'dev-test round 1',
    });
  });
});

describe('decideHeavy', () => {
  const shipped = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../board/limits.json', import.meta.url)), 'utf8'),
  );
  const MiB = 1048576;
  const GiB = 1024 * MiB;
  const ll = { pidsMax: 4096, highBytes: 18 * GiB }; // soft 3276 pids / 10.8 GiB, hard 3768 / 14.4 GiB
  const limits = (enforce = false) => ({ ...parseLimits(structuredClone(shipped)), enforce });
  const idle = { pids: 300, anonBytes: 2 * GiB };
  const slot = (cls: string, ageSec: number, pid = 1) => ({
    pid,
    class: cls,
    wrapperPid: 9000 + pid,
    startedAt: new Date(now.getTime() - ageSec * 1000).toISOString(),
  });

  // the measured cost of one test job (limits.json is rewritten by each quiet window)
  const cost = () => classCost(limits(), 'test');

  it('grants under soft and predicts live + request', () => {
    const d = decideHeavy(limits(), ll, idle, [], { class: 'test' }, now);
    expect(d).toMatchObject({
      verdict: 'grant',
      wait: false,
      predicted: { pids: 300 + cost().pids, anonMiB: 2048 + cost().anonMiB },
    });
    expect(d.thresholds).toEqual({
      pidsSoft: 3276,
      pidsHard: 3768,
      anonSoftMiB: 11059,
      anonHardMiB: 14746,
    });
  });

  it('bites only past the hard line: exactly at it is a nudge', () => {
    // derived, not hard-coded: the quiet window rewrites the class costs in limits.json
    const hard = thresholds(limits(true), ll).pidsHard;
    const onHard = hard - classCost(limits(true), 'test').pids; // live pids that land exactly on hard
    const at = decideHeavy(limits(true), ll, { ...idle, pids: onHard }, [], { class: 'test' }, now);
    expect(at).toMatchObject({ verdict: 'nudge', wait: false, predicted: { pids: hard } });
    const past = decideHeavy(
      limits(true),
      ll,
      { ...idle, pids: onHard + 1 },
      [],
      { class: 'test' },
      now,
    );
    expect(past).toMatchObject({ verdict: 'over-hard', wait: true, predicted: { pids: hard + 1 } });
  });

  it('counts young slots (not ramped yet) and trusts live numbers for older ones', () => {
    const young = decideHeavy(
      limits(),
      ll,
      idle,
      [slot('test', 5), slot('test', 5, 2)],
      { class: 'test' },
      now,
    );
    expect(young.predicted.anonMiB).toBe(2048 + 3 * cost().anonMiB);
    const old = decideHeavy(
      limits(),
      ll,
      idle,
      [slot('test', RAMP_SEC + 1)],
      { class: 'test' },
      now,
    );
    expect(old.predicted.anonMiB).toBe(2048 + cost().anonMiB);
  });

  it('nudges over soft but never waits there', () => {
    const th = thresholds(limits(true), ll); // live anon that lands the prediction midway soft → hard
    const anonBytes = (th.anonSoft + th.anonHard) / 2 - cost().anonMiB * MiB;
    const d = decideHeavy(limits(true), ll, { pids: 300, anonBytes }, [], { class: 'test' }, now);
    expect(d).toMatchObject({ verdict: 'nudge', wait: false });
  });

  it('waits past hard only when enforce is on', () => {
    const busy = { pids: 300, anonBytes: 12 * GiB };
    expect(decideHeavy(limits(false), ll, busy, [], { class: 'test' }, now)).toMatchObject({
      verdict: 'over-hard',
      wait: false,
    });
    expect(decideHeavy(limits(true), ll, busy, [], { class: 'test' }, now)).toMatchObject({
      verdict: 'over-hard',
      wait: true,
    });
    const pids = { pids: 3700, anonBytes: 2 * GiB };
    expect(decideHeavy(limits(true), ll, pids, [], { class: 'test' }, now)).toMatchObject({
      verdict: 'over-hard',
      wait: true,
    });
  });

  it('treats an unknown class as free', () => {
    expect(decideHeavy(limits(true), ll, idle, [], { class: 'other' }, now).predicted).toEqual({
      pids: 300,
      anonMiB: 2048,
    });
  });

  describe('the test cap (concurrency.test in limits.json)', () => {
    const tests = (n: number, ageSec = 60) =>
      Array.from({ length: n }, (_, i) => slot('test', ageSec, i + 1));
    const max = limits().concurrency!.test!;

    it('changes nothing below the cap', () => {
      const d = decideHeavy(limits(true), ll, idle, tests(max - 1), { class: 'test' }, now);
      expect(d).toMatchObject({ verdict: 'grant', wait: false });
      expect(d.cap).toEqual({ max, running: max - 1, full: false });
    });

    it('holds the next test job at the cap only when enforcing', () => {
      const on = decideHeavy(limits(true), ll, idle, tests(max), { class: 'test' }, now);
      expect(on).toMatchObject({
        verdict: 'cap-full',
        wait: true,
        cap: { max, running: max, full: true },
      });
      const off = decideHeavy(limits(false), ll, idle, tests(max), { class: 'test' }, now);
      expect(off).toMatchObject({ verdict: 'cap-full', wait: false });
    });

    it('counts slots however young — a just-started suite is about to take 8 cores', () => {
      const d = decideHeavy(limits(true), ll, idle, tests(max, 1), { class: 'test' }, now);
      expect(d.verdict).toBe('cap-full');
    });

    it('is per class: other classes are judged by the budget only', () => {
      const d = decideHeavy(limits(true), ll, idle, tests(max), { class: 'typecheck' }, now);
      expect(d).toMatchObject({ verdict: 'grant', wait: false, cap: null });
    });

    it('never holds a load test — they probe the edge on purpose', () => {
      const req = { class: 'test', loadTest: true };
      const d = decideHeavy(limits(true), ll, idle, tests(max), req, now);
      expect(d.verdict).not.toBe('cap-full');
      expect(d.wait).toBe(false);
    });

    it('wins over the hard line when both apply', () => {
      const past = { pids: 4000, anonBytes: 2 * GiB };
      const d = decideHeavy(limits(true), ll, past, tests(max), { class: 'test' }, now);
      expect(d).toMatchObject({ verdict: 'cap-full', wait: true });
    });

    it('reads the cap from limits.json', () => {
      const two = { ...limits(true), concurrency: { test: 2 } };
      expect(decideHeavy(two, ll, idle, tests(2), { class: 'test' }, now).verdict).toBe('cap-full');
      expect(decideHeavy(two, ll, idle, tests(1), { class: 'test' }, now).verdict).toBe('grant');
    });
  });
});
