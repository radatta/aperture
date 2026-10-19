---
name: handoff
description: Compaction-only. The PreCompact hook runs this in a forked copy of the session to write localNotes/handoffs/handoff-<date>-<branch>-<sid8>.md (decisions and why, dead ends, open questions, file pointers) before the context is summarised. Not for manual use — /compact is how to get one.
argument-hint: "session=<id> trigger=<manual|auto> [instructions=file]"
disable-model-invocation: true
---

# Write a handoff

A dated snapshot of what a fresh reader needs to pick this up — this session after compaction, a
subagent, or a concurrent session on another branch.

**Compaction-only.** `.claude/hooks/precompact-handoff.sh` runs it on every compaction — manual
`/compact`, idle, and context-full — in a fork of the session (docs/ops/COMPACTION-HANDOFF.md).

## Arguments

$ARGUMENTS

**No `session=` above means someone typed `/handoff` by hand.** Write nothing. Reply that handoffs are
written automatically at compaction, that `/compact <instructions>` is how to get one now (the
instructions reach the handoff too), and stop.

Otherwise you are a **fork of a session that is about to be compacted**. No one reads your replies — the
file is the only output. Don't ask questions or wait for input. Only file reads, the commands in steps
1–3 and writes under `localNotes/handoffs/` are permitted; anything else is denied, so don't retry
around a denial — note what you couldn't check and move on. Take `<sid>` from `session=` (`<sid8>` is
its first 8 characters) and the trigger from `trigger=`.

## What the user wants in it

Two sources, both the user's input, **not verified state**:

- **`instructions=file`** → read `localNotes/handoffs/.instructions-<sid8>.txt`: the text the user typed
  after `/compact`.
- **The conversation** — anything the user said was for the handoff ("for the handoff: …", "make sure
  the handoff covers …").

**Route each item into the section it belongs in** — state into the verified block, a choice into
Decisions, a failed path into Dead ends — rather than dumping it verbatim at the top. Confirm each
factual claim in step 1 where a command can reach it, otherwise record it marked "unverified" (*Mark
beliefs as beliefs* applies here too). "PR 42 is merged", said in passing, is the single easiest way
for a stale claim to land as fact.

## Why this exists (don't shortcut it)

- **Subagents start with a completely fresh context** — no conversation history, no compacted summary, none of the files the parent read. A file is the only way to brief one without restating everything in every prompt.
- **Compaction is lossy and occasionally generative** — its summary dies with the session, and there is a filed, JSONL-verified case of one fabricating a user instruction that the post-compact session then executed (anthropics/claude-code#46602).
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

Branch from step 1's `git status -sb` line; `detached` when HEAD is detached. Substitute it literally —
no `$(...)` in the command:

```bash
ls -1 localNotes/handoffs/ | grep -E -- "^handoff-.*-<branch>(-[0-9a-f]{8})?\.md$" | tail -1
```

### 3. Write `localNotes/handoffs/handoff-YYYY-MM-DD-HHMM-<branch>-<sid8>.md`

Timestamp from `date +%Y-%m-%d-%H%M`. The name sorts chronologically, carries the branch, and ends in
the session id so the post-compact hook finds this exact file (`.claude/hooks/post-compact-context.sh`).

**A new file every time.** Never edit or append to an existing one. A dated file reads as "this was
true at 14:32"; a rewritten file reads as "this is true," and that second claim is the one that goes
quietly wrong.

End by replying with the path.

## Template

Drop any section with nothing real in it. An empty heading is noise.

```markdown
# Handoff — <branch> — <YYYY-MM-DD HH:MM TZ>

Session: <sid> · Trigger: <manual|auto>
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
