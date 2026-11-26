# The lane gate — `pnpm gate:fast` locally, the full suite on GitHub

A lane's gate (FEATURE-WORKFLOW.md → phase 5) is **`pnpm gate:fast`**. It runs a full `tsc -b` and a full cached
`eslint .`, then only the tests the branch's diff can reach. The **full suite runs once per push on GitHub**, in the
`Branch` workflow (INFRA §9 → _Branch runs_), and **`pnpm gate:ci`** reads its verdict. The all-clear needs that run
green on the head sha (phase 9). **The full suite still decides every merge:** the gate only chooses what runs in the
container before a push; the PR check that merges a branch runs every test, whatever the gate's rules say.

Why: every lane used to run the full suite 4–6 times. With 3–8 lanes, the shared container ran at load 18–29 on 9
cores, typecheck and lint ran ×4–9 slower than their median, and a suite held ~8 cores for 3–6 min (2026-11-17,
`faster-lanes`).

## What `gate:fast` runs

```
pnpm gate:fast [--full] [--dry-run] [--base <ref>] [--wait <sec>]
```

1. **The diff:** everything since the merge-base with `origin/main` — committed, staged, unstaged and untracked, with
   a move counted as a delete plus an add.
2. **The plan** (`scripts/src/gate/plan.ts`, pure): for each package, its **whole suite**, a **fast** run, or
   **skip**. A fast run is `vitest related` on the changed modules plus the test files a rule names. The plan is
   printed with the reason for each choice, so a skip is never silent.
3. **The steps, at once.** The gate re-runs itself under one outer `scripts/board/heavy.sh` slot, then starts every
   step inside it, each under its own `heavy.sh` (through `step.sh`, which reports its exit code) with `HEAVY_NOSLOT` naming the outer one: measured and logged, but
   taking no slot (SESSION-BOARD.md → _Heavy wrapper_).
   - **Wide** means 3+ packages' tests, or any whole suite. A wide gate counts as a full suite: its slot is a `test`
     one, so it takes one of the 2 full-suite places, with the same wait and exit 75 (`--wait <sec>` sets the wait,
     90 s by default). It logs as `gate-wide`.
   - **Narrow** holds an uncapped `test-fast` slot and logs as `gate-narrow`.
   - The inner pass plans again after the slot wait. If the diff has widened past a narrow slot meanwhile, it refuses
     with exit 2; run the gate again.

   | Step                                                                | Class (event)    | Workers                 |
   | ------------------------------------------------------------------- | ---------------- | ----------------------- |
   | `pnpm typecheck`                                                    | `gate-typecheck` | — (one core)            |
   | `pnpm lint`                                                         | `gate-lint`      | — (one core)            |
   | Per fast package: `pnpm --filter <pkg> exec vitest related --run …` | `gate-test-fast` | below                   |
   | Per full package (always wide): `pnpm --filter <pkg> test`          | `gate-test`      | below                   |
   | The whole repo: `pnpm test`, after typecheck and lint, alone        | `gate-test`      | 4 a package, as a suite |

   Every step logs a `gate-*` class, so the solo baselines (`typecheck`, `lint`, `test`) and the board's slot-job
   counts stay clean. The outer run is the gate's one slot job.

   - **The budget** bounds what runs at once: 10 tokens wide (`BUDGET`, about a suite's cores), 6 narrow
     (`NARROW_BUDGET`: one 4-worker package beside tsc and eslint, near the sequential gate's peak, since a narrow
     gate is uncapped).
     - A test step costs its workers; typecheck and lint cost 1 each, since `tsc -b` and eslint are single-threaded.
     - Scripts costs 7 (`SCRIPTS_COST`, one more than app leaves free) at its 2 workers. Its tests spawn shells and
       CLIs: a wide gate's scripts set ran ~220 threads and ~2.2 GB, an app run's weight; beside app, a replayed
       wide gate's process tree reached 7 GB against a suite's 5.2 at most. So it never runs beside app, and in a
       narrow gate it runs alone. A narrow set is often lighter, but a `scripts/board` diff makes it as heavy, so the
       cost is flat (it costs a light narrow gate ~10 s).
   - **Start order:** longest first, a smaller step filling any gap: app, extension, typecheck, lint, cdk, lambdas,
     shared, and scripts last.
   - **Workers:** a wide gate uses `WIDE_WORKERS` (app 4; extension, lambdas, cdk and scripts 2; shared 1). A narrow
     one keeps 4 a package, and the budget runs a second package after the first, as the sequential gate did. Scripts
     always pins 2, as its own test script does.
   - **The whole suite** costs the full budget, so it runs alone once typecheck and lint are done.
   - **Output:** each step's output is held and printed as one block when it finishes, under
     `── <step> · ok|exit n · s ──`. `▶ <step>` marks its start.
   - **The exit code** is the first failing step's in the printed order (typecheck, lint, then the packages), not in
     finishing order.
     - Every step still runs.
     - 75 means `heavy.sh` gave up on the cap, which is a failure, never a pass.
     - 1 before any step is the registry check (_The rules_, below); 2 is a bad argument, the inner pass outside
       `heavy.sh`, or a diff that widened past its slot.
     - INT, TERM or HUP to the gate's own pid is passed on to the outer `heavy.sh`, which stops every step. The gate
       then exits 128+n.
   - A fast run that names tests fails if it selects no file at all (a path or include drift, since a named test
     always matches itself).
   - The caller's `VITEST_MAX_WORKERS`, `HEAVY_*` and `GATE_*` never reach a step.

`--full` runs the whole suite, e.g. to reproduce a red Branch run. `--dry-run` prints the plan and runs nothing.

## `--remote`: the tests' verdict from GitHub

```
pnpm gate:fast --remote [--dry-run] [--base <ref>] [--wait <sec>]
```

Typecheck and lint run in the container as always, in a narrow slot (`gate-narrow`); the tests don't. Their verdict is
GitHub's run for `HEAD`, read the way `gate:ci` reads it (the PR run, else the Branch run), polled every 15 s
(`ci-offload`, 2026-11). It exists because tests were about half the container's heavy core-hours, and a Branch run
now finishes in ~2 min (_The full suite on GitHub_, below).

- **Green** (exit 0): the run for exactly `HEAD` passed. It prints the run and the sha.
- **Red** (exit 1): the run failed; it names the failed jobs. Run `pnpm gate:ci` for the miss check.
- **A red typecheck or lint** fails at once; GitHub isn't asked.
- **Anything else runs the local tests instead** — the plain `gate:fast` plan, with one line saying why, never a pass:
  - a dirty tree (any `git status --porcelain` line, untracked included): the pushed commit isn't what's on disk;
  - no run for the sha after `REMOTE_START_S` (90 s): not pushed;
  - `gh` failing for 90 s straight, retried every 15 s (offline, unauthenticated);
  - a `cancelled` run (a newer push superseded it);
  - no verdict within `REMOTE_WAIT_S` (600 s).
- A commit or edit while it waits (the slot, the steps, GitHub) falls back too: the verdict is for exactly the `HEAD`
  and tree it started on.
- A fallback re-enters the plain gate, so typecheck and lint run again there (warm, seconds).
- `--full` and `--remote` together is a bad argument (exit 2).

So the order is commit, `pnpm bot push` (with its scan first: FEATURE-WORKFLOW.md → phase 5), then
`pnpm gate:fast --remote`. `--remote` is opt-in, not the default yet.

## The rules

`scripts/src/gate/rules.ts` is the one home. `rules.test.ts` pins it against the real tree.

**A change that runs the whole suite:**

- **Every package** (`REPO_FULL`): the lockfile, the workspace file, the root `package.json`, `.nvmrc`/`.npmrc`, the
  root tsconfigs, the eslint config, `identifiers.json` (cdk and scripts read it at import time, behind a cast `tsc`
  can't check), and the gate's selection code: `cli.ts`, `plan.ts`, `registry.ts`, `base.ts`, `step.sh`,
  `fixture-inputs.ts`, `bot/sh.ts` (it reads the diff) and any gate file the rule's `except` doesn't name yet (`rules.test.ts` pins that list). A bug there could skip
  tests in the very run judging it.
- **One package** (`PACKAGE_FULL`): its `package.json`, tsconfigs and vitest/vite config, and its `src/test/` (the
  shared test setup and harness). Also every module a setupFile imports from outside `src/test/` — the console guard
  (app and lambdas), the modules app's `setup.ts` resets: no test imports a setupFile, so the graph never sees them.
  `rules.test.ts` checks each setupFile's imports against these rules.
- **Everything, also:** an empty or unreadable diff, or more than `MAX_CHANGED` (150) changed paths.

**A `rules.ts` change** (data only: it imports nothing) is planned twice, with HEAD's rules and with the merge-base's
(`base.ts`, which loads that copy from a temp `.mts`), and the union runs, so a rules edit can't narrow its own gate.
The whole suite runs instead when the base copy can't be read or loaded, `rules.ts` is added or deleted, or the
package list differs. A branch whose merge-base predates a rules change keeps that older base's triggers until it
rebases. The rest of the gate dir (`ci.ts`, `miss.ts`, `related.ts`, the tests) is ordinary code, and the gate
same-area rule runs every gate test on any change to it.

**A change that runs named tests:**

- **A snapshot** (`__snapshots__/x.test.ts.snap`) runs only `x.test.ts` beside its folder. An orphan snapshot is
  refused up front by the registry check; when that check was skipped, it runs its package.
- **A graph-blind input** (`INPUT_RULES`) runs the tests that read it from disk, raw-import it, or spawn it.
  - Same-area rules: a change under `scripts/src/<area>/` (board, bot, devcheck, gate, lane, mailroom, ios-probe,
    lc-e2e) runs every test in that area, which covers the CLIs those tests spawn.
  - The board shell (`scripts/board/`: `heavy.sh`, `lib.sh`, `limits.json`, the watchers) runs every test under
    `scripts/src/board/` and `scripts/src/lane/`, which spawn it and read it; `limits.json` also runs
    `gate/cli.test.ts`, which pins `NARROW_WORKERS` to it.
    Every vitest reader is in scripts, and CI never runs `heavy.sh`. A broken `heavy.sh` can't pass the gate: the
    inner pass and every step report their own exit codes past it, through a file named in their env (`GATE_RESULT`;
    `GATE_STEP_RESULT`, written by `step.sh`), and a `heavy.sh` 0 with no report is exit 2. The hook fixtures read `limits.json` too, outside vitest: after a change to it, run them by hand
    (`.claude/hooks/README.md` → _Testing_), as before.
  - `extension/` runs every extension test plus `lc-e2e`, because `test/load.ts` reads the extension's `.js` from
    disk.
- **A changed module** runs `vitest related` in its own package and in every package that imports it (`reaches`).
  Every package but `scripts` reaches `packages/shared`. Its sibling `x.test.ts` also runs by name. `scripts` imports
  no package statically; the scripts code that loads lambdas or shared source at runtime comes in by rule (the smoke
  test's `argSpecs.ts`, lc-e2e's spawned local BFF, siri-capture's shared helpers, deploy-base's header pins).
- **A Lambda entry file** (`lambdas/src/index.ts`, `coachWorker.ts` and the others a stack names by path) runs the cdk
  stack tests. `NodejsFunction` checks the file exists even with bundling skipped, and `tsc` never sees the path;
  `rules.test.ts` keeps the list in step with the stacks.
- **The mailroom fixture suite** runs exactly when CI's own rule says so (`fixture-inputs.ts`).
- **`ALWAYS_RUN`**: the repo-wide scanners any path can break (tracked identifiers, fixture inputs, the devcheck
  coverage matrix, the tower's import walk).

**Unknown means run more:**

- A path outside every package that no rule names runs every test any rule names by file.
- A file in a package that neither a rule nor the graph can see runs that package's whole suite.

**A deleted code module** (`.ts`/`.js` family) widens nothing. Its importers either changed, so they are in
`related`, or no longer typecheck, and `tsc -b` runs in full every gate. A deleted `.css` or `.json` in a package runs its
package even when a rule claims it: an ambient declaration can still type its import, and the rule's tests aren't
necessarily its importers. Any other deleted file is read from disk, so a claiming rule's tests are its readers;
unclaimed, it runs its package.

**Adding code that reads files, imports by a computed path (`import(x)`, a template with `${}`, any
`new URL(…, import.meta.url)`) or spawns:**

- A test: name it in an `INPUT_RULES` entry (what it reads), `ALWAYS_RUN`, or `SELF_CONTAINED` (temp dirs or
  same-area only, with why).
- A setupFile import (a new reset in `app/src/test/setup.ts`, say): add the module to its `PACKAGE_FULL` rule;
  `rules.test.ts` names it if you don't.
- Any other module: list it in `MODULE_READERS` with what it reads. A tracked input also needs a rule that runs its
  importers' tests; naming the module in a rule's `tests` does that, since `vitest related` runs a module's importers.
  Runtime-only state (the board dir, git, `gh`) needs none.

**The registry check runs first** (`registry.ts`, ~1–2 s, the caller pass in every mode, `--dry-run` too). It exits
1 before any step, naming the file, why and the fix, on: a test-named file no vitest project includes, two include,
or `isTest` won't name (`PACKAGES[].projects`, which `includes.test.ts` pins to `vitest list`); a glob it would read
differently from vitest; an unregistered graph-blind test or module; an orphan snapshot; an unclaimed fixtures
folder. A check that can't run (git fails or lists nothing, a file won't read) is skipped aloud. `rules.test.ts` runs
the same check in CI over tracked and untracked files, so a lane's new file fails before its first commit until it's
registered.

## A miss

On a failed run (conclusion `failure`), `gate:ci` prints the verdict, then checks each failing test file against what
`gate:fast` plans for that sha (`miss.ts`). It reads the failing files from `gh run view --log-failed` (vitest's
`FAIL <path>` lines, the package from pnpm's `<dir> test:` prefix or an app shard's job name) and judges each:

- **ran:** the repo or its package ran whole, the plan named it, or `vitest related` reaches it (`related.ts` reads its
  imports with vitest's own walk, without running a test);
- **missed:** its package was skipped, ran named tests only, or no changed module reaches it;
- **unsure:** the checkout isn't at the run's sha or has tracked edits (so its rules may not be the run's: every file
  is unsure), the file is in no test package or vitest doesn't collect it, the graph helper failed, or a PR run tests
  a merge with a main that has moved past the merge-base (a miss there is only unsure; "moved" is judged by the local
  `origin/main`, so fetch first).

gh prints vitest's colours as the literal text `^[[…m` (piped), and a coloured project label (`app`) can come
before the path; both are read. The graph helper starts one vitest per fast package with an unnamed failing file
(0.7 s for scripts, 3.4 s for app, outside `heavy.sh`), each within 60 s, as is the log fetch; the verdict line is
printed again last.

A miss or an unsure prints a `!!` block and appends one `kind: "gate-miss"` row to the board's
`history/events-<UTC day>.jsonl` (`branch`, `sha`, `run`, `workflow`, `url`, `failing`, `missed`, `unsure`; no
`class`, so the job-row readers skip it), once per run and failing set (best effort: two checks at once can both
log). Send the hub the block as `[info]`: a real miss means a rule
is missing. A failing test that CI alone hits (a flake, or a break from main in a PR run) also reads as one, so a row
is a candidate. The check never changes the exit code; its own failure prints `miss check failed` and the verdict
stands.

## The full suite on GitHub

- Every push of a feature branch (the bot's `pnpm bot push`) starts the `Branch` workflow: the same `ci.yml` as the
  PR check, with the fixture suite always on.
- `ci.yml` runs eight jobs at once with no `needs` (INFRA §9): `check` (scan, lint, typecheck, fixture slice 1),
  `test-app-1`/`-2`, `test-scripts-1`/`-2` (vitest `--shard`), `test-packages` (shared, cdk, lambdas, extension) and
  `fixtures-2`/`-3`. A run takes as long as its slowest job.
  - A failing test's package comes from the job name in a single-package job (no pnpm prefix): `miss.ts` maps
    `test-app` to app and `test-scripts`/`fixtures-` to scripts.
- `pnpm gate:ci [--wait]` gives the verdict for `HEAD`: the PR run when a PR exists, which tests the merge with main,
  else the Branch run.
  - Exit 0: green.
  - Exit 1: red, cancelled or failed. It names the jobs.
  - Exit 75: still running, or no run yet.
  - Exit 2: a bad argument, or `git`/`gh` failed, which is no verdict. `--wait` retries `gh` until its timeout.
- Once a PR is open, a push starts both runs. The lane cancels the Branch twin with `pnpm bot run cancel <id>`, and
  reruns a real flake with `pnpm bot run rerun <id> --failed` (CI-BOT.md → _Commands_).

## Proof (2026-11-17)

**The replay.** The 25 merged PRs 174–198 produced 59 failing-test observations across 22 lanes, mined from the
lanes' own transcripts and archives (0 of the 30 CI runs on those branches failed). Under these rules:

- 57 of the 59 are selected: 40 named by a rule or the diff, 7 through the graph, 8 by a repo-wide fallback, 2 by a
  package-wide one (PR 183's deleted fixture JSON).
- The 2 not selected are load-flake timeouts.
- 0 real failures missed.

**Fallback rate on those 25 PRs:**

| Rules                                                                      | Repo full | Package full | Fast |
| -------------------------------------------------------------------------- | --------- | ------------ | ---- |
| Final                                                                      | 3         | 1            | 21   |
| With a snapshot running its package                                        | 3         | 5            | 17   |
| The plan's first cut (shared contract and deleted modules ran the package) | 3         | 8            | 14   |

The record lives in the lane archive, `faster-lanes/replay/` and `gate-replay/`.

**The trims (2026-11-18, `gate-trims`).** Replayed over the 85 `gate-wide` events of 11-18 (UTC), each sha from its
branch's reflog, against the old planner on the same diffs:

- **0 misses.** Off the trimmed paths the plans are the same (29) or a superset (3). On them, every test the old plan
  named is still named or runs whole (53 of 53).
- **Real failures:** 15 failing-file observations on diffs touching a trimmed path, all selected (lane logs and
  transcripts, PRs 177 and 181), plus the one failed GitHub test run since 11-01, off them and selected by the graph.
  Few: most red gates on those diffs were typecheck or lint.
- **Mutations:** `limits.json` (every leaf shifted), `heavy.sh` (`exit 1`) and `lib.sh` (a syntax error), each with
  the scripts tests the trimmed plan skips: 313 of 314 file runs green, the one red a flake that passed 3 of 3 with the
  mutation still in. Each mutation also turned selected tests red, so it bit.
- **Saved:** 24 of the 85 turn narrow, 7,013 s of wide gates (about 900 s narrow). Kept wide: the gate's selection
  code (22), a package's test config or setupFile (6), the root `package.json` (1).

The record lives in the lane archive, `gate-trims/replay/`.

**Cost, measured** with the sequential gate (before gate-parallel), before review's wider rules (one run each under `heavy.sh`, against the full suite's median of
175 s at ~8.7 container cores). A shared change now also runs lc-e2e, the smoke test and siri-capture's ~10 devcheck
importers; a Lambda entry-file change also runs the cdk stack tests:

| Diff                     | Files run | Wall |
| ------------------------ | --------- | ---- |
| Docs-only                | 9         | 7 s  |
| App-only                 | 66        | 62 s |
| One app page             | 44        | 57 s |
| `scripts/board`          | 54        | 37 s |
| Extension                | 25        | 62 s |
| A shared contract change | 153       | 69 s |

**Concurrent steps (gate-parallel, 2026-11-17).** Each diff was replayed through the sequential gate and the
concurrent one on the same base (`496b934e`), serially, one run each, under `heavy.sh` on the shared container. The
replay script is in the lane archive, `gate-parallel/replay/`. Lint was warm in both variants; the sequential
typecheck was partly cold (13–19 s against ~2 s), which is most of the narrow row's gain (about 50 s → 49 s warm).

- **Peak.** For the concurrent gate, its outer run's whole tree. For the sequential gate, the max over its steps.
- **The yardstick:** 147 green full `pnpm test` runs on 11-17/18. Their median (max) is:
  - wall 191 s;
  - 276 (284) threads and 4.6 (5.2) GB RSS in the process tree;
  - +395 container pids, +3.8 GB container anon;
  - 8.7 cores.

| Diff                                       | Wall: sequential → concurrent | Concurrent peak: threads · RSS | Container: +pids · +anon · cores |
| ------------------------------------------ | ----------------------------- | ------------------------------ | -------------------------------- |
| coach-fixes (wide: 6 packages, via shared) | 285 s → 65 s                  | 287 · 4.0 GB                   | 254 · 3.1 GB · 7.6               |
| lc-catalog (wide: 6 packages, via shared)  | 174 s → 63 s                  | 286 · 4.2 GB                   | 268 · 3.3 GB · 7.3               |
| Narrow (app + scripts: PR 202, reverted)   | 62 s → 49 s                   | 104 · 3.4 GB                   | 105 · 2.4 GB · 6.1               |

**Tuning.** A wide gate sits at the suite's thread ceiling and under its median on everything else. Two tunes got it
there:

- **With scripts beside app and extension** (an earlier tune), a wide gate peaked at 371–389 threads and up to 7.1 GB
  RSS. Hence `SCRIPTS_COST`.
- **The narrow budget** keeps a narrow gate near the sequential peak: it saves the typecheck and lint time, and runs
  its packages one after another. A narrow gate gains little; the win is the wide one.

**Speed knobs** (adopted only if ≥15% faster and stable, at equal strictness):

- ESLint `--concurrency`: not adopted. Under ~1 concurrent suite, cold `auto` ran 15–34 s against 33–37 s off, and
  warm runs (a lane's usual case, ~10 s off) swung 5.6–31 s.
- `isolate: false` for `packages/shared`: declined. Its suite is ~5 s, and the flag weakens isolation.
- TypeScript 7's native `tsc`: not measured, because the board held 2 full suites throughout. Left to its own lane.

## What is weaker (accepted by the maintainer, 2026-11-17)

1. **A break the import graph can't see shows up after the push, not before the commit.**
   - The Branch run catches it before the all-clear.
   - Until then, a red commit can sit on the public branch, and on dev, for minutes.
2. **Far fewer shuffled orders of the app suite.**
   - Each lane gets 1–2 CI runs instead of 4–6 local runs.
   - A state leak from a changed file into an unrelated one is seen less often.
   - The follow-up (pick 3): a periodic full local run on `main`.
3. **Review rounds start on a green fast gate, not a green full gate.**
4. **The dev deploy can start on a sha whose CI then fails.** That wastes dev minutes, and nothing ships.
5. **The Branch run tests the head, not the merge.** The PR run, still required, tests the merge.
6. **The gate is new code.** A stale rule is a silent skip. The mitigations:
   - unknown paths run more;
   - every skip is printed;
   - the rules are tested against the real tree;
   - a change to the selection code runs the full suite, and a `rules.ts` change runs the union with the base rules;
   - `gate:ci` logs a failing test the plan skipped (_A miss_).
7. **Timing-sensitive tests no longer run under container load.**
8. **A `heavy.sh` or `lib.sh` change runs the board and lane tests, not every package** (2026-11-18). A change that
   breaks only another package's run under it shows on the next gate that runs that package; one that loses an exit
   code fails the gate (`GATE_RESULT`, `step.sh`). CI never uses them.

**Not weaker:** typecheck and lint (full every time), the required PR checks, and main's pipeline.
