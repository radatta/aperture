import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createApiClient } from './api';
import { makeCore as apiCore } from './api/core';
import type { Ledger } from './ledger';
import { fingerprint, fingerprintScenario } from './list';
import { createMcpClient } from './mcp';
import { makeCore as mcpCore } from './mcp/core';
import type { Scenario } from './scenario';
import { SCENARIOS } from './scenarios';

describe('list', () => {
  it('fingerprints every scenario in run order, with the counts', () => {
    const f = fingerprint();
    expect(f.order).toEqual(SCENARIOS.map((s) => s.id));
    expect(f.counts.rows).toBe(SCENARIOS.reduce((n, s) => n + s.rows.length, 0));
    expect(Object.keys(f.clients.api.writes)).toContain('lcSittingStart');
  });

  it('a step’s hash ignores whitespace but not a changed token', () => {
    const sc = (run: Scenario['steps'][number]['run']): Scenario => ({
      id: 'x',
      title: 'x',
      tiers: ['full'],
      rows: [],
      steps: [{ id: 's', title: 's', entry: 'api', run }],
    });
    const a = fingerprintScenario(sc(new Function('return async () => { await 1; }')() as never));
    const b = fingerprintScenario(
      sc(new Function('return async () => {\n      await 1;\n}')() as never),
    );
    const c = fingerprintScenario(sc(new Function('return async () => { await 2; }')() as never));
    expect(a.steps[0]!.run).toBe(b.steps[0]!.run);
    expect(a.steps[0]!.run).not.toBe(c.steps[0]!.run);
  });
});

// The clients are composed from one file an area (api/, mcp/): spreads, so two areas defining one method name would
// silently keep the later — and an area file the composer forgot would never be reachable.
describe('the clients’ areas', () => {
  const ledger: Ledger = { append: () => undefined, read: () => [], has: () => false };
  const deps = {
    fetch: async () => ({ status: 500, text: async () => '' }),
    token: () => '',
    ledger,
    run: 't',
  };

  it.each([
    ['api', createApiClient, apiCore],
    ['mcp', createMcpClient, mcpCore],
  ] as const)(
    '%s: every area’s methods reach the client, and no two areas share a name',
    async (dir, create, core) => {
      const client = create(deps);
      const c = core(deps as never);
      const names = { reads: [] as string[], writes: [] as string[] };
      for (const f of readdirSync(new URL(`./${dir}/`, import.meta.url)).filter(
        (x) => x !== 'core.ts',
      )) {
        const mod = (await import(`./${dir}/${f.replace(/\.ts$/, '')}`)) as Record<string, unknown>;
        for (const [k, fn] of Object.entries(mod)) {
          const kind = k.endsWith('Reads') ? 'reads' : k.endsWith('Writes') ? 'writes' : null;
          if (kind && typeof fn === 'function')
            names[kind].push(...Object.keys((fn as (...a: unknown[]) => object)(c, client.reads)));
        }
      }
      for (const kind of ['reads', 'writes'] as const) {
        expect(
          names[kind].filter((n, i) => names[kind].indexOf(n) !== i),
          `${dir} ${kind}`,
        ).toEqual([]);
        expect(names[kind].sort(), `${dir} ${kind}`).toEqual(Object.keys(client[kind]).sort());
      }
    },
  );

  // makeCore hands out the raw transport (call, rpc): a scenario using it would write outside any `writes` object.
  it('only the clients themselves use makeCore', () => {
    const files = (dir: URL, rel = ''): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory()
          ? files(new URL(`${d.name}/`, dir), `${rel}${d.name}/`)
          : d.name.endsWith('.ts')
            ? [`${rel}${d.name}`]
            : [],
      );
    const users = files(new URL('./', import.meta.url)).filter((f) =>
      /\bmakeCore\b/.test(readFileSync(new URL(f, import.meta.url), 'utf8')),
    );
    expect(users.filter((f) => !/^(api|mcp)(\.ts|\/)/.test(f) && f !== 'list.test.ts')).toEqual([]);
  });
});
