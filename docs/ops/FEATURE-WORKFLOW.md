# Feature workflow — the phases every feature runs

Every feature runs the same eleven phases, in a lane (`docs/ops/LANES.md`) that reports to the hub
(`docs/ops/HUB.md`). Root `CLAUDE.md` → _Feature workflow_ keeps the rules every session needs; this is the detail.
**Read it at kickoff, and again before each phase** — it is not loaded on its own.

## Talking to the maintainer: through the hub only

A lane never sends a phone ping and never asks the maintainer in its own pane, in either mode (the maintainer,
2026-11-16). Whatever it needs from the maintainer — a decision, a Mac command, a resource it can't reach — goes to the hub as
`[ask-maintainer]` with the options and the lane's pick, or the exact one-line Mac command; the hub relays it with
its recommendation and sends back the answer as `[relay]` (`docs/ops/HUB.md` → _Messages_). So in a lane, "ask the
user", "tell the user" and "hand the user" anywhere in the docs mean that message. Anything the maintainer types in
a lane's pane goes to the hub as `[info]` at once, verbatim in the message (it is not GitHub-bound text). Which hub
messages count as the maintainer's approval: `docs/ops/HUB.md` → _Approval_.

## Two modes

The maintainer names the mode; collaborative is the default.

- **Collaborative.** Claude stops at decision points: Plan's model, Plan's questions, the execute and n, review
  findings that need a product call or add scope, and the dev all-clear. Each is one `[ask-maintainer]` (findings as
  a list), and the lane waits for the hub's `[relay]`.
- **Autonomous (only when the maintainer says so).** Claude makes every decision itself — it never stops or hands
  one back. Make the best call from `PRODUCT.md`, the plan, and real day-to-day use
  (`docs/product/EvaluatingChanges.md`), then act; for new scope that may be building it or deciding "not now" as a
  noted follow-up. Log **every** decision — Plan answers included — in the worktree's `localNotes/decisions.md`: what
  came up, what was chosen, why, and how to undo it. Present the log at the end of development; the PR body
  summarises it. Parking is only allowed _as_ a logged decision, never a quiet "ask later".
  - **"Build it, autonomous" is the execute.** Rounds come from Plan's file count — under 10 files → 1, 10–30 → 2,
    over 30 → 3. Risk overrides size: auth, IAM/cdk, finance, migrations or external-service writes → at least 2. If
    the last planned round still finds real bugs, one extra round, logged, never more. A number in the kickoff wins.
  - **Every plan opens with _Operator steps_** — the exact one-line Mac commands, in order, each marked before Build
    / at dev test / at PR / at Cleanup (a `.github/workflows/` branch's push, which the bot can't do, and a
    `.github/` branch's admission to the `dev` environment, only when Claude asks for them — phase 8; its removal at
    Cleanup — phase 11). The pause before Build is the only planned one.
  - **Blocked anyway** (a maintainer-only command, an undecidable call): `[ask-maintainer] <branch> — <need>` to the
    hub, with the command or the options and a pick, and the lane file's `--needs … --cmd|--link`. A block the
    maintainer isn't needed for (another lane, a stuck environment) is `[blocked]` instead — one message per block,
    never both. Carry on with whatever doesn't depend on it.
  - **Dev test is Claude's after the push:** run `pnpm devcheck --tier full --feature <the feature's scenario>` (it
    waits for the deploy itself; a branch with no scenario of its own runs without `--feature`), Read the screenshots.
    A green full run with zero leftovers, every _Feature coverage_ row `pass`, `off dev`, `needs you` or `deferred`
    (under _This feature_ and _Other scenarios_ alike), plus that review is the all-clear (phase 9). On
    `DEV_CHANGED_MID_RUN`, main won: read the merged PRs, rebase, gate, `pnpm bot push --after-rebase` (a
    `.github/workflows/` branch: the maintainer's push), `pnpm bot deploy-dev` again, rerun.
  - **Finished:** `[pr-open]` (or `[pr-ready]` when the mailroom was unreachable) to the hub, with the devcheck
    report's _This feature_ lists — _You don't need to test_ / _Needs you_, "no feature rows" for a branch with no
    scenario of its own — and the report below.

**No hub.** Before the kickoff, `ListAgents` must list the hub (`board.sh hub` is the quick check). Missing, in
either mode: `pnpm board lane <phase> --needs "no hub"` (the tower shows it), one line in the pane saying so — a
statement, not a question — then carry on with what is already approved and keep sending at each checkpoint (the
messages land when it is back). A call that needs the maintainer is parked as a logged decision until the hub returns.

## Lane status and checkpoints

At the checkpoints marked **→ hub** — kickoff (2), the dev lock taken, queued or released (8, 10), blocked, PR open
(10), merged (11) — the lane sends one short `[tag] <branch> — facts` message (`docs/ops/HUB.md` → _Checkpoints_).
At those same checkpoints, and at each phase change between them, it also writes its lane status file —
`pnpm board lane <phase> [--step …] [--needs … --link|--cmd …]`, from the worktree — which the web tower's NOW and
NEEDS YOU read (`docs/ops/TOWER.md` → _Lane files_); a `[blocked]` or `[ask-maintainer]` is also `--needs` with the
command or link.

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
   _Probe check_). **→ hub:** `[kickoff]` — what, areas touched, open questions, mode.
3. **Questions** — collaborative: `[ask-maintainer]` with each question's options and a pick. Autonomous: answer and
   log them.
4. **Build** — only on the maintainer's "execute" plus a number of review rounds (n). When asking for n, give a rough
   estimate of how many files the change will touch — a gauge of size, not a commitment. While building, after each
   section run the touched files' tests (`vitest run <file>`) and a typecheck. Autonomous: n per the sizing rule
   above, logged.
5. **Gate** — full `pnpm typecheck`, `pnpm lint`, `pnpm test`, in sequence, each under `scripts/board/heavy.sh --`,
   real exit codes (`pipefail`). Nothing goes to a subagent on a red gate.
6. **Review round** — the read-only `code-reviewer` (no tests, no servers) in parallel with whatever each touched
   package adds:

   | Touched           | Adds                                                                                                                                                                                                                                                  |
   | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `app/`            | Headless UI agent (`run-app` skill, stub + auth bypass) driving a concrete checklist from the plan, at phone width in light and dark. Screenshots → the worktree's `localNotes/screenshots/round-<n>/`.                                               |
   | `lambdas/`        | No second agent — the node-env handler tests are the runtime proof and the gate ran them. The reviewer gets a backend checklist: writes only via the handler's `writes` object, external calls only via gated gateways, JWT + origin-secret handling. |
   | `cdk/`            | Synth pass: `cdk synth`, diff the template against `origin/main`'s, report changed resources, IAM grants, cdk-nag findings. No creds needed; never alongside tests.                                                                                   |
   | `packages/shared` | The contract both sides build on — the `app/` and `lambdas/` rows both apply, and the reviewer checks both callers.                                                                                                                                   |

   When the round is back, fix real bugs and convention breaks. Findings that need a product call or add scope:
   collaborative → one `[ask-maintainer]` with the list; autonomous → decide and log. Then the gate runs again, which
   also starts the next round.

7. **Ready for dev** — after n rounds: committed on the feature branch (one commit after the build, one per round's
   fixes), gate green, PR body current.
8. **Dev test** — first make sure the branch sits on the latest `origin/main`; if main moved, read the merged PRs and
   rebase (CLAUDE.md → _Claude behavior_), then re-run the gate. Then a green
   `pnpm devcheck:local --tier full --feature <its scenario>` (`docs/ops/LOCAL-CHECK.md`) — a red one is fixed before
   the lock, a green one proves nothing about dev.
   - **Before the first `pnpm bot push`, scan for publication.** The repo is public, so a push publishes; an amend
     or a later force-push doesn't recall it. Check the branch name, every commit message and the diff against
     `origin/main` against `docs/ops/PUBLIC-CONTENT.md` — the judgment half; the identifier and identity checks are
     `pnpm bot push`'s own. Phase 10 scans the PR text again.
   - Then `pnpm bot push`, and `pnpm bot deploy-dev`: it takes a dev slot's lock (slot A only when the branch touches
     iOS paths), which stays held through dev testing — `pnpm bot lock renew` before it runs out (**→ hub:** `[lock]`
     taken until when, ETA). Slots and locks: `docs/ops/CI-BOT.md` → _Dev slots_, _Dev lock_.
   - **Another branch's lock means wait, never work around it:** the refusal prints two messages — send them at once,
     once each (**→ hub** `[lock]` queued, and the holder's session when the board names it) — then the
     `pnpm bot lock wait` the refusal names (`--any` when both slots are held) in the background wakes you when it
     frees or lapses (exit 0 → `deploy-dev` again; 75, still held after 45 min → tell the hub who holds it and until
     when). Etiquette and the named dev order: `docs/ops/HUB.md` → _Lock etiquette_.
   - **`.github/` branches.** A branch that changes `.github/` is dispatched on its own ref, and the `dev`
     environment admits it only by name: the first time, the admit command goes to the maintainer **before**
     `pnpm bot deploy-dev` — else GitHub refuses the deploy job and the run is wasted (`docs/ops/CI-BOT.md` →
     _Commands_ → workflow changes). One that changes `.github/workflows/` is also pushed by the maintainer (the bot has
     no `workflows` permission) — send the maintainer, from the worktree path, `git push -u origin <branch>` with the admit
     command `&&`-chained after it the first time (after a rebase, `git push --force-with-lease -u origin <branch>`),
     again after every fix commit, since the branch head must be the dispatched commit. **A `.github/workflows/`
     branch never skips this phase:** PR checks never run the deploy workflows, so a green `dev` deploy run is the
     only proof they even start. For a changed reusable workflow, check who else calls it
     (`scripts/src/workflow-permissions.test.ts` checks caller permissions).
   - **A dispatch that fails in `Deploy stacks` with `explicit deny in a service control policy`** means the branch
     changes a shape dev's freeze holds still: the maintainer opens the freeze for it (`docs/ops/CI-BOT.md` → _Kill
     switch_ → _Opening the freeze_), asked through `[ask-maintainer]`.
   - Also send the maintainer `code <Mac worktree path>`, to read the code directly, and a short checklist of
     what matters most to test on dev for this feature: a handful of items, not the review checklist.
   - **Then run the dev check yourself** — `pnpm devcheck --tier full --feature <its scenario>`, plus a
     `scenarios/<feature>.ts` whose rows encode the plan's matrix (`docs/ops/DEV-CHECK.md` → _Rows_); the report keeps
     the feature's rows apart from every other scenario's — and Read its screenshots; `ios` rows need the Mac awake —
     an unreachable Mac leaves them _Needs you_ with the reason, never a failure (`docs/ops/IOS-CHECK.md`); what they
     turn up goes through phase 9's rule.
   - Autonomous: a `.github/workflows/` branch's push and a `.github/` branch's admission are the maintainer's
     (operator steps, else `[ask-maintainer]`); everything else is Claude's.
9. **Dev feedback** — collaborative: `[ask-maintainer]` for how dev testing went. **Every defect a dev test turns up
   — the headless agent's oddity, the maintainer's repro, a devcheck row — is a bug to fix:** "pre-existing" decides
   only where (this branch when it's the same surface, else its own small PR), never whether; triage by reading the
   code path or reproducing, never "automation artifact" or "by design" unverified. Fixes go back through the gate
   (plus a review round if non-trivial), then back to dev (phase 8). Repeat until the all-clear. The all-clear needs
   every row of the feature's matrix proven on dev, covered off dev, or listed under _Needs you_, and every other
   scenario's row likewise (_Other scenarios (regression)_) — a row the report shows `fail` or `skipped` is untested
   (a `deferred` slow row counts like off dev, with `ios-standalone`'s caveat: `docs/ops/DEV-CHECK.md` → _Slow
   tier_), whatever the status line says. Autonomous: the all-clear is the green full run with every row so.
10. **PR** — on the all-clear, scan the PR title, body and the report against `docs/ops/PUBLIC-CONTENT.md`, then
    `pnpm bot lock release` (**→ hub:** `[lock]` released), `pnpm bot push`, then `pnpm mailroom open-pr`
    (`docs/ops/MAILROOM.md` → _Using it_; **→ hub:** `[pr-open]` with the URL, or `[pr-ready]` when the mailroom was
    unreachable). A push to an open PR after a rebase is `pnpm bot push --after-rebase` (a `.github/workflows/`
    branch: the maintainer's `git push --force-with-lease -u origin <branch>`); after any push to an open PR,
    `pnpm mailroom edit-pr` brings its body up to date.
11. **Cleanup** — once `gh pr view <branch>` shows it merged and main's deploy run is green, without asking the
    maintainer (the maintainer, 2026-11-08), the session or the hub runs `pnpm lanes end <branch>` from `/workspace`
    (`docs/ops/LANES.md` → _End_: it checks both gates, archives `localNotes/` to
    `/workspace/localNotes/archive/<branch>/`, removes the worktree; `--force-abandon "<reason>"` on the maintainer's
    word for an abandoned branch; by hand only when it can't run, its _End_ steps 1–3); the local branch goes at the
    end of the wave, when the hub runs `pnpm bot prune-branches` (squash merges make `-d` refuse; `-D` stays
    hard-blocked) — whenever `lanes end` prints a line, send it to the hub as printed, never through a Bash command:
    a `dev`-environment admission's removal (phase 8; a leftover entry lets the bot recreate that name at any
    commit), and the delete of any branch `prune-branches` would keep, e.g. an abandoned one. **→ hub:** `[merged]` —
    follow-ups, decisions that matter to the roadmap.

## The report

**Every feature ends with `localNotes/report-<branch>.md`**, either mode, written even when the run never reached a
PR (a run that stops before phase 10 releases its dev lock first): status first (PR ready / blocked / failed, and
why), what the feature is, what happened (build, rounds, dev check, decisions), a short happy-path test the
maintainer can run unaided, the devcheck report's _This feature_ lists, _You don't need to test_ and _Needs you_
(what still needs the maintainer, and why; "no feature rows" for a branch with no scenario of its own), key
screenshots (relative links into `localNotes/`). Its text gets pasted into PRs, so it follows
`docs/ops/PUBLIC-CONTENT.md` like the PR body — scan both before `open-pr`. The last message in the pane links it
(Mac path); the `[pr-open]` points the hub at it.

Page-first still holds: a backend half usually follows a frontend that already passed its rounds, so the plan says
which half this is, and the reviewer checks the lambda against the contract the stub set.
