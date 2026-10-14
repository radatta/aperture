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

export function idsFromCreateResponse(method: string, json: unknown): string[] {
  if (!isCreate(method)) return [];
  if (method === 'createTask') return [idOf(json)].filter((x): x is string => !!x);
  if (method === 'createTasks')
    return Array.isArray(json) ? json.map(idOf).filter((x): x is string => !!x) : [];
  // splitTask → { parent, original, followUp }: a standalone split makes a NEW parent, and the follow-up is
  // always new. The original existed before; it's recorded only if it already was.
  const r = json as { parent?: unknown; followUp?: unknown } | null;
  return [idOf(r?.parent), idOf(r?.followUp)].filter((x): x is string => !!x);
}
