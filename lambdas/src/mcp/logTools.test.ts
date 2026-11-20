import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USER_TIME_ZONE, zonedEpoch, type ApiMethod } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// search_log / list_log / get_day over the real handleRpc path. Pinned to UTC like the Lambda, so a day
// bucketed by the runtime's clock instead of the user's zone fails here.
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const U = 'local';
const at = (day: string, hhmm: string) => zonedEpoch(day, hhmm, USER_TIME_ZONE);
let clock: number;
let doc: InMemoryDoc;
let backend: BackendClient;
let ctx: ToolContext;
let dispatched: string[];

const backendFor = (userId: string) =>
  new BackendClient(new Repo(doc, liveWrites(doc), userId), { userId, now: () => clock });

beforeEach(() => {
  clock = at('2026-11-05', '12:00');
  doc = new InMemoryDoc();
  backend = backendFor(U);
  dispatched = [];
  ctx = {
    dispatch: (method: ApiMethod, args: unknown[]) => {
      dispatched.push(method);
      return handleRpc(doc, { userId: U, method, args, now: () => clock });
    },
    upload: async () => {},
    now: () => clock,
  };
});

const run = (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
};
const log = async (text: string, day: string) => {
  clock += 1000;
  return backend.createLogEntry(text, day);
};

interface Page {
  entries: { id: string; day: string; text: string; createdAt: string; localTime: string }[];
  more: boolean;
  nextCursor: string | null;
  totalMatches?: number;
  total?: number;
}

describe('search_log', () => {
  it('finds a substring case-insensitively, across days, with day, id, text and createdAt', async () => {
    const e = await log('Disk PASSWORD hunter2', '2026-09-01');
    await log('groceries', '2026-11-05');
    const out = (await run('search_log', { query: 'disk password' })) as Page;
    expect(out.totalMatches).toBe(1);
    expect(out.entries).toEqual([
      expect.objectContaining({
        id: e.id,
        day: '2026-09-01',
        text: 'Disk PASSWORD hunter2',
        createdAt: new Date(e.createdAt).toISOString(),
      }),
    ]);
    expect(((await run('search_log', { query: '  HUNTER2 ' })) as Page).entries).toHaveLength(1);
  });

  it('no match is an empty page, not an error', async () => {
    await log('groceries', '2026-11-05');
    expect(await run('search_log', { query: 'nothing like it' })).toMatchObject({
      entries: [],
      totalMatches: 0,
      more: false,
      nextCursor: null,
    });
  });

  it('from/to are inclusive and each optional', async () => {
    await log('note a', '2026-11-01');
    await log('note b', '2026-11-03');
    await log('note c', '2026-11-05');
    const days = async (args: Record<string, unknown>) =>
      ((await run('search_log', { query: 'note', ...args })) as Page).entries.map((e) => e.day);
    expect(await days({ from: '2026-11-01', to: '2026-11-03' })).toEqual([
      '2026-11-03',
      '2026-11-01',
    ]);
    expect(await days({ from: '2026-11-03' })).toEqual(['2026-11-05', '2026-11-03']);
    expect(await days({ to: '2026-11-01' })).toEqual(['2026-11-01']);
  });

  it('pages sparse matches newest first, every match once, and an entry added mid-way shifts nothing', async () => {
    const hits: string[] = [];
    for (let i = 0; i < 20; i++) {
      const e = await log(i % 4 === 0 ? `match ${i}` : `other ${i}`, `2026-10-${10 + (i % 7)}`);
      if (i % 4 === 0) hits.push(e.id);
    }
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const out = (await run('search_log', { query: 'MATCH', limit: 2, cursor })) as Page;
      expect(out.totalMatches).toBeGreaterThanOrEqual(5);
      seen.push(...out.entries.map((e) => e.id));
      cursor = out.nextCursor;
      if (pages++ === 0) await log('match late', '2026-10-30'); // newer than every page: never shows
    } while (cursor);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...hits].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses bad arguments with a param error, dispatching nothing', async () => {
    const bad = [
      {},
      { query: '   ' },
      { query: 'x'.repeat(201) },
      { query: 'a', from: '2026-11-05', to: '2026-11-01' },
      { query: 'a', from: '2026-13-01' },
      { query: 'a', limit: 0 },
      { query: 'a', limit: 101 },
      { query: 'a', limit: 2.5 },
      { query: 'a', cursor: 'not-a-cursor' },
    ];
    for (const args of bad) await expect(run('search_log', args)).rejects.toThrow(RpcParamError);
    expect(dispatched).toEqual([]);
  });

  it("never returns another user's entries", async () => {
    await backendFor('someone-else').createLogEntry('shared secret', '2026-11-05');
    await log('shared secret', '2026-11-05');
    const out = (await run('search_log', { query: 'secret' })) as Page;
    expect(out.entries).toHaveLength(1);
    expect(out.totalMatches).toBe(1);
  });
});

describe('list_log', () => {
  it('lists a range newest first with a total; from and to are required', async () => {
    const a = await log('one', '2026-11-01');
    const b = await log('two', '2026-11-02');
    await log('later', '2026-11-09');
    const out = (await run('list_log', { from: '2026-11-01', to: '2026-11-05' })) as Page;
    expect(out.entries.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(out.total).toBe(2);
    await expect(run('list_log', { from: '2026-11-01' })).rejects.toThrow(RpcParamError);
    await expect(run('list_log', { to: '2026-11-01' })).rejects.toThrow(RpcParamError);
  });

  it('pages with limit and cursor', async () => {
    for (let i = 0; i < 5; i++) await log(`e${i}`, '2026-11-02');
    const p1 = (await run('list_log', { from: '2026-11-01', to: '2026-11-02', limit: 3 })) as Page;
    expect(p1.entries.map((e) => e.text)).toEqual(['e4', 'e3', 'e2']);
    expect(p1.more).toBe(true);
    const p2 = (await run('list_log', {
      from: '2026-11-01',
      to: '2026-11-02',
      limit: 3,
      cursor: p1.nextCursor,
    })) as Page;
    expect(p2.entries.map((e) => e.text)).toEqual(['e1', 'e0']);
    expect(p2).toMatchObject({ more: false, nextCursor: null });
  });
});

describe('the log tools only read', () => {
  it('search_log, list_log and get_day leave the table as it was', async () => {
    await log('note', '2026-11-05');
    // A due series and a stale plan: getDay would spawn and sweep — get_day must do neither.
    await backend.upsertSeries({
      title: 'Daily',
      categoryId: null,
      defaultEstimateMin: 10,
      rule: { kind: 'daily' },
      anchorDate: '2026-11-01',
    });
    const stale = await backend.createTask({ title: 'Left over', estimateMin: 15 });
    await backend.upsertPlan({ taskId: stale.id, day: '2026-11-04', plannedMinutes: 15, order: 1 });
    await backend.getSettings(); // a real user's settings row exists; the first read creates it
    const before = doc.snapshot();
    await run('search_log', { query: 'note' });
    await run('list_log', { from: '2026-11-01', to: '2026-11-05' });
    await run('get_day', { day: '2026-11-05' });
    await run('get_day', { day: '2026-11-06' });
    expect(doc.snapshot()).toEqual(before);
    expect(dispatched).not.toContain('getDay');
    // The fixture is live: the app's getDay does write here (spawns the series, sweeps the stale plan).
    await backend.getDay('2026-11-05');
    expect(doc.snapshot()).not.toEqual(before);
    expect((await backend.getTask(stale.id))?.status).toBe('backlog');
  });
});

interface DayOut {
  day: string;
  today: string;
  window: { start: string; end: string };
  dayPlan: { intent: string | null } | null;
  log: { count: number; entries: { id: string }[] };
  tasks: {
    done: {
      id: string;
      estimateLockedMin: number | null;
      actualMin: number;
      deltaMin: number | null;
      isCalibrationPoint: boolean;
    }[];
    planned: { id: string; byTime: boolean; plannedMinutes: number | null }[];
    stillOpen: { id: string }[];
    due: { id: string }[];
  };
  calendar: { reason?: string; window?: unknown };
  flux: { sets: unknown[]; daySummary: string };
  leetcode: unknown[];
}

describe('get_day', () => {
  const finishAt = async (title: string, when: number) => {
    const t = await backend.createTask({ title, estimateMin: 30, bufferMin: 0 });
    await backend.transitionTask(t.id, 'in_progress');
    await backend.setTaskActual(t.id, 40);
    const saved = clock;
    clock = when;
    await backend.transitionTask(t.id, 'done');
    clock = saved;
    return t;
  };

  it('composes the day: plan, log, done with estimate vs actual, planned, due, calendar, flux, leetcode', async () => {
    await backend.getDay('2026-11-05');
    await backend.setDayIntent('2026-11-05', 'ship logs');
    const e = await log('shipped', '2026-11-05');
    await log('other day', '2026-11-04');
    const done = await finishAt('Write tools', at('2026-11-05', '11:00'));
    const open = await backend.createTask({ title: 'Plan it', estimateMin: 20, bufferMin: 0 });
    await backend.upsertPlan({ taskId: open.id, day: '2026-11-05', plannedMinutes: 25, order: 1 });
    const due = await backend.createTask({ title: 'Due one', dueDay: '2026-11-05' });

    const out = (await run('get_day', { day: '2026-11-05' })) as DayOut;
    expect(out.today).toBe('2026-11-05');
    expect(out.window).toEqual({
      start: new Date(at('2026-11-05', '04:00')).toISOString(),
      end: new Date(at('2026-11-06', '04:00')).toISOString(),
    });
    expect(out.dayPlan?.intent).toBe('ship logs');
    expect(out.log.entries.map((x) => x.id)).toEqual([e.id]);
    expect(out.tasks.done).toEqual([
      expect.objectContaining({
        id: done.id,
        estimateLockedMin: 30,
        actualMin: 40,
        deltaMin: 10,
        isCalibrationPoint: true,
      }),
    ]);
    expect(out.tasks.planned).toEqual([
      expect.objectContaining({ id: open.id, byTime: false, plannedMinutes: 25 }),
    ]);
    expect(out.tasks.stillOpen.map((t) => t.id)).toEqual([open.id]);
    expect(out.tasks.due.map((t) => t.id)).toEqual([due.id]);
    expect(out.calendar.reason).toMatch(/No calendars/);
    expect(out.flux).toEqual({ sets: [], daySummary: 'No sets.' });
    expect(out.leetcode).toEqual([]);
  });

  it('a backfilled ticket is listed with no delta and never reads as a calibration point', async () => {
    const scored = await finishAt('Scored', at('2026-11-05', '10:00'));
    const old = await finishAt('Old ticket', at('2026-11-05', '11:00'));
    await backend.setTaskBackfilled(old.id, true);
    const out = (await run('get_day', { day: '2026-11-05' })) as DayOut;
    const row = (id: string) => out.tasks.done.find((t) => t.id === id);
    expect(row(old.id)).toMatchObject({
      actualMin: 40,
      isCalibrationPoint: false,
      deltaMin: null,
      backfilled: true,
    });
    expect(row(scored.id)).toMatchObject({
      isCalibrationPoint: true,
      deltaMin: 10,
      backfilled: false,
    });
  });

  it('the mark is read off the row’s own task, so a lagging points read never scores a backfilled ticket', async () => {
    const old = await finishAt('Old ticket', at('2026-11-05', '11:00'));
    await backend.setTaskBackfilled(old.id, true);
    const live = ctx.dispatch;
    ctx.dispatch = async (method, args) => {
      const got = await live(method, args);
      if (method !== 'getCalibration') return got;
      // the points as a read from before the mark would return them
      return (got as { backfilled: boolean }[]).map((p) => ({ ...p, backfilled: false }));
    };
    const out = (await run('get_day', { day: '2026-11-05' })) as DayOut;
    expect(out.tasks.done.find((t) => t.id === old.id)).toMatchObject({
      isCalibrationPoint: false,
      deltaMin: null,
      backfilled: true,
    });
  });

  it('buckets a finish before the day start into the previous day', async () => {
    const late = await finishAt('Late', at('2026-11-06', '03:59'));
    const early = await finishAt('Early', at('2026-11-06', '04:00'));
    clock = at('2026-11-06', '12:00');
    const d5 = (await run('get_day', { day: '2026-11-05' })) as DayOut;
    const d6 = (await run('get_day', { day: '2026-11-06' })) as DayOut;
    expect(d5.tasks.done.map((t) => t.id)).toEqual([late.id]);
    expect(d6.tasks.done.map((t) => t.id)).toEqual([early.id]);
  });

  it('places a timed task by its deadline instant: 00:30 on the 6th is still the 5th', async () => {
    const t = await backend.createTask({
      title: 'Midnight',
      dueDay: '2026-11-06',
      dueTime: '00:30',
    });
    const d5 = (await run('get_day', { day: '2026-11-05' })) as DayOut;
    expect(d5.tasks.planned).toEqual([expect.objectContaining({ id: t.id, byTime: true })]);
  });

  it('a series deadline occurrence (recurring D8): its work day by plan row; its due day by time unless rowed', async () => {
    await backend.upsertSeries({
      title: 'Pre-lab',
      categoryId: null,
      defaultEstimateMin: 45,
      rule: { kind: 'weekly', daysOfWeek: [4] }, // 2026-11-05 is a Thursday
      anchorDate: '2026-11-05',
      dueOffsetDays: 1,
      dueTime: '14:00',
    });
    await backend.getDay('2026-11-05');
    const [occ] = (await backend.listTasks()).filter((t) => t.seriesId);
    const d5 = (await run('get_day', { day: '2026-11-05' })) as DayOut;
    expect(d5.tasks.planned).toEqual([
      expect.objectContaining({ id: occ!.id, byTime: false, plannedMinutes: 45 }),
    ]);
    const d6 = (await run('get_day', { day: '2026-11-06' })) as DayOut;
    expect(d6.tasks.planned).toEqual([
      expect.objectContaining({ id: occ!.id, byTime: true, plannedMinutes: null }),
    ]);
    await backend.upsertPlan({ taskId: occ!.id, day: '2026-11-06', plannedMinutes: 30, order: 1 });
    const rowed = (await run('get_day', { day: '2026-11-06' })) as DayOut;
    expect(rowed.tasks.planned).toEqual([
      expect.objectContaining({ id: occ!.id, byTime: false, plannedMinutes: 30 }),
    ]);
  });

  it('a day the app never opened, or a future one, has dayPlan null and no error', async () => {
    const out = (await run('get_day', { day: '2026-11-08' })) as DayOut;
    expect(out.dayPlan).toBeNull();
    expect(out.log.count).toBe(0);
  });

  it('refuses a bad day with a param error', async () => {
    await expect(run('get_day', {})).rejects.toThrow(RpcParamError);
    await expect(run('get_day', { day: '2026-11-5' })).rejects.toThrow(RpcParamError);
  });
});

// docs/areas/log: a private entry's text never leaves through MCP.
describe('private log entries', () => {
  const secret = async (text: string, day: string) => {
    const e = await log(text, day);
    return backend.setLogEntryPrivate(e.id, true);
  };

  it('list_log and get_day read a private entry as 🔒 private entry, keeping its id, day and time', async () => {
    const p = await secret('disk password hunter2', '2026-11-05');
    const pub = await log('groceries', '2026-11-05');
    const listed = (await run('list_log', { from: '2026-11-05', to: '2026-11-05' })) as Page;
    expect(listed.total).toBe(2);
    expect(listed.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: p.id,
          day: '2026-11-05',
          text: '🔒 private entry',
          private: true,
          createdAt: new Date(p.createdAt).toISOString(),
        }),
        expect.objectContaining({ id: pub.id, text: 'groceries', private: false }),
      ]),
    );
    const day = (await run('get_day', { day: '2026-11-05' })) as {
      log: { count: number; entries: { id: string; text: string; localTime: string }[] };
    };
    expect(day.log.count).toBe(2);
    const row = day.log.entries.find((x) => x.id === p.id);
    expect(row).toMatchObject({ text: '🔒 private entry' });
    expect(row?.localTime).toMatch(/^\d\d:\d\d$/);
    expect(JSON.stringify([listed, day])).not.toContain('hunter2');
  });

  it('search_log never matches a private entry, even on an exact word or the mask itself', async () => {
    await secret('disk password hunter2', '2026-11-05');
    const pub = await log('hunter2 is also a meme', '2026-11-05');
    const hit = (await run('search_log', { query: 'hunter2' })) as Page;
    expect(hit.totalMatches).toBe(1);
    expect(hit.entries.map((e) => e.id)).toEqual([pub.id]);
    expect(((await run('search_log', { query: 'disk password' })) as Page).totalMatches).toBe(0);
    expect(((await run('search_log', { query: 'private entry' })) as Page).totalMatches).toBe(0);
  });

  it('unlocked in the app, the text reads and matches again', async () => {
    const p = await secret('disk password hunter2', '2026-11-05');
    await backend.setLogEntryPrivate(p.id, false);
    const hit = (await run('search_log', { query: 'hunter2' })) as Page;
    expect(hit.entries).toEqual([
      expect.objectContaining({ id: p.id, text: 'disk password hunter2' }),
    ]);
  });

  it('no MCP tool can set or clear the flag', () => {
    const touches = TOOLS.filter((t) => /private/i.test(JSON.stringify(t.inputSchema)));
    expect(touches.map((t) => t.name)).toEqual([]);
  });
});
