// The Review preview's category chip on the Simulator (docs/areas/tasks/quick-add.md): a real parse, the chip tapped,
// the keyboard and the field staying up. It was category-suggest's last step; on slot A the Simulator signs in as its
// own user in the iPhone lane (DEV-CHECK.md → Two users), whose partition has none of the browser lane's history, so
// this scenario seeds the same Garden and Kitchen history there first. In a one-user run category-suggest (order 260)
// has already seeded it this run, in the same partition, and the seed is skipped: a second Garden would split the
// history the chip is scored on. Both steps are slow, so a run that defers the sim seeds nothing.
import type { IosOp } from '../../mailroom/sim.ts';
import { DOCK, MODE_ROW } from '../ios';
import type { Ctx, Scenario } from '../scenario';
import { GARDEN, KITCHEN, name } from './category-suggest';
import { CATEGORY_SUGGEST_IOS_PATHS } from './ios-paths';

// The Simulator's own line: a verb no other step saves. A full run's real-review can file its line under
// another category (the model matches the run nonce to another scenario's category), and the same words
// then outvote Garden; measured, this one still clears the margin after every earlier save (2.8 nats).
const R_SIM_CHIP = 'shim the flux gasket';

// The sim types through its own keyboard, so the line is fixed words, no nonce. Nothing is saved. The field and the
// chip are found by scanning: the preview lifts the bar by its own height.
// Opens with its own launch: it can't count on ios-standalone leaving the sim up.
// A filled field reads as its value, and only over its text, with no textarea role (as ios-standalone
// finds 'zzqx'). Scanned down from the top, so the field wins over the preview's copy of the title below
// it, wherever the dock sits.
const REVIEW_KEYBOARD: IosOp[] = [
  { op: 'launch' },
  { op: 'signIn' },
  // A warm app holds the task list it loaded earlier in the run, before this scenario seeded its history.
  { op: 'kill', method: 'terminate' },
  { op: 'launch' },
  { op: 'nav', tab: 'Home' },
  { op: 'tap', label: 'Capture', near: { x: 220, y: 895 }, radius: 10 },
  // 4 s, not 2: since the mode-row scan starts at MODE_ROW (315) it can read the Task toggle mid-settle (y 374/402 on
  // 2026-11-12, against 464 settled), and a tap there misses the moving dock and blurs the field (jobs …011648Z…-8c62,
  // …010744Z…-6102). ios-standalone's CAPTURE waits 4 for the same settle.
  { op: 'wait', s: 4 },
  { op: 'tap', label: 'Task', scan: DOCK(110, MODE_ROW), role: 'AXCheckBox' },
  { op: 'keys', text: R_SIM_CHIP },
  // Send, since review-first (2026-11-17): the first press parses; ✨ beside it is the read-with-AI toggle now.
  { op: 'tap', label: 'Review before saving', scan: DOCK(395) },
  { op: 'wait', s: 6 },
  { op: 'shot', name: 'review-chip' },
  {
    op: 'find',
    label: R_SIM_CHIP,
    scan: { x: 60, from: 300, to: 600 },
    as: 'bar0',
  },
  { op: 'expect', as: 'bar0', aboveKeyboard: true },
  {
    op: 'find',
    label: 'Use suggested category',
    scan: { x: 195, from: 300, to: 600 },
    role: 'AXButton',
    as: 'chip',
  },
  { op: 'expect', as: 'chip', aboveKeyboard: true },
  {
    op: 'tap',
    label: 'Use suggested category',
    scan: { x: 195, from: 300, to: 600 },
    role: 'AXButton',
  },
  { op: 'wait', s: 1 },
  { op: 'shot', name: 'review-chip-tapped' },
  {
    op: 'find',
    label: R_SIM_CHIP,
    scan: { x: 60, from: 300, to: 600 },
    as: 'bar',
  },
  { op: 'expect', as: 'bar', aboveKeyboard: true },
  { op: 'absent', label: 'Use suggested category', scan: { x: 195, from: 300, to: 600 } },
  { op: 'shot', name: 'review-chip-taken' },
  { op: 'erase', n: R_SIM_CHIP.length },
  { op: 'tap', label: 'Log', scan: DOCK(49, MODE_ROW), role: 'AXCheckBox' },
  { op: 'blur' },
];

// This run's whole Garden history in this lane's partition: category-suggest's seed, when it ran here first and
// finished — a seed that stopped part-way would leave the chip short of history, so this one seeds afresh.
// Any Garden: a leftover one from an earlier run (the sweep's to delete) never hides this run's.
async function seeded(ctx: Ctx): Promise<boolean> {
  const gardens = new Set(
    (await ctx.api.reads.listCategories()).filter((c) => c.label === 'Garden').map((c) => c.id),
  );
  if (!gardens.size) return false;
  const filed = new Set(
    (await ctx.api.reads.listTasks())
      .filter((t) => !!t.categoryId && gardens.has(t.categoryId))
      .map((t) => t.title),
  );
  return GARDEN.every((g) => filed.has(name(ctx, g)));
}

export const categorySuggestIos: Scenario = {
  id: 'category-suggest-ios',
  title: 'Review preview’s category chip on the Simulator',
  tiers: ['full'],
  user: 'iphone',
  order: 265, // just after category-suggest, as its last step ran; in the iPhone lane, after ios-standalone
  slowPaths: CATEGORY_SUGGEST_IOS_PATHS,
  rows: [
    {
      id: 'review-keyboard',
      entry: 'ios',
      kind: 'nominal',
      what: 'iPhone PWA, real parse: Review a line, tap the chip: the keyboard stays up, the field stays above it, the chip goes',
    },
  ],
  steps: [
    {
      id: 'seed',
      entry: 'api',
      cost: 'slow',
      title:
        'Garden and Kitchen, 27 categorised tasks — unless category-suggest seeded them here this run (API)',
      async run(ctx) {
        if (await seeded(ctx)) return ctx.log('  category-suggest seeded this partition already');
        const garden = await ctx.api.writes.upsertCategory({ label: 'Garden', isWork: false });
        const kitchen = await ctx.api.writes.upsertCategory({ label: 'Kitchen', isWork: false });
        for (const t of GARDEN)
          await ctx.api.writes.createTask({ title: name(ctx, t), categoryId: garden.id });
        for (const t of KITCHEN)
          await ctx.api.writes.createTask({ title: name(ctx, t), categoryId: kitchen.id });
      },
    },
    {
      id: 'review-keyboard',
      entry: 'ios',
      cost: 'slow',
      proves: ['review-keyboard'],
      title: 'On the Simulator: Review, tap the chip; the keyboard stays up over a real parse',
      async run(ctx) {
        await ctx.ios.run('review-chip', REVIEW_KEYBOARD);
      },
    },
  ],
};
