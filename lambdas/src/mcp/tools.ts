import {
  ATTACHMENT_MAX_BYTES,
  TASK_NOTES_MAX,
  UPLOAD_URL_TTL_MS,
  computeDayShape,
  isDayKey,
  isTimeKey,
  normalizeContentType,
  normalizeNotes,
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
  'deadline clock time HH:MM (24h) in the user\'s local time (America/Los_Angeles) on dueDay — "due Friday 4pm" is dueDay + dueTime "16:00". Needs a dueDay. A timed task is added to Google Calendar automatically when that is on (an event ending at the deadline, as long as the estimate); a sync failure shows as gcalSyncError on the returned task';
// Notes are checked here, before any dispatch, so an over-cap note is a param error that lands nothing —
// not a half-applied update_task. The value passed on is already normalized (trim, '' → null).
function nullableNotes(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v !== null && v !== undefined && typeof v !== 'string')
    throw new RpcParamError(`"${key}" must be a string or null`);
  try {
    return normalizeNotes(v);
  } catch (e) {
    throw new RpcParamError(`"${key}": ${e instanceof Error ? e.message : 'invalid'}`);
  }
}
const NOTES_SCHEMA_DESC = `light markdown (**bold**, *italic*, \`code\`, - bullets, 1. lists, [text](https://…), bare URLs; newlines kept), at most ${TASK_NOTES_MAX} characters after trimming (the server checks)`;

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

// --- the tools -----------------------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: 'list_tasks',
    description:
      'List all live tasks (any status), newest first. Optionally filter by status (backlog, planned, in_progress, done, cancelled).',
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
      return status ? tasks.filter((t) => t.status === status) : tasks;
    },
  },
  {
    name: 'list_backlog',
    description: 'List backlog tasks (status = backlog), newest first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, ctx) => ctx.dispatch('listBacklog', []),
  },
  {
    name: 'create_task',
    description:
      'Create one backlog task. categoryId comes from list_categories (a label will not resolve). estimateMin/bufferMin are minutes; dueDay is an ISO date (YYYY-MM-DD); dueTime is an optional HH:MM deadline time on that day; notes is free-form context (light markdown). The estimate stays editable until the task is done or cancelled.',
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
      },
      required: ['title'],
      additionalProperties: false,
    },
    run(args, ctx) {
      const input: CreateTaskInput = { title: reqStr(args, 'title') };
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
      'Bulk-create many backlog tasks in order (one shared timestamp so they sort together). Each task takes the same fields as create_task. All-or-nothing on invalid input: one bad task (e.g. notes over the cap) creates none. Use this for a study plan or a session backlog dump.',
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
        return input;
      });
      return ctx.dispatch('createTasks', [inputs]);
    },
  },
  {
    name: 'update_task',
    description:
      'Patch fields on a task: title, categoryId (null clears), dueDay (null clears the day AND its time; ISO date; a new day keeps the current time), dueTime (HH:MM 24h local deadline time; null clears; needs a dueDay on the task or in the same call), notes (REPLACES the whole note; null or "" clears; editable at any status), estimateMin and/or bufferMin (either alone keeps the other), status. Fields apply in order title→categoryId→due→notes→estimate→status. On a task with a linked Google Calendar event, title/due/estimate changes move or rename the event. estimateMin is the working estimate, editable until the task is done or cancelled (then it errors); the calibration baseline frozen when work started is separate and never moves. If only part of the work is finished, use split_task. Setting status uses the transition rules (done is only reachable from in_progress; prefer complete_task).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        categoryId: { type: ['string', 'null'] },
        dueDay: { type: ['string', 'null'], description: 'ISO date YYYY-MM-DD, or null to clear' },
        dueTime: { type: ['string', 'null'], description: `${DUE_TIME_DESC}; null clears` },
        notes: {
          type: ['string', 'null'],
          description: `${NOTES_SCHEMA_DESC}; replaces the whole note, null clears`,
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
        'dueDay',
        'dueTime',
        'notes',
        'estimateMin',
        'bufferMin',
        'status',
      ];
      if (!fields.some((f) => present(args, f))) {
        throw new RpcParamError('update_task needs at least one field to change');
      }
      const notes = present(args, 'notes') ? nullableNotes(args, 'notes') : undefined; // before any write
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
      'Mark a task done and record how long it ACTUALLY took (actualMin, minutes). This is what feeds calibration, so actualMin is required — never guess a round number silently, ask the user if unsure. Chains through in_progress if needed (which freezes the calibration baseline). If only part of the task is finished, use split_task instead. actualMin REPLACES any timer-tracked minutes; the previous value is returned so an overwrite is visible.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        actualMin: { type: 'integer', minimum: 1, description: 'actual minutes the task took' },
      },
      required: ['id', 'actualMin'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = reqStr(args, 'id');
      const actualMin = reqInt(args, 'actualMin', 1);
      const task = (await ctx.dispatch('getTask', [id])) as Task | null;
      if (!task) throw new Error(`Not found: ${id}`);
      if (task.status === 'done' || task.status === 'cancelled') {
        throw new Error(`Task is already ${task.status}`);
      }
      const previousActualMin = task.actualAccruedMin;
      if (task.status === 'backlog' || task.status === 'planned') {
        await ctx.dispatch('transitionTask', [id, 'in_progress']);
      }
      await ctx.dispatch('setTaskActual', [id, actualMin]);
      const done = (await ctx.dispatch('transitionTask', [id, 'done'])) as Task;
      return { task: done, previousActualMin };
    },
  },
  {
    name: 'split_task',
    description:
      'Split a task in two when the work turned out bigger, or part of it is finished: this part either finishes (finish="done" — only for a started task; actualMin is required and feeds calibration, so ask the user, never guess) or keeps going (finish="keep"), and the rest becomes a new task (followUpTitle, followUpEstimateMin). Optional title/estimateMin/bufferMin rename or rescope this part. The new task keeps the category, deadline, notes and roll; it lands on this task\'s latest plan day when this task is planned or in progress (else the backlog), and links back to it (splitFromId) only if this task had started work (or is itself a split part) — its split family is left out of calibration until it can be scored as one. Nothing is cancelled. Returns { original, followUp }.',
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
        title: { type: 'string', description: "this part's new title; omitted keeps it" },
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
      if (present(args, 'estimateMin')) input.estimateMin = reqInt(args, 'estimateMin', 0);
      if (present(args, 'bufferMin')) input.bufferMin = reqInt(args, 'bufferMin', 0);
      return ctx.dispatch('splitTask', [reqStr(args, 'id'), input]);
    },
  },
  {
    name: 'delete_task',
    description:
      'Permanently delete a task (no restore tool). Also removes its day plans and attachments, DELETES its linked Google Calendar event if it has one, and its logged time stops counting toward calibration. Refused for a recurring occurrence (seriesId set) — the series would just respawn it. To abandon a task while keeping its history, use update_task status=cancelled instead.',
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
      await ctx.dispatch('deleteTask', [id]);
      return { deleted: id };
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
      'Calibration points (frozen estimate vs actual) for completed tasks in a date range. from/to are ISO dates (YYYY-MM-DD), inclusive. Tasks split after work started (a split family) are excluded for now — they will be scored as one family. This is the signature metric — use it to advise better estimates.',
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
      'Create a Google Calendar event linked to a task (a task can hold one event). start is an ISO timestamp WITH offset; give either end (ISO) or durationMin. accountSub/calendarId default to the write-default (see list_calendars); title defaults to the task title. For a task with no due time: a manual time block — renaming it in Google renames the task; its time maps to no task field. Refused on a task with a due time while auto-sync is on (with a calendar to write to): that task’s block is placed at its deadline automatically, so change the due time with update_task instead. On error, re-read the task before retrying — the event may already exist.',
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
        title = task.title;
      }
      return ctx.dispatch('insertCalendarEvent', [
        { taskId, accountSub, calendarId, title, startMs, endMs },
      ]);
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete the Google Calendar event linked to a task. This is a REAL delete in Google Calendar, but only ever of an event Aperture created for this task — it cannot touch any other calendar event.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: (args, ctx) => ctx.dispatch('deleteCalendarEvent', [reqStr(args, 'taskId')]),
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
    description: 'Soft-delete an attachment (recoverable tombstone; the S3 bytes are orphaned).',
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
];

// Guard against a duplicate name slipping in (both clients index tools by name).
const seen = new Set<string>();
for (const t of TOOLS) {
  if (seen.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
  seen.add(t.name);
}

export type { ToolContext };
