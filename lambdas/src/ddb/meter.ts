import { AsyncLocalStorage } from 'node:async_hooks';
import { isApiMethod, isDevSlot } from '@aperture/shared';

// The dev slots' DynamoDB read-cost meter (docs/ops/DEV-CHECK.md → Read cost). A metered LiveDoc asks each call for
// its ConsumedCapacity and records it here; the metered handler writes ONE `ddb_units` line per request into the
// function's existing log group, which `pnpm devcheck:cost` reads back. Off the dev slots nothing is wrapped and
// LiveDoc's requests are byte-identical to an unmetered build. The line carries kinds and counts only — never a PK,
// an id, a title or request text: a fetched log file is a public artifact for a day.

// q query, g get, x GSI query, p put, d delete, u update, b batchWrite.
export type Verb = 'q' | 'g' | 'x' | 'p' | 'd' | 'u' | 'b';
const READS: ReadonlySet<Verb> = new Set(['q', 'g', 'x']);

type Entry = [calls: number, units: number, items: number, dead: number];
export interface Tally {
  ru: number;
  wu: number;
  n: number;
  by: Map<string, Entry>;
}

// Per request, never a module counter: interleaved requests (tests, the local edge) must not share a tally.
const store = new AsyncLocalStorage<Tally>();

// The sort key's leading letters-only segment (`task#…` → task, `settings` → settings); an id-first or unknown
// shape reads `other`, so an id can't reach the line.
export const skKind = (sk: string): string => /^([a-z]{2,16})(?:#|$)/.exec(sk)?.[1] ?? 'other';
// A GSI1PK's key space (`u#<id>#done` → done), from the fixed set keys.ts's gsi1 builds; anything else reads
// `other`, so a future key space ending in user text can't reach the line.
const INDEX_KINDS = new Set(['done', 'remind', 'fintxn']);
export const indexKind = (gsi1pk: string): string => {
  const last = gsi1pk.slice(gsi1pk.lastIndexOf('#') + 1);
  return INDEX_KINDS.has(last) ? last : 'other';
};

export interface Call {
  verb: Verb;
  kind: string;
  units: number;
  consistent?: boolean;
  items?: number; // rows returned (reads)
  dead?: number; // of those, rows with deletedAt set (tombstones)
}

// A no-op outside a metered request (workers, an unmetered stage).
export function record(c: Call): void {
  const t = store.getStore();
  if (!t) return;
  const key = `${c.verb}${c.consistent ? 'c' : ''}:${c.kind}`;
  const e = t.by.get(key) ?? [0, 0, 0, 0];
  e[0] += 1;
  e[1] += c.units;
  e[2] += c.items ?? 0;
  e[3] += c.dead ?? 0;
  t.by.set(key, e);
  if (READS.has(c.verb)) t.ru += c.units;
  else t.wu += c.units;
  t.n += 1;
}

const TOP = 8;
const round = (n: number) => Math.round(n * 1000) / 1000;

export interface UnitsLine {
  event: 'ddb_units';
  v: 1;
  edge: 'bff' | 'mcp';
  op: string;
  status: number | 'threw';
  at: number; // epoch ms at the handler's start — the reader's step attribution
  ms: number;
  ru: number;
  wu: number;
  n: number;
  by: [string, ...Entry][];
}

export function unitsLine(
  edge: 'bff' | 'mcp',
  op: string,
  status: number | 'threw',
  at: number,
  ms: number,
  t: Tally,
): UnitsLine {
  const sorted = [...t.by.entries()].sort((a, b) => b[1][1] - a[1][1] || a[0].localeCompare(b[0]));
  const by: [string, ...Entry][] = sorted
    .slice(0, TOP)
    .map(([k, e]) => [k, e[0], round(e[1]), e[2], e[3]]);
  const rest = sorted.slice(TOP);
  if (rest.length) {
    const sum = rest.reduce<Entry>(
      (s, [, e]) => [s[0] + e[0], s[1] + e[1], s[2] + e[2], s[3] + e[3]],
      [0, 0, 0, 0],
    );
    by.push(['other', sum[0], round(sum[1]), sum[2], sum[3]]);
  }
  return {
    event: 'ddb_units',
    v: 1,
    edge,
    op,
    status,
    at,
    ms,
    ru: round(t.ru),
    wu: round(t.wu),
    n: t.n,
    by,
  };
}

export interface MeterOpts {
  log?: (line: string) => void;
  now?: () => number;
}

// Runs each request in a fresh tally and logs its line when the handler returns or throws (the error still
// propagates). A timeout kills the environment first, so the reader counts REPORT lines with no units line.
export function metered<E, R extends { statusCode: number }>(
  edge: 'bff' | 'mcp',
  opOf: (event: E) => string,
  handler: (event: E) => Promise<R>,
  { log = (l) => console.log(l), now = Date.now }: MeterOpts = {},
): (event: E) => Promise<R> {
  return (event) => {
    const t: Tally = { ru: 0, wu: 0, n: 0, by: new Map() };
    const at = now();
    let op = 'unknown';
    try {
      op = opOf(event);
    } catch {
      // a label is never worth failing the request
    }
    return store.run(t, async () => {
      let status: number | 'threw' = 'threw';
      try {
        const res = await handler(event);
        status = res.statusCode;
        return res;
      } finally {
        log(JSON.stringify(unitsLine(edge, op, status, at, now() - at, t)));
      }
    });
  };
}

// The same function object off the dev slots (prod, an unset or unknown stage): nothing changes there.
export const wrapIfDev = <E, R extends { statusCode: number }>(
  stage: string | undefined,
  edge: 'bff' | 'mcp',
  opOf: (event: E) => string,
  handler: (event: E) => Promise<R>,
  opts?: MeterOpts,
): ((event: E) => Promise<R>) => (isDevSlot(stage) ? metered(edge, opOf, handler, opts) : handler);

// The BFF's op label: the API method, a fixed name for the routes outside the RPC dispatch, else `unknown` — so
// no path text reaches the line.
const BFF_ROUTES = new Set(['health', 'capture', 'places', 'google']);
export function bffOp(event: {
  rawPath?: string;
  requestContext?: { http?: { path?: string; method?: string } };
}): string {
  if (event.requestContext?.http?.method === 'OPTIONS') return 'options';
  const path = event.rawPath ?? event.requestContext?.http?.path ?? '';
  const method = path.split('/api/')[1]?.split('/')[0] ?? '';
  if (isApiMethod(method)) return method;
  return BFF_ROUTES.has(method) ? method : 'unknown';
}
