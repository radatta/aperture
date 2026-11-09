# Sim bench — the devcheck's iOS jobs, timed on any Mac

The **sim bench** replays the devcheck's iOS jobs N times (default 5) on a Mac. They run through the **real** mailroom runner and `jobs/sim.sh`, as a black box, and the bench measures how long each op takes and what the machine went through meanwhile. It answers "how does the sim run on the M1 (8 GB) against the M3?" with the same jobs a devcheck sends, rather than a synthetic test. Code: `tools/mailroom/bench/`.

```
plans.json ◀─ pnpm sim-bench:plans ◀─ scenarios/ios-standalone.ts (its steps, against a recording ctx)
    │
sim-bench.sh ── prelude (sign in, shut down) ─▶ run 1..N × [launch, capture, done-form, capture-long, relaunch]
    │             each: envelope → <results>/hostjobs/inbox → bash runner.sh <hostjobs> <state> → result.json (per-op ms)
    ├─ sampler.sh every 2 s: free memory %, swap, compressor, load, RSS/CPU of the sim's processes
    └─ summarize.sh → summary.json + summary.md        (--against another bench's summary.json: ratio columns)
```

**What it reuses, and what it doesn't measure:**

- **Timings** are sim.sh's own `steps[].ms` from each `result.json`; the bench never re-times anything.
- **Plans** are exported from the scenario, never hand-copied. `sim-bench.test.ts` fails when `plans.json` drifts from what `ios-standalone` sends.
- **Isolation:** the runner runs with a private `.hostjobs` and state dir inside the results folder, so no launchd and no shared folder are involved.
- **Not measured:** `powermetrics` needs sudo, and Apple Silicon has no sudo-free temperature reading. The sampler takes `pmset -g therm` (warning levels only) instead. Both gaps are listed in every summary.

**What it does to dev:**

- The sim signs in as the dev test user and only reads. The plans never save: `TAP_DENY`, IOS-CHECK.md.
- The one write is the **seed**, the in-progress task the Done form job opens.
- capture-long's 16 padding tasks are skipped. Its row is marked `(no 16 createTask, 16 upsertPlan)`: the op timings are real, but the "long page" condition isn't.
- While the bench runs, the seed's session holds **slot A's dev lock**.

## Seed (container, Claude)

`pnpm sim-bench:seed` runs from a pushed branch's worktree, since the dev lock is held by a branch name. It:

1. checks slot A is free or already this branch's. If another branch is testing on dev, it refuses with `NO_LOCK` before any lock or write.
2. takes the dev lock: `pnpm bot lock acquire --slot dev`, the same lock `deploy-dev` takes.
3. signs in as the test user through the devcheck's own sign-in and API client (cached Hosted UI state).
4. creates `plans.json`'s seed, `devcheck-ios simben`, and moves it to **in progress**. The id is ledgered in `localNotes/devcheck/ledger.dev.jsonl` under a `sim-bench-seed-…` run, so cleanup is by id.
5. prints the id and the lock's expiry. A seed already in place is reused.

If it fails after taking the lock, it frees dev again (unless the branch held dev before).

**While the bench runs:**

- Other lanes' slot-A devchecks and deploys wait through `pnpm bot lock wait`. Slot B is unaffected; until `PER_SLOT_RUNS` flips, its devchecks wait only for the seed step itself, which shares the run lock.
- The lock's TTL is 45 minutes. The session that seeded renews it (`pnpm bot lock renew`) before each expiry, and a 5-run M1 bench needs several renewals.

`pnpm sim-bench:seed --clean` deletes the seed by ledger id, recording it in the ledger, then releases the lock. A seed it can't delete stays pending in the ledger, and the next devcheck's sweep takes it.

Two failure modes, both visible in the summary:

- **No seed** (or a devcheck swept it): each run's done-form job fails `ASSERT/MISS` at the row's Done. The summary names it: **Done form task missing?**
- **dev redeployed mid-bench** (the lock lapsed): `devBuildChanged`, and the shas of the builds are listed.

## Setup on the M1 (once; user `godbobz12`)

The repo is private and the M1 has no node, so it gets a tarball rather than a clone (a `git clone` to `~/aperture` works as well if the M1 has a GitHub login). It needs only `tools/mailroom/`, macOS's own `/usr/bin/jq`, and native Homebrew's AXe.

| Piece           | How                                                                                                                                                                                                                                                                                                                                                                     | Check                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| the bench files | On the main Mac: `cd /Users/rahuldatta/Coding/Personal/aperture && git fetch -q origin && git archive --format=tar.gz --prefix=aperture/ -o ~/Desktop/aperture-bench.tgz origin/main tools/mailroom` (before the merge: `origin/m1-sim-bench`). AirDrop it to the M1, then on the M1 `cd ~ && tar xzf ~/Downloads/aperture-bench.tgz` (an update overwrites the files). | `ls ~/aperture/tools/mailroom/bench/sim-bench.sh`                        |
| AXe 1.8.0       | already at `/opt/homebrew/bin/axe`. The bench pins the mailroom plist's PATH (`/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`), so the Intel Homebrew in `/usr/local` is never used, and refuses a tool that resolves there.                                                                                                                                          | `/opt/homebrew/bin/axe --version`                                        |
| the sim         | `aperture-devcheck` (iPhone 18 Pro Max), dev on its Home Screen page 2 (IOS-CHECK.md → _Setup_). Signing in isn't needed: the prelude does it.                                                                                                                                                                                                                          | `xcrun simctl list devices available \| grep -c aperture-devcheck` → `1` |
| the password    | On the main Mac: `security find-generic-password -s aperture-devcheck-dev -a rahul3datta+devcheck@gmail.com -w \| pbcopy`. On the M1: `security add-generic-password -a rahul3datta+devcheck@gmail.com -s aperture-devcheck-dev -T /usr/bin/security -U -w`, then paste at its prompt (Universal Clipboard).                                                            | the bench's preflight                                                    |

The tarball has no git metadata, so `repoSha` reads `unknown`. `simShSha256` (sha256 of the `jobs/sim.sh` that ran), `runnerSha256` and `plansSha256` are always recorded, and they identify what was benched. **Main's `sim.sh` changes when sim-speedups-be merges.** Compare runs by `simShSha256`, never by date.

## Run it

**Morning order:**

1. Claude runs `pnpm sim-bench:seed`.
2. The user pastes the M1 line.
3. Claude renews the lock while the bench runs, then runs `--clean` when it ends.

```bash
cd ~/aperture && /bin/bash tools/mailroom/bench/sim-bench.sh --tag m1
```

The console shows each job's op progress, then one line per job (`r2 capture pass 61.3 s`). Results go to `~/aperture-sim-bench/<UTC stamp>-<tag>/`.

| Flag                       | Default                           | What                                                                                            |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--runs N`                 | 5                                 | timed runs of every job; run 1 is reported apart (cold)                                         |
| `--tag`                    | host name                         | names the results dir and the summary                                                           |
| `--out DIR`                | `~/aperture-sim-bench`            | where results dirs go                                                                           |
| `--sha auto\|<40 hex>`     | auto                              | auto re-reads dev's `<meta name="aperture-build">` before every job; a fixed sha skips the read |
| `--jobs a,b`               | all five, in the scenario's order | a subset                                                                                        |
| `--timeout S`              | 480 (the devcheck's)              | each job's budget, 60–600; a `TIMEOUT` count means "a devcheck would have timed out here"       |
| `--interval S`             | 2                                 | sampler period                                                                                  |
| `--no-prelude`             | prelude on                        | skip the sign-in job (the sim already signed in)                                                |
| `--no-sampler`             | sampler on                        |                                                                                                 |
| `--allow-mailroom`         | refuse                            | run with the mailroom agent loaded (never on the M3 outside a quiet window)                     |
| `--against <summary.json>` | —                                 | add ratio columns against another bench                                                         |

**Exit codes:**

- **0** — the bench ran. Job failures are findings, not errors.
- **1** — aborted. The sim can't run (`PASSWORD_MISSING`, `SIM_MISSING`, `SIM_AMBIGUOUS`, `PROFILE_MISMATCH`, `DEVICE_HUB`, `AXE_MISSING`, `AXE_VERSION`, `WEBCLIP_MISSING`), or the sign-in prelude didn't pass. The summary is still written, marked **Aborted**.
- **75** — refused at preflight, before any job:
  - not on a Mac;
  - a missing tool, or one resolving to `/usr/local`;
  - no Keychain item;
  - the mailroom agent loaded, or its lock fresh;
  - dev's build marker unreadable;
  - a bad flag.

A job whose runner doesn't answer within its timeout plus 120 s is stopped by PID and recorded `NO_RESULT`. A `result.json` that isn't the runner's is recorded `BAD_RESULT`. Neither is ever skipped.

### The M3 baseline (main Mac)

The M3's mailroom agent drives the same sim, `aperture-devcheck`, and a container devcheck arriving mid-bench would interleave jobs with it. So the bench refuses while the agent is loaded. Booting the agent out takes the M3's sim and `open-pr` away from every lane, so **ask dispatch for the M3 window**. It must be quiet: before auto-6's BEFORE runs or after its AFTER runs, never between them. The M1 run has no such restriction.

```bash
cd /Users/rahuldatta/Coding/Personal/aperture && launchctl bootout gui/$(id -u)/dev.rahuldatta.aperture.mailroom && /bin/bash tools/mailroom/bench/sim-bench.sh --tag m3 --out /Users/rahuldatta/Coding/Personal/aperture/localNotes/sim-bench; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.rahuldatta.aperture.mailroom.plist
```

The `;` before `bootstrap` is deliberate: the agent comes back even when the bench fails. Before the merge, run it from the worktree path (`…/aperture/.claude/worktrees/m1-sim-bench`).

## Results

A results dir holds:

| File                     | What                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.md`             | read first: header (machine, sim.sh / runner / repo / plans hashes, dev builds), jobs, signals, machine load, slowest ops, op kinds   |
| `summary.json`           | everything in it: `jobs`, `ops` (every op of every job), `opKinds`, `signals`, `fails`, `failures`, `load`, `machine`, hashes, `gaps` |
| `machine.json`           | model, RAM, CPU, macOS, Xcode, AXe, iOS runtimes, the sim's device, the hashes, the args                                              |
| `runs.jsonl`             | one line per job run: run, job, id, dev sha, status/reason/detail, `durationMs`, booted, builds seen                                  |
| `samples.jsonl`          | the sampler's ticks                                                                                                                   |
| `plans.json`             | what was replayed                                                                                                                     |
| `hostjobs/results/<id>/` | the runner's own `result.json`, `plan.json` and `shots/` per job — what a devcheck would get back                                     |
| `bench.log`              | the runner's log lines                                                                                                                |

**Bring it back:** AirDrop the results dir to the main Mac, then:

```bash
mkdir -p /Users/rahuldatta/Coding/Personal/aperture/localNotes/sim-bench && mv ~/Downloads/<stamp>-m1 /Users/rahuldatta/Coding/Personal/aperture/localNotes/sim-bench/
```

The container then reads it under `/workspace/localNotes/sim-bench/`.

**Compare** (in the container, or on either Mac):

```bash
bash tools/mailroom/bench/summarize.sh localNotes/sim-bench/<m1 dir> --against localNotes/sim-bench/<m3 dir>/summary.json
```

This adds a "vs p50" and a ratio column per job and per op. The 2026-11-08 M3 profile (`localNotes/sim-profile-2026-11-08.md`) predates the bench. Its _Wall (4 runs)_ column is the jobs table's _min–max (all)_.

### Reading it

- **Wall:**
  - _Run 1 (cold)_ is the first timed run after the prelude shut the sim down, as a devcheck's first job boots it.
  - _p50 runs 2–N_ is the warm figure. Percentiles are nearest-rank.
- **Per op:** passing steps only, keyed `job / index / op + its tab, label, text, method, name, as`. Failed ops are under _Failures_ with their note.
- **Signals** are counted from sim.sh's step notes (`tools/mailroom/jobs/sim.sh`):

  | Signal                              | Note that counts                                                                                          |
  | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
  | `retap`                             | `tapped again (…)`                                                                                        |
  | `iconRetap`                         | `icon tapped N times`, counting N − 1                                                                     |
  | `homeRepress`                       | `home pressed N times`, counting N − 1                                                                    |
  | `keyboardSecondTap`                 | —                                                                                                         |
  | `settingsAgain`                     | readBuild's second trip                                                                                   |
  | `retype`                            | `retyped once` / `twice`                                                                                  |
  | `extraDelete`                       | `deleted N more`                                                                                          |
  | `keyboardLate`                      | —                                                                                                         |
  | `inputDrops`                        | axe-input-gap's `drops N`                                                                                 |
  | `leftoverDraft`, `resumedMidTyping` | sim-speedups-be's notes                                                                                   |
  | `expectBuildRelaunch`               | `first launch ran X, second Y`: the PWA's two-launch refresh, a relaunch the baseline paid in 3 of 4 runs |

- **Dropped-input fails** are jobs ending in:
  - `ICON_TAP_DROPPED`, `HOME_PRESS_DROPPED`, `TAP_DROPPED`, `TYPED` or `ERASED`;
  - or `SWITCHER_FAILED` with status fail.

  `AX_TIMEOUT` and `TIMEOUT` (budget or `PROBES`) are counted apart.

- **Machine:**
  - free memory is min and mean %;
  - swap is the swap-in/out delta in pages across the bench;
  - the compressor peak is in MB;
  - load is the 1-minute average, peak and mean.

  Per job, the jobs table gives the minimum free % and peak load inside that job's runs. The processes are SpringBoard, SimMetalHost, SimRenderServer, DeviceHub, launchd_sim, `Web` (the Home Screen app) and `com.apple.WebKit*` (summed): peak RSS, peak and mean CPU, and how many ran at once.

- **Fairness:**
  - The M1's first hand trial ran with Xcode installs at load 170–200 (`localNotes/second-dev-stack/plan.md` → _M1 sim trial 1_), so check the peak-load column before reading lag into a job.
  - The M3 baseline is fair only in a quiet M3: no build, test suite or fixture suite beside it (IOS-CHECK.md → _Runtime_).

## Plans

`pnpm sim-bench:plans` (`scripts/src/mailroom/sim-bench-plans.ts`) runs `ios-standalone`'s steps, in order, against a recording ctx with the nonce `simbench`:

- each `ctx.ios.run` is recorded and stopped there;
- a step's API writes before its job become `skippedSetup`;
- the MCP setup step's task becomes `seed`.

It writes `tools/mailroom/bench/plans.json`, along with the prelude (`launch`, `signIn`, `expect signedIn`, `shutdown`; 600 s) and the 480 s job timeout. **A change to `ios-standalone.ts` means running `pnpm sim-bench:plans` and committing the file.** The drift test says so.

## Tests

`tools/mailroom/bench/run-fixtures.sh` runs inside `pnpm test` (`scripts/src/mailroom/sim-bench.test.ts`), in fixture mode (`SIM_BENCH_FIXTURE=1`). The Mac's tools are exported shell functions, so no stub file ever puts a path ending in the curl name on a process's argv (COI-INCIDENTS.md → Incident H). Its cases:

1. **Orchestration** through `fixtures/fake-runner.sh`: the prelude, then 3 × 5 jobs in order. Every envelope is the runner's (id, `submittedAt`, keys, sha, 480/600 s). Dev's build is re-read per job and a mid-bench switch is recorded. `machine.json` carries the real `sim.sh`'s sha256, and the sampler is stopped.
2. **Summary math:** cold vs warm wall, nearest-rank p50/p95 per op, signals from verbatim notes, fails by reason, and the missing seed named.
3. **Machine load:** from planted samples, overall and inside one job's window.
4. **`--against`** ratios.
5. **The sampler:** one tick parsed from `memory_pressure`, `vm_stat`, `sysctl`, `ps` (paths with spaces, WebKit processes summed) and `pmset`.
6. **The real `runner.sh` + `sim.sh`** run the bench's job from a private `.hostjobs`, with axe/simctl answered from the mailroom's default tape (`testdata/jobs.jsonl` line 2, read only).
7. **Preflight refusals:**
   - the agent is loaded, unless `--allow-mailroom`;
   - the mailroom's lock is fresh (a stale one passes);
   - no Keychain item;
   - no build marker, unless `--sha`;
   - bad flags;
   - not on a Mac.
8. **Aborts:** no password, no device, or a failed sign-in prelude.
9. **A hung runner** is stopped by PID and recorded.
10. **An unreadable `result.json`** is recorded `BAD_RESULT`.

The plans' drift, validity (`validateSimParams`), order and seed are checked in `sim-bench.test.ts`, and the seed's lock and ledger handling in `sim-bench-seed.test.ts`. Static checks cover the scripts:

- bash 3.2 only;
- the plist's PATH pinned;
- `pkill -P` only;
- the runner never sourced.

**What only the Mac proves:** a real run, plus bash 3.2 and BSD tools (`awk`, `sed`, `ps`). The fixture suite runs under the container's bash 5 and GNU tools.
