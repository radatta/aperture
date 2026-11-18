// The full LeetCode catalog (docs/areas/recruiting/coach.md → The full LeetCode catalog): a capped import from the
// pinned public dataset (on dev the worker fetches it and Sonnet classifies up to 50 problems still on their tags a
// kick, under the stage's $0.25 stop; locally the synthetic fixture and a stand-in), an uploaded class through the
// API and through MCP in two parts, then what reads see — the record of an off-list problem, get_problem, the
// Problem page, the plan still NeetCode 150's. The catalog is stage-wide public metadata, not the test user's data:
// it isn't ledgered and stays for the next run. The one off-list problem is palindrome-number (number 9, on dev's
// source and the local fixture alike), uploaded under two-pointers — a pattern its Math tag can't give, so only the
// upload can put it there — with two-sum as its similar problem; its one attempt is ledgered and deleted in the
// step. Every step that needs the catalog is slow tier: it runs on --feature, or when the catalog's own code moves.
import type { DevCatalogStatus } from '../api';
import type { DevMcpCatalogStatus } from '../mcp';
import { noConsoleErrors, needsYou, type Ctx, type Scenario } from '../scenario';

const OFF = 'palindrome-number';
const OFF_CLASS = '9\ttwo-pointers\t1\t-'; // number, pattern, similar (two-sum), harder
const LIMIT = 300; // problems beside NeetCode's: dev's import stays quick and its worker slot free
const SETTLE_MS = 240_000; // above the 180 s claim, so a dropped event reads as stuck, not as settled
const STOP_USD = 0.25; // LC_CATALOG_COST_STOP_USD (scripts doesn't depend on shared)
const fail = (msg: string): never => {
  throw new Error(msg);
};
const at = (v: number | string | null) =>
  v === null ? 0 : typeof v === 'number' ? v : Date.parse(v);

// Polls until no job holds the claim and an import newer than `since` is live; a failed one fails the step.
async function settled<
  S extends { state: string; importedAt: number | string | null; lastError: string | null },
>(read: () => Promise<S>, since: number | string | null): Promise<S> {
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const s = await read();
    if (s.state !== 'running' && s.lastError) fail(`the import failed: ${s.lastError}`);
    if ((s.state === 'ready' || s.state === 'partial') && at(s.importedAt) > at(since)) return s;
    if (Date.now() > until) fail(`the import never settled: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
function sane(s: DevCatalogStatus | DevMcpCatalogStatus) {
  const by = s.by ?? fail('no classifier counts');
  const sum = by.neetcode + by.rule + by.model + by.tags;
  // The exact pinned URL is import.test.ts's to prove (scripts doesn't depend on shared); here, a whole commit sha.
  if (!/^[0-9a-f]{40}$/.test(s.sha ?? '')) fail(`built from ${s.sha}, not a pinned commit`);
  if (sum !== s.count) fail(`the counts don’t add up: ${JSON.stringify(s)}`);
  if (by.neetcode < 1 || s.count <= by.neetcode)
    fail(`nothing beyond NeetCode: ${JSON.stringify(s)}`);
  if (s.modelError) fail(`the model step failed: ${s.modelError}`);
}

// Steps share what earlier ones read; a failed step skips the rest, so these are set when read.
let imported: DevCatalogStatus;
let kicks: { first: string; second: string };

export const lcCatalog: Scenario = {
  id: 'lc-catalog',
  title: 'The full LeetCode catalog: import, an uploaded class, and what reads see',
  tiers: ['full'],
  slowPaths: [
    'packages/shared/src/catalogs.ts',
    'packages/shared/src/lcCatalog.ts',
    'packages/shared/src/coach.ts',
    'lambdas/src/catalog/**',
    'lambdas/src/anthropic/catalogClassifyPrompt.ts',
    'lambdas/src/coachWorker.ts',
    'lambdas/src/mcp/coachTools.ts',
    'app/src/pages/Recruiting/ProblemPage.tsx',
    'scripts/src/devcheck/scenarios/lc-catalog.ts',
  ],
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
      what: 'An uploaded classification line sets that problem’s pattern and similar problem, which its tags alone can’t',
    },
    {
      id: 'api-running',
      entry: 'api',
      kind: 'edge',
      what: 'A second kick while an import runs starts nothing and reads running',
    },
    {
      id: 'api-refused',
      entry: 'api',
      kind: 'edge',
      what: 'A malformed import (limit 0, empty classes, a part over 64,000 characters, a part beyond parts, a part out of order) is refused, with why',
    },
    {
      id: 'mcp-upload',
      entry: 'mcp',
      kind: 'nominal',
      what: 'import_catalog takes the classification in two parts: part 1 stages (the live catalog still reads), part 2 kicks',
    },
    {
      id: 'mcp-import',
      entry: 'mcp',
      kind: 'edge',
      what: 'A repeat import through MCP settles with every earlier class and link kept, and classifies more problems while some wait and spend is under the stop',
    },
    {
      id: 'mcp-problem',
      entry: 'mcp',
      kind: 'nominal',
      what: 'get_problem knows an untried off-list problem from the catalog (number, lists, similar, off the roadmap); two-sum keeps NeetCode’s facts on both lists',
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
      what: 'With the catalog loaded, every new or stretch slot of today’s plan is a NeetCode 150 problem',
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
        why: 'dev can’t make the pinned GitHub file fail on demand, and the gateway is never switched in shipped code; source.test.ts covers the gateway’s own failures',
      },
    },
    {
      id: 'api-cost-stop',
      entry: 'api',
      kind: 'edge',
      what: 'Past the $0.25 stop no model call is made and late problems keep their tags’ guess; a call with no usage is charged at its ceiling',
      offDev: {
        file: 'lambdas/src/catalog/import.test.ts',
        test: 'makes no model call once spend reaches the stop; rows stay on their tags',
        why: 'reaching the stop on dev means spending it',
      },
    },
    {
      id: 'api-limit-keeps',
      entry: 'api',
      kind: 'edge',
      what: 'A capped import keeps every class it was given, so a full import after it loses none',
      offDev: {
        file: 'lambdas/src/catalog/import.test.ts',
        test: 'a capped import keeps every class it was given: a full one after it loses none',
        why: 'dev imports capped only (its write ceiling and worker slot); the uncapped import is prod’s, needs-you below',
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
        'prod is the maintainer’s data: after the deploy, import_catalog on `aperture` with his go (docs/areas/recruiting/coach.md → On prod)',
    },
  ],
  steps: [
    {
      id: 'refused',
      entry: 'api',
      title: 'A malformed import is refused, with why, and nothing is staged',
      proves: ['api-refused'],
      async run(ctx) {
        const before = await ctx.api.reads.getCatalogStatus();
        for (const [bad, why] of [
          [{ limit: 0 }, /limit/],
          [{ classes: '' }, /non-empty/],
          [{ classes: 'x'.repeat(64_001) }, /split it/],
          [{ classes: OFF_CLASS, part: 3, parts: 2 }, /part must/],
          // 3 of 3: a shape this scenario never stages, so no leftover upload can take it
          [{ classes: OFF_CLASS, part: 3, parts: 3 }, /part 1|Send part|start again/],
        ] as const) {
          const out = await ctx.api.writes.startCatalogImport(bad).then(
            () => 'accepted',
            (err: unknown) => String(err),
          );
          if (!/HTTP 4\d\d/.test(out) || !why.test(out))
            fail(`${JSON.stringify(bad).slice(0, 80)} → ${out}`);
        }
        const after = await ctx.api.reads.getCatalogStatus();
        if (JSON.stringify(after.staged) !== JSON.stringify(before.staged))
          fail('a refused part was staged');
      },
    },
    {
      id: 'import',
      entry: 'api',
      cost: 'slow',
      title:
        'Kick a capped import with one uploaded class, kick again at once; it settles from the pinned commit',
      proves: ['api-import', 'api-upload'],
      async run(ctx) {
        const before = await ctx.api.reads.getCatalogStatus();
        const first = await ctx.api.writes.startCatalogImport({ classes: OFF_CLASS, limit: LIMIT });
        const second = await ctx.api.writes.startCatalogImport({ limit: LIMIT });
        kicks = { first: first.state, second: second.state };
        imported = await settled(() => ctx.api.reads.getCatalogStatus(), before.importedAt);
        sane(imported);
        if (imported.staged !== null) fail('the upload is still staged after the import');
        ctx.log(
          `catalog: ${imported.count} problems ${JSON.stringify(imported.by)} · $${imported.costUsd} · kicks ${kicks.first}/${kicks.second}`,
        );
      },
    },
    {
      id: 'running',
      entry: 'api',
      cost: 'slow',
      title: 'The second kick, sent while the first ran, read running and started nothing',
      proves: ['api-running'],
      async run(ctx) {
        // Locally the job runs inside the first call, so there's never a running one to kick against.
        if (kicks.first !== 'running')
          needsYou(`the first kick returned ${kicks.first}: this server runs the import inline`, {
            stepOnly: true,
          });
        if (kicks.second !== 'running') fail(`the second kick read ${kicks.second}, not running`);
        const after = await ctx.api.reads.getCatalogStatus();
        if (after.importedAt !== imported.importedAt) fail('a second import ran after the first');
      },
    },
    {
      id: 'mcp-problem',
      entry: 'mcp',
      cost: 'slow',
      title: 'get_problem on the untried off-list problem, and on two-sum',
      proves: ['mcp-problem', 'api-upload'],
      async run(ctx) {
        const off = await ctx.mcp.reads.getProblem({ slug: OFF });
        const p = off.problem;
        if (
          p.onRoadmap ||
          p.patternId !== 'two-pointers' ||
          p.difficulty !== 'Easy' ||
          p.number !== 9
        )
          fail(`get_problem ${OFF}: ${JSON.stringify(p)}`);
        if (JSON.stringify(p.lists) !== '["leetcode"]')
          fail(`${OFF} lists ${JSON.stringify(p.lists)}`);
        if (!p.similar?.some((x) => x.slug === 'two-sum'))
          fail(`${OFF}’s similar: ${JSON.stringify(p.similar)}`);
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
      cost: 'slow',
      title:
        'import_catalog in two parts: part 1 stages, part 2 kicks; it settles with every class kept',
      proves: ['mcp-upload', 'mcp-import'],
      async run(ctx) {
        const first = await ctx.mcp.reads.catalogStatus();
        const cut = 5; // mid-line: parts are raw slices of the file
        const staged = await ctx.mcp.writes.importCatalog({
          classes: OFF_CLASS.slice(0, cut),
          part: 1,
          parts: 2,
        });
        if (
          JSON.stringify(staged.staged) !== '{"have":1,"of":2}' ||
          !['ready', 'partial'].includes(staged.state)
        )
          fail(`part 1 → ${JSON.stringify(staged)}`);
        const kicked = await ctx.mcp.writes.importCatalog({
          classes: OFF_CLASS.slice(cut),
          part: 2,
          parts: 2,
          limit: LIMIT,
        });
        if (!['running', 'ready', 'partial'].includes(kicked.state))
          fail(`part 2 → ${JSON.stringify(kicked)}`);
        const again = await settled(() => ctx.mcp.reads.catalogStatus(), first.importedAt);
        sane(again);
        const by = again.by!;
        const was = first.by!;
        if (again.count !== first.count)
          fail(`the repeat changed the count: ${again.count} vs ${first.count}`);
        if (by.model < was.model) fail('the repeat lost model classes');
        // While problems wait on their tags and spend is under the stop, each kick classifies more.
        if (was.tags > 0 && first.costUsd < STOP_USD && by.model <= was.model)
          fail(`the model classified nothing: ${JSON.stringify(again)}`);
        const p = (await ctx.mcp.reads.getProblem({ slug: OFF })).problem;
        if (p.patternId !== 'two-pointers' || !p.similar?.some((x) => x.slug === 'two-sum'))
          fail(`the uploaded class was lost: ${JSON.stringify(p)}`);
      },
    },
    {
      id: 'records',
      entry: 'api',
      cost: 'slow',
      title:
        'Log a solve of the off-list problem; its record reads the catalog’s facts (then the solve goes)',
      proves: ['api-record'],
      async run(ctx) {
        const [a] = await ctx.api.writes.logCoachAttempts([{ slug: OFF, outcome: 'solved' }]);
        try {
          const r = (await ctx.api.reads.listProblemRecords()).find((x) => x.slug === OFF);
          if (
            !r ||
            r.title !== 'Palindrome Number' ||
            r.pattern !== 'two-pointers' ||
            r.difficulty !== 'Easy' ||
            r.inCatalog !== false ||
            JSON.stringify(r.lists) !== '["leetcode"]'
          )
            fail(`the record reads ${JSON.stringify(r)}`);
        } finally {
          if (a) await ctx.api.writes.deleteCoachAttempt(a.id); // later scenarios never see it
        }
      },
    },
    {
      id: 'plan',
      entry: 'mcp',
      cost: 'slow',
      title: 'Today’s plan’s new and stretch slots are NeetCode 150 problems',
      proves: ['mcp-plan'],
      async run(ctx) {
        const today = await ctx.mcp.reads.leetcodeToday();
        for (const s of today.slots) {
          if (s.kind !== 'new' && s.kind !== 'stretch') continue; // a re-solve may be any problem tried
          const p = (await ctx.mcp.reads.getProblem({ slug: s.slug })).problem;
          if (!p.onRoadmap)
            fail(`slot ${s.slug} (${s.kind}) is off NeetCode 150: ${JSON.stringify(p)}`);
        }
      },
    },
    {
      id: 'ui-problem',
      entry: 'ui',
      cost: 'slow',
      title:
        'The Problem page names the full list for an off-list problem tried once; a reload keeps it',
      proves: ['ui-problem'],
      async run(ctx) {
        // The app knows an off-list problem only through its record (it loads no catalog): log one, read, remove it.
        const [a] = await ctx.api.writes.logCoachAttempts([{ slug: OFF, outcome: 'solved' }]);
        try {
          const line = 'Two Pointers · Easy · All LeetCode';
          await ctx.ui.goto(`/recruiting/progress/${OFF}`);
          await ctx.ui.expectText(line, 20_000);
          await ctx.shot('problem-page');
          await ctx.page.reload();
          await ctx.ui.expectText(line, 20_000);
        } finally {
          if (a) await ctx.api.writes.deleteCoachAttempt(a.id);
        }
      },
    },
    {
      id: 'ui-progress',
      entry: 'ui',
      cost: 'slow',
      title: 'Progress draws, the off-list problem among the touched ones',
      proves: ['ui-progress'],
      async run(ctx: Ctx) {
        const [a] = await ctx.api.writes.logCoachAttempts([{ slug: OFF, outcome: 'solved' }]);
        try {
          await ctx.ui.goto('/recruiting/progress');
          await ctx.ui.expectText('Palindrome Number', 20_000);
          await ctx.page.getByText('Palindrome Number').first().scrollIntoViewIfNeeded();
          await ctx.shot('progress');
        } finally {
          if (a) await ctx.api.writes.deleteCoachAttempt(a.id);
        }
      },
    },
    noConsoleErrors,
  ],
};
