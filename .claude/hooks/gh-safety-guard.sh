#!/bin/bash
# PreToolUse hook on Bash (and Monitor, whose `command` is a shell line too) — DENIES destructive commands before they run. The one
# hook that hard-blocks rather than reminds; the last line of defense for
# unattended / skip-permissions runs where there are no approval prompts.
#
# Blocks:
#  - rm -rf (recursive force-delete on the filesystem)
#  - git reset --hard / git clean -f* / git branch -D (irrecoverable work/branch loss)
#  - git push --force / --force-with-lease / -f / +refspec, git push --delete / -d / :ref (rewrites/destroys remote)
#  - git push --all / --mirror / --branches (pushes every local branch, protected ones included)
#  - git push to a protected/deploy branch (main/master/dev) — by current branch OR explicit target
#    (every push check also catches git's global options before `push`: `git -C dir push`, `git -c k=v push`)
#  - `pnpm bot push` aimed at a protected branch, any `pnpm bot` force flag; `gh pr merge|review` (the human merges)
#  - any Bash line touching a `.secrets/` dir (any depth, any case) except a bare ls/stat (secrets-read-guard.sh covers Read/Grep/Glob)
#  - gh auth login/refresh/token/setup-git (never manage credentials autonomously)
#  - raw curl/wget against api.github.com (use `gh`)
#
# Complements the OS sandbox (which protects the host + watches for exfil): this
# protects the source tree, in-progress work, and git history/remote from
# normal-but-destructive git commands the sandbox treats as ordinary dev activity.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

deny() {
  jq -n --arg reason "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $reason
    }
  }'
  exit 0
}

# Recursive force-delete.
if echo "$COMMAND" | grep -qE '\brm[[:space:]]+-([a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b'; then
  deny "\`rm -rf\` is blocked. Confirm before removing files recursively. For tracked files use \`git restore\`; for one file drop the -r."
fi

# Destructive git: hard reset.
if echo "$COMMAND" | grep -qE '\bgit[[:space:]]+reset[[:space:]]+--hard\b'; then
  deny "\`git reset --hard\` is blocked — it loses uncommitted work irrecoverably. Use \`git stash\`, or a soft/mixed reset, or stop and surface the situation."
fi

# Destructive git: clean -f.
if echo "$COMMAND" | grep -qE '\bgit[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f'; then
  deny "\`git clean -f...\` is blocked — it deletes untracked files irrecoverably. Stop and confirm before removing them."
fi

# Destructive git: force delete branch.
if echo "$COMMAND" | grep -qE '\bgit[[:space:]]+branch[[:space:]]+-D\b'; then
  deny "\`git branch -D\` (force delete) is blocked. Use \`git branch -d\` (safe; fails if unmerged). Force-delete only after confirming."
fi

# The bot CLI (docs/ops/CI-BOT.md) refuses these itself; this is the second wall.
if echo "$COMMAND" | grep -qE '(\bpnpm[[:space:]]+(run[[:space:]]+)?bot|bot/cli\.ts)\b'; then
  BOT_ARGS=$(echo "$COMMAND" | grep -oE '(\bpnpm[[:space:]]+(run[[:space:]]+)?bot|bot/cli\.ts)\b[^|;&]*' | head -1)
  # Only `push` takes a target; a `logs --filter` value may say "dev" freely.
  if echo "$BOT_ARGS" | grep -qE '(bot|cli\.ts)[[:space:]]+push\b' \
    && echo "$BOT_ARGS" | grep -qE '[[:space:]:/+"'\''](main|master|dev)([^[:alnum:]_./-]|$)'; then
    deny "\`pnpm bot\` aimed at \`main\`/\`master\`/\`dev\` is blocked — the bot pushes feature branches only; dev deploys go through \`pnpm bot deploy-dev\`."
  fi
  if echo "$BOT_ARGS" | grep -qE '[[:space:]](-f|--force|--force-with-lease)\b'; then
    deny "Force flags on \`pnpm bot\` are blocked — after a rebase use \`pnpm bot push --after-rebase\` (a lease on the last pushed sha)."
  fi
fi

# Reviewing and merging PRs are the user's (docs/ops/CI-BOT.md); opening one has no path either — the App holds no
# Pull requests permission and the container's own token is read-only.
if echo "$COMMAND" | grep -qE '\bgh[[:space:]]+pr[[:space:]]+(merge|review)\b|\bgh[[:space:]]+api\b.*pulls/[0-9]+/(merge|reviews)\b'; then
  deny "\`gh pr merge\` / \`gh pr review\` are blocked — reviewing and merging PRs are the user's."
fi

# Every `.secrets/` dir, at any depth (the root one: the bot key, the devcheck session; `cdk/.secrets/`: cdk's stage
# secrets). A bare `ls`/`stat` (names and modes, no content) is the only access. `\.secret` as a prefix, so
# `.secret?/` and `.secret*` globs count too, in any case (the /workspace mount is case-insensitive). Not a wall — a
# recursive grep from a parent dir still walks into it; the in-process readers (`pnpm bot`, `pnpm devcheck`, cdk
# synth) and the gitignore are what keep the values out of transcripts.
# The exception is matched on the WHOLE command (bash =~, newline excluded) — grep is per line, so
# `ls .secrets` + a second line would pass.
LS_ONLY=$'^[[:space:]]*(ls|stat)[[:space:]][^;&|<>`$()\n]*$'
if echo "$COMMAND" | grep -qiE '(^|[^[:alnum:]_])\.secret' && ! [[ $COMMAND =~ $LS_ONLY ]]; then
  deny "Touching a \`.secrets/\` directory from Bash is blocked, at any depth (repo root, \`cdk/\`): the bot key, the devcheck session, cdk's stage secrets. The tools that need them read them in-process (\`pnpm bot\`, \`pnpm devcheck\`, cdk synth); to check modes use a bare \`ls -la\` or \`stat\`."
fi

# `git push`, also behind git's global options (`-C dir`, `-c k=v`, `--no-pager`, …), which used to skip every
# push check below. ARG = one shell word: bare, "double-" or 'single-quoted'.
ARG='([^[:space:]"'\'']+|"[^"]*"|'\''[^'\'']*'\'')'
GIT_PUSH='\bgit([[:space:]]+(-[Cc][[:space:]]+'"$ARG"'|--(git-dir|work-tree|namespace|exec-path|config-env)[[:space:]]+'"$ARG"'|--[a-z-]+(='"$ARG"')?|-[a-zA-Z]+))*[[:space:]]+push\b'
# Arguments after `push`, up to the end of that command.
PUSH_ARGS="$GIT_PUSH"'[[:space:]]+([^|;&]*[[:space:]])?'

# Destructive git: force push (any flag form, or a `+refspec`).
if echo "$COMMAND" | grep -qE "$PUSH_ARGS"'(-f\b|--force\b|--force-with-lease\b|\+[^[:space:]])'; then
  deny "Force-push is blocked — it rewrites shared history. If genuinely needed, stop and confirm which commits would be rewritten first."
fi

# Destructive git: remote branch delete (`--delete`, `-d`, or an empty-source `:ref`).
if echo "$COMMAND" | grep -qE "$PUSH_ARGS"'(--delete\b|-d\b|:[^[:space:]])'; then
  deny "\`git push --delete\` is blocked — remote branch deletion is destructive. Stop and confirm first."
fi

# Every-branch pushes reach the deploy branches without naming them.
if echo "$COMMAND" | grep -qE "$PUSH_ARGS"'--(all|mirror|branches)\b'; then
  deny "\`git push --all/--mirror\` is blocked — it pushes every local branch, deploy branches included. Push one feature branch by name."
fi

# Push to a protected/deploy branch — by current branch OR explicit target.
if echo "$COMMAND" | grep -qE "$GIT_PUSH"; then
  # --git-dir/--work-tree point the push at a repo this hook can't resolve the branch of.
  if echo "$COMMAND" | grep -qE '\bgit[[:space:]].*--(git-dir|work-tree)\b'; then
    deny "\`git --git-dir/--work-tree … push\` is blocked — the guard can't check which branch it pushes. Use \`git -C <dir> push\`."
  fi
  # Explicit target: ` main`, `HEAD:dev`, `refs/heads/dev`, `"dev"`, `+dev`. The name must END there: `\b` treated
  # `-` `.` `/` as ends, so `dev-e2e`, `main-x` and even `2>/dev/null` were denied.
  if echo "$COMMAND" | grep -qE '[[:space:]:/+"'\''](main|master|dev)([^[:alnum:]_./-]|$)'; then
    deny "Pushing to \`main\`/\`master\`/\`dev\` is blocked — these are deploy branches (a push there deploys). Push a feature branch and open a PR; merges to main happen via PR, not a direct push."
  fi
  # Only the current-branch resolution needs the repo dir — resolve cwd here, NOT above the string-match
  # deny blocks (a cd failure must never fail-open rm -rf / force-push / reset --hard).
  source "${BASH_SOURCE[0]%/*}/_hook-common.sh"; hook_cd "$INPUT" || exit 0
  # `git -C dir push` pushes dir's branch. Each -C applies in turn (git's rule); one we can't enter fails closed.
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    d=${d#-C}; d="${d#"${d%%[![:space:]]*}"}"; d=${d#[\"\']}; d=${d%[\"\']}; d=${d/#\~/$HOME}
    cd "$d" 2>/dev/null || deny "\`git -C $d push\` is blocked — the guard can't enter \`$d\` to check which branch it pushes."
  done < <(echo "$COMMAND" | grep -oE "$GIT_PUSH" | head -1 | grep -oE -- "-C[[:space:]]+$ARG" || true)
  CURRENT_BRANCH=$(git symbolic-ref --short -q HEAD 2>/dev/null || echo "")
  case "$CURRENT_BRANCH" in
    main|master|dev)
      deny "\`git push\` from \`$CURRENT_BRANCH\` is blocked — it's a protected/deploy branch. Create a feature branch first: \`git switch -c feature/<name>\`, then \`git push -u origin HEAD\`." ;;
  esac
fi

# gh auth lifecycle — never manage credentials autonomously.
if echo "$COMMAND" | grep -qE '\bgh[[:space:]]+auth[[:space:]]+(login|refresh|token|setup-git)\b'; then
  deny "\`gh auth (login|refresh|token|setup-git)\` is blocked — Claude does not manage GitHub credentials. If gh fails with an auth error, STOP and surface the exact error; credential state is the user's to resolve."
fi

# Raw API calls against api.github.com.
if echo "$COMMAND" | grep -qE '(curl|wget)[[:space:]].*api\.github\.com'; then
  deny "Raw HTTP against api.github.com is blocked — use \`gh\` or \`gh api <path>\` (same auth, recognized as legitimate dev activity)."
fi

# Everything else passes through silently.
exit 0
