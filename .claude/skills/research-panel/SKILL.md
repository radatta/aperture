---
name: research-panel
description: Multi-agent web research on one question — a scout splits it into angles, parallel search-specialist researchers take one each, an opus synthesizer writes one report that keeps documented, anecdotal and unknown apart. User-invoked only, as `/research-panel <question>`; the report lands in the worktree's localNotes/research/.
argument-hint: '<question> [researchers=N] [scout=|researcher=|synth=<model>]'
disable-model-invocation: true
---

# Run a research panel

**Typing `/research-panel` is the opt-in** to a multi-agent Workflow run — no "ultracode" needed. It spends real
tokens (a scout, N researchers, an opus synthesizer), which is why the model can't start it on its own. A single
fact still goes to one `search-specialist` (CLAUDE.md → _Check what can be checked online_); the panel is for a
question with several independent angles.

## Arguments

$ARGUMENTS

No question above → ask for one and stop. Knobs in the text become `args`: `researchers=N` (default 5, 1–8) and
`scout=`, `researcher=`, `synth=` (`models`; defaults sonnet, sonnet, opus). Strip them from the question.

## Search privacy — hard rule

Nothing that identifies the project or a person goes to the panel: no repo name, owner, GitHub login, domain,
person's name, email, Mac path or any personal detail in the question, the context, or — through them — any
search query or fetched URL. Generic product-category wording only ("a solo developer's personal PWA on AWS
serverless", not the project's names). The script repeats the rule in every agent prompt, alongside the COI
rules, the `.secrets/` ban and the scoped-search rule; what you pass in is what it can't scrub.

## Steps

1. **Write the context paragraph** — 3–8 lines of what the researchers need: the stack, constraints (cost,
   effort, platform), what is already decided or ruled out. Scrubbed per the rule above. Rephrase the question
   the same way when it names the project.
2. **Call `Workflow`** with `scriptPath` set to the absolute path `${CLAUDE_SKILL_DIR}/panel.js` and `args` as a
   JSON object, not a string: `{question, context, researchers?, models?: {scout?, researcher?, synth?}}`.
   It returns `{question, models, researchers, angles, report}`, or `{error}`.
3. **Save the report** to the current worktree's `localNotes/research/<slug>.md` (its root is
   `git rev-parse --show-toplevel`; `/workspace` when not in a worktree). `<slug>` is 3–6 lowercase kebab
   words from the question; add `-2` rather than overwrite. Head it with the question, today's date, the models and the
   angles, then the report verbatim.
4. **Give the user the path** — the Mac path (`<mac-repo>/…`, from the SessionStart context) — and the report's
   bottom line in 2–3 lines. On `{error}`, say which stage failed; never rerun unasked.
