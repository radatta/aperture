import {
  addDays,
  isTimed,
  isUlid,
  computeDayShape,
  dayKeyInZone,
  isDayKey,
  userDueEpoch,
  USER_TIME_ZONE,
  zonedDayTime,
  zonedEpoch,
} from '@aperture/shared';
import type {
  CalendarBusy,
  CalibrationPoint,
  Day,
  FluxSet,
  LogEntry,
  Settings,
  Sitting,
  Task,
  TaskPlan,
} from '@aperture/shared';
import { summarizeSets } from '@aperture/shared/flux';
import { setRow } from './fluxTools';
import { RpcParamError } from './types';
import type { Tool, ToolContext } from './types';

// Read-only Log tools (docs/areas/mcp → Tools): search the whole log, list a range, and one day as data —
// the Log page and "Today in review" in one call. Nothing here writes: get_day reads the stored day row
// (peekDay), never getDay, whose read spawns recurrences and sweeps stale plans.

const QUERY_MAX = 200;
const SEARCH_LIMIT = { def: 50, max: 100 };
const LIST_LIMIT = { def: 100, max: 200 };
// A cursor is the SK without `log#`: "<day>#<ULID>". A ULID sorts by time within a day, so this orders entries.
const isCursor = (v: string) => {
  const [day, id, ...rest] = v.split('#');
  return rest.length === 0 && !!day && !!id && isDayKey(day) && isUlid(id);
};

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const hhmm = (ms: number) => zonedDayTime(ms, USER_TIME_ZONE).hhmm;
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;

// THE choke point for log text leaving through MCP — every tool maps entries through here, so a
// redaction (a private flag) has one place to live. It MASKS the text, never drops the entry: list_log's
// total and get_day's count include private entries. Search is the exception — see logEntryMatches.
// A private entry (docs/areas/log) keeps its id, day and times; its text never leaves.
export const PRIVATE_TEXT = '🔒 private entry';
export function toMcpLogEntry(e: LogEntry) {
  const isPrivate = e.private === true;
  return {
    id: e.id,
    day: e.day,
    text: isPrivate ? PRIVATE_TEXT : e.text,
    private: isPrivate,
    createdAt: iso(e.createdAt),
    localTime: hhmm(e.createdAt), // the time the night card shows
    updatedAt: iso(e.updatedAt),
  };
}

// THE one place search matches: a contiguous, case-insensitive substring of the text. `needle` is
// already lowercased. A private entry never matches — not even as a masked hit, which would still confirm
// what the query found in its text.
export const logEntryMatches = (e: LogEntry, needle: string): boolean =>
  e.private !== true && e.text.toLowerCase().includes(needle);

const cursorOf = (e: LogEntry) => `${e.day}#${e.id}`;

// Newest first, then a page after `cursor` (the last entry the previous page returned). Paging is over the
// fully read, totally ordered list, so a sparse filter never yields a short page by accident.
function page(entries: LogEntry[], limit: number, cursor: string | undefined) {
  const desc = [...entries].sort((a, b) => (cursorOf(a) < cursorOf(b) ? 1 : -1));
  const after = cursor === undefined ? desc : desc.filter((e) => cursorOf(e) < cursor);
  const shown = after.slice(0, limit);
  const more = after.length > shown.length;
  return {
    entries: shown.map(toMcpLogEntry),
    more,
    nextCursor: more ? cursorOf(shown[shown.length - 1]!) : null,
  };
}

// --- arg guards (typeof → RpcParamError, -32602, before any dispatch) ---
function optDay(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !isDayKey(v))
    throw new RpcParamError(`"${key}" must be an ISO date (YYYY-MM-DD)`);
  return v;
}
function reqDay(args: Record<string, unknown>, key: string): string {
  const v = optDay(args, key);
  if (v === undefined) throw new RpcParamError(`"${key}" is required (YYYY-MM-DD)`);
  return v;
}
function range(from: string | undefined, to: string | undefined) {
  if (from !== undefined && to !== undefined && from > to)
    throw new RpcParamError('"from" must be on or before "to"');
  return { from, to };
}
function limitArg(args: Record<string, unknown>, l: { def: number; max: number }): number {
  const v = args.limit;
  if (v === undefined || v === null) return l.def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > l.max)
    throw new RpcParamError(`"limit" must be an integer from 1 to ${l.max}`);
  return v;
}
function cursorArg(args: Record<string, unknown>): string | undefined {
  const v = args.cursor;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !isCursor(v))
    throw new RpcParamError('"cursor" must be a nextCursor from a previous call, unchanged');
  return v;
}
function queryArg(args: Record<string, unknown>): string {
  const v = args.query;
  if (typeof v !== 'string' || v.trim() === '')
    throw new RpcParamError('"query" is required: the text to find');
  const q = v.trim();
  if (q.length > QUERY_MAX) throw new RpcParamError(`"query" is at most ${QUERY_MAX} characters`);
  return q;
}

const PAGING =
  'Newest first. When `more` is true, call again with `cursor` set to `nextCursor`, unchanged, to read the next page.';
const PRIVACY =
  "Entries are the user's own words and can hold secrets (a password they logged); quote only what the user asked for. An entry the user marked private reads '🔒 private entry' (private: true) with its day and time; its text is never available here, search never matches it, and no tool can unlock it — only the user, in the app.";

// --- get_day ---
const finished = (t: Task) => t.status === 'done' || t.status === 'cancelled';

function doneRow(t: Task, point: CalibrationPoint | undefined, parts: number) {
  return {
    id: t.id,
    title: t.title,
    label: parts > 0 ? `${t.title} · ${parts} part${parts === 1 ? '' : 's'}` : t.title,
    categoryId: t.categoryId,
    completedAt: iso(t.completedAt),
    estimateLockedMin: t.estimateLockedMin,
    estimateMin: t.estimateMin,
    estimateSource: t.estimateSource ?? null,
    actualMin: t.actualAccruedMin,
    // Only a calibration point has a delta: a done task with a frozen estimate (get_calibration's rule).
    isCalibrationPoint: point !== undefined,
    deltaMin: point ? point.actualAccruedMin - point.estimateLockedMin : null,
    parts,
    reflection: t.reflection ?? null,
  };
}

function sittingRow(s: Sitting) {
  return {
    id: s.id,
    problem: { title: s.problemTitle, slug: s.problemSlug, difficulty: s.difficulty },
    status: s.status,
    startedAt: iso(s.startedAt),
    endedAt: iso(s.endedAt),
    submits: s.summary.submits,
    accepted: s.summary.submitsBeforeAccepted !== null,
    reviewed: (s.review ?? null) !== null,
  };
}

async function composeDay(day: string, ctx: ToolContext) {
  const settings = (await ctx.dispatch('getSettings', [])) as Settings;
  const start = settings.dayStartHour;
  const today = dayKeyInZone((ctx.now ?? Date.now)(), USER_TIME_ZONE, start);
  const windowStartMs = zonedEpoch(day, hour(settings.dayFocusStart), USER_TIME_ZONE);
  const windowEndMs = zonedEpoch(day, hour(settings.dayEndHour), USER_TIME_ZONE);
  const hasCalendars = settings.calendarShapeRefs.length > 0;
  const [dayRow, log, tasks, points, plans, busy, flux, sittings] = (await Promise.all([
    ctx.dispatch('peekDay', [day]),
    ctx.dispatch('listLogEntries', [day]),
    ctx.dispatch('listTasks', []),
    ctx.dispatch('getCalibration', [{ from: day, to: day }]),
    ctx.dispatch('listPlansForDay', [day]),
    hasCalendars
      ? ctx.dispatch('getCalendarBusy', [{ day, windowStartMs, windowEndMs }])
      : Promise.resolve(null),
    ctx.dispatch('listFluxSets', [{ from: day, to: day }]),
    ctx.dispatch('listSittings', [{ from: day, to: day }]),
  ])) as [
    Day | null,
    LogEntry[],
    Task[],
    CalibrationPoint[],
    TaskPlan[],
    CalendarBusy | null,
    FluxSet[],
    Sitting[],
  ];

  const parentIds = new Set(tasks.map((t) => t.parentId).filter((id): id is string => !!id));
  const partsOf = (id: string) => tasks.filter((t) => t.parentId === id).length;
  const pointOf = new Map(points.map((p) => [p.taskId, p]));
  const appDay = (ms: number) => dayKeyInZone(ms, USER_TIME_ZONE, start);
  const doneOnDay = (t: Task) =>
    t.status === 'done' && t.completedAt !== null && appDay(t.completedAt) === day;
  // The server twin of the app's todayRows: a timed task is on the app day its deadline falls on, by
  // clock (a parent's deadline is a marker, never a row; one finished on another day is gone); an untimed
  // one is on the day by its plan row.
  const timedOnDay = (t: Task) =>
    !!t.dueDay &&
    !!t.dueTime &&
    !parentIds.has(t.id) &&
    appDay(userDueEpoch(t.dueDay, t.dueTime)) === day &&
    (!finished(t) || doneOnDay(t));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const plannedRow = (t: Task, plannedMinutes: number | null, byTime: boolean) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    byTime,
    plannedMinutes,
    dueDay: t.dueDay,
    dueTime: t.dueTime,
    estimateMin: t.estimateMin,
  });
  const planned = [
    ...tasks
      .filter(timedOnDay)
      .sort(
        (a, b) =>
          userDueEpoch(a.dueDay!, a.dueTime!) - userDueEpoch(b.dueDay!, b.dueTime!) ||
          a.createdAt - b.createdAt,
      )
      .map((t) => plannedRow(t, null, true)),
    ...plans.flatMap((p) => {
      const t = byId.get(p.taskId);
      return t && !isTimed(t) ? [plannedRow(t, p.plannedMinutes, false)] : [];
    }),
  ];

  return {
    day,
    today,
    // The app day this covers, in the user's zone from their day-start hour.
    window: {
      start: iso(zonedEpoch(day, hour(start), USER_TIME_ZONE)),
      end: iso(zonedEpoch(addDays(day, 1), hour(start), USER_TIME_ZONE)),
    },
    dayPlan: dayRow
      ? {
          intent: dayRow.intent,
          capacityHours: dayRow.capacityHours,
          reflectionPrompt: dayRow.reflectionPrompt,
          reflectionText: dayRow.reflectionText,
        }
      : null,
    log: { count: log.length, entries: log.map(toMcpLogEntry) }, // capture order, as the Log page lists
    tasks: {
      done: tasks
        .filter(doneOnDay)
        .sort((a, b) => (a.completedAt as number) - (b.completedAt as number))
        .map((t) => doneRow(t, pointOf.get(t.id), partsOf(t.id))),
      planned,
      stillOpen: planned.filter((r) => r.status !== 'done' && r.status !== 'cancelled'),
      due: tasks
        .filter((t) => t.dueDay === day && !parentIds.has(t.id))
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          dueTime: t.dueTime,
          estimateMin: t.estimateMin,
        })),
    },
    calendar: busy
      ? {
          window: { start: iso(windowStartMs), end: iso(windowEndMs) },
          shape: computeDayShape(busy, windowStartMs, windowEndMs),
          busy,
        }
      : { reason: 'No calendars are chosen for the day shape (Settings → Calendar).' },
    flux: {
      sets: flux.map(setRow),
      daySummary: flux.length > 0 ? summarizeSets(flux) : 'No sets.',
    },
    leetcode: sittings.map(sittingRow),
  };
}

export const LOG_TOOLS: Tool[] = [
  {
    name: 'search_log',
    description: `Search the user's Log (their one-line journal: notes, wins, things to remember) across every day. query is matched as a case-insensitive substring of the entry text — use a distinctive word or two, not a sentence. from/to (ISO dates, inclusive) narrow it; omit both to search everything. Returns day, id, text, createdAt and localTime per entry, plus totalMatches. ${PAGING} ${PRIVACY}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: `1–${QUERY_MAX} characters` },
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        limit: {
          type: 'integer',
          description: `1–${SEARCH_LIMIT.max}, default ${SEARCH_LIMIT.def}`,
        },
        cursor: { type: 'string', description: 'nextCursor from the previous page' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const query = queryArg(args);
      const { from, to } = range(optDay(args, 'from'), optDay(args, 'to'));
      const limit = limitArg(args, SEARCH_LIMIT);
      const cursor = cursorArg(args);
      const all = (await ctx.dispatch('listLogRange', [{ from, to }])) as LogEntry[];
      const needle = query.toLowerCase();
      const hits = all.filter((e) => logEntryMatches(e, needle));
      return {
        query,
        from: from ?? null,
        to: to ?? null,
        totalMatches: hits.length,
        ...page(hits, limit, cursor),
      };
    },
  },
  {
    name: 'list_log',
    description: `List the user's Log entries from one day to another (ISO dates, inclusive) — e.g. "what did I log this week". ${PAGING} For one day with its tasks, calendar, Flux and LeetCode, use get_day. ${PRIVACY}`,
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        limit: { type: 'integer', description: `1–${LIST_LIMIT.max}, default ${LIST_LIMIT.def}` },
        cursor: { type: 'string', description: 'nextCursor from the previous page' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { from, to } = range(reqDay(args, 'from'), reqDay(args, 'to'));
      const limit = limitArg(args, LIST_LIMIT);
      const cursor = cursorArg(args);
      const all = (await ctx.dispatch('listLogRange', [{ from, to }])) as LogEntry[];
      return { from, to, total: all.length, ...page(all, limit, cursor) };
    },
  },
  {
    name: 'get_day',
    description: `One day as data — the Log page and the night review in one call. day is an ISO date (an app day: it runs from the user's day-start hour, 4am by default, to the next, Pacific time — see window). Returns: dayPlan (intent, capacity, reflection — null if the app never opened that day); log (that day's entries, in capture order); tasks.done (finished that day: estimateLockedMin vs actualMin, deltaMin for a calibration point; a parent's parts are points of their own, so don't total a parent with its parts); tasks.planned (timed tasks whose deadline falls on the day, byTime, then the day's plan rows) and stillOpen; tasks.due (dueDay is this date — by date, so a 00:30 deadline tomorrow is due tomorrow yet planned tonight); calendar (busy time and the day's shape over the focus window, or a reason; an account whose Google sign-in lapsed reads as free — list_calendars shows reconnectRequired); flux (sets and a summary); leetcode (sittings started that day — get_sitting reads one in full). Read-only: it never spawns recurring tasks or moves stale plans (the app does that when opened). ${PRIVACY}`,
    inputSchema: {
      type: 'object',
      properties: { day: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['day'],
      additionalProperties: false,
    },
    run: async (args, ctx) => composeDay(reqDay(args, 'day'), ctx),
  },
];
