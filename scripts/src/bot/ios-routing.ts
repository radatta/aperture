// F3: a branch whose diff touches an iOS scenario's slowPaths goes to slot A — the Simulator is slot A's
// (SIM_SLOT_A_ONLY), so on devb its iPhone rows could only read needs-you (CI-BOT.md → Dev slots). The paths and the
// glob are the devcheck's own (no copy), from leaves with no imports, since the bot runs under plain node.
import { globMatch } from '../devcheck/glob.ts';
import { IOS_SLOW_PATHS } from '../devcheck/scenarios/ios-paths.ts';
import type { Run as Sh } from './sh.ts';

// The committed diff only: requirePushed makes HEAD what deploys. Three dots, so a branch behind main (lock acquire
// doesn't check) still names only its own changes; no renames, so a file moved out of an iOS path still counts.
export function iosFiles(sh: Sh): string[] {
  let out: string;
  try {
    out = sh('git', ['diff', '--name-only', '--no-renames', 'origin/main...HEAD']);
  } catch (err) {
    throw new Error(
      "couldn't diff against origin/main to see whether this branch touches iOS paths — `git fetch origin main`, then retry",
      { cause: err },
    );
  }
  return out.split('\n').filter((f) => f && IOS_SLOW_PATHS.some((g) => globMatch(g, f)));
}
