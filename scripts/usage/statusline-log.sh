# Usage meter logger (docs/ops/USAGE-METER.md). Sourced by the Claude Code status-line script with $input set to
# the status-line JSON; appends one JSONL row per session to <dir>/meter-<local day>.jsonl — the account's
# rate_limits (weekly used %), this session's cumulative list-price cost, cache and context. At most one row per
# session per APERTURE_USAGE_MIN_SEC (30), plus one whenever the weekly % moved, so meter ticks are timed sharply.
# Silent and fast: prints nothing, ignores every failure, unsets its helpers, so the status line never breaks.
# Undo: remove the sourcing line from the status-line script.
# Safe under a caller's `set -eu`: errexit is off for the block and restored after; every variable has a default.
case $- in *e*) _ul_e=1 && set +e ;; *) _ul_e= ;; esac
{
  _ul_sid=$(jq -r '.session_id // empty' <<<"${input-}" 2>/dev/null)
  if [ -n "$_ul_sid" ]; then
    _ul_dir=${APERTURE_USAGE_DIR:-/workspace/localNotes/usage}
    _ul_stamp="${APERTURE_USAGE_STAMP_DIR:-/tmp}/aperture-usage-stamp-$_ul_sid"
    _ul_pct=$(jq -r '.rate_limits.seven_day.used_percentage // empty' <<<"${input-}" 2>/dev/null)
    _ul_now=$(date +%s)
    _ul_last=$(stat -c %Y "$_ul_stamp" 2>/dev/null || echo 0)
    _ul_prev=$(cat "$_ul_stamp" 2>/dev/null)
    if [ $((_ul_now - _ul_last)) -ge "${APERTURE_USAGE_MIN_SEC:-30}" ] || [ "$_ul_pct" != "$_ul_prev" ]; then
      printf '%s' "$_ul_pct" >"$_ul_stamp"
      mkdir -p "$_ul_dir"
      jq -c --arg ts "$(date -Iseconds)" '{ts:$ts, sid:.session_id, name:.session_name, cwd:.workspace.current_dir,
        branch:(.worktree.branch // null), pr:(.pr.number // null), agent:(.agent.name // null), model:.model.id,
        cost:(.cost.total_cost_usd // null), rl:(.rate_limits // null), cache:(.prompt_cache // null),
        ctx:(.context_window.current_usage // null), tp:.transcript_path, v:.version, lv:1}' <<<"${input-}" \
        >>"$_ul_dir/meter-$(date +%F).jsonl"
    fi
  fi
  unset _ul_sid _ul_dir _ul_stamp _ul_pct _ul_now _ul_last _ul_prev
} >/dev/null 2>&1
if [ -n "$_ul_e" ]; then set -e; fi
unset _ul_e
