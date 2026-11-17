# Review — one parallel round of lenses, then a recheck of the fixes

Phase 6 of the feature workflow (`docs/ops/FEATURE-WORKFLOW.md`) points here. Several independent reviews of one
diff find more than the same review run again, and here the late rounds mostly found bugs that the previous round's
fixes had introduced, or a twin call site a fix had missed: about 45 of the ~130 archived lanes ran an extra round
(the coverage check, 2026-11-17, _Coverage_ below). So the review is one round of reviewers in parallel, each
reading the same diff through a different **lens**, merged into one list, fixed in one pass, gated once — then a
recheck of the fix diff alone, only while a round still finds something serious.

## Lens map

Each lens is a read-only agent in `.claude/agents/`. `code-reviewer` is the base: run alone before any non-trivial
commit, it behaves as before (and says what it left to the other lenses).

| Lens        | Agent                | Model       | Runs when the diff touches                                                                                                                                                                                                                                                                                                             | Owns                                                                                                                                         |
| ----------- | -------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| rules       | `code-reviewer`      | session's   | every diff                                                                                                                                                                                                                                                                                                                             | security, BFF writes, secrets, public content, conventions, docs, data-model invariants, architecture fit, merged neighbours, approval holes |
| correctness | `review-correctness` | opus, high  | any code, config or script                                                                                                                                                                                                                                                                                                             | logic, ordering, reads and writes, failure paths, time, contracts, model output                                                              |
| tests       | `review-tests`       | sonnet      | any code, config or script                                                                                                                                                                                                                                                                                                             | test gaps, assertions that can't fail, isolation, clocks, CI parity, fakes, the dev-test matrix and its scenario                             |
| infra       | `review-infra`       | fable, high | `cdk/`, `.github/`, `scripts/src/bot/`, `scripts/src/classify-changes.ts`, `scripts/src/deploy-*`, `scripts/src/workflow-*`; a `lambdas/` change adding a function, env var, AWS call, table access pattern, schedule or secret; `docs/arch/INFRA.md`, `docs/ops/CI-BOT.md`; any deploy, slot, lock or approval rule; the risk classes | blast radius, IAM and SCPs, cost and quotas, deploy order and rollback, workflows, dev slots and the bot, Lambda wiring, the synth pass      |
| shell       | `review-shell`       | opus, high  | `*.sh`, `.claude/`, `CLAUDE.md`, `tools/`, `scripts/board/`, `scripts/src/{lane,board,mailroom}/`; a doc adding or changing an operator command                                                                                                                                                                                        | portability, fail-open checks, file modes, guard bypass, the Mac trust boundary, container safety, operator commands, CLI footguns           |
| UI          | `review-ui`          | sonnet      | `app/`; `packages/shared` when it changes what renders                                                                                                                                                                                                                                                                                 | the headless pass, first-open state, focus, input size, probe points                                                                         |
| extension   | `review-extension`   | opus, high  | `extension/`                                                                                                                                                                                                                                                                                                                           | research before fixing, the WebKit quirks, the wire contract                                                                                 |
| fix recheck | `review-fixes`       | opus, high  | rounds 2 and later; a non-trivial dev fix; a rebase that resolved conflicts                                                                                                                                                                                                                                                            | fix closed, fix regressions, sibling call sites, drop reasons                                                                                |

What each touched package still brings, as before:

- **`app/`** — the UI lens drives a concrete checklist from the plan (`run-app` skill, stub + auth bypass) at phone
  width in light and dark; screenshots → the worktree's `localNotes/screenshots/round-<n>/`.
- **`lambdas/`** — no runtime review agent: the node-env handler tests are the runtime proof and the gate ran them.
  `code-reviewer` holds the backend checklist: writes only via the handler's `writes` object, external calls only
  via gated gateways, JWT + origin-secret handling. Page-first: a backend half follows a frontend that already
  passed its review, so the plan says which half this is, and the lenses check the lambda against the contract the
  stub set.
- **`cdk/`** — the infra lens runs the synth pass: `cdk synth`, diff the template against `origin/main`'s, report
  changed resources, IAM grants, cdk-nag findings. No creds needed; never alongside tests.
- **`packages/shared`** — the contract both sides build on: the `app/` and `lambdas/` rows both apply, and the
  correctness lens opens both callers.

## Picking lenses

`git diff --name-only origin/main...HEAD` against the table; when unsure, add the lens. The pick goes in
`localNotes/decisions.md`.

- **Docs only** — `code-reviewer` alone; plus shell if an operator command changed, infra if a deploy, slot, lock or
  approval rule changed.
- **Tooling only** (scripts, hooks, `tools/`) — rules, correctness, tests, shell; plus infra when the bot or deploy
  rules change.
- **Workflow docs or `.claude/`** — rules and shell; plus infra when an approval or deploy rule changes.
- **Risk classes** — auth, IAM/cdk, finance, migrations, external-service writes — add infra, and get the recheck
  whenever round 1 led to a code fix, serious or not.
- **A model call, prompt or model-output validator** in the diff — tell the correctness lens, so it runs its model
  output section.

## Launching

All of a round's lenses go out in one message. Each prompt carries the diff range, the plan's path, the round
number, and the lens's own input (the UI checklist; the LLM flag). A session that started before an agent file
existed, or whose checkout lacks it, runs a general-purpose agent told to Read the lens file and follow it, on the
file's model, with the container rule in words. A budget-tight kickoff may move the `fable` lens to `opus`.

**Effort stays at `high`.** No lens, or any other agent, runs above `high` (`xhigh` or `max`) without an
`[ask-maintainer]` through the hub and the maintainer's explicit yes. A lens that seems to need more is proposed to
the hub with the numbers that show it, never raised in place.

## Finding shape

Every lens reports one line per finding, worst first:

`S1|S2|S3 · confirmed|suspected · path:line · kind · what is wrong · the fix`

- **S1** — security, data loss, a secret or never-list text, a deploy that fails or can't roll back, a new recurring
  cost, a guard or gate that passes when it should fail.
- **S2** — behaviour a user or operator would hit wrong, a broken invariant, a test or dev-check row that can't fail
  for the change.
- **S3** — the rest.
- **Serious** means a confirmed S1 or S2. A `suspected` one counts only once the lane has traced it.

Then `Not checked:`, `Other lenses:`, and the last line `lens=<name> S1=<n> S2=<n> S3=<n> serious=<yes|no>`.
`kind` is a tag from _Coverage_. The agent files carry a copy of this block; this section is its home.

## Merge

1. Collect every lens's lines; sort by path and line.
2. The same defect within about five lines of one file is one finding: keep the highest severity, list the lenses
   that found it.
3. `Other lenses:` notes join as `suspected`.
4. Trace each suspected S1/S2 to confirmed, or drop it with the reason.
5. Write `localNotes/review/round-<n>.md`: per finding an id `R<n>-<nn>`, severity, lenses, path, the issue, and the
   verdict — fix / drop: why / product call — then the fix commit.

Product calls and added scope: collaborative → one `[ask-maintainer]` with the list; autonomous → decide and log.

## Fix, gate, commit

One pass over everything kept, S1 to S3; the touched files' tests while fixing; then one gate (phase 5) and one
commit for the round.

## Round 2 and later

- **Only after a serious finding.** No confirmed S1/S2 in a round (and not a risk class with code fixes) → the
  review has stopped; go to phase 7.
- **What runs** — `review-fixes` alone, on `<the commit before the fixes>..HEAD`, with the previous round's
  `round-<n>.md`. If a fixed finding came from the UI lens, `review-ui` also re-shoots just those screens.
- **What it reports** — each fixed finding closed or not, regressions in the touched functions and their callers,
  sibling call sites with the same pattern, dropped serious findings whose reason the code doesn't bear out; each
  line tagged `cause=fix|sibling|not-closed|pre-existing`.
- **Serious again** → fix, gate, commit, and the next round rechecks that fix diff. **Minor only** → fix, gate,
  commit, done. **Nothing** → done, no extra gate.
- **Stop and ask** after four rounds, or from round 3 on when a round finds no fewer serious bugs than the one before:
  `[ask-maintainer]` with the open list and three options — another recheck, re-plan that piece, or ship with it
  logged as a follow-up — and the lane's pick.

## After a dev fix or a rebase

A non-trivial fix from dev testing (phase 9), or a rebase that resolved conflicts, gets `review-fixes` on that diff,
then the gate.

## Lens gaps

A serious finding in round 2 or later that the fixes didn't cause (`cause=pre-existing`) means a round-1 lens should
have seen it.

- **The lane** records it under `## Lens gaps` in its report — lens, kind, one line, round — and sends one
  `lens-gap: <lens> <kind> — <line>` per gap in its `[pr-open]`.
- **The hub** keeps the ledger, `/workspace/localNotes/review-gaps.md` (`docs/ops/HUB.md` → _The hub's duties_). A
  second gap of the same lens and kind queues a small lane to widen that lens's checklist.
- The archived lane reports are the backup if the ledger is lost.

## The round record

The report's _what happened_ carries one table per round: lens, model, minutes, tokens when the agent result gives
them, findings by severity, gates run. No lane recorded review tokens before this, so this is the calibration data
for the next design change.

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
| `sibling`     | a twin call site the fix missed                                                      | fix recheck | correctness        |

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
