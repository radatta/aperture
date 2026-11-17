# Session board — sharing one container between Claude sessions

Several Claude sessions run in the one COI container. They share its memory, threads and CPU, and two of
them can hit the same dev stage or the same files. The board shows who is doing what (and who holds the dev
lock, and the hub — `docs/ops/HUB.md`), keeps a usage history, and leases heavy-job slots. All of it lives in `scripts/board/` (bash) and
`scripts/src/board/` (the tested decisions, TypeScript under plain `node`).

**It must never make a session timid.** Tests and the headless UI pass always run. Below the _measured_
edge the board only offers advice. A heavy job waits only at a measured edge — past the hard line, or when
its class's concurrency cap is full (`test`: 2 suites at once, each at 4 vitest workers — the 2026-11-08 bench in _Results_) — and only while
`limits.json` says `enforce: true` (shipped 2026-10-29, after the 2026-10-13 quiet window found the CPU edge). Every hold is logged, so how
limiting the cap is stays a number, not a feeling (`cli.ts barriers`).

## Use it

| Want                              | Run                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who's running what, headroom      | `scripts/board/board.sh status` (live in the container; on the Mac, the sampler's latest snapshot) · `board.sh json` for machines                                                                                                                                              |
| Run a heavy command               | `scripts/board/heavy.sh -- pnpm test` — same output and exit code, plus its peak usage in the history and a budget slot others can see                                                                                                                                         |
| Hold the dev stage for a dev test | `pnpm bot deploy-dev` takes a free slot's lock, `refs/locks/dev` or `refs/locks/devb` (`docs/ops/CI-BOT.md` → _Dev slots_; a branch touching iOS paths takes `dev` only); refused → the `lock wait` it names, in the background. The board shows the holders (_Dev lock line_) |
| Who is the hub, is it up          | `board.sh hub` — the name from `scripts/board/hub.json` and whether a live session by that name is on the board (`docs/ops/HUB.md`)                                                                                                                                            |
| What does a mix of sessions cost  | `node scripts/src/board/cli.ts report /workspace/localNotes/board/history 7` (days)                                                                                                                                                                                            |
| How limiting is the test cap      | `node scripts/src/board/cli.ts barriers /workspace/localNotes/board/history 7` — blocks/day, total + p50/p90 wait, by mix / holder / blocked session (also the last line of `board.sh status`)                                                                                 |
| Is `limits.json` stale            | `node scripts/src/board/cli.ts staleness scripts/board/limits.json /workspace/localNotes/board/history`                                                                                                                                                                        |
| The whole picture, live           | `scripts/board/tower.sh` in its own tmux window — the control tower (_Control tower_)                                                                                                                                                                                          |
| The web tower                     | http://localhost:6183 · `board.sh tower start\|restart\|stop\|status\|version`; sync-main after a merge (`docs/ops/TOWER.md` → _Run it_)                                                                                                                                       |
| Sampler                           | `board.sh sampler start\|restart\|stop\|status` · `board.sh gc` drops stale slots/sessions, history older than 90 days                                                                                                                                                         |

Every Claude status line ends with the board's one-liner (`· 2 working · 5 idle · heavy 0 · anon 2.0/18G ·
pids 315/4096 · dev: flux`; `dev:` is the branch holding a live `refs/locks/dev`) —
`scripts/board/statusline-snippet.sh`, sourced at the end of `~/.claude/statusline-command.sh`.

## The container's real limits

Measured 2026-10-13 at 9 CPUs / `memory.high` 18 GiB / `pids.max` 4096 (`measure/probe.sh` rewrites this
snapshot to `history/probe-<date>.json`):

- **Memory is a throttle, not a kill.** `memory.high` = 18 GiB: past it the kernel reclaims, then stalls
  allocators (`memory.pressure` `full` rises). `memory.max` = `max`, and the VM has **no swap**, so anon memory
  can't be reclaimed — but **the container cgroup never OOM-kills** (`memory.events` `oom_kill 0`). A
  `SIGKILL`/137 comes from the VM's OOM killer (VM RAM 21.4 GiB, `/proc/meminfo` via lxcfs) or from userland
  (vitest kills workers that miss its teardown timeout) — never from this cgroup.
- **pids is the hard ceiling.** `pids.max` 4096 (threads count); `RLIMIT_NPROC` and `pid_max` are no lower. At
  the ceiling `clone()` is refused → `SIGABRT`/134 (Incident A).
- **Budget on anon, not `memory.current`.** `memory.current`/`memory.peak` include page cache (a fresh boot
  showed peak 2.6 GB against 1.9 GB anon; a long-running box shows far more). `memory.stat` `anon` is the
  pressure number.
- **The test fan-out grew with the CPUs.** Root `pnpm test` = `pnpm -r test`: up to 4 packages at once
  (`workspace-concurrency` unset), each vitest with `availableParallelism() − 1` = **8** workers. CI never
  runs the root script, so container-only tuning can't leak into CI.
- `cpu.max` is `max 100000` — the 80 % CPU allowance in `.coi/config.toml` doesn't land (Incident A
  follow-ups).

| File (`/sys/fs/cgroup/`)                      | Meaning                                   | Use                                  |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| `memory.stat` → `anon`                        | real process memory                       | **the number**                       |
| `memory.current` / `memory.peak`              | anon + cache (+ kernel)                   | context only                         |
| `memory.high`                                 | throttle line                             | thresholds are fractions of it       |
| `memory.max`                                  | `max` → no cgroup OOM                     | a 137 is the VM or userland          |
| `memory.events` `high` / `oom_kill`           | throttle hits / kills since boot          | the delta per job is the verdict     |
| `memory.pressure` `full avg10`                | stall regime                              | the stop signal                      |
| `pids.current` / `pids.max` / `pids.peak`     | tasks (threads) / ceiling / high-water    | `paste -d/ pids.{current,max}`       |
| `cpu.stat` `usage_usec`, `cpu.pressure`       | CPU time, CPU stalls                      | cores busy = Δusage / Δt             |
| `/proc/meminfo` `MemTotal`                    | VM RAM                                    | the real 137 line                    |
| `/proc/<pid>/stat` (parse after the last `)`) | ppid, threads, rss, cpu ticks, start time | attribution (`comm` may hold spaces) |

## History — what the sampler records

`scripts/board/sampler.sh` runs once per container (a `flock` singleton, a detached background process,
stderr → `board/sampler.log`), started by the SessionStart hook and dying with the container. Every 30 s it
reads `/proc/<pid>/{stat,cmdline}` and the cgroup files — pure bash plus one `awk` — and appends one line to
`history/samples-<date>.jsonl` (~3 MB/day):

```
{"t":"…","v":1,"cg":{"anonMiB":1851,"fileMiB":136,"currentMiB":2091,"highMiB":18432,"pids":255,"pidsMax":4096,
  "cpuCores":0.3,"psiMemSome10":0,"psiMemFull10":0,"psiCpuSome10":0,"oomKill":0,"highEvents":0},
 "cats":{"claude":{"n":7,"thr":110,"rssMiB":2675},"vitest":{…},"vite":{…},"chromium":{…},"tsc":{…},
         "eslint":{…},"pnpm":{…},"system":{…},"other":{…},"unattributed":{"thr":0}},
 "sessions":[{"pid":2180,"name":"dev-e2e","sid":"…","branch":"dev-e2e","state":"working","stateSrc":"hook",
              "thr":15,"rssMiB":502,"cpuSec":1.2,"heavy":"test"}],
 "mix":{"working":2,"idle":5,"heavy":1},"gapSec":null}
```

- A **session** is a `claude` process; every other process is attributed to the nearest `claude` ancestor
  (subagents run in-process, so they count with their session). Its `name` is its tmux window name — the
  session name, and the `SendMessage` address — when the pane runs that `claude` (a `claude` started inside
  another session's pane inherits `TMUX_PANE`); otherwise its branch, then its cwd's basename.
- **state** comes from the session's hooks (`stateSrc: "hook"`: working from a prompt until Stop). A session
  that hasn't fired a hook since the hooks were installed falls back to CPU (`"cpu"`, ≥ 5 % of a core) —
  unreliable, because a session waiting on the model uses almost no CPU. `board.sh status` marks those `*`.
- `unattributed` counts heavy-category threads with no session (drift detector for the attribution).
- `gapSec` is set when a tick is > 60 s late — the container was frozen or the VM slept.
- `cpuCores` is the cgroup's CPU time since the last tick over the real time between (`$EPOCHREALTIME`, so a
  `status` read just after a tick isn't off by a rounded second), from the previous tick's counters in
  `/tmp/aperture-sampler.prev` (a fake cgroup, `APERTURE_CGROUP_DIR`, keeps its own beside it;
  `sampler.sh --prev-path` says which). It is `null` when that delta is negative or above 1.5 × the
  container's CPUs (`cpu.max`, else the online CPUs): the counters weren't this cgroup's. Until 2026-11-07 a board test's `--once` against a fake cgroup overwrote the
  live prev file, so the tick after every scripts suite read thousands of cores (127 such ticks on 2026-11-05);
  `cli.ts report` skips values over 64 in that older history, and the control tower anything over 2 × its cores.
- It also rewrites `board/status.line` every tick and, every 5th tick, `board/overlap.json`.

`heavy.sh` adds one **job event** per run to `history/events-<date>.jsonl` (`kind: "job"`, below); lease
actions are `kind: "lease"`. `cli.ts report` buckets the samples by mix (`2w 5i 1h`) with median / p95 / max
anon, pids and cores; measures an idle session directly (RSS, threads); estimates each extra session's anon
from heavy-free ticks; and summarises real jobs per class — load-test runs (`loadTest: true`: `matrix.sh`'s
guarded jobs and `edge.sh`'s instances) are left out, as they are from `staleness`.

**Barrier events** — every hold by the cap or the hard line is a `kind: "lease", lease: "heavy"` event, one
envelope for all: `{t, action, pid, name, branch, class, label, cmd, reason: "cap"|"hard"|"lock", cap: {max, running,
full}, holders: [{pid, name, class, label, startedAt}], predicted, thresholds, mix, loadTest, waitedSec?, interrupted?}`.
`action`: `waited` (ran after the wait; `waitedSec` real), `gaveUp` (exit 75; `waitedSec` = the budget; or, with
`interrupted: true` and the real `waitedSec`, a wait killed by INT, TERM or HUP, exit 128 + the signal; a KILL leaves none),
`denied` (the PreToolUse guard refused a raw command; `label: "guard"`), `wouldWait` (enforce off — the
counterfactual). `holders` and `cap` are the ones at the first block, the cause. `cli.ts barriers` (and the
report's _Barriers_ section) counts **blocks** = waited + gaveUp + denied, except that a deny followed within
2 min by the same session's held `heavy.sh` re-run of the same class is **one** block (`merged`; each re-run
absorbs one deny, the earliest). It gives blocks/day over the real window, total / p50 / p90 / max wait, and
counts by reason, class, mix, holder and blocked session — per block, so reason, class and blocked session add
up to the headline (a block can have several holders, and older events no mix).
`lockBusy` (enforcing, the board lock stayed busy for the whole wait before any decision, so the job ran
unslotted — fail-open; a job already held gives up instead, and with `enforce: false` a busy lock never waits) is reported,
not counted as a block. Load tests are excluded.

## Heavy wrapper — `scripts/board/heavy.sh [--wait SEC] -- <cmd…>`

- **Class** from the command (`case` match, shared with the hook): `test`, `test-file` (a single-file run —
  measured, no slot), `typecheck`, `lint`, `build`, `dev`, `ui`, `other` (no slot). `HEAVY_CLASS` overrides;
  `HEAVY_LABEL` names the run — **never on argv** (a `pkill -f <label>` once killed the wrong process).
- Takes a **heavy slot** (below), runs the command in the background, and samples at 1 Hz: container
  pids / anon / current / PSI / cores, and the command's own process subtree (threads, RSS). Renews the slot
  every 30 s.
- On exit: releases the slot, appends the event, prints one line —
  `heavy: test exit 0 · 27.3s · pids +312 (peak 600/4096) · anon +3100 MiB (peak 5000/18432) · subtree 290 thr / 3200 MiB · 4.1 cores · psi 0 · clean`.
- **verdict**: `pids-ceiling` (134 with peak pids ≥ 95 % of max), `cgroup-oom` (137 with an `oom_kill` delta
  — should never happen), `outside-cgroup` (137 without one: VM or userland), `throttled` (PSI full past
  `psiFullKill` or a `high` delta), `guard-stop`, `clean`.
- stdout/stderr pass straight through; the exit code is the command's (`128+sig` if signalled). A
  background command's stdin is `/dev/null`.
- `HEAVY_DURATION=N` stops it after N s (load tests' `dev` cell); `HEAVY_GUARD=1` enforces the stop
  conditions (load tests only).
- **Container-only tuning** (`limits.json` `tuning.test`: `workspaceConcurrency`, `maxWorkers`) applies only
  in a `coi-*` container and only once measured: a setting ships only if it cuts peak anon ≥ 30 % for ≤ 15 %
  more wall time. `maxWorkers: 4` shipped 2026-11-13 **below that bar**, on the user's call: it cut anon 26 % solo /
  19 % in a pair, and was taken for the headroom and the bench's pair speed, at no wall cost on 2026-11-13 (_Results_). vitest applies
  `VITEST_MAX_WORKERS` over every config, so `scripts`' test script pins its own 2 (CI parity, `scripts/vitest.config.ts`).

## Leases

State lives on the shared mount (`/workspace/localNotes/board/`, visible from the Mac), written tmp + rename.
Every lease change runs under `flock /tmp/aperture-board.lock` — on the container's rootfs, because the whole
population is this one container (virtiofs `flock` semantics aren't worth trusting).

The board's own `dev` lease is gone (removed in session-comms, 2026-11): the dev lock is `refs/locks/dev` on
GitHub, below. History keeps its old `lease: "dev"` events for their 90 days, and `cli.ts barriers` ignores them;
`board.sh gc` deletes a leftover `leases/dev.json`.

**`heavy`** — a counting budget, one slot per running heavy job (`leases/heavy/<claudePid>-<wrapperPid>.json`).
The decision (`lease.ts` `decideHeavy`): predicted = live pids / anon + the cost of slots younger than 20 s
(not ramped up yet, so not in the live numbers) + this job's class cost. Under soft → run. Over soft → run,
with a one-line note. **Cap** (`concurrency` in `limits.json`): a `test` job finding 2 `test` slots already
held is `cap-full` — every slot counts however young (a 5 s-old suite is about to take 8 cores), the cap wins
over the hard line when both apply (it names the holders), other classes and `test-file` runs are never
capped, and load tests (`HEAVY_GUARD=1` / `HEAVY_LOADTEST=1`) bypass it — and the hard-line wait too: they probe the
edge on purpose and stop themselves, so a hold would only record a false edge. Past
hard or at a full cap → with `enforce: false` run anyway and log `wouldWait`; with
`enforce: true` (shipped) wait for room or a slot, polling every 2 s, up to `--wait` (90 s — inside the Bash tool's 120 s
timeout, so the message reaches Claude), then exit **75** naming the jobs that hold the room: tell the user
rather than retry. A longer wait is `--wait <sec>` with the Bash call run in the background. (Room that frees
late in the wait still starts the command inside the same call, so with `enforce: true` give long jobs a
longer Bash timeout or run them in the background.) A slot whose wrapper died — or is a zombie (`Z`: exited, never
reaped) — is never a running job: every reader (`status`/`json`, the sampler's `heavy` count, the guard's offer and cap
count) counts live slots only, through one rule (`lib.sh` `sb_slot_live` / `sb_live_slots`), and the file is dropped
by the next acquire and by `gc`.

## Dev lock line

`board.sh status`, the SessionStart hook and the status line's `dev:` show the real `refs/locks/dev`
(`docs/ops/CI-BOT.md` → _Dev lock_), from one cache, `board/devlock.json`
(`{v: 1, t, source: "peek" | "bot", holder: {branch, sha, expiresAt} | null, failedAt?, failedWhy?, failedBy?, failedFor?}`); slot B's
`refs/locks/devb` has its own, `board/devlock.devb.json`, the same shape (_Dev slots_). `devlock.sh line` prints
slot A as before, then ` · devb: free` / `· devb: <branch> (<session>) until HH:MM` once slot B has a cache; the
status line's `dev:` and `board.sh json` still read slot A only. Two writers, each for both files:

- **`scripts/board/devlock.sh refresh`** peeks read-only with the container's own credential —
  one `git ls-remote origin refs/locks/dev refs/locks/devb` for both slots, then `gh api …/git/tags/<sha>` for each held slot's holder — each call under
  `timeout` (4 s; the hook passes 2). It skips while the cache is younger than `--max-age` (60 s; `status` 30,
  the sampler 240, run every 10th tick, about 5 min, backgrounded). A failed peek keeps the old cache and sets
  `failedAt`, `failedWhy` (git's last error line, any URL userinfo stripped, `timed out after N s`, or the tag
  read), `failedBy` (the caller: `status`, `sampler`, `tower`, `hook` via `APERTURE_DEVLOCK_CALLER`, else its
  parent's process name) and `failedFor` (each caller's last failure); a good read writes the cache afresh,
  without them. The minute's wait after a failure is that caller's own (`failedFor[caller]`), however callers'
  failures interleave: another caller still asks (an older cache with only `failedAt` holds every caller for the
  minute). One broken caller —
  the COI tmux status bar, whose `#()` jobs ran with no `HOME`, so git lost `~/.gitconfig`'s https rewrite and
  credential helper and fell back to SSH (2026-11-14) — once stamped `failedAt` every minute and kept every
  other caller from ever refreshing. `lib.sh` now sets a missing `HOME` from the passwd entry (`HOME=~`) for every
  board script. A peek that finds the bot wrote while it was asking keeps the bot's write. No bot key, no token
  mint, no node.
- **The bot** (`scripts/src/bot/lock-cache.ts`) writes it on every `pnpm bot lock …`, `lock wait` poll and
  `deploy-dev` lock change.

`devlock.sh line` judges expiry at read time (the cache never stores a verdict) and names the holder's
session from `board/sessions/`: `dev lock: free` · `dev lock: flux (flux) until 14:05` ·
`dev lock: flux — EXPIRED 14:05, the next acquire takes it over` · a ` (as of 13:20, refresh failed)` suffix
once the cache is over 5 min old · `dev lock: unknown (offline, no cache)`. Test seam:
`APERTURE_DEVLOCK_SOURCE=file:<path>` stands in for GitHub (`board-cli.test.ts` → `devlock.sh`).

## `scripts/board/limits.json`

Thresholds are **fractions of the live `pids.max` / `memory.high`**, so a limit change moves nothing:
`pidsSoftFrac` 0.80 / `pidsHardFrac` 0.92 (3276 / 3768 at 4096), `anonSoftFrac` 0.60 / `anonHardFrac` 0.80
(10.8 / 14.4 GiB at 18 GiB), `psiFullKill` 15 (load-test stop), `currentGuardMiB` 1536. `classes` hold each
job class's cost (`pids`, `anonMiB`, `p95Sec`, `source`) — shipped as the 2026-10-06 bench maxima × 1.6 for the
8-worker fan-out, `measuredAt: null`, `enforce: false`; the 2026-10-13 quiet window filled them in and set
`measuredLimits`; on 2026-10-29 (the user's call) `enforce: true` shipped with `"concurrency": { "test": 4 }` — a policy
key, top-level like `tuning`, so a quiet window rewriting `classes` never loses it. The value is the CPU edge:
a 6th concurrent suite timed out (_Results_). On 2026-11-13 the cap became 2, with `tuning.test`
`{ maxWorkers: 4 }`, and `classes.test` was re-measured at that cap and `classes.ui` against a local check (the 2026-11-13 check in _Results_); the other classes and
`measuredAt` still date from 2026-10-13. Loosen or tighten it with `cli.ts barriers` data; `cli.ts staleness` then warns when the live limits differ or a class's real p95 runs 20 %
over its cost.
`lanes.maxActive` (5) is the lane cap `pnpm lanes start` enforces: a policy key, top-level like `concurrency`. What
counts as active: `docs/ops/LANES.md` → _Start_.

## Hooks

Four, all fail-open, documented with their fixtures in `.claude/hooks/README.md` → _Board hooks_:
SessionStart registers and injects headroom / the dev lock line / `board.sh hub` (in the hub itself, its roadmap
reminder) / overlaps; UserPromptSubmit and Stop keep the state;
the Bash PreToolUse guard offers `heavy.sh` and, with `enforce: true`, denies a raw heavy command only at the
measured edge or a full cap (recording a `denied` barrier event, pointing at this board's `heavy.sh` by absolute
path — other worktrees have none until merge — which waits). Only a command that actually starts a runner counts:
some `&&` / `;` / `|` segment begins (after env assignments, `env`, `timeout N`) with `pnpm`, `vitest`, `tsc`,
`node`, … — `cat vitest.config.ts`, `rg -n "vitest|pnpm test"` (quoted spans are text), a heredoc body, or `pnpm add vitest` is
text, not a run — and the class comes only from the segments that run. A `bash -c "…"` / `sh -c '…'` body (a path
or `-lc` too) is unwrapped first, so the run inside it counts; `pnpm rm` / `uninstall` is package management. It misses `make` (no
Makefile here), which only costs the offer: the hook fails open;
SessionEnd marks the session gone.

## Overlaps

Every 5th sampler tick `cli.ts overlap` lists each worktree on a branch (the detached main checkout is
skipped) with its files — committed since the merge-base with `origin/main` ∪ uncommitted ∪ untracked, minus
`localNotes/` — and intersects them pairwise into `board/overlap.json`. Files nearly every branch touches
(`CLAUDE.md`, `docs/index.md`, `package.json`, `pnpm-lock.yaml`, `.claude/settings.json`, the hooks README,
`run-fixtures.py`) go on a separate "small appends" line so real overlaps stand out. SessionStart injects this
branch's lines, e.g. "flux also touches 2 of your files: app/src/data/seed.ts, app/src/data/stubClient.ts —
SendMessage session `flux`; expect a rebase conflict whichever merges second." `origin/main` is whatever was
last fetched; the merge-base keeps that safe.

## Measurement protocol

Scripts in `scripts/board/measure/`; every job goes through `heavy.sh`, so the load tests are the first
history. **Singles** run any time — the build's own gates through `heavy.sh` fill them. **Pairs, sessions and
the edge test need the quiet window.**

1. `probe.sh` — environment snapshot (limits, versions, vitest's default workers, tmux/setsid capability).
2. `matrix.sh setup` — scratch worktrees `board-matrix-b` / `-c` (detached at this HEAD, installed), so pair
   cells are real two-tree runs.
3. `matrix.sh <cell> [reps]` — 3 reps (to 5 when Δanon or Δpids spread > 10 % of the median), 20 s apart, one
   summary line per rep, a `matrix-<date>.jsonl` row per cell. A 3-rep `test` cell takes ~3 min, past the
   Bash tool's 120 s default: run cells with `run_in_background` (or a 600 s timeout). Pair and session
   cells refuse until `setup` has installed their trees. Cells (`matrix.sh list`): `typecheck` and
   `lint` cold (`tsc -b --force`, `eslint` without cache); `test`; `test-wc1`/`-wc2`
   (`--workspace-concurrency`); `test-w3`/`-w4` (`VITEST_MAX_WORKERS`) — `test` and `test-wc*` unset heavy.sh's
   tuning, so they stay vitest's default and pairs and sessions compose that; `dev` (90 s); `ui` and `ui-rpl1`
   (`measure/ui-cell.sh`: dev server + Chromium over 4 routes at phone width, `--renderer-process-limit=1`
   on/off; `PW_DIR` must hold Playwright); `pair:test+test`, `pair:test+ui`, `pair:test+typecheck`,
   `pair:dev+ui`; `two-sessions` / `three-sessions` (test → typecheck → ui per tree, trees in parallel).
4. `edge.sh --detach` — detached (progress in `history/edge-<date>.log`), adds a looping `pnpm test` instance (tuned, 4 workers, since 2026-11-13) every 30 s until a
   stop fires, a run fails (any exit but 0 / 143 — the gate was green, so the load caused it), or 12
   instances; stops them by PID (each wrapper's PID is recorded as it starts), waits for anon to settle,
   writes `history/edge-<date>-<HHMM>.json` (per step: instances launched and alive, peaks, PSI,
   `memory.events` deltas, exits; and the **head** of the first failed run's output). Refuses while any
   other session is live or was working in the last 5 min, or when it can't read the board (`EDGE_FORCE=1`
   with the user's say-so). `EDGE_CMD` swaps the job for a dry run. Expected at 18 GiB was a PSI stop at ~4–5
   instances; measured, CPU gives out first (_Results_).

**Stop conditions** (1 Hz in `heavy.sh` under `HEAVY_GUARD=1` and in `edge.sh`, all from `limits.json` ×
live limits): pids past soft → stop launching; pids past hard, anon past hard, PSI `full avg10` past
`psiFullKill` twice running, or `memory.current` within `currentGuardMiB` of `memory.high` with PSI rising →
kill children; in `edge.sh`, a run failing (any exit but 0 / 143) → stop and record.

**Cheap fixes measured before any gating:** `--workspace-concurrency=1|2`, `VITEST_MAX_WORKERS=3|4`, Chromium
`--renderer-process-limit=1`. More VM RAM only if the window shows VM-side kills.

**The quiet window** (the user schedules it; during this branch's dev-test phase):

1. Other sessions ended properly (`Ctrl+D`, `exit` — COI exports them); worktrees committed.
2. Playwright installed in the driving session's scratchpad **beforehand** (the install is a rootfs write
   burst the COI monitor can flag); `matrix.sh setup` done.
3. In the VM: `journalctl -k -f | grep -iE 'oom|cgroup|killed process'` in a tmux window; `coi unfreeze` at hand.
4. Run: singles not yet covered → pairs → `two-sessions` / `three-sessions` → `edge.sh --detach`.
5. After any 137: the user pastes back `free -g`, `cat /sys/fs/cgroup/lxc.payload.<container>/memory.events`,
   `journalctl -k | grep -i 'killed process'`, and the failed head from the edge file.
6. Fill `limits.json` (`classes`, `measuredAt`, `measuredLimits`, `tuning` per the 30 % / 15 % rule,
   `enforce: true` — it bites only past hard), the results table below, and CLAUDE.md's COI bullet.

### Results

Quiet window 2026-10-13 (18:53–19:52 PDT): every other session exited; 9 CPUs, `memory.high` 18 GiB,
`pids.max` 4096, baseline 527 MiB anon / 162 pids. Rows: matrix `history/matrix-2026-10-14.jsonl` (3 reps,
5 when the spread passed 10 %); edge `history/edge-2026-10-14-0248.json`. Δ = the job's added peak; peak =
the container's. No matrix cell saw memory pressure (PSI `full` 0, `high` 0, `oom_kill` 0); the edge peaked at PSI `full` 0.36.

| Cell                                   | Δpids (max) | Δanon MiB (max) | wall s (median) | cores (max) |
| -------------------------------------- | ----------- | --------------- | --------------- | ----------- |
| `typecheck` (cold)                     | 30          | 1023            | 13.7            | 3.3         |
| `lint` (cold)                          | 23          | 828             | 6.3             | 2.7         |
| `test` (8 workers)                     | 257         | 2476            | 32.9            | 7.9         |
| `test-wc1` / `-wc2`                    | 105 / 196   | 2393 / 2381     | 37.8 / 31.6     | 8.1 / 8.4   |
| `test-w3` / `-w4`                      | 193 / 208   | 1839 / 2116     | 32.6 / 30.2     | 6.8 / 7.2   |
| `dev` (90 s)                           | 66          | 294             | 90.9            | 3.0         |
| `ui` / `ui-rpl1`                       | 157 / 158   | 677 / 676       | 6.2 / 6.1       | 2.8 / 2.4   |
| `pair:test+test`                       | 520         | 4735            | 50.5            | 8.9         |
| `pair:test+typecheck`                  | 279         | 3011            | 34.2            | 8.0         |
| `pair:test+ui` / `pair:dev+ui`         | 271 / 213   | 2373 / 925      | 33.6 / 90.1     | 8.3 / 4.3   |
| `two-sessions` (test → typecheck → ui) | 518         | 4806            | 45.6            | 8.9         |
| `three-sessions`                       | 776         | 6616            | 66.6            | 9.1         |

**Edge** (a looping `pnpm test` added every 30 s): 1 → 3.1 GiB / 427 pids, 2 → 4.5 / 636, 4 → 6.1 / 839,
5 → 7.3 / 872, then at 6 launched (5 alive) a run **failed**: `Finances.test.tsx` timed out at vitest's 5 s
under CPU starvation, with the container at 7.6 GiB anon (42 % of `memory.high`), 1140 pids (28 %) and PSI
`full` 0.36. Anon settled back to 543 MiB.

What it means:

- **CPU is the edge, not memory or pids.** One `pnpm test` keeps ~7.9 of 9 cores busy; two saturate them.
  Past ~5 concurrent suites, jsdom tests start timing out — a flaky timeout under parallel load is
  contention, not a bug. Memory and pids never came near their lines, so the anon/pids budget (and
  `enforce`) can't see this edge — hence the `test` cap (`concurrency`: 4 from 2026-10-29, 2 since 2026-11-13, below), tracked by
  `cli.ts barriers` so it can be loosened with data.
- **CPU plus memory pressure is what breaks the app suite's waits (2026-11-09).** Beside 16 threads
  sweeping 256 MB each (container anon about 13.5 GiB, as in the gate runs that failed), 4 runs in 6
  failed one wait: opening a Flux exercise from the list outran Testing Library's 1 s (each failing test
  ran 1.5–2.2 s). CPU-only load (up to 24 busy threads) failed 0 in 23. Capping workers at 4 still failed
  1 in 6, ran about 18 % slower under that load, so the worker cap isn't the fix for this wait (it ships since 2026-11-13 for
  the pair gain, below). `app/src/test/setup.ts`
  raises `asyncUtilTimeout` to 3000 ms instead: 0 in 6 under the same load, and no change in idle
  duration (about 20 s for the app suite).
- **Three sessions' full gate + UI at once is fine** (+6.6 GiB, +776 pids, all green), just CPU-bound.
- **Test tuning, 2026-10-13: none** (answer 3's bar is ≥ 30 % peak-anon cut for ≤ 15 % more wall time).
  `VITEST_MAX_WORKERS=3` cut 24 % at no wall cost; `--workspace-concurrency=1` saved nothing and was 15 % slower.
- **Vitest worker bench, 2026-11-08** (quiet board, ~3,680 tests, 37 runs, every one through `heavy.sh`; 3 reps per
  cell, 2 for workspace-concurrency 1; no failures or timeouts). A pair is two full suites started together from two
  worktrees. Medians:

  | Workers (cap) | Solo wall s | Solo Δanon  | Pair wall s (range) | Pair Δanon  | Pair container anon peak |
  | ------------- | ----------- | ----------- | ------------------- | ----------- | ------------------------ |
  | default (8)   | 74.4        | 3.5 GiB     | 104.1 (98–116)      | 6.8 GiB     | 11.3 GiB (over soft)     |
  | 6             | 77.2        | 3.5 GiB     | 103.5 (97–117)      | 6.1 GiB     | 11.0 GiB                 |
  | **4**         | **76.3**    | **2.6 GiB** | **97.4 (95–98)**    | **5.5 GiB** | **9.9 GiB**              |

  One suite keeps 8.1–8.7 of 9 cores busy at any cap; the cap cuts oversubscription (threads 273 → 213), not CPU.
  `--workspace-concurrency=1` halves threads but gains nothing alone or on top of cap 4 (100.6 s pair). **2
  concurrent suites are measured safe** (26 pair runs, 0 failures); 3+ weren't run. Each extra suite adds ~3.0 GiB at
  cap 4 on a ~4.4 GiB base, so 3 ≈ 13 GiB (under the 14.4 hard line) and 4 ≈ 16 GiB (over it) — the 2026-10-13
  edge of ~5 suites (2,600 tests then) no longer holds. Hence `concurrency.test` 2 and `tuning.test` `{ maxWorkers: 4 }`
  (2026-11-13, the user's call, below the 30 % bar). Measure 3 and 4 suites at cap 4 in a quiet window before
  loosening. Not covered: typecheck or lint beside the suites, a busy board, CI.

- **Same-day check, 2026-11-13** (the shipped setup: cap 4, `scripts` at 2; 4,742 tests, 6 packages — `extension`, about
  80 s, is new since the bench, so walls aren't comparable to it). Solo, uncapped vs cap 4, 2 each, no other suite
  running: wall 158 / 152 s vs 154 / 147 s; subtree 367 vs 277 threads and 5.8 / 5.6 vs 4.4 / 4.3 GiB RSS; container
  Δanon 4.8 / 4.2 vs 4.0 / 3.1 GiB. A pair at cap 4: 180 / 202 s, +6.0 GiB together, peak 13.7 GiB on a 7.5 GiB base
  (15 idle sessions); a 3rd suite printed `test cap full (2/2 …) — waiting` and ran when a slot freed. So the cap
  costs no wall time today; the pair-speed gain wasn't re-measured. At that base 3 suites ≈ 16.5 GiB — past hard.
  After PR 161 cut `extension` to ~15 s: uncapped 126 s vs cap 4 113 s. The same evening, 3 other sessions' suites
  (main's heavy.sh, cap 4, untuned) ran beside a capped one: anon 14.8 GiB (past hard), PSI `full` 0.40, and the Flux
  exercise wait failed at 4.4 s against `asyncUtilTimeout`'s 3 s, the 2026-11-09 failure mode below, at 4 suites.

- **Class costs** in `limits.json` are these maxima, rounded up, except `test` (the 2026-11-13 check: +320 pids and
  155 s, the maxima; 3200 MiB, the capped solo median and a pair's per-suite share — the 4.0 GiB max carried
  neighbours' noise, and as a cost it would hold the 2nd suite at a 7.5 GiB base, a cap of 1 in practice) and `ui`
  (since 2026-11-13: one solo `devcheck:local --tier full` with no other heavy job, +276 pids, +2664 MiB anon,
  301 s, 3497 MiB subtree RSS, rounded up to 280 / 2700 / 305; was 160 / 700 / 7, the 2026-10-13 dev server +
  Chromium cell, but `ui` jobs are mostly dev checks now; `staleness` still warns, since the class's 14-day p95 (406
  runs) is +4859 MiB / +469 pids: it mixes `shot.mjs` (~0.5–0.7 GiB), remote `pnpm devcheck` (~0.5–1.5 GiB) and
  local checks (2.4–6.9 GiB, partly neighbours' noise; a `--feature` local check is unmeasured solo)); `build`
  wasn't measured.

## Control tower

`scripts/board/tower.sh` — a full-screen board for its own tmux window (it replaces a
`watch board.sh status` window): `tmux new-window -n tower /workspace/scripts/board/tower.sh`. Keys: `q` quit ·
`1` / `6` / `2` history over 1 h / 6 h / 24 h · `←` `→` (or `h` `l`) move the readout column back / forward ·
`Esc` back to live · `r` refresh now. Node, no dependencies: `scripts/src/board/tower/`. It draws in Nord colours on the terminal's own background, like the tmux bar (painting Nord's grey over iTerm's navy read as haze).

**Panels.** Header: the dev-lock holder, its session, the countdown and the queue's `next`, then slot B's lock (` · devb …`, from `devlock.devb.json`; left out until that cache exists); gauges for anon
memory and pids (soft / hard marks from `limits.json`) and CPU against the cores. _Dev queue_, _Waiting on
you_ (an age only past a day: `1d`), the wave (a merged / open / in-flight / not-started bar, then the
unmerged items; merged ones are counted in the bar, legend and title, not listed) and _Plan_ come from
`queue.json` (below). _Plan_: dispatch's timeline, `HH:MM  countdown  kind  what (who)` by time, the
unscheduled last (`--:--`); merges and the maintainer's items bright, an item past due dimmed with `?` and dropped 2 h
after; its title is `next merge ~HH:MM` (the first `merge` with a time, `?` once past) or `n planned`.
_Sessions_: the latest sample's sessions, a row for each working one and each holding a branch, working first, then one `idle: a, b, c`
line (cut with `…`; the title counts both). _Machine_:
CPU, memory, pids, heavy jobs and working sessions on one time axis, each bucket's peak, a sampler gap blank;
under it the event ticks, one per column by precedence — `✗` a failed suite, a red `◆` a devcheck run that ended
other than PASS, `▲` a merge, a green `◆` a PASS, `·` a passed suite — and a readout of the exact values at the
readout column. _Test failures_: the last 7 days of suites (`class: test`, not load tests) by how many other
slot-class jobs (`test ui typecheck lint build dev`) overlapped each one at any point, with the failure rate
and median wall; a failure is any exit but 0, 130 or 143 (Ctrl-C and TERM are the operator). _Activity_: what
changed in the last 24 h, not what ran — failed jobs (local only: CI checks need an API the container's token
can't read), devcheck runs that ended (`localNotes/devcheck/ledger.dev.jsonl` and slot B's `ledger.devb.jsonl`, whose runs read `on devb`; a start only while in flight),
merges, PRs opened (gh `createdAt`), heavy leases that gave up or were denied, and the dev lock taken (a
`pnpm bot deploy-dev`) as this tower saw it (kept in memory: a viewer writes no history). Passing jobs, the Vite dev server, waits and the lock freed
stay out (_Machine_ and _Status_ count the suites); `other` and `test-file` jobs take no heavy slot and show
nowhere in the tower. _Status_: the dead-row TTL proof
(slot A's full runs that ended PASS since `proofs.deadRows.since`, minus `excludedRuns`; devb's rows are another table), the overnight vitest bench
when `localNotes/bench-vitest/results.tsv` exists, `queue.json`'s age, gh, the sampler's last tick, suites in
24 h, heavy jobs now.

**Sizes.** Wide at ≥ 160 × 40: queue, _Waiting on you_ and wave across the top in thirds; history beside sessions, the
band as tall as history's full 15 rows and up to 20 for a long session list; then plan (`max(44, 26 %)` cols) |
activity | failures over status (52). Narrow at ≥ 95 × 24: one column, pairs side by side, plan beside the
wave; below that, the header and a size hint. `Ctrl-a t` opens it as a borderless full-size tmux popup
(`tools/coi/tmux.conf`). Panels shrink to their minimums
before _Activity_ drops under 4 rows; a cut list ends `+n more`. Resizing redraws (SIGWINCH).

**Reads, and what it costs.** The board's files, never `board.sh status` (which scans `/proc` and peeks at
GitHub each call): incremental tails of `history/samples-<UTC day>.jsonl` (24 h, two files across UTC
midnight; each tick compacted to a few numbers) and `events-*.jsonl` (7 days), `devlock.json` and `devlock.devb.json`, `limits.json`,
`queue.json`, both slots' devcheck ledgers and the bench files, each re-read only when its size or mtime changes. Text
from them (and from gh) is cleaned to one column per glyph: control characters dropped, tabs as spaces,
double-width glyphs (CJK, emoji) as `?`. A `cpuCores` over 2 × the cores is a bad tick (_History_) and shows
as unknown. `gh pr list` at most once a minute, a failure keeping the last list; `devlock.sh refresh --max-age 50`
once a minute (50: the cache is stamped after its peek), which rewrites both slots' lock caches — the tower's
only write, and fewer GitHub calls than a `watch` on `status`, which refreshes at 30 s. It redraws every 5 s, writing
only changed rows (no clear, no flicker), on the alternate screen; exit, Ctrl-C, TERM, HUP and a crash restore
the terminal. Measured (2026-11-07, live board, 210 × 55): first tick 18 ms, then ~6 ms wall / 4–8 ms CPU
per tick, RSS ~100–120 MiB. `tower.sh --measure` logs each tick to stderr.

**`queue.json`** (`/workspace/localNotes/board/queue.json`, schema v1). The hub owns and writes it
(`docs/ops/HUB.md` → _The hub's duties_), tmp file + rename; `scripts/board/queue.example.json` is the seed.
Only `v` and `updatedAt` are required; unknown keys are ignored; the dev queue and to-dos show in file order,
the wave grouped by state (in flight, open, not started; merged only counted) and in file order within each.

```json
{
  "v": 1,
  "updatedAt": "<ISO>",
  "devQueue": [
    {
      "branch": "",
      "session": "",
      "state": "on-dev | next | waiting | building | pr-open | ready | needs-you",
      "slot": "dev | devb (optional, dev when absent)",
      "pr": 41,
      "eta": "<ISO, on-dev>",
      "waitingOn": "<waiting, needs-you>",
      "note": ""
    }
  ],
  "maintainer": [{ "text": "", "since": "<YYYY-MM-DD>" }],
  "wave": {
    "name": "Wave 2",
    "items": [
      {
        "branch": "",
        "state": "merged | open | in-flight | not-started",
        "pr": 40,
        "session": "",
        "title": ""
      }
    ]
  },
  "proofs": { "deadRows": { "since": "<ISO>", "target": 12, "excludedRuns": ["<run id>"] } },
  "plan": [
    {
      "at": "<ISO, optional>",
      "what": "",
      "kind": "dev | merge | maintainer | ci",
      "who": "",
      "you": "<optional: the maintainer's cost, 2 min | talk | 1 line + a mode>",
      "eta": { "from": "<ISO>", "to": "<ISO>", "source": "measured | guess" },
      "lane": "<optional: the branch whose ETA this row waits on>",
      "done": "<optional: true, or the ISO time it finished>"
    }
  ],
  "planAt": "<ISO, when the hub last rewrote the plan>",
  "planNotes": ["<what slips, what moved and why, what can wait>"],
  "mergeOrder": [{ "branch": "", "pr": 41, "note": "<optional>" }]
}
```

`mergeOrder` is the hub's landing order for the lanes in flight, first to land first (an entry may be a bare branch name); the web tower's NEXT shows
it (TOWER.md → _Panels_). Entries with no `branch`, a duplicate branch, or a field that isn't an array are named as
problems; the tower drops the bad entries and holds nothing on them. A bare-date `since` (`2026-11-13`, in
`maintainer[]` and `followups[]`) means some time that local day and is read as its end, so an age is never overstated.

A lane's `slot` is the dev slot it's on (CI-BOT.md → _Dev slots_); an `on-dev` lane on `devb` reads `branch@devb`, slot A's stay unmarked, and any other value drops the lane as a bad write (a tower from before slot B ignores the key). Lane states: `pr-open` (`PR`) is a PR the lane opened whose checks aren't green yet, between `building` and `ready`;
`ready` (`READY`) is a PR whose check is green, waiting on the maintainer's merge; `needs-you` (`YOU`)
is blocked on a maintainer step, named in `waitingOn`. All three are hand-set by the hub: the container's token can't
read check status, and the tower on a `main` without them drops such lanes as a bad write. `plan` is the one
source for the next merge — the PLAN panel's title and the statusline (`localNotes/board/next-merge.sh`) both
take the earliest `kind: merge` item with an `at` no more than 2 h past (the statusline also marks `?` once
`queue.json` is 30 min old) — and the hub rewrites it at every event; a `plan` item without `what` or with an unknown `kind` is dropped and named; one whose `at` isn't a
whole ISO date-time (a real date, minutes or seconds, an optional `Z` / offset; not a bare `22:40`, a date,
` PST` or fractions) is kept unscheduled and named, so the statusline's `date -d` can't
read it differently. A `queue.json` that won't parse leaves the tower on its last good plan while the
statusline reads the new file. No `plan` is an empty plan, not a problem.

The plan-table fields (the web tower's NEXT, TOWER.md → _Expand_) are all optional, and a file without them reads as
before. `you` is what the row costs the maintainer; `eta` is the window the row finishes in (`at` stays its start,
its sort key and the statusline's time), `measured` from board history or a `guess`; `lane` names the lane whose ETA
the row waits on, so the tower can mark it slipping; `done` strikes it (`true`, or the ISO time it finished, which
the expanded view sets against its due as est vs actual). A `done` row leaves the PLAN panel and the next merge, and
the statusline's `next-merge.sh` should skip it too. `planAt` is when the hub last rewrote the plan; `planNotes` its
notes on the whole. A bad value in any of them (a loose time, `to` before `from`, an unknown `source`, a `done` that
is neither, a `lane` that isn't a branch name, a `planNotes` that isn't a list of text) is named as a problem and
dropped; the row stays. The hub rewrites them at every lane ETA report.

A wave item's named `pr` fills a missing title from gh, and gh's `MERGED` for it upgrades the item to merged
but never downgrades one; an item with no `pr` takes the number and title of an open PR on its
branch, never a merged one (a reused branch name would carry an old PR). The age shows amber past 30 min, red past 2 h. A malformed
file keeps the last good parse on screen and names the problem; a missing one prints the seed's `cp` line.
`excludedRuns` is for full runs that don't count toward the TTL proof (a purge, a cap hit) — the ledger can't
tell.

**Proof frames.** `scripts/board/tower-capture.sh <dir>` runs the tower on the fixtures
(`scripts/src/board/tower/fixtures/`, a fixed clock) in a private tmux server at 210 × 55 and 100 × 50,
presses `6`, `←`×12 and `2` (failing if no frame draws within 10 s), and writes each frame as ANSI text (`cat` it in a truecolor terminal), SVG and
PNG (headless Chromium from `~/pw`, else ImageMagick, whose SVG renderer drops braille); `--live` captures
the real board instead. `tower.sh --once <cols>x<rows>` prints one frame without a terminal; `--no-gh` skips
`gh pr list` (live, the minute's `devlock.sh` peek still runs; `--fixtures` skips both).

**The web tower.** http://localhost:6183 reuses the data half (`source.ts` → `TowerState`) with its own
derivation and lane files: `docs/ops/TOWER.md`. This terminal tower stays as its fallback.

## Script-shape rules (COI monitor)

The monitor reads every process's argv (`docs/ops/COI-SANDBOX.md`, `localNotes/code-on-incus/APERTURE-ANALYSIS.md`).
Everything here: never reads `/proc/*/environ`, never `xargs` over `/proc`, no `python`/`perl`/`ruby`/`node` one-liners (heredocs
only; `awk`, inline or `-f`, isn't on the monitor's list), no `ps | grep` sweeps (it reads `/proc/<pid>/stat` itself), kills by PID, keeps
labels off argv, and has no `/curl` or `/wget` on any command line. Subagent prompts that run these scripts
carry the same list.

## Operator steps

- **Hooks before merge:** `.claude/settings.json` registers them from the main checkout, so until merge they
  run only from a paste into the main checkout's `.claude/settings.local.json` (read-only in the container)
  with the worktree's absolute hook paths. Remove the paste after merge, or every hook runs twice.
- **Status line:** two lines appended to `~/.claude/statusline-command.sh` (container-local) source the
  snippet from the main checkout, else the worktree.

## Known limitations

- CPU-inferred state (no hooks yet) misreads a session waiting on the model as idle.
- Session identity relies on `CLAUDE_PID` in the Bash env (observed, undocumented, Claude Code 2.1.296) and
  falls back to walking `/proc` to the nearest `claude` ancestor; hooks always walk.
- The first sampler started wins the lock; after this lands, `board.sh sampler restart` from the main checkout
  so it runs main's code. Edit `sampler.sh` / `lib.sh` only through a rename (`sed -i`, write-then-`mv`) —
  overwriting a file in place under the running sampler has killed it once. The lock is taken with `flock -w 5`,
  so a `status` / `json` / SessionStart probe (a microsecond hold) never costs a `start`; `start` confirms the
  lock within 1 s or says `sampler: did not start — see sampler.log` (exit 1), and `sampler_running` probes with
  `flock -w 0.2` — only the sampler keeps the lock that long — so a live sampler costs `status`/`json` 200 ms. Tests point the lock and pid file elsewhere
  (`APERTURE_SAMPLER_LOCK`, `APERTURE_SAMPLER_PID`).
- On the Mac there is no `timeout` (coreutils), so `devlock.sh refresh` doesn't peek there and `board.sh status`
  shows the container's last cache, marked stale once it's 5 min old.
- The cap only sees suites that hold a slot: a raw `pnpm test` (not under `heavy.sh`) takes none, so 2
  wrapped suites plus raw ones can still pass the edge. The guard's deny at a full cap closes only the case where 2 wrapped suites already run.
- `edge.sh` maps the throttle regime; pids exhaustion is container-wide, so other live sessions can abort —
  hence the quiet-window precondition.
