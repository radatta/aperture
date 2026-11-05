import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiMethod, Task, TaskSeries } from '@aperture/shared';
import { InMemoryDoc } from '../ddb/DocClient';
import { Repo } from '../ddb/repo';
import { liveWrites } from '../ddb/writes';
import { BackendClient } from '../backend';
import { handleRpc } from '../handler';
import { TOOLS } from './tools';
import { RpcParamError } from './types';
import type { ToolContext } from './types';

// Series over MCP (recurring.md D5): list / create / stop through the real handleRpc path. The clock starts
// at 2023-11-14 14:13 in America/Los_Angeles, so the user's today is 2023-11-14 (a Tuesday); a case that
// reads the next day moves it first (getDay refuses a day after the user's today).
const U = 'local';
const START = 1_700_000_000_000;
let clock = START;
const now = () => clock;
const TODAY = '2023-11-14';
const DAY_MS = 86_400_000;
let doc: InMemoryDoc;
let setup: BackendClient;
let ctx: ToolContext;

beforeEach(() => {
  clock = START;
  doc = new InMemoryDoc();
  setup = new BackendClient(new Repo(doc, liveWrites(doc), U), { userId: U, now });
  ctx = {
    dispatch: (method: ApiMethod, args: unknown[]) =>
      handleRpc(doc, { userId: U, method, args, now }),
    upload: async () => {},
    now,
  };
});
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
};
const prelab = {
  title: 'Pre-lab',
  rule: { kind: 'weekly', daysOfWeek: [2] },
  defaultEstimateMin: 60,
  dueOffsetDays: 1,
  until: '2023-12-05',
};

describe('create_series / list_series', () => {
  it('creates from the user’s today; the app’s next day load spawns the dated occurrence', async () => {
    const s = (await call('create_series', prelab)) as TaskSeries;
    expect(s).toMatchObject({
      title: 'Pre-lab',
      rule: { kind: 'weekly', daysOfWeek: [2] },
      defaultEstimateMin: 60,
      dueOffsetDays: 1,
      until: '2023-12-05',
      anchorDate: TODAY,
      categoryId: null,
      active: true,
    });
    expect(((await call('list_series')) as TaskSeries[]).map((x) => x.id)).toEqual([s.id]);
    await setup.getDay(TODAY);
    const [occurrence] = (await setup.listTasks()).filter((t) => t.seriesId === s.id);
    expect(occurrence).toMatchObject({
      status: 'planned',
      seriesDay: TODAY,
      dueDay: '2023-11-15',
      dueTime: null,
      estimateMin: 60,
    });
  });

  it('omitted cadence fields are none; the title is trimmed; weekly days are deduped and sorted', async () => {
    const s = (await call('create_series', {
      title: '  Standup ',
      rule: { kind: 'weekly', daysOfWeek: [4, 2, 2] },
    })) as TaskSeries;
    expect(s).toMatchObject({
      title: 'Standup',
      rule: { kind: 'weekly', daysOfWeek: [2, 4] },
      dueOffsetDays: null,
      until: null,
      defaultEstimateMin: null,
    });
  });

  it('refuses before any write: until before today, a negative offset, a bad rule, a blank title', async () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ ...prelab, until: '2023-11-13' }, /before today \(2023-11-14\)/],
      [{ ...prelab, until: '2023-2-5' }, /"until" must be an ISO date/],
      [{ ...prelab, dueOffsetDays: -1 }, /"dueOffsetDays" must be an integer >= 0/],
      [{ ...prelab, dueOffsetDays: 1.5 }, /"dueOffsetDays"/],
      [{ ...prelab, rule: { kind: 'weekly', daysOfWeek: [] } }, /daysOfWeek/],
      [{ ...prelab, rule: { kind: 'weekly', daysOfWeek: [7] } }, /daysOfWeek/],
      [{ ...prelab, rule: { kind: 'everyN', interval: 0 } }, /interval/],
      [{ ...prelab, rule: { kind: 'monthly' } }, /rule.kind/],
      [{ ...prelab, rule: 'daily' }, /"rule" is required/],
      [{ ...prelab, title: '  ' }, /"title" is required/],
      [{ ...prelab, defaultEstimateMin: -5 }, /defaultEstimateMin/],
    ];
    for (const [args, re] of bad) {
      await expect(call('create_series', args)).rejects.toThrow(re);
      await expect(call('create_series', args)).rejects.toBeInstanceOf(RpcParamError);
    }
    expect(await setup.listSeries()).toHaveLength(0);
    expect(await setup.listTasks()).toHaveLength(0);
  });

  it('until today itself is allowed (it recurs once more)', async () => {
    const s = (await call('create_series', { ...prelab, until: TODAY })) as TaskSeries;
    expect(s.until).toBe(TODAY);
  });
});

describe('stop_series', () => {
  it('deactivates: nothing spawns after, the occurrences stay, list_series omits it unless asked', async () => {
    const s = (await call('create_series', { ...prelab, rule: { kind: 'daily' } })) as TaskSeries;
    await setup.getDay(TODAY);
    const stopped = (await call('stop_series', { id: s.id })) as TaskSeries;
    expect(stopped.active).toBe(false);
    expect(await call('list_series')).toEqual([]);
    expect(((await call('list_series', { includeStopped: true })) as TaskSeries[])[0]?.id).toBe(
      s.id,
    );
    clock += DAY_MS;
    await setup.getDay('2023-11-15');
    const mine = (await setup.listTasks()).filter((t: Task) => t.seriesId === s.id);
    expect(mine.map((t) => t.seriesDay)).toEqual([TODAY]);
  });

  it('an unknown id, or another user’s, is not found; nothing changes', async () => {
    const other = new BackendClient(new Repo(doc, liveWrites(doc), 'someone-else'), {
      userId: 'someone-else',
      now,
    });
    const theirs = await other.upsertSeries({
      title: 'Theirs',
      categoryId: null,
      defaultEstimateMin: null,
      rule: { kind: 'daily' },
      anchorDate: TODAY,
    });
    await expect(call('stop_series', { id: theirs.id })).rejects.toThrow(/Not found/);
    await expect(call('stop_series', { id: 'nope' })).rejects.toThrow(/Not found/);
    await expect(call('stop_series', {})).rejects.toBeInstanceOf(RpcParamError);
    expect((await other.listSeries())[0]?.active).toBe(true);
  });
});
