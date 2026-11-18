// @aperture/scripts — the data behind `pnpm gate:fast` (docs/ops/GATE.md): which changed paths force a full suite,
// and which tests read inputs vitest's import graph can't see. plan.ts applies it; rules.test.ts pins it against the
// real tree, so a rule can't rot and a new file-reading test can't go unregistered.
//
// Patterns: a trailing `/` is a directory prefix, `*` matches within one path segment, `**/` any number of
// directories, anything else is an exact path. In `tests`, a trailing `/` means every test file under that directory.

export interface Pkg {
  dir: string; // repo-relative
  name: string; // the pnpm filter
  reaches: string[]; // other package dirs its tests import from: a change there can select its tests
  projects: Project[]; // its vitest projects, as its vitest config sets them
}

// A vitest project's test globs, relative to the package dir. registry.ts checks every test-named file against them
// before the gate starts; includes.test.ts pins them to what `vitest list` finds. vitest's default exclude
// (node_modules, .git) is left out: the gate lists git files only.
export interface Project {
  name?: string; // vitest's projectName; unset for a single-project config
  include: string[];
  exclude?: string[];
}
const SRC = [{ include: ['src/**/*.test.ts'] }];

// Every workspace package with a vitest suite; rules.test.ts checks this against pnpm-workspace.yaml and checks
// `reaches` against the packages' actual imports.
export const PACKAGES: Pkg[] = [
  {
    dir: 'app',
    name: '@aperture/app',
    reaches: ['packages/shared'],
    projects: [
      {
        name: 'app',
        include: ['src/**/*.test.{ts,tsx}', 'pwa/**/*.test.ts'],
        exclude: ['src/auth/auth.test.tsx'],
      },
      { name: 'isolated', include: ['src/auth/auth.test.tsx'] },
    ],
  },
  { dir: 'lambdas', name: '@aperture/lambdas', reaches: ['packages/shared'], projects: SRC },
  { dir: 'packages/shared', name: '@aperture/shared', reaches: [], projects: SRC },
  { dir: 'cdk', name: '@aperture/cdk', reaches: ['packages/shared'], projects: SRC },
  {
    dir: 'extension',
    name: '@aperture/extension',
    reaches: ['packages/shared'],
    projects: [{ include: ['test/**/*.test.ts'] }],
  },
  { dir: 'scripts', name: '@aperture/scripts', reaches: [], projects: SRC },
];

export interface FullRule {
  match: string[];
  why: string;
  // PACKAGE_FULL only: the packages a non-`<pkg>` path runs whole, when they aren't (only) the one that owns it.
  pkgs?: string[];
}

// Any of these changed → the whole suite, every package: they change how every test is resolved, compiled or run.
export const REPO_FULL: FullRule[] = [
  {
    match: ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '.nvmrc', '.npmrc'],
    why: 'dependencies, toolchain or root scripts',
  },
  {
    match: ['tsconfig.json', 'tsconfig.base.json'],
    why: 'compiler settings every package extends',
  },
  { match: ['eslint.config.js'], why: 'lint config' },
  {
    match: ['scripts/board/heavy.sh', 'scripts/board/lib.sh', 'scripts/board/limits.json'],
    why: 'how every gate step is run and budgeted',
  },
  {
    match: ['identifiers.json'],
    why: 'read at import time by cdk (config/identifiers.ts) and scripts (identifiers.ts), behind a cast tsc can’t check',
  },
  {
    match: ['scripts/src/gate/'],
    why: 'the gate itself: a change to it is never judged by itself',
  },
];

// Any of these changed → that package's whole suite (`<pkg>` stands for each package dir).
export const PACKAGE_FULL: FullRule[] = [
  {
    match: [
      '<pkg>/package.json',
      '<pkg>/tsconfig*.json',
      '<pkg>/vitest.config.*',
      '<pkg>/vite.config.*',
    ],
    why: 'the package’s dependencies, compiler or test config',
  },
  { match: ['<pkg>/src/test/'], why: 'the package’s shared test setup (setupFiles) and harness' },
  // What a setupFile imports runs around every test of its package, yet no test imports a setupFile, so the graph
  // can't see it. rules.test.ts checks each setupFile's imports against these.
  {
    match: ['packages/shared/src/consoleGuard.ts'],
    pkgs: ['app', 'lambdas'],
    why: 'the console guard, which app’s and lambdas’ setupFiles load around every test',
  },
  {
    match: [
      'app/src/data/queryClient.ts',
      'app/src/auth/tokenStore.ts',
      'app/src/data/attachmentTransport.ts',
      'app/src/lib/useDisclosure.ts',
      'app/src/modules/finances/usePlaidLink.ts',
      'app/src/modules/pomodoro/chime.ts',
      'app/src/modules/flux/engine/engine.ts',
      'app/src/modules/flux/fluxOutbox.ts',
      'app/src/modules/flux/useFluxOutbox.ts',
      'app/src/modules/push/browserPush.ts',
    ],
    pkgs: ['app'],
    why: 'app/src/test/setup.ts resets its state after every app test',
  },
];

export interface InputRule {
  inputs: string[];
  tests: string[];
  why: string;
}

// Tests whose real inputs the graph can't see (file reads, raw imports, spawned processes). A changed path matching
// `inputs` adds `tests`. Every graph-blind test file is named in a rule's `tests`, ALWAYS_RUN or SELF_CONTAINED.
export const INPUT_RULES: InputRule[] = [
  {
    inputs: ['extension/manifest.json', 'app/pwa/extensionVersion.ts'],
    tests: ['app/src/pages/Settings/Settings.test.tsx', 'scripts/src/devcheck/scenarios/'],
    why: 'the extension’s version is the app’s "latest" (vitest.config.ts sets it from app/pwa/extensionVersion.ts) and lc-sittings.ts reads it from disk',
  },
  {
    inputs: ['extension/'],
    tests: ['extension/test/', 'scripts/src/lc-e2e/extension.test.ts'],
    why: 'test/load.ts reads extension/src/*.js from disk; lc-e2e boots the extension in a browser',
  },
  {
    inputs: ['lambdas/src/', 'packages/shared/src/'],
    tests: ['scripts/src/lc-e2e/extension.test.ts'],
    why: 'lc-e2e runs the extension against the local BFF (serve.ts, with shared inside), with no import edge to it',
  },
  {
    // rules.test.ts checks this list against every lambdas path a cdk/src/lib module names.
    inputs: [
      'lambdas/src/index.ts',
      'lambdas/src/mcp/index.ts',
      'lambdas/src/coachWorker.ts',
      'lambdas/src/financeSync.ts',
      'lambdas/src/kill/index.ts',
      'lambdas/src/pushDispatch.ts',
    ],
    tests: [
      'cdk/src/lib/app-stack.ts',
      'cdk/src/lib/coach-worker.ts',
      'cdk/src/lib/finance-sync.ts',
      'cdk/src/lib/org-stack.ts',
      'cdk/src/lib/push-dispatch.ts',
    ],
    why: 'the stacks name these Lambda entry files by path, and NodejsFunction checks they exist even with bundling skipped; naming the stack modules runs their importers',
  },
  {
    inputs: ['lambdas/src/', 'packages/shared/src/'],
    tests: ['scripts/src/smoke.test.ts'],
    why: 'imports lambdas/src/rpc/argSpecs.ts by path at runtime (and so everything it imports)',
  },
  {
    inputs: ['packages/shared/src/'],
    tests: ['scripts/src/devcheck/scenarios/siri-capture.ts'],
    why: 'loadShared imports shared’s dates/due/spokenTime/capture by URL; naming the module runs its importers',
  },
  {
    inputs: ['app/src/**/*.tsx', 'app/src/**/*.ts'],
    tests: ['app/src/styles/fieldSize.test.ts', 'app/src/styles/theme.test.ts'],
    why: 'raw import.meta.glob scanners over every app source file (the 16px input-zoom guard)',
  },
  {
    inputs: ['app/src/styles/'],
    tests: ['app/src/styles/tokens.test.ts'],
    why: 'reads tokens.css?raw',
  },
  {
    inputs: ['app/pages/'],
    tests: ['app/pwa/identityPages.test.ts'],
    why: 'reads app/pages/*.html',
  },
  {
    inputs: ['app/src/modules/flux/engine/model/'],
    tests: ['app/pwa/fluxModel.test.ts'],
    why: 'reads the model binary',
  },
  {
    inputs: ['app/index.html'],
    tests: ['scripts/src/board/tower/web/standalone.test.ts'],
    why: 'reads the app shell to keep the tower page’s standalone tags in step',
  },
  {
    inputs: ['cdk/src/lib/app-stack.ts'],
    tests: ['lambdas/src/local/edge.test.ts'],
    why: 'reads the stack source as text',
  },
  {
    inputs: ['cdk/cdk.json'],
    tests: ['cdk/src/stacks.test.ts'],
    why: 'reads cdk.json',
  },
  {
    inputs: ['cdk/src/'],
    tests: ['cdk/src/cicd.test.ts', 'scripts/src/deploy-base.test.ts'],
    why: 'walk cdk/src as text',
  },
  {
    inputs: ['packages/shared/src/stage.ts'],
    tests: [
      'scripts/src/deploy-base.test.ts',
      'scripts/src/devcheck/config.slots.test.ts',
      'scripts/src/bot/lock.test.ts',
    ],
    why: 'read stage.ts as text',
  },
  {
    inputs: ['packages/shared/src/rpc.ts'],
    tests: ['scripts/src/deploy-base.test.ts', 'scripts/src/devcheck/mcp.test.ts'],
    why: 'reads rpc.ts as text (the header names it pins)',
  },
  {
    inputs: ['packages/shared/src/coach.ts'],
    tests: ['scripts/src/devcheck/api.test.ts'],
    why: 'reads coach.ts as text',
  },
  {
    inputs: ['cdk/src/config/claudeConnector.ts'],
    tests: ['scripts/src/devcheck/config.test.ts'],
    why: 'reads the connector config as text',
  },
  {
    inputs: ['.github/'],
    tests: [
      'scripts/src/workflow-fork-guard.test.ts',
      'scripts/src/workflow-lanes.test.ts',
      'scripts/src/workflow-permissions.test.ts',
      'scripts/src/workflow-run-scripts.test.ts',
      'scripts/src/workflow-tiers.test.ts',
      'scripts/src/workflow-triggers.test.ts',
      'scripts/src/checked-tree.test.ts',
      'scripts/src/mask-function-url.test.ts',
      'scripts/src/cdk-diff-summary.test.ts',
    ],
    why: 'read the workflows and the setup action',
  },
  {
    inputs: ['docs/'],
    tests: ['scripts/src/checked-tree.test.ts', 'scripts/src/board/tower/web/server.test.ts'],
    why: 'read INFRA.md and TOWER.md',
  },
  {
    inputs: ['tools/mailroom/bench/'],
    tests: ['scripts/src/mailroom/sim-bench.test.ts'],
    why: 'reads and runs the bench files',
  },
  {
    inputs: ['tools/mailroom/jobs/sim.sh'],
    tests: ['scripts/src/ios-probe/check.test.ts'],
    why: 'mirrors sim.sh',
  },
  {
    inputs: ['tools/mailroom/'],
    tests: ['scripts/src/mailroom/', 'scripts/src/mailroom/submit.test.ts'],
    why: 'submit pins the repo runner version; mailroom/fixtures.ts and sim-bench-seed.ts read its testdata and bench plans',
  },
  {
    inputs: ['scripts/board/hub.json'],
    tests: ['scripts/src/bot/'],
    why: 'bot/cli.ts and bot/lock.ts read the hub’s name from it',
  },
  {
    inputs: ['tools/coi/xclip'],
    tests: ['scripts/src/mailroom/xclip-shim.test.ts'],
    why: 'spawns the shim',
  },
  {
    inputs: ['tools/macstats/'],
    tests: ['scripts/src/board/macstats-fixtures.test.ts'],
    why: 'runs the macstats scripts against fixtures',
  },
  {
    inputs: ['scripts/board/', '.claude/hooks/board-heavy-guard.sh'],
    tests: [
      'scripts/src/board/',
      'scripts/src/board/board-cli.test.ts',
      'scripts/src/board/lease.test.ts',
      'scripts/src/board/limits.test.ts',
      'scripts/src/board/tower/queue.test.ts',
      'scripts/src/board/watchers.test.ts',
      'scripts/src/lane/pace.test.ts',
      'scripts/src/lane/start.test.ts',
      'scripts/src/lane/state.test.ts',
    ],
    why: 'the board shell, its limits and the heavy guard, run by the board tests',
  },
  {
    inputs: ['.claude/', 'CLAUDE.md', 'README.md', 'LICENSE.md', 'SECURITY.md'],
    tests: [],
    why: 'read by no test but the always-run scanners (hooks run their own fixtures, not vitest)',
  },
  // Same-area tests: a scripts area's tests spawn its CLIs and read its files, so a change anywhere in the area runs
  // all of them (cheaper than one rule per spawn, and it keeps new spawns covered).
  ...['board', 'bot', 'devcheck', 'lane', 'mailroom', 'ios-probe', 'lc-e2e'].map((a) => ({
    inputs: [`scripts/src/${a}/`],
    tests: [`scripts/src/${a}/`],
    why: `the ${a} tests spawn its CLIs and read its files`,
  })),
  {
    inputs: [
      'app/vitest.config.ts',
      'cdk/vitest.config.ts',
      'extension/vitest.config.mts',
      'lambdas/vitest.config.ts',
      'packages/shared/vitest.config.ts',
      'scripts/vitest.config.ts',
    ],
    tests: ['scripts/src/gate/includes.test.ts'],
    why: 'pins PACKAGES[].projects to the files `vitest list` finds under each config',
  },
  {
    inputs: ['scripts/usage/'],
    tests: ['scripts/src/usage/statusline-log.test.ts'],
    why: 'spawns bash on scripts/usage/statusline-log.sh, which nothing imports',
  },
];

// Run on every fast gate: repo-wide scanners any path can break.
export const ALWAYS_RUN = [
  'scripts/src/tracked-identifiers.test.ts', // every git-tracked file
  'scripts/src/fixture-inputs.test.ts', // the hook fixtures' runtime modules, .github/ and docs
  'scripts/src/devcheck/scenarios/index.test.ts', // coverage matrices against app/lambdas/docs paths
  'scripts/src/board/tower/behind.test.ts', // the tower's import walk against TOWER_PATHS
  'scripts/src/gate/rules.test.ts', // these rules against the tree: a lane's new file-reading test must register
];

// Graph-blind by API, but every input is the test's own temp dir or an imported module: no rule needed.
export const SELF_CONTAINED: Record<string, string> = {
  'cdk/src/config/ciSecrets.test.ts': 'temp dir',
  'scripts/src/bot/cli.test.ts': 'spawns bot/cli.ts (same area)',
  'scripts/src/bot/lock-cache.test.ts': 'temp dir',
  'scripts/src/board/cli-help.test.ts': 'temp dir',
  'scripts/src/board/main-lock.test.ts': 'temp lock files',
  'scripts/src/board/sync-main.test.ts': 'spawns board/cli.ts (same area) on a temp repo and lock',
  'scripts/src/board/tower/lanes.test.ts': 'temp dir',
  'scripts/src/bot/logs.test.ts': 'temp dir',
  'scripts/src/commit-identity.test.ts': 'temp repos; spawns its sibling commit-identity.ts',
  'scripts/src/devcheck/ios-plans.test.ts': 'reads devcheck/scenarios (same area)',
  'scripts/src/devcheck/ledger.test.ts': 'temp dir',
  'scripts/src/devcheck/login.test.ts': 'temp dir',
  'scripts/src/devcheck/mcp-login.test.ts': 'temp dir',
  'scripts/src/identifiers-scan.test.ts': 'temp repos',
  'scripts/src/lane/archive.test.ts': 'temp dir',
  'scripts/src/lane/cli.test.ts': 'reads lane/*.ts (same area)',
  'scripts/src/lane/end.test.ts': 'temp dir',
  'scripts/src/mailroom/clip.test.ts': 'temp dir',
  'scripts/src/vapid-keys.test.ts': 'spawns its sibling vapid-keys.ts',
  'scripts/src/main-dev-wait.test.ts': 'spawns its sibling main-dev-wait.ts (also imported)',
  'scripts/src/root-scripts.test.ts': 'reads the root package.json, a REPO_FULL trigger',
  'scripts/src/usage/cli.test.ts': 'temp dirs',
  'scripts/src/usage/scan.test.ts': 'temp dirs',
  'scripts/src/identifiers.test.ts': 'reads identifiers.json, a REPO_FULL trigger',
  'extension/test/load.ts':
    'helper: its importers are the extension tests, all run by the extension/ rule',
};

// Non-test modules that read files, import by a computed path or spawn: a test that imports one inherits its reads,
// and the graph sees only the import. Each says what it reads and what runs its importers' tests when that changes;
// runtime state no tracked file feeds needs no rule. rules.test.ts fails on a new one until it's listed here (the
// gate's own files are exempt: any change to them is REPO_FULL).
const RUNTIME = 'runtime state only (no tracked input)';
const STACK_ENTRY =
  'Lambda entry paths, which NodejsFunction checks exist even with bundling skipped (the entry-file rule)';
export const MODULE_READERS: Record<string, string> = {
  'app/pwa/identityPages.ts':
    'app/pages/*.html (the app/pages/ rule) and identifiers.json (REPO_FULL)',
  'app/pwa/extensionVersion.ts':
    'extension/manifest.json (the manifest rule); only the vite and vitest configs import it (PACKAGE_FULL)',
  'app/src/modules/flux/engine/tracker.ts': 'a method named spawn: no process, no file',
  'app/vite.config.ts': 'app/pages and identifiers.json for the build; itself PACKAGE_FULL',
  'cdk/src/bin/aperture.ts': 'the cdk app entry: gitignored secret files; no test imports it',
  'cdk/src/config/ciSecrets.ts': 'gitignored secret files',
  'cdk/src/config/identifiers.ts': 'identifiers.json (REPO_FULL)',
  'cdk/src/lib/app-stack.ts': STACK_ENTRY,
  'cdk/src/lib/coach-worker.ts': STACK_ENTRY,
  'cdk/src/lib/finance-sync.ts': STACK_ENTRY,
  'cdk/src/lib/org-stack.ts': STACK_ENTRY,
  'cdk/src/lib/push-dispatch.ts': STACK_ENTRY,
  'scripts/aws/fetch-dev-logs.mjs': 'the aws CLI at run time; no test imports it',
  'scripts/aws/fetch-stack-outputs.mjs': 'the aws CLI at deploy time; no test imports it',
  'scripts/aws/health-check.mjs': 'cdk outputs and app/dist at deploy time; no test imports it',
  'scripts/aws/publish-frontend.mjs': 'cdk outputs and app/dist at deploy time; no test imports it',
  'scripts/src/board/cli.ts': `${RUNTIME}: board dir, cgroup, git; limits.json is REPO_FULL`,
  'scripts/src/board/main-lock.ts': `${RUNTIME}: a flock file`,
  'scripts/src/board/sessions.ts': `${RUNTIME}: the board dir`,
  'scripts/src/board/sync-main.ts': `${RUNTIME}: git on /workspace`,
  'scripts/src/board/tower/behind.ts': `${RUNTIME}: a git dir's HEAD`,
  'scripts/src/board/tower/gh.ts': `${RUNTIME}: gh`,
  'scripts/src/board/tower/health.ts': `${RUNTIME}: board and log files`,
  'scripts/src/board/tower/jsonl.ts': `${RUNTIME}: transcript files`,
  'scripts/src/board/tower/lanes.ts': `${RUNTIME}: lane files`,
  'scripts/src/board/tower/main.ts': `${RUNTIME}: gh, or a --fixtures dir its tests pass`,
  'scripts/src/board/tower/prs.ts': `${RUNTIME}: gh`,
  'scripts/src/board/tower/source.ts': `${RUNTIME}: board and localNotes files`,
  'scripts/src/board/tower/web/main.ts': `${RUNTIME}: lane files, /proc, --fixtures; limits.json is REPO_FULL`,
  'scripts/src/board/tower/web/server.ts': 'its own web/ dir (the board same-area rule)',
  'scripts/src/usage/cli.ts': `${RUNTIME}: the usage dir, settings, the lane archive, board history; hub.json only names the hub`,
  'scripts/src/usage/gh.ts': `${RUNTIME}: gh`,
  'scripts/src/usage/scan.ts': `${RUNTIME}: transcript files, the cgroup`,
  'scripts/src/usage/store.ts': `${RUNTIME}: the usage cache`,
  'scripts/src/bot/cli.ts': 'scripts/board/hub.json (its rule runs the bot tests)',
  'scripts/src/devcheck/scenarios/lc-sittings.ts': 'extension/manifest.json (the manifest rule)',
  'scripts/src/bot/config.ts': 'the gitignored bot env file and key',
  'scripts/src/bot/lock-cache.ts': `${RUNTIME}: localNotes/board`,
  'scripts/src/bot/logs.ts': `${RUNTIME}: fetched log files`,
  'scripts/src/bot/prune.ts': `${RUNTIME}: worktree dirs`,
  'scripts/src/bot/sh.ts': `${RUNTIME}: git and gh`,
  'scripts/src/cdk-diff-summary.ts': 'spawns cdk diff at deploy time',
  'scripts/src/checked-tree.ts': `${RUNTIME}: git`,
  'scripts/src/classify-changes.ts': 'stdin',
  'scripts/src/commit-identity.ts': 'stdin',
  'scripts/src/deploy-base.ts': `${RUNTIME}: git diff`,
  'scripts/src/devcheck/browser.ts': 'the installed playwright package (the lockfile is REPO_FULL)',
  'scripts/src/devcheck/config.ts': `${RUNTIME}: git and a gitignored env file`,
  'scripts/src/devcheck/ledger.ts': `${RUNTIME}: the ledger file`,
  'scripts/src/devcheck/local/run-local.ts': `${RUNTIME}: git diff and the scenario files (same area)`,
  'scripts/src/devcheck/local/server.ts':
    'spawns lambdas/src/local/serve.ts, shared inside (lc-e2e runs it, by the lambdas/ + shared rule)',
  'scripts/src/devcheck/login.ts': `${RUNTIME}: a storage-state file`,
  'scripts/src/devcheck/run.ts': `${RUNTIME}: a pid lock and the scenario files (same area)`,
  'scripts/src/devcheck/scenarios/per-slot-runs.ts': `${RUNTIME}: the branch's git diff`,
  'scripts/src/devcheck/scenarios/siri-capture.ts': 'packages/shared/src (its rule)',
  'scripts/src/fixture-inputs.ts': 'stdin',
  'scripts/src/identifiers-scan.ts': 'stdin',
  'scripts/src/identifiers.ts': 'identifiers.json (REPO_FULL)',
  'scripts/src/ios-probe/run.ts': `${RUNTIME}: Simulator results and git`,
  'scripts/src/lane/archive.ts': `${RUNTIME}: the dirs it archives`,
  'scripts/src/lc-e2e/chrome-build.ts': 'extension/ (its rule runs lc-e2e)',
  'scripts/src/mac-root.ts': 'the gitignored .local/mac-root',
  'scripts/src/mailroom/fixtures.ts': 'tools/mailroom/testdata (its rule runs the mailroom tests)',
  'scripts/src/mailroom/sim-bench-seed.ts':
    'tools/mailroom/bench/plans.json (its rule runs the mailroom tests)',
  'scripts/src/mailroom/submit.ts': 'job files at run time; tools/mailroom/jobs (its rule)',
  'scripts/src/mask-function-url.ts':
    'the aws CLI and workflow files at deploy time (the .github/ rule runs its test)',
  'scripts/src/smoke.ts': 'the aws CLI at deploy time',
};

// The mailroom fixture suite keeps CI's own rule (fixture-inputs.ts): it runs exactly when one of its inputs changed.
export const FIXTURE_RULE = 'fixture-inputs.ts';

// Past this many changed paths the selection is most of the suite anyway: run it all.
export const MAX_CHANGED = 150;

// What the graph can follow: these are passed to `vitest related`; any other changed file under a package dir that no
// rule claims makes that package full (an unknown input, run more).
export const MODULE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css)$/;
