// per-slot-runs: each dev slot has its own devcheck run lock, so a dev run and a devb run may overlap (config.ts →
// runLockFile), and `pnpm bot deploy-dev` sends a branch touching iOS paths to slot A, the only slot with a
// Simulator (bot/ios-routing.ts, CI-BOT.md → Dev slots). A run holds one slot, so the lock and routing rules are the
// bot's and the harness's own tests; dev proves the outcome a run can see — an iOS-touching branch is on dev. That
// step is slow, gated on the iOS paths: a branch touching none defers it, rather than passing it vacuously.
import { execFileSync } from 'node:child_process';
import { currentSlot } from '../config';
import { globMatch } from '../glob';
import { noConsoleErrors, type Row, type RowKind, type Scenario } from '../scenario';
import { IOS_SLOW_PATHS } from './ios-paths';

const off = (
  id: string,
  what: string,
  file: string,
  test: string,
  why: string,
  kind: RowKind = 'edge',
): Row => ({ id, entry: 'api', kind, what, offDev: { file, test, why } });
const BOT =
  'which slot a branch gets is the bot’s choice before any deploy; a run holds one slot, so it can’t make the other choice happen';
const HARNESS = 'the lock files live in the container, not on dev; the harness’s tests drive them';

export const perSlotRuns: Scenario = {
  id: 'per-slot-runs',
  title: 'Per-slot devcheck runs, and iOS branches routed to slot A',
  tiers: ['full'],
  slowPaths: [...IOS_SLOW_PATHS, 'scripts/src/devcheck/scenarios/per-slot-runs.ts'],
  rows: [
    {
      id: 'ios-on-a',
      entry: 'api',
      kind: 'nominal',
      what: 'A branch touching iOS paths runs its devcheck on dev (slot A), where the Simulator is',
    },
    off(
      'own-lock',
      'Each slot has its own run lock, so a devb run doesn’t wait for a dev run',
      'scripts/src/devcheck/config.slots.test.ts',
      'keeps per-slot files apart, the run lock included, so the two slots’ runs may overlap',
      HARNESS,
      'nominal',
    ),
    off(
      'same-slot-refused',
      'A second run on the same slot still refuses',
      'scripts/src/devcheck/run.test.ts',
      'is exclusive while held, and free after release',
      HARNESS,
    ),
    off(
      'seed-waits',
      'A devcheck running refuses the sim-bench seed before it takes the dev lock',
      'scripts/src/mailroom/sim-bench-seed.test.ts',
      'refuses while a devcheck runs, before taking the dev lock (none leaks)',
      HARNESS,
    ),
    off(
      'deploy-to-a',
      'deploy-dev sends an iOS branch to dev, and waits for it rather than take a free devb',
      'scripts/src/bot/deploy-dev.test.ts',
      'sends a branch touching iOS paths to slot A, and refuses rather than take a free devb when A is held',
      BOT,
      'nominal',
    ),
    off(
      'devb-refused',
      'An iOS branch holding devb, or asking for it by name, is refused with the way to slot A',
      'scripts/src/bot/lock.test.ts',
      'pins a branch with iOS paths to slot A: waits for it, never takes or keeps devb',
      BOT,
    ),
    off(
      'non-ios-to-b',
      'A branch nothing iOS can see still falls through to devb when dev is held',
      'scripts/src/bot/deploy-dev.test.ts',
      'takes slot B when another branch holds A, dispatches devb, and leaves A alone',
      BOT,
      'nominal',
    ),
    off(
      'ios-files',
      'The routing reads only the files the Simulator proves',
      'scripts/src/bot/ios-routing.test.ts',
      "keeps the files only slot A's Simulator proves: the app's iOS surface, the sim harness, the probe job",
      BOT,
    ),
    off(
      'one-list',
      'The routing list is exactly every iOS scenario’s slowPaths',
      'scripts/src/devcheck/scenarios/index.test.ts',
      "the bot's iOS routing list is exactly every iOS scenario's slowPaths",
      'a list compared with a list; nothing on dev changes it',
    ),
    off(
      'plain-node',
      'The bot still loads under plain node with the devcheck leaves it now imports',
      'scripts/src/bot/cli.test.ts',
      'loads and prints its usage',
      'how the CLI loads, before it talks to anything',
    ),
    off(
      'devb-note',
      'An iOS branch that reached devb anyway reads needs-you naming the way to slot A',
      'scripts/src/devcheck/ios.test.ts',
      'on devb a branch touching iOS paths reads needs you with the way to slot A, never a quiet skip',
      'with F3 in place a branch reaches devb only around the bot, which a run can’t stage',
    ),
    {
      id: 'two-at-once',
      entry: 'api',
      kind: 'nominal',
      what: 'Two sessions’ devchecks on dev and devb run at the same time',
      needsYou:
        'a run holds one slot; the hub watches the first real overlap (two overlapping ledger windows)',
    },
    {
      id: 'headroom',
      entry: 'api',
      kind: 'nominal',
      what: 'The kill alarms keep their headroom for a two-lane hour',
      needsYou:
        'measured from dev’s REPORT lines (`pnpm bot logs --query`), not a run: the numbers are in the PR body',
    },
  ],
  steps: [
    {
      id: 'slot-a-for-ios',
      title: 'A branch touching iOS paths is on dev',
      entry: 'api', // reads the branch's diff and the slot its lock put this run on — no call to dev
      cost: 'slow',
      proves: ['ios-on-a'],
      async run(ctx) {
        // The committed diff, as the bot routes it (ios-routing.ts).
        const files = execFileSync(
          'git',
          ['diff', '--name-only', '--no-renames', 'origin/main...HEAD'],
          {
            encoding: 'utf8',
          },
        )
          .split('\n')
          .filter((f) => f && IOS_SLOW_PATHS.some((g) => globMatch(g, f)));
        if (!files.length) {
          ctx.log(`no iOS paths in this branch's diff: either slot is fine (${currentSlot()})`);
          return;
        }
        if (currentSlot() !== 'dev')
          throw new Error(
            `this branch touches iOS paths (${files.slice(0, 3).join(', ')}) but runs on ${currentSlot()} — deploy-dev should have sent it to dev`,
          );
        ctx.log(`iOS paths (${files.slice(0, 3).join(', ')}) → on dev, where the Simulator is`);
      },
    },
    noConsoleErrors,
  ],
};
