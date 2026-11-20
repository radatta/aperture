// Pulse tracking (docs/areas/mcp/pulse.md): a Claude session sends `pulse` (a task id, an optional one-line
// note) on every reply; the server turns pulses into work sessions and the task's actual minutes. All the
// timing lives here, server-side — the client has no clock and decides nothing.
//
// A pulse session is a PomodoroSession row with source 'pulse', written COMPLETED from birth and rewritten
// as pulses extend it, so the app's timer (which adopts running rows) never sees it. Its minutes are always
// (end − start). While it runs it is credited to its last pulse; the next pulse (any task) or a timer start
// settles it with its tail — the grace, or less if that came sooner — so time is credited only once it has
// passed and never taken back, with no close step and no schedule. One open session per user, held in one
// state row (`OpenPulse`) both impls change under a conditional write. Pure: the stub and the Lambda share it.

import { areaOf, type Area } from './areas';
import { isCalibrated, needsEstimate } from './machines';
import type { BaseEntity, Category, PomodoroSession, PulseNote } from './types';

// The windows a gap may last and still be the same session, by the task's life area (its category's).
// One constant, server-side only: the first-week check retunes it without a schema change. A gap past the
// window closes the session at the last pulse plus the grace; the next pulse opens a new one.
export const PULSE_WINDOW_MIN: Record<Area, number> = {
  recruiting: 20, // mocks and system design have silent stretches; LeetCode is sitting-timed anyway
  school: 25, // homework and reading look like silence
  aperture: 15,
  personal: 15,
};
// Reading the last reply: every session ends this long after its last pulse — less when the next pulse
// for another task, or a timer start, comes sooner. A done keeps it.
export const PULSE_GRACE_MIN = 3;
export const PULSE_NOTE_MAX = 140;
export const PULSE_NOTES_KEPT = 20;

const MIN = 60_000;
export const pulseWindowMs = (category: Pick<Category, 'area'> | null | undefined): number =>
  PULSE_WINDOW_MIN[areaOf(category)] * MIN;

export interface PulseInput {
  taskId: string;
  note?: string | null;
  done?: boolean;
}

// Why a pulse added no time: a running timer on the task, or a LeetCode sitting's rep (sittings.ts times it).
export type PulseBlock = 'timer' | 'sitting';
// Why `done` didn't finish the task: finish it in the app (a timer or sitting times it), or it needs numbers.
export type PulseNeeds = 'app' | 'estimate' | 'actual';

export interface PulseResult {
  task: { id: string; title: string; status: string };
  counted: boolean;
  reason?: PulseBlock;
  opened: boolean; // this pulse started a new session
  sessionMin: number; // the session this pulse landed in (0 when not counted)
  taskActualMin: number;
  pulses: number; // in this session
  closed?: { taskId: string; minutes: number }; // a session this pulse ended (a switch, or a block)
  done?: boolean;
  needs?: PulseNeeds;
  message?: string;
}

// The open session: everything its row is derived from. `endedAt` is how far it is credited: its last pulse
// while it runs, the last pulse plus its tail once settled (settlePulse), or plus the grace on a done.
export interface OpenPulse {
  sessionId: string;
  taskId: string;
  categoryId: string | null;
  wasWork: boolean;
  day: string;
  startedAt: number;
  lastPulseAt: number;
  endedAt: number;
  pulses: number;
  notes: PulseNote[];
}
// The per-user state row: the open session, or none.
export interface PulseState extends BaseEntity {
  open: OpenPulse | null;
}
export const PULSE_STATE_ID = 'pulse';

// One line, at most PULSE_NOTE_MAX characters: whitespace runs collapse, the rest is cut. A pulse is never
// refused over its note — a refusal would lose the time. Empty → null.
export function normalizePulseNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  const line = note.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > PULSE_NOTE_MAX ? `${line.slice(0, PULSE_NOTE_MAX - 1)}…` : line;
}

export const pulseMinutes = (o: Pick<OpenPulse, 'startedAt' | 'endedAt'>): number =>
  Math.max(0, o.endedAt - o.startedAt) / MIN;

// The session row an open pulse writes: a completed work session, rewritten in place on every pulse.
export function pulseSessionRow(o: OpenPulse, userId: string, now: number): PomodoroSession {
  return {
    id: o.sessionId,
    userId,
    createdAt: o.startedAt,
    updatedAt: now,
    deletedAt: null,
    taskId: o.taskId,
    categoryId: o.categoryId,
    label: null,
    wasWork: o.wasWork,
    kind: 'work',
    startedAt: o.startedAt,
    endedAt: o.endedAt,
    day: o.day,
    activeMinutes: pulseMinutes(o),
    status: 'completed',
    lastHeartbeatAt: o.lastPulseAt,
    source: 'pulse',
    pulses: o.pulses,
    pulseNotes: o.notes,
  };
}

// Ends a session at `now`: its tail is the time since its last pulse, at most the grace (a gap past the
// window gets the whole grace; a switch or a timer start sooner gets only what passed). Never earlier than
// what it was already credited. Unchanged when already settled.
export function settlePulse(o: OpenPulse, now: number): OpenPulse {
  const tail = Math.min(PULSE_GRACE_MIN * MIN, Math.max(0, now - o.lastPulseAt));
  const end = Math.max(o.endedAt, o.lastPulseAt + tail);
  return end === o.endedAt ? o : { ...o, endedAt: end };
}

export interface PulsePlanInput {
  open: OpenPulse | null;
  task: { id: string; categoryId: string | null };
  wasWork: boolean;
  windowMs: number; // the task's window (pulseWindowMs)
  day: string; // the app day a new session would be filed under
  now: number;
  note: string | null; // normalized
  blocked: PulseBlock | null;
  finish: boolean; // a done that passed its gate: the session ends with its grace, and the state clears
  newId: () => string;
}
// A session row to write and the minutes it adds to its task's actual — never negative: time is only ever
// credited once it has passed (or, on a done, as the grace), so nothing is ever taken back.
export interface PulseRowChange {
  session: OpenPulse;
  deltaMin: number;
}
export interface PulsePlan {
  open: OpenPulse | null; // the state row's next value
  rows: PulseRowChange[]; // in write order: a settled old session first
  counted: boolean;
  opened: boolean;
  current: OpenPulse | null; // the session this pulse landed in
  closed?: { taskId: string; minutes: number }; // a session this pulse settled
}

const withNote = (notes: PulseNote[], note: string | null, at: number): PulseNote[] =>
  note ? [...notes, { at, text: note }].slice(-PULSE_NOTES_KEPT) : notes;
const delta = (before: OpenPulse, after: OpenPulse): number =>
  pulseMinutes(after) - pulseMinutes(before);

// The decision for one pulse. A pulse is the server's own clock reading; a client's time is never asked for.
// A running session is credited up to its last pulse; its tail (the grace, or less) is credited when the
// next pulse — for any task — or a timer start settles it.
//  - same task, inside its window: extend (credit the gap since the last pulse);
//  - same task, past its window: settle the old session (its whole grace), open a new one;
//  - another task: settle the old session (the time since its last pulse, at most the grace), open a new one;
//  - blocked (a timer or a sitting times this task): settle any open session, open nothing;
//  - finish: the session this pulse lands in ends with its grace, and the state clears.
export function planPulse(p: PulsePlanInput): PulsePlan {
  const { open, now } = p;
  const grace = PULSE_GRACE_MIN * MIN;
  const rows: PulseRowChange[] = [];
  let closed: PulsePlan['closed'];
  const settle = (o: OpenPulse) => {
    const done = settlePulse(o, now);
    if (done !== o) rows.push({ session: done, deltaMin: delta(o, done) });
    closed = { taskId: o.taskId, minutes: pulseMinutes(done) };
  };
  const same = open !== null && open.taskId === p.task.id;
  const live = same && now - open.lastPulseAt <= p.windowMs;

  if (p.blocked) {
    if (open) settle(open);
    return { open: null, rows, counted: false, opened: false, current: null, closed };
  }

  let current: OpenPulse | null = null;
  let opened = false;
  if (open && live) {
    const last = Math.max(open.lastPulseAt, now); // two Lambdas' clocks may differ by a few ms
    current = {
      ...open,
      lastPulseAt: last,
      endedAt: Math.max(open.endedAt, p.finish ? last + grace : last),
      pulses: open.pulses + 1,
      notes: withNote(open.notes, p.note, now),
    };
    rows.push({ session: current, deltaMin: delta(open, current) });
  } else {
    if (open) settle(open);
    // A done with no live session on the task: nothing to time, so no empty row.
    if (!p.finish) {
      current = {
        sessionId: p.newId(),
        taskId: p.task.id,
        categoryId: p.task.categoryId,
        wasWork: p.wasWork,
        day: p.day,
        startedAt: now,
        lastPulseAt: now,
        endedAt: now,
        pulses: 1,
        notes: withNote([], p.note, now),
      };
      opened = true;
      rows.push({ session: current, deltaMin: 0 });
    }
  }
  return { open: p.finish ? null : current, rows, counted: true, opened, current, closed };
}

// The done gate, on the numbers this pulse leaves: a timer or a sitting times the task (finish it in the
// app, which stops it); no estimate (ask for one, set it, pulse done again); under a minute tracked. An
// errand needs neither number (machines.ts isCalibrated). Null → the task can be marked done.
export function pulseDoneNeeds(
  task: { place: string | null; estimateMin: number | null },
  actualAfterMin: number,
  blocked: PulseBlock | null,
): PulseNeeds | null {
  if (blocked) return 'app';
  if (!isCalibrated(task)) return null;
  if (needsEstimate(task)) return 'estimate';
  return actualAfterMin >= 1 ? null : 'actual';
}

export const PULSE_PARENT_ERROR =
  'A task with parts isn’t worked on itself — pulse the part being worked on.';

// The plan for one pulse with its done gate applied: a done the gate refuses is an ordinary pulse (the
// session stays open), and the answer says what it needs. `task` is as read before this pulse.
export function decidePulse(
  p: Omit<PulsePlanInput, 'finish'> & {
    done: boolean;
    task: { place: string | null; estimateMin: number | null; actualAccruedMin: number };
  },
): { plan: PulsePlan; needs: PulseNeeds | null } {
  if (!p.done) return { plan: planPulse({ ...p, finish: false }), needs: null };
  const plan = planPulse({ ...p, finish: true });
  const gained = plan.rows
    .filter((r) => r.session.taskId === p.task.id)
    .reduce((sum, r) => sum + r.deltaMin, 0);
  const needs = pulseDoneNeeds(p.task, p.task.actualAccruedMin + gained, p.blocked);
  return needs ? { plan: planPulse({ ...p, finish: false }), needs } : { plan, needs: null };
}

const MESSAGES: Record<PulseBlock | PulseNeeds, string> = {
  timer: 'A timer is running on this task; it times the work, so this pulse added nothing.',
  sitting: 'A LeetCode sitting times this task; it is finished with Done in Aperture.',
  app: 'Not marked done: a timer or a sitting times this task — finish it in Aperture.',
  estimate:
    'Not marked done: the task has no estimate. Ask what they would have estimated, set it with update_task, then pulse done again.',
  actual:
    'Not marked done: under a minute is tracked. Ask how long it took and use complete_task with their number.',
};
const round1 = (n: number) => Math.round(n * 10) / 10;

// The answer both impls return, from the task as it ends up.
export function pulseResultOf(
  task: { id: string; title: string; status: string; actualAccruedMin: number },
  plan: PulsePlan,
  opts: { blocked: PulseBlock | null; done: boolean; needs: PulseNeeds | null },
): PulseResult {
  const { current } = plan;
  const message = opts.needs ? MESSAGES[opts.needs] : opts.blocked ? MESSAGES[opts.blocked] : null;
  return {
    task: { id: task.id, title: task.title, status: task.status },
    counted: plan.counted,
    ...(opts.blocked ? { reason: opts.blocked } : {}),
    opened: plan.opened,
    sessionMin: current ? round1(pulseMinutes(current)) : 0,
    taskActualMin: round1(task.actualAccruedMin),
    pulses: current?.pulses ?? 0,
    ...(plan.closed
      ? { closed: { taskId: plan.closed.taskId, minutes: round1(plan.closed.minutes) } }
      : {}),
    ...(opts.done ? { done: opts.needs === null } : {}),
    ...(opts.needs ? { needs: opts.needs } : {}),
    ...(message ? { message } : {}),
  };
}

// A work timer started on a task settles that task's open pulse session now: the timer is the clock from
// here. Null when the open session (if any) is another task's.
export function yieldPulse(
  open: OpenPulse | null,
  taskId: string,
  now: number,
): { row: PulseRowChange | null } | null {
  if (!open || open.taskId !== taskId) return null;
  const done = settlePulse(open, now);
  return { row: done === open ? null : { session: done, deltaMin: delta(open, done) } };
}
