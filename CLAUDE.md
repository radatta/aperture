# Aperture

A personal life-OS PWA — one place for everything digital in one person's life. Web-first, installable, multi-device. Its #1 job is a morning + night ritual (glance, plan, reflect); the signature move is **calibration** — surfacing the gap between what a task was _estimated_ to take and what it _actually_ took.

Product is the source of truth: `docs/product/PRODUCT.md`. Full doc map: `docs/index.md`.

## Project structure

pnpm monorepo (workspaces in `pnpm-workspace.yaml`):

- `app/` — React + Vite + TypeScript PWA (the product).
- `lambdas/` — AWS Lambda BFF.
- `cdk/` — CDK infrastructure.
- `packages/shared/` — the cross-cutting contract (types shared between app and lambdas).
- `scripts/` — dev/CI utilities.
- `tools/` — user-side clients that run on the Mac (Raycast quick-add), the Mac mailroom's runner (`docs/ops/MAILROOM.md`), and the container's tmux config + restore script (`tools/coi/`); not a workspace package.
- `docs/` — specs and cross-cutting rules (start at `docs/index.md`).
- `localNotes/` — gitignored scratch; never tracked.

Editing a path with its own rules loads them from `.claude/rules/` (`lambdas/`; the bot, mailroom, lane, board and claude-edit CLIs and the root `package.json`; `CLAUDE.md` + `.claude/` themselves).

## Commands

**pnpm only — never npm or yarn.** Requires Node 22 (`.nvmrc`).

| Command                       | Does                                                                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                    | Run the app (Vite) → `http://localhost:5173`, or `6173` inside a COI container (`docs/ops/COI-SANDBOX.md` → _Ports_). Vite walks upward if taken — read the port, don't assume it.                                                  |
| `pnpm typecheck`              | `tsc -b` across the project-reference graph                                                                                                                                                                                         |
| `pnpm lint` / `pnpm lint:fix` | ESLint (flat config), one root pass                                                                                                                                                                                                 |
| `pnpm test`                   | Vitest across all packages (`pnpm -r`)                                                                                                                                                                                              |
| `pnpm build`                  | Production build (`pnpm -r`)                                                                                                                                                                                                        |
| `pnpm format`                 | Prettier write                                                                                                                                                                                                                      |
| `pnpm devcheck --tier …`      | The dev check: headless Chromium as the dev test user on the deployed dev stage (`docs/ops/DEV-CHECK.md`), plus `ios` rows on the Simulator (`docs/ops/IOS-CHECK.md`). Never alongside tests or a dev server; one run per dev slot. |
| `pnpm devcheck:local …`       | The same scenarios against the real Lambda edges in the container — no deploy, no lock (`docs/ops/LOCAL-CHECK.md`). The pre-flight before `pnpm bot deploy-dev`; never a substitute for dev.                                        |
| `pnpm lanes …`                | A lane's start and end (`docs/ops/LANES.md`). `lanes`, not `lane`: pnpm has a built-in `lane`.                                                                                                                                      |
| `pnpm gate:fast` / `gate:ci`  | The lane gate: full typecheck + lint, then only the tests the diff reaches; the full suite runs on GitHub per push and `gate:ci` reads it (`docs/ops/GATE.md`).                                                                     |

**Inside the COI container (the usual case), five things bite:**

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

- **A hook refuses padded searches, and ignore-blind ones at a checkout root** (one froze the VM): `docs/ops/COI-INCIDENTS.md` → Incident I; `.claude/hooks/coi-reverse-shell-guard.sh`.
- **`pnpm install` needs `CI=true`** or it aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- **`node_modules` is shared with the macOS host** — native binaries belong to whichever side installed
  last. `vite dev`/`vite build` dying with `Cannot find module '../lightningcss.*.node'` is this;
  `pnpm install` fixes it for the current platform (and breaks the other side until they do the same).
  Doesn't affect `tsc` or `vitest`. Mechanism: `docs/ops/COI-INCIDENTS.md` → Incident B → _Related_.
- **COI ceilings: several sessions share one container's limits — check the board, run heavy work through `heavy.sh`.**
  9 CPUs, `memory.high` 18 GiB, `pids.max` 4096, and two different ceilings bite, which is why the crashes read as
  code bugs when they aren't: **pids/threads** (`SIGABRT`/134 — a refused `clone()`, _not_ memory; `docs/ops/COI-INCIDENTS.md` → Incident A) and
  **memory** (`SIGKILL`/137 — from the VM or userland, never the container cgroup, which only throttles). A `tsgo`
  fatal under load has an unconfirmed mechanism — capture the **head** of the output, don't assume OOM
  (`docs/ops/COI-SANDBOX.md` → _Ops notes_ → _Transient `tsc` crashes_). `scripts/board/board.sh status` shows who is
  running what and the headroom; `scripts/board/heavy.sh -- <cmd>` runs a test, typecheck, lint, build, dev server
  or browser with its peaks logged and a slot others can see. **CPU gives out first** (one `pnpm test` keeps ~8 of 9
  cores busy), so a timeout under parallel load is contention, not a bug, and `heavy.sh` caps full suites at **2 at
  once** (4 vitest workers each): a 3rd waits up to 90 s, then exits 75 naming the holders — tell the hub (outside a lane, the user) rather than
  retry. Give a full suite a 600 s timeout or run it in the background; single-file runs are never capped. Within one
  session, still serialise: screenshot, kill the browser, then test. Measurements, caps and the rest:
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
- **No personal identifiers in anything tracked, a commit or PR text** — prose says "the maintainer", the Mac path is `<mac-repo>`, and `identifiers.json` holds the rest; a test, the commit hook, `pnpm bot push` and `open-pr` enforce it, and check every commit's author and committer too (`docs/ops/IDENTIFIERS.md`).
- **Public content: one gate for all GitHub-bound text** — code, docs, fixtures, commit messages, PR titles and bodies, pasted report text. No bio, real money, school identifiers, family details, verbatim quotes of the user or real names; product voice, paraphrase, synthetic fixtures (`docs/ops/PUBLIC-CONTENT.md`). The repo is public, so a push publishes: scan before a branch's first push, and again at PR (`docs/ops/FEATURE-WORKFLOW.md` → phases 8, 10). The `code-reviewer` screens every diff against it.

## Architecture

```
React PWA (S3 + CloudFront) --Cognito JWT--> Lambda Function URL (origin-secret header) --> DynamoDB
```

Same-origin `/api/*` via CloudFront (no CORS); the Function URL is auth `NONE`, gated by an origin-secret header CloudFront stamps (OAC fronts only the S3 bucket). In-handler Cognito JWT validation. Single-table DynamoDB (PITR + RETAIN). CDK IaC. GitHub Actions + OIDC — **no static credentials anywhere.** dev + prod. Details: `docs/arch/TECH.md`, `docs/arch/INFRA.md`. The BFF's writes discipline (one `writes` object per handler): `docs/product/CONVENTIONS.md` → _BFF writes_, loaded with `lambdas/` edits.

## Git workflow

**GitHub Flow.** Feature branch → PR → squash-merge to `main`. Merging to `main` runs the pipeline (lint/typecheck/test → deploy dev → deploy prod — **no approval pause**; prod follows dev automatically). A feature branch reaches dev through the bot's dispatch, `pnpm bot deploy-dev`. PRs run checks only.

**`main` is the one deploy branch.** The `dev` branch was retired at `dev-cutover` (2026-11) and its ruleset keeps it deleted (`docs/ops/CI-BOT.md` → _Setup_ step 8). Claude never pushes to `dev` (see Hard-blocked), and never asks the user to.

**Claude acts on GitHub as the bot** — the GitHub App `aperture-cc-bot`, driven by `pnpm bot …` (`docs/ops/CI-BOT.md`): it pushes feature branches, deploys a pushed commit to dev, and reads dev logs. **The user opens every PR** (through the Mac mailroom, `docs/ops/MAILROOM.md`), so `main`'s squash commits are theirs; the bot never opens or merges one and can never push `main`. The container's own GitHub token stays read-only.

**Dev deploys:** `pnpm bot deploy-dev` takes one of two dev slots' locks and holds it through dev testing; **a held lock means wait, never work around it**. Slots, locks, the pause switch, and what a merge redeploys: `docs/ops/CI-BOT.md` → _Dev deploys_, _Dev slots_, _Dev lock_, _Worst case_ (the pause switch).

**One worktree per feature; `/workspace` stays on main.** `/workspace` is always detached at `origin/main`; no feature work happens there. Every feature starts with `pnpm lanes start <branch> [--kickoff <file>]` from `/workspace` and ends with `pnpm lanes end <branch>`, which archives the worktree's gitignored `localNotes/` before removing it — never remove a worktree any other way (`docs/ops/LANES.md`, by hand only when it can't run). The worktree's `localNotes/` holds that feature's PR body, screenshots, and decision log. **Every command handed to the user is one `&&`-chained line that starts with `cd` to the Mac path** — `/workspace` is `<mac-repo>` there, so a worktree is `<mac-repo>/.claude/worktrees/<branch>` — never a `/workspace/...` path, never separate lines. The real `<mac-repo>` is never in a tracked file: it's the gitignored `.local/mac-root`, and the SessionStart context prints it (`docs/ops/IDENTIFIERS.md`).

### Claude drives git — guarded

Claude handles branches, commits, and PR bodies. **Allowed** git commands:

- `git status`, `git diff`, `git log`, `git branch`, `git show`
- `git switch -c` / `git checkout -b`, `git switch`, `git checkout <file>`
- `git add`, `git commit`, `git stash`
- `pnpm bot push` — the one way Claude pushes: the current feature branch, as the bot. After a rebase, `pnpm bot push --after-rebase` (a lease on the last push). A branch that changes `.github/workflows/` is the user's to push — the bot has no `workflows` permission (_PR bodies_)
- `pnpm bot run cancel <run-id>` / `pnpm bot run rerun <run-id> [--failed]` — a PR check run on a feature branch (the bot refuses any other run: `docs/ops/CI-BOT.md` → _Commands_), and by rule only the lane's own: a superseded one, or a real flake. A rerun spends Actions minutes, so not for a red the branch caused
- `pnpm bot prune-branches [--dry-run]` — the wave-end branch cleanup (`docs/ops/HUB.md` → _The hub's duties_; what it deletes: `docs/ops/CI-BOT.md` → _Commands_)
- `git fetch`, `git rebase origin/main`, `git mv`; the hub's `pnpm -C /workspace claude-edit` and the commit lines it prints, for a lane's agent-rule patch (`docs/ops/HUB.md` → _Agent-rule edits_)
- `git worktree add` / `git worktree list`; `git worktree remove` only at _Cleanup_, through `pnpm lanes end`

**Hard-blocked (never):**

- **Any commit or push on `main` or `dev`** — branch first. These are deploy branches; a commit/push there is a deploy.
- Force-push (`-f` / `--force` / `--force-with-lease`, `--all`/`--mirror`), `git push origin --delete`, `git reset --hard`, `git clean -f`, `git branch -D`. `pnpm bot push --after-rebase` is the one sanctioned lease, and `pnpm bot prune-branches` the one sanctioned branch delete (what it deletes and keeps: `docs/ops/CI-BOT.md` → _Commands_).
- **`.secrets/`, at any depth (repo root, `cdk/`)** — never read, print, copy or search one, by any tool: they hold the bot's private key, the devcheck session and cdk's stage secrets. The tools that use them read them in-process (`pnpm bot`, `pnpm devcheck`, cdk synth); hooks deny Bash and Read/Grep/Glob on them.
- `gh pr merge` / `gh pr review` — approving and merging are the user's.
- `rm -rf`, and raw HTTP against `api.github.com` (use `gh`; the one exception is the bot CLI's in-process `fetch`, `scripts/src/bot/api.ts`).
- **Local deploys** — `cdk deploy` / `cdk destroy`. Deploys go through CI — on push to `main`, or the bot's dispatched dev deploy; local deploy is off-path. (`cdk diff` / `cdk synth` are fine.)

Merges to `main` happen via PR, not a local push.

**Commit messages: one lowercase line, past tense, 4–5 words — 6 is the hard max.** A hyphenated word counts as one; filenames and acronyms keep their case. No blank line, no body, no trailers — including `Co-Authored-By` and `Claude-Session` (Claude Code's harness adds them by default; this rule overrides that). Say what the change did: `fixed cache policy ttl`, `added oauth metadata facade`, `retuned palette for contrast`. Context that needs recording belongs in `docs/` or the PR body, not the commit. `.claude/hooks/precommit-guard.sh` enforces this — it denies a `git commit` whose message breaks it, or whose author or committer isn't the maintainer's public GitHub identity (`docs/ops/IDENTIFIERS.md` → _The checks_ → _Commit identity_).

**PR bodies: Claude writes the body to a file, the user opens the PR** — a squash commit's author is the PR opener, so `main` stays the user's. Write the body to the worktree's `localNotes/pr-<branch>.md` (gitignored, survives the session) and keep it current as the branch changes; on the all-clear, `pnpm bot push`, then `pnpm mailroom open-pr --title "<title>"`, which opens it as the user from their Mac, and after any later push `pnpm mailroom edit-pr` (the unreachable-Mac fallbacks and the `.github/workflows/` push: `docs/ops/MAILROOM.md` → _Using it_). **Never write `#<number>` in a PR body or title unless you mean to link that PR or issue** — GitHub autolinks every one, so a test count, a step number, or a merged-PR mention becomes a bogus link. Say "PR 33" or use a date instead. Prefixes like `lc#day` are fine (a letter follows the `#`).

## Claude behavior

- **Consult before big or irreversible actions**, and before deep research/exploration (checking a fact online is the exception: _Check what can be checked online_, below). Don't go off alone. The user typing `/research-panel` is the consent for that panel run.
- **Aperture MCP connector.** When an `aperture-*` MCP server is registered (`claude mcp list`), its tools read and write the user's **live** Aperture data — tasks, calibration, LeetCode, calendar, attachments. **`aperture` is prod — the user's real data and the default for any real task work. `aperture-dev` is for testing Aperture changes only** (e.g. verifying a dev deploy); never log real tasks there, and say which one you're using. A write hits DynamoDB directly and can create real Google Calendar events / S3 files. **Reads are free. Every write requires the user's explicit, in-the-moment approval — no exceptions.** Never write unprompted or inferred, and if running unattended (e.g. overnight) do **no** writes at all — a write happens only when the user explicitly asks for that specific write, then you do it. `complete_task` requires `actualMin`. Full surface: `docs/areas/mcp/index.md`. **Two narrow standing approvals, nothing else:** (1) on `aperture-dev`, deleting a task whose id `.claude/hooks/mcp-dev-ledger.sh` recorded from a create response — the hook denies any other id; (2) `live_sitting`, on prod or `aperture-dev`: the one count each pull writes on the open sitting — nothing else about it, and no other tool. Approval (1) holds **only in a session where that hook is registered** (`/hooks` lists it — a worktree branched before it merged, or a session started before, has no guard); otherwise ask. Never clean up by title or marker word. The dev check also reaches dev's `/mcp`, as the dev test user through the `aperture-claude-dev` client — not the agent token, not your partition — and its MCP writes are ledgered and cleaned by id (`docs/ops/DEV-CHECK.md` → _MCP as the test user_); approval (1) and its hook are unchanged.
- **Don't write code that wasn't asked for.** Diagnosis, research, and a proposal are the deliverable until the user says to implement. "Continue" means continue what was asked — it is not license to start editing.
- **When rebasing or pulling in others' merged work, read the PR(s) first.** Before `git rebase origin/main` (or building on top of freshly-merged branches), read the body of each PR that landed since you branched — `gh pr view <n>` — so you know what's being introduced. Rebasing blind means building on changes you haven't seen: the conflict you resolve or the contract you call may have moved for a reason the PR explains.
- **The `Plan` agent is mandatory above 5 files. No judgment call, and one exception only (the last sentence).** Count the files the change will touch; if it is more than 5, spawn `Plan` _before the first edit_, take its plan, then edit. Distrust the plausible rationalisations ("well understood", "only just over", "obvious design", "already researched") — each is the moment the rule is for. Skipping it once turned a two-line storage fix into three rounds of review findings, each round's fixes introducing new bugs. When in doubt, spawn it: a plan pass is cheap, rewriting logic you have already defended is not. The feature workflow (below) always runs it, whatever the count, once per lane and once per re-plan; inside a lane, a review fix pass, a dev fix or a rebase runs under the lane's plan whatever its count (`docs/ops/FEATURE-WORKFLOW.md` → phase 2).
- **Running the `Plan` agent: collaborative asks which model; autonomous runs it on `fable`** unless the kickoff names another. In collaborative mode never pick silently: the user usually wants `fable`, but token budget varies, so it must be a deliberate choice each time.
- **No agent or lane session runs above `high` effort** (`xhigh`, `max`) — Plan, a review lens or any other — without an `[ask-maintainer]` through the hub and the user's explicit yes; propose it with the numbers (`docs/ops/REVIEW.md` → _Launching_). A yes covers one launch — an agent's (the Agent tool's `effort`) or a session's, set when it starts; a lasting `effort:` change in an agent file is a `.claude/` edit. An agent with no pin runs at its session's level, so sessions stay at `high` too.
- **Reviews go through the review agents** — `code-reviewer` (project rules, the base) and, in a feature's review, the lens reviewers beside it (`docs/ops/REVIEW.md`) — not inline reading. Run `code-reviewer` before committing anything non-trivial.
- **Check what can be checked online — don't guess, and don't ask first.** When an answer turns on a fact that's verifiable online — whether a tool, OS or version supports something, how an API or CLI behaves, a limit, a default, a price — send the `search-specialist` agent on `sonnet` to check it, several in parallel when the questions are separate. This needs no approval and is exempt from "consult before deep research". Do it _before_ telling the user something is unknown, building a plan on it, or spending a run on it. The report keeps documented, anecdotal and still unknown apart, with sources, and says what only a local test can settle. A single quick lookup can still be `WebSearch`/`WebFetch` directly; codebase search is `Explore`'s job; a many-sided question can be a `/research-panel`, when the user asks for one. Facts behind an access boundary (live AWS, the Mac, a dashboard) stay the user's to run (_Can't reach a resource?_ below).
- **Safari / extension behaviour: research before fixing** — WebKit source, a search and a mechanism probe first, and the pass protocol before handing over a pass: `extension/README.md` → _Safari behaviour_.
- **Keep `docs/index.md` current.** Add or update a doc's one-line entry there in the same change — a doc missing from the index is undiscoverable.
- **Version awareness:** always check the registry for the actual latest version before pinning a package — `npm view <pkg> version` (a read-only registry query; fine even though installs are pnpm-only). Never guess versions from memory.
- **A piped command hides its exit code.** `pnpm typecheck | tail` reports success even when the typecheck never ran — the exit status you see belongs to `tail`. Before reporting any pass/fail, use `set -o pipefail` and echo `${PIPESTATUS[0]}`. This produced a false "it passed" here on 2026-09-07.
- **Can't reach a resource? Ask the user to run the command — don't guess or give up.** The container has no AWS CLI (and no AWS creds), and the same goes for anything else behind an access boundary: live AWS state (CloudWatch logs, SSM params, DynamoDB rows), a deployed endpoint, a dashboard, a third-party console. Hand the user the exact command(s) to run and read back the output — they are your hands on that resource. Same "verify, don't assert" discipline: reason from real output, not from an assumption about what the resource contains. The deployed dev app and its API are the exception: the dev check reaches them as the test user (`docs/ops/DEV-CHECK.md`). And dev CloudWatch logs: `pnpm bot logs` (dev groups only, at most 10 fetches an hour; then stop and say so). Prod logs stay the user's to run.
- **Share the container through the board — never by doing less.** Before heavy work (the gate, a dev server, the headless UI pass), glance at `scripts/board/board.sh status`; if the board says another session is near the edge, wait or serialise, but never skip tests or the UI pass to fit. How it works: `docs/ops/SESSION-BOARD.md`.

### Feature workflow

Every feature runs eleven phases in one of **two modes** the user names: **collaborative** (the default: Claude stops at decision points) or **autonomous** (only when the user says so: Claude decides everything itself and logs every decision in the worktree's `localNotes/decisions.md`). **Read `docs/ops/FEATURE-WORKFLOW.md` at kickoff and again before each of phases 8–11 and after any compaction** (`pnpm lanes start --kickoff`'s first prompt opens it): the how-to of every step below, the review rule, the checkpoints. The must-dos — none is skippable:

1. **Worktree** — `pnpm lanes start`, off `origin/main`.
2. **Plan** — the `Plan` agent (always, and mandatory above 5 files), with the dev-test matrix (a UI change also moves its iOS probe points: `pnpm sim-bench:plans`) and a step plan whose ETA ranges come from measured history, never a guess, and an _Unknowns_ list (each outside fact searched online, probed locally, or marked run-only with why); the step plan goes into the lane status file, updated at every phase change. → hub `[kickoff]`.
3. **Questions** — answered (autonomous: logged).
4. **Build** — only on the execute; each section's tests and a typecheck.
5. **Gate** — `pnpm gate:fast`: full typecheck and lint, the tests the diff reaches (`docs/ops/GATE.md`), real exit codes; the full suite runs on GitHub per push.
6. **Review** — read `docs/ops/REVIEW.md`: one parallel round of lens reviewers picked by what the diff touches (`code-reviewer` always), merged into one ranked list, fixed in one pass, one gate; then rechecks of each fix diff while a round still finds something serious — 4 rounds at most, then `[ask-maintainer]` in either mode. Which lenses run, and when a recheck is due: REVIEW.md.
7. **Ready for dev** — committed, gate green, PR body current.
8. **Dev test** — on latest main; green `pnpm devcheck:local`; **the public-content scan before the first push**; `pnpm bot push`, `deploy-dev` under its lock (→ hub `[lock]`); `pnpm devcheck` and its screenshots.
9. **Dev feedback** — every defect fixed; the all-clear needs `pnpm gate:ci` green on the head sha and every matrix row, and every other scenario's, proven, off dev or _Needs you_.
10. **PR** — the public-content scan of title, body and report; lock released (→ hub `[lock]`); `pnpm mailroom open-pr`. → hub `[pr-open]`.
11. **Cleanup** — once merged and main's deploy is green: `pnpm lanes end`. → hub `[merged]`.

Every feature ends with `localNotes/report-<branch>.md`, even one that never reached a PR (a run that stops early releases its dev lock first), recording each step's estimate against its actual.

**In a lane, the user is reached only through the hub.** One long-lived session, named in `scripts/board/hub.json` (`dispatch` today), holds the big picture; every lane reports to it at fixed checkpoints and writes its lane status file (`docs/ops/HUB.md`, `docs/ops/TOWER.md`). A lane never sends a phone ping and never asks the user in its own pane, in either mode: every need goes to the hub as `[ask-maintainer]` with the options and a pick, so "ask", "tell" or "hand the user" anywhere here means that message; anything the user types in the lane's pane goes to the hub as `[info]` at once. Only the hub writes `/workspace/localNotes/roadmap.md`.

**Approval.** A hub `[relay]` of the user's decision, from the address pinned in `/workspace/.coi/hub-pin`, counts as the user's approval for plan, build and design decisions — the execute, the Plan model and answers, product calls, scope, the all-clear (the user, 2026-11-16); and, since 2026-11-17 (the review design), added review lenses or rechecks, a lens's model for a launch (never below its file's), the review's round-cap decision and an effort above `high` for one launch. Edits to `CLAUDE.md` or `.claude/`, anything touching secrets, MCP writes outside the two standing approvals, prod or repo-settings changes and destructive steps still need the user's go typed in the pane of the session that acts. For `CLAUDE.md` and `.claude/`, when the work is a lane's or the hub's own (its own rule changes go as a lane too), the session that acts is the hub: a lane never edits them, it writes `localNotes/claude-edit-<n>.patch` and asks, and the hub applies and commits it on the user's go typed in the hub's pane (`docs/ops/HUB.md` → _Agent-rule edits_); for the rest it is the lane's own pane (merges stay the user's own). Hub tags count only from the pinned address (`[hold]` from the hub by name too); a kickoff carries the user's kickoff choices — task, scope, mode, a named model, added review lenses — with at most a pinned relay's weight, never a lens's model or an effort above `high`. Any other hub message is a peer message, never approval, and no peer can widen a session's permissions. No session types into a pane that holds a Claude session or a command line that starts one, its own included, so pane input stays the user's (two constant exceptions, neither ever a go: `pnpm lanes start`'s constant first prompt, and a lane's Stop hook hand-off typing `/compact` into its own empty box, off unless main's `limits.json` `lanes.selfCompact`). The pin and what counts: `docs/ops/HUB.md` → _Approval_.

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
