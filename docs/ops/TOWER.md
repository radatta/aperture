# The web tower

A web page at **http://localhost:6183** that answers the five questions the maintainer asks dispatch: what needs me, what's
happening now, what's next, did anything get dropped, is the machine OK. It's served from the container (COI port
`vite10`, container 6183 → the Mac's localhost:6183), so it opens in Safari or an iTerm2 browser pane. The phone
reaches it as a Home Screen web app through Cloudflare (Access → a Worker that only proxies → Workers VPC →
cloudflared → localhost:6183), so the page only polls: WebSockets don't pass that path (_Phone_, below).

The terminal tower (`tower.sh`, `Ctrl-a t`; `docs/ops/SESSION-BOARD.md` → _Control tower_) stays as a fallback. Its
render half retires after a week of web use (a follow-up). The two share the data modules in
`scripts/src/board/tower/`.

```
container                                                                       Mac
board.sh tower start → tower-web.sh → node tower/web/main.ts   ◀── GET :6183 ── Safari / iTerm2 pane (polls 5 s)
  per poll    Source.refresh: samples, events, ledgers, lock caches, queue.json, lanes/, mac-stats.json, costs
  every 5 s   gh polls (each on its own cadence below) · a Mac sample for the series (mac-stats.json)
  every 60 s  gh: pr list · newest 100 Actions runs · files per new head
              checks per open PR head (every 60 s while running, 2 min once all finished)
              devlock.sh refresh (the lock caches)
                                                 localNotes/board/mac-stats.json ◀── launchd agent, every 15 s
```

## Run it

| Command                                                | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board.sh tower start\|restart\|stop\|status\|version` | The server, detached (`setsid nohup`). Only the server `start` launches writes `/tmp/aperture-tower.pid`, once the port is bound; "running" means that pid is alive as the tower's node, and the port is the one-server lock. With the pidfile gone (`/tmp` cleaned), the port's listener (`ss -ltnp`), if it is a node running `tower/web/main.ts` without `--fixtures` / `--once`, is the server, and its pid is written back; any other listener (a proof server included) is never claimed, and `start` names it. `APERTURE_TOWER_PORT` moves the port (6183), `APERTURE_TOWER_PID` the pidfile. Log: `localNotes/board/tower.log`. `version` prints the commit the running server started from, which it writes beside its pidfile (`<pidfile>.sha`, `<pid> <sha>`; printed only when that pid is the running server, else empty: unknown); `stop` removes it. `restart` exits with `start`'s status. |
| `pnpm board sync-main`                                 | The main checkout to `origin/main` (fetch, then `git switch --detach`; refuses tracked changes or a checkout on a branch, untracked files are fine), then `board.sh tower restart` only when the tower is running and its served commit differs from the new HEAD in a file the tower runs (`behind.ts` `TOWER_PATHS`: `scripts/src/board`, `scripts/board` and the files they import or read outside them, tests and fixtures excluded; a test holds the list to the import graph) or is unknown. Never starts a stopped tower. Prints what moved and why it restarted or didn't; a rerun is a no-op. Runs from any worktree.                                                                                                                                                                                                                                                                             |
| `scripts/board/tower-web.sh --once`                    | One View as JSON, no socket (`--fixtures <dir> --now <iso>` for the recorded board; `--no-gh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The SessionStart hook (`board-session.sh`) starts it when none is running, always from `/workspace`'s main checkout
and never from a worktree. After a merge, `pnpm board sync-main` moves `/workspace` and restarts the tower only if
its code changed. The page's header shows the commit it serves; when the checkout's HEAD has moved past it in a tower
file (a merge synced by hand, or `pnpm lane start` detaching `/workspace`), the sources chip reads "behind main" and
SOURCES says what to run. The server compares on each page poll (HEAD read from the file, `git diff` once per HEAD
move), never on a timer. Only a detached checkout is compared; a tower run by hand from a checkout on a branch shows no chip. It binds `0.0.0.0:6183` (the COI proxy's connect address isn't visible from
inside). It serves read-only routes only: `/`, `/app.js`, `/api/state` (`?history=1` adds the chart series) and the
icon (`/icon.svg`, `/apple-touch-icon.png` with its `-precomposed` twin, which iOS probes, and the tab icon
`/favicon.svg`, `/favicon-32.png`, `/favicon-64.png`, `/favicon.ico`), and nothing else, and only to a `Host` of `localhost` or a loopback address (no DNS rebinding); a bad URL is a 400.

## Panels

How it reads (the maintainer, 2026-11-13: the text was too small and too long, and should look livelier):

- Big type, one line per item, details on click: long text from `queue.json` or a lane shows its first clause only.
- Nord colours, each beside its word:

  | Colour | Means                   |
  | ------ | ----------------------- |
  | frost  | on dev                  |
  | blue   | building                |
  | purple | a PR in flight          |
  | green  | ready / merge me / done |
  | yellow | needs you / held        |
  | orange | deploying               |
  | red    | failed                  |
  | grey   | waiting / parked        |

- A pulsing dot marks work in flight, elapsed timers tick every second, and a row flashes when its state changes.
  Under `prefers-reduced-motion` the pulse, flash and glow are off; the timers still tick (text, not motion).
- Each lane has a phase track: plan › build › gate › review › local › dev › pr › merged, with the current step lit.
- The page reloads itself when the server restarts on a new commit (its `version`). The script itself is read
  from disk on each request, so a reload is all a new one needs.

From the top:

1. **The health strip**, always above the fold at 1512×860. Click a tile for its details.
   - **TODAY**: DONE TODAY's merges (the same day boundary) and how many deployed. It glows when one lands.
   - **CONTAINER**: memory against soft and hard (a last-hour sparkline), CPU, live `test` slots against
     `limits.json`.
   - **MAC** (below): until `tools/macstats/install.sh` is on `origin/main` it says "installs at merge".
   - **AWS**: month to date.
2. **NEEDS YOU (n)**, in order:
   - lane `needs` items, with the link or a copy button for the one-line Mac command (the phone says "on the Mac"
     instead; the command is in the details). An ask written before its lane's PR merged is dropped with the lane;
     one written after the merge shows;
   - queue lanes in `needs-you` with no lane-file ask, in the queue's words;
   - **MERGE ME** PRs, with what they unblock (queue lanes whose `waitingOn` names the PR);
   - **DEPLOY FAILED**, with the run link;
   - `queue.json` `maintainer[]` to-dos (a bare-date `since` shows as `since MM-DD`, not a timer);
   - an unreadable lane file (it may have carried an item);
   - the Mac agent missing (its install line, once that's on main) or silent.
3. **NOW**: the `dev` and `devb` cards, then every lane that's building, needs you, ready, on dev, in PR or failing
   checks. A finished lane (merged, deploying, deployed or deploy failed, or a lane file at `merged` / `cleanup`
   with no open PR) shows only in DONE TODAY, and its slot card while it still holds a lock.
   - A card shows the holder, session, what it's doing and the lock's end; a click shows the full detail.
   - A lock read under 5 min old is a quiet "as of HH:MM". Past that the card turns amber: "lock unknown · last
     read HH:MM", with why (the refresh's own error, `failedWhy`) in its details.
   - A building lane whose lane file hasn't moved in 2 h (`STALE.lane`) carries an amber "quiet" age.
4. **NEXT**:
   - your next step (the first NEEDS YOU item, with how many more; else the first `plan[]` `maintainer` item that is
     undated, or timed within 2 h of now either way);
   - the landing order (`queue.json` `mergeOrder`), numbered, each lane as it stands (building, PR, HOLD…, or NOT
     STARTED with no lane file, queue entry or PR; such a lane shows here only, never in NOW). An entry whose PR
     merged (in the PR list's newest 40) or whose row is merged / deploying drops out;
   - the merge queue (MERGE ME and HOLD, with the reason) not already in the landing order;
   - your other such `plan[]` steps, up to 3 (PLAN);
   - the dev order per slot (`devQueue` `next` / `waiting`): a different order from the landing order, so a lane
     can show in both;
   - one muted PARKED line for the lanes whose `waitingOn` starts `PARKED`.
5. **DONE TODAY**: PRs merged since the day began: local midnight, but before noon it reaches back 12 h
   (`dayStart` in `web/main.ts`), so last night's merges stay in view through the morning (marked `yest`) and age
   out by noon, with no reset cliff. Fork PRs (`isCrossRepository`) are dropped at the read: a fork's branch name is
   its owner's choice and never stands for a lane, so a merged fork PR doesn't show here either. Each shows `deployed ✓` / `deploying` / `deploy failed`, with the long form (a
   superseded run) in its details. A merge whose own Deploy run was cancelled rides the first later run that
   wasn't cancelled too (not the newest, which may still be running or fail after this one deployed).
6. **SLIPPING** (collapsed):
   - `followups[]` that are STALE (open, `after: "now"`, over 24 h: `staleFollowups()` in `queue.ts`, which
     `pq-check.ts` imports);
   - DUE: open `followups[]` whose `after` has happened: a merged branch or PR (`<branch>`, `<branch> merge(s)`,
     `PR <n>`, optionally `+ N day(s)|week(s)` and a trailing `(…)`; in the PR list's newest 40) or a real date that
     has begun (`2026-11-20 …`, at its `~HH:MM` if given, or a whole ISO time; `Sat 11-14 …`, zero-padded, the nearest
     such date, a year either way). Exact
     shapes only: free text (`wave 4`, `1-2 days after …`) never fires (`firedFollowups()` in `queue.ts`);
   - parked lanes;
   - lanes whose file hasn't moved in a day.

**Charts** (the header toggle) show 24 h of container memory and CPU, plus the Mac's memory since the server started (up to 24 h; the server samples `mac-stats.json` on its own 5 s tick, so the series has no gap while no page is open). A sparkline with under 3 points isn't drawn.

**Phone** (≤ 700 px; the maintainer's iPhone, 440 px, and 390 px):

- Nothing is cut off. Text CSS would clip wraps; a row whose first clause is all it shows has a `›` and its full
  text one tap away; every row and slot card opens on a tap, and stays open across polls.
  `short()` never cuts inside `( )` or `[ ]`.
- The header stays one line: the time without "as of", the commit in SOURCES (`serving <sha>, started HH:MM`).
- The health strip is two columns: TODAY | AWS, CONTAINER | MAC; sparklines sit in the flow,
  never over the numbers.
- Mac-only copy buttons become an "on the Mac" label.
- Home Screen metas: `viewport-fit=cover` with safe-area padding (the header: the top inset plus 8 px on the phone, 12 px on the desktop, so it clears the status bar), `theme-color` per scheme,
  `apple-mobile-web-app-title`, and the radar icon (`web/icon.svg`, Nord; `apple-touch-icon.png` is it at 180 px:
  `rsvg-convert -w 180 -h 180 icon.svg -o apple-touch-icon.png` after an edit). iOS reads them when the icon is
  added, so a re-add picks them up.
- The tab icon is its own radar, `web/favicon.svg`, drawn on a 32 grid with strokes that survive 16 px (a dark rounded
  tile, one bright ring, a sweep, a blip); the Home Screen's detailed one would read as a dark square there. Its PNGs are linked
  before the SVG because Safari's tab skips an SVG icon (it showed a letter monogram): `favicon-32.png` and
  `favicon-64.png` (`rsvg-convert -w 32 -h 32 favicon.svg -o favicon-32.png`, and `-w 64 -h 64`), and `favicon.ico`
  holding both (`convert favicon-32.png favicon-64.png favicon.ico`), which Safari falls back to.

**Proof**: `scripts/board/tower-web-capture.sh <out-dir> [--url <base>]` (under `heavy.sh`) screenshots the
fixtures (or a running server) in Chromium, and the phone sizes in WebKit too, at 440×956 and 390×844 (dpr 3, touch)
and 1512×860, light and dark, plain / stress (every string long, every source off) / empty, and fails on hidden text,
a sideways scroll, a wrapped header, a spark over its numbers, `undefined` on the page, or a Mac-only button on the
phone.

**SOURCES** (collapsed, plus a header chip that also tints the live dot) lists every source with its age and state:
`ok`, `stale`, `failed` (with the error) or `missing`.

- A failed source keeps its last good value and says so; it is never shown empty or green.
- An empty panel whose source isn't ok says "can't tell: …" in red, never "nothing".
- Two failed page polls in a row put a red "tower server unreachable since HH:MM" banner over everything.
- Behind main (above, _Run it_): the chip reads `behind main` (`behind` on the phone, `· N off` when sources are off
  too) and SOURCES carries an amber row with both commits and `pnpm board sync-main`.

Freshness limits (`derive.ts` `STALE`):

| Source        | Stale after                      |
| ------------- | -------------------------------- |
| sampler       | 90 s                             |
| lock caches   | 5 min                            |
| gh            | 3 min                            |
| a PR's checks | 5 min                            |
| queue.json    | 2 h                              |
| a lane file   | amber at 2 h, SLIPPING at 24 h   |
| Mac stats     | 60 s, then silent (red) at 5 min |
| AWS costs     | 3 days                           |

## Lane states

`derive.ts` `laneRow`, first match wins. Truth comes from locks, PRs and runs; the lane file adds the phase, the step
and what the maintainer must do.

| State                                                           | When                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PARKED                                                          | the lane file says `parked`, or the queue's `waitingOn` starts `PARKED`                                                                                                                                                                                                |
| MERGED → DEPLOYING → DONE / DEPLOY FAILED                       | the PR merged; main's `Deploy` push run for its merge sha. A run cancelled by a later merge (deploy.yml's concurrency group) follows the newest later Deploy run, which carries it                                                                                     |
| MERGED (lane file)                                              | the lane file says `merged` or `cleanup` and there's no open PR (none in the newest 40, or a closed one), before the lock check: a finished lane still holding a lock stays off NOW                                                                                    |
| TESTING on dev / devb                                           | the branch holds that slot's live lock. Detail: `deploying` (a running dispatch whose run-name carries its sha), `devcheck running since` (an open ledger run, under 2 h), `held for you: …`, else the step. On a lock read over 5 min old: `TESTING on dev?` with why |
| PR (checks running / no checks seen / checks unknown / draft)   | open PR; the `pull_request` runs for its head sha (newest per workflow). Green is believed only from fresh reads: a failed or stale PR list (its head may have moved) or checks read caps it at `checks unknown`                                                       |
| CHECKS FAILED                                                   | a check ended other than success / skipped / neutral                                                                                                                                                                                                                   |
| MERGE ME / HOLD (reason)                                        | every check green; HOLD when `holdReason` gives one                                                                                                                                                                                                                    |
| BUILDING · WAITING · NEXT FOR DEV · NEEDS YOU · READY · ON dev? | anything else: the lane file's phase and step; with no lane file, the queue's own `state` and its `waitingOn`                                                                                                                                                          |

**The automatic HOLD** (`holdReason`, first match wins). A main merge redeploys dev over a dispatched branch
(CLAUDE.md → _Git workflow_), so:

1. the `dev` lock is unknown: no cache, a failed or stale refresh (over 5 min), an unreadable expiry;
2. another branch holds a live `dev` lock;
3. a devcheck run is open on `dev` (even with the lock lapsed);
4. the runs read is failed, stale or not read yet (`main deploy state unknown`);
5. a dispatch (`deploy-dev <sha> <key>` run-name) is running that is not devb's (below);
6. `devb` is busy (its lock unknown, held by another branch, or a devcheck open on it) and the PR changes devb's
   shape (`cdk/`, `pnpm-lock.yaml`, `packages/shared/src/stage.ts`: `deploy-base.ts` → `SHAPE_PATHS`), or its
   files aren't read yet;
7. a main Deploy run is queued or running;
8. dispatch's `devQueue[].hold` reason, or `dispatch's hold unknown` when queue.json is missing or unreadable, or this lane's entry was dropped (a state or slot the parser doesn't know).

A running dispatch is devb's (rule 6) only when its run-name carries devb's holder sha. Any other may be dev's (a lock
released mid-deploy), so it holds as rule 5. MERGE ME trusts a PR list up to 3 min old; a push inside that window still shows the old head's green
checks until the next poll, and GitHub's required checks are what gate the merge itself. An expired lock, when its cache is fresh, never holds. HOLD is never a NEEDS YOU item. A slot card shows `free`
only for a fresh, free lock; an unknown one says why, in amber. A dev card with no live holder while a dispatch that isn't devb's still runs says `no holder · a dev deploy is running` (orange), matching rule 5, never `free`.

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
tower reads: `devQueue[].hold` and `followups[]` (`id`, `what`, `owner` maintainer|lane|dispatch, `after`, `status`
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
- Its one write is `mktemp` in the board dir, then `mv -fh` (BSD: never follow a link to a directory at the
  target, so a link planted there is replaced, not moved into). Before that, a symlink at the target is removed (rm
  removes the link, not what it points at), and a real directory there is refused.
- A symlinked or missing board dir is refused, with one log line per change.
- The container could also swap the board dir itself for a link between the agent's check and its write. The names
  stay fixed and the content is the agent's own JSON, so the most it can do is put one stats file somewhere the Mac
  user can write.

The worst outcome of a bug is a wrong number on the page. `macstats-fixtures.test.ts` checks this statically, plus
the parse on recorded macOS output (`fixtures/mac/`).

**Install** from the main checkout, `<mac-repo>` (the Mac repo path, from the gitignored `.local/mac-root`; shown in the SessionStart context). It's the mailroom's pattern: GitHub at main's head, read with the mailroom's
Keychain token (Contents: read); `--ref <sha>` installs an unmerged commit after a `[y/N]`:

```
cd <mac-repo> && /bin/bash <(curl -sSf -H @<(printf 'Authorization: Bearer %s\n' "$(security find-generic-password -s aperture-mailroom-gh -w)") -H 'Accept: application/vnd.github.raw+json' 'https://api.github.com/repos/radatta/aperture/contents/tools/macstats/install.sh?ref=main')
```

The same line with ` --uninstall` appended removes it, keeping the last `mac-stats.json`, which the page then shows
stale and then silent. Logs: `~/Library/Logs/aperture-macstats/agent.log`.

## AWS costs

`/workspace/localNotes/costs-daily.json` is the maintainer's `aws ce get-cost-and-usage --granularity DAILY --group-by
LINKED_ACCOUNT,SERVICE` pull, re-pulled on request. The page sums this month's `UnblendedCost`, split dev
(`aws.devAccountId`) and prod (matched by `aws.prodAccountSha256`; the id itself stays out of tracked files). "As of" is the file's mtime and "through" is its last day.
