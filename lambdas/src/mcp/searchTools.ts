import { partsOf, partsSummary } from '@aperture/shared';
import type { Task, TaskStatus } from '@aperture/shared';
import { QUERY_MAX, limitArg, optDay, queryArg } from './logTools';
import { RpcParamError } from './types';
import type { Tool } from './types';

// Finding a task without pulling every task's full record (docs/areas/mcp/index.md → Finding a task). Both
// list_tasks' compact form and search_tasks read the one listTasks the list tools make, filtered in memory.

export const TASK_STATUSES: TaskStatus[] = [
  'backlog',
  'planned',
  'in_progress',
  'done',
  'cancelled',
];

const SEARCH_LIMIT = { def: 25, max: 50 };
const SNIPPET_SIDE = 60;
const KEYS = new Set(['query', 'status', 'categoryId', 'dueFrom', 'dueTo', 'limit']);

// A parent's progress on each listed task, from the full list (parts.ts): { total, done, estimateMin }.
export function withParts(shown: Task[], all: Task[]) {
  return shown.map((t) => {
    const parts = partsOf(all, t.id);
    if (!parts.length) return t;
    const { total, done, estimateMin } = partsSummary(parts);
    return { ...t, parts: { total, done, estimateMin } };
  });
}

// The same eight keys on every row, null when unset (older rows read dueTime/parentId back undefined); a
// parent keeps its parts summary, since its own estimate is null.
export function compactRows(shown: Task[], all: Task[]) {
  return withParts(shown, all).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    dueDay: t.dueDay ?? null,
    dueTime: t.dueTime ?? null,
    estimateMin: t.estimateMin ?? null,
    categoryId: t.categoryId ?? null,
    parentId: t.parentId ?? null,
    ...('parts' in t ? { parts: t.parts } : {}),
  }));
}

function statusArg(args: Record<string, unknown>): TaskStatus[] | undefined {
  const v = args.status;
  if (v === undefined || v === null) return undefined;
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.some((s) => !TASK_STATUSES.includes(s as TaskStatus)))
    throw new RpcParamError(
      `"status" must be one of ${TASK_STATUSES.join(', ')}, or a non-empty list of them`,
    );
  return list as TaskStatus[];
}
function categoryArg(args: Record<string, unknown>): string | undefined {
  const v = args.categoryId;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v)
    throw new RpcParamError('"categoryId" must be an id from list_categories');
  return v;
}

// The notes around the earliest query word, whitespace collapsed, at most SNIPPET_SIDE characters either
// side; a cut never splits a surrogate pair (surrogate-safe, not grapheme-safe: a joined emoji can lose a part).
// The hit is found in the lowercased text, which a rare letter lengthens (İ), shifting the window a little.
export function notesSnippet(notes: string, words: string[]): string | undefined {
  const flat = notes.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const hits = words.map((w) => ({ at: lower.indexOf(w), len: w.length })).filter((h) => h.at >= 0);
  if (!hits.length) return undefined;
  const first = hits.reduce((a, b) => (b.at < a.at ? b : a));
  let start = Math.max(0, first.at - SNIPPET_SIDE);
  let end = Math.min(flat.length, first.at + first.len + SNIPPET_SIDE);
  if (start > 0 && isLow(flat.charCodeAt(start))) start++;
  if (end < flat.length && isLow(flat.charCodeAt(end))) end--;
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

export const SEARCH_TOOLS: Tool[] = [
  {
    name: 'search_tasks',
    description: `Find tasks by words in their title or notes, without pulling every task's full record — use this instead of list_tasks whenever you are looking for particular tasks. query is split on spaces and every word must appear (case-insensitive, any order, as part of a word is fine) in the title or the notes: use one to three distinctive words, not a sentence. Optional filters narrow it: status (one status or a list of them), categoryId (from list_categories), dueFrom/dueTo (ISO dates, inclusive; with either set, a task without a due day never matches). Returns { query, totalMatches, more, tasks }, newest first, at most limit rows (default ${SEARCH_LIMIT.def}, max ${SEARCH_LIMIT.max}); more is true when totalMatches is over the rows returned — then add a word or a filter, or raise limit. Each row is { id, title, status, dueDay, dueTime, estimateMin, categoryId, parentId } (null when unset); a parent (a task with parts) adds parts: { total, done, estimateMin }; when the notes held a query word, notesSnippet is a short excerpt around it. Full notes are not returned here: list_tasks without compact carries them. A task created a moment ago can take a second to show up.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: `1–${QUERY_MAX} characters: the words to find` },
        status: {
          anyOf: [
            { type: 'string', enum: TASK_STATUSES },
            { type: 'array', items: { type: 'string', enum: TASK_STATUSES }, minItems: 1 },
          ],
          description: 'optional: one status, or a list of them',
        },
        categoryId: { type: 'string', description: 'optional: a category id from list_categories' },
        dueFrom: { type: 'string', description: 'optional: YYYY-MM-DD, inclusive' },
        dueTo: { type: 'string', description: 'optional: YYYY-MM-DD, inclusive' },
        limit: {
          type: 'integer',
          description: `1–${SEARCH_LIMIT.max}, default ${SEARCH_LIMIT.def}`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      // Every check before the read: a refused call costs no read.
      const extra = Object.keys(args).filter((k) => !KEYS.has(k));
      if (extra.length) throw new RpcParamError(`Unknown argument: ${extra.join(', ')}`);
      const query = queryArg(args);
      const statuses = statusArg(args);
      const categoryId = categoryArg(args);
      const dueFrom = optDay(args, 'dueFrom');
      const dueTo = optDay(args, 'dueTo');
      if (dueFrom !== undefined && dueTo !== undefined && dueFrom > dueTo)
        throw new RpcParamError('"dueFrom" must be on or before "dueTo"');
      const limit = limitArg(args, SEARCH_LIMIT);
      const words = query.toLowerCase().split(/\s+/);
      const all = (await ctx.dispatch('listTasks', [])) as Task[];
      const hits = all.filter((t) => {
        if (statuses && !statuses.includes(t.status)) return false;
        if (categoryId !== undefined && t.categoryId !== categoryId) return false;
        if (dueFrom !== undefined || dueTo !== undefined) {
          if (!t.dueDay) return false;
          if (dueFrom !== undefined && t.dueDay < dueFrom) return false;
          if (dueTo !== undefined && t.dueDay > dueTo) return false;
        }
        const title = t.title.toLowerCase();
        const notes = (t.notes ?? '').toLowerCase();
        return words.every((w) => title.includes(w) || notes.includes(w));
      });
      const shown = hits.slice(0, limit);
      const rows = compactRows(shown, all).map((row, i) => {
        const snippet = shown[i]!.notes ? notesSnippet(shown[i]!.notes!, words) : undefined;
        return snippet === undefined ? row : { ...row, notesSnippet: snippet };
      });
      return { query, totalMatches: hits.length, more: hits.length > shown.length, tasks: rows };
    },
  },
];
