import {
  ATTACHMENT_MAX_BYTES,
  AUTO_PLACED_ERROR,
  TASK_NOTES_MAX,
  TASK_REFLECTION_MAX,
  UPLOAD_URL_TTL_MS,
  blockTitle,
  calendarSyncPlan,
  computeDayShape,
  hasParts,
  isDayKey,
  isTimeKey,
  normalizeContentType,
  normalizeNotes,
  normalizeReflection,
  PARENT_NO_ACTUAL_ERROR,
  parentOf,
  partsOf,
  partsSummary,
  userDueEpoch,
} from '@aperture/shared';
import type {
  Attachment,
  CalendarBusy,
  Category,
  CreateTaskInput,
  GoogleCalendar,
  GoogleStatus,
  Settings,
  SplitTaskInput,
  Task,
  TaskStatus,
  UpsertCategoryInput,
} from '@aperture/shared';
import { FINANCE_TOOLS } from './financeTools';
import { FLUX_TOOLS } from './fluxTools';
import { PLACE_ARG_DESC, PLACE_TOOLS, placeArg } from './placeTools';
import { SERIES_TOOLS } from './seriesTools';
import { RpcParamError } from './types';
import type { Tool, ToolContext } from './types';

// The v1 tool surface Claude Code / claude.ai see. Each tool is a thin wrapper over one or more RPC
// methods dispatched through handleRpc, so the writes-discipline and the state machines apply unchanged.
// The grammar is meant to be GENERATED (the operator is Claude), so it's strict and concrete: ISO dates
// only, minutes only, ids from list_categories — the descriptions carry the rules the model can't infer.

const TASK_STATUSES: TaskStatus[] = ['backlog', 'planned', 'in_progress', 'done', 'cancelled'];

// attach_file carries bytes IN the tool call (base64). Tool arguments are model OUTPUT tokens (~1 token
// per 2–3 base64 chars), so this is a small-text-artifact path (a spec, notes, a snippet) — a real file
// goes through create_attachment_upload's presigned URL. 64 KB decoded ≈ 87 KB base64 ≈ the edge of one
// tool call; well under the 6 MB Function-URL request cap and the 20 MB S3 cap.
const AGENT_ATTACH_MAX_BYTES = 64 * 1024;

// --- arg parsing (explicit, so error messages are useful; these throw RpcParamError → -32602) ----------

const present = (args: Record<string, unknown>, key: string): boolean => args[key] !== undefined;

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (v === undefined || v === null) throw new RpcParamError(`"${key}" is required`);
  if (typeof v !== 'string') throw new RpcParamError(`"${key}" must be a string`);
  return v;
}
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new RpcParamError(`"${key}" must be a string`);
  return v;
}
// present-with-null clears the field; a wrong type is an error.
function nullableStr(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new RpcParamError(`"${key}" must be a string or null`);
  return v;
}
function reqInt(args: Record<string, unknown>, key: string, min?: number): number {
  const v = args[key];
  if (v === undefined || v === null) throw new RpcParamError(`"${key}" is required`);
  if (typeof v !== 'number' || !Number.isInteger(v))
    throw new RpcParamError(`"${key}" must be an integer`);
  if (min !== undefined && v < min) throw new RpcParamError(`"${key}" must be >= ${min}`);
  return v;
}
function optInt(args: Record<string, unknown>, key: string, min?: number): number | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  return reqInt(args, key, min);
}
function reqBool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  if (typeof v !== 'boolean') throw new RpcParamError(`"${key}" must be true or false`);
  return v;
}
function reqDay(args: Record<string, unknown>, key: string): string {
  const s = reqStr(args, key);
  if (!isDayKey(s)) throw new RpcParamError(`"${key}" must be an ISO date (YYYY-MM-DD)`);
  return s;
}
function nullableDay(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === null || v === undefined) return null;
  return reqDay(args, key);
}
// A deadline clock time: "HH:MM", 24h, the user's local wall clock. null clears.
function nullableTime(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || !isTimeKey(v))
    throw new RpcParamError(`"${key}" must be HH:MM (24h, e.g. 16:00), or null`);
  return v;
}
const DUE_TIME_DESC =
  'deadline clock time HH:MM (24h) in the user\'s local time (America/Los_Angeles) on dueDay — "due Friday 4pm" is dueDay + dueTime "16:00". Needs a dueDay. A timed task is added to Google Calendar automatically when that is on (an event ending at the deadline, as long as the estimate; a part’s block is named "Parent · Part"; a parent’s is its 15-minute due marker, free, which a due change moves); a sync failure shows as gcalSyncError on the returned task — sync_calendar_event retries it';
// Why sync_calendar_event would do nothing — calendarSyncPlan's `none` gates, in its order.
function syncRefusal(task: Task, settings: Settings, parent: boolean): string {
  if (settings.autoCalendar === false)
    return 'Auto-sync is off — the user turns it on in the app; nothing syncs until then.';
  if (task.status === 'done' || task.status === 'cancelled')
    return `A ${task.status} task never syncs to the calendar.`;
  if (parent && !task.gcalEventId && !(task.dueDay && task.dueTime))
    return 'A task with parts is on the calendar as its due marker, which needs a due time — set dueDay + dueTime with update_task (its parts take blocks of their own).';
  if (!task.gcalEventId && !(task.dueDay && task.dueTime))
    return 'No due time and no event — set dueDay + dueTime with update_task (the block follows), or add a manual block with create_calendar_event.';
  if (!task.gcalEventId && !settings.calendarWriteDefault)
    return 'No calendar to write to — the user sets a write default in the app (see list_calendars).';
  return 'Nothing to sync.';
}
// Notes are checked here, before any dispatch, so an over-cap note is a param error that lands nothing —
// not a half-applied update_task. The value passed on is already normalized (trim, '' → null).
// The reflection goes through the same check with its own normalizer (and cap).
function nullableText(
  args: Record<string, unknown>,
  key: string,
  normalize: (v: string | null | undefined) => string | null,
): string | null {
  const v = args[key];
  if (v !== null && v !== undefined && typeof v !== 'string')
    throw new RpcParamError(`"${key}" must be a string or null`);
  try {
    return normalize(v);
  } catch (e) {
    throw new RpcParamError(`"${key}": ${e instanceof Error ? e.message : 'invalid'}`);
  }
}
// complete_task's reflection on a task already marked done (a parent, an errand without an actual): if
// this write fails, say the task is done, so a retry goes to update_task rather than "already done".
async function reflectAfterDone(ctx: ToolContext, id: string, reflection: string | null) {
  try {
    return (await ctx.dispatch('setTaskReflection', [id, reflection])) as Task;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    throw new Error(`${msg} (the task is done; the reflection wasn't saved — use update_task)`, {
      cause: e,
    });
  }
}
const nullableNotes = (args: Record<string, unknown>, key: string) =>
  nullableText(args, key, normalizeNotes);
const nullableReflection = (args: Record<string, unknown>) =>
  nullableText(args, 'reflection', normalizeReflection);
const NOTES_SCHEMA_DESC = `light markdown (**bold**, *italic*, \`code\`, - bullets, 1. lists, [text](https://…), bare URLs; newlines kept), at most ${TASK_NOTES_MAX} characters after trimming (the server checks)`;
const REFLECTION_SCHEMA_DESC = `the user's short look back at the finished task — what went well, what to do differently next time, where the time went. Only in the user's own words, when they say it; never invent or summarise one. Plain text or the notes' light markdown, at most ${TASK_REFLECTION_MAX} characters after trimming (the server checks)`;

function enumArg<T extends string>(args: Record<string, unknown>, key: string, allowed: T[]): T {
  const s = reqStr(args, key);
  if (!(allowed as string[]).includes(s)) {
    throw new RpcParamError(`"${key}" must be one of: ${allowed.join(', ')}`);
  }
  return s as T;
}
function optEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: T[],
): T | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  return enumArg(args, key, allowed);
}
// A calendar event time: ISO 8601 with an EXPLICIT offset or Z. We do no timezone inference (the operator
// must send the user's local offset), consistent with the rest of the app's "no server date math" rule.
function reqTime(args: Record<string, unknown>, key: string): number {
  const s = reqStr(args, key);
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    throw new RpcParamError(
      `"${key}" must be an ISO 8601 timestamp with an explicit offset or Z (e.g. 2026-09-22T14:00:00-07:00)`,
    );
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new RpcParamError(`"${key}" is not a valid timestamp`);
  return ms;
}

// A parent's progress on each listed task, from the full list (parts.ts): { total, done, estimateMin }.
function withParts(shown: Task[], all: Task[]) {
  return shown.map((t) => {
    const parts = partsOf(all, t.id);
    if (!parts.length) return t;
    const { total, done, estimateMin } = partsSummary(parts);
    return { ...t, parts: { total, done, estimateMin } };
  });
}

// --- the tools -----------------------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: 'list_tasks',
    description:
      'List all live tasks (any status), newest first. Optionally filter by status (backlog, planned, in_progress, done, cancelled). A task with parts (a parent: the deliverable, holding the deadline) carries parts: { total, done, estimateMin } — total and estimateMin leave dropped parts out; a part carries parentId.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: TASK_STATUSES, description: 'optional status filter' },
      },
      additionalProperties: false,
    },
    async run(args, ctx) {
      const tasks = (await ctx.dispatch('listTasks', [])) as Task[];
      const status = optEnum(args, 'status', TASK_STATUSES);
      // One read: a parent's progress comes from the same list (parts.ts).
      return withParts(status ? tasks.filter((t) => t.status === status) : tasks, tasks);
    },
  },
  {
    name: 'list_backlog',
    description:
      'List backlog tasks (status = backlog), newest first. A parent carries parts: { total, done, estimateMin }, like list_tasks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const backlog = (await ctx.dispatch('listBacklog', [])) as Task[];
      return withParts(backlog, (await ctx.dispatch('listTasks', [])) as Task[]);
    },
  },
  {
    name: 'create_task',
    description:
      "Create one backlog task. categoryId comes from list_categories (a label will not resolve). estimateMin/bufferMin are minutes; dueDay is an ISO date (YYYY-MM-DD); dueTime is an optional HH:MM deadline time on that day (on a part: when its block ends, not a deadline); notes is free-form context (light markdown). The estimate stays editable until the task is done or cancelled. parentId makes it a PART of that task (one level: not a part, not finished, not already worked on): the parent is the deliverable and holds the deadline; its parts hold the work. Its first part clears the parent's estimate (now the sum of its parts), and if the parent was planned an untimed first part takes its spot. A timed task (dueDay + dueTime) is never planned: it's on Today on its day, by its time. place puts it on an errand list (a slug from list_places) — \"add shampoo to my Safeway list\" is create_task { title: 'shampoo', place: 'safeway' }. A part always takes its parent's place: omit place (a different one errors).",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        categoryId: { type: 'string', description: 'category id from list_categories, or omit' },
        estimateMin: { type: 'integer', minimum: 0 },
        bufferMin: { type: 'integer', minimum: 0 },
        dueDay: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        dueTime: { type: 'string', description: DUE_TIME_DESC },
        notes: { type: ['string', 'null'], description: NOTES_SCHEMA_DESC },
        parentId: { type: 'string', description: 'make it a part of this task (list_tasks id)' },
        place: { type: ['string', 'null'], description: PLACE_ARG_DESC },
      },
      required: ['title'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const input: CreateTaskInput = { title: reqStr(args, 'title') };
      if (present(args, 'parentId')) input.parentId = nullableStr(args, 'parentId');
      if (present(args, 'place')) input.place = placeArg(args, 'place');
      if (present(args, 'categoryId')) input.categoryId = nullableStr(args, 'categoryId');
      if (present(args, 'estimateMin')) input.estimateMin = reqInt(args, 'estimateMin', 0);
      if (present(args, 'bufferMin')) input.bufferMin = reqInt(args, 'bufferMin', 0);
      if (present(args, 'dueDay')) input.dueDay = nullableDay(args, 'dueDay');
      if (present(args, 'dueTime')) input.dueTime = nullableTime(args, 'dueTime');
      if (present(args, 'notes')) input.notes = nullableNotes(args, 'notes');
      return ctx.dispatch('createTask', [input]);
    },
  },
  {
    name: 'create_tasks',
    description:
      'Bulk-create many backlog tasks in order (one shared timestamp so they sort together). Each task takes the same fields as create_task, parentId included — breaking a deliverable into parts is one call with every part pointing at it. All-or-nothing on invalid input: one bad task (e.g. notes over the cap, an ineligible parentId, an unknown place, a part placed differently from its parent) creates none. Use this for a study plan or a session backlog dump.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              categoryId: { type: 'string' },
              estimateMin: { type: 'integer', minimum: 0 },
              bufferMin: { type: 'integer', minimum: 0 },
              dueDay: { type: 'string' },
              dueTime: { type: 'string', description: 'HH:MM (24h), needs dueDay' },
              notes: { type: ['string', 'null'], description: NOTES_SCHEMA_DESC },
              parentId: { type: 'string' },
              place: { type: ['string', 'null'], description: 'place slug (list_places)' },
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const raw = args.tasks;
      if (!Array.isArray(raw)) throw new RpcParamError('"tasks" must be an array');
      const inputs: CreateTaskInput[] = raw.map((t, i) => {
        if (typeof t !== 'object' || t === null) {
          throw new RpcParamError(`tasks[${i}] must be an object`);
        }
        const row = t as Record<string, unknown>;
        const input: CreateTaskInput = { title: reqStr(row, 'title') };
        if (present(row, 'categoryId')) input.categoryId = nullableStr(row, 'categoryId');
        if (present(row, 'estimateMin')) input.estimateMin = reqInt(row, 'estimateMin', 0);
        if (present(row, 'bufferMin')) input.bufferMin = reqInt(row, 'bufferMin', 0);
        if (present(row, 'dueDay')) input.dueDay = nullableDay(row, 'dueDay');
        if (present(row, 'dueTime')) input.dueTime = nullableTime(row, 'dueTime');
        if (present(row, 'notes')) input.notes = nullableNotes(row, 'notes');
        if (present(row, 'parentId')) input.parentId = nullableStr(row, 'parentId');
        if (present(row, 'place')) input.place = placeArg(row, 'place');
        return input;
      });
      return ctx.dispatch('createTasks', [inputs]);
    },
  },
  {
    name: 'parse_task',
    description:
      'Parse ONE natural-language quick-capture line (e.g. "aperture, fix login bug due fri 4pm 30m") into create_task fields with the server\'s Claude Haiku prompt — the same parse as the app\'s quick add — against the user\'s real day start and active categories. Writes nothing. Returns {ok:true, source, input, categoryLabel, dropped, today}: pass `input` straight to create_task; `dropped` names fields the model returned that were invalid and left out. {ok:false, reason, detail?} (reason: unavailable, timeout, network, api, bad-json, empty-title, grammar) means save the line raw as the title — never drop it. A line containing " | " is parsed by the strict bulk grammar instead (no model call); a grammar error returns ok:false with reason "grammar". When you can parse a line yourself, call create_task directly — this tool is for clients with no model (the Raycast hotkey).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'the line as typed' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: (args, ctx) => ctx.dispatch('parseTask', [reqStr(args, 'text')]),
  },
  {
    name: 'update_task',
    description:
      'Patch fields on a task: title, categoryId (null clears), parentId (attach it as a part of that task, or null to detach; a started task attaching freezes the parent\'s baseline; an open part takes its parent\'s place, a detached one keeps it), place (an errand list slug from list_places; null takes it off; open tasks only — on a finished task the place is history and errors; a part follows its parent\'s place and errors — set the parent\'s, which carries its open parts along), dueDay (null clears the day AND its time; ISO date; a new day keeps the current time), dueTime (HH:MM 24h local deadline time; null clears; needs a dueDay on the task or in the same call), notes (REPLACES the whole note; null or "" clears; editable at any status), reflection (REPLACES the whole reflection; null or "" clears; usually on a done task — the look back written at completion), estimateMin and/or bufferMin (either alone keeps the other), status. Fields apply in order title→categoryId→parentId→place→due→notes→reflection→estimate→status. A parent (a task with parts) takes no estimate and no in_progress/planned status of its own — those belong to its parts; on a part, dueDay/dueTime is when its block ends. On a task with a linked Google Calendar event, while auto-sync is on, title/due/estimate changes move or rename the event and clearing the due time DELETES it; cancelling DELETES it either way. Setting the same due time again never re-adds a removed block — sync_calendar_event does. estimateMin is the working estimate, editable until the task is done or cancelled (then it errors); the calibration baseline frozen when work started is separate and never moves. If only part of the work is finished, use split_task (not on a roll rep or a recurring occurrence). Setting status uses the transition rules (done is only reachable from in_progress; prefer complete_task). A timed task is never planned — it’s on Today on its day, by its time — so status planned on one is undone by the next app open (back to backlog).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        categoryId: { type: ['string', 'null'] },
        place: { type: ['string', 'null'], description: PLACE_ARG_DESC },
        parentId: { type: ['string', 'null'], description: 'parent task id, or null to detach' },
        dueDay: { type: ['string', 'null'], description: 'ISO date YYYY-MM-DD, or null to clear' },
        dueTime: { type: ['string', 'null'], description: `${DUE_TIME_DESC}; null clears` },
        notes: {
          type: ['string', 'null'],
          description: `${NOTES_SCHEMA_DESC}; replaces the whole note, null clears`,
        },
        reflection: {
          type: ['string', 'null'],
          description: `${REFLECTION_SCHEMA_DESC}; replaces the whole reflection, null clears`,
        },
        estimateMin: { type: 'integer', minimum: 0 },
        bufferMin: { type: 'integer', minimum: 0 },
        status: { type: 'string', enum: TASK_STATUSES },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = reqStr(args, 'id');
      const fields = [
        'title',
        'categoryId',
        'place',
        'parentId',
        'dueDay',
        'dueTime',
        'notes',
        'reflection',
        'estimateMin',
        'bufferMin',
        'status',
      ];
      if (!fields.some((f) => present(args, f))) {
        throw new RpcParamError('update_task needs at least one field to change');
      }
      const notes = present(args, 'notes') ? nullableNotes(args, 'notes') : undefined; // before any write
      const place = present(args, 'place') ? placeArg(args, 'place') : undefined;
      const reflection = present(args, 'reflection') ? nullableReflection(args) : undefined;
      const dueDay = present(args, 'dueDay') ? nullableDay(args, 'dueDay') : undefined;
      const dueTime = present(args, 'dueTime') ? nullableTime(args, 'dueTime') : undefined;
      const applied: string[] = [];
      try {
        if (present(args, 'title')) {
          await ctx.dispatch('setTaskTitle', [id, reqStr(args, 'title')]);
          applied.push('title');
        }
        if (present(args, 'categoryId')) {
          await ctx.dispatch('setTaskCategory', [id, nullableStr(args, 'categoryId')]);
          applied.push('categoryId');
        }
        // parentId before place: a detach then frees the place, and a place given with an attach is
        // refused (a part follows its parent) rather than silently overwritten by the parent's.
        let current: Task | null = null;
        if (present(args, 'parentId')) {
          current = (await ctx.dispatch('setTaskParent', [
            id,
            nullableStr(args, 'parentId'),
          ])) as Task;
          applied.push('parentId');
        }
        if (place !== undefined) {
          // A part already on that place (its parent's) is a no-op, as create_task takes it — only a
          // DIFFERENT place on a part is refused.
          current ??= (await ctx.dispatch('getTask', [id])) as Task | null;
          if (!(current?.parentId && current.place === place))
            await ctx.dispatch('setTaskPlace', [id, place]);
          applied.push('place');
        }
        if (dueDay !== undefined || dueTime !== undefined) {
          // A time-only change keeps the task's day; the server rejects a time with no day at all.
          const day =
            dueDay !== undefined
              ? dueDay
              : ((await ctx.dispatch('getTask', [id])) as Task | null)?.dueDay || null;
          await ctx.dispatch('setTaskDue', [
            id,
            dueTime === undefined ? { dueDay: day } : { dueDay: day, dueTime },
          ]);
          applied.push('due');
        }
        if (notes !== undefined) {
          await ctx.dispatch('setTaskNotes', [id, notes]);
          applied.push('notes');
        }
        if (reflection !== undefined) {
          await ctx.dispatch('setTaskReflection', [id, reflection]);
          applied.push('reflection');
        }
        if (present(args, 'estimateMin') || present(args, 'bufferMin')) {
          // Either half alone keeps the other (like split_task and the editor) — a rescope that sends
          // only estimateMin must not wipe the buffer.
          const cur = (await ctx.dispatch('getTask', [id])) as Task | null;
          const est = present(args, 'estimateMin')
            ? reqInt(args, 'estimateMin', 0)
            : (cur?.estimateMin ?? null);
          const buf = present(args, 'bufferMin')
            ? reqInt(args, 'bufferMin', 0)
            : (cur?.bufferMin ?? null);
          await ctx.dispatch('setTaskEstimate', [id, est, buf]);
          applied.push('estimate');
        }
        if (present(args, 'status')) {
          await ctx.dispatch('transitionTask', [id, enumArg(args, 'status', TASK_STATUSES)]);
          applied.push('status');
        }
      } catch (e) {
        if (e instanceof RpcParamError) throw e; // bad args → -32602, unchanged
        // A later field can throw after earlier ones already landed — tell the model exactly what applied.
        const msg = e instanceof Error ? e.message : 'error';
        throw new Error(`${msg} (already applied: ${applied.join(', ') || 'none'})`, { cause: e });
      }
      return (await ctx.dispatch('getTask', [id])) as Task;
    },
  },
  {
    name: 'complete_task',
    description:
      'Mark a task done and record how long it ACTUALLY took (actualMin, minutes). This is what feeds calibration, so actualMin is required — never guess a round number silently, ask the user if unsure. Chains through in_progress if needed (which freezes the calibration baseline). If only part of the task is finished, use split_task instead. actualMin REPLACES any timer-tracked minutes; the previous value is returned so an overwrite is visible. A PARENT (a task with parts) is the exception: omit actualMin — its actual is what its parts took — and it is refused while any part is still open (complete, drop or delete that part first). An ERRAND (a task with a place) may omit actualMin too: it is checked off, never a calibration point. reflection (optional): the user’s look back, saved in the same write as actualMin (on a parent, after its parts’ rollup; on an errand without one, after the check-off); to add or fix one on a task already done, use update_task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        actualMin: {
          type: 'integer',
          minimum: 1,
          description:
            'actual minutes the task took (required, except on a parent: omit it; optional on an errand)',
        },
        reflection: { type: ['string', 'null'], description: REFLECTION_SCHEMA_DESC },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = reqStr(args, 'id');
      // Checked before any dispatch: an over-cap reflection is a param error that lands nothing.
      const reflection = present(args, 'reflection') ? nullableReflection(args) : undefined;
      const task = (await ctx.dispatch('getTask', [id])) as Task | null;
      if (!task) throw new Error(`Not found: ${id}`);
      if (task.status === 'done' || task.status === 'cancelled') {
        throw new Error(`Task is already ${task.status}`);
      }
      const all = (await ctx.dispatch('listTasks', [])) as Task[];
      if (partsOf(all, id).length) {
        if (present(args, 'actualMin'))
          throw new RpcParamError(`${PARENT_NO_ACTUAL_ERROR} Omit actualMin.`);
        // The server refuses while a part is open, naming it (parts.ts) — that message is the answer.
        const done = (await ctx.dispatch('transitionTask', [id, 'done'])) as Task;
        if (reflection === undefined) return { task: done, previousActualMin: 0 };
        return { task: await reflectAfterDone(ctx, id, reflection), previousActualMin: 0 };
      }
      // An errand is checked off — no actual needed (it never feeds calibration: contributesCalibration).
      const actualMin =
        task.place && !present(args, 'actualMin') ? null : reqInt(args, 'actualMin', 1);
      const previousActualMin = task.actualAccruedMin;
      if (task.status === 'backlog' || task.status === 'planned') {
        await ctx.dispatch('transitionTask', [id, 'in_progress']);
      }
      if (actualMin !== null)
        await ctx.dispatch(
          'setTaskActual',
          reflection === undefined ? [id, actualMin] : [id, actualMin, reflection],
        );
      const done = (await ctx.dispatch('transitionTask', [id, 'done'])) as Task;
      // An errand checked off with no actual has no setTaskActual for the reflection to ride.
      if (actualMin !== null || reflection === undefined) return { task: done, previousActualMin };
      return { task: await reflectAfterDone(ctx, id, reflection), previousActualMin };
    },
  },
  {
    name: 'split_task',
    description:
      'Split a task when the work turned out bigger, or part of it is finished: this part either finishes (finish="done" — only for a started task; actualMin is required and feeds calibration, so ask the user, never guess) or keeps going (finish="keep"), and the rest becomes a new PART (followUpTitle, followUpEstimateMin). A split always yields parent + parts: a standalone task becomes "Part 1" (unless title renames it) under a NEW parent that takes its title (or parentTitle), deadline and calibration baseline; splitting a part adds a sibling under the same parent (parentTitle is refused there). A parent itself can\'t be split — create a part instead — and nor can a roll rep or a recurring occurrence (one rep of a repeating thing: rescope it with update_task or finish it with complete_task). Optional title/estimateMin/bufferMin rename or rescope this part. The new part keeps the category, time and notes, and lands on this task\'s latest plan day when this task is planned or in progress and untimed (else the backlog; a timed follow-up is on its day by its time). Each part is its own calibration point; the parent is scored as the whole job once marked done. Nothing is cancelled. Calendar: a timed follow-up gets its own Google Calendar block ending at its time — on finish="done" it takes over this task’s block, if it has one (never the parent’s: a parent has none); a sync failure shows as gcalSyncError on whichever task it failed for (sync_calendar_event retries it). Returns { parent, original, followUp }.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        finish: { type: 'string', enum: ['done', 'keep'] },
        actualMin: {
          type: 'integer',
          minimum: 0,
          description: 'finish="done" only (required there): minutes this part actually took',
        },
        title: {
          type: 'string',
          description:
            'this part\'s new title; omitted keeps it (a standalone task becomes "Part 1")',
        },
        parentTitle: {
          type: 'string',
          description: "standalone only: the new parent's title; omitted takes this task's",
        },
        estimateMin: { type: 'integer', minimum: 0, description: "this part's working estimate" },
        bufferMin: { type: 'integer', minimum: 0 },
        followUpTitle: { type: 'string' },
        followUpEstimateMin: { type: 'integer', minimum: 0, description: 'the rest, in minutes' },
        followUpBufferMin: { type: 'integer', minimum: 0 },
      },
      required: ['id', 'finish', 'followUpTitle'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const finish = enumArg<'done' | 'keep'>(args, 'finish', ['done', 'keep']);
      if (finish === 'keep' && present(args, 'actualMin'))
        throw new RpcParamError('actualMin is only for finish="done"');
      const input: SplitTaskInput = {
        finish,
        followUp: {
          title: reqStr(args, 'followUpTitle'),
          estimateMin: optInt(args, 'followUpEstimateMin', 0) ?? null,
          bufferMin: optInt(args, 'followUpBufferMin', 0) ?? null,
        },
      };
      if (finish === 'done') input.actualMin = reqInt(args, 'actualMin', 0);
      if (present(args, 'title')) input.title = reqStr(args, 'title');
      if (present(args, 'parentTitle')) input.parentTitle = reqStr(args, 'parentTitle');
      if (present(args, 'estimateMin')) input.estimateMin = reqInt(args, 'estimateMin', 0);
      if (present(args, 'bufferMin')) input.bufferMin = reqInt(args, 'bufferMin', 0);
      return ctx.dispatch('splitTask', [reqStr(args, 'id'), input]);
    },
  },
  {
    name: 'delete_task',
    description:
      'Permanently delete a task (no restore tool). Also removes its day plans and attachments (their stored file bytes too), DELETES its linked Google Calendar event if it has one, and its logged time stops counting toward calibration. Deleting a parent deletes every one of its parts the same way (the result lists them) — confirm the count with the user first. Refused for a recurring occurrence (seriesId set) — the series would just respawn it. To abandon a task while keeping its history, use update_task status=cancelled instead.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = reqStr(args, 'id');
      // deleteTask is idempotent (a bad id silently no-ops), so check first — a typo'd id should say so.
      const task = (await ctx.dispatch('getTask', [id])) as Task | null;
      if (!task) throw new Error(`Not found: ${id}`);
      // Same guard as the UI (TaskEditor hides Delete): getDay would respawn a deleted occurrence.
      if (task.seriesId !== null) {
        throw new Error(
          'Recurring occurrence — use update_task status=cancelled instead of deleting',
        );
      }
      const parts = partsOf((await ctx.dispatch('listTasks', [])) as Task[], id);
      await ctx.dispatch('deleteTask', [id]);
      return parts.length ? { deleted: id, parts: parts.map((p) => p.id) } : { deleted: id };
    },
  },
  {
    name: 'list_categories',
    description:
      'List all categories (id, label, isWork, order). Use the id when creating/updating tasks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, ctx) => ctx.dispatch('listCategories', []),
  },
  {
    name: 'create_category',
    description:
      'Create a category. isWork tags it as work vs personal (the calibration/work split). order is an optional sort key.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        isWork: { type: 'boolean' },
        order: { type: 'integer' },
      },
      required: ['label', 'isWork'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const input: { label: string; isWork: boolean; order?: number } = {
        label: reqStr(args, 'label'),
        isWork: reqBool(args, 'isWork'),
      };
      if (present(args, 'order')) input.order = reqInt(args, 'order');
      return ctx.dispatch('upsertCategory', [input]);
    },
  },
  {
    name: 'update_category',
    description:
      'Patch a category: label, isWork, order, active. Unsent fields keep their current value. active:false retires it (hidden from pickers; existing tasks keep the label), active:true restores it. isWork is forward-only here — past sessions keep their recorded work/personal split.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        label: { type: 'string' },
        isWork: { type: 'boolean' },
        order: { type: 'integer' },
        active: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = reqStr(args, 'id');
      if (!['label', 'isWork', 'order', 'active'].some((f) => present(args, f))) {
        throw new RpcParamError('update_category needs at least one field to change');
      }
      // upsertCategory requires label + isWork, so those merge over the current row; order/active are
      // patch-style in the contract (omitted keeps the current value), so they're sent only when given.
      const cats = (await ctx.dispatch('listCategories', [])) as Category[];
      const cat = cats.find((c) => c.id === id);
      if (!cat) throw new Error(`Not found: ${id}`);
      const input: UpsertCategoryInput = {
        id,
        label: present(args, 'label') ? reqStr(args, 'label') : cat.label,
        isWork: present(args, 'isWork') ? reqBool(args, 'isWork') : cat.isWork,
      };
      if (present(args, 'order')) input.order = reqInt(args, 'order');
      if (present(args, 'active')) input.active = reqBool(args, 'active');
      return ctx.dispatch('upsertCategory', [input]);
    },
  },
  {
    name: 'get_calibration',
    description:
      'Calibration points (frozen estimate vs actual) for completed tasks in a date range. from/to are ISO dates (YYYY-MM-DD), inclusive. Every part is a point; a done parent is one too (parts > 0, the parts not dropped): its frozen lock against what its parts took. Its parts are already points, so leave parents out when totalling, or the work counts twice. This is the signature metric — use it to advise better estimates.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    run(args, ctx) {
      return ctx.dispatch('getCalibration', [
        { from: reqDay(args, 'from'), to: reqDay(args, 'to') },
      ]);
    },
  },
  {
    name: 'list_leetcode_attempts',
    description:
      'LeetCode attempts captured by the browser extension, reverse-chron. Optional from/to ISO date range (pass BOTH or NEITHER). Use it to spot weak topics and queue drills.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      additionalProperties: false,
    },
    run(args, ctx) {
      const from = optStr(args, 'from');
      const to = optStr(args, 'to');
      if ((from === undefined) !== (to === undefined)) {
        throw new RpcParamError('pass both "from" and "to", or neither');
      }
      const range =
        from !== undefined ? [{ from: reqDay(args, 'from'), to: reqDay(args, 'to') }] : [];
      return ctx.dispatch('listLeetcodeAttempts', range);
    },
  },
  {
    name: 'list_calendars',
    description:
      'Connected Google accounts and their calendars, plus the write-default target. Call this first to pick accountSub + calendarId for create_calendar_event. reconnectRequired means the account needs re-connecting in the app (only the browser can do that).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const [status, calendars, settings] = (await Promise.all([
        ctx.dispatch('getGoogleStatus', []),
        ctx.dispatch('listGoogleCalendars', []),
        ctx.dispatch('getSettings', []),
      ])) as [GoogleStatus, GoogleCalendar[], Settings];
      const wd = settings.calendarWriteDefault;
      const accounts = status.accounts.map((a) => ({
        sub: a.sub,
        email: a.email,
        connected: a.connected,
        reconnectRequired: a.reconnectRequired,
        calendars: calendars
          .filter((c) => c.accountSub === a.sub)
          .map((c) => ({ calendarId: c.calendarId, summary: c.summary, primary: c.primary })),
        isWriteDefault: wd?.accountSub === a.sub,
      }));
      return { accounts, writeDefault: wd };
    },
  },
  {
    name: 'create_calendar_event',
    description:
      'Create a Google Calendar event linked to a task (a task can hold one event). start is an ISO timestamp WITH offset; give either end (ISO) or durationMin. accountSub/calendarId default to the write-default (see list_calendars); title defaults to the task title (on a part, "Parent · Part", as its auto block is named). For a task with no due time: a manual time block — renaming it in Google renames the task; its time maps to no task field. Refused on a parent (a task with parts — its one event is its due marker, placed by sync_calendar_event; add the event to a part). Refused on a task with a due time while auto-sync is on (with a calendar to write to): that task’s block is placed at its deadline automatically — sync_calendar_event puts it (back) there, update_task changes the time. On error, re-read the task before retrying — the event may already exist.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        start: {
          type: 'string',
          description: 'ISO 8601 with offset, e.g. 2026-09-22T14:00:00-07:00',
        },
        end: { type: 'string', description: 'ISO 8601 with offset' },
        durationMin: { type: 'integer', minimum: 1 },
        title: { type: 'string' },
        accountSub: { type: 'string' },
        calendarId: { type: 'string' },
      },
      required: ['taskId', 'start'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const taskId = reqStr(args, 'taskId');
      const startMs = reqTime(args, 'start');
      let endMs: number;
      if (present(args, 'end')) endMs = reqTime(args, 'end');
      else if (present(args, 'durationMin'))
        endMs = startMs + reqInt(args, 'durationMin', 1) * 60_000;
      else throw new RpcParamError('provide either "end" (ISO) or "durationMin"');
      if (endMs <= startMs) throw new RpcParamError('the event must end after it starts');

      // Target: accountSub + calendarId must be given TOGETHER (a lone accountSub paired with the
      // default's calendarId could point at a different account's calendar). Give both, or neither → the
      // write default.
      let accountSub = optStr(args, 'accountSub');
      let calendarId = optStr(args, 'calendarId');
      if (accountSub || calendarId) {
        if (!accountSub || !calendarId) {
          throw new RpcParamError(
            'pass accountSub and calendarId together, or neither (to use the write default)',
          );
        }
      } else {
        const wd = ((await ctx.dispatch('getSettings', [])) as Settings).calendarWriteDefault;
        if (!wd) {
          throw new Error(
            'No calendar target — pass accountSub + calendarId, or set a write default in the app (see list_calendars).',
          );
        }
        accountSub = wd.accountSub;
        calendarId = wd.calendarId;
      }
      let title = optStr(args, 'title');
      if (!title) {
        const task = (await ctx.dispatch('getTask', [taskId])) as Task | null;
        if (!task) throw new Error(`Not found: ${taskId}`);
        const parent = task.parentId
          ? ((await ctx.dispatch('getTask', [task.parentId])) as Task | null)
          : null;
        title = blockTitle(task, parent?.title);
      }
      try {
        return await ctx.dispatch('insertCalendarEvent', [
          { taskId, accountSub, calendarId, title, startMs, endMs },
        ]);
      } catch (e) {
        // The shared refusal ends with the app's way out; MCP's is the ensure pass.
        if (!(e instanceof Error) || !e.message.startsWith(AUTO_PLACED_ERROR)) throw e;
        throw new Error(
          `${AUTO_PLACED_ERROR} From here: sync_calendar_event {taskId} puts the block at the deadline; update_task changes the time.`,
          { cause: e },
        );
      }
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete the Google Calendar event linked to a task. This is a REAL delete in Google Calendar, but only ever of an event Aperture created for this task — it cannot touch any other calendar event. (sync_calendar_event puts a timed task’s block back.)',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: (args, ctx) => ctx.dispatch('deleteCalendarEvent', [reqStr(args, 'taskId')]),
  },
  {
    name: 'sync_calendar_event',
    description:
      'Sync a task’s Google Calendar event to the task as it is now — the app’s Add to calendar / Retry / Send to Google. Nothing is picked: a timed task’s block goes on the write default (see list_calendars), ends at its due time (on a part, when its block ends; named "Parent · Part") and is as long as the estimate; a parent’s is its due marker — 15 minutes ending at its deadline, shown free and graphite. Writes a REAL Google Calendar event. Returns { outcome, task }: "created" (a timed task with no event gets one — e.g. after its block was removed), "updated" (a linked event gets the task’s title and time — a failed sync is retried, and a value kept over a Google edit is sent), "removed" (a removal that failed earlier is finished), "unlinked" (Google had already deleted the event — call again to create a fresh one). Refused, with the reason, when nothing would happen: a parent with no due time (its marker needs one; a stray event on one is removed), a done or cancelled task (beyond an owed removal), auto-sync off, no due time and no event, no calendar to write to. A Google failure is an error; its text is also stored on the task as gcalSyncError.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const taskId = reqStr(args, 'taskId');
      const before = (await ctx.dispatch('getTask', [taskId])) as Task | null;
      if (!before) throw new Error(`Not found: ${taskId}`);
      const settings = (await ctx.dispatch('getSettings', [])) as Settings;
      // An eventually consistent read, unlike the backend's: a part attached or detached a moment ago
      // can be missed — rare, and the outcome below is still named from what came back.
      const all = (await ctx.dispatch('listTasks', [])) as Task[];
      const parent = hasParts(all, taskId);
      const parentTitle = parentOf(all, before)?.title ?? null;
      // The same planner the backend runs (ensure = the button, parent = it has parts — its event is the
      // due marker), so the outcome is what it decides — a skipped sync never reads as "updated".
      const plan = calendarSyncPlan(null, before, settings, userDueEpoch, {
        ensure: true,
        parent,
        parentTitle,
      });
      if (plan.kind === 'none') {
        // The backend's ensure pass clears a moot failure note without calling Google (sync off, finished,
        // a parent) — run it, so a refusal never leaves a Retry behind that can't do anything.
        if (before.gcalSyncError) await ctx.dispatch('syncCalendarEvent', [taskId]);
        throw new Error(syncRefusal(before, settings, parent));
      }
      const task = (await ctx.dispatch('syncCalendarEvent', [taskId])) as Task;
      if (task.gcalSyncError) throw new Error(task.gcalSyncError);
      // Named from what came back, so a task changed between the read and the sync (finished, sync
      // turned off) never reports a write that didn't happen.
      const was = before.gcalEventId;
      if (!was && !task.gcalEventId)
        throw new Error('Nothing synced — the task changed meanwhile; re-read it and retry.');
      const outcome = !was
        ? 'created'
        : task.gcalEventId
          ? 'updated'
          : plan.kind === 'delete'
            ? 'removed'
            : 'unlinked';
      return { outcome, task };
    },
  },
  {
    name: 'get_day_busy',
    description:
      'Read the shape of a day from the calendar for planning: the longest free stretch and how fragmented the rest is, plus raw busy intervals. day is an ISO date; windowStart/windowEnd are ISO timestamps with offset bounding the focus window.',
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string' },
        windowStart: { type: 'string' },
        windowEnd: { type: 'string' },
      },
      required: ['day', 'windowStart', 'windowEnd'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const day = reqDay(args, 'day');
      const windowStartMs = reqTime(args, 'windowStart');
      const windowEndMs = reqTime(args, 'windowEnd');
      const busy = (await ctx.dispatch('getCalendarBusy', [
        { day, windowStartMs, windowEndMs },
      ])) as CalendarBusy;
      return { shape: computeDayShape(busy, windowStartMs, windowEndMs), busy };
    },
  },
  {
    name: 'list_attachments',
    description:
      'List ready attachments (metadata) for a task, or across all tasks when taskId is omitted.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      additionalProperties: false,
    },
    run: (args, ctx) => ctx.dispatch('listAttachments', [optStr(args, 'taskId')]),
  },
  {
    name: 'attach_file',
    description: `Attach a small text artifact (notes, a spec, a snippet) to a task by sending its content inline as base64. Hard cap ${AGENT_ATTACH_MAX_BYTES} bytes decoded — for a real file (image, PDF), use create_attachment_upload instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        filename: { type: 'string' },
        contentType: { type: 'string', description: 'MIME type, e.g. text/markdown' },
        contentBase64: { type: 'string' },
      },
      required: ['taskId', 'filename', 'contentBase64'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const taskId = reqStr(args, 'taskId');
      const filename = reqStr(args, 'filename');
      const contentType = normalizeContentType(optStr(args, 'contentType'));
      const bytes = Buffer.from(reqStr(args, 'contentBase64'), 'base64');
      if (bytes.length === 0) throw new RpcParamError('contentBase64 decoded to 0 bytes');
      if (bytes.length > AGENT_ATTACH_MAX_BYTES) {
        throw new RpcParamError(
          `attach_file is capped at ${AGENT_ATTACH_MAX_BYTES} bytes (got ${bytes.length}); use create_attachment_upload for a real file`,
        );
      }
      const { attachment, uploadUrl } = (await ctx.dispatch('createAttachmentUploadUrl', [
        { taskId, filename, contentType, size: bytes.length },
      ])) as { attachment: Attachment; uploadUrl: string };
      await ctx.upload(uploadUrl, bytes, contentType);
      return ctx.dispatch('confirmAttachment', [attachment.id]);
    },
  },
  {
    name: 'create_attachment_upload',
    description: `Get a presigned URL to upload a real file (up to ${ATTACHMENT_MAX_BYTES} bytes) to a task. size is the exact byte length (it is signed into the PUT). Then PUT the bytes to uploadUrl and call confirm_attachment. Usable from a shell (curl); claude.ai should use attach_file for small content instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        filename: { type: 'string' },
        contentType: { type: 'string' },
        size: { type: 'integer', minimum: 1 },
      },
      required: ['taskId', 'filename', 'size'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const taskId = reqStr(args, 'taskId');
      const filename = reqStr(args, 'filename');
      const contentType = normalizeContentType(optStr(args, 'contentType'));
      const size = reqInt(args, 'size', 1);
      if (size > ATTACHMENT_MAX_BYTES) {
        throw new RpcParamError(`size ${size} exceeds the ${ATTACHMENT_MAX_BYTES}-byte cap`);
      }
      const { attachment, uploadUrl } = (await ctx.dispatch('createAttachmentUploadUrl', [
        { taskId, filename, contentType, size },
      ])) as { attachment: Attachment; uploadUrl: string };
      return {
        attachmentId: attachment.id,
        uploadUrl,
        expiresInMin: Math.floor(UPLOAD_URL_TTL_MS / 60_000),
        next: `PUT the ${size} bytes to uploadUrl with header "content-type: ${contentType}", then call confirm_attachment with id "${attachment.id}". e.g. curl -T <file> -H "content-type: ${contentType}" "<uploadUrl>"`,
      };
    },
  },
  {
    name: 'confirm_attachment',
    description: 'Confirm an upload (pending → ready) after the bytes have been PUT. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (args, ctx) => ctx.dispatch('confirmAttachment', [reqStr(args, 'id')]),
  },
  {
    name: 'get_attachment_download_url',
    description: 'Get a short-lived download URL for an attachment (mint per view).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    run: (args, ctx) => ctx.dispatch('getAttachmentDownloadUrl', [reqStr(args, 'id')]),
  },
  {
    name: 'delete_attachment',
    description:
      'Delete an attachment: its stored file bytes are deleted (the bucket keeps a noncurrent version for 30 days) and its metadata is tombstoned.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = reqStr(args, 'id');
      await ctx.dispatch('deleteAttachment', [id]);
      return { deleted: id };
    },
  },
  ...FINANCE_TOOLS,
  ...FLUX_TOOLS,
  ...PLACE_TOOLS,
  ...SERIES_TOOLS,
];

// Guard against a duplicate name slipping in (both clients index tools by name).
const seen = new Set<string>();
for (const t of TOOLS) {
  if (seen.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
  seen.add(t.name);
}

export type { ToolContext };
