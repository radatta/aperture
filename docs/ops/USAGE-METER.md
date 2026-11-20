# Usage meter — what agent work costs against the weekly limit

The account's Claude usage limit shows only as a weekly **percent**. This turns that into a cost model, bottom-up:
token counts per model call → **quota units (QU)** → lane phases → merged PRs → per PR type. A single fitted factor
**k** converts QU to meter percent at the end. Method and sources: the 11-17 research panel (`localNotes/research/`).
Code: `scripts/src/usage/`. Data: the gitignored `localNotes/usage/`, never a tracked file. The repo is public, so
real numbers, costs and session ids stay out of tracked text; fixtures are synthetic.

```
status line ─► statusline-log.sh ─► meter-<day>.jsonl ─► k (fit)
~/.claude/projects/**.jsonl ─► scan ─► cache/shards ─► phases ─► PR table
board/lanes/*.json ─► phase-log.sh ─► phase-log.jsonl ─► phases
PR table ─► per PR type · work units ─► estimate + backtest · k turns QU into %
```

## Commands

| Command                                                                             | Does                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm usage report [--since YYYY-MM-DD] [--refresh]`                                | Scans, then prints the full model and writes `localNotes/usage/report-<day>.md`. `--since` defaults to 2026-11-04; `--refresh` refetches merged PRs.                                                                          |
| `pnpm usage fit`                                                                    | Only k, its interval, the holdout and the burn rate.                                                                                                                                                                          |
| `pnpm usage line`                                                                   | One line: `usage <n>% · <r>%/h · ~<h> h to 100%`. Not wired into the status line or tower yet (a follow-up).                                                                                                                  |
| `pnpm usage burn [--at <HH:MM>]`                                                    | The hub's `/burn`: usage now, and where it lands at the weekly reset and at HH:MM, low–high: k's 80% interval × the last hour's QU (+ λ), widened to hold the meter's tick rate (`burn.ts`). Scans first, unless `--no-scan`. |
| `pnpm usage estimate --lines <n> [--ui] [--lenses <a,b,…>] [--fanout <n>] [--scan]` | A task's QU and meter %, low–high, from what is known before the work (_Estimate_). Offline: the cache and `cache/prs.json` as they are; `--scan` scans first.                                                                |
| `pnpm usage scan [--rate <MB/s>]`                                                   | Only the transcript scan (default 40, at most 60).                                                                                                                                                                            |
| `pnpm usage doctor`                                                                 | Is the logger installed and writing? Exit 1 with the fix otherwise.                                                                                                                                                           |

`--no-scan` on report, fit and line skips the scan. `-h` on any command prints its usage and runs nothing. `--since`
is midnight Pacific on that day, in its own offset.

Paths come from the environment, defaults in brackets: `APERTURE_USAGE_DIR` (`/workspace/localNotes/usage`),
`APERTURE_USAGE_PROJECTS` (`~/.claude/projects`), `APERTURE_CLAUDE_DIR` (`~/.claude`, for `doctor`),
`APERTURE_LANE_ARCHIVE` (`/workspace/localNotes/archive`), `APERTURE_BOARD_DIR` (`/workspace/localNotes/board`) and
`APERTURE_CGROUP_DIR` (`/sys/fs/cgroup`, for the memory guard).

## Units

A call's **QU** is its tokens priced at API list prices, **1 QU = $1**: input, 5-minute and 1-hour cache writes,
cache reads and output each at their own per-model rate (`prices.ts`, from the platform pricing page). This is the
same scale as the status line's `cost.total_cost_usd`, so the two cross-check. Fast mode is ×2; Haiku 5.5 moves to its
long-prompt tier past 100k prompt tokens; an unknown model is priced as Opus 5.5 and flagged in the report. The
weights are pinned at price ratios: the research found too few meter intervals to fit them freely.

## The meter log

`scripts/usage/statusline-log.sh` is sourced by the status-line script with `$input` set to the status-line JSON. Per
session it appends at most one row per 30 s, plus one whenever the weekly percent moved, to
`localNotes/usage/meter-<local day>.jsonl`: `ts`, `sid`, `name`, `cwd`, `branch`, `pr`, `agent`, `model`, `cost`
(the session's cumulative list-price USD), `rl` (`rate_limits`), `cache`, `ctx`, `tp`, `v` (Claude Code's version) and
`lv` (the row format, 1). It prints nothing and ignores every failure. `APERTURE_USAGE_DIR`, `APERTURE_USAGE_STAMP_DIR`
and `APERTURE_USAGE_MIN_SEC` override the dir, the throttle stamp dir (`/tmp`) and the 30 s.

What the log showed on this plan (checked 11-17): `used_percentage` is a whole number, and only `seven_day` is
present — no `five_hour`.

### Install

1. **The sourcing line**, at the end of `~/.claude/statusline-command.sh` (the maintainer's file; a change to it is
   theirs to make):

   ```bash
   for _s in /workspace/scripts/usage/statusline-log.sh /workspace/localNotes/usage/statusline-log.sh; do [ -r "$_s" ] && { . "$_s"; break; }; done; unset _s
   ```

   The repo copy wins; the older `localNotes` copy is the fallback, so there is one writer and never a gap. The
   script file lives in `~/.claude`, which survives a container restart.

2. **After a COI restart, check the `statusLine` key** in `~/.claude/settings.json`. The re-seed has dropped it
   before (COI-SANDBOX.md → _Gotchas_), and then nothing logs. `pnpm usage doctor` says so. The restore that worked:
   `jq -s '(.[0]|del(.hooks)) * .[1]' ~/.claude/settings.json /workspace/localNotes/claude-user-settings.mac.json`.

3. **`pnpm usage doctor`** checks all three: the key, the sourcing line, a meter row under 10 min old.

**Undo:** delete the sourcing line. The data stays; the `/tmp/aperture-usage-stamp-*` files are throwaway.

## Scan

The transcript store sits on the container's root disk, and COI pauses the container when reads pass about 250 MB/s
(COI-INCIDENTS.md). So `scan` reads one file at a time through a token bucket (`throttle.ts`, 40 MB/s by default,
60 at most), never greps the store, and only ever opens `*.jsonl` transcripts and their `*.meta.json`:

- `<project>/<sid>.jsonl` (main), `<sid>/subagents/agent-<id>.jsonl` (subagent),
  `<sid>/subagents/workflows/wf_<w>/agent-<id>.jsonl` (workflow agent). `journal.jsonl`, `tool-results/` and the rest
  are skipped.
- Only `assistant`, `custom-title` and `agent-name` rows are parsed; the rest are skipped on a byte search.
- **Dedupe:** one request is logged on 2–10 rows. Calls are keyed by message id (else request id) with each token
  field's max. Input and cache counts are exact; output is a lower bound whichever row is kept. A message id seen in
  two files is counted once: owned by the file whose session wrote the row (a forked copy carries the original's
  `sessionId`, unverified on a real fork), then by a subagent's own file over its parent's, then by the earlier
  sighting.
- **Markers:** each call's tool uses become enum-only markers for the phases: an explicit `pnpm board lane <phase>`
  (`ready` read as `local`, as the CLI writes it), every agent spawn with its type (Plan and `code-reviewer` also as
  their own kinds), a source/test/docs/notes edit, a full `pnpm typecheck|lint|test` (no file argument, no
  `-C`/`--dir`: that is one package's) or `pnpm gate:fast` (its flags allowed, `--dry-run` and `--help` not: they run
  nothing), `devcheck:local`, `devcheck`, `bot push|deploy-dev`, `mailroom open-pr`, `git commit`. pnpm's own
  options before the script name (`-s`, `--silent`, `-w`, `-C <dir>`, `--dir`) are allowed: lanes run
  `pnpm -s board lane …`, which the parser missed before 2026-11-19, so lanes that had written their phases looked
  like they never left plan.
  A command counts only at command position (line start, after `&&`/`;`/`|`, env assignments or `heavy.sh --`), so a
  grep or echo of one doesn't; a quoted string that itself contains `; pnpm …` still can. Each marker keeps its
  tool-use id. The cache
  keeps no command text or content; per transcript it keeps its relative path, its first row's cwd and the session
  name (pattern-checked).
- **Cache** (`localNotes/usage/cache/`): one shard per transcript file, plus `index.json` with each file's size,
  mtime, inode and the byte offset of its last complete line. An unchanged file is skipped, a grown one resumes from
  its offset (a torn last line waits for the next run), and a shrunk or replaced one is reread. A change to what
  `transcript.ts` extracts bumps `PARSER` in `store.ts`, and the next scan rereads everything.
- Before a file over 100 MB it waits while the container's anon memory is over 10 GiB, then gives up loudly.

A first full scan of about 3 GB takes under 2 minutes; later ones read only what was appended.

## Meter

Each session's `rate_limits` comes from its own last API response, so an idle session keeps logging an old
percent. A reading counts only on a row where that session's percent or cost moved (**fresh**), and never on a
session's first row. The account meter is the **newest change** across sessions, as a running max — never an
average. A new window starts when `resets_at` moves by over an hour, or a fresh reading falls 10+ below the max (a
manual reset may leave `resets_at` alone). Within a window, **tick n** is the first time the meter reaches n; tick to
tick, ΔP is exact.

History comes from `localNotes/usage/manual-readings.json`: `{ readings: [{ at, pct, approx? }], resets: [at] }`,
`at` as ISO with offset. A manual reading counts as ±½ point (variance 1/12, or 1/3 if `approx`); a reset is an exact
zero. The weekly resets that `resets_at` implies are added to the history's resets, so no interval spans one. The oldest
`resets_at` in the log steps back 7 days at a time to the first manual reading. Each later value marks its own
window's start, plus the weeks from the previous value up to that start: that covers a week the log skipped and a
manual reset before or after the previous scheduled one. Values within an hour count as one. The report lists those it inferred. Once the latest `resets_at` any fresh reading carried has passed,
`fit` and `line` say the meter reset instead of showing last week's numbers.

## Fit

Over intervals of at least 3 points and 10 minutes, inside one window and inside the calls table's span:

```
ΔP = k·ΔQU + λ·Δt + ε      k, λ ≥ 0
```

ΔQU sums every call in the interval — all sessions, subagents and workflow agents. λ is drift the transcripts can't
see, mostly claude.ai chat, which shares the meter. Weighted least squares with w = 1/(r + 0.05·ΔP): r is the
readings' rounding variance, and the 0.05·ΔP term lets a long interval count more without swamping the rest. That is
a modelling choice, not a published one. Two parameters solve in closed form, with the k, λ ≥ 0 boundary checked.
λ is held at 0 with under 4 intervals, or when ΔQU and Δt move together (correlation over 0.98).

The report also gives:

- k with λ = 0, the upper bound on k;
- a bootstrap interval for k (2000 resamples, fixed seed), or the leave-one-out range under 5 intervals;
- a **holdout**: the history-only fit's prediction of the live ticks against what they did;
- the calls table against the status line's own summed `cost` over the live ticks, which checks additivity.

Refit weekly; the public reports show the mapping drifting.

## Phases

Lane status files hold only the current phase, so each **track** (one session's work on one lane) gets a timeline
from its own markers (`phases.ts`), in FEATURE-WORKFLOW.md's order: plan → build → gate → review → local → dev → pr →
post.

- An explicit phase wins from the first one on: a `pnpm board lane <phase>` in the transcript, or a phase-log row
  (_Phase log_). Before it, tool-use heuristics move the phase forward. A phase-log row is the lane's, not a
  session's: it joins every track of its lane whose main-session calls span its time, give or take 2 minutes. A
  track with no row in its span (a lane resumed in a new session) opens at the lane's last logged phase before it,
  unless that row was the lane file's removal.
- A source edit while in gate goes back to build (a red gate's fix; a green one can't be told apart). After the first
  review, fixes stay in review.
- A Plan run after the PR step starts the next cycle on the same track.
- Calls before the first marker are plan when planning came first, else **unattributed**, which stays visible.
- A subagent or workflow agent takes its parent's phase at its own first call.
- A call's lane is its own row's git branch (else its worktree cwd), else its session's. Older lanes ran from the
  main checkout and `cd`'d into their worktree, so the session alone can't tell. The hub stays the hub wherever it
  `cd`s.
- The report gives how far the heuristics agree with explicit markers on tracks that have both. That agreement is
  the stated accuracy for older lanes, which only have heuristics.
- _Phase sources_ in the report: the share of lane QU in PR windows whose phase a marker, the phase log, a heuristic
  or nothing set, and the lens-regime PRs whose lane never wrote an explicit phase past plan, by name. That list is the check
  that lanes write their phases: a name on it is a lane to ask why.

## PR table and types

Merged PRs come from `gh pr list --search merged:>=<since − 60 days>` (the lookback keeps a reused branch's earlier
PR, so it still bounds the next one's window; the table starts at `--since`) (read-only token, at most 1000, and the report says when
it hit that), cached an hour per `--since` in `cache/prs.json`; a failed read falls back to the cache and says so. A PR's calls are its branch's from the previous PR on that branch (or the start) to its merge.
For the last PR on a branch, the window runs 6 hours past the merge, which covers cleanup and the deploy watch. Each
row lists:

- files and lines changed;
- review rounds: `review` markers and every review lens's spawn (`code-reviewer`, `review-*`), a new round after 10
  quiet minutes, so each `review-fixes` recheck after a fix pass is a round of its own (it has no marker otherwise);
- rechecks (`review-fixes` runs, by tool-use id, so a fork's copied spawn counts once), ui (any file under `app/` or `extension/`), each agent run's type, model and QU,
  the main session's QU and its context summed over turns, and the lens regime (any `review-*` lens ran);
- local and dev devcheck runs;
- turns: main-session calls;
- subagent runs;
- QU, in total and per phase.

**Types**, first match wins, assigned by rule so a forecast exists before the work:

1. **research**: every file is docs or Markdown, or workflow agents are over half the QU.
2. **infra-ci**: over half the files are under `cdk/`, `.github/`, `scripts/`, `tools/`, `.claude/`, or are root
   config.
3. **small-fix**: 7 files or fewer.
4. **feature**: everything else.

Per type, the model works on **ln QU**. Each type's mean is shrunk toward the overall mean (empirical Bayes; needs 3+
types with 2+ PRs each), and the spread is pooled across types. It reports the median, P80 = exp(θ + 0.84·s), and in
percent via k, with k's spread added in. **With fewer than 9 PRs a type shows min / median / max (the plain median),
not a P80.** The
hub's QU over the PR window is overhead: shown per merged PR and kept out of the type medians. So are ad hoc
main-checkout sessions and lanes with no merged PR.

## Work units

The 11-19 work-units analysis (`localNotes/usage/work-units-analysis.md`) found the root unit is the **main-session
turn, priced by the context it re-reads**: turn count explains most of a PR's QU, lane-hours far less. The report
measures the units from the cache:

- **Where the QU goes:** each call's QU split into re-read (cache reads), ingest (input and cache writes) and output,
  main sessions apart from agents (`priceParts`, which sums to the call's QU).
- **Context bands:** main-session turns by the context each read (under 100k, then each 100k to 500k, 500k+): share,
  QU per turn and re-read per turn. A turn's cost rises with the context it carries.
- **Turn and context model:** the fitted constants below, and the median context at a lane session's turns 1, 10,
  50, 100 and 200 (turn 1 is the fixed load a session starts with).
- **Agent prices:** each agent type × model, runs and QU per run (median, p25–p75) — lens prices differ several-fold
  by model, so they are never one "subagents" lump.

## Estimate

```
T      = exp(a + b·ln lines + c·ui) · smear                     turns, smear = mean exp(residual)
main   = a + b·T + c·ctxSumM,   ctxSumM = T·(g0 + g1·T) / 1e6   the average context grows with the turns
agents = Plan + rules + the other lenses + rechecks(lines, ui) · recheck price + fan-out · general-purpose price
QU     = main + agents;  meter % = k · QU
```

- **The fit set** is the merged PRs in the **lens regime** (a `review-*` lens ran) with calls, turns and lines: it
  defines itself from the data and grows as PRs merge. Every constant is refit on each run.
- **Priors:** a constant falls back to its prior, tagged `[prior]` in the output: every regression under 12 fit-set
  PRs; the ui coefficient alone (the rest fitted) under 3 PRs in either ui class; a recheck's or fan-out agent's price under 5 runs, Plan's or a lens's under 5 PRs.
  The priors are `<usage dir>/priors.json`, gitignored like the rest of the usage dir, because a real fit's values are
  usage numbers and costs. Its shape is `estimate.ts` → `Priors` (`turns`, `main`, `ctx`, `rechecks`, `prices`,
  `band`, `k`); any subset overlays the tracked defaults, keys starting `_` are comments, and a key or value that
  doesn't fit is named in the output and ignored. The tracked defaults (`DEFAULT_PRIORS`) are invented placeholders so
  a fresh checkout and CI run end to end; without the file, the estimate and the report say so. The numbers don't
  transfer between repos (the analysis's sister-project addendum); the structure does, so another repo's cache
  refits them.
- **Prices:** Plan and each lens per PR (the median, over PRs that ran it, of what one PR spent on it); a recheck and
  a fan-out agent per run, times its count. Plan and the rules lens always run; `--lenses` names the rest
  (`rules correctness tests shell infra ui extension`; default `correctness,tests`, plus `ui` with `--ui`).
- **The range** is the backtest's 10th–90th percentile errors on the point, once it has 12 PRs; before that ÷/× the
  prior `band`. The meter % multiplies the ends by k's 80% interval (`usage fit`), or the prior k when the meter
  can't fit one.
- **The hub** is not in the estimate: the output adds its measured QU per merged PR as a separate line.
- **Backtest**, in every report: leave-one-out over the fit set, each PR predicted from a refit on the others
  (regressions and prices), from its merged lines, paths, the lenses it ran and its general-purpose runs, beside the
  PR-type median of the others (the forecast this replaces): rms and median error, PRs within ×1.5, totals, and the
  newest 30 PRs. The merged diff and the lens set as run are known only afterwards, so a live estimate carries more
  error than the backtest shows.

## Phase log

`scripts/board/phase-log.sh --once` is the zero-token phase logger: plain bash and `jq`, no Claude, no hub wake. The
board sampler's loop runs it every tick, in the background (`docs/ops/SESSION-BOARD.md` → _Watchers_). Each pass
compares the lane files (`board/lanes/*.json`) with its state (`board/phase-log.state`) and appends one row per
change to `<usage dir>/phase-log.jsonl`:

```
{"v":1,"lane":"<branch>","from":"<phase>"|null,"to":"<phase>"|null,"ts":"<ISO>","pct":<weekly %>|null}
```

- `from: null` is a first sighting (a new lane, or the logger's first pass); `to: null` is the file gone
  (`--clear`, `lanes end`). A same-phase rewrite (`board lane build --step …`) is no change; a phase that left and
  came back between passes is, since `phaseSince` moved.
- `ts` is the file's own `phaseSince`, so a 30 s pass loses no precision (a removed file: the pass's time).
- `pct` is the account's weekly % at the pass, as `usage-watch.sh` reads it: the max over meter rows from the last
  `watchers.usage.freshSec`; null with no fresh row. On a first sighting, or after the sampler was down, the pass
  can come well after `ts`, so `pct` then trails it.
- A torn lane file is skipped with its state kept; a removed file is one the pass didn't see. A failed append, or a
  row that failed to build (a refused fork), leaves the state alone, so the next pass writes the same rows; a torn
  last line in the log gets a newline first; a lost state file repeats rows, which the reader keeps once (by lane,
  phase and time). One pass at a time (`flock` on `phase-log.state.lock`; a pass that finds it held does nothing),
  and the sampler cuts a pass off at 25 s. It always exits 0 and prints nothing; trouble goes to
  `board/phase-log.log`, the sampler's copy of its stderr too. `APERTURE_PHASE_LOG` and `APERTURE_PHASE_STATE`
  override its two files.

## The two measure-first questions

- **Do review rounds 3–4 find real issues?** Each round's window runs from its first review marker to the next round,
  the first local/dev/PR step, or the merge. Per round index, the report gives:
  - QU;
  - the share of rounds with a source edit in the lane's own session (a fix was made; a fix handed to a subagent
    isn't seen);
  - what the lane's archived report says about that round (real bugs or clean). That is parsed heuristically from
    prose, and the report says how many reports it could read.
- **Do more lanes give more merged PRs, or just more slowdown?** Concurrency is the number of lanes with a call in the
  hour. Per day, the report gives:
  - mean and max lanes;
  - merged PRs;
  - PRs per lane-hour;
  - QU per PR;
  - rank correlations across the days with lane work (a day with merges but no lane call, the tail of yesterday's
    lane, is listed but left out of them);
  - from `heavy.sh` job records, the wall-time growth per extra working session for typecheck, lint and test.

## Known limits

- Output tokens in transcripts are a lower bound. The additivity check shows how much that matters.
- Phase heuristics before explicit lane markers are approximate. The agreement figure says how approximate.
- A transcript Claude Code deleted before its first scan is gone, so early PRs can show "no calls" and leave the type
  statistics. Once scanned, a shard outlives its transcript, and a `PARSER` bump rereads only the transcripts still
  there: older shards keep the earlier parser's output. Each shard records the parser that built it, and _Phase
  sources_ counts those on an older one.
- Two checkouts on different `PARSER`s sharing one cache reread everything on each other's scans: a branch that
  bumps it runs its real-data checks against its own `APERTURE_USAGE_DIR` until it merges.
- gh lists at most 100 files per PR, so a bigger PR's ui flag is read from part of its list; the _Turn and context
  model_ section counts those fit-set PRs.
- The phase logger samples once a tick: a phase held for less than one pass (30 s) is missed; the transcript's
  explicit markers still carry it.
- Meter intervals are few, and whole-percent readings are coarse, so k's interval is wide. Read the interval, not the
  point.
