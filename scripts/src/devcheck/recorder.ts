// Tasks the UI creates get their ids from the server's responses: the browser's POST /api/<create> replies
// are read here and appended to the ledger, so cleanup can delete them by id like any API-made task. A
// place, category or recurring series added in the app (upsertPlace / upsertCategory / upsertSeries with no id) is
// recorded the same way; an upsert naming an id is an edit of an existing row and is never recorded — cleanup would
// delete a row the run didn't make.
// A push device Settings' Enable subscribed (subscribePush) is recorded by the id the server answered with,
// so cleanup removes it like one the API subscribed.
export const CREATE_METHODS = [
  'createTask',
  'createTasks',
  'splitTask',
  'upsertPlace',
  'upsertSeries',
  'upsertCategory',
  'subscribePush',
  'createLogEntry',
] as const;
const UPSERTS: readonly string[] = ['upsertPlace', 'upsertSeries', 'upsertCategory'];
type CreateMethod = (typeof CREATE_METHODS)[number];

const isCreate = (m: string): m is CreateMethod =>
  (CREATE_METHODS as readonly string[]).includes(m);
const idOf = (v: unknown): string | undefined =>
  v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string'
    ? (v as { id: string }).id
    : undefined;

// The method a POST /api/<method> URL names, or undefined.
export function methodOf(url: string): string | undefined {
  const m = /\/api\/([A-Za-z]+)(?:[/?#]|$)/.exec(new URL(url).pathname);
  return m?.[1];
}

// Whether this POST creates: always, except an upsert whose input names an id (an edit). A body that can't be
// read isn't recorded — the run's end-of-run place/category check then reports the row as appeared.
export function isCreateRequest(method: string, postData: string | null): boolean {
  if (!isCreate(method)) return false;
  if (!UPSERTS.includes(method)) return true;
  try {
    const input = (JSON.parse(postData ?? '') as { args?: unknown[] }).args?.[0];
    return !!input && typeof input === 'object' && (input as { id?: unknown }).id === undefined;
  } catch {
    return false;
  }
}

// `ownsSplitParent(original, parent)` guards the split: deleting a parent deletes its parts, so a split's parent
// is recorded only when the split task was ours AND the parent didn't exist before the run (pipeline.ts). The
// MCP hook's rule is the same idea from what it can see (.claude/hooks/mcp-dev-ledger.sh); cleanup also checks
// the server for unknown parts before every delete.
export function idsFromCreateResponse(
  method: string,
  json: unknown,
  ownsSplitParent: (original: string, parent: string) => boolean = () => false,
): string[] {
  if (!isCreate(method)) return [];
  if (
    method === 'createTask' ||
    method === 'subscribePush' ||
    method === 'createLogEntry' ||
    UPSERTS.includes(method)
  )
    return [idOf(json)].filter((x): x is string => !!x);
  if (method === 'createTasks')
    return Array.isArray(json) ? json.map(idOf).filter((x): x is string => !!x) : [];
  // splitTask → { parent, original, followUp }: the follow-up is always new.
  const r = json as { parent?: unknown; original?: unknown; followUp?: unknown } | null;
  const original = idOf(r?.original);
  const parentId = idOf(r?.parent);
  const parent = original && parentId && ownsSplitParent(original, parentId) ? parentId : undefined;
  return [parent, idOf(r?.followUp)].filter((x): x is string => !!x);
}
