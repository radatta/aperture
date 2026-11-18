# Feature workflow — the phases every feature runs

Every feature runs the same eleven phases, in a lane (`docs/ops/LANES.md`) that reports to the hub
(`docs/ops/HUB.md`). Root `CLAUDE.md` → _Feature workflow_ keeps the rules every session needs and each phase's
must-dos; this is the how-to. **Read it at kickoff, again before each of phases 8–11, and after any compaction** —
nothing loads it on its own, so `pnpm lanes start --kickoff`'s first prompt opens it before the kickoff.

## Talking to the user: through the hub only

The rule — no phone pings, no asking in the pane, every need as `[ask-maintainer]`, the user's pane words relayed
as `[info]` — and its message shapes live in `docs/ops/HUB.md` → _Messages_, _Checkpoints_. What it means here: in a
lane, "ask the user", "tell the user" and "hand the user" anywhere in the docs mean an `[ask-maintainer]` to the
hub, with the options and the lane's pick or the exact one-line Mac command; the answer comes back as `[relay]`.
Which hub messages count as the user's approval: `docs/ops/HUB.md` → _Approval_; for a go only the pane can give,
the `[ask-maintainer]` says "needs your go typed in `<branch>`'s pane".

## Two modes

The user names the mode; collaborative is the default.

- **Collaborative.** Claude stops at decision points: Plan's model, Plan's questions, the execute, review findings
  that need a product call or add scope, the review's stop-and-ask, a review item only
  live state can settle or a lens that couldn't run, an effort above `high`, and the dev all-clear.
  Each is one `[ask-maintainer]` (findings as a list), and the lane waits for the hub's `[relay]`.
- **Autonomous (only when the user says so).** Claude makes every decision itself — it never stops or hands
  one back, bar the review's stop-and-ask, a review item only live state can settle or a lens that couldn't run, and an effort
  above `high` (each an `[ask-maintainer]`: `docs/ops/REVIEW.md` → _Round 2 and later_, _Merge_, _Launching_). Make the best call from `PRODUCT.md`, the plan, and real day-to-day use
  (`docs/product/EvaluatingChanges.md`), then act; for new scope that may be building it or deciding "not now" as a
  noted follow-up. Log **every** decision — Plan answers included — in the worktree's `localNotes/decisions.md`: what
  came up, what was chosen, why, and how to undo it. Present the log at the end of development; the PR body
  summarises it. Parking is only allowed _as_ a logged decision, never a quiet "ask later".
  - **"Build it, autonomous" is the execute.** The review takes no round count: its lenses come from what the diff
    touches and its rechecks from what it finds (phase 6). Risk classes — auth, IAM/cdk, finance, migrations,
    external-service writes — add the infra lens and get the fix-diff recheck whenever round 1 led to a code fix.
    Lenses or a recheck named in the kickoff are added, never taken away.
  - **Every plan opens with _Operator steps_** — the exact one-line Mac commands, in order, each marked before Build
    / at dev test / at PR / at Cleanup (a `.github/workflows/` branch's push, which the bot can't do, and a
    `.github/` branch's admission to the `dev` environment, only when Claude asks for them — phase 8; its removal at
    Cleanup — phase 11). The pause before Build is the only planned one.
  - **Blocked anyway** (a user-only command, an undecidable call): `[ask-maintainer] <branch> — <need>` to the
    hub, with the command or the options and a pick, and the lane file's `--needs … --cmd|--link`. A block the
    user isn't needed for (another lane, a stuck environment) is `[blocked]` instead — one message per block,
    never both. Carry on with whatever doesn't depend on it.
  - **Dev test is Claude's after the push:** run `pnpm devcheck --tier full --feature <the feature's scenario>` (it
    waits for the deploy itself; a branch with no scenario of its own runs without `--feature`), Read the screenshots.
    A green full run with zero leftovers, every _Feature coverage_ row `pass`, `off dev`, `needs you` or `deferred`
    (under _This feature_ and _Other scenarios_ alike), `pnpm gate:ci` green on the head sha, plus that review is the
    all-clear (phase 9). On
    `DEV_CHANGED_MID_RUN`, main won: read the merged PRs, rebase, gate (a rebase that resolved conflicts also gets
    the recheck: `docs/ops/REVIEW.md` → _After a dev fix or a rebase_), `pnpm bot push --after-rebase` (a
    `.github/workflows/` branch: the user's push), `pnpm bot deploy-dev` again, rerun.
  - **Finished:** `[pr-open]` to the hub — or `[pr-ready]` when the mailroom was unreachable, then the hand-off line
    in its own `[ask-maintainer]` — in the shape `docs/ops/HUB.md` → _Checkpoints_ gives, and the report below.

**No hub** before the kickoff, or a hub that drops mid-run: `docs/ops/HUB.md` → _Missing hub_.

## Lane status and checkpoints

At the checkpoints marked **→ hub** — kickoff (2), the dev lock taken, queued or released (8, 10), blocked, PR open
(10), merged (11) — the lane sends one short `[tag] <branch> — facts` message to the pinned hub address (`docs/ops/HUB.md` →
_Checkpoints_, _Approval_).
At those same checkpoints, and at each phase change between them, it also writes its lane status file —
`pnpm board lane <phase> [--step …] [--needs … --link|--cmd …]`, from the worktree — which the web tower's NOW and
NEEDS YOU read (`docs/ops/TOWER.md` → _Lane files_); a `[blocked]` or `[ask-maintainer]` is also `--needs` with the
command or link.

**The lane file carries the estimate.** Right after Plan, the lane writes its step plan with
`pnpm board lane plan --plan <step>=<lo>-<hi>[?],… --files <n>` (minutes, `?` a guess); at every phase change after,
a plain `pnpm board lane <phase> --step …` accrues the time each step took and re-derives the ETA ranges to the next
step and to the PR from it, and a fresh `--plan` replaces the ranges when they move (`docs/ops/TOWER.md` → _Lane
files_). The tower reads lane files directly — a step bar, `PR ~HH:MM–HH:MM`, the next ask — so status needs no extra
hub message (the checkpoints stay).

## Phases

1. **Worktree** — `pnpm lanes start <branch> [--kickoff <file>]` from `/workspace`: the worktree off `origin/main`,
   its install, and the lane's window and session named `<branch>` (`docs/ops/LANES.md` → _Start_; by hand only when
   it can't run).
2. **Plan** — the `Plan` agent; collaborative: `[ask-maintainer]` for the model, with `fable` as the pick;
   autonomous: `fable` unless named. The plan drafts the feature's **dev-test matrix**: rows of entry point (UI, API,
   MCP, iOS, …) × case, nominal and edge, walked through the edge-case checklist (empty/max/invalid, cancel, repeat,
   survives reload, neighbour unaffected, ownership). Each row is proven on dev through its own entry point (`ios`
   rows on the Simulator, `docs/ops/IOS-CHECK.md`), covered off dev by a named test (only a failure dev can't produce,
   or one whose path a dev-proven row of the same scenario already runs, named in its `why` — no test-only switch in
   shipped code), or _Needs you_. The feature's scenario encodes it and is then its source of truth
   (`docs/ops/DEV-CHECK.md` → _Rows_). A UI change also lists the iOS plan probe points (`near`/`scan`) inside the
   changed area and moves them in the same PR, regenerating `tools/mailroom/bench/plans.json` with
   `pnpm sim-bench:plans`; `pnpm ios-probe` is the backstop, the Simulator the proof (`docs/ops/IOS-CHECK.md` →
   _Probe check_). The plan also carries a **step plan**: build, the review (round 1 with its lenses, plus a recheck when serious findings are likely), dev test and PR, each with an
   **ETA range** derived from measured history — the board history's `heavy.sh` records (gate steps, devcheck runs)
   and archived lanes' estimate-vs-actual records — scaled by the file count, never a guess (guessed ETAs ran 2–4×
   long, 2026-11-14); a step with no history says so and gets a wide range. The plan also carries an **Unknowns**
   list: every fact the work depends on about an outside tool, OS, platform, version, API, limit or price, each
   _searched_ (`search-specialist` on `sonnet`, its sources named), _probed_ (a local probe or the installed tool's
   own source settled it, how named), or marked _run-only_ with the reason neither can settle it — "none" written out
   when there are none. A text rule to search first wasn't enough: a lane once spent hours of trial CI runs on a
   platform-version fact one search answered. The same holds past Plan: before spending a run or an iteration on a
   failure the environment caused, search it first, and add what the search found to the list. Right after Plan, the
   lane writes the step plan and its ranges to its lane status file (below). **→ hub:** `[kickoff]` — what, areas
   touched, open questions, the Unknowns, mode, the step plan.
3. **Questions** — collaborative: `[ask-maintainer]` with each question's options and a pick. Autonomous: answer and
   log them.
4. **Build** — only on the user's "execute". When asking for it, give a rough estimate of how many files the change
   will touch — a gauge of size, not a commitment — and the lenses the review will run. While building, after each
   section run the touched files' tests (`vitest run <file>`) and a typecheck.
5. **Gate** — `pnpm gate:fast` (`docs/ops/GATE.md`): full typecheck and lint, then the tests the branch's diff can
   reach, each step under `heavy.sh` by itself; it runs a package's whole suite, or all of them, when its rules say so,
   and prints why. Its exit code is real (`pipefail` if piped). The full suite runs on GitHub on every push (phase 8);
   `pnpm gate:fast --full` locally only to reproduce a red Branch run a single file can't, or when GitHub is
   unreachable. Nothing goes to a subagent on a red gate.
6. **Review** — read `docs/ops/REVIEW.md` first: the lens map, the merge, the finding shape and the escalation
   rules live there.
   - **Round 1, parallel.** On the committed, gate-green diff, launch together the read-only lens reviewers its
     paths call for (`docs/ops/REVIEW.md` → _Lens map_, _Picking lenses_).
   - **One list, one pass, one gate.** Merge every lens's findings into one deduped list ranked S1–S3
     (`localNotes/review/round-<n>.md`), trace each suspected serious one, fix real bugs and convention breaks in one
     pass, run the gate once, commit. Findings that need a product call or add scope: collaborative → one
     `[ask-maintainer]` with the list; autonomous → decide and log.
   - **Round 2 and later** recheck only the fix diff, and run while a round finds something serious or leaves an
     S1/S2 unfixed, and once after a risk class's code fix (when, and which lenses rerun: `docs/ops/REVIEW.md` → _Round 2 and later_). Serious again →
     fix, gate, commit, next round on that fix. Minor only → fix, gate, commit, done.
   - **Stop** when a round has no serious finding; stop and ask, in either mode, as `docs/ops/REVIEW.md` →
     _Round 2 and later_ says (the round cap, a twin).
   - A serious finding in round 2 or later that the fixes didn't cause is a **lens gap**: recorded in the report and
     sent to the hub (`docs/ops/REVIEW.md` → _Lens gaps_).

7. **Ready for dev** — once the review has stopped with no serious finding open (or the stop-and-ask is answered),
   every picked lens ran, and nothing is held open (`docs/ops/REVIEW.md` → _Merge_ 1 and 5): committed on the feature branch (one commit after the build, one
   per round's fixes), `gate:fast` green, PR body current.
8. **Dev test** — first make sure the branch sits on the latest `origin/main`; if main moved, read the merged PRs and
   rebase (CLAUDE.md → _Claude behavior_), then re-run the gate (and the recheck, after a rebase that resolved
   conflicts: `docs/ops/REVIEW.md` → _After a dev fix or a rebase_). Then a green
   `pnpm devcheck:local --tier full --feature <its scenario>` (`docs/ops/LOCAL-CHECK.md`) — a red one is fixed before
   the lock, a green one proves nothing about dev.
   - **Before the first `pnpm bot push`, scan for publication.** The repo is public, so a push publishes; an amend
     or a later force-push doesn't recall it. Check the branch name, every commit message and the diff against
     `origin/main` against `docs/ops/PUBLIC-CONTENT.md` — the judgment half; the identifier and identity checks are
     `pnpm bot push`'s own. Phase 10 scans the PR text again.
   - Then `pnpm bot push` — every push starts the full suite on GitHub (the `Branch` workflow; GATE.md); start
     `pnpm gate:ci --wait` in the background beside the dev steps. A red one is a gate failure: fix, `gate:fast`, the recheck
     (`docs/ops/REVIEW.md` → _After a dev fix or a rebase_), push.
     A branch with no dev deploy (nothing deployed changes) waits for it here.
   - `pnpm bot deploy-dev`: it takes a dev slot's lock (slot A only when the branch touches
     iOS paths), which stays held through dev testing — `pnpm bot lock renew` before it runs out (**→ hub:** `[lock]`
     taken until when, ETA). Slots and locks: `docs/ops/CI-BOT.md` → _Dev slots_, _Dev lock_.
   - **Another branch's lock means wait, never work around it:** the refusal prints two messages — send them at once,
     once each (**→ hub** `[lock]` queued, and the holder's session when the board names it) — then the
     `pnpm bot lock wait` the refusal names (`--any` when both slots are held) in the background wakes you when it
     frees or lapses (exit 0 → `deploy-dev` again; 75, still held after 45 min → tell the hub who holds it and until
     when). Etiquette and the named dev order: `docs/ops/HUB.md` → _Lock etiquette_.
   - **`.github/` branches.** A branch that changes `.github/` is dispatched on its own ref, and the `dev`
     environment admits it only by name: the first time, the admit command goes to the user **before**
     `pnpm bot deploy-dev` — else GitHub refuses the deploy job and the run is wasted (`docs/ops/CI-BOT.md` →
     _Commands_ → workflow changes). One that changes `.github/workflows/` is also pushed by the user (the bot has
     no `workflows` permission) — send the user, from the worktree path, `git push -u origin <branch>` with the admit
     command `&&`-chained after it the first time (after a rebase, `git push --force-with-lease -u origin <branch>`),
     again after every fix commit, since the branch head must be the dispatched commit. **A `.github/workflows/`
     branch never skips this phase:** PR checks never run the deploy workflows, so a green `dev` deploy run is the
     only proof they even start. For a changed reusable workflow, check who else calls it
     (`scripts/src/workflow-permissions.test.ts` checks caller permissions).
   - **A dispatch that fails in `Deploy stacks` with `explicit deny in a service control policy`** means the branch
     changes a shape dev's freeze holds still: the user opens the freeze for it (`docs/ops/CI-BOT.md` → _Kill
     switch_ → _Opening the freeze_), asked through `[ask-maintainer]`.
   - Also send the user `code <Mac worktree path>`, to read the code directly, and a short checklist of
     what matters most to test on dev for this feature: a handful of items, not the review checklist.
   - **Then run the dev check yourself** — `pnpm devcheck --tier full --feature <its scenario>`, plus a
     `scenarios/<feature>.ts` whose rows encode the plan's matrix (`docs/ops/DEV-CHECK.md` → _Rows_); the report keeps
     the feature's rows apart from every other scenario's — and Read its screenshots; `ios` rows need the Mac awake —
     an unreachable Mac leaves them _Needs you_ with the reason, never a failure (`docs/ops/IOS-CHECK.md`); what they
     turn up goes through phase 9's rule.
   - Autonomous: a `.github/workflows/` branch's push and a `.github/` branch's admission are the user's
     (operator steps, else `[ask-maintainer]`); everything else is Claude's.
9. **Dev feedback** — collaborative: `[ask-maintainer]` for how dev testing went. **Every defect a dev test turns up
   — the headless agent's oddity, the user's repro, a devcheck row — is a bug to fix:** "pre-existing" decides
   only where (this branch when it's the same surface, else its own small PR), never whether; triage by reading the
   code path or reproducing, never "automation artifact" or "by design" unverified. Fixes go back through the gate
   (plus the fix-diff recheck: `docs/ops/REVIEW.md` → _After a dev fix or a rebase_), then back to dev (phase 8). Repeat until the all-clear. The all-clear needs
   `pnpm gate:ci` green on the head sha (the full suite), every row of the feature's matrix proven on dev, covered off dev, or listed under _Needs you_, and every other
   scenario's row likewise (_Other scenarios (regression)_) — a row the report shows `fail` or `skipped` is untested
   (a `deferred` slow row counts like off dev, with `ios-standalone`'s caveat: `docs/ops/DEV-CHECK.md` → _Slow
   tier_), whatever the status line says. Autonomous: the all-clear is the green full run with every row so.
10. **PR** — on the all-clear, scan the PR title, body and the report against `docs/ops/PUBLIC-CONTENT.md`, then
    `pnpm bot lock release` (**→ hub:** `[lock]` released), `pnpm bot push`, then `pnpm mailroom open-pr`
    (`docs/ops/MAILROOM.md` → _Using it_; **→ hub:** `[pr-open]` with the URL, or `[pr-ready]` when the mailroom was
    unreachable). A push to an open PR after a rebase is `pnpm bot push --after-rebase` (a `.github/workflows/`
    branch: the user's `git push --force-with-lease -u origin <branch>`); after any push to an open PR,
    `pnpm mailroom edit-pr` brings its body up to date. Once the PR is open its PR run is the one that counts
    (`gate:ci` picks it): cancel the push's `Branch` twin with `pnpm bot run cancel <id>`.
11. **Cleanup** — once `gh pr view <branch>` shows it merged and main's deploy run is green, without asking the
    user (the user, 2026-11-08), the session or the hub runs `pnpm lanes end <branch>` from `/workspace`
    (`docs/ops/LANES.md` → _End_: it checks both gates, archives `localNotes/` to
    `/workspace/localNotes/archive/<branch>/`, removes the worktree; `--force-abandon "<reason>"` on the user's
    word for an abandoned branch; by hand only when it can't run, its _End_ steps 1–3); the local branch goes at the
    end of the wave, when the hub runs `pnpm bot prune-branches` (squash merges make `-d` refuse; `-D` stays
    hard-blocked) — whenever `lanes end` prints a line, send it to the hub as printed, never through a Bash command:
    a `dev`-environment admission's removal (phase 8; a leftover entry lets the bot recreate that name at any
    commit), and the delete of any branch `prune-branches` would keep, e.g. an abandoned one. **→ hub:** `[merged]` —
    follow-ups, decisions that matter to the roadmap.

## The report

**Every feature ends with `localNotes/report-<branch>.md`**, either mode, written even when the run never reached a
PR (a run that stops before phase 10 releases its dev lock first): status first (PR ready / blocked / failed, and
why), what the feature is, what happened (build, the review's round record and `## Lens gaps` —
`docs/ops/REVIEW.md` → _The round record_, _Lens gaps_ — dev check, decisions), a short happy-path test the
user can run unaided, the devcheck report's _This feature_ lists, _You don't need to test_ and _Needs you_
(what still needs the user, and why; "no feature rows" for a branch with no scenario of its own), key
screenshots (relative links into `localNotes/`), and **each step's estimate against its actual**, which
also go into `decisions.md` and the lane file, so the next plan's ranges calibrate. Its text gets pasted into PRs, so it follows
`docs/ops/PUBLIC-CONTENT.md` like the PR body — scan both before `open-pr`. The last message in the pane links it
(Mac path); the `[pr-open]` points the hub at it.

Page-first still holds: a backend half usually follows a frontend that already passed its review
(`docs/ops/REVIEW.md` → _Lens map_, `lambdas/`).
