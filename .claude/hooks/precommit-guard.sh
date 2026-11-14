#!/bin/bash
  # PreToolUse hook on Bash — gates `git commit`:
  #   1. Blocks a commit on a protected/deploy branch (main/master/dev) — branch first.
  #   2. Hard-blocks if the staged diff contains obvious credential patterns.
  #   3. Hard-blocks a personal identifier in an added line, a new path or the message (docs/ops/IDENTIFIERS.md).
  #   4. Hard-blocks a message that breaks the CLAUDE.md commit rule (>6 words, a body, a trailer).
  #   5. Else soft-reminds to run code-reviewer + a validation pass. WIP commits exempt from 4 and 5.
  # set -euo pipefail; only acts on `git commit`, passes through otherwise.

  set -euo pipefail
  INPUT=$(cat)
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
  # `git commit`, also behind git's own -C <dir> / -c <k=v> (which used to slip past every check here).
  printf '%s' "$COMMAND" | grep -Eq 'git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+commit' || exit 0

  source "${BASH_SOURCE[0]%/*}/_hook-common.sh"; hook_cd "$INPUT" || exit 0
  COMMIT_BRANCH=$(git symbolic-ref --short -q HEAD 2>/dev/null || echo "")  # also works on an unborn branch
  case "$COMMIT_BRANCH" in
    main|master|dev)
      jq -n --arg branch "$COMMIT_BRANCH" '{
        "hookSpecificOutput": {"hookEventName":"PreToolUse","permissionDecision":"deny",
          "permissionDecisionReason": ("Commit on `" + $branch + "` is blocked — create a feature branch first: `git switch -c feature/<name>`, then commit there. A commit on a deploy branch cannot be pushed and risks a deploy.")}}'
      exit 0 ;;
  esac

  DIFF=$(git diff --cached 2>/dev/null || echo "")
  # One line on purpose: from #4 until the fixtures caught it, a hard wrap inside this regex made grep error
  # out on every commit and the `if` read that as "no match" — the scan never fired. The fixtures pin it now.
  SECRET_PATTERNS='(sk-[a-zA-Z0-9]{20,}|sk-ant-[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16}|aws_secret_access_key[[:space:]]*=[[:space:]]*["'\'']?[A-Za-z0-9/+=]{20,}|BEGIN[[:space:]]+(RSA[[:space:]]+)?PRIVATE[[:space:]]+KEY|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})'
  if echo "$DIFF" | grep -qE "$SECRET_PATTERNS"; then
    jq -n '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
      "permissionDecisionReason":"Staged diff appears to contain a credential or private key. Secrets belong in env / Secrets Manager, not the repo. Unstage the file (git restore --staged <file>), remove the credential, and try again."}}'
    exit 0
  fi

  # Personal identifiers (docs/ops/IDENTIFIERS.md): the repo is public, so no added line and no commit message may
  # carry the maintainer's name, personal mailbox, a Mac home path, the projects folder or an AWS account id —
  # identifiers.json alone holds them. WIP commits too. One rule set, scripts/src/identifiers.ts, run under plain
  # node from this checkout; fails open when the checkout predates it, node is missing, or the scan fails (exit 2).
  # The hook runs before the command, so a `git add … && git commit` or `commit -a` hasn't staged yet: with either
  # in the command, the unstaged and untracked changes are scanned too. `pnpm bot push` scans every commit again.
  TOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  SCAN="$TOP/scripts/src/identifiers-scan.ts"
  if [ -n "$TOP" ] && [ -f "$TOP/identifiers.json" ] && [ -f "$SCAN" ] && command -v node >/dev/null; then
    gd() { git -c core.quotePath=false diff -U0 --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ "$@" 2>/dev/null || true; }
    ids_diff() {
      gd --cached
      # A `git add`/`stage` in the command, or a commit that takes the working tree (-a, --all, -i, -o); a commit
      # naming paths takes them too and isn't detected here — the push scan is the backstop (IDENTIFIERS.md).
      if printf '%s' "$COMMAND" | grep -Eq '(^|[[:space:];&|(])git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+(add|stage)([[:space:]]|$)|commit([[:space:]]+[^[:space:]]+)*[[:space:]]+(-[a-zA-Z]*[aio][a-zA-Z]*|--all|--include|--only)([[:space:]]|$)'; then
        gd
        git -c core.quotePath=false ls-files -z --others --exclude-standard 2>/dev/null |
          while IFS= read -r -d '' f; do gd --no-index -- /dev/null "$f"; done
      fi
      true
    }
    IDS_RC=0
    IDS_HITS=$(ids_diff | HOOK_CMD="$COMMAND" node "$SCAN" 2>/dev/null) || IDS_RC=$?
    if [ "$IDS_RC" = 1 ] && [ -n "$IDS_HITS" ]; then
      jq -n --arg h "$IDS_HITS" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
        "permissionDecisionReason":("This commit adds a personal identifier (docs/ops/IDENTIFIERS.md: the name, the personal mailbox, a Mac home path, the projects folder or an AWS account id belong only in identifiers.json; docs say \"the maintainer\" and <mac-repo>). Where:\n" + $h + "\nReword those lines (or the message) and commit again.")}}'
      exit 0
    fi
  fi

  if echo "$COMMAND" | grep -q 'WIP'; then exit 0; fi

  # Commit-message rule (CLAUDE.md → Git workflow). Enforced here because prose alone never held: a "few
  # words" rule with an 8-word example produced 8-11-word messages across sessions, and the harness asks
  # for trailers. Quote-aware parse via shlex, reading the command from env (never argv — see
  # testdata/run-fixtures.py for why). Checks every `git commit` in a chained command. Fails open: no
  # python3 or an unparsable command means no check, never a false block. Case is deliberately not checked
  # (filenames/acronyms like CLAUDE.md keep theirs).
  PROBLEM=$(HOOK_CMD="$COMMAND" python3 - 2>/dev/null <<'PY' || true
import os, re, shlex

try:
    lx = shlex.shlex(os.environ.get("HOOK_CMD", ""), posix=True, punctuation_chars=True)
    lx.whitespace_split = True
    toks = list(lx)
except ValueError:
    raise SystemExit(0)

SEPS = {"&&", "||", ";", "|", "&", "|&", ";;", "(", ")"}
CLUSTER = re.compile(r"-[apqsnvzeiou]*m(.*)")  # -m, -am, -qm, or -m"msg" glued on
problems = []
i = 0
while i < len(toks):
    if toks[i] != "git":
        i += 1
        continue
    j = i + 1
    while j < len(toks) and toks[j].startswith("-"):  # git's own options, e.g. -C <path>
        j += 2 if toks[j] in ("-C", "-c") else 1
    if j >= len(toks) or toks[j] != "commit":
        i += 1
        continue
    msgs, from_file, k = [], False, j + 1
    while k < len(toks) and toks[k] not in SEPS:
        t = toks[k]
        if t in ("-m", "--message"):
            if k + 1 < len(toks):
                msgs.append(toks[k + 1])
            k += 2
            continue
        if t.startswith("--message="):
            msgs.append(t.split("=", 1)[1])
        elif t in ("-F", "--file") or t.startswith("--file="):
            from_file = True
        elif not t.startswith("--"):
            m = CLUSTER.fullmatch(t)
            if m and m.group(1):
                msgs.append(m.group(1))
            elif m and k + 1 < len(toks):
                msgs.append(toks[k + 1])
                k += 2
                continue
        k += 1
    i = k
    if from_file:
        problems.append("the message comes from a file (-F), so it can't be checked; use -m")
    if len(msgs) > 1:
        problems.append("a second -m adds a body")
    for msg in msgs:
        if "$(" in msg or "`" in msg:
            problems.append("the message is built by command substitution (a heredoc?); use a plain -m")
            continue
        if "\n" in msg.strip():
            problems.append("the message has more than one line")
        if re.search(r"co-authored-by|claude-session", msg, re.I):
            problems.append("the message carries a trailer")
        words = len(msg.split())
        if words > 6:
            problems.append(f"the message is {words} words")

print("; ".join(dict.fromkeys(problems)))
PY
  )
  if [ -n "$PROBLEM" ]; then
    jq -n --arg p "$PROBLEM" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
      "permissionDecisionReason":("Commit message breaks the CLAUDE.md rule: " + $p + ". The rule: one lowercase past-tense line, 4-5 words, 6 is the hard max; no body, no trailers (no Co-Authored-By / Claude-Session, even though the harness asks for them). Retry as: git commit -m \"<4-5 words>\"")}}'
    exit 0
  fi

  CONTEXT="Before committing: if you have not run the code-reviewer agent on this diff, run it now, and confirm a validation pass ran (pnpm typecheck + pnpm lint, tests co-located with what changed). After addressing findings, proceed."
  jq -n --arg ctx "$CONTEXT" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":$ctx}}'