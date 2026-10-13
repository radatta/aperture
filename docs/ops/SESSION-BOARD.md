# Session board — sharing one container between Claude sessions

Several Claude sessions run in the one COI container. They share its memory, threads and CPU, and two of
them can hit the same dev stage or the same files. The board shows who is doing what, keeps a usage history,
and leases the two shared things that need it. All of it lives in `scripts/board/` (bash) and
`scripts/src/board/` (the tested decisions, TypeScript under plain `node`).

**It must never make a session timid.** Tests and the headless UI pass always run. Below the _measured_
edge the board only offers advice; a heavy job waits only past the measured hard line, and only once
`limits.json` says `enforce: true`.

## Use it

| Want                              | Run                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Who's running what, headroom      | `scripts/board/board.sh status` (live in the container; on the Mac, the sampler's latest snapshot) · `board.sh json` for machines      |
| Run a heavy command               | `scripts/board/heavy.sh -- pnpm test` — same output and exit code, plus its peak usage in the history and a budget slot others can see |
| Hold the dev stage for a dev test | `scripts/board/board.sh lease acquire dev [--wait SEC] [--note "…"]` → `lease release dev` when done                                    |
| What does a mix of sessions cost  | `node scripts/src/board/cli.ts report /workspace/localNotes/board/history 7` (days)                                                    |
| Is `limits.json` stale            | `node scripts/src/board/cli.ts staleness scripts/board/limits.json /workspace/localNotes/board/history`                                |
| Sampler                           | `board.sh sampler start\|restart\|stop\|status` · `board.sh gc` drops stale slots/sessions, history older than 90 days                  |

Every Claude status line ends with the board's one-liner (`· 2 working · 5 idle · heavy 0 · anon 2.0/18G ·
pids 315/4096 · dev: flux`) — `scripts/board/statusline-snippet.sh`, sourced at the end of
`~/.claude/statusline-command.sh`.

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

| File (`/sys/fs/cgroup/`)                     | Meaning                                    | Use                                    |
| -------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| `memory.stat` → `anon`                       | real process memory                        | **the number**                         |
| `memory.current` / `memory.peak`             | anon + cache (+ kernel)                    | context only                           |
| `memory.high`                                | throttle line                              | thresholds are fractions of it         |
| `memory.max`                                 | `max` → no cgroup OOM                      | a 137 is the VM or userland            |
| `memory.events` `high` / `oom_kill`          | throttle hits / kills since boot           | the delta per job is the verdict       |
| `memory.pressure` `full avg10`               | stall regime                               | the stop signal                        |
| `pids.current` / `pids.max` / `pids.peak`    | tasks (threads) / ceiling / high-water     | `paste -d/ pids.{current,max}`         |
| `cpu.stat` `usage_usec`, `cpu.pressure`      | CPU time, CPU stalls                       | cores busy = Δusage / Δt               |
| `/proc/meminfo` `MemTotal`                   | VM RAM                                     | the real 137 line                      |
| `/proc/<pid>/stat` (parse after the last `)`) | ppid, threads, rss, cpu ticks, start time | attribution (`comm` may hold spaces)   |

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
  session name, and the `SendMessage` address.
- **state** comes from the session's hooks (`stateSrc: "hook"`: working from a prompt until Stop). A session
  that hasn't fired a hook since the hooks were installed falls back to CPU (`"cpu"`, ≥ 5 % of a core) —
  unreliable, because a session waiting on the model uses almost no CPU. `board.sh status` marks those `*`.
- `unattributed` counts heavy-category threads with no session (drift detector for the attribution).
- `gapSec` is set when a tick is > 60 s late — the container was frozen or the VM slept.
- It also rewrites `board/status.line` every tick and, every 5th tick, `board/overlap.json`.

`heavy.sh` adds one **job event** per run to `history/events-<date>.jsonl` (`kind: "job"`, below); lease
actions are `kind: "lease"`. `cli.ts report` buckets the samples by mix (`2w 5i 1h`) with median / p95 / max
anon, pids and cores; measures an idle session directly (RSS, threads); estimates each extra session's anon
from heavy-free ticks; and summarises real jobs (load-test runs excluded) per class.

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
  more wall time. Until then `null` — no guessing.

## Leases

State lives on the shared mount (`/workspace/localNotes/board/`, visible from the Mac), written tmp + rename.
Every lease change runs under `flock /tmp/aperture-board.lock` — on the container's rootfs, because the whole
population is this one container (virtiofs `flock` semantics aren't worth trusting).

**`dev`** — one branch on the dev stage at a time. Advisory and local; ci-bot's `refs/locks/dev` will be
GitHub's truth, and dev-e2e's build marker catches an overwrite after the fact. Lease
`{holderPid, holderStart, holderName, branch, acquiredAt, expiresAt, ttlSec: 2700, note}`:

- free → granted; the holder again → renewed; someone else → exit 3 with who and until when
  (`--wait SEC` polls, `--force` takes it, logged).
- **expired** → taken over; holder **dead** (pid gone or reused — `/proc` start time) → taken over at once,
  with the `SendMessage` text printed for the new holder to send.
- The holder's **session ending** flags it `holderGone` but keeps it until TTL (45 min) — dev testing and
  feedback outlive a session restart. Each prompt in the holder's session on that branch renews it.
- Only the holder releases it (`--force` overrides, logged).

**`heavy`** — a counting budget, one slot per running heavy job (`leases/heavy/<claudePid>-<wrapperPid>.json`).
The decision (`lease.ts` `decideHeavy`): predicted = live pids / anon + the cost of slots younger than 20 s
(not ramped up yet, so not in the live numbers) + this job's class cost. Under soft → run. Over soft → run,
with a one-line note. Past hard → with `enforce: false` (shipped) run anyway and log `wouldWait`; with
`enforce: true` wait for room, polling every 2 s, up to `--wait` (600 s), then exit **75**: tell the user
rather than retry. Slots whose wrapper died are dropped on the next acquire and by `gc`.

## `scripts/board/limits.json`

Thresholds are **fractions of the live `pids.max` / `memory.high`**, so a limit change moves nothing:
`pidsSoftFrac` 0.80 / `pidsHardFrac` 0.92 (3276 / 3768 at 4096), `anonSoftFrac` 0.60 / `anonHardFrac` 0.80
(10.8 / 14.4 GiB at 18 GiB), `psiFullKill` 15 (load-test stop), `currentGuardMiB` 1536. `classes` hold each
job class's cost (`pids`, `anonMiB`, `p95Sec`, `source`) — shipped as the 2026-10-06 bench maxima × 1.6 for the
8-worker fan-out, `measuredAt: null`, `enforce: false`. The quiet window fills them in and sets
`measuredLimits`; `cli.ts staleness` then warns when the live limits differ or a class's real p95 runs 20 %
over its cost.

## Hooks

Four, all fail-open, documented with their fixtures in `.claude/hooks/README.md` → _Board hooks_:
SessionStart registers and injects headroom / dev lease / overlaps; UserPromptSubmit and Stop keep the state;
the Bash PreToolUse guard offers `heavy.sh` and denies only at the measured edge with `enforce: true`;
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
   summary line per rep, a `matrix-<date>.jsonl` row per cell. Cells (`matrix.sh list`): `typecheck` and
   `lint` cold (`tsc -b --force`, `eslint` without cache); `test`; `test-wc1`/`-wc2`
   (`--workspace-concurrency`); `test-w3`/`-w4` (`VITEST_MAX_WORKERS`); `dev` (90 s); `ui` and `ui-rpl1`
   (`measure/ui-cell.sh`: dev server + Chromium over 4 routes at phone width, `--renderer-process-limit=1`
   on/off; `PW_DIR` must hold Playwright); `pair:test+test`, `pair:test+ui`, `pair:test+typecheck`,
   `pair:dev+ui`; `two-sessions` / `three-sessions` (test → typecheck → ui per tree, trees in parallel).
4. `edge.sh --detach` — detached (progress in `history/edge-<date>.log`), adds a looping `pnpm test` instance every 30 s until a
   stop fires, a run exits ≥ 128, or 12 instances; stops them by PID, waits for anon to settle, writes
   `history/edge-<date>-<HHMM>.json` (per step: instances, peaks, PSI, `memory.events` deltas, exits, and the
   **head** of a failed run's output). Refuses while another session was working in the last 5 min
   (`EDGE_FORCE=1` with the user's say-so). `EDGE_CMD` swaps the job for a dry run. Expected at 18 GiB: the
   PSI stop at ~4–5 instances, well before pids (~10) — the throttle regime, mapped.

**Stop conditions** (1 Hz in `heavy.sh` under `HEAVY_GUARD=1` and in `edge.sh`, all from `limits.json` ×
live limits): pids past soft → stop launching; pids past hard, anon past hard, PSI `full avg10` past
`psiFullKill` twice running, or `memory.current` within `currentGuardMiB` of `memory.high` with PSI rising →
kill children; a run exiting ≥ 128 (bar the 143 of our own stop) → stop and record.

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

_Pending the quiet window._

## Script-shape rules (COI monitor)

The monitor reads every process's argv (`docs/ops/COI-SANDBOX.md`, `localNotes/code-on-incus/APERTURE-ANALYSIS.md`).
Everything here: never reads `/proc/*/environ`, never `xargs` over `/proc`, no interpreter one-liners (`awk -f`
files and heredocs only), no `ps | grep` sweeps (it reads `/proc/<pid>/stat` itself), kills by PID, keeps
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
  overwriting a file in place under the running sampler has killed it once.
- `edge.sh` maps the throttle regime; pids exhaustion is container-wide, so other live sessions can abort —
  hence the quiet-window precondition.
