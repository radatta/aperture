// Every scenario the dev check knows. A feature adds scenarios/<feature>.ts and lists it here; `--tier
// delta --scenario <id>` runs just that one, `--tier full` runs them all — their slow steps only where the
// branch touches the scenario's slowPaths or `--feature` names it — and `--tier all` runs every step.
// `--feature <id>` marks whose rows are the feature's in the report.
import type { Scenario, Tier } from '../scenario';
import { areas } from './areas';
import { attachmentDelete } from './attachment-delete';
import { calibrationIntegrity } from './calibration-integrity';
import { captureDock } from './capture-dock';
import { captureTask } from './capture-task';
import { categorySuggest } from './category-suggest';
import { cognitoRefresh } from './cognito-refresh';
import { deadRows } from './dead-rows';
import { devSlotB } from './dev-slot-b';
import { dayGuards } from './day-guards';
import { failedReads } from './failed-reads';
import { finance } from './finance';
import { fluxHistory } from './flux-history';
import { fluxPerf } from './flux-perf';
import { devConcurrencyCaps } from './dev-concurrency-caps';
import { inflightCap } from './inflight-cap';
import { iosStandalone } from './ios-standalone';
import { lcExtension } from './lc-extension';
import { lcSittings } from './lc-sittings';
import { partsV2 } from './parts-v2';
import { partsV2b } from './parts-v2b';
import { partsV2bReads } from './parts-v2b-reads';
import { phoneNits } from './phone-nits';
import { places } from './places';
import { planWriteRefetch } from './plan-write-refetch';
import { reflectionLine } from './reflection-line';
import { recurring } from './recurring';
import { smoke } from './smoke';
import { timedReminders } from './timed-reminders';
import { timerCredit } from './timer-credit';

export const SCENARIOS: Scenario[] = [
  smoke,
  devSlotB, // early and cheap: proves the run is on the slot its lock names before the long scenarios
  iosStandalone, // early: an asleep Mac is known (and short-circuits) before the long browser scenarios
  captureTask,
  captureDock,
  partsV2,
  partsV2b,
  partsV2bReads,
  dayGuards,
  deadRows,
  planWriteRefetch, // makes and tears down its own tasks, like day-guards; its timers stop before the next
  fluxHistory,
  fluxPerf,
  attachmentDelete,
  places,
  reflectionLine,
  phoneNits,
  timerCredit,
  calibrationIntegrity,
  recurring,
  areas,
  categorySuggest, // after areas: its 27 seeded tasks would push areas' Home picker past its cap of 30
  finance,
  timedReminders, // its cheap rows first; its poller chain (two tick waits) last, so it can defer whole
  cognitoRefresh,
  lcSittings, // its reps run in progress mid-scenario: after the Home and task scenarios that read the day
  devConcurrencyCaps,
  lcExtension, // rows only: the extension is proven off dev (scripts/src/lc-e2e) and in Safari
  inflightCap, // late: its check reads the whole run's console for a 429
  failedReads, // last: its intercepts and a 30 s wait shouldn't sit in front of the others
];

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

// A repo-relative glob: `**` crosses folders, `*` stays inside one.
export function globMatch(glob: string, path: string): boolean {
  const re = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${re}$`).test(path);
}

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
