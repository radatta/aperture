#!/bin/bash
# PreToolUse hook on Read|Grep|Glob — DENIES any of them reaching into a `.secrets/` directory, at any depth: the
# root one (the bot's private key and app.env, docs/ops/CI-BOT.md; the devcheck session, docs/ops/DEV-CHECK.md) and
# `cdk/.secrets/` (cdk's stage secrets) alike. gh-safety-guard.sh covers Bash; Read/Grep/Glob never pass through it.
# The tools that need them read them in-process (`pnpm bot`, `pnpm devcheck`, cdk synth), so no tool call ever
# needs to. Builtins + jq only, like the other guards. Case-insensitive: the /workspace mount is, so `.SECRETS/` opens
# the real dir.
# A Grep *pattern* is content, not a path — searching the repo for the text `.secrets/` stays allowed. A broad
# Grep from a parent dir skips `.secrets/` (gitignored, hidden), but an rg `--glob` overrides ignore rules: it
# re-admits an ignored dir when the glob matches the directory's own name (`*`, `**`, `*.*`, `.*`, `*s*`), never
# for `*.json` or `*.ts` (rg 14.1, probed on synthetic dirs 2026-11-17). So a Grep whose glob could match the name
# `.secrets` (or any `{…}` brace glob, which can't be checked here), rooted where a `.secrets` dir sits within
# reach, is denied too. Glob gets no such arm: it doesn't honour .gitignore and can list the dir's file *names*,
# the same exposure as the bare `ls` the Bash guard allows; a path or pattern naming the dir is still denied.
# Second wall, not a proof (a symlink into the dir, a `.s*` in a path, a dir deeper than the walk).
set -euo pipefail
INPUT=$(cat)

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

# Path-like fields only: Read file_path, Grep path/glob, Glob path/pattern.
TEXT=$(printf '%s' "$INPUT" | jq -r '[.tool_input.file_path, .tool_input.path, .tool_input.glob,
  (if .tool_name == "Glob" then .tool_input.pattern else null end)]
  | map(select(type == "string")) | join("\n")')
# `.secret…` starting a path component (`.secrets`, `.secret*`, `{.secrets,x}` all count), any case.
if printf '%s\n' "$TEXT" | grep -qiE '(^|[/*{,[:space:]])\.secret'; then
  deny "Reading or searching a \`.secrets/\` directory is blocked, at any depth (repo root, \`cdk/\`): the bot key, the devcheck session, cdk's stage secrets. The tools that need them read them in-process (\`pnpm bot\`, \`pnpm devcheck\`, cdk synth)."
fi

# A Grep with a glob. Each value on its own line (paths may hold spaces): glob, path, session cwd.
{ IFS= read -r GLOB || true; IFS= read -r ROOT || true; IFS= read -r CWD || true; } < <(printf '%s' "$INPUT" | jq -r '
  if .tool_name == "Grep" and ((.tool_input.glob // "") != "")
  then .tool_input.glob, (.tool_input.path // ""), (.cwd // "") else "", "", "" end')
[ -n "${GLOB:-}" ] || exit 0

# Cheap string test first: the disk walk below runs only for a glob that could re-admit the dir. Each token (split on
# whitespace, and on commas outside braces, in case the tool splits a list) is tested on its last path segment;
# a `!` exclusion admits nothing.
HIT=0
check_token() {
  local tok=$1 seg name
  [ -n "$tok" ] && [[ $tok != '!'* ]] || return 0
  seg=${tok##*/}
  if [[ $seg == *'{'* ]]; then HIT=1; return 0; fi
  shopt -s nocasematch
  # shellcheck disable=SC2053 # seg is a glob on purpose
  for name in .secrets private-key.pem app.env; do  # the dir name; the bot's two file names (belt and braces)
    if [[ $name == $seg ]]; then HIT=1; fi
  done
  shopt -u nocasematch
}
TOK=''
DEPTH=0
GLOB_LEN=${#GLOB}
for ((i = 0; i < GLOB_LEN; i++)); do
  c=${GLOB:i:1}
  case $c in
    '{') DEPTH=$((DEPTH + 1)); TOK+=$c ;;
    '}') [ "$DEPTH" -gt 0 ] && DEPTH=$((DEPTH - 1)); TOK+=$c ;;
    ',') if [ "$DEPTH" -eq 0 ]; then check_token "$TOK"; TOK=''; else TOK+=$c; fi ;;
    ' ' | $'\t') check_token "$TOK"; TOK='' ;;
    *) TOK+=$c ;;
  esac
done
check_token "$TOK"
[ "$HIT" = 1 ] || exit 0

# Where rg starts: the path (relative ones from the session cwd), else the cwd.
if [ -z "${ROOT:-}" ]; then ROOT=${CWD:-}; elif [[ $ROOT != /* ]] && [ -n "${CWD:-}" ]; then ROOT=$CWD/$ROOT; fi
[ -d "${ROOT:-}" ] || exit 0
# A `.secrets` within reach: shallow first (a checkout root answers here), then deeper — a worktree's
# `cdk/.secrets` sits at depth 5 under /workspace — pruning the trees rg skips anyway. `|| true` + a non-empty
# test, not a pipeline: under pipefail, find's exit 1 on an unreadable dir would read as "none". What it finds is
# never printed.
FOUND=$(find "$ROOT" -maxdepth 2 -iname .secrets -print -quit 2>/dev/null || true)
if [ -z "$FOUND" ]; then
  FOUND=$(find "$ROOT" -maxdepth 6 \( -name node_modules -o -name .git -o -name dist -o -name cdk.out \) -prune \
    -o -type d -iname .secrets -print -quit 2>/dev/null || true)
fi
if [ -n "$FOUND" ]; then
  deny "This Grep's glob (\`$GLOB\`) could match the gitignored \`.secrets\` directory's own name (or the bot key's) under \`$ROOT\`, so rg would pull the dir back into the search. Narrow the glob to a file type (\`*.ts\`, \`*.json\`) or root the search below the checkout (e.g. \`docs/\`)."
fi
exit 0
