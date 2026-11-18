// The dev check’s MCP client (mcp.ts), tasks: tasks, series, categories, attachments, places, the log and the
// day.
// Its internals come from core.ts under the names the bodies use.
import {
  type CreateSeriesInput,
  type DevAttachment,
  type DevCategory,
  type DevParseResult,
  type DevPlace,
  type DevPlaceDigest,
  type DevSeries,
  type DevTask,
  MCP_CATEGORY_VIA,
  MCP_SERIES_VIA,
} from '../api';
import { DevcheckError } from '../errors';
import type { Reads } from '../mcp';
import {
  type Core,
  type DevDayView,
  type DevLogPage,
  MCP_CREATE_VIA,
  McpRpcError,
  PARAM_ERROR,
  type ToolResult,
} from './core';

export function tasksReads(c: Core) {
  const { data } = c;
  const reads = {
    listTasks: () => data<DevTask[]>('list_tasks'),
    listBacklog: () => data<DevTask[]>('list_backlog'),
    getCalibration: (range: { from: string; to: string }) =>
      data<{ taskId: string; reflection?: string | null }[]>('get_calibration', range),
    listAttachments: (taskId: string) => data<DevAttachment[]>('list_attachments', { taskId }),
    getAttachmentDownloadUrl: (id: string) => data<string>('get_attachment_download_url', { id }),
    listPlaces: () => data<DevPlace[]>('list_places'),
    // list_series: the active ones, or every one with includeStopped (a stopped series stays, inactive).
    listSeries: (includeStopped = false) =>
      data<DevSeries[]>('list_series', includeStopped ? { includeStopped: true } : {}),
    listCategories: () => data<DevCategory[]>('list_categories'),
    parseTask: (text: string) => data<DevParseResult>('parse_task', { text }), // the real model; writes nothing
    // The digest plus each errand's id and status (lambdas/src/mcp/placeTools.ts) — a pure read, no heartbeat.
    listPlaceTasks: (place: string) =>
      data<DevPlaceDigest & { tasks: { id: string; title: string; status: string }[] }>(
        'list_place_tasks',
        { place },
      ),
    // The Log tools (lambdas/src/mcp/logTools.ts): pure reads. Args go as given — the param-error rows
    // send bad ones on purpose.
    searchLog: (args: Record<string, unknown>) => data<DevLogPage>('search_log', args),
    listLog: (args: Record<string, unknown>) => data<DevLogPage>('list_log', args),
    getDay: (args: Record<string, unknown>) => data<DevDayView>('get_day', args),
    listStories: () =>
      data<{
        stories: { id: string; title: string; situation: string; competencies: string[] }[];
        note?: string;
      }>('list_stories', {}),
  };
  return reads;
}

export function tasksWrites(c: Core, reads: Reads) {
  const { ledger, run, tool, data, assertLedger, assertLedgerTask } = c;
  const writes = {
    async createTask(input: {
      title: string;
      estimateMin?: number;
      place?: string | null;
    }): Promise<DevTask> {
      ledger.append({ run, op: 'intent', via: MCP_CREATE_VIA, title: input.title });
      const task = await data<DevTask>('create_task', input);
      ledger.append({ run, op: 'created', id: task.id, via: MCP_CREATE_VIA, title: input.title });
      return task;
    },
    // A create_task the server must refuse (bff-shapes: a title over the BFF's cap), ledgered like a create:
    // an execution error resolves the intent as `refused`; a create a regression let through is recorded
    // and cleaned like any other. Returns the tool's answer for the step to read.
    async createTaskExpectingRefusal(input: { title: string }): Promise<ToolResult> {
      ledger.append({ run, op: 'intent', via: MCP_CREATE_VIA, title: input.title });
      const r = await tool('create_task', input);
      if (r.isError) ledger.append({ run, op: 'refused', via: MCP_CREATE_VIA, title: input.title });
      else {
        const task = JSON.parse(r.text) as DevTask;
        ledger.append({ run, op: 'created', id: task.id, via: MCP_CREATE_VIA, title: input.title });
      }
      return r;
    },
    // Patch fields on a task this run created (update_task: place moves it between errand lists; the
    // reflection scenario sets one up for complete_task to keep; the iOS scenario starts one, since the sim
    // never taps Start).
    async updateTask(
      id: string,
      patch: {
        place?: string | null;
        reflection?: string | null;
        estimateMin?: number;
        status?: 'in_progress' | 'done';
      },
    ): Promise<DevTask> {
      assertLedgerTask(id);
      return data<DevTask>('update_task', { id, ...patch });
    },
    // Mark one of this run's tasks done. actualMin is optional only where the server allows it (an errand,
    // a parent) — omitted here, it is left out of the call, never sent as null; so is an omitted reflection
    // or estimate.
    async completeTask(
      id: string,
      actualMin?: number,
      reflection?: string | null,
      estimateMin?: number,
    ): Promise<{ task: DevTask; previousActualMin: number | null }> {
      assertLedgerTask(id);
      return data('complete_task', {
        id,
        ...(actualMin === undefined ? {} : { actualMin }),
        ...(reflection === undefined ? {} : { reflection }),
        ...(estimateMin === undefined ? {} : { estimateMin }),
      });
    },
    // Split one of this run's tasks; what it creates is recorded from the response, so cleanup can remove it.
    async splitTask(
      id: string,
      input: {
        finish: 'done' | 'keep';
        followUpTitle: string;
        actualMin?: number;
        estimateMin?: number;
      },
    ): Promise<{ parent: DevTask; original: DevTask; followUp: DevTask }> {
      assertLedgerTask(id);
      const out = await data<{ parent: DevTask; original: DevTask; followUp: DevTask }>(
        'split_task',
        { id, ...input },
      );
      for (const t of [out.parent, out.followUp])
        ledger.append({ run, op: 'created', id: t.id, via: MCP_CREATE_VIA, title: t.title });
      return out;
    },
    // Deleting a parent deletes its parts, so a recorded parent with a part the ledger doesn't know is
    // refused, as the pipeline's cleanup does. A task already gone answers Not found — returned, not thrown.
    async deleteTask(
      id: string,
    ): Promise<{ deleted: string; parts: string[] } | { notFound: true }> {
      assertLedgerTask(id);
      const unknownParts = (await reads.listTasks()).filter(
        (t) => t.parentId === id && !ledger.has(t.id),
      );
      if (unknownParts.length)
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete ${id} — it has parts the ledger never recorded`,
        );
      const r = await tool('delete_task', { id });
      if (r.isError && /^Not found/.test(r.text)) return { notFound: true };
      if (r.isError) throw new Error(`mcp delete_task: ${r.text}`);
      const out = JSON.parse(r.text) as { deleted: string; parts?: string[] };
      return { deleted: out.deleted, parts: out.parts ?? [] };
    },
    // create_series: intent, then the server's id (the series counts from the user's today, server-side). A
    // param error (-32602) is raised before any dispatch, so it resolves the intent as `refused`; any other
    // failure leaves the intent open — the create may have landed.
    async createSeries(input: CreateSeriesInput): Promise<DevSeries> {
      ledger.append({ run, op: 'intent', via: MCP_SERIES_VIA, title: input.title });
      let s: DevSeries;
      try {
        s = await data<DevSeries>('create_series', { ...input });
      } catch (err) {
        if (err instanceof McpRpcError && err.code === PARAM_ERROR)
          ledger.append({ run, op: 'refused', via: MCP_SERIES_VIA, title: input.title });
        throw err;
      }
      ledger.append({ run, op: 'created', id: s.id, via: MCP_SERIES_VIA, title: input.title });
      return s;
    },
    // stop_series on a series this harness created; cleanup still deletes it by id (api.ts deleteSeries).
    // An id the ledger never recorded is refused here; one the server doesn't have throws its text.
    async stopSeries(id: string): Promise<DevSeries> {
      assertLedger(id, 'series');
      return data<DevSeries>('stop_series', { id });
    },
    // The server's answer to stop_series for an id that isn't the user's — no ledger check, since the point is
    // that the server refuses it; the harness only ever names ids no row can have.
    stopSeriesUnknown: (id: string) => tool('stop_series', { id }),
    // create_category, ledgered like create_task (the areas scenario proves `area` on create); cleaned by the
    // API's deleteCategory on the recorded id.
    async createCategory(input: {
      label: string;
      isWork: boolean;
      area?: DevCategory['area'];
    }): Promise<DevCategory> {
      ledger.append({ run, op: 'intent', via: MCP_CATEGORY_VIA, title: input.label });
      const cat = await data<DevCategory>('create_category', input);
      ledger.append({ run, op: 'created', id: cat.id, via: MCP_CATEGORY_VIA, title: input.label });
      return cat;
    },
    // Patch a category this run created (update_category) — the areas scenario sets its area over MCP.
    async updateCategory(
      id: string,
      patch: { label?: string; isWork?: boolean; area?: DevCategory['area'] },
    ): Promise<DevCategory> {
      assertLedger(id, 'category');
      return data<DevCategory>('update_category', { id, ...patch });
    },
    // Only an attachment the server lists on one of this run's tasks.
    async deleteAttachment(taskId: string, id: string): Promise<{ deleted: string }> {
      assertLedgerTask(taskId);
      if (!(await reads.listAttachments(taskId)).some((a) => a.id === id))
        throw new DevcheckError(
          'LEDGER_GUARD',
          `refusing to delete attachment ${id} — not on recorded task ${taskId}`,
        );
      return data<{ deleted: string }>('delete_attachment', { id });
    },

    // The LeetCode coach's writes (lambdas/src/mcp/coachTools.ts). Args go as given — the param-error rows send
    // bad ones on purpose. An attempt is recorded from the answer; a slot change before the call (coachSlotId).
  };
  return writes;
}
