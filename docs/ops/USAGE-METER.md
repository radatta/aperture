# Usage meter — what agent work costs against the weekly limit

The account's Claude usage limit shows only as a weekly **percent**. This turns that into a cost model, bottom-up:
token counts per model call → **quota units (QU)** → lane phases → merged PRs → per PR type. A single fitted factor
**k** converts QU to meter percent at the end. Method and sources: the 11-17 research panel (`localNotes/research/`).
Code: `scripts/src/usage/`. Data: the gitignored `localNotes/usage/`, never a tracked file. The repo is public, so
real numbers, costs and session ids stay out of tracked text; fixtures are synthetic.

```
status line ─► statusline-log.sh ─► meter-<day>.jsonl ──┐
                                                         ├─► k (fit) ─► % per PR type
~/.claude/projects/**.jsonl ─► scan ─► cache/shards ─────┘     ▲
                                  └─► phases ─► PR table ──────┘
```

## Commands

| Command                                              | Does                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm usage report [--since YYYY-MM-DD] [--refresh]` | Scans, then prints the full model and writes `localNotes/usage/report-<day>.md`. `--since` defaults to 2026-11-04; `--refresh` refetches merged PRs. |
| `pnpm usage fit`                                     | Only k, its interval, the holdout and the burn rate.                                                                                                 |
| `pnpm usage line`                                    | One line: `usage <n>% · <r>%/h · ~<h> h to 100%`. Not wired into the status line or tower yet (a follow-up).                                         |
| `pnpm usage scan [--rate <MB/s>]`                    | Only the transcript scan (default 40, at most 60).                                                                                                   |
| `pnpm usage doctor`                                  | Is the logger installed and writing? Exit 1 with the fix otherwise.                                                                                  |

`--no-scan` on report, fit and line skips the scan. `-h` on any command prints its usage and runs nothing.

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
  two files (a forked session) is counted once, owned by the subagent file over its parent.
- **Markers:** each call's tool uses become enum-only markers for the phases: an explicit `pnpm board lane <phase>`,
  a Plan or `code-reviewer` spawn, a source/test/docs/notes edit, a full `pnpm typecheck|lint|test`,
  `devcheck:local`, `devcheck`, `bot push|deploy-dev`, `mailroom open-pr`, `git commit`. A command counts only where
  it runs, never quoted inside a grep or echo. The cache keeps no command text, path or content.
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
zero. The weekly resets that `resets_at` implies (every 7 days back from it) are added to the history's resets, so no
interval spans one; the report lists those it inferred.

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

- An explicit `pnpm board lane <phase>` wins from the first one on. Before it, tool-use heuristics move the phase
  forward.
- A source edit after a red gate goes back to build. After the first review, fixes stay in review.
- A Plan run after the PR step starts the next cycle on the same track.
- Calls before the first marker are plan when planning came first, else **unattributed**, which stays visible.
- A subagent or workflow agent takes its parent's phase at its own first call.
- A call's lane is its own row's git branch (else its worktree cwd), else its session's. Older lanes ran from the
  main checkout and `cd`'d into their worktree, so the session alone can't tell. The hub stays the hub wherever it
  `cd`s.
- The report gives how far the heuristics agree with explicit markers on tracks that have both. That agreement is
  the stated accuracy for older lanes, which only have heuristics.

## PR table and types

Merged PRs come from `gh pr list` (read-only token), cached an hour in `cache/prs.json`; a failed read falls back to
the cache and says so. A PR's calls are its branch's from the previous PR on that branch (or the start) to its merge.
For the last PR on a branch, the window runs 6 hours past the merge, which covers cleanup and the deploy watch. Each
row lists:

- files and lines changed;
- review rounds: `review` markers, a new round after 10 quiet minutes;
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
percent via k, with k's spread added in. **With fewer than 9 PRs a type shows min / median / max, not a P80.** The
hub's QU over the PR window is overhead: shown per merged PR and kept out of the type medians. So are ad hoc
main-checkout sessions and lanes with no merged PR.

## The two measure-first questions

- **Do review rounds 3–4 find real issues?** Each round's window runs from its first review marker to the next round,
  the first local/dev/PR step, or the merge. Per round index, the report gives:
  - QU;
  - the share of rounds with a source edit (a fix was made);
  - what the lane's archived report says about that round (real bugs or clean). That is parsed heuristically from
    prose, and the report says how many reports it could read.
- **Do more lanes give more merged PRs, or just more slowdown?** Concurrency is the number of lanes with a call in the
  hour. Per day, the report gives:
  - mean and max lanes;
  - merged PRs;
  - PRs per lane-hour;
  - QU per PR;
  - rank correlations across days;
  - from `heavy.sh` job records, the wall-time growth per extra working session for typecheck, lint and test.

## Known limits

- Output tokens in transcripts are a lower bound. The additivity check shows how much that matters.
- Phase heuristics before explicit lane markers are approximate. The agreement figure says how approximate.
- Transcripts older than Claude Code's retention are gone, so early PRs can show "no calls" and leave the type
  statistics.
- Meter intervals are few, and whole-percent readings are coarse, so k's interval is wide. Read the interval, not the
  point.
