#!/bin/bash
# PreToolUse hook on Read|Grep|Glob — DENIES any of them reaching into `.secrets/` (the bot's private key and
# app.env, docs/ops/CI-BOT.md). gh-safety-guard.sh covers Bash; Read/Grep/Glob never pass through it. The bot
# CLI reads the key in-process, so no tool call ever needs to. Builtins + jq only, like the other guards.
# A Grep *pattern* is content, not a path — searching the repo for the text `.secrets/` stays allowed. A broad
# Grep from a parent dir normally skips `.secrets/` (gitignored, hidden), but rg lets a `glob` re-admit ignored
# paths — so a Grep whose glob could match the key files (`*`, `*.pem`, `*.env`, any `{…}` brace glob, which
# can't be checked here), rooted where a `.secrets` dir sits within reach, is denied too. `*.ts` passes.
# Second wall, not a proof.
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
# `.secret…` starting a path component (`.secrets`, `.secret*`, `{.secrets,x}` all count).
if printf '%s\n' "$TEXT" | grep -qE '(^|[/*{,[:space:]])\.secret'; then
  deny "Reading or listing \`.secrets/\` is blocked — it holds the bot private key. The bot CLI reads it in-process (\`pnpm bot …\`); nothing else needs its contents."
fi

# A Grep with a glob, rooted where a `.secrets` dir is within reach. Each value on its own line (paths may hold spaces).
{ IFS= read -r GLOB || true; IFS= read -r ROOT || true; } < <(printf '%s' "$INPUT" | jq -r 'if .tool_name == "Grep" and ((.tool_input.glob // "") != "")
  then .tool_input.glob, (.tool_input.path // .cwd // "") else "", "" end')
# `|| true` + a non-empty test, not a pipeline: under pipefail, find's exit 1 on an unreadable dir would read as "none".
if [ -n "${GLOB:-}" ] && [ -d "${ROOT:-}" ] \
  && [ -n "$(find "$ROOT" -maxdepth 3 -name .secrets -print -quit 2>/dev/null || true)" ]; then
  SEG=${GLOB##*/}
  HIT=0
  if [[ $SEG == *'{'* ]]; then HIT=1; fi
  for name in private-key.pem app.env; do
    # shellcheck disable=SC2053 # SEG is a glob on purpose
    if [[ $name == $SEG ]]; then HIT=1; fi
  done
  if [ "$HIT" = 1 ]; then
    deny "This Grep's glob (\`$GLOB\`) could pull the gitignored \`.secrets/\` (the bot key) under \`$ROOT\` back into the search. Narrow the glob to a file type (\`*.ts\`, \`*.md\`) or root the search below the checkout (e.g. \`docs/\`)."
  fi
fi
exit 0
