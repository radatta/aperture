#!/bin/bash
# PreToolUse hook on Read|Grep|Glob — DENIES any of them reaching into a `.secrets/` directory, at any depth: the
# root one (the bot's private key and app.env, docs/ops/CI-BOT.md; the devcheck session, docs/ops/DEV-CHECK.md) and
# `cdk/.secrets/` (cdk's stage secrets) alike. gh-safety-guard.sh covers Bash; Read/Grep/Glob never pass through it.
# The tools that need them read them in-process (`pnpm bot`, `pnpm devcheck`, cdk synth), so no tool call ever
# needs to. Builtins + jq + find only, like the other guards. Case-insensitive, in a UTF-8 locale: the /workspace
# mount folds case (`.SECRETS/`, even `ſ` for `s`, opens the real dir).
#
# Arm 1, any path-like field naming the dir. A Grep *pattern* is content, not a path — searching the repo for the
# text `.secrets/` stays allowed.
# Arm 2, a Grep glob that re-admits the dir. The Grep tool (Claude Code 2.1.327, read from its installed source)
# runs rg with `--hidden --no-follow`, splits `glob` on whitespace, comma-splits each piece without both `{` and `}`,
# and passes each piece as its own `--glob`. With `--hidden`, only the gitignore keeps rg out of `.secrets/`, and a
# `--glob` overrides ignore rules: rg re-admits an ignored dir when a glob matches the dir's own name (`*`, `**`,
# `*.*`, `.*`, `*s*`, `*/`), and then reads every file inside some glob matches. `*.json`, `*.ts` never match the
# name (rg 14.1, probed on synthetic dirs). So a glob piece whose last segment could match `.secrets` — or holds a
# brace, which can't be tested here — with a `.secrets` dir within reach of the search root is denied. The bot key's
# own names (`*.pem`, `*.env`) count too, as a margin. A glob with anything but printable ASCII (a newline, NBSP —
# JS splits on them, this hook doesn't try to) or over 4 KiB counts as `*`.
# Glob gets no arm 2: it doesn't honour .gitignore and can list the dir's file *names* — via a glob arm 1 can't read
# (`[.]secrets/**`) or any catch-all — the same exposure as the bare `ls` the Bash guard allows; never contents.
# Second wall, not a proof: a symlink into the dir, a dir deeper than the walk, or under a pruned tree, gets past.
set -euo pipefail
export LC_ALL=C.UTF-8
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
# A failure past this point denies rather than exiting non-zero (which Claude Code reads as "run the tool").
trap 'deny "The secrets guard failed on this input, so it is denied to be safe. Narrow the call (a plain path, a file-type glob)."' ERR

# Path-like fields only: Read file_path, Grep path/glob, Glob path/pattern.
TEXT=$(jq -r '[.tool_input.file_path, .tool_input.path, .tool_input.glob,
  (if .tool_name == "Glob" then .tool_input.pattern else null end)]
  | map(select(type == "string")) | join("\n")' <<<"$INPUT")
# `.secret…` after any non-word character, any case. A here-string, not a pipe: under pipefail an early `grep -q`
# exit SIGPIPEs a writer of more than 64 KiB, and the match would read as none.
if grep -qiE '(^|[^[:alnum:]_])\.secret' <<<"$TEXT"; then
  deny "Reading or searching a \`.secrets/\` directory is blocked, at any depth (repo root, \`cdk/\`): the bot key, the devcheck session, cdk's stage secrets. The tools that need them read them in-process (\`pnpm bot\`, \`pnpm devcheck\`, cdk synth)."
fi

# Grep with a glob: the glob (normalised), a flag for control characters in path/cwd (stripped so lines stay aligned),
# the path, the session cwd.
FIELDS=$(jq -r 'def ctl: test("[\\x00-\\x1f\\x7f]"); def clean: gsub("[\\x00-\\x1f\\x7f]"; "");
  if .tool_name == "Grep" and ((.tool_input.glob // "") | type == "string" and . != "") then
    (.tool_input.glob | if test("[^ -~]") or length > 4096 then "*" else . end),
    (if ((.tool_input.path // "") | ctl) or ((.cwd // "") | ctl) then "1" else "0" end),
    ((.tool_input.path // "") | clean), ((.cwd // "") | clean)
  else "", "0", "", "" end' <<<"$INPUT")
{ IFS= read -r GLOB || true; IFS= read -r CTL || true; IFS= read -r ROOT || true; IFS= read -r CWD || true; } <<<"$FIELDS"
[ -n "${GLOB:-}" ] || exit 0

# Cheap string test first; the disk walk below runs only for a glob that could re-admit the dir.
HIT=0
hit_piece() { # one `--glob` as the tool passes it
  local p=$1 seg name
  case $p in '' | '!'*) return 0 ;; esac # an exclusion admits nothing
  while [[ $p == */ ]]; do p=${p%/}; done # `*/` matches dirs only — the dir itself
  if [ -z "$p" ]; then HIT=1; return 0; fi
  case $p in *'{'* | *'}'*) HIT=1; return 0 ;; esac
  seg=${p##*/}
  shopt -s nocasematch
  # `case`, never `[[ == $seg ]]`: bash 5.2 turns extglob on for a pattern inside [[ ]], and a 15-character
  # `*(?|?|?|?)z` then backtracks past the hook timeout (a timeout runs the tool). `case` keeps extglob off.
  for name in .secrets private-key.pem app.env; do
    # shellcheck disable=SC2254 # seg is a glob on purpose
    case $name in $seg) HIT=1 ;; esac
  done
  shopt -u nocasematch
}
IFS=' ' read -r -a PIECES <<<"$GLOB"
for piece in ${PIECES[@]+"${PIECES[@]}"}; do
  if [[ $piece == *'{'* && $piece == *'}'* ]]; then
    hit_piece "$piece"
  else
    IFS=, read -r -a SUBS <<<"$piece"
    for sub in ${SUBS[@]+"${SUBS[@]}"}; do hit_piece "$sub"; done
  fi
done
[ "$HIT" = 1 ] || exit 0

NARROW="Narrow the glob to a file type (\`*.ts\`, \`*.json\`) or root the search below the checkout (e.g. \`docs/\`)."
if [ "${CTL:-0}" = 1 ]; then
  deny "This Grep's path or cwd holds a control character, so the guard can't tell where its glob (\`$GLOB\`) would reach. $NARROW"
fi
# Where rg starts: the path (`~` expanded; relative ones from the session cwd), else the cwd — always absolute.
CWD=${CWD:-$PWD}
case ${ROOT:-} in '~') ROOT=$HOME ;; '~/'*) ROOT=$HOME/${ROOT#'~/'} ;; esac
ROOT=${ROOT:-$CWD}
[[ $ROOT == /* ]] || ROOT=$CWD/$ROOT
[[ $ROOT == /* ]] || ROOT=$PWD/$ROOT
if ! [ -d "$ROOT" ]; then
  [ -e "$ROOT" ] && exit 0 # one file: rg searches just it
  deny "This Grep's glob (\`$GLOB\`) could re-admit a gitignored \`.secrets\` directory, and its root (\`$ROOT\`) doesn't resolve here to check. $NARROW"
fi
# A `.secrets` within reach: shallow first (a checkout root answers here), then deeper — a worktree's `cdk/.secrets`
# sits at depth 5 under /workspace. `-H`: rg follows a symlinked root, so find must too. The deep walk prunes
# node_modules, .git, dist and cdk.out for speed (a catch-all glob re-admits them too; no secrets dir lives there).
# `|| true` + a non-empty test, not a pipeline: under pipefail, find's exit 1 on an unreadable dir would read as
# "none". What it finds is never printed.
FOUND=$(find -H "$ROOT" -maxdepth 2 -type d -iname .secrets -print -quit 2>/dev/null || true)
if [ -z "$FOUND" ]; then
  FOUND=$(find -H "$ROOT" -maxdepth 6 \( -name node_modules -o -name .git -o -name dist -o -name cdk.out \) -prune \
    -o -type d -iname .secrets -print -quit 2>/dev/null || true)
fi
if [ -n "$FOUND" ]; then
  deny "This Grep's glob (\`$GLOB\`) could match the gitignored \`.secrets\` directory's own name (or the bot key's) under \`$ROOT\`, so rg would pull the dir back into the search. $NARROW"
fi
exit 0
