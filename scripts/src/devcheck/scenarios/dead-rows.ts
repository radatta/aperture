// Dev's tombstones (TECH §2.3): the delete paths still work with each list read once, and a stamped tombstone's
// `expiresAt` never reaches an answer. The test user sees no raw row, so the stamp itself is a named test plus
// Rahul's query, and TTL's real deletes are measured from the Mac after the merge enables it.
import type { DevFluxSetInput, DevTask } from '../api';
import { datesFor, noConsoleErrors, type Row, type Scenario } from '../scenario';
import { devUlid } from './flux-history';

const WRITES = 'lambdas/src/ddb/writes.test.ts';
const WHY_RAW = 'the test user’s API returns no tombstone, so dev can’t show the raw row';
const offDev = (id: string, what: string, test: string, why = WHY_RAW): Row => ({
  id,
  entry: 'api',
  kind: 'edge',
  what,
  offDev: { file: WRITES, test, why },
});

const made: Record<string, DevTask> = {};
const hasExpiry = (row: object) => 'expiresAt' in row;

export const deadRows: Scenario = {
  id: 'dead-rows',
  title: 'Dev’s tombstones: delete paths, and expiresAt stays out of answers',
  tiers: ['full'],
  rows: [
    {
      id: 'delete-leaf',
      entry: 'api',
      kind: 'nominal',
      what: 'Deleting a planned task drops it and its plan; a neighbour stays; a repeat is a no-op',
    },
    {
      id: 'delete-parent',
      entry: 'api',
      kind: 'nominal',
      what: 'Deleting a parent drops every part and a part’s plan through the one list',
    },
    {
      id: 'flux-retry',
      entry: 'api',
      kind: 'edge',
      what: 'A retried deleted Flux set gets its stored row back, still deleted, with no expiresAt',
    },
    {
      id: 'stamp-live',
      entry: 'api',
      kind: 'nominal',
      what: 'A real tombstone on dev’s table carries expiresAt',
      needsYou: 'raw rows are behind AWS: the query in the report and PR body',
    },
    offDev(
      'stamp-kinds',
      'Tombstones expire at once, flux after a week, finance never',
      'a tombstone expires at once, in epoch seconds',
    ),
    offDev(
      'stamp-prod',
      'Prod and a stage-less Lambda write items unchanged',
      'prod writes the item unchanged, as does a Lambda with no stage',
      'dev is the only stage this run reaches',
    ),
    offDev(
      'expired-reorder',
      'A reorder of a plan whose tombstone expired answers Not found',
      'a reorder of a plan whose tombstone has expired answers Not found',
      'TTL’s timing can’t be forced on dev',
    ),
    offDev(
      'reads-once',
      'A delete reads the task and plan lists once each, consistently',
      'a parent with parts: still one of each, and every part and plan goes',
      'the wire shows one RPC, never the table reads behind it',
    ),
  ],
  steps: [
    {
      id: 'setup',
      title:
        'A planned task with a neighbour, and a parent with two parts, one planned (API, ledgered)',
      entry: 'api',
      async run(ctx) {
        const title = (what: string) => `devcheck-dead ${ctx.nonce} ${what}`;
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const { today } = datesFor(new Date(Date.now() - dayStartHour * 3_600_000));
        const create = ctx.api.writes.createTask;
        made.leaf = await create({ title: title('leaf') });
        made.neighbour = await create({ title: title('neighbour') });
        made.parent = await create({ title: title('parent') });
        made.one = await create({ title: title('one'), parentId: made.parent.id });
        made.two = await create({ title: title('two'), parentId: made.parent.id });
        for (const [order, t] of [made.leaf, made.one].entries())
          await ctx.api.writes.upsertPlan({ taskId: t.id, day: today, plannedMinutes: 15, order });
      },
    },
    {
      id: 'delete-leaf',
      title: 'deleteTask on the leaf: it and its plan go, the neighbour stays, a repeat is a no-op',
      entry: 'api',
      proves: ['delete-leaf'],
      async run(ctx) {
        const { leaf, neighbour } = made;
        if (!leaf || !neighbour) throw new Error('setup made no tasks');
        await ctx.api.writes.deleteTask(leaf.id);
        const live = (await ctx.api.reads.listTasks()).map((t) => t.id);
        if (live.includes(leaf.id)) throw new Error('the deleted task is still listed');
        if (!live.includes(neighbour.id)) throw new Error('the neighbour went too');
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const { today } = datesFor(new Date(Date.now() - dayStartHour * 3_600_000));
        const plans = await ctx.api.reads.listPlansForDay(today);
        if (plans.some((p) => p.taskId === leaf.id)) throw new Error('its plan is still listed');
        await ctx.api.writes.deleteTask(leaf.id); // idempotent: throws on a non-2xx
      },
    },
    {
      id: 'delete-parent',
      title: 'deleteTask on the parent: both parts and the part’s plan go',
      entry: 'api',
      proves: ['delete-parent'],
      async run(ctx) {
        const { parent, one, two } = made;
        if (!parent || !one || !two) throw new Error('setup made no parent');
        await ctx.api.writes.deleteTask(parent.id);
        const live = new Set((await ctx.api.reads.listTasks()).map((t) => t.id));
        for (const t of [parent, one, two])
          if (live.has(t.id)) throw new Error(`${t.title} is still listed`);
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const { today } = datesFor(new Date(Date.now() - dayStartHour * 3_600_000));
        const plans = await ctx.api.reads.listPlansForDay(today);
        if (plans.some((p) => p.taskId === one.id))
          throw new Error('the part’s plan is still listed');
      },
    },
    {
      id: 'flux-retry',
      title:
        'recordFluxSet again after a delete: the stored row, deleted, no expiresAt, nothing listed',
      entry: 'api',
      proves: ['flux-retry'],
      async run(ctx) {
        const { dayStartHour } = await ctx.api.reads.getSettings();
        const now = Date.now();
        const input: DevFluxSetInput = {
          id: devUlid(now),
          day: datesFor(new Date(now - dayStartHour * 3_600_000)).today,
          exerciseId: 'chin-tuck',
          kind: 'holdAtTarget',
          side: null,
          condition: null,
          count: 6,
          avgPeakDeg: null,
          avgErrorDeg: null,
          rom: { pitch: 9, yaw: 2, roll: 2 },
          calibrated: true,
          delegate: 'CPU',
          durationSec: 150,
          completedAt: now,
          repTaskId: null,
          stoppedEarly: false,
          planned: 6,
        };
        await ctx.api.writes.recordFluxSet(input);
        await ctx.api.writes.deleteFluxSet(input.id);
        const retried = await ctx.api.writes.recordFluxSet(input);
        // The harness's type leaves deletedAt out: reads never carry a live one.
        if ((retried as { deletedAt?: number | null }).deletedAt == null)
          throw new Error('the retry brought the set back to life');
        if (hasExpiry(retried)) throw new Error('expiresAt reached the answer');
        if ((await ctx.api.reads.listFluxSets()).some((f) => f.id === input.id))
          throw new Error('the deleted set is listed after the retry');
      },
    },
    noConsoleErrors,
  ],
};
