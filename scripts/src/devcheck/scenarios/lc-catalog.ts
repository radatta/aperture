// The full LeetCode catalog (docs/areas/recruiting/coach.md → The catalog): a capped import from the pinned public
// dataset (on dev: the worker fetches it and Sonnet classifies a few late rows a kick, under the stage's $0.25 stop;
// locally: the synthetic fixture, model off), an uploaded class, then what reads see — the record of an off-list
// problem, get_problem, the Problem page, the plan still NeetCode 150's. The catalog is stage-wide public metadata,
// not the test user's data: it isn't ledgered and stays for the next run. The one off-list problem is
// palindrome-number (number 9, on dev's source and the local fixture alike); its attempt is ledgered and deleted.
import type { DevCatalogStatus } from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';

const OFF = 'palindrome-number';
const OFF_CLASS = '9\tmath-geometry\t-\t-'; // one uploaded line: number, pattern, similar, harder
const LIMIT = 300; // problems beside NeetCode's: dev's import stays quick and its worker slot free
const SETTLE_MS = 120_000;
const fail = (msg: string): never => {
  throw new Error(msg);
};

// Polls until no job holds the claim; a failed import fails the step with its error.
async function settled(read: () => Promise<DevCatalogStatus>, since: number | null) {
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const s = await read();
    if (s.state === 'failed' || (s.lastError && s.state !== 'running'))
      fail(`the import failed: ${s.lastError}`);
    if ((s.state === 'ready' || s.state === 'partial') && (s.importedAt ?? 0) > (since ?? 0))
      return s;
    if (Date.now() > until) fail(`the import never settled: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
function sane(s: DevCatalogStatus) {
  const by = s.by ?? fail('no classifier counts');
  const sum = by.neetcode + by.rule + by.model + by.tags;
  // The exact pinned URL is import.test.ts's to prove (scripts doesn't depend on shared); here, a whole commit sha.
  if (!/^[0-9a-f]{40}$/.test(s.sha ?? '')) fail(`built from ${s.sha}, not a pinned commit`);
  if (sum !== s.count) fail(`the counts don’t add up: ${JSON.stringify(s)}`);
  if (by.neetcode < 1 || s.count <= by.neetcode)
    fail(`nothing beyond NeetCode: ${JSON.stringify(s)}`);
}
let imported: DevCatalogStatus;

export const lcCatalog: Scenario = {
  id: 'lc-catalog',
  title: 'The full LeetCode catalog: import, an uploaded class, and what reads see',
  tiers: ['full'],
  rows: [
    {
      id: 'api-import',
      entry: 'api',
      kind: 'nominal',
      what: 'An import from the pinned commit settles ready or partial, with problems beyond NeetCode 150 and counts that add up',
    },
    {
      id: 'api-upload',
      entry: 'api',
      kind: 'nominal',
      what: 'An uploaded classification line sets that problem’s pattern',
    },
    {
      id: 'api-refused',
      entry: 'api',
      kind: 'edge',
      what: 'A malformed import (limit 0, part beyond parts) is refused before any write',
    },
    {
      id: 'mcp-import',
      entry: 'mcp',
      kind: 'nominal',
      what: 'catalog_status reads it; import_catalog kicks again (repeat) and settles with every earlier class kept',
    },
    {
      id: 'mcp-problem',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_problem knows an untried off-list problem from the catalog (number, lists, off the roadmap); two-sum keeps NeetCode’s facts on both lists',
    },
    {
      id: 'api-record',
      entry: 'api',
      kind: 'nominal',
      what: 'A tried off-list problem’s record takes the catalog’s title, pattern and difficulty, on the LeetCode list, not inCatalog',
    },
    {
      id: 'mcp-plan',
      entry: 'mcp',
      kind: 'edge',
      what: 'With the catalog loaded, every slot of today’s plan is still a NeetCode 150 problem',
    },
    {
      id: 'ui-problem',
      entry: 'ui',
      kind: 'nominal',
      what: 'The Problem page names the full list for an off-list problem, and still does after a reload',
    },
    {
      id: 'ui-progress',
      entry: 'ui',
      kind: 'nominal',
      what: 'Progress still draws with the full catalog loaded, the problem among the touched ones',
    },
    {
      id: 'api-running',
      entry: 'api',
      kind: 'edge',
      what: 'A second kick while an import runs starts nothing and reads running',
      offDev: {
        file: 'lambdas/src/backend.catalog.test.ts',
        test: 'answers a second kick while one runs with the status, starting nothing',
        why: 'dev can’t hold a job running on demand: the worker finishes in seconds and the second kick’s timing against it isn’t the harness’s to control; the claim is the BFF’s own, and api-import proves the same BFF method on dev',
      },
    },
    {
      id: 'api-absent',
      entry: 'api',
      kind: 'edge',
      what: 'With no catalog imported, every read is exactly as before',
      offDev: {
        file: 'lambdas/src/backend.catalog.test.ts',
        test: 'reads records exactly as before until an import, then every user sees the catalog’s facts',
        why: 'dev can’t un-import: the catalog is stage-wide and stays between runs',
      },
    },
    {
      id: 'api-source-fails',
      entry: 'api',
      kind: 'edge',
      what: 'A source fetch that fails keeps the live catalog and records the error',
      offDev: {
        file: 'lambdas/src/catalog/import.test.ts',
        test: 'keeps the live catalog and records why when the source fails',
        why: 'dev can’t make the pinned GitHub file fail on demand, and the gateway is never switched in shipped code',
      },
    },
    {
      id: 'api-cost-stop',
      entry: 'api',
      kind: 'edge',
      what: 'Past the $0.25 stop no model call is made and late problems keep their tags’ guess',
      offDev: {
        file: 'lambdas/src/catalog/import.test.ts',
        test: 'leaves rows to their tags past the cost stop, and on a failed model call still counts its spend',
        why: 'reaching the stop on dev means spending it',
      },
    },
    {
      id: 'api-other-user',
      entry: 'api',
      kind: 'edge',
      what: 'The catalog is shared; another user’s records and plan stay their own',
      offDev: {
        file: 'lambdas/src/backend.catalog.test.ts',
        test: 'reads records exactly as before until an import, then every user sees the catalog’s facts',
        why: 'dev has one test user',
      },
    },
    {
      id: 'mcp-prod-import',
      entry: 'mcp',
      kind: 'nominal',
      what: 'The full import on prod: the classification file uploaded in parts through import_catalog, then ready',
      needsYou:
        'prod is the maintainer’s data: after the deploy, import_catalog on `aperture` with his go in the lane’s pane',
    },
  ],
  steps: [
    {
      id: 'import',
      entry: 'api',
      title: 'Kick a capped import with one uploaded class; it settles from the pinned commit',
      proves: ['api-import', 'api-upload'],
      async run(ctx) {
        const before = await ctx.api.reads.getCatalogStatus();
        await ctx.api.writes.startCatalogImport({ classes: OFF_CLASS, limit: LIMIT });
        imported = await settled(() => ctx.api.reads.getCatalogStatus(), before.importedAt);
        sane(imported);
        if (imported.staged !== null) fail('the upload is still staged after the import');
        ctx.log(
          `catalog: ${imported.count} problems ${JSON.stringify(imported.by)} · $${imported.costUsd}`,
        );
      },
    },
    {
      id: 'refused',
      entry: 'api',
      title: 'A malformed import is refused, nothing staged',
      proves: ['api-refused'],
      async run(ctx) {
        for (const bad of [{ limit: 0 }, { classes: OFF_CLASS, part: 3, parts: 2 }]) {
          const out = await ctx.api.writes.startCatalogImport(bad).then(
            () => 'accepted',
            (err: unknown) => String(err),
          );
          if (!/HTTP 4\d\d/.test(out)) fail(`${JSON.stringify(bad)} → ${out}`);
        }
        if ((await ctx.api.reads.getCatalogStatus()).staged !== null)
          fail('a refused part was staged');
      },
    },
    {
      id: 'mcp-problem',
      entry: 'mcp',
      title: 'get_problem on the untried off-list problem, and on two-sum',
      proves: ['mcp-problem', 'api-upload'],
      async run(ctx) {
        const off = await ctx.mcp.reads.getProblem({ slug: OFF });
        const p = off.problem;
        if (
          p.onRoadmap ||
          p.patternId !== 'math-geometry' ||
          p.difficulty !== 'Easy' ||
          p.number !== 9
        )
          fail(`get_problem ${OFF}: ${JSON.stringify(p)}`);
        if (JSON.stringify(p.lists) !== '["leetcode"]')
          fail(`${OFF} lists ${JSON.stringify(p.lists)}`);
        if (off.record !== null) fail(`${OFF} already has a record — a leftover attempt?`);
        const ts = (await ctx.mcp.reads.getProblem({ slug: 'two-sum' })).problem;
        if (
          !ts.onRoadmap ||
          ts.patternId !== 'arrays-hashing' ||
          JSON.stringify(ts.lists) !== '["neetcode150","leetcode"]'
        )
          fail(`get_problem two-sum: ${JSON.stringify(ts)}`);
      },
    },
    {
      id: 'mcp-import',
      entry: 'mcp',
      title: 'catalog_status, then import_catalog again: it settles, the uploaded class kept',
      proves: ['mcp-import'],
      async run(ctx) {
        const first = await ctx.mcp.reads.catalogStatus();
        if (first.sha !== imported.sha || first.count !== imported.count)
          fail(
            `catalog_status reads ${JSON.stringify(first)}, the import made ${JSON.stringify(imported)}`,
          );
        const kicked = await ctx.mcp.writes.importCatalog({ limit: LIMIT });
        if (!['running', 'ready', 'partial'].includes(kicked.state))
          fail(`import_catalog → ${JSON.stringify(kicked)}`);
        const again = await settled(() => ctx.mcp.reads.catalogStatus(), first.importedAt);
        sane(again);
        if (again.count !== imported.count)
          fail(`the repeat changed the count: ${again.count} vs ${imported.count}`);
        if ((again.by?.model ?? 0) < (imported.by?.model ?? 0))
          fail('the repeat lost model classes');
        const p = (await ctx.mcp.reads.getProblem({ slug: OFF })).problem;
        if (p.patternId !== 'math-geometry')
          fail(`the uploaded class was lost: ${JSON.stringify(p)}`);
      },
    },
    {
      id: 'records',
      entry: 'api',
      title: 'Log a solve of the off-list problem; its record reads the catalog’s facts',
      proves: ['api-record'],
      async run(ctx) {
        await ctx.api.writes.logCoachAttempts([{ slug: OFF, outcome: 'solved' }]);
        const r = (await ctx.api.reads.listProblemRecords()).find((x) => x.slug === OFF);
        if (
          !r ||
          r.title !== 'Palindrome Number' ||
          r.pattern !== 'math-geometry' ||
          r.difficulty !== 'Easy' ||
          r.inCatalog !== false ||
          JSON.stringify(r.lists) !== '["leetcode"]'
        )
          fail(`the record reads ${JSON.stringify(r)}`);
      },
    },
    {
      id: 'plan',
      entry: 'mcp',
      title: 'Today’s plan picks only NeetCode 150 problems (each slot on the roadmap)',
      proves: ['mcp-plan'],
      async run(ctx) {
        const today = await ctx.mcp.reads.leetcodeToday();
        for (const s of today.slots) {
          if (s.slug.startsWith('devcheck-')) continue; // another scenario's own re-solve
          const p = (await ctx.mcp.reads.getProblem({ slug: s.slug })).problem;
          if (!p.onRoadmap) fail(`slot ${s.slug} is off NeetCode 150: ${JSON.stringify(p)}`);
        }
      },
    },
    {
      id: 'ui-problem',
      entry: 'ui',
      title: 'The Problem page names the full list; a reload keeps it',
      proves: ['ui-problem'],
      async run(ctx) {
        const line = 'Math & Geometry · Easy · All LeetCode';
        await ctx.ui.goto(`/recruiting/progress/${OFF}`);
        await ctx.ui.expectText(line, 20_000);
        await ctx.shot('problem-page');
        await ctx.page.reload();
        await ctx.ui.expectText(line, 20_000);
      },
    },
    {
      id: 'ui-progress',
      entry: 'ui',
      title: 'Progress draws, the off-list problem among the touched ones',
      proves: ['ui-progress'],
      async run(ctx: Ctx) {
        await ctx.ui.goto('/recruiting/progress');
        await ctx.ui.expectText('Palindrome Number', 20_000);
        await ctx.page.getByText('Palindrome Number').first().scrollIntoViewIfNeeded();
        await ctx.shot('progress');
      },
    },
    noConsoleErrors,
  ],
};
