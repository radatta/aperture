# shellcheck shell=bash
# The `edit-pr` job: replace the body (and, when given, the title) of a lane's own open PR, as the user, with the same
# PR-only token as `open-pr`. runner.sh sources every job file before the first run, so this reuses open-pr.sh's
# constants (MR_OWNER, MR_REPO, MR_KEYCHAIN), params check and mr_* helpers and spells none of them itself.
# Five fixed calls, one write:
#   GET /user · GET …/git/ref/heads/<branch> · GET …/pulls?head=<owner>:<branch>&state=open
#   · POST /markdown (the same render check as open-pr) · PATCH …/pulls/<n> with only {body} or {title, body}
# The PR is found here, never named by the container: exactly one open PR from this repo's branch, by the token's
# owner, onto main, whose head is the job's sha (the body must describe what's pushed). Design: docs/ops/MAILROOM.md.

validate_edit_pr() { mr_validate "$1" true; }

run_edit_pr() {
  local w="$1" fail n pr cur
  mr_begin "$w" "$2" || return 0

  mr_call GET "/repos/$MR_REPO/pulls?head=$MR_OWNER:$MR_BRANCH&state=open"
  fail="$(mr_failure 200)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi
  n="$(jq -r 'if type == "array" then length else "x" end' "$MR_P.resp" 2>/dev/null || echo x)"
  case "$n" in
    0) mr_emit rejected NO_PR; return 0 ;;
    1) ;;
    x) mr_emit error API_FAILED; return 0 ;;
    *) mr_emit rejected MANY_PRS; return 0 ;;
  esac
  cur="$(jq -c '.[0]' "$MR_P.resp")"
  pr="$(mr_pr_json <<<"$cur")"
  if [ -z "$pr" ]; then mr_emit error API_FAILED; return 0; fi
  if [ "$(jq -r .author <<<"$pr")" != "$MR_OWNER" ]; then mr_emit error WRONG_AUTHOR "$pr"; return 0; fi
  if [ "$(jq -r '.base.ref // ""' <<<"$cur")" != main ]; then mr_emit rejected WRONG_BASE "$pr"; return 0; fi
  if [ "$(jq -r '.head.repo.full_name // ""' <<<"$cur")" != "$MR_REPO" ] || [ "$(jq -r .headSha <<<"$pr")" != "$MR_SHA" ]; then
    mr_emit rejected HEAD_MISMATCH "$pr"
    return 0
  fi
  n="$(jq -r .number <<<"$pr")"

  mr_render "$w" "$pr" || return 0

  # The one write: the text only. Never state, base, draft or maintainer_can_modify.
  jq -c '.params | if has("title") then {title, body} else {body} end' "$w" >"$MR_P.patch"
  mr_call PATCH "/repos/$MR_REPO/pulls/$n" "$MR_P.patch"
  fail="$(mr_failure 200)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail" "$pr"; return 0; fi
  pr="$(mr_pr_json <"$MR_P.resp")"
  if [ -z "$pr" ] || [ "$(jq -r .number <<<"$pr")" != "$n" ]; then mr_emit error API_FAILED; return 0; fi
  if [ "$(jq -r .author <<<"$pr")" != "$MR_OWNER" ]; then mr_emit error WRONG_AUTHOR "$pr"; return 0; fi
  # The result's bodySha256 is what GitHub now holds, so the container can tell a stored body from the one it sent.
  MR_BODY_SHA="$(jq -j '.body // ""' "$MR_P.resp" | sha256)"
  mr_emit edited - "$pr"
}
