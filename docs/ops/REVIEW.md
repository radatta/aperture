# Review — one parallel round of lenses, then a recheck of the fixes

Phase 6 of the feature workflow (`docs/ops/FEATURE-WORKFLOW.md`) points here. Several independent reviews of one
diff find more than the same review run again, and here the late rounds mostly found bugs that the previous round's
fixes had introduced, or another call site a fix had missed: about 45 of the ~130 archived lanes ran an extra round
(the coverage check, 2026-11-17, _Coverage_ below). So the review is one round of reviewers in parallel, each
reading the same diff through a different **lens**, merged into one list, fixed in one pass, gated once — then a
recheck of the fix diff alone, only while a round still finds something serious.

## Lens map

Each lens is a read-only agent in `.claude/agents/`. `code-reviewer` is the base: run alone before any non-trivial
commit, it behaves as before (and says what it left to the other lenses).

| Lens        | Agent                | Model           | Runs when the diff touches                                                                                                                           | Owns                                                                                                                                         |
| ----------- | -------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| rules       | `code-reviewer`      | session's, high | every diff                                                                                                                                           | security, BFF writes, secrets, public content, conventions, docs, data-model invariants, architecture fit, merged neighbours, approval holes |
| correctness | `review-correctness` | opus, high      | any code, config or script                                                                                                                           | logic, ordering, reads and writes, failure paths, time, contracts, model output, unsourced outside assumptions                               |
| tests       | `review-tests`       | sonnet, high    | any code, config or script                                                                                                                           | test gaps, assertions that can't fail, isolation, clocks, CI parity, fakes, the dev-test matrix and its scenario                             |
| infra       | `review-infra`       | fable, high     | the infra triggers below                                                                                                                             | blast radius, IAM and SCPs, cost and quotas, deploy order and rollback, workflows, dev slots and the bot, Lambda wiring, the synth pass      |
| shell       | `review-shell`       | opus, high      | `*.sh`, `.claude/`, `CLAUDE.md`, `tools/`, `scripts/board/`; the TypeScript CLI dirs only as set below; a doc adding or changing an operator command | portability, fail-open checks, file modes, guard bypass, the Mac trust boundary, container safety, operator commands, CLI footguns           |
| UI          | `review-ui`          | sonnet, high    | `app/`; `packages/shared` when it changes what renders                                                                                               | the headless pass, first-open state, focus, input size, probe points                                                                         |
| extension   | `review-extension`   | opus, high      | `extension/`                                                                                                                                         | research before fixing, the WebKit quirks, the wire contract                                                                                 |
| fix recheck | `review-fixes`       | opus, high      | rounds 2 and later; a dev fix; a rebase that resolved conflicts                                                                                      | fix closed, fix regressions, sibling call sites, drop reasons                                                                                |

**Infra triggers** — anything that can change a deploy, a dev slot or a monthly bill:

- `cdk/`, `.github/`, and any file a workflow or action runs or reads: `scripts/aws/`, `scripts/src/bot/`,
  `scripts/src/classify-changes.ts`, `scripts/src/deploy-*`, `scripts/src/workflow-*`, `scripts/src/checked-tree.ts`,
  `scripts/src/smoke.ts`, `scripts/src/mask-function-url.ts`, `scripts/src/cdk-diff-summary.ts`,
  `scripts/src/fixture-inputs.ts`;
- the deploy-shape paths (`deploy-base.ts` → `SHAPE_PATHS`: `packages/shared/src/stage.ts`, `pnpm-lock.yaml`),
  `.nvmrc` and the root `package.json`'s `packageManager`;
- slot routing and locks: `scripts/src/devcheck/{slot,config}.ts`, `scripts/src/devcheck/scenarios/ios-paths.ts`,
  `scripts/board/devlock.sh`;
- a `lambdas/` change adding a function, env var, AWS call, table access pattern, schedule, secret, a paid
  third-party or model call, or heavy logging (the kill switch's log-bytes alarm);
- an `app/` change adding an `/api` call at load (the BFF's reserved concurrency), and a devcheck scenario that adds
  load against the kill thresholds (`docs/ops/CI-BOT.md` → _What's capped_, _Kill switch_);
- `docs/arch/INFRA.md`, `docs/ops/CI-BOT.md`, and any deploy, slot, lock or approval rule.

A risk class alone is not a trigger (_Picking lenses_); IAM/cdk always is one (`cdk/`). On four auth and
lambdas-config diffs that touched none of these, infra found 0 serious (the lens measurement, 2026-11-18).

**Shell on the CLI dirs** — `scripts/src/{lane,board,mailroom,gate}/` is TypeScript: it brings the shell lens only when
the diff there spawns a shell, writes a hook, or builds a shell command line or an operator command. The same
measurement: shell found 0–1 serious a run on TS-only CLI diffs, 2 on shell, hook and process diffs.

What each touched package still brings, as before:

- **`app/`** — the UI lens drives a concrete checklist from the plan (`run-app` skill, stub + auth bypass) at phone
  width in light and dark; screenshots → the worktree's `localNotes/screenshots/round-<n>/`.
- **`lambdas/`** — no runtime review agent: the node-env handler tests are the runtime proof and the gate ran them.
  `code-reviewer` holds the backend checklist (its Severity 1): writes only via the handler's `writes` object,
  external calls only via gated gateways, JWT + origin-secret handling. Page-first: a backend half follows a frontend that already
  passed its review, so the plan says which half this is, and the lenses check the lambda against the contract the
  stub set.
- **`cdk/`** — the infra lens runs its synth pass on HEAD (`.claude/agents/review-infra.md` → _Synth pass_: the
  stages, the dummy values, the output path). A base assembly for the template diff is built by the lane from a checkout at the prompt's
  `origin/main` sha, under `heavy.sh`, with that same command, stages, `devmain` runs and all five dummy values, to
  an absolute output path outside any checkout — never a bare `cdk synth`, which reads or creates real tokens under
  `cdk/.secrets/`. Without a base, the template diff goes under
  `Not checked:`.
- **`packages/shared`** — the contract both sides build on: the `app/` and `lambdas/` rows both apply, and the
  correctness lens opens both callers.

## Picking lenses

`git diff --name-only origin/main...HEAD` against the table and the infra triggers; when unsure, add the lens. The
pick goes in `localNotes/decisions.md`. The triggered lenses are a floor: a kickoff or a relay can add lenses or
rechecks, never remove one (the one exception, a lens that couldn't run: _Merge_ 1).

- **Docs only** — `code-reviewer` alone; plus shell if an operator command changed, infra if a deploy, slot, lock or
  approval rule changed.
- **Tooling only** (scripts, `.claude/hooks/`, `tools/`) — rules, correctness, tests; shell on a shell trigger (a TS-only
  CLI change isn't one: _Shell on the CLI dirs_); plus infra for any infra trigger.
- **Workflow docs or other `.claude/` files** (agents, rules, skills) — rules and shell; plus infra when an approval
  or deploy rule changes.
- **Risk classes** — auth (JWT, Cognito, tokens, the origin secret), IAM/cdk (`cdk/`, roles, policies), finance
  (`lambdas/src/finance*`, Plaid, `app/src/modules/finances`), migrations (a stored shape that changes, a backfill),
  external-service writes (Google Calendar, S3, push, model calls that write). A class adds no lens and no recheck by
  itself: infra runs on an infra trigger, and its prompt then names the class. The class still counts for the dev-fix
  skip (_After a dev fix or a rebase_) and at the round cap (_Round 2 and later_ → _The pick_).
- **A small diff** — 3 files or fewer, no infra, shell, UI or extension trigger: round 1 is `code-reviewer`,
  `review-tests` and `review-correctness` only, and "when unsure, add the lens" doesn't apply (docs only stays
  `code-reviewer` alone; kickoff or relay additions still add). Such diffs ran 4–5 lenses; app-401-refresh's only
  serious finds came from tests, and f242-overlay-flakes had none (the lens measurement).
- **A model call, prompt or model-output validator** in the diff — tell the correctness lens, so it runs its model
  output section.

## Launching

Run `git fetch` first. All of a round's lenses go out in one message. Each prompt carries the diff range, the
`origin/main` sha, the plan's path, the round number, and the lens's own input (the UI checklist; the LLM flag; the
risk class). A session that started before an agent file existed, or whose checkout lacks it, runs a general-purpose
agent told to Read the lens file from the lane's own checkout and follow it, on the file's model and effort (set on the launch), told in words that
it is read-only and given the container rule — read-only by instruction only, an accepted residual. Nothing moves a
lens below its file's model or effort. A branch that edits a lens file is reviewed by that lens as the branch wrote it: say so in the round record.

**Effort stays at `high`** (the rule's home is `CLAUDE.md` → _Claude behavior_): every lens file pins `effort: high`
or lower, and going above is proposed to the hub with the numbers that show it, never raised in place.

## Finding shape

Every lens reports one line per finding, worst first:

`S1|S2|S3 · confirmed|suspected · path:line · kind · what is wrong · the fix`

- **S1** — security, data loss, a secret or never-list text, a deploy that fails or can't roll back, a new recurring
  cost, a guard or gate that passes when it should fail.
- **S2** — behaviour a user or operator would hit wrong, a broken invariant, a test or dev-check row that can't fail
  for the change.
- **S3** — the rest.
- **Serious** means a confirmed S1 or S2. A `suspected` one counts only once the lane has traced it.

Then `Not checked:`, `Other lenses:`, and the last line `lens=<name> S1=<n> S2=<n> S3=<n> serious=<yes|no>`
(serious = any confirmed S1 or S2).
`kind` is a tag from _Coverage_. The agent files carry a copy of this block; this section is its home.

## Merge

1. Check every picked lens returned its `lens=` line and ran its pass. A missing one is relaunched, and so is an infra lens
   that put its synth under `Not checked:` because the board was busy (once the UI lens returns); one that can't
   run (no browser, a blocked synth) goes to the hub as `[blocked]` or `[ask-maintainer]` and holds the lane until it has run, or the user's explicit
   yes, relayed, lets the round finish without it (then it is an open finding shipped: _The round record_). Then
   collect every lens's lines; sort by path and line.
2. The same defect within about five lines of one file is one finding: keep the highest severity, list the lenses
   that found it.
3. `Other lenses:` notes join as `suspected`.
4. Trace each suspected S1/S2 to confirmed, drop it with the reason, or hold it open (5). Severity is the lens's:
   the merge never lowers it.
5. A `Not checked:` item, or a suspected S1/S2, that only live state can settle (AWS, the Mac, a device) goes to the
   hub as one `[ask-maintainer]` with a read-only command to run whose output carries no secret (describe, get, list, with a `--query` naming
   the fields — never env values, `get-secret-value` or `--with-decryption`); it stays open in the round file and
   holds the lane until
   the relay answers it (an answer may make it a dev-test row, proven in phase 8).
6. Write `localNotes/review/round-<n>.md`: per finding an id `R<n>-<nn>`, severity, lenses, path, the issue, and the
   verdict — fix / drop: why / product call / open (5) — then the fix commit. Any S1/S2 a lens reported, confirmed or
   suspected, that leaves the round other than fixed (dropped, or a product call decided "not now") gets a second
   reader: `review-fixes` checks those reasons against HEAD, as in round 2 — with no fix range when the round fixed
   nothing (the prompt says so).

Product calls and added scope: collaborative → one `[ask-maintainer]` with the list; autonomous → decide and log.

**A hold stops the lane where it is**: in the review, before phase 7; after a dev fix or a rebase, before the
next push or deploy, and phase 10.

## Fix, gate, commit

One pass over everything kept, S1 to S3; the touched files' tests while fixing; then one gate (phase 5) and one
commit for the round.

## Round 2 and later

- **Only after a serious finding**, or an S1/S2 left unfixed (_Merge_ 6). Otherwise the review has stopped, risk class
  or not; go to phase 7. Every serious `review-fixes` find so far followed a round with serious fixes (the lens
  measurement).
- **What runs** — `review-fixes`, on `<the commit before the fixes>..HEAD`, with the previous round's
  `round-<n>.md`. If the fix range changes what renders (`app/` components or styles, or a UI-lens finding), `review-ui` also
  re-shoots just those screens; if the fix
  range itself touches an infra trigger, `review-infra` reruns on it (with the synth pass for `cdk/`) — not because the
  branch is a risk class or ran infra in round 1.
- **What it reports** — each fixed finding closed or not, regressions in the touched functions and their callers,
  sibling call sites with the same pattern, S1/S2 left unfixed whose reason the code doesn't bear out; each
  line tagged `cause=fix|sibling|not-closed|pre-existing`.
- **Serious again** (unless the stop below fires) → fix, gate, commit, and the next round rechecks that fix diff.
  **Minor only** → fix, gate, commit, done. **Nothing** → done, no extra gate.
- **Stop and ask**, in both modes: after four rounds; from round 3 on, when a round finds no fewer serious bugs
  than the one before; or, from round 2 on, at a **twin** — a serious `cause=fix` or `cause=sibling` finding in
  the mechanism an earlier round's fix already patched (one regex family, one parser, one state machine): the
  design is wrong, not the code. Round 2 counts; a serious regression elsewhere (a caller, another module) does
  not. The round file names, for each serious `cause=fix` or `cause=sibling` finding, the earlier finding whose
  fix patched that mechanism, or why it lies elsewhere. At any stop the round's findings stay unpatched:
  `[ask-maintainer]` with the open list and three options — patch it and recheck, re-plan that piece, or ship with
  the open list unpatched, logged as a follow-up and each S1/S2 under _Open findings shipped_ — and the lane's pick; the lane holds until the relay.
- **The pick.** At a twin, cap or not: re-plan that piece — move the judgment to where it is made once (the
  model, one parser) or narrow the scope. A relayed re-plan, with the open list's other fixes, is built, gated and
  committed, then reviewed afresh: a round 1 over its own diff with every lens _Picking lenses_ picks for it (kickoff
  or relay additions included), never skipped, its rounds counted anew in
  `localNotes/review/replan<k>-round-<n>.md` with ids `P<k>R<n>-<nn>`. At the cap with no twin, on a diff with no
  risk class: fix the open list, gate, commit, then one final broad review — every lens _Picking lenses_ picks for the
  branch (kickoff or relay additions included), on the whole branch diff, not the fix range — its S1/S2 fixed and gated with no further
  round, then ship; one it can't fix goes back as `[ask-maintainer]`. Not another narrow recheck. At any other
  stop, the lane picks on the merits.

## After a dev fix or a rebase

A fix from dev testing (phases 8–9, a red `Branch` run included), or a rebase that resolved conflicts, is committed and gated, then gets
`review-fixes`, plus `review-ui` or `review-infra` when the fix or rebase range itself touches their triggers, as in round 2 —
whatever its size. Only a fix that touches no infra, shell, UI or extension trigger and no risk class, and is
covered by a test it adds or changes, may skip `review-fixes`; say so in the record. Each dev fix or rebase is its own chain: its first
recheck is the chain's round 1, the rest runs as round 2 and later (serious again → recheck that fix), the cap and the
no-fewer comparison count within the chain, the twin in a dev-fix chain from its round 1 on, against any earlier
fix to that mechanism (a rebase chain has no twin stop: a bad resolution is serious again), and its files are `localNotes/review/dev<k>-round-<n>.md` with ids `D<k>R<n>-<nn>`.

- **Dev fix** — the range is `<the commit before the fix>..HEAD`; the list is the dev defects it fixes.
- **Rebase** — note the head before rebasing (`git rev-parse HEAD`); after, the recheck reads
  `git range-diff $(git merge-base <old-head> origin/main)..<old-head> origin/main..HEAD`, which shows only how each
  commit changed in the rebase, and the conflicted files' list stands in for the round file.

## Lens gaps

A serious finding in round 2 or later, or in any recheck of a dev, rebase or re-plan chain, that the fixes didn't cause
(`cause=pre-existing`) means an earlier lens should have seen it.

- **The lane** records it under `## Lens gaps` in its report — lens, kind, one line, round — and sends one
  `lens-gap: <lens> <kind> — <line>` per gap in its `[pr-open]`.
- **The hub** keeps the ledger, `/workspace/localNotes/review-gaps.md` (`docs/ops/HUB.md` → _The hub's duties_). A
  second gap of the same lens and kind becomes a follow-up to widen that lens's checklist — an edit to
  `.claude/agents/`, so it needs the maintainer's go in that lane's pane.
- The archived lane reports are the backup if the ledger is lost.

## The round record

The report's _what happened_ carries one table per round: lens, model, minutes, tokens when the agent result gives
them, findings by severity, gates run. No lane recorded review tokens before this, so this is the calibration data
for the next design change.

**Open findings shipped** — every S1/S2 left unfixed (a drop the second reader upheld, a product call "not now", the
stop-and-ask's "ship it"), every live-state item still open (only after the relay's answer, _Merge_ 5) by id from the round files,
and every lens that didn't run, by lens and round (only after the user's yes, _Merge_ 1).
The list goes in the report, the PR body and `[pr-open]`; an empty one is written "none".

## Coverage

Every finding kind in the archived lane reports and decision logs (~130 lanes, read 2026-11-17), and the lens that
owns it. Kinds no lens can own are listed last. "Also" lenses see the kind from their own angle.

| Tag           | Kind                                                                                 | Owner       | Also               |
| ------------- | ------------------------------------------------------------------------------------ | ----------- | ------------------ |
| `logic`       | logic and edge cases (empty, max, boundary, a regex too loose)                       | correctness |                    |
| `race`        | ordering and lost updates (double tap, late response, navigating mid-mutation)       | correctness |                    |
| `stale-read`  | an eventually-consistent read followed by a write; a stale read after a write        | correctness | rules              |
| `partial`     | a multi-step write that can stop half-way; a retry after a half-applied write        | correctness |                    |
| `silent`      | a swallowed error, a failure read as success, a check that passes on missing input   | correctness | shell              |
| `loading`     | a default shown while data loads that reads as real                                  | correctness | UI                 |
| `invariant`   | data-model invariants (soft delete, frozen estimate, ULID, day bucket, tombstones)   | rules       | correctness        |
| `time`        | local getters on a UTC Lambda, app day against calendar day, DST                     | correctness | tests              |
| `contract`    | stub and http clients that differ; a fake that hides prod                            | correctness | tests              |
| `caller`      | a shared-type change one caller doesn't follow                                       | correctness | rules              |
| `parse`       | two parsers of one field that disagree                                               | correctness |                    |
| `llm`         | model output reaching storage unchecked; a validator too strict or too loose         | correctness | dev (variance)     |
| `assumed`     | outside behaviour (tool, OS, version, API, limit, price) assumed with no source      | correctness |                    |
| `security`    | auth, JWT, origin secret, token races, information leaks                             | rules       | correctness        |
| `writes`      | BFF writes discipline; MCP prod-write semantics                                      | rules       |                    |
| `secrets`     | secrets in errors, argv or fixtures                                                  | rules       |                    |
| `public`      | public content, identifiers, commit author and committer                             | rules       |                    |
| `convention`  | pnpm, dependencies, tokens, prettier churn on untouched lines                        | rules       |                    |
| `docs`        | a doc made wrong, an overclaim, a second home for a fact, a missing index entry      | rules       |                    |
| `approval`    | a hole in an approval or authority rule                                              | rules       | infra              |
| `process`     | a pass claimed through a pipe, a commit on a red gate, review on an uncommitted tree | rules       |                    |
| `fit`         | logic in the wrong layer, a read with side effects, page-first inverted              | rules       | infra              |
| `neighbour`   | another branch's merged rule, seed or contract that the diff contradicts             | rules       | infra, fix recheck |
| `test-gap`    | a changed behaviour or failure path with no test                                     | tests       |                    |
| `vacuous`     | an assertion that passes without the change                                          | tests       |                    |
| `flaky`       | shared state, live files, wall-clock waits, load-only timeouts                       | tests       |                    |
| `ci-parity`   | a 2-CPU runner, a gitignored fixture, bash 3.2 on the Mac                            | tests       | shell              |
| `matrix`      | dev-test matrix and scenario: off-dev rows, entries, locators, preconditions, leaks  | tests       |                    |
| `iam`         | least privilege, SCPs and the freeze, permission boundary, stored roles              | infra       |                    |
| `cdk`         | resource wiring, two owners of one resource, provider functions                      | infra       |                    |
| `deploy`      | deploy order, rollback, migration, retention and tombstone expiry                    | infra       |                    |
| `cost`        | recurring cost, quotas, concurrency, the kill switch                                 | infra       |                    |
| `workflow`    | `.github/` callers' permissions, runner images, environment policy                   | infra       |                    |
| `slots`       | dev slots, locks, the bot                                                            | infra       |                    |
| `portability` | bash 3.2, zsh, BSD tools, `set -u`, `IFS`                                            | shell       |                    |
| `fail-open`   | `pipefail` with `grep -q`, a pipe's exit code, `\|\| true`                           | shell       |                    |
| `mode`        | an exec bit dropped                                                                  | shell       |                    |
| `bypass`      | another way around a guard or hook                                                   | shell       | rules              |
| `trust`       | shared-folder code run on the Mac, check-then-use races, sandbox profiles            | shell       | rules              |
| `container`   | monitor-tripping text, kill by pattern, orphaned children, mount quirks              | shell       |                    |
| `runbook`     | an operator command that can't pass                                                  | shell       | infra              |
| `footgun`     | `--help` or no arguments that act                                                    | shell       |                    |
| `layout`      | layout at 440/390, dark, contrast                                                    | UI          |                    |
| `focus`       | focus after a dialog or removal; a destructive default                               | UI          | correctness        |
| `first-open`  | a field or panel as it first opens                                                   | UI          |                    |
| `ios`         | inputs under 16 px; iOS probe points                                                 | UI          | dev                |
| `webkit`      | Safari extension behaviour                                                           | extension   | dev (Safari pass)  |
| `fix-regress` | a bug the previous round's fix introduced                                            | fix recheck |                    |
| `sibling`     | another call site the fix missed                                                     | fix recheck | correctness        |

Not a lens's to own: real-device, Simulator and model-variance behaviour (the dev check and _Needs you_), and
product calls (the decision log or `[ask-maintainer]`).

## Follow-ups: findings that should become machinery

Kinds that recur across lanes and a check can catch, queued as follow-ups (not built with this doc):

1. `pipefail` with `grep -q` in hooks and scans → a test over `.claude/hooks` and `scripts/**/*.sh`.
2. An exec bit dropped → a test that every tracked script under hooks, scripts and tools keeps mode 100755.
3. Local date getters in `lambdas/` → an ESLint `no-restricted-syntax` rule.
4. `toEqual` where an absent key matters → prefer `toStrictEqual` in tests.
5. `JSON.stringify` equality on stored maps in devcheck → a helper and a lint.
6. An eventually-consistent read followed by a put in `lambdas/` → a consistent-read marker type or a contract test.
7. Input font size under 16 px in `app/` → a CSS test.
8. Prettier churn on untouched lines → a pre-commit check that formats only touched files.
9. Devcheck locators that match more than one element → a scenario lint for `getByLabel`/`getByRole` without `exact`.
10. The report block identical across the lens agent files → a pinning test.
11. The trigger table as a script (changed paths → lenses).
