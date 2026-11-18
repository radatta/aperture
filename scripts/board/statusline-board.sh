#!/bin/bash
# Sourced by the status line (after the board line): the web tower's derived board.line (docs/ops/TOWER.md → Board
# freshness) as `· usage 13% · 9.0%/h · ~9.5 h to 100% · ctx ≥50 lc-catalog · 3 ≥40 · board 12m · 3 stale · next ~19:40
# coach-fixes`, the next merge last (no length cap: only it gets cut). ctx (F240): red with the names at 50 %, amber
# with a count at 40 %, nothing below. Builtins only — no processes; silent when the file is absent or unreadable.
# Dim when the board is fresh, amber with stale items, red past the tower's threshold; red "tower down" once the tower
# hasn't written for 3 min (its facts are then old). Replaces localNotes/board/next-merge.sh, whose merge row it reads
# after the tower's own derivation (a merged PR's row is gone).
_bl_f="${APERTURE_BOARD_DIR:-/workspace/localNotes/board}/board.line"
if [ -r "$_bl_f" ]; then
  _bl_now=$(printf '%(%s)T' -1)
  _bl_merge= _bl_usage= _bl_ctx=
  {
    IFS=' ' read -r _bl_w _bl_q _bl_n _bl_tone _bl_x
    while IFS=' ' read -r _bl_k _bl_rest; do
      case $_bl_k in
        merge) _bl_merge=$_bl_rest ;;
        usage) _bl_usage=$_bl_rest ;;
        ctx) _bl_ctx=$_bl_rest ;;
      esac
    done
  } <"$_bl_f"
  if [[ "$_bl_w" =~ ^[0-9]+$ ]]; then
    if [ $((_bl_now - _bl_w)) -gt 180 ]; then
      printf ' \033[31m· tower down (board.line %s min old)\033[0m' $(((_bl_now - _bl_w) / 60))
    else
      # the usage line, while under 15 min old: "<atEpoch> <text>"
      _bl_ua=${_bl_usage%% *}
      [[ "$_bl_ua" =~ ^[0-9]+$ ]] && [ $((_bl_now - _bl_ua)) -le 900 ] && printf ' \033[2m· %s\033[0m' "${_bl_usage#* }"
      # sessions over the context lines: "<n≥40> <n≥50> <names≥50,…|->"
      read -r _bl_c40 _bl_c50 _bl_cn <<<"$_bl_ctx"
      if [[ "$_bl_c40" =~ ^[0-9]+$ ]] && [[ "$_bl_c50" =~ ^[0-9]+$ ]] && [ "$_bl_c40" -gt 0 ]; then
        if [ "$_bl_c50" -gt 0 ]; then
          printf ' \033[31m· ctx ≥50 %s%s\033[0m' "${_bl_cn//,/, }" "$([ $((_bl_c40 - _bl_c50)) -gt 0 ] && printf ' · %s ≥40' $((_bl_c40 - _bl_c50)))"
        else
          printf ' \033[33m· ctx %s ≥40\033[0m' "$_bl_c40"
        fi
      fi
      case $_bl_tone in bad) _bl_c='31' ;; warn) _bl_c='33' ;; *) _bl_c='2' ;; esac
      _bl_age='?'
      [[ "$_bl_q" =~ ^[0-9]+$ ]] && { _bl_m=$(((_bl_now - _bl_q) / 60)); _bl_age="${_bl_m}m"; [ "$_bl_m" -ge 60 ] && _bl_age="$((_bl_m / 60))h"; }
      _bl_txt="board $_bl_age"
      [ "${_bl_n:-0}" != 0 ] && _bl_txt+=" · $_bl_n stale"
      printf ' \033[%sm· %s\033[0m' "$_bl_c" "$_bl_txt"
      # the next merge: "<atEpoch> <HH:MM> <what>"; "?" once its time has passed
      read -r _bl_at _bl_hm _bl_what <<<"$_bl_merge"
      if [[ "$_bl_at" =~ ^[0-9]+$ ]]; then
        _bl_mark='~'
        [ "$_bl_now" -gt "$_bl_at" ] && _bl_mark='?'
        _bl_what=${_bl_what#Merge }
        printf ' \033[2m· next %s%s%s\033[0m' "$_bl_mark" "$_bl_hm" "${_bl_what:+ $_bl_what}"
      fi
    fi
  fi
  unset _bl_f _bl_now _bl_merge _bl_usage _bl_ctx _bl_c40 _bl_c50 _bl_cn _bl_w _bl_q _bl_n _bl_tone _bl_k _bl_rest _bl_ua _bl_c _bl_age _bl_m _bl_txt _bl_at _bl_hm _bl_what _bl_mark _bl_x
else
  unset _bl_f
fi
