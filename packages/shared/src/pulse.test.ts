import { describe, expect, it } from 'vitest';
import { AREAS } from './areas';
import {
  PULSE_GRACE_MIN,
  PULSE_NOTE_MAX,
  PULSE_NOTES_KEPT,
  PULSE_WINDOW_MIN,
  decidePulse,
  normalizePulseNote,
  planPulse,
  pulseDoneNeeds,
  pulseMinutes,
  pulseResultOf,
  pulseSessionRow,
  pulseWindowMs,
  settlePulse,
  yieldPulse,
  type OpenPulse,
  type PulsePlanInput,
} from './pulse';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
let n = 0;
const base = (over: Partial<PulsePlanInput> = {}): PulsePlanInput => ({
  open: null,
  task: { id: 'A', categoryId: null },
  wasWork: false,
  windowMs: 15 * MIN,
  day: '2026-11-19',
  now: T0,
  note: null,
  blocked: null,
  finish: false,
  newId: () => `s${++n}`,
  ...over,
});
const openOn = (taskId: string, startedAt: number, lastPulseAt: number): OpenPulse => ({
  sessionId: `open-${taskId}`,
  taskId,
  categoryId: null,
  wasWork: false,
  day: '2026-11-19',
  startedAt,
  lastPulseAt,
  endedAt: lastPulseAt, // a running session is credited to its last pulse
  pulses: 1,
  notes: [],
});

describe('pulse windows', () => {
  it('keys every life area, each at least the grace, and reads a task with no category as personal', () => {
    for (const a of AREAS) expect(PULSE_WINDOW_MIN[a]).toBeGreaterThanOrEqual(PULSE_GRACE_MIN);
    expect(pulseWindowMs({ area: 'recruiting' })).toBe(20 * MIN);
    expect(pulseWindowMs({ area: 'school' })).toBe(25 * MIN);
    expect(pulseWindowMs({ area: 'aperture' })).toBe(15 * MIN);
    expect(pulseWindowMs(null)).toBe(PULSE_WINDOW_MIN.personal * MIN);
    expect(pulseWindowMs({ area: null })).toBe(PULSE_WINDOW_MIN.personal * MIN);
  });
});

describe('normalizePulseNote', () => {
  it('collapses to one line, cuts at the max, and reads blank as none', () => {
    expect(normalizePulseNote('  two\n\tlines  ')).toBe('two lines');
    const long = normalizePulseNote('x'.repeat(400))!;
    expect(long).toHaveLength(PULSE_NOTE_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(normalizePulseNote('x'.repeat(PULSE_NOTE_MAX))).toBe('x'.repeat(PULSE_NOTE_MAX));
    expect(normalizePulseNote(' \n ')).toBeNull();
    expect(normalizePulseNote(undefined)).toBeNull();
    expect(normalizePulseNote(null)).toBeNull();
  });
});

describe('planPulse', () => {
  it('opens a session at zero on a first pulse: nothing is credited before it has passed', () => {
    const p = planPulse(base({ note: 'started' }));
    expect(p.opened).toBe(true);
    expect(p.counted).toBe(true);
    expect(p.open).toMatchObject({
      taskId: 'A',
      startedAt: T0,
      lastPulseAt: T0,
      endedAt: T0,
      pulses: 1,
    });
    expect(p.open!.notes).toEqual([{ at: T0, text: 'started' }]);
    expect(p.rows).toEqual([{ session: p.open, deltaMin: 0 }]);
  });

  it('extends inside the window, crediting exactly the gap', () => {
    const open = openOn('A', T0 - 4 * MIN, T0 - 4 * MIN);
    const p = planPulse(base({ open, now: T0 + 6 * MIN }));
    expect(p.opened).toBe(false);
    expect(p.open).toMatchObject({
      sessionId: open.sessionId,
      pulses: 2,
      lastPulseAt: T0 + 6 * MIN,
    });
    expect(p.rows).toEqual([{ session: p.open, deltaMin: 10 }]);
    expect(pulseMinutes(p.open!)).toBe(10);
    expect(p.closed).toBeUndefined();
  });

  it('extends at exactly the window; one ms past it settles the old session with its whole grace and opens anew', () => {
    const open = openOn('A', T0 - 5 * MIN, T0);
    expect(planPulse(base({ open, now: T0 + 15 * MIN })).opened).toBe(false);
    const p = planPulse(base({ open, now: T0 + 15 * MIN + 1 }));
    expect(p.opened).toBe(true);
    expect(p.rows[0]).toEqual({
      session: { ...open, endedAt: T0 + PULSE_GRACE_MIN * MIN },
      deltaMin: PULSE_GRACE_MIN,
    });
    expect(p.rows[1]).toMatchObject({ deltaMin: 0, session: { taskId: 'A', pulses: 1 } });
    expect(p.closed).toEqual({ taskId: 'A', minutes: 5 + PULSE_GRACE_MIN });
  });

  it('a switch inside the grace settles the old session with only the time that passed', () => {
    const open = openOn('A', T0 - 10 * MIN, T0 - MIN);
    const p = planPulse(base({ open, task: { id: 'B', categoryId: null } }));
    expect(p.rows[0]).toEqual({ session: { ...open, endedAt: T0 }, deltaMin: 1 });
    expect(p.rows[1]!.session.taskId).toBe('B');
    expect(p.closed).toEqual({ taskId: 'A', minutes: 10 });
    expect(p.open!.taskId).toBe('B');
  });

  it('a switch past the old grace credits the whole grace, never more', () => {
    const open = openOn('A', T0 - 20 * MIN, T0 - 10 * MIN);
    const p = planPulse(base({ open, task: { id: 'B', categoryId: null } }));
    expect(p.rows[0]!.deltaMin).toBe(PULSE_GRACE_MIN);
    expect(p.closed!.minutes).toBe(10 + PULSE_GRACE_MIN);
  });

  it('blocked: settles the open session, opens nothing, counts nothing', () => {
    const open = openOn('A', T0 - 5 * MIN, T0 - MIN);
    const p = planPulse(base({ open, blocked: 'timer' }));
    expect(p).toMatchObject({ open: null, counted: false, opened: false, current: null });
    expect(p.rows).toEqual([{ session: { ...open, endedAt: T0 }, deltaMin: 1 }]);
    expect(planPulse(base({ blocked: 'sitting' })).rows).toEqual([]);
  });

  it('finish: the live session ends with its grace and the state clears; with nothing live no empty row', () => {
    const open = openOn('A', T0 - 10 * MIN, T0 - 2 * MIN);
    const p = planPulse(base({ open, finish: true }));
    expect(p.open).toBeNull();
    expect(p.current).toMatchObject({ endedAt: T0 + PULSE_GRACE_MIN * MIN, pulses: 2 });
    expect(p.rows[0]!.deltaMin).toBe(2 + PULSE_GRACE_MIN);
    const none = planPulse(base({ finish: true }));
    expect(none).toMatchObject({ rows: [], current: null, open: null, counted: true });
    // Done after its own window lapsed: the old session settles (its grace), nothing new opens.
    const lapsed = planPulse(
      base({ open: openOn('A', T0 - 40 * MIN, T0 - 30 * MIN), finish: true }),
    );
    expect(lapsed.rows.map((r) => r.deltaMin)).toEqual([PULSE_GRACE_MIN]);
    expect(lapsed.current).toBeNull();
    // Done on A while B is open: B settles, A has nothing live.
    const other = planPulse(base({ open: openOn('B', T0 - 5 * MIN, T0 - MIN), finish: true }));
    expect(other.rows).toEqual([
      { session: expect.objectContaining({ taskId: 'B', endedAt: T0 }), deltaMin: 1 },
    ]);
    expect(other.closed).toEqual({ taskId: 'B', minutes: 5 });
  });

  it('every delta is non-negative: nothing credited is ever taken back', () => {
    const cases: PulsePlanInput[] = [
      base({ open: openOn('A', T0 - 5 * MIN, T0 - MIN) }),
      base({ open: openOn('A', T0 - 5 * MIN, T0 - MIN), task: { id: 'B', categoryId: null } }),
      base({ open: openOn('A', T0 - 5 * MIN, T0 - MIN), blocked: 'timer' }),
      base({ open: openOn('A', T0 - 5 * MIN, T0 - MIN), finish: true }),
      base({ open: openOn('A', T0, T0), now: T0 - 5 }),
    ];
    for (const c of cases)
      for (const r of planPulse(c).rows) expect(r.deltaMin).toBeGreaterThanOrEqual(0);
  });

  it('never moves a session backwards on a pulse stamped before its last (two clocks)', () => {
    const open = openOn('A', T0, T0);
    const p = planPulse(base({ open, now: T0 - 5 }));
    expect(p.rows[0]!.deltaMin).toBe(0);
    expect(p.open!.lastPulseAt).toBe(T0);
  });

  it('keeps only the newest notes', () => {
    let open: OpenPulse | null = null;
    for (let i = 0; i < PULSE_NOTES_KEPT + 5; i++)
      open = planPulse(base({ open, now: T0 + i * 1000, note: `n${i}` })).open;
    expect(open!.notes).toHaveLength(PULSE_NOTES_KEPT);
    expect(open!.notes.at(-1)!.text).toBe(`n${PULSE_NOTES_KEPT + 4}`);
  });
});

describe('settlePulse and yieldPulse', () => {
  it('settles with the time since the last pulse, at most the grace, and only once', () => {
    const o = openOn('A', T0, T0 + MIN);
    expect(settlePulse(o, T0 + 2 * MIN).endedAt).toBe(T0 + 2 * MIN);
    expect(settlePulse(o, T0 + 60 * MIN).endedAt).toBe(T0 + (1 + PULSE_GRACE_MIN) * MIN);
    expect(settlePulse(o, T0)).toBe(o); // a clock behind the last pulse adds nothing
    const settled = settlePulse(o, T0 + 60 * MIN);
    expect(settlePulse(settled, T0 + 90 * MIN)).toBe(settled);
  });
  it('yields only the timed task, settling its session to now', () => {
    const o = openOn('A', T0 - 5 * MIN, T0 - MIN);
    expect(yieldPulse(o, 'B', T0)).toBeNull();
    expect(yieldPulse(null, 'A', T0)).toBeNull();
    expect(yieldPulse(o, 'A', T0)!.row!.deltaMin).toBe(1);
    expect(yieldPulse(o, 'A', T0 + 60 * MIN)!.row!.deltaMin).toBe(PULSE_GRACE_MIN); // lapsed: its whole grace
    expect(yieldPulse(o, 'A', T0 - MIN)).toEqual({ row: null }); // nothing passed: clear the state only
  });
});

describe('the done gate', () => {
  const task = { place: null, estimateMin: 30, actualAccruedMin: 0 };
  it('names what a done needs', () => {
    expect(pulseDoneNeeds(task, 5, 'timer')).toBe('app');
    expect(pulseDoneNeeds({ ...task, estimateMin: null }, 5, null)).toBe('estimate');
    expect(pulseDoneNeeds(task, 0.5, null)).toBe('actual');
    expect(pulseDoneNeeds(task, 1, null)).toBeNull();
    expect(pulseDoneNeeds({ place: 'grocer', estimateMin: null }, 0, null)).toBeNull(); // an errand
  });
  it('decidePulse: a refused done is an ordinary pulse that keeps the session open', () => {
    const open = openOn('A', T0 - 10 * MIN, T0 - MIN);
    const t = { ...task, id: 'A', categoryId: null };
    const refused = decidePulse({
      ...base({ open }),
      done: true,
      task: { ...t, estimateMin: null },
    });
    expect(refused.needs).toBe('estimate');
    expect(refused.plan.open).not.toBeNull();
    expect(refused.plan.rows[0]!.deltaMin).toBe(1); // the gap only: no grace without the finish
    const ok = decidePulse({ ...base({ open }), done: true, task: t });
    expect(ok.needs).toBeNull();
    expect(ok.plan.open).toBeNull();
    expect(ok.plan.current!.endedAt).toBe(T0 + PULSE_GRACE_MIN * MIN);
  });
  it('decidePulse: the gate counts the minutes this pulse adds', () => {
    const t = { ...task, id: 'A', categoryId: null };
    // Nothing tracked before, but the live session's gap plus its grace clears the minute.
    const live = openOn('A', T0 - 30_000, T0 - 30_000);
    expect(decidePulse({ ...base({ open: live }), done: true, task: t }).needs).toBeNull();
    // Nothing live on A (B is open): A gains nothing, so under a minute it needs the user's number.
    const elsewhere = openOn('B', T0 - 5 * MIN, T0 - MIN);
    const d = decidePulse({
      ...base({ open: elsewhere }),
      done: true,
      task: { ...t, actualAccruedMin: 0.5 },
    });
    expect(d.needs).toBe('actual');
    expect(d.plan.open).not.toBeNull(); // re-planned as an ordinary pulse: A opens
  });
});

describe('the session row and the answer', () => {
  it('a pulse row is a completed work session whose minutes are its span', () => {
    const o = { ...openOn('A', T0, T0 + 4 * MIN), endedAt: T0 + (4 + PULSE_GRACE_MIN) * MIN };
    const row = pulseSessionRow({ ...o, notes: [{ at: T0, text: 'x' }] }, 'u1', T0 + 5 * MIN);
    expect(row).toMatchObject({
      id: o.sessionId,
      status: 'completed',
      kind: 'work',
      source: 'pulse',
      endedAt: T0 + (4 + PULSE_GRACE_MIN) * MIN,
      activeMinutes: 4 + PULSE_GRACE_MIN,
      lastHeartbeatAt: T0 + 4 * MIN,
      pulses: 1,
      pulseNotes: [{ at: T0, text: 'x' }],
      updatedAt: T0 + 5 * MIN,
    });
  });
  it('the answer carries the reason and the need with its message, and rounds minutes', () => {
    const plan = planPulse(base({ blocked: 'sitting' }));
    const r = pulseResultOf(
      { id: 'A', title: 't', status: 'in_progress', actualAccruedMin: 1.234 },
      plan,
      { blocked: 'sitting', done: true, needs: 'app' },
    );
    expect(r).toMatchObject({
      counted: false,
      reason: 'sitting',
      done: false,
      needs: 'app',
      taskActualMin: 1.2,
      sessionMin: 0,
    });
    expect(r.message).toMatch(/finish it in Aperture/);
    const plain = pulseResultOf(
      { id: 'A', title: 't', status: 'in_progress', actualAccruedMin: 3 },
      planPulse(base()),
      { blocked: null, done: false, needs: null },
    );
    expect(plain).not.toHaveProperty('done');
    expect(plain).not.toHaveProperty('message');
  });
});
