# Aperture

A personal life-OS PWA — one place for everything digital about me. Web-first, installable, multi-device. Its #1 job is a morning + night ritual (glance, plan, reflect); the signature move is **calibration** — surfacing the gap between what a task was *estimated* to take and what it *actually* took.

Product is the source of truth: `docs/product/PRODUCT.md`. Full doc map: `docs/index.md`.

## Project structure

pnpm monorepo (workspaces in `pnpm-workspace.yaml`):

- `app/` — React + Vite + TypeScript PWA (the product).
- `lambdas/` — AWS Lambda BFF.
- `cdk/` — CDK infrastructure.
- `packages/shared/` — the cross-cutting contract (types shared between app and lambdas).
- `scripts/` — dev/CI utilities.
- `docs/` — specs and cross-cutting rules (start at `docs/index.md`).
- `localNotes/` — gitignored scratch; never tracked.

## Commands

**pnpm only — never npm or yarn.** Requires Node 22 (`.nvmrc`).

| Command | Does |
| --- | --- |
| `pnpm dev` | Run the app (Vite) → `http://localhost:5173`, or `6173` inside a COI container (`docs/ops/COI-SANDBOX.md` → *Ports*). Vite walks upward if taken — read the port, don't assume it. |
| `pnpm typecheck` | `tsc -b` across the project-reference graph |
| `pnpm lint` / `pnpm lint:fix` | ESLint (flat config), one root pass |
| `pnpm test` | Vitest across all packages (`pnpm -r`) |
| `pnpm build` | Production build (`pnpm -r`) |
| `pnpm format` | Prettier write |

**Inside the COI container (the usual case), four things bite:**

- **Never put a reverse-shell literal on a Bash command line — it kills the container.** COI's monitor
  matches a hardcoded list: `python -c` / `python3 -c`, `perl -e`, `php -r`, `ruby -e`, `bash -i`,
  `sh -i`, `nc -e`, `socat`, `/dev/tcp/`. A match is **CRITICAL**, and `auto_kill_on_critical` kills
  the whole container (no latch — it repeats; `docs/ops/COI-INCIDENTS.md` → Incident F). For the interpreter one-liners the "is this network related?" gate is satisfied
  by **any `:` in the command** (a dict, a slice like `v[-5:]`, a URL, a timestamp — every JSON
  one-liner). Use `python3 - <<'PY' … PY` (runs as `python3 -`, not on the list) or `jq`. **This
  applies to the literal text anywhere in the command**, including test fixtures and echoed strings —
  file contents mentioning these belong in the Write/Edit tools, not a Bash heredoc.
  `.claude/hooks/coi-reverse-shell-guard.sh` enforces this; the rule stands whether or not it's registered.

- **`pnpm install` needs `CI=true`** or it aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- **`node_modules` is shared with the macOS host** — native binaries belong to whichever side installed
  last. `vite dev`/`vite build` dying with `Cannot find module '../lightningcss.*.node'` is this;
  `pnpm install` fixes it for the current platform (and breaks the other side until they do the same).
  Doesn't affect `tsc` or `vitest`. Mechanism: `docs/ops/COI-INCIDENTS.md` → Incident B → *Related*.
- **Don't run `pnpm test`, a dev server, and headless Chromium at once** — 12 GiB / 6 CPUs, and
  **two different ceilings** bite, which is why the crashes read as code bugs when they aren't: the **pids/thread** ceiling (`SIGABRT`/134 — a refused `clone()`,
  *not* memory; `docs/ops/COI-INCIDENTS.md` → Incident A) and memory itself (`SIGKILL`/137). A `tsgo`
  fatal has also been seen under load with the mechanism never confirmed — capture the **head** of the
  output, don't assume OOM (`docs/ops/COI-SANDBOX.md` → *Ops notes* → *Transient `tsc` crashes*).
  Serialise: screenshot, kill the browser, then test.

Runbook: `docs/ops/COI-SANDBOX.md`. Post-mortems (pids/`SIGABRT`, sleep, mounts): `docs/ops/COI-INCIDENTS.md`.

## Conventions (hard rules — these override defaults)

Full detail in `docs/product/CONVENTIONS.md`. The load-bearing ones:

- **pnpm only.** `pnpm install`, `pnpm -r`, `pnpm dlx` (not npx). **Its version comes from `packageManager` in the root `package.json`, via corepack — nothing else.** Never pin pnpm in a machine-global tool manager: CI (`.github/workflows/ci.yml`) resolves it from that field, so a second declaration is only a second thing to drift out of sync with CI (the mise trap: `docs/ops/COI-SANDBOX.md` → *Start here → 1*).
- **First-principles dependency discipline.** Default to rolling our own. Only propose a dependency when EITHER (A) it's substantial hard-to-own logic, OR (B) it's security-critical / subtle-correctness / hard cross-platform edges we shouldn't hand-roll. When proposing one, justify against A/B explicitly, note its footprint + transitive deps, and state the roll-our-own alternative. **"It's popular" is not a reason.**
- **Build order: page-first, backend-second.** Build `app/` against a stubbed API and validate the UX in-hand *before* wiring the Lambda + DynamoDB behind the same contract.
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

**`main` and `dev` are both deploy branches** — but they are not alike. `main` is protected and permanent. **`dev` is scratch: the user force-pushes it routinely to get a branch onto real infrastructure, and that is the intended workflow.** Its history is disposable and nothing ever merges out of it.

So when a branch can't fast-forward onto `dev`, **do not propose merging `origin/dev` into it, rebasing onto it, or creating a temporary worktree** — the answer is that the user force-pushes over it. Claude still never pushes to `dev` at all (see Hard-blocked); the point is to stop inventing workarounds for a problem the user solves in one command.

### Claude drives git — guarded

Claude handles branches, commits, and PRs. **Allowed** git commands:

- `git status`, `git diff`, `git log`, `git branch`, `git show`
- `git switch -c` / `git checkout -b`, `git switch`, `git checkout <file>`
- `git add`, `git commit`, `git stash`
- `git push` **to a feature branch only** (sets upstream on first push)
- `git fetch`, `git rebase origin/main`, `git mv`

**Hard-blocked (never):**

- **Any commit or push on `main` or `dev`** — branch first. These are deploy branches; a commit/push there is a deploy.
- Force-push (`-f` / `--force` / `--force-with-lease`), `git push origin --delete`, `git reset --hard`, `git clean -f`, `git branch -D`.
- `rm -rf`, and raw HTTP against `api.github.com` (use `gh`).
- **Local deploys** — `cdk deploy` / `cdk destroy`. Deploys go through CI on push to `main`; local deploy is off-path. (`cdk diff` / `cdk synth` are fine.)

Merges to `main` happen via PR, not a local push.

**Commit messages: one lowercase line, past tense, 4–5 words — 6 is the hard max.** A hyphenated word counts as one; filenames and acronyms keep their case. No blank line, no body, no trailers — including `Co-Authored-By` and `Claude-Session` (Claude Code's harness adds them by default; this rule overrides that). Say what the change did: `fixed cache policy ttl`, `added oauth metadata facade`, `retuned palette for contrast`. Context that needs recording belongs in `docs/` or the PR body, not the commit. `.claude/hooks/precommit-guard.sh` enforces this — it denies a `git commit` whose message breaks it.

**PR bodies: Claude writes the body to a file, the user opens the PR.** The container's GitHub token is read-only, so the push and `gh pr create` happen on the Mac. Write the body to `localNotes/pr-<branch>.md` (gitignored, survives the session), keep it current as the branch changes, and when the user says they're ready hand them the exact commands: `git push -u origin <branch>` and `gh pr create --title "<title>" --body-file localNotes/pr-<branch>.md`. **Never write `#<number>` in a PR body or title unless you mean to link that PR or issue** — GitHub autolinks every one, so a test count, a step number, or a merged-PR mention becomes a bogus link. Say "PR 33" or use a date instead. Prefixes like `lc#day` are fine (a letter follows the `#`).

## Claude behavior

- **Consult before big or irreversible actions**, and before deep research/exploration. Don't go off alone.
- **Aperture MCP connector.** When an `aperture-*` MCP server is registered (`claude mcp list`), its tools read and write the user's **live** Aperture data — tasks, calibration, LeetCode, calendar, attachments. **`aperture` is prod — the user's real data and the default for any real task work. `aperture-dev` is for testing Aperture changes only** (e.g. verifying a dev deploy); never log real tasks there, and say which one you're using. A write hits DynamoDB directly and can create real Google Calendar events / S3 files. **Reads are free. Every write requires the user's explicit, in-the-moment approval — no exceptions.** Never write unprompted or inferred, and if running unattended (e.g. overnight) do **no** writes at all — a write happens only when the user explicitly asks for that specific write, then you do it. `complete_task` requires `actualMin`. Full surface: `docs/areas/mcp/index.md`.
- **Don't write code that wasn't asked for.** Diagnosis, research, and a proposal are the deliverable until the user says to implement. "Continue" means continue what was asked — it is not license to start editing.
- **When rebasing or pulling in others' merged work, read the PR(s) first.** Before `git rebase origin/main` (or building on top of freshly-merged branches), read the body of each PR that landed since you branched — `gh pr view <n>` — so you know what's being introduced. Rebasing blind means building on changes you haven't seen: the conflict you resolve or the contract you call may have moved for a reason the PR explains.
- **The `Plan` agent is mandatory above 5 files. No judgment call, no exceptions.** Count the files the change will touch; if it is more than 5, spawn `Plan` *before the first edit*, take its plan, then edit. Distrust the plausible rationalisations ("well understood", "only just over", "obvious design", "already researched") — each is the moment the rule is for. Skipping it once turned a two-line storage fix into three rounds of review findings, each round's fixes introducing new bugs. When in doubt, spawn it: a plan pass is cheap, rewriting logic you have already defended is not.
- **Running the `Plan` agent: ask which model, never default.** When the user asks to run `Plan` (or you're about to spawn it) without naming a model, ask which model first — don't pick one silently. The user usually wants `fable`, but token budget varies, so it must be a deliberate choice each time.
- **Reviews go through the `code-reviewer` agent** (project-aware) — not inline reading. Run it before committing anything non-trivial.
- **Non-trivial external research → the `search-specialist` agent.** Single-fact lookups can use `WebSearch`/`WebFetch` directly. Codebase search is `Explore`'s job.
- **Keep `docs/index.md` current.** Add or update a doc's one-line entry there in the same change — a doc missing from the index is undiscoverable.
- **Version awareness:** always check the registry for the actual latest version before pinning a package — `npm view <pkg> version` (a read-only registry query; fine even though installs are pnpm-only). Never guess versions from memory.
- **A piped command hides its exit code.** `pnpm typecheck | tail` reports success even when the typecheck never ran — the exit status you see belongs to `tail`. Before reporting any pass/fail, use `set -o pipefail` and echo `${PIPESTATUS[0]}`. This produced a false "it passed" here on 2026-09-07.
- **Can't reach a resource? Ask the user to run the command — don't guess or give up.** The container has no AWS CLI (and no AWS creds), and the same goes for anything else behind an access boundary: live AWS state (CloudWatch logs, SSM params, DynamoDB rows), a deployed endpoint, a dashboard, a third-party console. Hand the user the exact command(s) to run and read back the output — they are your hands on that resource. Same "verify, don't assert" discipline: reason from real output, not from an assumption about what the resource contains.

### Before concluding "X can't do Y"

A wrong conclusion survived weeks and a night of work here, and each step below is where it should have died. Full write-up: `docs/ops/COI-INCIDENTS.md` → Incident D → *Fix* → the 2026-09-07 correction.

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
