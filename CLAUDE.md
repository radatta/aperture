# Aperture

A personal life-OS PWA — one place for everything digital about me. Web-first, installable, multi-device. Its #1 job is a morning + night ritual (glance, plan, reflect); the signature move is **calibration** — surfacing the gap between what a task was _estimated_ to take and what it _actually_ took.

Product is the source of truth: `docs/product/PRODUCT.md`. Full doc map: `docs/index.md`.

## Project structure

pnpm monorepo (workspaces in `pnpm-workspace.yaml`):

- `app/` — React + Vite + TypeScript PWA (the product).
- `lambdas/` — AWS Lambda BFF.
- `cdk/` — CDK infrastructure.
- `packages/shared/` — the cross-cutting contract (types shared between app and lambdas).
- `scripts/` — dev/CI utilities.
- `tools/` — user-side clients that run on the Mac (Raycast quick-add); not a workspace package.
- `docs/` — specs and cross-cutting rules (start at `docs/index.md`).
- `localNotes/` — gitignored scratch; never tracked.

## Commands

**pnpm only — never npm or yarn.** Requires Node 22 (`.nvmrc`).

| Command                       | Does                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                    | Run the app (Vite) → `http://localhost:5173`, or `6173` inside a COI container (`docs/ops/COI-SANDBOX.md` → _Ports_). Vite walks upward if taken — read the port, don't assume it. |
| `pnpm typecheck`              | `tsc -b` across the project-reference graph                                                                                                                                        |
| `pnpm lint` / `pnpm lint:fix` | ESLint (flat config), one root pass                                                                                                                                                |
| `pnpm test`                   | Vitest across all packages (`pnpm -r`)                                                                                                                                             |
| `pnpm build`                  | Production build (`pnpm -r`)                                                                                                                                                       |
| `pnpm format`                 | Prettier write                                                                                                                                                                     |
| `pnpm devcheck --tier …`      | The dev check: headless Chromium as the dev test user on the deployed dev stage (`docs/ops/DEV-CHECK.md`). Never alongside tests or a dev server.                                  |

**Inside the COI container (the usual case), four things bite:**

- **Never put a reverse-shell shape on a Bash command line or in a Grep pattern — it kills the container.**
  COI v0.15 kills on these anywhere in any process's argv (token-anchored, lowercased): `nc -e`/`ncat -e`;
  `bash -i`/`sh -i` (any shell); `socket.socket`, `fsockopen`, `System.Net.Sockets`, `ruby -rsocket`;
  `socat`/`powershell` next to a network token; `/dev/tcp/<host>/…` with a non-loopback host (in a
  shell line — the Bash wrapper is one); and `python3 -c`/`python -c`/`perl -e`/`ruby -e`/`php -r`
  **only when the same command also mentions `tcp`, `udp`, `socket`, an IP, or a `host:port`**
  (`[monitoring] reverse_shell_one_liners = "warn"` downgrades that class). Prefer
  `python3 - <<'PY' … PY` and `jq` anyway. Separately, **`/curl` or `/wget` (with the slash) anywhere
  in a Bash line pauses the container** (a Sigma rule the Bash wrapper pre-satisfies) — bare `curl` is
  fine; read `…/curl/…` paths with the Read tool. So do two exec-watcher shapes — `nc…` with `-e`
  anywhere in its text (even `us-east-1`) and `node -e` with `child_process` + `net`
  (`docs/ops/COI-SANDBOX.md` → _Container frozen_). **A remote `:8080` connection pauses the container, and kills it when COI's nft monitor runs.** This
  applies to the literal text anywhere — test fixtures, echoed strings, heredocs — so file content
  carrying these belongs in the Write/Edit tools, and every subagent prompt that may run Bash or Grep
  must carry this rule. `.claude/hooks/coi-reverse-shell-guard.sh` (Bash and Monitor) and
  `coi-grep-guard.sh` (Grep) enforce it; the rule stands whether or not they're registered. Mechanism:
  `docs/ops/COI-INCIDENTS.md` → Incidents F and H.

- **`pnpm install` needs `CI=true`** or it aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- **`node_modules` is shared with the macOS host** — native binaries belong to whichever side installed
  last. `vite dev`/`vite build` dying with `Cannot find module '../lightningcss.*.node'` is this;
  `pnpm install` fixes it for the current platform (and breaks the other side until they do the same).
  Doesn't affect `tsc` or `vitest`. Mechanism: `docs/ops/COI-INCIDENTS.md` → Incident B → _Related_.
- **Several sessions share one container's limits — check the board, run heavy work through `heavy.sh`.**
  9 CPUs, `memory.high` 18 GiB, `pids.max` 4096, and **two different ceilings** bite, which is why the
  crashes read as code bugs when they aren't: the **pids/thread** ceiling (`SIGABRT`/134 — a refused
  `clone()`, _not_ memory; `docs/ops/COI-INCIDENTS.md` → Incident A) and memory (`SIGKILL`/137 — from the
  VM or userland, never the container cgroup, which only throttles). A `tsgo` fatal has also been seen
  under load with the mechanism never confirmed — capture the **head** of the output, don't assume OOM
  (`docs/ops/COI-SANDBOX.md` → _Ops notes_ → _Transient `tsc` crashes_). `scripts/board/board.sh status`
  shows who is running what and the headroom; `scripts/board/heavy.sh -- <cmd>` runs a test, typecheck,
  lint, build, dev server or browser with its peak usage logged and a budget slot others can see. Measured
  (2026-10-13): **CPU gives out first** — one `pnpm test` keeps ~8 of 9 cores busy, and past ~5 concurrent
  suites jsdom tests time out at 7.6 GiB / 1140 threads, so a timeout under parallel load is contention,
  not a bug. So `heavy.sh` caps full test suites at **4 at once** (`limits.json` `concurrency`): a 5th waits up to
  90 s for a slot, then exits 75 naming the holders — tell the user rather than retry; give a full suite a 600 s
  timeout or run it in the background. Single-file runs are never capped, and every hold is tracked
  (`board.sh status`, `cli.ts barriers`). Within one session, still serialise: screenshot, kill the browser, then test. Measured edges and the rest:
  `docs/ops/SESSION-BOARD.md`.

Runbook: `docs/ops/COI-SANDBOX.md`. Post-mortems (pids/`SIGABRT`, sleep, mounts): `docs/ops/COI-INCIDENTS.md`.

## Conventions (hard rules — these override defaults)

Full detail in `docs/product/CONVENTIONS.md`. The load-bearing ones:

- **pnpm only.** `pnpm install`, `pnpm -r`, `pnpm dlx` (not npx). **Its version comes from `packageManager` in the root `package.json`, via corepack — nothing else.** Never pin pnpm in a machine-global tool manager: CI (`.github/workflows/ci.yml`) resolves it from that field, so a second declaration is only a second thing to drift out of sync with CI (the mise trap: `docs/ops/COI-SANDBOX.md` → _Start here → 1_).
- **First-principles dependency discipline.** Default to rolling our own. Only propose a dependency when EITHER (A) it's substantial hard-to-own logic, OR (B) it's security-critical / subtle-correctness / hard cross-platform edges we shouldn't hand-roll. When proposing one, justify against A/B explicitly, note its footprint + transitive deps, and state the roll-our-own alternative. **"It's popular" is not a reason.**
- **Build order: page-first, backend-second.** Build `app/` against a stubbed API and validate the UX in-hand _before_ wiring the Lambda + DynamoDB behind the same contract.
- **Workspace packages resolve from source.** `packages/shared` exports `./src/index.ts`; app and lambdas import it directly and their bundler transpiles it — no build step in the dev/test loop. (`shared` still emits a gitignored `dist/` only to satisfy TS project references; nothing imports it.)
- **One test runner: Vitest.** jsdom env for `app/`, **node env for `lambdas/`** so tests match the Lambda's prod runtime exactly.
- **Dates/times via a shared helper** — never inline `Date` math or raw ISO strings in a component.

## Architecture

```
React PWA (S3 + CloudFront) --Cognito JWT--> Lambda Function URL (origin-secret header) --> DynamoDB
```

Same-origin `/api/*` via CloudFront (no CORS); the Function URL is auth `NONE`, gated by an origin-secret header CloudFront stamps (OAC fronts only the S3 bucket). In-handler Cognito JWT validation. Single-table DynamoDB (PITR + RETAIN). CDK IaC. GitHub Actions + OIDC — **no static credentials anywhere.** dev + prod. Details: `docs/arch/TECH.md`, `docs/arch/INFRA.md`.

**Writes discipline (BFF):** every external write (POST/PUT/PATCH/DELETE) is declared in one `writes` object at the top of the handler and nowhere else — helpers call functions passed in via `writes`, never write APIs directly. Single audit point; guarantees no writes fire during any test/smoke run.

## Git workflow

**GitHub Flow.** Feature branch → PR → squash-merge to `main`. Merging to `main` runs the pipeline (lint/typecheck/test → deploy dev → deploy prod — **no approval pause**; prod follows dev automatically). Pushing to `dev` does a one-off dev deploy. PRs run checks only.

**`main` and `dev` are both deploy branches** — but they are not alike. `main` is protected and permanent. **`dev` is scratch: the user force-pushes it routinely to get a branch onto real infrastructure, and that is the intended workflow.** Its history is disposable and nothing ever merges out of it. Only the user can push it — a `dev` ruleset (from ci-bot's merge) restricts it to the admin, so the bot can't.

So when a branch can't fast-forward onto `dev`, **do not propose merging `origin/dev` into it, rebasing onto it, or creating a temporary worktree** — the answer is that the user force-pushes over it. Claude still never pushes to `dev` at all (see Hard-blocked); the point is to stop inventing workarounds for a problem the user solves in one command.

**Claude acts on GitHub as the bot** — the GitHub App `aperture-cc-bot`, driven by `pnpm bot …` (`docs/ops/CI-BOT.md`): it pushes feature branches, deploys a pushed commit to dev, and reads dev logs. It never opens or merges PRs — **the user opens every PR**, so `main`'s squash commits are theirs — and can never push `main`: the `main` ruleset requires the user's code-owner approval, and the bot is no bypass actor. The container's own GitHub token stays read-only.

**Bot dev deploys (`pnpm bot deploy-dev`) are off until dev's CDK bootstrap is isolated** (`dev-bootstrap`, `docs/ops/CI-BOT.md` → _Dev deploy blast radius_): the dispatch refuses unless the repository variable `DEV_DEPLOY_ISOLATED` is `true`, and until then the user pushes to `dev` as before, under the session board's dev lease (phase 8). `dev-bootstrap` isolates it; `dev-cutover` after it turns them on and retires the `dev` push path. Once on: **the dev stack is shared — one branch at a time, under the dev lock.** `pnpm bot deploy-dev` takes `refs/locks/dev` (45-minute TTL, `pnpm bot lock renew` to extend), holds it through dev testing, and `pnpm bot lock release` frees it; another branch's lock means wait, not work around. A merge to `main` redeploys dev over a dispatched branch — whichever deploys last wins; re-run `deploy-dev` when the devcheck sees the build change.

### One worktree per feature — `/workspace` stays on main

`/workspace` is always detached at `origin/main`; no feature work happens there. Every feature starts the same way:

1. `git fetch`, then `git switch --detach origin/main` in `/workspace`.
2. `git worktree add --no-track -b <name> .claude/worktrees/<name> origin/main` — a plain branch name (`EnterWorktree` would add a `worktree-` prefix) and no upstream, so a bare `git push` can't target `main`.
3. `CI=true pnpm install` inside the worktree, so it has its own real `node_modules` — never a symlink to the main checkout's (running pnpm through one rewires the main checkout).

The worktree's `localNotes/` holds that feature's PR body, screenshots, and decision log, and the push / `gh pr create` commands handed to the user run from the worktree path. Worktrees live under the workspace mount, so the user can reach them from the Mac. **Every command handed to the user is one `&&`-chained line that starts with `cd` to the Mac path** — `/workspace` is `/Users/rahuldatta/Coding/Personal/aperture` there, so a worktree is `/Users/rahuldatta/Coding/Personal/aperture/.claude/worktrees/<branch>` — never a `/workspace/...` path, never separate lines. **Removing a worktree deletes its gitignored `localNotes/`, so it happens only at _Feature workflow_ → _Cleanup_.**

### Claude drives git — guarded

Claude handles branches, commits, and PR bodies. **Allowed** git commands:

- `git status`, `git diff`, `git log`, `git branch`, `git show`
- `git switch -c` / `git checkout -b`, `git switch`, `git checkout <file>`
- `git add`, `git commit`, `git stash`
- `pnpm bot push` — the one way Claude pushes: the current feature branch, as the bot. After a rebase, `pnpm bot push --after-rebase` (a lease on the last push). A branch that changes `.github/workflows/` is the user's to push — the bot has no `workflows` permission (_PR bodies_)
- `git fetch`, `git rebase origin/main`, `git mv`
- `git worktree add` / `git worktree list` (feature worktrees, above); `git worktree remove` only at _Feature workflow_ → _Cleanup_

**Hard-blocked (never):**

- **Any commit or push on `main` or `dev`** — branch first. These are deploy branches; a commit/push there is a deploy.
- Force-push (`-f` / `--force` / `--force-with-lease`, `--all`/`--mirror`), `git push origin --delete`, `git reset --hard`, `git clean -f`, `git branch -D`. `pnpm bot push --after-rebase` is the one sanctioned lease.
- **`.secrets/`** — never read, print, copy or search it, by any tool: it holds the bot's private key. The bot CLI reads it in-process; hooks deny Bash and Read/Grep/Glob on it.
- `gh pr merge` / `gh pr review` — approving and merging are the user's.
- `rm -rf`, and raw HTTP against `api.github.com` (use `gh`; the one exception is the bot CLI's in-process `fetch`, `scripts/src/bot/api.ts`).
- **Local deploys** — `cdk deploy` / `cdk destroy`. Deploys go through CI — on push to `main`, or the bot's dispatched dev deploy; local deploy is off-path. (`cdk diff` / `cdk synth` are fine.)

Merges to `main` happen via PR, not a local push.

**Commit messages: one lowercase line, past tense, 4–5 words — 6 is the hard max.** A hyphenated word counts as one; filenames and acronyms keep their case. No blank line, no body, no trailers — including `Co-Authored-By` and `Claude-Session` (Claude Code's harness adds them by default; this rule overrides that). Say what the change did: `fixed cache policy ttl`, `added oauth metadata facade`, `retuned palette for contrast`. Context that needs recording belongs in `docs/` or the PR body, not the commit. `.claude/hooks/precommit-guard.sh` enforces this — it denies a `git commit` whose message breaks it.

**PR bodies: Claude writes the body to a file, the user opens the PR** — a squash commit's author is the PR opener, so `main` stays the user's. Write the body to the worktree's `localNotes/pr-<branch>.md` (gitignored, survives the session), keep it current as the branch changes, and on the all-clear `pnpm bot push`, then hand the user, run from the worktree path, `gh pr create --title "<title>" --body-file localNotes/pr-<branch>.md` (until the mac-sim bridge opens PRs for them). A branch that changes `.github/workflows/` can't be pushed by the bot — then the user's command also starts with `git push -u origin <branch>` (after a rebase, `git push --force-with-lease -u origin <branch>`). **Never write `#<number>` in a PR body or title unless you mean to link that PR or issue** — GitHub autolinks every one, so a test count, a step number, or a merged-PR mention becomes a bogus link. Say "PR 33" or use a date instead. Prefixes like `lc#day` are fine (a letter follows the `#`).

## Claude behavior

- **Consult before big or irreversible actions**, and before deep research/exploration. Don't go off alone.
- **Aperture MCP connector.** When an `aperture-*` MCP server is registered (`claude mcp list`), its tools read and write the user's **live** Aperture data — tasks, calibration, LeetCode, calendar, attachments. **`aperture` is prod — the user's real data and the default for any real task work. `aperture-dev` is for testing Aperture changes only** (e.g. verifying a dev deploy); never log real tasks there, and say which one you're using. A write hits DynamoDB directly and can create real Google Calendar events / S3 files. **Reads are free. Every write requires the user's explicit, in-the-moment approval — no exceptions.** Never write unprompted or inferred, and if running unattended (e.g. overnight) do **no** writes at all — a write happens only when the user explicitly asks for that specific write, then you do it. `complete_task` requires `actualMin`. Full surface: `docs/areas/mcp/index.md`. **Two narrow standing approvals, nothing else:** (1) on prod, the one `CC blocked` / `CC done` task per session (_Feature workflow_ → _Autonomous_) — create, update and delete it **by its id, recorded in the worktree's `localNotes/decisions.md` when created** (it survives compaction there), allowed even unattended; (2) on `aperture-dev`, deleting a task whose id `.claude/hooks/mcp-dev-ledger.sh` recorded from a create response — the hook denies any other id. Approval (2) holds **only in a session where that hook is registered** (`/hooks` lists it — a worktree branched before it merged, or a session started before, has no guard); otherwise ask. Never clean up by title or marker word.
- **Don't write code that wasn't asked for.** Diagnosis, research, and a proposal are the deliverable until the user says to implement. "Continue" means continue what was asked — it is not license to start editing.
- **When rebasing or pulling in others' merged work, read the PR(s) first.** Before `git rebase origin/main` (or building on top of freshly-merged branches), read the body of each PR that landed since you branched — `gh pr view <n>` — so you know what's being introduced. Rebasing blind means building on changes you haven't seen: the conflict you resolve or the contract you call may have moved for a reason the PR explains.
- **The `Plan` agent is mandatory above 5 files. No judgment call, no exceptions.** Count the files the change will touch; if it is more than 5, spawn `Plan` _before the first edit_, take its plan, then edit. Distrust the plausible rationalisations ("well understood", "only just over", "obvious design", "already researched") — each is the moment the rule is for. Skipping it once turned a two-line storage fix into three rounds of review findings, each round's fixes introducing new bugs. When in doubt, spawn it: a plan pass is cheap, rewriting logic you have already defended is not. The feature workflow (below) always runs it, whatever the count.
- **Running the `Plan` agent: collaborative asks which model; autonomous runs it on `fable`** unless the kickoff names another. In collaborative mode never pick silently: the user usually wants `fable`, but token budget varies, so it must be a deliberate choice each time.
- **Reviews go through the `code-reviewer` agent** (project-aware) — not inline reading. Run it before committing anything non-trivial.
- **Non-trivial external research → the `search-specialist` agent.** Single-fact lookups can use `WebSearch`/`WebFetch` directly. Codebase search is `Explore`'s job.
- **Keep `docs/index.md` current.** Add or update a doc's one-line entry there in the same change — a doc missing from the index is undiscoverable.
- **Version awareness:** always check the registry for the actual latest version before pinning a package — `npm view <pkg> version` (a read-only registry query; fine even though installs are pnpm-only). Never guess versions from memory.
- **A piped command hides its exit code.** `pnpm typecheck | tail` reports success even when the typecheck never ran — the exit status you see belongs to `tail`. Before reporting any pass/fail, use `set -o pipefail` and echo `${PIPESTATUS[0]}`. This produced a false "it passed" here on 2026-09-07.
- **Can't reach a resource? Ask the user to run the command — don't guess or give up.** The container has no AWS CLI (and no AWS creds), and the same goes for anything else behind an access boundary: live AWS state (CloudWatch logs, SSM params, DynamoDB rows), a deployed endpoint, a dashboard, a third-party console. Hand the user the exact command(s) to run and read back the output — they are your hands on that resource. Same "verify, don't assert" discipline: reason from real output, not from an assumption about what the resource contains. The deployed dev app and its API are the exception: the dev check reaches them as the test user (`docs/ops/DEV-CHECK.md`). And dev CloudWatch logs: `pnpm bot logs` (dev groups only, at most 10 fetches an hour; then stop and say so). Prod logs stay the user's to run.
- **Share the container through the board — never by doing less.** Before heavy work (the gate, a dev server, the headless UI pass), glance at `scripts/board/board.sh status`; if the board says another session is near the edge, wait or serialise, but never skip tests or the UI pass to fit. How it works: `docs/ops/SESSION-BOARD.md`.

### Feature workflow

Every feature runs the same phases. **Two modes**, and the user names which:

- **Collaborative (default).** Claude stops at decision points: Plan's questions come back for discussion, and review findings that need a product call or add scope come back as a list.
- **Autonomous (only when the user says so).** Claude makes every decision itself — it never stops or hands one back. Make the best call from `PRODUCT.md`, the plan, and real day-to-day use (`docs/product/EvaluatingChanges.md`), then act; for new scope that may be building it or deciding "not now" as a noted follow-up. Log **every** decision — Plan answers included — in the worktree's `localNotes/decisions.md`: what came up, what was chosen, why, and how to undo it. Present the log at the end of development; the PR body summarises it. Parking is only allowed _as_ a logged decision, never a quiet "ask later".
  - **"Build it, autonomous" is the execute.** Rounds come from Plan's file count — under 10 files → 1, 10–30 → 2, over 30 → 3. Risk overrides size: auth, IAM/cdk, finance, migrations or external-service writes → at least 2. If the last planned round still finds real bugs, one extra round, logged, never more. A number in the kickoff wins.
  - **Every plan opens with _Operator steps_** — the exact one-line Mac commands, in order, each marked before Build / at dev test / at PR (the `dev` push only when Claude asks for it, after taking the dev lease — phase 8). The pause before Build is the only planned one.
  - **Blocked anyway** (a user-only command, a stuck environment, an undecidable call): send a push notification and create one prod `aperture` task `CC blocked: <branch> — <need>` (category Aperture, the commands in its notes, due today at now + 5 minutes so it lands on the calendar). One per session: a new blocker updates it by id and moves the due time; delete it once unblocked.
  - **Dev test is Claude's after the push:** run `pnpm devcheck --tier full` (it waits for the deploy itself), Read the screenshots. A green full run with zero leftovers plus that review is the all-clear (phase 9). On `DEV_CHANGED_MID_RUN`, main won: read the merged PRs, rebase, gate, re-take the dev lease and ask for the push again (once bot dev deploys are on: `pnpm bot deploy-dev`), rerun.
  - **Finished:** push notification, a `CC done: <branch> — PR ready` task (summary + happy-path test in its notes), and the report below.

Phases:

1. **Worktree** — off `origin/main` (_Git workflow_ → _One worktree per feature_).
2. **Plan** — the `Plan` agent; collaborative: ask which model; autonomous: `fable` unless named.
3. **Questions** — collaborative: discuss them. Autonomous: answer and log them.
4. **Build** — only on the user's "execute" plus a number of review rounds (n). When asking for n, give a rough estimate of how many files the change will touch — a gauge of size, not a commitment. While building, after each section run the touched files' tests (`vitest run <file>`) and a typecheck. Autonomous: n per the sizing rule above, logged.
5. **Gate** — full `pnpm typecheck`, `pnpm lint`, `pnpm test`, in sequence, each under `scripts/board/heavy.sh --`, real exit codes (`pipefail`). Nothing goes to a subagent on a red gate.
6. **Review round** — the read-only `code-reviewer` (no tests, no servers) in parallel with whatever each touched package adds:

   | Touched           | Adds                                                                                                                                                                                                                                                  |
   | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `app/`            | Headless UI agent (`run-app` skill, stub + auth bypass) driving a concrete checklist from the plan, at phone width in light and dark. Screenshots → the worktree's `localNotes/screenshots/round-<n>/`.                                               |
   | `lambdas/`        | No second agent — the node-env handler tests are the runtime proof and the gate ran them. The reviewer gets a backend checklist: writes only via the handler's `writes` object, external calls only via gated gateways, JWT + origin-secret handling. |
   | `cdk/`            | Synth pass: `cdk synth`, diff the template against `origin/main`'s, report changed resources, IAM grants, cdk-nag findings. No creds needed; never alongside tests.                                                                                   |
   | `packages/shared` | The contract both sides build on — the `app/` and `lambdas/` rows both apply, and the reviewer checks both callers.                                                                                                                                   |

   When the round is back, fix real bugs and convention breaks. Findings that need a product call or add scope: collaborative → a list for the user; autonomous → decide and log. Then the gate runs again, which also starts the next round.

7. **Ready for dev** — after n rounds: committed on the feature branch (one commit after the build, one per round's fixes), gate green, PR body current.
8. **Dev test** — first make sure the branch sits on the latest `origin/main`; if main moved, read the merged PRs and rebase (_Claude behavior_, above), then re-run the gate. Then `pnpm bot push`, and get the branch onto dev: once bot dev deploys are on (`DEV_DEPLOY_ISOLATED`, _Git workflow_), `pnpm bot deploy-dev` — the dev lock stays held through dev testing, and a `.github/`-changing branch is dispatched on its own ref so its workflows run; until then take the session board's dev lease, `scripts/board/board.sh lease acquire dev` — another session's lease (exit 3) means wait: tell the user who holds it and until when, never `--force` it or ask for the push over it; if taking an expired lease prints a `SendMessage` for the old holder, send it. The lease renews only on a user prompt (45-minute TTL), so re-run that `acquire` before every devcheck and every request for a `dev` push, phase 9 and reruns included — for the holder it's a renew, and exit 3 means it was lost: wait as above. Then hand the user, run from the worktree path, `git push --force origin <branch>:dev` (Claude never pushes to `dev`). A branch that changes `.github/workflows/` is pushed by the user either way (the bot has no `workflows` permission). **Such a branch never skips this phase:** PR checks never run the deploy workflows, so a green `dev` deploy run is the only proof they even start. For a changed reusable workflow, check who else calls it (`scripts/src/workflow-permissions.test.ts` checks caller permissions). Also hand the user `code <Mac worktree path>`, so the user can read the code themselves, and a short checklist of what matters most to test on dev for this feature: a handful of items, not the review checklist. Then run the dev check yourself — `pnpm devcheck --tier full`, plus a `scenarios/<feature>.ts` for what the feature changed (`docs/ops/DEV-CHECK.md`) — and Read its screenshots. Autonomous: while bot dev deploys are off, the `dev` push is the user's (an operator step); everything else is Claude's.
9. **Dev feedback** — ask how dev testing went. Fixes go back through the gate (plus a review round if non-trivial), then back to dev (phase 8 — re-take the dev lease first). Repeat until the user gives the all-clear. Autonomous: the all-clear is the green full run.
10. **PR** — on the all-clear, `pnpm bot lock release` and `scripts/board/board.sh lease release dev` (whichever is held; exit 3 from `lease release` means another session has it now — leave it), `pnpm bot push`, then hand over the `gh pr create` command (_Git workflow_ → _PR bodies_). A push to an open PR after a rebase is `pnpm bot push --after-rebase` (a `.github/workflows/` branch: the user's `git push --force-with-lease -u origin <branch>`).
11. **Cleanup** — once `gh pr view <branch>` shows it merged, confirm with the user, then: copy the worktree's `localNotes/` to `/workspace/localNotes/archive/<branch>/`; from `/workspace`, `git worktree remove .claude/worktrees/<branch>`; hand the user `git branch -D <branch>` (hard-blocked for Claude; squash merges make `-d` refuse).

**Every feature ends with `localNotes/report-<branch>.md`**, either mode, written even when the run never reached a PR (a run that stops before phase 10 releases its dev lease first): status first (PR ready / blocked / failed, and why), what the feature is, what happened (build, rounds, dev check, decisions), a short happy-path test the user can run themselves, key screenshots (relative links into `localNotes/`). The last message links it (Mac path) and sends it to the phone.

Page-first still holds: a backend half usually follows a frontend that already passed its rounds, so the plan says which half this is, and the reviewer checks the lambda against the contract the stub set.

### Before concluding "X can't do Y"

A wrong conclusion survived weeks and a night of work here, and each step below is where it should have died. Full write-up: `docs/ops/COI-INCIDENTS.md` → Incident D → _Fix_ → the 2026-09-07 correction.

- **Check the tool's own surface first.** Never write "X doesn't support Y" into a doc — or build a workaround for it — without first running the thing that would disprove it (`coi --help` was one command).
- **Remove your own workaround before re-testing.** While a fix is installed, the original question is unfalsifiable. Take it out, then measure.
- **Don't inherit a test's success criterion unexamined.** On a negative result, ask what the check really measures before building on it.
- **Mark inference as inference.** State what was observed, then what you concluded from it, separately — so the next reader can re-derive rather than inherit.

## Writing style

Operator-level and tight. State what you observed, form a working assumption, ask only for the missing piece. When asked to explain architecture, use ascii art and analogies if appropriate. Short paragraphs, no generic architecture lectures. Confident, not absolute.

## Coding style

- Single-statement functions on one line when short and readable. Single-line guards: `if (!data) return null;`.
- Simple `//` comments, not JSDoc blocks. Don't repeat what the code already says.
- Match the surrounding code's naming, comment density, and idiom.
