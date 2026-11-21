# The plan (phase 2)

The shape of every lane's plan, so the plan carries its evidence and a reader can re-run it. The definitions of the
dev-test matrix, the step plan, the Unknowns list and Operator steps live in `docs/ops/FEATURE-WORKFLOW.md` → phase
2; this doc holds the row shapes, the light version and what runs after Plan. The `Plan` agent
(`.claude/agents/plan.md`) writes the plan; the lane saves it to `localNotes/plan.md`.

Why this shape: review rounds that ran long were mostly design flaws already visible in the plan, a reader or writer
the plan never listed, or an outside-tool fact assumed rather than checked. A model finds those when it must run
the search or fetch the page; asked only to "think harder" or critique itself without tools, it mostly doesn't.

## Full or light

Right under the plan's title, one line: `Template: full — <why>` or `Template: light — <why>`.

Light only when all four hold; a re-plan is always full, scoped to the piece it re-plans:

1. at most 5 files (the count `CLAUDE.md`'s Plan rule uses);
2. no risk class and no infra or shell trigger (`docs/ops/REVIEW.md` → _Picking lenses_);
3. no change to a stored shape, an API, MCP or extension contract, a CLI flag, a message shape, or text another
   program parses;
4. no write path or async hop added or reordered.

| Section            | Full                         | Light          |
| ------------------ | ---------------------------- | -------------- |
| Operator steps     | a table, or `none`           | same           |
| Files              | a table                      | at most 5 rows |
| Change census      | 2 searches per row           | 1 per row      |
| Unknowns           | a table, or `none`           | same           |
| Invariants         | 3–7                          | 1–3            |
| Ordering and races | a table, or `N/A — <reason>` | left out       |
| Pre-mortem         | 6 or more, every class       | left out       |
| Test matrix        | a table                      | same           |
| Step plan          | a table                      | same           |
| Open questions     | a table, or `none`           | same           |

## Sections

Each heading is `## <name>`, exactly as in the table above; other sections (appendices) are free. A section's first
table is the one read. Its first column is a row id (`C1`, `U1`, `I1`, `O1`, `P1`, `T1`; a range like `U1–U5` is
allowed), and other rows point at those ids. Name repo files in backticks by their path from the checkout root, with
`:line` or `:a-b` where a line is meant; mark a file the change creates once as `` `path` (new) ``.

**Change census** — one row per state or contract the change touches: a stored field, a message or file shape, a
flag, a name another file matches on.

| ID  | State / contract        | Writers                      | Readers                                     | Searches → hits                                                                                                  | Change           |
| --- | ----------------------- | ---------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| C1  | `doneAt` on a task item | `packages/x/src/write.ts:40` | `packages/x/src/list.ts:12`, `docs/x.md:30` | `git grep -n -e doneAt -- packages docs tools` → 9; `git grep -n -e "'doneAt'" -e done_at -- packages tools` → 2 | becomes optional |

- Writers and Readers are `path:line`, or start with `none` (a runtime writer: `none (the Agent tool's launches)`).
- A search is the exact command in backticks and its count of matching lines, `0` included. The plan reviewer
  re-runs it, so it is held to an allowlist: one `git grep` or `rg` (tracked or non-ignored files only — never
  `grep -r`, which reads ignored ones), flags from `SEARCH_FLAGS` in `scripts/src/plan-lint/lint.ts`, patterns in
  single quotes when they hold anything the shell reads, and the repo paths it searched — each one existing,
  relative, with no `..` (never the root as a whole). No pipe (one `-e` per form), `;`, `&`, redirection or `$`
  outside quotes. Searches in one cell are separated by `;`.
- Full takes two searches per row: the identifier, and its other form (a string literal, snake or kebab case, the
  wire name). Between them they cover docs, shell, infra, tests and the extension wherever the name can occur.

**Unknowns** — every fact about an outside tool, OS, platform, version, API, limit or price the work depends on.

| ID  | Claim                                       | Version  | Evidence                                    |
| --- | ------------------------------------------- | -------- | ------------------------------------------- |
| U1  | the tool rejects a key over 1 KB            | tool 3.2 | searched: https://example.com/docs/limits   |
| U2  | the flag exists in the installed build      | 3.2.1    | probed: `tool --help` → lists `--dry-run`   |
| U3  | the store's behaviour under a real throttle | n/a      | run-only: only the deployed stage throttles |

Evidence starts with `searched:` and the URL it came from (the public page, with no explicit port: the reviewer
fetches it, and a remote `:8080` pauses the container), `probed:` with `` `<command>` → <output> ``, or
`run-only:` with why no search or probe can settle it. Anything else is not evidence, "from memory" included: write
`open: <question>`, which fails the lint until the lane settles it (`search-specialist` on `sonnet`, or a probe).

**Invariants** — what must stay true, each pointing at the test row that fails if it breaks (or a named test file).

| ID  | Invariant                           | Failing test |
| --- | ----------------------------------- | ------------ |
| I1  | a done task is never listed as open | T2           |

**Ordering and races** — one row per write path or async hop: what can run twice or interleave, what must come
first, what a retry does, and the rule that makes it safe. None at all: `N/A — <why there is no write path or hop>`.

| ID  | Path / hop                    | Risk                                     | Rule                                   |
| --- | ----------------------------- | ---------------------------------------- | -------------------------------------- |
| O1  | toggle, then the list refetch | the refetch lands first, shows old state | the write's response updates the cache |

**Pre-mortem** — "this shipped, and round 1 found a serious flaw: why?" At least one row per class, each pointing at
the row that covers it. A reason nothing covers changes the plan first: a new census row, Unknown or matrix row.

| ID  | Class            | Why it failed                                                 | Covered by |
| --- | ---------------- | ------------------------------------------------------------- | ---------- |
| P1  | reader/writer    | a reader the census missed                                    | C1         |
| P2  | outside tool     | a limit assumed, not checked                                  | U1         |
| P3  | race             | two writers, the older one wins                               | O1         |
| P4  | contract         | two sides disagree on a shape or a unit                       | C1         |
| P5  | test cannot fail | the test passes with the change reverted                      | T2         |
| P6  | other            | rollback, mixed versions, the kickoff's likeliest-broken rule | I1         |

**Test matrix** — the dev-test matrix (phase 2), plus what turns each row red.

| ID  | Entry × case      | Proof | Fails when                               |
| --- | ----------------- | ----- | ---------------------------------------- |
| T2  | UI × toggle twice | dev   | fails when: the second toggle is dropped |

Proof is `dev`, a named test, `manual` or `needs-you`. `fails when:` names the code change that would turn the row
red; a row no change could turn red is a test that can't fail.

**Step plan** — `| # | Step | Phase key | Minutes | From |`: Minutes is `<lo>–<hi>` (a trailing `?` when From is
`no history`), From the record it came from.

**Operator steps**, **Files**, **Open questions** — tables, or `none`; each open question carries a recommended
answer.

## After Plan

1. The lane saves the plan to `localNotes/plan.md` and runs `pnpm plan-lint` (`--help` for flags; `--root` for a
   plan about another checkout). It fixes what the lint names: a missing search is run and counted, an `open:` row
   settled, a stale path corrected. No second `Plan`.
2. One `plan-reviewer` launch (`.claude/agents/plan-reviewer.md`), given the plan's and the kickoff's paths. It is
   read-only, re-runs a sample of the census searches and checks every Unknowns row against its source, and reports
   at most 7 serious gaps, each with its proof.
3. The lane traces each gap. A count that differs is not a gap by itself; a reader or writer the census missed is.
   A confirmed gap is fixed in the plan; one the lane drops is logged in `localNotes/decisions.md` with the reason.
4. `pnpm plan-lint` again, then `[kickoff]`. No second reviewer pass: a reviewer asked again always finds something.

What the lint checks is listed in `pnpm plan-lint --help` and pinned by `scripts/src/plan-lint/lint.test.ts`; it
never runs a census command, so a count is checked only by the reviewer's sample.
