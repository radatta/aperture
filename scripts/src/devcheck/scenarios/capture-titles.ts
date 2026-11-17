// Typed quick add keeps every title word (quick-add.md → 2026-11-17, titles): a sample of synthetic lines through
// the real model as the test user — the app's parse route (parseTask, which parse_task and Raycast share), MCP, and
// the capture bar's Review. Three classes, each a dev finding: a word the model dropped ("…typed at 1 am", 10 of 10),
// a due phrase it kept ("before 3pm"), and a leading word taken as a category the parse never set. Nothing is
// saved: parseTask writes nothing. Each step logs its first-try tally — the before/after rate in the PR.
import type { DevParseResult } from '../api';
import { noConsoleErrors, type Ctx, type Scenario } from '../scenario';
import { marker } from './siri-capture';

// A line, and the title it must save: `untimed` is the title when the model set no time (a "before 3pm" it read
// as part of the task); absent, a time is required. `category`: the parse must set the run's category.
interface Sample {
  line: string;
  title: string;
  untimed?: string;
  category?: true;
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
];
const dueOut: Sample[] = [
  { line: 'finish slides before 3pm', title: 'finish slides', untimed: 'finish slides before 3pm' },
  {
    line: 'email landlord quickly before 5pm',
    title: 'email landlord quickly',
    untimed: 'email landlord quickly before 5pm',
  },
  { line: 'send invoice until 5pm friday', title: 'send invoice' },
  { line: 'text sam back later today 3pm', title: 'text sam back later' },
  { line: 'call the bank 6pm', title: 'call the bank' },
  { line: 'pay rent today at 9am', title: 'pay rent' },
  { line: 'email landlord tomorrow at 5 pm', title: 'email landlord' },
  { line: 'gym session 6am', title: 'gym session' },
  { line: 'standup notes 9:30am', title: 'standup notes' },
  { line: 'call mom later today 7pm', title: 'call mom later' },
  // A clock that's part of the task stays, timed or not.
  { line: 'watch 9pm show', title: 'watch 9pm show', untimed: 'watch 9pm show' },
  {
    line: 'email the team about the 3pm meeting',
    title: 'email the team about the 3pm meeting',
    untimed: 'email the team about the 3pm meeting',
  },
];
// Leading words that name none of the test user's categories (checked against the live list: a clash is left out).
const leads = (m: string, label: string, live: Set<string>): Sample[] => [
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
    { line: `devcheck ${m} call the bank at 7 pm`, title: `devcheck ${m} call the bank` },
  ].filter((s) => !live.has(s.line.split(/[\s,:]/)[0]!)),
];

const CLOCK = /\d\s*[ap]m\b|\d:\d\d/i;
// Why a parse misses its sample, or null.
function miss(s: Sample, r: DevParseResult, categoryId: string | null): string | null {
  if (!r.ok) return `the parse failed (${r.reason})`;
  const { title, dueTime } = r.input;
  if (s.category && r.input.categoryId !== categoryId) return `no category, “${title}”`;
  if (!s.category && categoryId && r.input.categoryId === categoryId)
    return `the run's category set on “${title}”`;
  if (!dueTime && s.untimed === undefined && CLOCK.test(s.line)) return `no time, “${title}”`;
  const want = dueTime ? s.title : (s.untimed ?? s.title);
  return title === want ? null : `“${title}”, want “${want}”`;
}

// Four at a time (dev's parse route is the shared Lambda); a miss is asked once more — the model is
// nondeterministic, the server's guard isn't — and the first-try tally logged.
async function sample(
  ctx: Ctx,
  what: string,
  samples: Sample[],
  parse: (line: string) => Promise<DevParseResult>,
  categoryId: string | null = null,
): Promise<string[]> {
  const first: (string | null)[] = [];
  for (let i = 0; i < samples.length; i += 4)
    first.push(
      ...(await Promise.all(
        samples.slice(i, i + 4).map(async (s) => miss(s, await parse(s.line), categoryId)),
      )),
    );
  const fails: string[] = [];
  for (const [i, m] of first.entries()) {
    if (m === null) continue;
    const again = miss(samples[i]!, await parse(samples[i]!.line), categoryId);
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
      what: 'A clock that’s part of the task stays — “watch 9pm show”, “the 3pm meeting”',
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
      id: 'mcp-parse',
      entry: 'mcp',
      kind: 'nominal',
      what: 'parse_task (Raycast’s route) gives the same titles',
    },
    {
      id: 'review',
      entry: 'ui',
      kind: 'nominal',
      what: 'The capture bar’s Review previews the full title; nothing is saved',
    },
    {
      id: 'stands',
      entry: 'api',
      kind: 'edge',
      what: 'A reworded title, a notes overflow or a field with no words for it leaves the model’s title as it was',
      offDev: {
        file: 'packages/shared/src/titleWords.test.ts',
        test: 'a title the notes took the overflow from stands',
        why: 'the model decides whether it rewords or overflows — dev can’t make it',
      },
    },
    {
      id: 'spoken',
      entry: 'api',
      kind: 'edge',
      what: 'A spoken line keeps its words too, with its own meta (“remind me to”, “tonight”, “in 20 minutes”)',
      offDev: {
        file: 'packages/shared/src/titleWords.test.ts',
        test: 'spoken lines too, with their own meta words',
        why: 'the model decides whether it drops a spoken word — dev can’t make it; siri-capture’s rows run the spoken path',
      },
    },
    {
      id: 'raycast',
      entry: 'raycast',
      kind: 'nominal',
      what: 'The Raycast hotkey saves the same title',
      needsYou: 'Raycast runs on the Mac',
    },
  ],
  steps: [
    {
      id: 'api-sample',
      entry: 'api',
      proves: ['verbatim', 'due-out', 'due-kept', 'lead-category', 'lead-other'],
      title: 'The sample through parseTask: every class’s titles exact, tallies logged',
      async run(ctx) {
        const m = marker(ctx.nonce);
        const live = new Set(
          (await ctx.api.reads.listCategories()).map((c) => c.label.toLowerCase()),
        );
        // One word, this run's own: no live category or earlier run's can match it.
        const label = `quince${m}`;
        const cat = await ctx.api.writes.upsertCategory({ label, isWork: false });
        const parse = (line: string) => ctx.api.reads.parseTask(line);
        try {
          const fails = [
            ...(await sample(ctx, 'verbatim', verbatim(m), parse)),
            ...(await sample(ctx, 'due phrase', dueOut, parse)),
            ...(await sample(ctx, 'leading word', leads(m, label, live), parse, cat.id)),
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
      proves: ['mcp-parse'],
      title: 'parse_task: one line from each class, the same titles',
      async run(ctx) {
        const m = marker(ctx.nonce);
        const live = new Set(
          (await ctx.mcp.reads.listCategories()).map((c) => c.label.toLowerCase()),
        );
        const picks = [verbatim(m)[0]!, dueOut[0]!, leads(m, '', live).at(-1)!];
        const fails = await sample(ctx, 'mcp', picks, (line) => ctx.mcp.reads.parseTask(line));
        if (fails.length) throw new Error(fails.join('; '));
      },
    },
    {
      id: 'ui-review',
      entry: 'ui',
      proves: ['review'],
      title: 'Capture bar › Review: “…typed at 1 am” previews with “typed” kept; nothing saved',
      async run(ctx) {
        const s = verbatim(marker(ctx.nonce))[0]!;
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
        const why = miss(s, (await res.json()) as DevParseResult, null);
        if (why) throw new Error(`the preview: ${why}`);
        await ctx.ui.expectText(s.title, 10_000);
        await ctx.shot('review');
        await field.fill(''); // unsaved
        await new Promise((r) => setTimeout(r, 2_000)); // a create in flight reaches the ledger with its response
        if (ctx.createdIds().length !== created) throw new Error('the Review saved a task');
      },
    },
    noConsoleErrors,
  ],
};
