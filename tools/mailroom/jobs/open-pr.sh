# shellcheck shell=bash
# The `open-pr` job: open a ready PR on radatta/aperture from a pushed feature branch, as the user, with their
# PR-only fine-grained token from Keychain. Sourced by runner.sh. Five fixed calls, one write:
#   GET /user · GET /repos/radatta/aperture/git/ref/heads/<branch> · GET …/pulls?head=radatta:<branch>&state=open
#   · POST /markdown (read-only: GitHub renders the body, and a mention or foreign issue link refuses it) · POST …/pulls
# Params and checks mirror scripts/src/mailroom/job.ts (the fixtures run both). Design: docs/ops/MAILROOM.md.

MR_OWNER="radatta"
MR_REPO="radatta/aperture"
MR_API="https://api.github.com"
MR_KEYCHAIN="aperture-mailroom-gh" # the ONLY token source: the Mac Keychain, never a file under the repo folder

# A link to another repo's issue, PR or discussion (GitHub posts a cross-reference there).
MR_XREF='[Gg][Ii][Tt][Hh][Uu][Bb]\.[Cc][Oo][Mm]/(?!radatta/aperture/)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(issues|pull|discussions)/[0-9]'

# Prints a reason code, or nothing when the params are good.
OPEN_PR_JQ='
  def visible:
    gsub("(^|\n)(?<f>`{3,})[^`\n]*\n[\\s\\S]*?\n\\k<f>`*[ \t]*(?=\n|$)"; "\n")
    | gsub("(?<![`\\\\])(?<t>`+)[^`\n]+\\k<t>(?!`)"; " ");
  def whole($re): (contains("\n") | not) and test($re); # in jq, $ also matches before a final newline
  def hidden_chars:
    explode | any(. as $c | ($c < 32 and $c != 9 and $c != 10) or ($c >= 127 and $c <= 159)
      or $c == 173 or ($c >= 8203 and $c <= 8207) or $c == 8232 or $c == 8233 or ($c >= 8234 and $c <= 8238)
      or ($c >= 8288 and $c <= 8292) or ($c >= 8294 and $c <= 8297) or $c == 65279 or $c == 65533
      or ($c >= 917504 and $c <= 917631) or $c == 1564 or $c == 4447 or $c == 4448 or $c == 6158 or $c == 12644
      or ($c >= 65024 and $c <= 65039) or $c == 65440 or ($c >= 6155 and $c <= 6159)
      or ($c >= 917760 and $c <= 917999));
  try (
    .params as $p
    | if ($p | type) != "object" or ($p | keys) != ["body","bodySha256","branch","sha","title"] then "BAD_PARAM"
    elif ($p.branch | type) != "string" or ($p.branch | whole("^[a-z0-9][a-z0-9-]{0,62}$") | not)
      or (["main","master","dev"] | index($p.branch)) != null then "BAD_PARAM"
    elif ($p.sha | type) != "string" or ($p.sha | whole("^[0-9a-f]{40}$") | not) then "BAD_PARAM"
    elif ($p.title | type) != "string" or ($p.title | whole("^[A-Za-z0-9][A-Za-z0-9 .,:;()/+_&'"'"'-]{3,99}$") | not) then "BAD_PARAM"
    elif ($p.title | test($xref)) then "XREF"
    elif ($p.body | type) != "string" or ($p.body | utf8bytelength) < 1 or ($p.body | utf8bytelength) > 65536 then "BAD_PARAM"
    elif ($p.bodySha256 | type) != "string" or ($p.bodySha256 | whole("^[0-9a-f]{64}$") | not) then "BAD_PARAM"
    elif ($p.body | hidden_chars) or ($p.body | test("&#|&[A-Za-z][A-Za-z0-9]*;")) then "BAD_TEXT"
    elif ($p.body | visible | test("(^|[^A-Za-z0-9_])@[A-Za-z0-9]")) then "MENTION"
    elif ($p.body | visible | test("#[0-9]|(^|[^A-Za-z0-9_])GH-[0-9]")) then "HASH_REF"
    elif ($p.body | visible | test($xref)) then "XREF"
    else empty end
  ) catch "BAD_PARAM"'

# Over the rendered HTML: a reason code, or nothing. GitHub decides what is code (<pre>, <code> go first), and an
# issue link GitHub made for this repo is fine; then mention / reference classes, any foreign issue URL (in text or
# an attribute — the token may not see a private repo, so GitHub won't always mark it), and the fast-pass patterns
# over what is left as text.
RENDER_JQ='
  def own: "href=\"https://github\\.com/radatta/aperture/(issues|pull|discussions)/[0-9]+(#[^\"]*)?\"";
  # GitHub escapes < inside attribute values; a literal one means HTML this scan cannot read safely, so refuse.
  if ([match("<[^>]*>"; "g").string | select(.[1:] | contains("<"))] | length) > 0 then "BAD_TEXT"
  else
  gsub("<pre[\\s>][\\s\\S]*?</pre>"; " ") | gsub("<code[\\s>][\\s\\S]*?</code>"; " ")
  | if test("class=\"[^\"]*(user-mention|team-mention)") then "MENTION"
    elif ([match("<a [^>]*class=\"[^\"]*issue-link[^>]*>"; "g") | .string | select(test(own) | not)] | length) > 0
      then "XREF"
    elif test($xref) then "XREF"
    else gsub("<a [^>]*class=\"[^\"]*issue-link[^\"]*\"[^>]*" + own + "[^>]*>[\\s\\S]*?</a>"; " ")
      | gsub("<[^>]*>"; " ")
      | if test("(^|[^A-Za-z0-9_])@[A-Za-z0-9]") then "MENTION"
        elif test("#[0-9]|(^|[^A-Za-z0-9_])GH-[0-9]") then "HASH_REF"
        else empty end
    end
  end'

validate_open_pr() {
  local w="$1" reason
  reason="$(jq -r --arg xref "$MR_XREF" "$OPEN_PR_JQ" "$w" 2>/dev/null)" || reason="BAD_PARAM"
  if [ -z "$reason" ] && [ "$(jq -j .params.body "$w" | sha256)" != "$(jq -r .params.bodySha256 "$w")" ]; then
    reason="BAD_PARAM" # the body changed in transit, or the container hashed something else
  fi
  printf '%s' "$reason"
  return 0
}

# mr_call METHOD PATH [DATA_FILE] — one GitHub call; sets MR_HTTP and MR_RC, the body lands in $MR_P.resp and the
# headers in $MR_P.hdr. The token goes in through a process-substituted header file built right on the curl line
# (the tools/raycast idiom), so it is never on an argv.
mr_call() {
  local data=()
  [ -z "${3:-}" ] || data=(--data-binary "@$3" -H 'Content-Type: application/json')
  MR_RC=0
  MR_HTTP="$(curl -sS --max-time 30 -D "$MR_P.hdr" -o "$MR_P.resp" -w '%{http_code}' -X "$1" \
    -H @<(printf 'Authorization: Bearer %s\n' "$MR_TOKEN") \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'User-Agent: aperture-mailroom' ${data[@]+"${data[@]}"} "$MR_API$2" 2>/dev/null)" || MR_RC=$?
}

# A failed call's reason code (empty when MR_HTTP is the wanted status $1).
mr_failure() {
  if [ "$MR_RC" = 28 ]; then echo TIMEOUT; return; fi
  if [ "$MR_RC" != 0 ]; then echo API_FAILED; return; fi
  [ "$MR_HTTP" != "$1" ] || return 0
  case "$MR_HTTP" in
    401) echo TOKEN_REJECTED ;;
    404) echo TOKEN_FORBIDDEN ;; # a fine-grained token answers 404 for what it may not see
    403 | 429)
      if grep -qiE '^(retry-after:|x-ratelimit-remaining: *0)' "$MR_P.hdr" 2>/dev/null; then echo RATE_LIMITED; else echo TOKEN_FORBIDDEN; fi ;;
    *) echo API_FAILED ;;
  esac
}

# The token's expiry from the first response's header, as ISO; warns under 14 days.
mr_expiry() {
  local raw
  raw="$(grep -i '^github-authentication-token-expiration:' "$MR_P.hdr" 2>/dev/null | head -1 | cut -d: -f2- | tr -d '\r' || true)"
  MR_EXPIRY_JSON="$(jq -cn --arg raw "$raw" 'try ($raw | sub("^ +"; "") | strptime("%Y-%m-%d %H:%M:%S UTC") | mktime) catch null
    | if . == null then {} else {tokenExpiresAt: todate}
        + (if . < now + 14 * 86400 then {tokenWarning: "TOKEN_EXPIRING"} else {} end) end')"
}

# The result's extra fields: the hash of what was sent, the token expiry, and the PR (anchored fields only).
mr_emit() {
  local status="$1" reason="$2" pr="${3:-null}"
  printf '%s %s %s\n' "$status" "$reason" "$(jq -cn --arg sha "$MR_BODY_SHA" --argjson exp "$MR_EXPIRY_JSON" \
    --argjson pr "$pr" '{bodySha256: $sha} + $exp + (if $pr == null then {} else {pr: $pr} end)')"
}

# The PR fields from a PR object on stdin, or nothing if any field isn't what GitHub would return for this repo.
mr_pr_json() {
  jq -c --arg url "^https://github\\.com/$MR_REPO/pull/[0-9]+$" \
    'select((.number | type) == "number" and (.html_url | type) == "string" and (.html_url | test($url))
      and (.head.sha | type) == "string" and (.head.sha | test("^[0-9a-f]{40}$"))
      and (.user.login | type) == "string" and (.user.login | test("^[A-Za-z0-9-]{1,39}$")))
    | {number, url: .html_url, headSha: .head.sha, author: .user.login}' 2>/dev/null || true
}

run_open_pr() {
  local w="$1" fail branch sha got pr
  MR_P="$2"
  MR_EXPIRY_JSON='{}'
  MR_BODY_SHA="$(jq -j .params.body "$w" | sha256)"
  branch="$(jq -r .params.branch "$w")"
  sha="$(jq -r .params.sha "$w")"

  MR_TOKEN="$(security find-generic-password -s "$MR_KEYCHAIN" -w 2>/dev/null || true)"
  if [ -z "$MR_TOKEN" ]; then mr_emit error TOKEN_MISSING; return 0; fi

  mr_call GET /user
  fail="$(mr_failure 200)"
  [ -n "$fail" ] || mr_expiry
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi
  if [ "$(jq -r '.login // ""' "$MR_P.resp" 2>/dev/null)" != "$MR_OWNER" ]; then mr_emit error WRONG_AUTHOR; return 0; fi

  mr_call GET "/repos/$MR_REPO/git/ref/heads/$branch"
  if [ "$MR_RC" = 0 ] && [ "$MR_HTTP" = 404 ]; then mr_emit rejected HEAD_MISSING; return 0; fi
  fail="$(mr_failure 200)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi
  got="$(jq -r '.object.sha // ""' "$MR_P.resp" 2>/dev/null || true)"
  if [ "$got" != "$sha" ]; then mr_emit rejected HEAD_MISMATCH; return 0; fi

  mr_call GET "/repos/$MR_REPO/pulls?head=$MR_OWNER:$branch&state=open"
  fail="$(mr_failure 200)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi
  pr="$(jq -c '.[0] // empty' "$MR_P.resp" 2>/dev/null | mr_pr_json)"
  if [ -n "$pr" ]; then mr_emit exists - "$pr"; return 0; fi

  # GitHub's own renderer has the last word on what the title + body link (the jq checks above are the fast pass).
  jq -c --arg ctx "$MR_REPO" '{text: (.params.title + "\n\n" + .params.body), mode: "gfm", context: $ctx}' "$w" >"$MR_P.md"
  mr_call POST /markdown "$MR_P.md"
  fail="$(mr_failure 200)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi
  fail="$(jq -Rsr --arg xref "$MR_XREF" "$RENDER_JQ" "$MR_P.resp" 2>/dev/null || echo API_FAILED)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi

  jq -c --arg base main '{title: .params.title, head: .params.branch, base: $base, body: .params.body,
    draft: false, maintainer_can_modify: false}' "$w" >"$MR_P.post"
  mr_call POST "/repos/$MR_REPO/pulls" "$MR_P.post"
  fail="$(mr_failure 201)"
  if [ -n "$fail" ]; then mr_emit "$(status_of "$fail")" "$fail"; return 0; fi
  pr="$(mr_pr_json <"$MR_P.resp")"
  if [ -z "$pr" ]; then mr_emit error API_FAILED; return 0; fi
  if [ "$(jq -r .author <<<"$pr")" != "$MR_OWNER" ]; then mr_emit error WRONG_AUTHOR "$pr"; return 0; fi
  mr_emit opened - "$pr"
}
