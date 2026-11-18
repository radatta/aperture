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

| Command                                                    | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `board.sh tower start\|restart\|stop\|status\|version`     | The server, detached (`setsid nohup`). Only the server `start` launches writes `/tmp/aperture-tower.pid`, once the port is bound; "running" means that pid is alive as the tower's node, and the port is the one-server lock. With the pidfile gone (`/tmp` cleaned), the port's listener (`ss -ltnp`), if it is a node running `tower/web/main.ts` without `--fixtures` / `--once`, is the server, and its pid is written back; any other listener (a proof server included) is never claimed, and `start` names it. `APERTURE_TOWER_PORT` moves the port (6183), `APERTURE_TOWER_PID` the pidfile. Log: `localNotes/board/tower.log`. `version` prints the commit the running server started from, which it writes beside its pidfile (`<pidfile>.sha`, `<pid> <sha>`; printed only when that pid is the running server, else empty: unknown); `stop` removes it. `restart` exits with `start`'s status. |
| `pnpm board sync-main`                                     | The main checkout to `origin/main` (fetch, then `git switch --detach`; refuses tracked changes or a checkout on a branch, untracked files are fine), then `board.sh tower restart` only when the tower is running and its served commit differs from the new HEAD in a file the tower runs (`behind.ts` `TOWER_PATHS`: `scripts/src/board`, `scripts/board` and the files they import or read outside them, tests and fixtures excluded; a test holds the list to the import graph) or is unknown. Never starts a stopped tower. Prints what moved and why it restarted or didn't; a rerun is a no-op. Runs from any worktree. The tower check and restart run under their own lock (`/tmp/aperture-tower-restart.lock`, 30 s wait), so two callers at once (the main sync and a `lanes end`) restart it once and the second says not needed.                                                              |
| `board.sh sync start\|restart\|stop\|status\|once\|ensure` | The main sync loop (_Board freshness_ → _Main sync_). `ensure` starts it only for the real board, which `tower start` and the tower's minute tick do.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm board stale [--json]`                                | The tower's last `stale.json`: queue.json's age and each fact it contradicts, with the fix (_Board freshness_).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm board brief`                                         | The tower's last `brief.txt`, verbatim: the status block the hub pastes when the maintainer asks for status (_Board freshness_ → _Derived files_). Past 180 s old it opens `TOWER DOWN: this brief is from HH:MM`; with no file yet it refuses (exit 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `scripts/board/tower-web.sh --once`                        | One View as JSON, no socket (`--fixtures <dir> --now <iso>` for the recorded board; `--no-gh`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The SessionStart hook (`board-session.sh`) starts it when none is running, always from `/workspace`'s main checkout
and never from a worktree. `pnpm lanes start` and `pnpm lanes end` finish with sync-main, and the main sync loop runs
it every 2 min (_Board freshness_), so a merge needs nothing by hand. A stopped
tower comes back within 2 min while the loop runs; else `board.sh tower start`. The page's header shows the commit it serves; when the checkout's HEAD has moved past it in a tower
file (a checkout moved by hand or by a rolled-back `lanes start`, or a sync-main whose restart failed), the sources chip reads "behind main" and
SOURCES says what to run. The server compares on each page poll (HEAD read from the file, `git diff` once per HEAD
move), never on a timer. Only a detached checkout is compared; a tower run by hand from a checkout on a branch shows no chip. It binds `0.0.0.0:6183` (the COI proxy's connect address isn't visible from
inside). It serves read-only routes only: `/`, `/app.js`, `/manifest.webmanifest`, `/api/state` (`?history=1` adds the chart series) and the
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
  A lane whose file carries a step plan shows its steps instead, the current one filling with its time against its
  estimate's high end (amber past it), and, while building, waiting on you or testing on dev, `PR ~HH:MM–HH:MM`
  (amber `PR late · was ~HH:MM` once that has passed with no PR); the bar hides on the phone, the ETA doesn't.
- The page reloads itself when the server restarts on a new commit (its `version`). The page and its script are
  read once, when the server starts (`server.ts`), so they always match the View code it runs.

From the top:

1. **The health strip**, always above the fold at 1512×860. Click a tile for its details.
   - **TODAY**: DONE TODAY's merges (the same day boundary) and how many deployed. It glows when one lands.
   - **CONTAINER**: memory against soft and hard (a last-hour sparkline), CPU, live `test` slots against
     `limits.json`. The slowdown ratio (SESSION-BOARD.md → _History_ → _Slowdown_) is in its details, and on its line
     as "slow ×1.8 lint" once typecheck or lint reaches ×1.5 (amber; ×2 red).
   - **MAC** (below): until `tools/macstats/install.sh` is on `origin/main` it says "installs at merge". A second
     line is the power: "AC 82% charging (0:40 to full) · no thermal limit". It is red, and so is the tile, on Low
     Power Mode, on battery under 20%, on a CPU speed or scheduler limit under 100%, or on a recorded thermal or
     performance warning level that is a number other than 0 (one it can't read shows as "unreadable", not red). The details add the ≤ 3 lanes advice (HUB.md → _The hub's duties_). An
     agent older than the power fields shows no line, never red, and NEEDS YOU carries its reinstall.
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
   - your next step (the first NEEDS YOU item, with how many more; else the first `plan[]` `maintainer` item not
     `done` that is undated, or timed within 2 h of now either way);
   - **NEXT ASK**: when the maintainer is next asked for something, `~HH:MM–HH:MM` — the earliest of a NOW lane's
     PR window (its lane file's `eta.pr`, while it has no open PR; `late` once that window has passed) and the next
     `maintainer` or `merge` plan row not done and not past (over its lane's ETA window when it slips; `late` once
     that has passed too); one still ahead before a late one, which would otherwise hide it (`nextAsk()` in
     `plan.ts`). The strip's NEXT chip says `ask ~HH:MM`, `ask now` once the window has begun, or `ask late`;
   - the merge queue (MERGE ME and HOLD, with the reason) not already in the landing order;
   - the plan's next rows not `done` (up to 3, leaving out the rows YOU NEXT and NEXT ASK show; one past due over 2 h drops off unless it
     slips), each `HH:MM · what` with what it costs you (`you: 2 min`) and an amber `now HH:MM` slip or `late`;
   - the landing order (`queue.json` `mergeOrder`), numbered, each lane as it stands (building, PR, HOLD…, or NOT
     STARTED with no lane file, queue entry or PR; such a lane shows here only, never in NOW). An entry whose PR
     merged (in the PR list's newest 40) or whose row is merged / deploying drops out;
   - the dev order per slot (`devQueue` `next` / `waiting`): a different order from the landing order, so a lane
     can show in both;
   - **QUEUED**: dispatch's `autoStart` lanes not started yet (no lane file, no open PR), by `order`, then p0 before
     p1, then file order (`queued.ts`). Each is `ready`, `after <lane>` (an `after` lane still in `devQueue` or
     `autoStart`) or held (a note starting `LOW` or `HOLD`): the rule `pace-watch.sh`'s exit 6 starts them by, which a
     test holds the two to. The glance folds them into one `QUEUED n · k ready: <lanes>` row; expanded, a _Queued to
     start_ group, one row each;
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
   - lanes whose file hasn't moved in a day;
   - **BOARD** rows first: each queue.json fact the tower contradicts, with its fix in the details (_Board
     freshness_; the STALE follow-ups above are among its items, listed once). A "board: can't tell all" line says
     which source was too old to check. The title's count includes them, and so does the strip's SLIPPING chip.

### Expand

Any panel opens full screen with everything in it (the maintainer, 2026-11-16: the glance stays the default). Tap
NEEDS YOU, NOW, NEXT or DONE's title, or press `1`–`6` (needs, now, next, done, slipping, sources; SLIPPING's and
SOURCES' titles still fold them). The URL hash names the open panel (`#next`), so the 5 s poll, a reload and the
version reload all keep it. A poll never moves the scroll; a reload restores it (`sessionStorage`, per panel; none in
a private window, so it starts at the top). Esc, the strip's ✕, the same key again or Back closes it, back to where
the glance was: the first open pushes a history entry and a switch replaces it, so one Back closes; a page opened
straight at `#next` closes in place. A key with ⌘, Ctrl or ⌥ held does nothing; an unknown hash is the glance.

- HEALTH and the other panels hide; a sticky strip on top keeps ✕, the open panel's name and a chip per other panel
  with its headline number (`View.heads`: NEEDS `3`, NOW `4 lanes`, NEXT `ask ~19:40` or `n to land`, DONE `5`,
  SLIPPING `2`, SOURCES `ok` / `2 off`); a chip switches to that panel. On the phone it's a full-screen sheet, the
  strip scrolling sideways inside itself and sticking below the status bar (the header's installed floor, under _Phone_,
  holds for it too).
- Every row opens with its full text and details, and nothing is capped (`+n more` is gone); a tap folds one. What
  was open on the glance is open again when it closes.
- **NEXT** expanded: YOU NEXT and NEXT ASK, then the **plan table** — Time | What | You for every `plan[]` row, with
  `→ HH:MM–HH:MM` and `measured` / `guess` under a row's time when it has an `eta`, a red now-line before the first
  row still ahead, `done` rows struck with `est HH:MM · actual HH:MM (+n min)`, a slipping row amber with `now HH:MM`
  (its lane's ETA) or `late` (past due, nothing to say when), and dispatch's `planNotes` below; its head says `as of
planAt`, amber past 6 h. Then the landing order, the merge queue, every NEEDS YOU item, the dev order per slot,
  PARKED.
- A row's marks (`plan.ts`, from `queue.json` and the lane files): **struck** when `done`, or a `merge` row whose
  `lane`'s PR merged (actual = its merge time). **Slipping** when it isn't done, names a `lane` with no open PR, and
  that lane's ETA ends after the row's due (`eta.to`, else `at`): a `merge` row against the lane's `eta.pr`, any
  other against `eta.next`, else `eta.pr`. **Late** when its due has passed and no slip is still ahead: none, or
  the lane's ETA has passed too (the lane went quiet).
- **NOW** rows carry their lane's step bar and `PR ~HH:MM–HH:MM` (_Lane files_), and est vs actual per step in their
  details.
- Not yet: a lane's last checkpoint and decisions tail, and the machine (charts) view; the header's charts toggle
  covers the latter on the glance (with a panel open, LOAD hides with the rest). The header's sources chip, with a
  panel open, opens SOURCES.

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
  the app's `apple-mobile-web-app-capable` = `yes` and `apple-mobile-web-app-status-bar-style` = `black-translucent`,
  `apple-mobile-web-app-title`, and the radar icon (`web/icon.svg`, Nord; `apple-touch-icon.png` is it at 180 px:
  `rsvg-convert -w 180 -h 180 icon.svg -o apple-touch-icon.png` after an edit). iOS reads them only when the icon is
  added: **after a change to them merges, remove the Home Screen icon and add it again.** Installed and upright on the
  phone (`display-mode` standalone, or fullscreen, which iOS may report instead), the header's top inset is floored at
  62 px, a Dynamic Island phone's, because iOS 26 can report 0 there (WebKit bug 301994). A Home Screen site with no
  manifest still opens as a web app on iOS 26, and with the floor in place its header still sat under the bar
  (2026-11-16), as on other manifest-less sites while the Aperture app cleared it: so the page links
  `/manifest.webmanifest` (`web/manifest.webmanifest`: `display` standalone, scope `/`, Nord, the radar icons), and
  `app.js` also marks the page `installed` when `navigator.standalone` is true or the query matches, which applies the
  same floor upright. Which of the two fixed it is unverified. The header still sat under the bar on the phone
  (F161, parked 2026-11-16); before any more CSS, read what the phone reports: open the readout with five taps
  within 3 s on SOURCES' "serving …" line, or `?debug=1`, and a tap on it closes it. It lists the `display-mode`
  queries that match, `navigator.standalone`, the `installed` class, the measured `env(safe-area-inset-top/bottom)`,
  the header's padding and box, the viewport and screen, and the UA. It is read-only, the page's only, and the
  capture checks it per engine. **After this merges, remove the tower's Home Screen icon
  and add it again.**
- The tab icon is its own radar, `web/favicon.svg`, drawn on a 32 grid with strokes that survive 16 px (no tile: the
  dial, a sweep and a blip in mid-tones that read on light and dark tab bars); the Home Screen's detailed one would
  read as a dark square there. No tile because macOS Safari draws a light plate behind a tab icon it judges
  low-contrast on its dark bar (WebKit bug 309949), which a dark tile got; the maintainer picked this one of two
  trial variants in real Safari (2026-11-16). Its PNGs are linked before the SVG because Safari's tab skips an SVG
  icon (it showed a letter monogram): `favicon-32.png` and `favicon-64.png`
  (`rsvg-convert -w 32 -h 32 favicon.svg -o favicon-32.png`, and `-w 64 -h 64`), and `favicon.ico` holding both
  (`convert favicon-32.png favicon-64.png favicon.ico`), linked too, which Safari falls back to. The touch icon's
  link comes after the tab icons', so the tab never settles on the opaque 180 px radar. Safari caches a tab icon per
  page URL: a Private window shows a new one fresh.

**Proof**: `scripts/board/tower-web-capture.sh <out-dir> [--url <base>]` (under `heavy.sh`) screenshots the
fixtures (or a running server) in Chromium, and the phone sizes in WebKit too, at 440×956 and 390×844 (dpr 3, touch)
and 1512×860, light and dark, plain / stress (every string long, every source off) / empty, and expanded (`xnext`,
`xneeds`, and `xstress` at `#next`), and fails on hidden text, a sideways scroll, a wrapped header, a spark over its
numbers, `undefined` on the page, or a Mac-only button on the phone; an expanded frame also fails without the strip's
five chips, with HEALTH or another panel showing, and (NEXT) without a struck row, a slip marker and the now-line. One
pass per engine then drives the expand at 390 px: a title tap, a poll (scroll kept), a reload (panel and scroll
kept), Esc, keys `3` `2` `2` `1`, Back, a modified key, `#zzz`, Esc on a page opened at `#next`, and a slot card
opened on the glance still open after.
Three more frames per engine at 440 check the status-bar floor: nothing here emulates `display-mode` (Playwright
has no option, Chromium ignores it over CDP), so the installed frame is served the page with the floor's
`display-mode` terms dropped, and the flagged frame the page as served with `navigator.standalone` true (the
`installed` class's path); both must clear 62 px, and an expanded panel's strip must stick below 62 px in both. The
page as served keeps its own 8 px.

**SOURCES** (collapsed, plus a header chip that also tints the live dot) lists every source with its age and state:
`ok`, `stale`, `failed` (with the error) or `missing`. `gh PRs` says how many fork PRs it dropped from the newest 40
(`n fork PRs dropped of the newest 40`), so a window eaten by forks shows.

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
| main sync     | 7 min                            |
| ctx.json      | 5 min (then it counts nothing)   |
| a lane file   | amber at 2 h, SLIPPING at 24 h   |
| Mac stats     | 60 s, then silent (red) at 5 min |
| AWS costs     | 3 days                           |

## Board freshness

Dispatch hand-writes `queue.json`; the tower works facts out for itself, and where the two disagree the derived fact
shows and the hand-written one becomes a **stale item** for dispatch to fix. Nothing here writes `queue.json`: dispatch
stays its only writer. Merged truth comes from gh's newest 40 plus main's own log (`mergelog.ts`: squash subjects end
`(#N)`, `git log origin/main --first-parent -n 400`, read at most once a minute), so a PR any board record names reads
merged past gh's window and while gh fails.

What the tower derives over the hand-written fields:

- A merged PR beats a `PARKED` word (the queue's or a lane file's).
- A `merge` plan row is struck once its lane's PR merged, or every `PR <n>` its text names has (at least one; text
  like "Merge G" is never struck by a guess).
- The dev order (`devQueue` `next` / `waiting`) drops a lane holding a slot or merged, whatever its state says.
- A reused branch name: a lane file that began its phase after the branch's last merge, without naming that PR, is the
  new lane, not DONE (`prFor`).
- A lane's session: its lane file's, then the live registry's, then the queue's.

**Stale items** (`stale.ts`), one per contradiction, each with `since` (when the derived fact became true, when known):

| Kind           | When                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue-merged` | a `devQueue` lane whose PR merged (nothing else is said about it)                                                                                       |
| `queue-state`  | `on-dev` with no slot holding it, or holding one while not `on-dev`; `waiting`/`next`/`building` with an open non-draft PR; `pr-open`/`ready` with none |
| `queue-pr`     | its `pr` isn't its open PR                                                                                                                              |
| `waiting-on`   | a `waitingOn` naming a merge that has happened (`<branch> merges`, `PR <n>`: the follow-ups' exact shapes; never a date)                                |
| `plan-done`    | a plan row the tower struck that dispatch hasn't marked                                                                                                 |
| `plan-age`     | `planAt` over 6 h old, or missing, with a row not done                                                                                                  |
| `merge-order`  | a `mergeOrder` entry that landed                                                                                                                        |
| `wave`         | a wave item not `merged` whose PR merged                                                                                                                |
| `auto-start`   | an `autoStart` lane that has a lane file (or an open PR)                                                                                                |
| `orphan-lane`  | a lane file over a day past its merge: `pnpm lanes end <branch>`                                                                                        |
| `followup`     | a STALE follow-up (as SLIPPING's)                                                                                                                       |
| `queue-bad`    | the file has problems: the first, and how many more                                                                                                     |

A lock fact counts only from a fresh lock read and an open-PR fact only from a fresh PR list; a merge is final and
always counts. A branch name gets reused, so a merge known only by its branch name (no PR number, no lane file
begun after it) counts only while under a day old (`mergelog.ts` `REUSE_MS`); a follow-up's branch trigger counts a
merge from a day before it was written on. When either is stale the count reads `n?` and says which.

**Tone**, one for the age and the count: red when the main sync failed or went silent (7 min: a round's 240 s and its 2 min nap), at 5 items, or when
one has sat 30 min; amber with any item or an unsure count; else dim. A STALE follow-up is a judgment backlog, not a
wrong fact: it never makes it red. "Board updated" is `queue.json`'s own `updatedAt`.

**Where it shows.** The desktop header's chip, `board 12m · 3 stale` (a click opens SLIPPING), with `pnpm usage line`
beside it (the tower runs `usage line --no-scan` every 5 min: `docs/ops/USAGE-METER.md`). The phone has no room for a
third header button at 390 px, so its sources chip carries the first two of `behind`, `n stale`, `n off`, in the
worse tone. SLIPPING's BOARD rows; SOURCES' `main sync` row. Context per session shares the header and the status line (below).

**Derived files.** The board's own tower (started by `board.sh`, never a fixtures or `--once` server) writes three files
beside `queue.json` every 30 s, tmp + rename:

- `stale.json`: `{v, t, updatedAt, items, unsure, tone, why}`, which `pnpm board stale` prints;
- `board.line`, one fact per line, for the status line:

  ```
  <writtenEpoch> <boardEpoch|-> <count>[?] <tone>
  merge <atEpoch> <HH:MM> <what>    the next merge row not done (derived), due no more than 2 h ago
  usage <atEpoch> <text>            pnpm usage line's last good answer
  ctx <n≥40> <n≥50> <names≥50|->    sessions over the context lines (_Context per session_)
  slow <ok|warn|bad> <text>         the slowdown's status line cut, in the CONTAINER tile's tone
  mac <l1> <l5> <l15> <cpus>        the Mac's load averages, whole numbers; only from a fresh mac-stats.json
  vm <cores>                        the container's cores, for the live /proc/loadavg the status line reads
  ```

  Text fields are one line with no control bytes (every session's terminal prints them); a ctx name's spaces and
  commas become `_`.

- `brief.txt`, which `pnpm board brief` prints (`brief.ts`): one fixed block, every heading always there in this
  order, with `none` or `unknown` written out (gh unreachable reads `MERGE unknown (gh PRs …)`, never `none`).
  Board text is one line, control bytes out, capped. A new line is one more entry in `SECTIONS`.

  ```
  BRIEF 13:42 · board 4m · 2 stale · tower c5797521
  LANES 5 · 2 building · 1 testing · 1 pr · 1 merge me     then one row per NOW lane: state, PR or its PR window, ctx ≥ 40
  SLOTS dev <lane> until 14:05 · devb free
  MERGE 1 · PR 231 <lane> "<title>"                         MERGE ME, then HOLD with its reason
  QUEUED 12 · 3 ready · 5 held                              then the first 5 (QUEUED above), +n more
  ASK ~14:10–14:30 <what>                                   NEXT ASK
  NEEDS 3 · <first item> (+2)
  USAGE 53% · 9.6%/h · ~4.8 h to 100% (13:40)               pnpm usage line, with when it was read
  MAC AC 79% charging … · load 8.2 11.0 12.1 /12            the Mac line (Low Power and battery as RED:) and load
  VM anon 6.2G/18.0G · cpu 3.1/9 · slow <slowdown line>
  BUDGET jobs 3.8/6.5 · lanes 2.6/4.5 · sessions 12/14 · k 1 ac (log-only)   SESSION-BOARD.md → Budget; unknown on a read error
  CTX ≥50 <session> 78% · ≥40 <session> 41%
  ```

**Status line.** `scripts/board/statusline-board.sh` (builtins only, sourced by `statusline-snippet.sh`) prints
`· mac 6 8 12/12 · vm 2 5 9/9 · slow 30m tc×1.2 gl×1.0 gn– gw×1.1 · lint no data since 16:58 · usage … · board 12m ·
3 stale · next ~19:40 <what>`, the next merge last with `?` once its time has passed, the usage part only while under 15 min old. `vm` is
the container's live `/proc/loadavg` (1, 5, 15 min) over its cores; `slow` is the slowdown's cut (SESSION-BOARD.md →
_History_ → _Slowdown_), dim, amber or red. A `board.line` over 3 min old prints `vm` and red `tower down`, nothing
else; a missing or garbled one, `vm` alone (with its core count only if the `vm` row survived). It replaces dispatch's `localNotes/board/next-merge.sh`, which read `plan[]` raw, and
`localNotes/board/slowdown-line.sh`, which spawned node from the status line (F293): while that file is still in the
board dir it prints `mac`, `vm` and `slow` itself, so this leaves them out. So the hand-over is renaming that file;
the sourcing line in `~/.claude/statusline-command.sh` is then a no-op, deleted after the rename, never before.

### Context per session

Dispatch's `context-watch.sh` writes `localNotes/board/ctx.json` every minute (`[{name, ts, tokens, pct}]`, `pct` of
1M tokens); `ctx.ts` reads it, its mtime as its time. Each NOW row and slot card shows its session's `ctx N%`, amber at
40 and red at 50. The desktop header counts them (`ctx ≥50 lc-catalog 78% · 3 ≥40`; more than one over 50 is `×n`,
every name in the tooltip); on the phone a session over 50 leads the sources chip (`1 ctx≥50`) and one over 40 follows
the board's count. `board.line`'s `ctx` line gives the status line the same, red with the names at 50. A `ctx.json` over 5 min old counts nothing and SOURCES says so. The phone alert stays dispatch's: the
tower never pings.

### Conflicts

`Source` reads `localNotes/board/overlap.json`'s merge-tree `conflicts` (SESSION-BOARD.md → _Overlaps_, the check
itself), so the terminal and the page share one read. A lane git can't merge with main or with another lane is
marked, amber, as a warning only: it never changes the lane's state, its tone or NEEDS YOU, and never turns anything
red.

- **Terminal:** the SESSIONS row's branch ends `✗main` (against main) and `✗N` (against N other lanes); the branch
  is cut first, and the mark becomes a bare `✗` when the full one would leave the branch under 4 columns.
- **Page:** a lane's chip, `✗ main, <lane>` (two names, then `+n`), is the first meta of its row wherever a lane row
  shows (NOW, and NEXT's merge queue and landing order) and follows the holder on a dev slot card. Each target's files
  are in its tooltip and, for phones, in the details (`conflicts with main: …`). It wraps on a phone rather than
  overflow.
- **Old:** from 10 min (the file's own `t`; `board.sh` uses the same line) the mark dims and the first detail line
  adds `(N min old: is the sampler running?)`. Nothing is hidden: an old conflict is still likely real.
- **No file,** or one written before the check (no `conflicts` list), shows nothing; one that isn't JSON (a torn
  read) keeps the last list, and an entry with no files is dropped. The fixture board's `overlap.json` puts
  bravo-branch (the dev slot's holder) against main and charlie-branch, and echo-branch (a NOW row) against main.

### Main sync

`scripts/board/sync.sh`, a plain bash loop with no tokens: every 2 min `cli.ts sync-main` (fetch, move the main
checkout when clean, restart the tower only when its code changed), then `board.sh tower start` if the tower is
down. It writes `localNotes/board/main-sync.json` (`{v, t, pid, ok, head, msg}`) every round and appends to
`main-sync.log` only what moved, restarted, started or failed. A round waits 20 s at most for the main checkout's lock
(busy: the next round tries) and is killed past 240 s, above all it waits for, so the kill is for a hang, never a slow
`git switch`; it runs with no inherited `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE`.

- **One per container:** `flock` on `/tmp/aperture-main-sync.lock` (waited 5 s, as the sampler's), pid in
  `/tmp/aperture-main-sync.pid`; no child keeps the lock fd. `board.sh sync stop` kills that pid only, and only when
  it is bash running `sync.sh` with the lock file open on fd 8; it waits out the round in flight (bash runs the TERM
  trap after it), so a stop or restart can take up to 4 min.
- **Always main's code:** `board.sh sync start` runs the main checkout's `sync.sh` from any worktree (none there:
  nothing starts; a worktree's copy would outlive its worktree), and the loop re-execs itself (same pid, same lock,
  kept by the open fd, a `re-exec` log line) when `sync.sh` or `lib.sh` changes on disk. It exits once its own script
  is gone.
- **Kept alive:** `board.sh tower start` (so the SessionStart hook, after a container restart; it waits 1 s for the
  loop, the hook's budget) and the tower's minute tick, on a heartbeat over 7 min old or missing, run
  `board.sh sync ensure`, which starts it only for the real board
  (`BOARD_DIR` the default; a test's temp board never does; `APERTURE_SYNC=on|off` overrides).
- It pins `INIT_CWD` to its own checkout: sync-main finds the checkout from it.
- **The merge record** (`merge-record.ts`): after the fetch, under the main-checkout lock, each squash merge (`(#N)`
  subject) on `origin/main`'s first-parent line since `<board>/merge-seen` is appended to
  `history/events-<UTC day>.jsonl` as `{v: 1, t, kind: "merged", pr, sha, mergedAt, title}` (title cleaned, ≤ 120),
  oldest first, and the round's output says `merged: PR <n> (<sha7>)`. The rows go before the baseline moves, so a
  crash repeats a row rather than losing one (`merge-watch.sh` dedupes by sha). A missing or malformed `merge-seen`,
  or one `origin/main` no longer descends from (git's exit 1; any other git error keeps the baseline and says so), only sets the baseline: nothing is back-filled. A failed record never
  fails the round (`merge log: <error>`, the baseline holds). The hub wakes on it through `merge-watch.sh`
  (`docs/ops/SESSION-BOARD.md` → _Watchers_).

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
| PR (opened)                                                     | no lane file, and the queue says `pr-open` (the PR is open, its checks not green yet) before the PR list shows it; once it does, the PR rows above win                                                                                                                 |

**The automatic HOLD** (`holdReason`, first match wins). A main merge used to redeploy dev over a dispatched branch;
it now waits for the slot's lock (CI-BOT.md → _Dev deploys_ → _A merge waits for the lock_), so a HOLD below costs only
time — the rules stay until that wait has been seen working on main (a follow-up relaxes them):

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
phase change (FEATURE-WORKFLOW.md → _Lane status and checkpoints_), from its worktree:

```
pnpm board lane <phase> [--step <text>] [--pr <n>] [--slot dev|devb] [--session <name>]
                [--needs <what> (--link <https url> | --cmd <one-line Mac command>) [--unblocks <text>]]
                [--plan <step>=<lo>-<hi>[?],…] [--files <n>] [--eta-next <lo>-<hi>[?]] [--eta-pr <lo>-<hi>[?]]
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
- **The step plan** (`--plan`, at Plan's end, again whenever the estimates move): each step of
  `plan build gate review local dev pr` the lane will run, with its range in minutes from measured board history
  (`heavy.sh` records, archived lanes' estimate-vs-actual), which the lane scales by its file count itself (`--files`
  records the count beside them); a trailing `?` marks
  a guess, e.g. `--plan build=60-90,gate=3-6,review=40-70,pr=10-20? --files 37`. It carries across writes until
  replaced (a new one keeps each step's time so far). At each phase change the time in the phase just left accrues to
  its step (`spentMs`; `parked` and `blocked` count to none), so est vs actual records itself.
- **The ETAs** follow from it at every write: `next` is now plus the current step's range less its time so far
  (never before now), `pr` that plus every later step through `pr`; one `source` for both, `guess` when any step
  behind the PR ETA is. Past `pr`
  there are none. `--eta-next` / `--eta-pr` (minutes from now, `?` a guess) set one directly instead. No plan and no
  flag: no ETA (a stale one is worse than none). The echo ends `· PR ~HH:MM–HH:MM`.
- A malformed `plan`, `eta` or `files` reads as absent, never a problem row: the lane looks as it did before them.

```json
{
  "v": 1,
  "branch": "tower-web",
  "session": "auto-6",
  "phase": "review",
  "step": "round 1 (4 lenses)",
  "phaseSince": "…Z",
  "sha": "<40 hex>",
  "pr": null,
  "slot": null,
  "needs": { "what": "…", "link": "https://…", "cmd": null, "unblocks": "…" },
  "updatedAt": "…Z",
  "files": 37,
  "plan": [{ "phase": "build", "lo": 60, "hi": 90, "source": "measured | guess", "spentMs": 0 }],
  "eta": {
    "next": { "lo": "…Z", "hi": "…Z" },
    "pr": { "lo": "…Z", "hi": "…Z" },
    "source": "measured | guess"
  }
}
```

Dispatch writes only intent, in `queue.json` (schema: SESSION-BOARD.md → _Control tower_; the plan table's `you`,
`eta`, `lane`, `done`, `planAt` and `planNotes` among it), plus two keys the web tower reads: `devQueue[].hold` and `followups[]` (`id`, `what`, `owner` maintainer|lane|dispatch, `after`, `status`
open|tracked|done|dropped, `source`, `since`).

## Mac stats

A launchd agent on the Mac, `dev.rahuldatta.aperture.macstats` (`tools/macstats/`). It is not a mailroom job: the
mailroom's runner is serial and runs in the container→Mac direction. Every 15 s it runs `vm_stat`, `sysctl` and `ps`
and `pmset -g batt`, `pmset -g` and `pmset -g therm` (none needs sudo), and writes
`<main checkout>/localNotes/board/mac-stats.json`:

```json
{ "v": 1, "t": "…Z", "host": "…", "agentVersion": "<sha256 of macstats.sh>", "memTotalMiB": 36864,
  "mem": { "freeMiB": …, "activeMiB": …, "inactiveMiB": …, "wiredMiB": …, "compressedMiB": …, "usedMiB": …,
           "freePct": …, "pressure": "normal|warn|critical" },
  "swap": { "totalMiB": …, "usedMiB": … }, "load": [1, 5, 15], "cpus": 12,
  "vm": { "pid": …, "comm": "com.apple.Virtualization.VirtualMachine", "rssMiB": … },
  "power": { "source": "ac|battery|ups|null", "batteryPct": 12, "state": "charging", "remainingMin": 542,
             "lowPowerMode": false,
             "thermal": { "warningLevel": null, "performanceWarningLevel": null, "cpuSpeedLimit": null,
                          "cpuSchedulerLimit": null, "cpuAvailableCpus": null } } }
```

- `usedMiB` is active + wired + compressor.
- `freeMiB` is free + speculative.
- `vm` is the largest resident process named like a hypervisor (`Virtualization`, `limactl`, `qemu`, `vfkit`,
  `krunkit`), or `null`.
- `power` (F120): from `pmset -g batt`'s `Now drawing from 'AC Power'` / `'Battery Power'` and its
  `-InternalBattery-0 (id=…)<tab>12%; charging; 9:02 remaining present: true` line. `state` is `charging`,
  `discharging`, `charged`, `finishing` (finishing charge) or `not-charging` (`AC attached; not charging`).
  `remainingMin` is to full on AC and to empty on battery, and null for `(no estimate)`. The battery id is never
  written. `lowPowerMode` is `pmset -g`'s `lowpowermode 0|1`, else `powermode 0|1|2` (a Mac with High Power Mode; 1 is low); neither readable shows "Low Power Mode unknown" on the line, never a silent off. `thermal` is `pmset -g therm`: a `Note: No … has been
recorded` line is null, `CPU_Speed_Limit = 80` a number, and a recorded level that isn't a number `"recorded"`.
  Anything pmset doesn't print is null, so a desktop Mac or a pmset failure is nulls, never a failed tick. `v` stays
  1 (the key is additive): a key-less file is an older agent.
- Only the battery line, Low Power Mode and the "No … recorded" notes are seen in real output. The recorded-level
  layout and an Apple-silicon `CPU_Speed_Limit` are from Intel-era reports (2026-11-17 search), so a level that
  isn't a number shows as "unreadable" on the line, never red on a guess, and never fails a tick.

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
