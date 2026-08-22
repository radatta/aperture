# Aperture

A personal life-OS PWA — one place for everything digital about me. Web-first, installable, multi-device. Its #1 job is a morning + night ritual (glance, plan, reflect); the signature move is **calibration** — surfacing the gap between what a task was *estimated* to take and what it *actually* took.

Product is the source of truth: `docs/PRODUCT.md`. Full doc map: `docs/index.md`.

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
| `pnpm dev` | Run the app (Vite) → http://localhost:5173 |
| `pnpm typecheck` | `tsc -b` across the project-reference graph |
| `pnpm lint` / `pnpm lint:fix` | ESLint (flat config), one root pass |
| `pnpm test` | Vitest across all packages (`pnpm -r`) |
| `pnpm build` | Production build (`pnpm -r`) |
| `pnpm format` | Prettier write |

**Inside the COI container (the usual case), three things bite:**

- **`pnpm install` needs `CI=true`** or it aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- **`node_modules` is shared with the macOS host** — `/workspace` is a virtiofs mount and
  `node_modules` isn't separately mounted, so native binaries belong to whichever side installed
  last. If `vite dev`/`vite build` dies with `Cannot find module '../lightningcss.*.node'`, that's
  this. `pnpm install` fixes it for the current platform (and breaks the other side until they do the
  same). Doesn't affect `tsc` or `vitest`.
- **Don't run `pnpm test`, a dev server, and headless Chromium at once** — 12 GiB / 6 CPUs, and
  **two different ceilings** bite here, which is why the crashes read as code bugs when they aren't:
  the **pids/thread** ceiling (`SIGABRT`/134 — a refused `clone()`, *not* memory) and memory itself
  (`SIGKILL`/137). A `tsgo` fatal has also been seen under load with the mechanism never confirmed —
  capture the **head** of the output, don't assume OOM. Serialise: screenshot, kill the browser,
  then test. Details: `docs/COI-INCIDENTS.md`.

Runbook: `docs/COI-SANDBOX.md`. Post-mortems (pids/`SIGABRT`, sleep, mounts): `docs/COI-INCIDENTS.md`.

## Conventions (hard rules — these override defaults)

Full detail in `docs/CONVENTIONS.md`. The load-bearing ones:

- **pnpm only.** `pnpm install`, `pnpm -r`, `pnpm dlx` (not npx).
- **First-principles dependency discipline.** Default to rolling our own. Only propose a dependency when EITHER (A) it's substantial hard-to-own logic, OR (B) it's security-critical / subtle-correctness / hard cross-platform edges we shouldn't hand-roll. When proposing one, justify against A/B explicitly, note its footprint + transitive deps, and state the roll-our-own alternative. **"It's popular" is not a reason.**
- **Build order: page-first, backend-second.** Build `app/` against a stubbed API and validate the UX in-hand *before* wiring the Lambda + DynamoDB behind the same contract.
- **Workspace packages resolve from source.** `packages/shared` exports `./src/index.ts`; app and lambdas import it directly and their bundler transpiles it — no build step in the dev/test loop. (`shared` still emits a gitignored `dist/` only to satisfy TS project references; nothing imports it.)
- **One test runner: Vitest.** jsdom env for `app/`, **node env for `lambdas/`** so tests match the Lambda's prod runtime exactly.
- **Dates/times via a shared helper** — never inline `Date` math or raw ISO strings in a component.

## Architecture

```
React PWA (S3 + CloudFront) --Cognito JWT--> Lambda Function URL (OAC) --> DynamoDB
```

Same-origin `/api/*` via CloudFront OAC (no CORS). In-handler Cognito JWT validation. Single-table DynamoDB (PITR + RETAIN). CDK IaC. GitHub Actions + OIDC — **no static credentials anywhere.** dev + prod. Details: `docs/TECH.md`, `docs/INFRA.md`.

**Writes discipline (BFF):** every external write (POST/PUT/PATCH/DELETE) is declared in one `writes` object at the top of the handler and nowhere else — helpers call functions passed in via `writes`, never write APIs directly. Single audit point; guarantees no writes fire during any test/smoke run.

## Git workflow

**GitHub Flow.** Feature branch → PR → squash-merge to `main`. Merging to `main` runs the pipeline (lint/typecheck/test → deploy dev → approval → deploy prod). Pushing to `dev` does a one-off dev deploy. PRs run checks only.

**`main` and `dev` are both deploy branches.**

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

## Claude behavior

- **Consult before big or irreversible actions**, and before deep research/exploration. Don't go off alone.
- **Use the `Plan` agent when a task will touch more than ~5 files** — design in an isolated context first, return with a concrete plan, then edit.
- **Reviews go through the `code-reviewer` agent** (project-aware) — not inline reading. Run it before committing anything non-trivial.
- **Non-trivial external research → the `search-specialist` agent.** Single-fact lookups can use `WebSearch`/`WebFetch` directly. Codebase search is `Explore`'s job.
- **Keep `docs/index.md` current.** Add or update a doc's one-line entry there in the same change — a doc missing from the index is undiscoverable.
- **Version awareness:** always check the registry for the actual latest version before pinning a package — `npm view <pkg> version` (a read-only registry query; fine even though installs are pnpm-only). Never guess versions from memory.

## Writing style

Operator-level and tight. State what you observed, form a working assumption, ask only for the missing piece. Short paragraphs, no generic architecture lectures. Confident, not absolute.

## Coding style

- Single-statement functions on one line when short and readable. Single-line guards: `if (!data) return null;`.
- Simple `//` comments, not JSDoc blocks. Don't repeat what the code already says.
- Match the surrounding code's naming, comment density, and idiom.
