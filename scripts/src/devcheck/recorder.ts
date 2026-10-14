// Tasks the UI creates get their ids from the server's responses: the browser's POST /api/<create> replies
// are read here and appended to the ledger, so cleanup can delete them by id like any API-made task.
export const CREATE_METHODS = ['createTask', 'createTasks', 'splitTask'] as const;
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

// `isRecorded` guards the split: deleting a parent deletes its parts, so a split's parent is recorded only
// when the split task was ours (then its parent is ours or new). Same rule as .claude/hooks/mcp-dev-ledger.sh.
export function idsFromCreateResponse(
  method: string,
  json: unknown,
  isRecorded: (id: string) => boolean = () => false,
): string[] {
  if (!isCreate(method)) return [];
  if (method === 'createTask') return [idOf(json)].filter((x): x is string => !!x);
  if (method === 'createTasks')
    return Array.isArray(json) ? json.map(idOf).filter((x): x is string => !!x) : [];
  // splitTask → { parent, original, followUp }: the follow-up is always new.
  const r = json as { parent?: unknown; original?: unknown; followUp?: unknown } | null;
  const original = idOf(r?.original);
  const parent = original && isRecorded(original) ? idOf(r?.parent) : undefined;
  return [parent, idOf(r?.followUp)].filter((x): x is string => !!x);
}
