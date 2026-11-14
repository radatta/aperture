# The web tower

A web page at **http://localhost:6183** that answers the five questions Rahul asks dispatch: what needs me, what's
happening now, what's next, did anything get dropped, is the machine OK. It's served from the container (COI port
`vite10`, container 6183 → the Mac's localhost:6183), so it opens in Safari or an iTerm2 browser pane. Not from the
iPhone: the port is the Mac's only.

The terminal tower (`tower.sh`, `Ctrl-a t`; `docs/ops/SESSION-BOARD.md` → _Control tower_) stays as a fallback. Its
render half retires after a week of web use (a follow-up). The two share the data modules in
`scripts/src/board/tower/`.

```
container                                                                       Mac
board.sh tower start → tower-web.sh → node tower/web/main.ts   ◀── GET :6183 ── Safari / iTerm2 pane (polls 5 s)
  every 5 s   Source.refresh: samples, events, ledgers, lock caches, queue.json, lanes/, mac-stats.json, costs
  every 60 s  gh: pr list · newest 100 Actions runs · checks per open PR head · files per new head
              devlock.sh refresh (the lock caches)
  hourly      Actions minutes estimate (job times; cached in localNotes/board/tower/actions-runs.json)
                                                 localNotes/board/mac-stats.json ◀── launchd agent, every 15 s
```

## Run it

| Command                                       | Does                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board.sh tower start\|restart\|stop\|status` | The server, detached (`setsid nohup`). It writes `/tmp/aperture-tower.pid` once the port is bound, and "running" means that pid is alive as the tower's node; the port is the one-server lock. Log: `localNotes/board/tower.log` |
| `scripts/board/tower-web.sh --once`           | One View as JSON, no socket (`--fixtures <dir> --now <iso>` for the recorded board; `--no-gh`)                                                                                                                                   |

The SessionStart hook (`board-session.sh`) starts it when none is running, always from `/workspace`'s main checkout
and never from a worktree. After a merge that changes it, run `board.sh tower restart` from `/workspace`. The page's
header shows the commit it serves. It binds `0.0.0.0:6183` (the COI proxy's connect address isn't visible from
inside). It serves three read-only routes, `/`, `/app.js` and `/api/state` (`?history=1` adds the chart series),
and nothing else, and only to a `Host` of `localhost` or a loopback address (no DNS rebinding); a bad URL is a 400.

## Panels

1. **NEEDS YOU (n)**, in order:
   - lane `needs` items, with the link or the one-line Mac command and a copy button;
   - **MERGE ME** PRs, with what they unblock (queue lanes whose `waitingOn` names the PR);
   - **DEPLOY FAILED**, with the run link;
   - `queue.json` `rahul[]` to-dos;
   - the Mac agent missing (with its install line) or silent.
2. **NOW**: the `dev` and `devb` cards (holder, session, what it's doing, how long, lock expiry), then every lane that's
   building, in PR, failing checks, merged or deploying, each with its lane file's age.
3. **NEXT**: your next step (the first NEEDS YOU item, else the next `plan[]` `rahul` item); the merge queue (MERGE ME
   and HOLD, with the reason); the dev order per slot (`devQueue` `next` / `waiting`).
4. **DONE TODAY**: PRs merged since local midnight and their main deploy result.
5. **HEALTH**:
   - the container: memory against soft and hard, CPU, pids, live `test` slots against `limits.json`;
   - the Mac (below);
   - Actions minutes: an **estimate**, job times each rounded up to a minute, of the plan's 3,000 (the container
     token can't read billing: 403), for the UTC month, listed one UTC day at a time. A filtered listing stops at
     1,000 runs, so a day that reaches it turns the figure into a lower bound (`≥`, amber);
   - AWS month to date.
6. **SLIPPING**:
   - `followups[]` that are STALE (open, `after: "now"`, over 24 h: `staleFollowups()` in `queue.ts`, which
     `pq-check.ts` imports);
   - parked lanes;
   - lanes whose file hasn't moved in a day.

The **charts** toggle adds 24 h of container memory and CPU and the Mac's memory since the server started. The
**SOURCES** strip lists every source with its age and state: `ok`, `stale`, `failed` (with the error) or `missing`.
A failed source keeps its last good value and says so; it is never shown empty or green. Two failed page polls in
a row put a red "tower server unreachable since HH:MM" banner over everything.

Freshness limits (`derive.ts` `STALE`):

| Source          | Stale after                      |
| --------------- | -------------------------------- |
| sampler         | 90 s                             |
| lock caches     | 5 min                            |
| gh              | 3 min                            |
| queue.json      | 2 h                              |
| a lane file     | amber at 2 h, SLIPPING at 24 h   |
| Actions minutes | 2 h                              |
| Mac stats       | 60 s, then silent (red) at 5 min |
| AWS costs       | 3 days                           |

## Lane states

`derive.ts` `laneRow`, first match wins. Truth comes from locks, PRs and runs; the lane file adds the phase, the step
and what Rahul must do.

| State                                                         | When                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PARKED                                                        | the lane file says `parked`, or the queue's `waitingOn` starts `PARKED`                                                                                                                                          |
| MERGED → DEPLOYING → DONE / DEPLOY FAILED                     | the PR merged; main's `Deploy` push run for its merge sha. A run cancelled by a later merge (deploy.yml's concurrency group) follows the newest later Deploy run, which carries it                               |
| TESTING on dev / devb                                         | the branch holds that slot's live lock. Detail: `deploying` (its `deploy-dev <sha>` run in progress), `devcheck running since` (an open ledger run, under 2 h), `held for Rahul: …`, else the step               |
| PR (checks running / no checks seen / checks unknown / draft) | open PR; the `pull_request` runs for its head sha (newest per workflow). Green is believed only from fresh reads: a failed or stale PR list (its head may have moved) or checks read caps it at `checks unknown` |
| CHECKS FAILED                                                 | a check ended other than success / skipped / neutral                                                                                                                                                             |
| MERGE ME / HOLD (reason)                                      | every check green; HOLD when `holdReason` gives one                                                                                                                                                              |
| BUILDING                                                      | anything else: the lane file's phase and step, or `no status file` in grey                                                                                                                                       |

**The automatic HOLD** (`holdReason`, first match wins). A main merge redeploys dev over a dispatched branch
(CLAUDE.md → _Git workflow_), so:

1. the `dev` lock is unknown: no cache, a failed or stale refresh (over 5 min), an unreadable expiry;
2. another branch holds a live `dev` lock;
3. a devcheck run is open on `dev` (even with the lock lapsed);
4. the runs read is failed, stale or not read yet (`main deploy state unknown`);
5. a dev dispatch (`deploy-dev <sha> <key>` run-name) is running;
6. `devb` is busy (its lock unknown, held by another branch, or a devcheck open on it) and the PR changes devb's
   shape (`cdk/`, `pnpm-lock.yaml`, `packages/shared/src/stage.ts`: `deploy-base.ts` → `SHAPE_PATHS`), or its
   files aren't read yet;
7. a main Deploy run is queued or running;
8. dispatch's `devQueue[].hold` reason.

An expired lock, when its cache is fresh, never holds. HOLD is never a NEEDS YOU item. A slot card shows `free`
only for a fresh, free lock; an unknown one says why, in red.

## Lane files

Each feature session writes `/workspace/localNotes/board/lanes/<branch>.json` at its hub checkpoints and at each
phase change (CLAUDE.md → _The hub_), from its worktree:

```
pnpm board lane <phase> [--step <text>] [--pr <n>] [--slot dev|devb] [--session <name>]
                [--needs <what> (--link <https url> | --cmd <one-line Mac command>) [--unblocks <text>]]
pnpm board lane --clear          (Cleanup)
```

- Phases: `plan` `build` `gate` `review` `local` `dev` `pr` `merged` `cleanup` `parked` `blocked`.
- The branch and sha come from git, never from an argument. The branch must match `^[a-z0-9][a-z0-9-]{0,62}$`.
- The session comes from the board's registry.
- The file is written tmp + rename into the board dir (`boardDir()`: `APERTURE_BOARD_DIR`, else
  `/workspace/localNotes/board`).
- `needs` is cleared by any write without `--needs`, because a stale "needs you" is worse than none.
- `phaseSince` is kept while the phase is unchanged.
- An unreadable file shows as a problem row in SOURCES, never dropped.

```json
{
  "v": 1,
  "branch": "tower-web",
  "session": "auto-6",
  "phase": "review",
  "step": "round 1 of 3",
  "phaseSince": "…Z",
  "sha": "<40 hex>",
  "pr": null,
  "slot": null,
  "needs": { "what": "…", "link": "https://…", "cmd": null, "unblocks": "…" },
  "updatedAt": "…Z"
}
```

Dispatch writes only intent, in `queue.json` (schema: SESSION-BOARD.md → _Control tower_), plus two keys the web
tower reads: `devQueue[].hold` and `followups[]` (`id`, `what`, `owner` rahul|lane|dispatch, `after`, `status`
open|tracked|done|dropped, `source`, `since`).

## Mac stats

A launchd agent on the Mac, `dev.rahuldatta.aperture.macstats` (`tools/macstats/`). It is not a mailroom job: the
mailroom's runner is serial and runs in the container→Mac direction. Every 15 s it runs `vm_stat`, `sysctl` and `ps`
and writes `<main checkout>/localNotes/board/mac-stats.json`:

```json
{ "v": 1, "t": "…Z", "host": "…", "agentVersion": "<sha256 of macstats.sh>", "memTotalMiB": 36864,
  "mem": { "freeMiB": …, "activeMiB": …, "inactiveMiB": …, "wiredMiB": …, "compressedMiB": …, "usedMiB": …,
           "freePct": …, "pressure": "normal|warn|critical" },
  "swap": { "totalMiB": …, "usedMiB": … }, "load": [1, 5, 15], "cpus": 12,
  "vm": { "pid": …, "comm": "com.apple.Virtualization.VirtualMachine", "rssMiB": … } }
```

- `usedMiB` is active + wired + compressor.
- `freeMiB` is free + speculative.
- `vm` is the largest resident process named like a hypervisor (`Virtualization`, `limactl`, `qemu`, `vfkit`,
  `krunkit`), or `null`.

**Trust boundary.** The agent takes no input from the container:

- Its only argv are the two absolute paths the installer rendered into the plist.
- It reads nothing from the shared folder and executes nothing from it.
- It makes no network or Keychain call.
- Its one write is `mktemp` in the board dir, then `mv -f`. Before that, a symlink at the target is removed (rm
  removes the link, not what it points at), and a directory or a link to one is refused, since `mv` would move into
  it. The remaining race (a link re-planted between the rm and the mv) can at worst drop one stats file into the
  directory it points at; the agent never reads or runs it.
- A symlinked or missing board dir is refused, with one log line per change.

The worst outcome of a bug is a wrong number on the page. `macstats-fixtures.test.ts` checks this statically, plus
the parse on recorded macOS output (`fixtures/mac/`).

**Install** from the main checkout. It's the mailroom's pattern: GitHub at main's head, read with the mailroom's
Keychain token (Contents: read); `--ref <sha>` installs an unmerged commit after a `[y/N]`:

```
cd /Users/rahuldatta/Coding/Personal/aperture && /bin/bash <(curl -sSf -H @<(printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -H 'Accept: application/vnd.github.raw+json' 'https://api.github.com/repos/radatta/aperture/contents/tools/macstats/install.sh?ref=main')
```

The same line with ` --uninstall` appended removes it, keeping the last `mac-stats.json`, which the page then shows
stale and then silent. Logs: `~/Library/Logs/aperture-macstats/agent.log`.

## AWS costs

`/workspace/localNotes/costs-daily.json` is Rahul's `aws ce get-cost-and-usage --granularity DAILY --group-by
LINKED_ACCOUNT,SERVICE` pull, re-pulled on request. The page sums this month's `UnblendedCost`, split dev
(618015769091) and prod (594060113104). "As of" is the file's mtime and "through" is its last day.
