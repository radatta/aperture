// Typed quick add keeps every title word (quick-add.md → 2026-11-17, titles): a sample of synthetic lines through
// the real model as the test user — the app's parse route (parseTask, which parse_task shares), MCP, the capture
// bar's Review, and spoken and typed lines through the capture route (the Shortcut's and Raycast's bodies). Three
// classes, each a dev finding: a word the model dropped ("…typed at 1 am", 10 of 10), a due phrase it kept ("before
// 3pm"), and a leading word taken as a category the parse never set. parseTask writes nothing; the captures are
// ledgered tasks. Each step logs its first-try tally — the before/after rate in the PR. About 50 model calls, so its
// steps are slow-tier: they run when the branch touches the parse (slowPaths) or --feature names it.
import type { DevCaptureResult, DevParseResult } from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { marker } from './siri-capture';

// A line, and the title it must save: `untimed` lists the titles allowed when the model set no time (a "before
// 3pm" it read as part of the task); absent, a time is required. `category`: the parse must set the run's category.
interface Sample {
  line: string;
  title: string;
  untimed?: string[];
  category?: true;
  typed?: true; // the capture route with no voice flag: Raycast's body
}

const verbatim = (m: string): Sample[] => [
  ...[1, 2, 3, 4].map(() => ({
    line: `devcheck ${m} call the bank typed at 1 am`,
    title: `devcheck ${m} call the bank typed`,
  })),
  { line: 'pick up dry cleaning typed at 6 pm', title: 'pick up dry cleaning typed' },
  { line: 'email the landlord sent at 10 am', title: 'email the landlord sent' },
  { line: 'water the ferns done by 5 pm', title: 'water the ferns done' },
  { line: 'book the vet note at 11 am', title: 'book the vet note' },
  { line: 'ping the plumber asap at 4 pm', title: 'ping the plumber asap' },
  { line: 'renew passport online at 9 am', title: 'renew passport online' },
  // F232 (dev, 2026-11-17): the model put the marker and "typed" in notes; they go back.
  {
    line: `devcheck ${m} call the dentist typed tomorrow at 5 pm`,
    title: `devcheck ${m} call the dentist typed`,
  },
];
const dueOut: Sample[] = [
  {
    line: 'finish slides before 3pm',
    title: 'finish slides',
    untimed: ['finish slides before 3pm'],
  },
  {
    line: 'email landlord quickly before 5pm',
    title: 'email landlord quickly',
    untimed: ['email landlord quickly before 5pm'],
  },
  {
    line: 'send invoice until 5pm friday',
    title: 'send invoice',
    untimed: ['send invoice until 5pm friday', 'send invoice until 5pm'],
  },
  { line: 'text sam back later today 3pm', title: 'text sam back later' },
  { line: 'call the bank 6pm', title: 'call the bank' },
  { line: 'pay rent today at 9am', title: 'pay rent' },
  { line: 'email landlord tomorrow at 5 pm', title: 'email landlord' },
  { line: 'gym session 6am', title: 'gym session' },
  { line: 'standup notes 9:30am', title: 'standup notes' },
  { line: 'call mom later today 7pm', title: 'call mom later' },
  // The clock after "about the" is the task's, timed or not. A bare mid-title clock is the model's to read: kept,
  // it's a title word and sets no time (siri-capture's kept-words row); used for the time, it leaves — dev,
  // 2026-11-17, "watch show" at 21:00 twice. Either way the server never strips it on its own.
  { line: 'watch 9pm show', title: 'watch show', untimed: ['watch 9pm show'] },
  {
    line: 'email the team about the 3pm meeting',
    title: 'email the team about the 3pm meeting',
    untimed: ['email the team about the 3pm meeting'],
  },
];
// Through the capture route — spoken (the Shortcut's body: the lead-in, the said time and the day go) and typed
// (Raycast's) — every other word stays. Real tasks, so each carries the run's marker.
const captured = (m: string): Sample[] => [
  // F232 (dev, 2026-11-17): a marker prefix and a trailing word beside "tomorrow at <clock>", typed — the model put
  // both in notes and titled it "call the dentist".
  {
    line: `devcheck ${m} call the dentist typed tomorrow at 5 pm`,
    title: `devcheck ${m} call the dentist typed`,
    typed: true,
  },
  {
    line: `remind me to devcheck ${m} call the bank typed at 5 PM`,
    title: `devcheck ${m} call the bank typed`,
  },
  {
    line: `remind me tomorrow at 9 am to devcheck ${m} water the ferns done`,
    title: `devcheck ${m} water the ferns done`,
  },
  {
    line: `remind me at 5 to devcheck ${m} email the landlord sent`,
    title: `devcheck ${m} email the landlord sent`,
  },
  {
    line: `devcheck ${m} call the plumber asap tonight`,
    title: `devcheck ${m} call the plumber asap`,
  },
  { line: `devcheck ${m} stretch typed in 20 minutes`, title: `devcheck ${m} stretch typed` },
  {
    line: `devcheck ${m} call the bank typed at 5 o'clock`,
    title: `devcheck ${m} call the bank typed`,
  },
  {
    line: `remind me to devcheck ${m} book the vet note tomorrow morning`,
    title: `devcheck ${m} book the vet note`,
  },
  {
    line: `devcheck ${m} water the ferns done by 5 pm`,
    title: `devcheck ${m} water the ferns done`,
    typed: true,
  },
  {
    line: `devcheck ${m} book the vet note at 11 am`,
    title: `devcheck ${m} book the vet note`,
    typed: true,
  },
];
// Long enough that the model moves the rest to notes: the title is the model's, never grown by the guard.
const OVERFLOW = `plan the garden makeover typed at 9 am: ${'compost bins, raised beds, drip lines, mulch, trellis, '.repeat(5)}and a bench`;
// Leading words that name none of the test user's categories (checked against the live list: a clash is left out).
const leads = (label: string, live: Set<string>): Sample[] => [
  { line: `${label}, buy oat milk`, title: 'buy oat milk', category: true },
  { line: `${label}: renew the parking permit`, title: 'renew the parking permit', category: true },
  {
    line: `${label} - return the library books`,
    title: 'return the library books',
    category: true,
  },
  { line: `${label}, call the bank at 4 pm`, title: 'call the bank', category: true },
  { line: `${label}: water the ferns tomorrow 8am`, title: 'water the ferns', category: true },
  ...[
    { line: 'zephyr, fix the flaky login test', title: 'zephyr, fix the flaky login test' },
    { line: 'quokka: read chapter 4', title: 'quokka: read chapter 4' },
    { line: 'marlin - book a physio appointment', title: 'marlin - book a physio appointment' },
    { line: 'aperture, fix login bug due fri 30m', title: 'aperture, fix login bug' },
    { line: 'work, email sam about the lease', title: 'work, email sam about the lease' },
    { line: 'errands buy stamps', title: 'errands buy stamps' },
    // No run marker: the run's category is named after it, and the model files a line that shares it there.
    { line: 'devcheck call the bank at 7 pm', title: 'devcheck call the bank' },
  ].filter((s) => !live.has(s.line.split(/[\s,:]/)[0]!)),
];

// One word, this run's own: no live category or earlier run's can match it, and it doesn't carry the marker
// every sample line does (a line naming the marker would read as naming the category).
const baitLabel = (nonce: string) =>
  `quince${nonce.replace(/\d/g, (d) => 'qrstuvwxyz'[Number(d)]!)}`;

const parsed =
  (parse: (line: string) => Promise<DevParseResult>, categoryId: string | null = null) =>
  async (s: Sample) =>
    miss(s, await parse(s.line), categoryId);
const CLOCK = /\d\s*[ap]m\b|\d:\d\d/i;
// Why a parse misses its sample, or null.
function miss(s: Sample, r: DevParseResult, categoryId: string | null): string | null {
  if (!r.ok) return `the parse failed (${r.reason})`;
  const { title, dueTime } = r.input;
  if (s.category && r.input.categoryId !== categoryId) return `no category, “${title}”`;
  // The run's category is bait no other line is about: a line filed there was forced into it (F229).
  if (!s.category && categoryId && r.input.categoryId === categoryId)
    return `filed under the run's category, “${title}”`;
  // A line naming no category may still be filed by topic (the prompt's "clearly matches" is the model's call,
  // category suggestion's concern): what this scenario holds is that its leading word stays in the title.
  if (!dueTime && s.untimed === undefined && CLOCK.test(s.line)) return `no time, “${title}”`;
  const want = dueTime ? [s.title] : (s.untimed ?? [s.title]);
  return want.includes(title) ? null : `“${title}”, want “${want.join('” or “')}”`;
}

// Four at a time (dev's parse route is the shared Lambda); a miss is asked once more (`attempt` 1) — the model is
// nondeterministic, the server's guard isn't — and the first-try tally logged. Captures too, since a lost race on the
// token's row retries with jitter (F224, 2026-11-17; four at once had answered a 500): a 409 "busy" left after that is a
// miss, re-asked once like any other.
async function sample(
  ctx: Ctx,
  what: string,
  samples: Sample[],
  check: (s: Sample, attempt: number) => Promise<string | null>,
  batch = 4,
): Promise<string[]> {
  const first: (string | null)[] = [];
  for (let i = 0; i < samples.length; i += batch)
    first.push(...(await Promise.all(samples.slice(i, i + batch).map((s) => check(s, 0)))));
  const fails: string[] = [];
  for (const [i, m] of first.entries()) {
    if (m === null) continue;
    const again = await check(samples[i]!, 1);
    ctx.log(`${what}: “${samples[i]!.line}” missed (${m}); again: ${again ?? 'ok'}`);
    if (again) fails.push(`${samples[i]!.line} → ${again}`);
  }
  const ok = first.filter((m) => m === null).length;
  ctx.log(
    `${what}: ${ok}/${samples.length} first try, ${samples.length - fails.length}/${samples.length} after one re-ask`,
  );
  return fails;
}

export const captureTitles: Scenario = {
  id: 'capture-titles',
  title: 'Typed quick add keeps every title word',
  tiers: ['full'],
  slowPaths: [
    'packages/shared/src/quickParse.ts',
    'packages/shared/src/titleWords.ts',
    'packages/shared/src/spokenTime.ts',
    'lambdas/src/anthropic/parsePrompt.ts',
    'lambdas/src/anthropic/liveAnthropic.ts',
    'scripts/src/devcheck/scenarios/capture-titles.ts',
  ],
  rows: [
    {
      id: 'verbatim',
      entry: 'api',
      kind: 'nominal',
      what: 'A word beside a clock stays in the title — “call the bank typed at 1 am” is “call the bank typed”',
    },
    {
      id: 'due-out',
      entry: 'api',
      kind: 'nominal',
      what: 'A clock or day that became the due leaves the title — “before 3pm”, “today 3pm”, “until 5pm friday”',
    },
    {
      id: 'due-kept',
      entry: 'api',
      kind: 'edge',
      what: 'A clock that’s part of the task stays — “the 3pm meeting”; “watch 9pm show” keeps it unless it set the time',
    },
    {
      id: 'lead-category',
      entry: 'api',
      kind: 'nominal',
      what: 'A leading word naming a category (“<category>, …”, “:”, “ - ”) sets it and leaves the title',
    },
    {
      id: 'lead-other',
      entry: 'api',
      kind: 'edge',
      what: 'A leading word naming no category stays in the title',
    },
    {
      id: 'no-force',
      entry: 'api',
      kind: 'edge',
      what: 'A line about no category is never filed under one just because it is there: the run’s own category, which no line is about, stays empty (F229)',
    },
    {
      id: 'no-force-ui',
      entry: 'ui',
      kind: 'edge',
      what: 'The capture bar’s Review, with one category no line is about: the preview files the line under none (F229)',
    },
    {
      id: 'mcp-parse',
      entry: 'mcp',
      kind: 'nominal',
      what: 'parse_task (the MCP tool agents parse with) gives the same titles',
    },
    {
      id: 'review',
      entry: 'ui',
      kind: 'nominal',
      what: 'The capture bar’s Review previews the full title; nothing is saved',
    },
    {
      id: 'overflow',
      entry: 'api',
      kind: 'edge',
      what: 'A line long enough for notes keeps the model’s title — the guard never grows it',
    },
    {
      id: 'reworded',
      entry: 'api',
      kind: 'edge',
      what: 'A title the model reworded or reordered stands as it came',
      offDev: {
        file: 'packages/shared/src/titleWords.test.ts',
        test: 'stands when nothing changes or the words are reordered',
        why: 'the model decides whether it rewords — dev can’t make it',
      },
    },
    {
      id: 'capture-typed',
      entry: 'api',
      kind: 'nominal',
      what: 'A typed line through the capture route (Raycast’s body) keeps every title word',
    },
    {
      id: 'spoken',
      entry: 'api',
      kind: 'nominal',
      what: 'A spoken line keeps its words too — “remind me tomorrow to …”, “tonight”, “in 20 minutes” go',
    },
    {
      id: 'raycast',
      entry: 'raycast',
      kind: 'nominal',
      what: 'The Raycast hotkey saves the same title',
      needsYou:
        'the hotkey script runs on the Mac; its server path (a typed capture) is the capture-typed row',
    },
  ],
  steps: [
    {
      id: 'api-sample',
      entry: 'api',
      cost: 'slow',
      proves: ['verbatim', 'due-out', 'due-kept', 'lead-category', 'lead-other', 'no-force'],
      title: 'The sample through parseTask: every class’s titles exact, tallies logged',
      async run(ctx) {
        const m = marker(ctx.nonce);
        const live = new Set(
          (await ctx.api.reads.listCategories()).map((c) => c.label.toLowerCase()),
        );
        const label = baitLabel(ctx.nonce);
        const cat = await ctx.api.writes.upsertCategory({ label, isWork: false });
        const parse = (line: string) => ctx.api.reads.parseTask(line);
        try {
          const fails = [
            ...(await sample(ctx, 'verbatim', verbatim(m), parsed(parse, cat.id))),
            ...(await sample(ctx, 'due phrase', dueOut, parsed(parse, cat.id))),
            ...(await sample(ctx, 'leading word', leads(label, live), parsed(parse, cat.id))),
          ];
          if (fails.length) throw new Error(`${fails.length} missed twice: ${fails.join('; ')}`);
        } finally {
          // Gone before the scenarios after this one count or score categories.
          await ctx.api.writes.deleteCategory(cat.id, null);
        }
      },
    },
    {
      id: 'mcp-sample',
      entry: 'mcp',
      cost: 'slow',
      proves: ['mcp-parse'],
      title: 'parse_task: one line from each class, the same titles',
      async run(ctx) {
        const m = marker(ctx.nonce);
        const live = new Set(
          (await ctx.mcp.reads.listCategories()).map((c) => c.label.toLowerCase()),
        );
        const picks = [verbatim(m)[0]!, dueOut[0]!, leads('', live).at(-1)!];
        const fails = await sample(
          ctx,
          'mcp',
          picks,
          parsed((line) => ctx.mcp.reads.parseTask(line)),
        );
        if (fails.length) throw new Error(fails.join('; '));
      },
    },
    {
      id: 'ui-review',
      entry: 'ui',
      cost: 'slow',
      proves: ['review', 'no-force-ui'],
      title:
        'Capture bar › Review: “…typed at 1 am” previews with “typed” kept, not filed under the one bait category; nothing saved',
      async run(ctx) {
        const s = verbatim(marker(ctx.nonce))[0]!;
        // A category no line is about, live while the app parses (F229: a line is never forced into it).
        const cat = await ctx.api.writes.upsertCategory({
          label: `${baitLabel(ctx.nonce)}ui`,
          isWork: false,
        });
        try {
          await ctx.ui.goto('/tasks');
          await ctx.page.getByRole('button', { name: 'Task', exact: true }).click();
          const field = ctx.page.locator('textarea[aria-label="Capture task"]');
          const created = ctx.createdIds().length;
          await field.fill(s.line);
          const parsed = ctx.page.waitForResponse((r) => r.url().endsWith('/api/parseTask'), {
            timeout: 15_000,
          });
          await ctx.page.getByRole('button', { name: 'Review before saving' }).click();
          const res = await parsed;
          if (res.status() !== 200) throw new Error(`parseTask answered ${res.status()}`);
          const why = miss(s, (await res.json()) as DevParseResult, cat.id);
          if (why) throw new Error(`the preview: ${why}`);
          await ctx.ui.expectText(s.title, 10_000);
          await ctx.shot('review');
          await field.fill(''); // unsaved
          await new Promise((r) => setTimeout(r, 2_000)); // a create in flight reaches the ledger with its response
          if (ctx.createdIds().length !== created) throw new Error('the Review saved a task');
        } finally {
          await ctx.api.writes.deleteCategory(cat.id, null);
        }
      },
    },
    {
      id: 'api-spoken',
      entry: 'api',
      proves: ['spoken', 'capture-typed'],
      cost: 'slow',
      title:
        'Spoken and typed lines through the capture route: every title word kept, the lead-in and time gone',
      async run(ctx) {
        // Two tokens: a re-ask of the same text on one would answer the first capture (the 60 s duplicate guard).
        const minted: { token: string; info: { id: string } }[] = [];
        try {
          for (const n of ['titles', 'titles 2'])
            minted.push(await ctx.api.writes.mintScopedToken(`devcheck ${ctx.nonce} ${n}`));
          const fails = await sample(
            ctx,
            'capture route',
            captured(marker(ctx.nonce)),
            async (s, attempt) => {
              const got = await ctx.api.writes.captureRaw(
                minted[attempt]!.token,
                s.typed ? { text: s.line } : { text: s.line, voice: true },
              );
              const r = got.body as DevCaptureResult;
              if (got.status !== 200 || !r?.id) return `HTTP ${got.status}: ${r?.say ?? ''}`;
              if (r.raw) return `saved as typed: ${r.say}`;
              const title = (await ctx.api.reads.getTask(r.id))?.title;
              return title === s.title ? null : `“${title}”, want “${s.title}”`;
            },
          );
          if (fails.length) throw new Error(`${fails.length} missed twice: ${fails.join('; ')}`);
        } finally {
          for (const t of minted)
            await ctx.api.writes.revokeScopedToken(t.info.id).catch(() => undefined); // cleanup retries it
        }
      },
    },
    {
      id: 'api-overflow',
      entry: 'api',
      proves: ['overflow'],
      cost: 'slow',
      title: 'A long line: notes take the rest, the title is the model’s, not grown',
      async run(ctx) {
        const ok = async (s: Sample) => {
          const r = await ctx.api.reads.parseTask(s.line);
          if (!r.ok) return `the parse failed (${r.reason})`;
          if (!r.input.notes) return `no notes, title “${r.input.title}”`;
          // The model cuts its title at the prompt's 80; a guard that put dropped words back would run past it.
          return r.input.title.length <= 80 ? null : `the title grew to ${r.input.title.length}`;
        };
        const fails = await sample(ctx, 'overflow', [{ line: OVERFLOW, title: '' }], ok);
        if (fails.length) throw new Error(fails.join('; '));
      },
    },
    noConsoleErrors,
  ],
};
