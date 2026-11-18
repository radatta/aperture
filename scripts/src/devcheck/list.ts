// Every scenario the dev check knows, in run order, with its rows and steps — the table DEV-CHECK.md points at
// instead of keeping one (DEV-CHECK.md → Writing a scenario).
//   pnpm --dir scripts exec tsx src/devcheck/list.ts            one line a scenario: order, id, rows, steps
//   pnpm --dir scripts exec tsx src/devcheck/list.ts --json     the fingerprint: ids, rows, step bodies' hashes,
//                                                               and the API/MCP clients' method bodies' hashes
// A refactor that moves code without changing it keeps the --json output identical: diff it before and after.
import { createHash } from 'node:crypto';
import { createApiClient } from './api';
import type { Ledger } from './ledger';
import { createMcpClient } from './mcp';
import type { Scenario } from './scenario';
import { SCENARIOS } from './scenarios';

// Whitespace-blind: moving a function changes its indentation, never its tokens.
const hash = (f: unknown) =>
  createHash('sha256').update(String(f).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

export const fingerprintScenario = (s: Scenario) => ({
  id: s.id,
  title: s.title,
  tiers: s.tiers,
  slowPaths: s.slowPaths ?? null,
  rows: s.rows,
  steps: s.steps.map((x) => ({
    id: x.id,
    title: x.title,
    entry: x.entry,
    proves: x.proves ?? null,
    cost: x.cost ?? null,
    run: hash(x.run),
  })),
});

const methods = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, hash(v)]));

// The clients are built with inert deps: building one sends nothing.
function clients() {
  const ledger: Ledger = { append: () => undefined, read: () => [], has: () => false };
  const fetch = async () => ({ status: 500, text: async () => '' });
  const deps = { fetch, token: () => '', ledger, run: 'list' };
  const api = createApiClient(deps);
  const mcp = createMcpClient(deps);
  return {
    api: { reads: methods(api.reads), writes: methods(api.writes) },
    mcp: { reads: methods(mcp.reads), writes: methods(mcp.writes) },
  };
}

export function fingerprint(all = SCENARIOS) {
  const scenarios = all.map(fingerprintScenario);
  return {
    counts: {
      scenarios: scenarios.length,
      rows: scenarios.reduce((n, s) => n + s.rows.length, 0),
      steps: scenarios.reduce((n, s) => n + s.steps.length, 0),
    },
    order: scenarios.map((s) => s.id),
    scenarios,
    clients: clients(),
  };
}

if (process.argv[1]?.endsWith('list.ts')) {
  const f = fingerprint();
  if (process.argv.includes('--json')) console.log(JSON.stringify(f, null, 2));
  else {
    for (const [i, s] of f.scenarios.entries())
      console.log(
        `${String(i + 1).padStart(2)}  ${s.id.padEnd(24)} ${s.rows.length} rows · ${s.steps.length} steps`,
      );
    console.log(
      `${f.counts.scenarios} scenarios · ${f.counts.rows} rows · ${f.counts.steps} steps`,
    );
  }
}
