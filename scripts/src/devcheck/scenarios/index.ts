// Every scenario the dev check knows, found on disk: each `scenarios/<id>.ts` exports one Scenario whose id is
// its file name, and nothing here lists it — so lanes adding scenarios don't all edit this file (DEV-CHECK.md →
// Writing a scenario). `--tier delta --scenario <id>` runs just that one, `--tier full` runs them all — their slow
// steps only where the branch touches the scenario's slowPaths or `--feature` names it — and `--tier all` runs
// every step. `--feature <id>` marks whose rows are the feature's in the report. `list.ts` prints them in order.
import { readdirSync } from 'node:fs';
import { globMatch } from '../glob';
import type { Scenario, Tier } from '../scenario';

// Files here that aren't scenarios.
const NOT_SCENARIOS = new Set(['index.ts', 'ios-paths.ts']);

// The run order of the scenarios that predate discovery, each at order (position + 1) × 10 — the comments say why
// one sits where it does. A newer scenario sets its own `order` (scenario.ts) to land between them; ties break by
// id. Frozen: never add to it.
export const LEGACY_ORDER = [
  'smoke',
  'dev-slot-b', // early and cheap: proves the run is on the slot its lock names before the long scenarios
  'ios-standalone', // early: an asleep Mac is known (and short-circuits) before the long browser scenarios
  'ios-probe', // opt-in (--feature/--scenario ios-probe); deferred whenever ios-standalone runs in full
  'capture-task',
  'capture-dock',
  'parts-v2',
  'parts-v2b',
  'parts-v2b-reads',
  'day-guards',
  'dead-rows',
  'plan-write-refetch', // makes and tears down its own tasks, like day-guards; its timers stop before the next
  'flux-history',
  'flux-perf',
  'attachment-delete',
  'places',
  'errand-rows-night',
  'log-mcp',
  'private-log',
  'reflection-line',
  'phone-nits',
  'timer-credit',
  'calibration-integrity',
  'recurring',
  'areas',
  'category-suggest', // after areas: its 27 seeded tasks would push areas' Home picker past its cap of 30
  'finance',
  'timed-reminders', // its cheap rows first; its poller chain (two tick waits) last, so it can defer whole
  'cognito-refresh',
  // Before lc-sittings and lc-coach: their sittings, attempts and slot changes today put the day under way on the
  // rules, which is never due a pick. Its pick (the setting on for its own steps only) leaves them the rules' plan.
  'lc-coach-ai',
  'lc-catalog',
  'lc-sittings', // its reps run in progress mid-scenario: after the Home and task scenarios that read the day
  'lc-coach', // after lc-sittings: it links its own roll, Starts on today's slot, and unlinks for the next
  'coach-fixes', // after lc-coach: its plan-mode counts start from what lc-coach (and lc-coach-ai) left due; links its own roll
  'dev-concurrency-caps',
  'bff-hardening',
  'bff-shapes',
  'per-slot-runs',
  'identifier-cleanup',
  'capture-titles', // its one category is gone before the scenarios after it
  'siri-capture', // late, and tears its tokens and tasks down itself: no later scenario sees its captures
  'lc-extension', // rows only: the extension is proven off dev (scripts/src/lc-e2e) and in Safari
  'failed-reads', // its intercepts and a 30 s wait shouldn't sit in front of the others
  'sitting-auto-close', // last of all: its ~50-min idle wait (slow: --feature / --tier all only) behind everything
] as const;

const isScenario = (x: unknown): x is Scenario =>
  !!x &&
  typeof x === 'object' &&
  typeof (x as Scenario).id === 'string' &&
  Array.isArray((x as Scenario).steps) &&
  Array.isArray((x as Scenario).rows) &&
  Array.isArray((x as Scenario).tiers);

// A file that loads no scenario, or two, or one under another id, fails the load: a silently skipped file is a
// scenario that never runs.
export function scenarioOf(file: string, mod: Record<string, unknown>): Scenario {
  const found = Object.values(mod).filter(isScenario);
  const id = file.replace(/\.ts$/, '');
  if (found.length !== 1)
    throw new Error(`scenarios/${file} exports ${found.length} scenarios — one a file`);
  if (found[0]!.id !== id)
    throw new Error(
      `scenarios/${file} exports scenario ${found[0]!.id} — its id must be its file name`,
    );
  return found[0]!;
}

export function orderOf(s: Scenario): number {
  const legacy = (LEGACY_ORDER as readonly string[]).indexOf(s.id);
  if (legacy >= 0) return (legacy + 1) * 10;
  if (s.order === undefined)
    throw new Error(
      `scenario ${s.id} has no order — set one (scenario.ts → order) to place it among the others`,
    );
  return s.order;
}

export const ordered = (all: Scenario[]) =>
  [...all].sort((a, b) => orderOf(a) - orderOf(b) || a.id.localeCompare(b.id));

export const scenarioFiles = (dir = new URL('.', import.meta.url)) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !NOT_SCENARIOS.has(f))
    .sort();

export const SCENARIOS: Scenario[] = ordered(
  await Promise.all(
    scenarioFiles().map(async (f) =>
      scenarioOf(f, (await import(`./${f}`)) as Record<string, unknown>),
    ),
  ),
);

export type RunTier = Tier | 'delta' | 'all';

function assertKnown(ids: string[], all: Scenario[]): void {
  const unknown = ids.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length)
    throw new Error(
      `unknown scenario ${unknown.join(', ')} — known: ${all.map((s) => s.id).join(', ')}`,
    );
}

export function selectScenarios(tier: RunTier, ids: string[], all = SCENARIOS): Scenario[] {
  assertKnown(ids, all);
  if (tier === 'delta') {
    if (!ids.length) throw new Error('--tier delta needs --scenario <id,…>');
    // smoke always leads: a delta run still proves sign-in and the shell before the feature's steps.
    return all.filter((s) => s.id === 'smoke' || ids.includes(s.id));
  }
  const inTier = all.filter((s) => s.tiers.includes(tier === 'all' ? 'full' : tier));
  const picked = ids.length ? inTier.filter((s) => ids.includes(s.id)) : inTier;
  if (!picked.length) throw new Error(`no scenario in tier ${tier} matches ${ids.join(', ')}`);
  return picked;
}

// The scenarios whose rows are this feature's. Each must be known, declare rows (smoke proves the harness, not
// a feature) and be in the run — a feature whose scenario didn't run has nothing to paste, so that is an
// error, not an empty section.
export function selectFeature(ids: string[], selected: Scenario[], all = SCENARIOS): string[] {
  assertKnown(ids, all);
  const rowless = ids.filter((id) => !all.find((s) => s.id === id)!.rows.length);
  if (rowless.length)
    throw new Error(
      `--feature ${rowless.join(', ')} declares no rows — smoke proves the harness, not a feature`,
    );
  const absent = ids.filter((id) => !selected.some((s) => s.id === id));
  if (absent.length)
    throw new Error(
      `--feature ${absent.join(', ')} is not in this run (${selected.map((s) => s.id).join(', ')}) — add --scenario, or a tier it runs in`,
    );
  return ids;
}

export { globMatch } from '../glob';

// The scenarios whose slow steps run this time (DEV-CHECK.md → Slow tier). `changed` is the branch's diff
// against origin/main; null when it couldn't be read — then nothing is deferred, never silently skipped.
export function slowScenarios(
  tier: RunTier,
  feature: string[],
  selected: Scenario[],
  changed: string[] | null,
): string[] {
  const slow = selected.filter((s) => s.steps.some((x) => x.cost === 'slow'));
  if (tier === 'all' || tier === 'delta' || changed === null) return slow.map((s) => s.id);
  return slow
    .filter(
      (s) =>
        feature.includes(s.id) ||
        changed.some((f) => (s.slowPaths ?? []).some((g) => globMatch(g, f))),
    )
    .map((s) => s.id);
}

// The probe job (ios-probe) reads the points ios-standalone's own jobs read: when those run in full, it is deferred
// with this note, never sent as well (IOS-CHECK.md → Probe job). run.ts passes this as the pipeline's `skip`.
export const PROBE_COVERED = 'ios-standalone runs in full this run: its probes are read there';
export function probeSkip(slow: string[]): (scenario: string) => string | null {
  const covered = slow.includes('ios-standalone') && slow.includes('ios-probe');
  return (scenario) => (covered && scenario === 'ios-probe' ? PROBE_COVERED : null);
}
