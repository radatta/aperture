# The lane gate — `pnpm gate:fast` locally, the full suite on GitHub

A lane's gate (FEATURE-WORKFLOW.md → phase 5) is **`pnpm gate:fast`**. It runs a full `tsc -b` and a full cached
`eslint .`, then only the tests the branch's diff can reach. The **full suite runs once per push on GitHub**, in the
`Branch` workflow (INFRA §9 → _Branch runs_), and **`pnpm gate:ci`** reads its verdict. The all-clear needs that run
green on the head sha (phase 9).

Why: every lane used to run the full suite 4–6 times. With 3–8 lanes, the shared container ran at load 18–29 on 9
cores, typecheck and lint ran ×4–9 slower than their median, and a suite held ~8 cores for 3–6 min (2026-11-17,
`faster-lanes`).

## What `gate:fast` runs

```
pnpm gate:fast [--full] [--dry-run] [--base <ref>]
```

1. **The diff:** everything since the merge-base with `origin/main` — committed, staged, unstaged and untracked, with
   a move counted as a delete plus an add.
2. **The plan** (`scripts/src/gate/plan.ts`, pure): for each package, its **whole suite**, a **fast** run, or
   **skip**. A fast run is `vitest related` on the changed modules plus the test files a rule names. The plan is
   printed with the reason for each choice, so a skip is never silent.
3. **The steps**, in order, each under `scripts/board/heavy.sh`, so the board sees them, budgets them and logs their
   peaks (SESSION-BOARD.md → _Heavy wrapper_):

   | Step                                                                       | Class                                           |
   | -------------------------------------------------------------------------- | ----------------------------------------------- |
   | `pnpm typecheck`                                                           | `typecheck`                                     |
   | `pnpm lint`                                                                | `lint`                                          |
   | Per fast package: `pnpm --filter <pkg> exec vitest related --run …`        | `test-fast` (a slot, not under the 2-suite cap) |
   | Per full package: `pnpm --filter <pkg> test` (the whole repo: `pnpm test`) | `test` (the cap applies)                        |

   The exit code is the first failing step's; later steps still run. 75 means `heavy.sh` gave up on the cap, which is
   a failure, never a pass.

`--full` runs the whole suite, e.g. to reproduce a red Branch run. `--dry-run` prints the plan and runs nothing.

## The rules

`scripts/src/gate/rules.ts` is the one home. `rules.test.ts` pins it against the real tree.

**A change that runs the whole suite:**

- **Every package** (`REPO_FULL`): the lockfile, the workspace file, the root `package.json`, `.nvmrc`/`.npmrc`, the
  root tsconfigs, the eslint config, `heavy.sh`/`lib.sh`/`limits.json`, and the gate itself.
- **One package** (`PACKAGE_FULL`): its `package.json`, tsconfigs and vitest/vite config, and the app's test setup.
- **Everything, also:** an empty or unreadable diff, or more than `MAX_CHANGED` (150) changed paths.

**A change that runs named tests:**

- **A snapshot** (`__snapshots__/x.test.ts.snap`) runs only `x.test.ts` beside its folder. An orphan snapshot runs
  its package.
- **A graph-blind input** (`INPUT_RULES`) runs the tests that read it from disk, raw-import it, or spawn it.
  - Same-area rules: a change under `scripts/src/<area>/` (board, bot, devcheck, lane, mailroom, ios-probe, lc-e2e)
    runs every test in that area, which covers the CLIs those tests spawn.
  - `extension/` runs every extension test plus `lc-e2e`, because `test/load.ts` reads the extension's `.js` from
    disk.
- **A changed module** runs `vitest related` in its own package and in every package that imports it (`reaches`).
  Every package but `scripts` reaches `packages/shared`. Its sibling `x.test.ts` also runs by name.
- **The mailroom fixture suite** runs exactly when CI's own rule says so (`fixture-inputs.ts`).
- **`ALWAYS_RUN`**: the repo-wide scanners any path can break (tracked identifiers, fixture inputs, the devcheck
  coverage matrix, the tower's import walk).

**Unknown means run more:**

- A path outside every package that no rule names runs every test any rule names by file.
- A file in a package that neither a rule nor the graph can see runs that package's whole suite.

**A deleted module** widens nothing. Its importers either changed, so they are in `related`, or no longer typecheck,
and `tsc -b` runs in full every gate.

**Adding a test that reads files, raw-imports or spawns:** name it in an `INPUT_RULES` entry (what it reads),
`ALWAYS_RUN`, or `SELF_CONTAINED` (temp dirs or same-area only, with why). The completeness test fails until you do.

## The full suite on GitHub

- Every push of a feature branch (the bot's `pnpm bot push`) starts the `Branch` workflow: the same `ci.yml` as the
  PR check, with the fixture suite always on.
- `pnpm gate:ci [--wait]` gives the verdict for `HEAD`: the PR run when a PR exists, which tests the merge with main,
  else the Branch run.
  - Exit 0: green.
  - Exit 1: red, cancelled or failed. It names the jobs.
  - Exit 75: still running, or no run yet.
- Once a PR is open, a push starts both runs. The lane cancels the Branch twin with `pnpm bot run cancel <id>`, and
  reruns a real flake with `pnpm bot run rerun <id> --failed` (CI-BOT.md → _Commands_).

## Proof (2026-11-17)

**The replay.** The 25 merged PRs 174–198 produced 59 failing-test observations across 22 lanes, mined from the
lanes' own transcripts and archives (0 of the 30 CI runs on those branches failed). Under these rules:

- 57 of the 59 are selected: 42 named by a rule or the diff, 7 through the graph, 8 by a repo-wide fallback.
- The 2 not selected are load-flake timeouts.
- 0 real failures missed.

**Fallback rate on those 25 PRs:**

| Rules                                                                      | Repo full | Package full | Fast |
| -------------------------------------------------------------------------- | --------- | ------------ | ---- |
| Final                                                                      | 3         | 0            | 22   |
| With a snapshot running its package                                        | 3         | 4            | 18   |
| The plan's first cut (shared contract and deleted modules ran the package) | 3         | 8            | 14   |

The record lives in the lane archive, `faster-lanes/replay/` and `gate-replay/`.

**Cost, measured** (one run each under `heavy.sh`, against the full suite's median of 175 s at ~8.7 container cores):

| Diff                     | Files run | Wall |
| ------------------------ | --------- | ---- |
| Docs-only                | 9         | 7 s  |
| App-only                 | 66        | 62 s |
| One app page             | 44        | 57 s |
| `scripts/board`          | 54        | 37 s |
| Extension                | 25        | 62 s |
| A shared contract change | 153       | 69 s |

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
   - a change to the gate runs the full suite.
7. **Timing-sensitive tests no longer run under container load.**

**Not weaker:** typecheck and lint (full every time), the required PR checks, and main's pipeline.
