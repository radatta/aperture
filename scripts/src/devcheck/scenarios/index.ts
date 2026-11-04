// Every scenario the dev check knows. A feature adds scenarios/<feature>.ts and lists it here; `--tier
// delta --scenario <id>` runs just that one, `--tier full` runs them all. `--feature <id>` marks whose rows
// are the feature's in the report.
import type { Scenario, Tier } from '../scenario';
import { attachmentDelete } from './attachment-delete';
import { captureTask } from './capture-task';
import { failedReads } from './failed-reads';
import { fluxHistory } from './flux-history';
import { partsV2 } from './parts-v2';
import { partsV2b } from './parts-v2b';
import { smoke } from './smoke';

export const SCENARIOS: Scenario[] = [
  smoke,
  captureTask,
  partsV2,
  partsV2b,
  fluxHistory,
  attachmentDelete,
  failedReads, // last: its intercepts and a 30 s wait shouldn't sit in front of the others
];

export type RunTier = Tier | 'delta';

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
  const inTier = all.filter((s) => s.tiers.includes(tier));
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
