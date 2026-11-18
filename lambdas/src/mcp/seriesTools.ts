import {
  USER_TIME_ZONE,
  beforeDayStart,
  dayKeyInZone,
  isDayKey,
  isTimeKey,
} from '@aperture/shared';
import type { RecurrenceRule, Settings, TaskSeries, UpsertSeriesInput } from '@aperture/shared';
import { RpcParamError } from './types';
import type { Tool } from './types';

// Recurring series — the templates (docs/areas/tasks/recurring.md). Each occurrence is a real task spawned
// when its day loads in the app (getDay), so list_tasks shows occurrences, these show what recurs. Voice:
// "weekly report every Tuesday, due Wednesday, until Nov 30" → create_series. The cadence and the end are checked
// here, before any write, so a mistake is a param error that lands nothing.

const RULE_DESC =
  'the recurrence: {kind:"daily"} · {kind:"weekdays"} (Mon–Fri) · {kind:"weekly", daysOfWeek:[0–6]} (0 = Sunday … 6 = Saturday; "every Tue and Thu" is [2,4]) · {kind:"everyN", interval:N} (every N days from today)';

function ruleArg(args: Record<string, unknown>): RecurrenceRule {
  const r = args.rule;
  if (!r || typeof r !== 'object')
    throw new RpcParamError('"rule" is required: an object with kind');
  const { kind, daysOfWeek, interval } = r as Record<string, unknown>;
  switch (kind) {
    case 'daily':
    case 'weekdays':
      return { kind };
    case 'weekly': {
      if (
        !Array.isArray(daysOfWeek) ||
        daysOfWeek.length === 0 ||
        !daysOfWeek.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
      )
        throw new RpcParamError('"rule.daysOfWeek" must be a non-empty list of 0–6 (0 = Sunday)');
      return { kind, daysOfWeek: [...new Set(daysOfWeek as number[])].sort((a, b) => a - b) };
    }
    case 'everyN':
      if (!Number.isInteger(interval) || (interval as number) < 1)
        throw new RpcParamError('"rule.interval" must be an integer >= 1');
      return { kind, interval: interval as number };
    default:
      throw new RpcParamError('"rule.kind" must be daily, weekdays, weekly or everyN');
  }
}

// Optional integer ≥ 0, null/omitted → null.
function offsetArg(args: Record<string, unknown>): number | null {
  const v = args.dueOffsetDays;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
    throw new RpcParamError('"dueOffsetDays" must be an integer >= 0 (0 = due the day it recurs)');
  return v;
}

// Optional "HH:MM", null/omitted → null; only with a due offset (recurring.md D8).
function timeArg(args: Record<string, unknown>, dueOffsetDays: number | null): string | null {
  const v = args.dueTime;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !isTimeKey(v))
    throw new RpcParamError('"dueTime" must be a 24h clock time HH:MM (e.g. "14:00")');
  if (dueOffsetDays === null)
    throw new RpcParamError('"dueTime" needs "dueOffsetDays" — a time is on a due day');
  return v;
}

export const SERIES_TOOLS: Tool[] = [
  {
    name: 'list_series',
    description:
      "The user's recurring series (id, title, rule, categoryId, defaultEstimateMin, dueOffsetDays, dueTime, until, active, anchorDate) — the templates, not the tasks they spawn (those are list_tasks rows with seriesId). Active ones unless includeStopped. An until in the past means it has run out but wasn't stopped.",
    inputSchema: {
      type: 'object',
      properties: { includeStopped: { type: 'boolean' } },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const all = (await ctx.dispatch('listSeries', [])) as TaskSeries[];
      return args.includeStopped === true ? all : all.filter((s) => s.active);
    },
  },
  {
    name: 'create_series',
    description:
      'Create a recurring series. Each time the rule hits, the app spawns a planned task for that day (its own estimate and actual, so its own calibration point). dueOffsetDays is the cadence: the spawned task\'s due date is that many days after its day (0 = the same day, 1 = the next day; omit for no due date). dueTime (HH:MM, 24h) makes the deadline timed and needs dueOffsetDays: with an offset of 1 or more the task is still planned on its day and the time is its deadline ("pre-lab every Tuesday, due Wednesday 2pm" = weekly Tue, dueOffsetDays 1, dueTime "14:00"); with 0 it is a plain timed task, on that day by its time and never planned (a time before the user\'s day start is refused there). Each timed occurrence gets a calendar event like any timed task, when calendar sync is on. until is the last day it recurs (ISO date YYYY-MM-DD, inclusive; omit for open-ended) — a course series ends with the term. A course is its category: categoryId from list_categories. defaultEstimateMin is minutes. Counts from the user\'s today. The spawned task appears when the user next opens the app on that day — not at create time: list_tasks right after create_series shows none, and that is normal; never create the occurrence by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        rule: {
          type: 'object',
          description: RULE_DESC,
          properties: {
            kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'everyN'] },
            daysOfWeek: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
            interval: { type: 'integer', minimum: 1 },
          },
          required: ['kind'],
        },
        categoryId: { type: 'string', description: 'category id from list_categories, or omit' },
        defaultEstimateMin: { type: 'integer', minimum: 0 },
        dueOffsetDays: {
          type: 'integer',
          minimum: 0,
          description: 'days after each occurrence’s day it is due; omit for none',
        },
        dueTime: {
          type: 'string',
          description:
            'deadline clock HH:MM (24h) on the due day; needs dueOffsetDays; omit for untimed',
        },
        until: {
          type: 'string',
          description: 'last day it recurs, YYYY-MM-DD; omit for open-ended',
        },
      },
      required: ['title', 'rule'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) throw new RpcParamError('"title" is required');
      const rule = ruleArg(args);
      const dueOffsetDays = offsetArg(args);
      const dueTime = timeArg(args, dueOffsetDays);
      const categoryId = args.categoryId ?? null;
      if (categoryId !== null && typeof categoryId !== 'string')
        throw new RpcParamError('"categoryId" must be a string or omitted');
      const est = args.defaultEstimateMin ?? null;
      if (est !== null && (typeof est !== 'number' || !Number.isInteger(est) || est < 0))
        throw new RpcParamError('"defaultEstimateMin" must be an integer >= 0');
      const until = args.until ?? null;
      if (until !== null && (typeof until !== 'string' || !isDayKey(until)))
        throw new RpcParamError('"until" must be an ISO date (YYYY-MM-DD)');
      // Today in the user's zone and day boundary — the anchor the rule counts from; an until before it
      // could never spawn, so it's a mistake, not a series.
      const settings = (await ctx.dispatch('getSettings', [])) as Settings;
      const today = dayKeyInZone((ctx.now ?? Date.now)(), USER_TIME_ZONE, settings.dayStartHour);
      if (until !== null && until < today)
        throw new RpcParamError(
          `"until" ${until} is before today (${today}) — nothing would recur`,
        );
      if (dueOffsetDays === 0 && dueTime !== null && beforeDayStart(dueTime, settings.dayStartHour))
        throw new RpcParamError(
          `"dueTime" ${dueTime} the same day is before the day start (${settings.dayStartHour}:00) — it would spawn past due; use dueOffsetDays 1`,
        );
      const input: UpsertSeriesInput = {
        title,
        categoryId,
        defaultEstimateMin: est,
        rule,
        anchorDate: today,
        dueOffsetDays,
        dueTime,
        until,
      };
      return ctx.dispatch('upsertSeries', [input]);
    },
  },
  {
    name: 'stop_series',
    description:
      'Stop a recurring series (id from list_series): nothing spawns from now on; the tasks it already spawned stay as they are. Not a delete — the row is kept, inactive.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      if (typeof args.id !== 'string' || !args.id) throw new RpcParamError('"id" is required');
      return ctx.dispatch('deactivateSeries', [args.id]);
    },
  },
];
