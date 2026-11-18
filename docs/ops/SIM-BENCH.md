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
- **Isolation:** the runner runs with a private `.hostjobs` and state dir inside the results folder, in a Mac-only dir. No launchd and no shared folder are involved.
- **Not measured:** `powermetrics` needs sudo, and Apple Silicon has no sudo-free temperature reading. The sampler takes `pmset -g therm` (warning levels only) instead. Both gaps are listed in every summary.

**What it does to dev:**

- The sim signs in as the dev test user and only reads. The plans never save: `TAP_DENY`, IOS-CHECK.md.
- The one write is the **seed**, the in-progress task the Done form job opens.
- capture-long's 16 padding tasks are skipped. Its row is marked `(no 16 createTask, 16 upsertPlan)`: the op timings are real, but the "long page" condition isn't.
- While the bench runs, the seed's session holds **slot A's dev lock**.

## Seed (container, Claude)

`pnpm sim-bench:seed` runs from a pushed branch's worktree, since the dev lock is held by a branch name. It:

1. takes slot A's devcheck run lock. A dev devcheck running now refuses the seed before any dev lock is taken.
2. checks slot A is free or already this branch's. If another branch is testing on dev, it refuses with `NO_LOCK` before any lock or write.
3. takes the dev lock: `pnpm bot lock acquire --slot dev`, the same lock `deploy-dev` takes.
4. signs in as the test user through the devcheck's own sign-in and API client (cached Hosted UI state).
5. creates `plans.json`'s seed, `devcheck-ios simben`, and moves it to **in progress**. The id is ledgered in `localNotes/devcheck/ledger.dev.jsonl` under a `sim-bench-seed-…` run, so cleanup is by id.
6. prints the id and the lock's expiry, and releases the run lock. A seed already in place is reused.

If it fails after taking the lock, it frees dev again (unless the branch held dev before).

**While the bench runs:**

- Other lanes' slot-A devchecks and deploys wait through `pnpm bot lock wait`. Slot B is unaffected: its devchecks have their own run lock.
- The lock's TTL is 45 minutes. The session that seeded renews it (`pnpm bot lock renew`) before each expiry, and a 5-run M1 bench needs several renewals.
- **A merge waits for the lock, up to an hour from the later of the merge and the branch's taking of the lock** (a seed on a branch already holding dev keeps the earlier time; renewals and re-seeds don't stretch it, and each run waits 15 min at least; CI-BOT.md → _Dev deploys_ → _A merge waits for the lock_), then deploys anyway and the summary shows `devBuildChanged`. So only an M1 window renewed past an hour is one where dispatch holds merges (past it, each later run still waits its 15 min).

`pnpm sim-bench:seed --clean` deletes the seed by ledger id, recording it in the ledger, then releases the lock, even one this branch held before seeding: the bench is over. A seed it can't delete, or a sign-in that fails, leaves the seed pending in the ledger for the next devcheck's sweep, and still frees dev. `--clean` frees nothing when another branch holds dev.

Two failure modes, both visible in the summary:

- **No seed** (or a devcheck swept it): each run's done-form job fails `ASSERT/MISS` at the row's Done. The summary names it: **Done form task missing?**
- **dev redeployed mid-bench** (the lock lapsed): `devBuildChanged`, and the shas of the builds are listed.

## Setup (each Mac, once per bench version)

**The bench never runs from the shared checkout.** On the main Mac the container can write that folder, and the mailroom's rule is that nothing from it runs on the Mac (MAILROOM.md → _Trust boundary_). It refuses with 75 when its own files, its `--runner` or `--plans`, or `--out` sit under a directory holding `.hostjobs`. So each Mac runs it from **GitHub's tarball** of a branch, unpacked into a Mac-only dir, `~/aperture-bench`.

The tarball comes straight from GitHub, fetched with the mailroom's own token, the way the mailroom's install line fetches `install.sh` (MAILROOM.md → _Install, update, remove_). Nothing in it passes through the shared checkout or its `.git`, which the container can write. The repo is private and the M1 has no node or token, so the main Mac downloads it and AirDrops it over, rather than the M1 cloning.

**Before the merge, `m1-sim-bench` is branch code you haven't reviewed.** On the M1 that's a small blast radius, since its Keychain holds only the dev test password. On the main Mac, wait for the merge: its Keychain holds the mailroom's PR token.

| Piece             | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Check                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| the bench files   | Download on the main Mac: `curl -sSfL -H @<(printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -o ~/Desktop/aperture-bench.tgz https://api.github.com/repos/radatta/aperture/tarball/main` (before the merge, for the M1 only: `tarball/m1-sim-bench`). Unpack it clean, so no file of an older version stays behind: on the main Mac `rm -r -f ~/aperture-bench && mkdir ~/aperture-bench && tar xzf ~/Desktop/aperture-bench.tgz -C ~/aperture-bench --strip-components=1`; on the M1, AirDrop it over, then the same with `~/Downloads/aperture-bench.tgz`, and delete the tarball (the M1 line under _Run it_ does all of it). | `ls ~/aperture-bench/tools/mailroom/bench/sim-bench.sh`                  |
| AXe 1.8.0         | Already at `/opt/homebrew/bin/axe`. The bench pins the mailroom plist's PATH (`/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`), so it never uses the Intel Homebrew in `/usr/local`, and it refuses a tool that resolves there. `jq` is macOS's own `/usr/bin/jq`.                                                                                                                                                                                                                                                                                                                                                                                                                | `/opt/homebrew/bin/axe --version`                                        |
| the sim           | `aperture-devcheck` (iPhone 18 Pro Max, else `PROFILE_MISMATCH`), with dev on its Home Screen **page 2** (else `WEBCLIP_MISSING`); IOS-CHECK.md → _Setup_. It doesn't need to be signed in: the prelude does that.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `xcrun simctl list devices available \| grep -c aperture-devcheck` → `1` |
| the password (M1) | `security add-generic-password -a <dev-test-user> -s aperture-devcheck-dev -T /usr/bin/security -U -w` (`<dev-test-user>` is `identifiers.json` → `email.devTestUser`) prompts for the password twice. Read it on the main Mac with `security find-generic-password -s aperture-devcheck-dev -a <dev-test-user> -w`, and type it. Universal Clipboard (`… -w \| pbcopy`, then paste) needs both Macs on one Apple ID; clear it afterwards with `pbcopy </dev/null`.                                                                                                                                                                                                                 | the bench's preflight                                                    |

The tarball has no git metadata, so `repoSha` reads `unknown`. What identifies the run is in every result: `simShSha256` (the sha256 of the `jobs/sim.sh` beside the runner that ran), plus `runnerSha256` and `plansSha256`. **Main's `sim.sh` changes when sim-speedups-be merges.** Compare runs by `simShSha256`, never by date.

## Run it

**Morning order:**

1. Claude runs `pnpm sim-bench:seed`, from the pushed branch's worktree: `pnpm bot lock acquire` refuses an unpushed branch.
2. The user pastes the M1 line.
3. Claude renews the lock while the bench runs, then runs `--clean` when it ends.

Run it in Terminal **in the Mac's GUI session**, not over SSH: there the login Keychain is locked, and the prelude ends `PASSWORD_MISSING`.

On the M1, with the tarball AirDropped into `~/Downloads` (_Setup_), one paste unpacks it clean and runs:

```bash
rm -r -f ~/aperture-bench && mkdir ~/aperture-bench && tar xzf ~/Downloads/aperture-bench.tgz -C ~/aperture-bench --strip-components=1 && rm ~/Downloads/aperture-bench.tgz && cd ~/aperture-bench && /bin/bash tools/mailroom/bench/sim-bench.sh --tag m1
```

It deletes the tarball once unpacked: AirDrop names a second copy `aperture-bench 2.tgz`, so a leftover would make the next version's line re-run the old bench. A rerun from the same unpack is `cd ~/aperture-bench && /bin/bash tools/mailroom/bench/sim-bench.sh --tag m1`.

The console shows each job's op progress, then one line per job (`r2 capture pass 61.3 s`). Results go to `~/aperture-sim-bench/<UTC stamp>-<tag>/`.

| Flag                       | Default                           | What                                                                                                             |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--runs N`                 | 5                                 | timed runs of every job; run 1 is reported apart                                                                 |
| `--tag`                    | host name                         | names the results dir and the summary                                                                            |
| `--out DIR`                | `~/aperture-sim-bench`            | where results dirs go                                                                                            |
| `--sha auto\|<40 hex>`     | auto                              | auto re-reads dev's `<meta name="aperture-build">` before every job; a fixed sha skips the read                  |
| `--jobs a,b`               | all five, in the scenario's order | a subset; after the prelude the sim is off, so the first must open with `launch` or `kill` (else `NOT_LAUNCHED`) |
| `--timeout S`              | 480 (the devcheck's)              | each job's budget, 60–600; a `TIMEOUT` count means "a devcheck would have timed out here"                        |
| `--interval S`             | 2                                 | sampler period                                                                                                   |
| `--no-prelude`             | prelude on                        | skip the sign-in job (the sim already signed in)                                                                 |
| `--no-sampler`             | sampler on                        |                                                                                                                  |
| `--allow-mailroom`         | refuse                            | run with the mailroom agent loaded (never on the M3 outside a quiet window)                                      |
| `--against <summary.json>` | —                                 | add ratio columns against another bench                                                                          |

**Exit codes:**

- **0** — the bench ran. Job failures are findings, not errors.
- **1** — aborted. The sim can't run (`PASSWORD_MISSING`, `SIM_MISSING`, `SIM_AMBIGUOUS`, `PROFILE_MISMATCH`, `DEVICE_HUB`, `AXE_MISSING`, `AXE_VERSION`, `WEBCLIP_MISSING`), or the sign-in prelude didn't pass. The summary is still written, marked **Aborted**.
- **75** — refused at preflight, before any job:
  - not on a Mac;
  - run from, or writing results into, the shared checkout (a `.hostjobs` above it);
  - a missing tool, or one resolving to `/usr/local`;
  - no Keychain item;
  - the mailroom agent loaded, or its lock fresh;
  - dev's build marker unreadable;
  - a bad flag.

**Ctrl-C** stops the runner and the sampler and exits 130, without a summary. The results dir stays; `/bin/bash ~/aperture-bench/tools/mailroom/bench/summarize.sh <results dir>` writes one from the jobs that finished.

A job whose runner doesn't answer within its timeout plus 120 s is stopped with its process group and recorded `NO_RESULT`. A `result.json` that isn't the runner's is recorded `BAD_RESULT`. Neither is ever skipped.

### The M3 baseline (main Mac)

The M3's mailroom agent drives the same sim, `aperture-devcheck`, and a container devcheck arriving mid-bench would interleave jobs with it. So the bench refuses while the agent is loaded. Booting the slow agent (`dev.rahuldatta.aperture.mailroom`) out takes the M3's sim away from every lane; `open-pr` and Ctrl+V keep working through the fast agent. So **ask dispatch for the M3 window**. It must be quiet: before auto-6's BEFORE runs or after its AFTER runs, never between them. The M1 run has no such restriction.

After the merge, with `~/aperture-bench` unpacked from main's tarball (_Setup_):

```bash
cd ~/aperture-bench && launchctl bootout gui/$(id -u)/dev.rahuldatta.aperture.mailroom && /bin/bash tools/mailroom/bench/sim-bench.sh --tag m3; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.rahuldatta.aperture.mailroom.plist
```

The `;` before `bootstrap` is deliberate: the agent comes back even when the bench fails. Results land in `~/aperture-sim-bench/`, a Mac-only dir; the bench refuses an `--out` inside the shared checkout, where the container could drop a job into its inbox mid-bench.

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

**Bring it back:** AirDrop the results dir to the main Mac, then (`<mac-repo>` is the Mac repo path, from the gitignored `.local/mac-root`: main checkout; shown in the SessionStart context):

```bash
mkdir -p <mac-repo>/localNotes/sim-bench && mv ~/Downloads/<stamp>-m1 <mac-repo>/localNotes/sim-bench/
```

The M3's own results: `mkdir -p <mac-repo>/localNotes/sim-bench && mv ~/aperture-sim-bench/<stamp>-m3 <mac-repo>/localNotes/sim-bench/`.

The container then reads it under `/workspace/localNotes/sim-bench/`.

**Compare** in the container, from the worktree or `/workspace`:

```bash
bash tools/mailroom/bench/summarize.sh localNotes/sim-bench/<m1 dir> --against localNotes/sim-bench/<m3 dir>/summary.json
```

On a Mac, never from the shared checkout (_Setup_): use the unpacked copy and full paths, `/bin/bash ~/aperture-bench/tools/mailroom/bench/summarize.sh ~/aperture-sim-bench/<m3 dir> --against <m1 dir>/summary.json`.

This adds a "vs p50" and a ratio column per job and per op. The 2026-11-08 M3 profile (`localNotes/sim-profile-2026-11-08.md`) predates the bench. Its _Wall (4 runs)_ column is the jobs table's _min–max (all)_.

### Reading it

- **Wall:**
  - _Run 1_ is the first timed run after the sign-in prelude. Each run, run 1 included, starts from a shut-down sim: relaunch, the last job, ends with `shutdown`, as consecutive devchecks do. So run 1 differs from later runs only by coming first after the sign-in and keyboard setup. It is not a cold/warm split. The result's `booted` per job is in `summary.json`.
  - _p50 runs 2–N_ is the steady figure. Percentiles are nearest-rank.
- **Per op:** passing steps only, keyed `job / index / op + its tab, label, text, method, name, as`. Failed ops are under _Failures_ with their note.
- **Signals** are counted from sim.sh's step notes (`tools/mailroom/jobs/sim.sh`):

  | Signal                              | Note that counts                                                                                                   |
  | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | `retap`                             | `tapped again (…)`                                                                                                 |
  | `iconRetap`                         | `icon tapped N times`, counting N − 1                                                                              |
  | `homeRepress`                       | `home pressed N times`, counting N − 1                                                                             |
  | `keyboardSecondTap`                 | —                                                                                                                  |
  | `settingsAgain`                     | readBuild's second trip                                                                                            |
  | `retype`                            | `retyped once` / `twice`                                                                                           |
  | `extraDelete`                       | `deleted N more`; `deleted more twice` counts 2                                                                    |
  | `switcherRetry`                     | the kill-by-switcher's retries: `the switcher didn't open`, `no Aperture card at`, `still running after the swipe` |
  | `keyboardLate`                      | —                                                                                                                  |
  | `inputDrops`                        | **pending:** axe-input-gap's `drops N`, 0 until a benched sim.sh writes it                                         |
  | `leftoverDraft`, `resumedMidTyping` | **pending:** sim-speedups-be's notes, likewise                                                                     |
  | `expectBuildRelaunch`               | `first launch ran X, second Y`: the PWA's two-launch refresh, a relaunch the baseline paid in 3 of 4 runs          |

- **Dropped-input fails** are jobs ending in:
  - `ICON_TAP_DROPPED`, `ICON_SCROLL_DROPPED`, `HOME_PRESS_DROPPED`, `TAP_DROPPED`, `NAV_UNCONFIRMED` after two tab taps, `TYPED` or `ERASED`;
  - or `SWITCHER_FAILED` whose note says iOS dropped the input. A "no Aperture card … was the app running?" is a fail, not a drop.

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
2. **Summary math:** run 1 vs runs 2–N wall, nearest-rank p50/p95 per op, signals from verbatim notes, fails by reason, and the missing seed named.
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
9. **A hung runner** is stopped with its process group (its children too) and recorded `NO_RESULT`, and the next job runs.
10. **An unreadable `result.json`** is recorded `BAD_RESULT`.
11. **A runner that dies mid-drain**, leaving its envelope and lock behind: after every job the bench clears its private inbox and runner lock, so the stranded job never runs inside the next one or locks it out.
12. **The shared checkout:** the bench refuses to run from, or write results into, a directory under one holding `.hostjobs`, and refuses a `--runner` there. Only fixture mode off a Mac (`SIM_BENCH_FX_ALLOW_SHARE=1`) skips the check, since the suite itself runs inside the shared checkout.
13. **Temp dirs:** a failed `mktemp` bails the suite; it never works in, or deletes, the cwd.

The plans' drift, validity (`validateSimParams`), order and seed are checked in `sim-bench.test.ts`, and the seed's lock and ledger handling in `sim-bench-seed.test.ts`. Static checks cover the scripts:

- bash 3.2 only;
- the plist's PATH pinned;
- kills by PID or process group only;
- the runner never sourced.

**What only the Mac proves:** a real run, plus bash 3.2 and BSD tools (`awk`, `sed`, `ps`). The fixture suite runs under the container's bash 5 and GNU tools.
