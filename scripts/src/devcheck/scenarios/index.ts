// Every scenario the dev check knows. A feature adds scenarios/<feature>.ts and lists it here; `--tier
// delta --scenario <id>` runs just that one, `--tier full` runs them all.
import type { Scenario, Tier } from '../scenario';
import { captureTask } from './capture-task';
import { fluxHistory } from './flux-history';
import { partsV2 } from './parts-v2';
import { smoke } from './smoke';

export const SCENARIOS: Scenario[] = [smoke, captureTask, partsV2, fluxHistory];

export type RunTier = Tier | 'delta';

export function selectScenarios(tier: RunTier, ids: string[], all = SCENARIOS): Scenario[] {
  const unknown = ids.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length)
    throw new Error(
      `unknown scenario ${unknown.join(', ')} — known: ${all.map((s) => s.id).join(', ')}`,
    );
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
