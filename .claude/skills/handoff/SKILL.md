---
name: handoff
description: Write a dated handoff file to localNotes/handoffs/ capturing durable context — decisions and why, dead ends, open questions, file pointers. Use before running /compact, before spawning subagents, or before ending a session. Invoke manually with /handoff.
argument-hint: "[state or context to fold in]"
disable-model-invocation: true
---

# Write a handoff

A dated snapshot of what a fresh reader needs to pick this up — the next you, this session after
`/compact`, a subagent, or a concurrent session on another branch.

**Manual only.** Never write one because it seems like a good moment; the user decides when.

## What you passed with `/handoff`

$ARGUMENTS

If the block above is non-empty, it's context the user wants folded in. **Route each item into the
section it belongs in** — state into the verified block, a choice into Decisions, a failed path into
Dead ends — rather than dumping it verbatim at the top. It is the user's input, **not verified
state**: confirm each factual claim in step 1 where a command can reach it, otherwise record it marked
"unverified" (*Mark beliefs as beliefs* applies here too). "PR 42 is merged", passed in passing, is
the single easiest way for a stale claim to land as fact.

## Why this exists (don't shortcut it)

- **Subagents start with a completely fresh context** — a file is the only way to brief one without restating everything in every prompt.
- **`/compact` is lossy and occasionally generative** — a filed, JSONL-verified case of a summary fabricating a user instruction that the post-compact session then executed (anthropics/claude-code#46602).
- **Compaction keeps the arc and drops the dead ends** — the expensive part, since they stop the next reader re-walking a known-failed path.

## Steps

### 1. Verify state — never write it from memory

Run these and use the output. Do not assert branch tips, PR status, or test counts from recollection;
that is the single most common way these files become confidently wrong.

```bash
git status -sb | head -3
git log --oneline -5
gh pr list --state open --json number,headRefName,mergeStateStatus \
  --template '{{range .}}#{{.number}} {{.headRefName}} {{.mergeStateStatus}}{{"\n"}}{{end}}'
gh run list --limit 3 --json headBranch,headSha,conclusion \
  --template '{{range .}}{{.headBranch}} {{.headSha | printf "%.8s"}} {{.conclusion}}{{"\n"}}{{end}}'
```

If a command fails (no network, no `gh` auth), say so in the file rather than filling the gap from
memory. "Couldn't verify" is useful; a stale guess presented as fact is not.

### 2. Find the previous handoff for this branch

```bash
ls -1 localNotes/handoffs/ | grep -- "-$(git branch --show-current).md$" | tail -1
```

### 3. Write `localNotes/handoffs/handoff-YYYY-MM-DD-HHMM-<branch>.md`

Timestamp from `date +%Y-%m-%d-%H%M`, branch from `git branch --show-current`. The name sorts
chronologically and carries the branch, so concurrent sessions never collide.

**A new file every time.** Never edit or append to an existing one. A dated file reads as "this was
true at 14:32"; a rewritten file reads as "this is true," and that second claim is the one that goes
quietly wrong.

## Template

Drop any section with nothing real in it. An empty heading is noise.

```markdown
# Handoff — <branch> — <YYYY-MM-DD HH:MM TZ>

Previous: `handoff-<...>.md`   (omit if this is the first for this branch)

## Goal
One or two sentences. What is this branch for, and what does done look like?

## Session arc
One line per exchange, in order — what was asked, what came of it. Enough that a reader who saw none
of the conversation understands how the decisions below were reached. Compress hard: this is the
shape of the session, not a transcript. Mark corrections explicitly ("was wrong about X, actually
Y") — those are the highest-value lines.

## State as of <HH:MM>
Verified output from step 1 — branch, recent commits, open PRs, last deploy.
**Re-verify anything load-bearing before acting on it.** This is a snapshot, not a claim about now.

## Decisions + why
The reasoning, not just the outcome. "Chose X over Y because Z" — Z is the part that stops the next
reader relitigating it.

## Dead ends — do not retry
What was tried and failed, and why. The highest-value section, because it's exactly what compaction
drops.

## Open questions
Things genuinely undecided, and who or what would settle them. Distinguish "blocked on the user" from
"blocked on a fact nobody has checked yet."

## Files in play
Paths with a phrase on why each matters. Pointers, not contents.

## Next action
One concrete step, not a list of everything remaining.
```

## Rules

- **Durable content only.** Decisions, rationale, dead ends, open questions, pointers. State is fine —
  it's stamped and the filename dates it — but keep it to the verified block, not scattered as
  assertions throughout.
- **Point, don't copy.** If it's in `docs/`, a commit, or a PR, link it. Copying creates a second
  source of truth that drifts from the first.
- **Anything genuinely durable belongs in `docs/`, not here.** `localNotes/` is explicitly not a source
  of truth (CLAUDE.md). If something surfaces that the project should know permanently — a convention,
  a gotcha, a resolved architecture question — say so and offer to write it to `docs/` instead. A
  handoff that accumulates project knowledge is a doc-rot vector.
- **Narrate the arc, not the transcript.** The arc belongs here, compressed to one line per exchange
  (*Why this exists* covers why `/compact`'s summary is not enough). What does *not* belong is
  blow-by-blow: individual tool calls, what was read in what order, or anything a reader wouldn't
  act on.
- **Mark beliefs as beliefs.** If something wasn't actually verified this session, write "believed" or
  "unverified," never as a flat fact. The next reader will treat anything unqualified as contractual.
- **No secrets.** No tokens, no `.env` contents, no credentials — `localNotes/` is gitignored but it's
  still on disk and gets read by subagents.

## Length

**Soft guidance: ~500 lines** — a ceiling, *not a target*; a good handoff is often 40 lines. Never pad.
Approaching 500 is a smell, not a limit to trim to: narration belongs in `/compact`'s summary, durable
project knowledge in `docs/` — either way the content moves, it isn't deleted.

## After writing

Tell the user the path, and that they can now `/compact`, spawn agents pointing at it, or end the
session. When briefing a subagent, reference the file path in the prompt — the subagent reads it
itself rather than having the context restated.
