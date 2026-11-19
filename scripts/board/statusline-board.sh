#!/bin/bash
# Sourced by the status line (after the board line): the web tower's derived board.line (docs/ops/TOWER.md → Board
# freshness) as `· usage 13% · 9.0%/h · ~9.5 h to 100% · ctx ≥50 lc-catalog · 3 ≥40 · board 12m · 3 stale · next ~19:40
# coach-fixes`, the next merge last (no length cap: only it gets cut). ctx (F240): red with the names at 50 %, amber
# with a count at 40 %, nothing below. Builtins only — no processes; only the vm load when the file is absent or
# unreadable.
# Dim when the board is fresh, amber with stale items, red past the tower's threshold; red "tower down" once the tower
# hasn't written for 3 min (its facts are then old). Replaces localNotes/board/next-merge.sh, whose merge row it reads
# after the tower's own derivation (a merged PR's row is gone). First, `· mac 6 8 12/12 · vm 2 5 9/9 · slow 30m tc×1.2
# lint– gl×1.0 gn– gw×1.1` (F293): the Mac's load, the VM's live /proc/loadavg over the container's cores (shown whatever
# the tower's state; the core count from the file), and the slowdown's cut in its tone. Replaces
# localNotes/board/slowdown-line.sh: while that file is still there, it prints these three itself, so this leaves them
# out. vm rounds half to even (printf), mac half up (the tower), as that file did.
_bl_f="${APERTURE_BOARD_DIR:-/workspace/localNotes/board}/board.line"
_bl_w= _bl_vm= _bl_vmt= _bl_own=1
[ -r "${_bl_f%/*}/slowdown-line.sh" ] && _bl_own=
if [ -r "$_bl_f" ]; then
  printf -v _bl_now '%(%s)T' -1 # bash ≥ 4.2 (the container's; not the Mac's 3.2)
  _bl_merge= _bl_usage= _bl_ctx= _bl_slow= _bl_mac=
  {
    IFS=' ' read -r _bl_w _bl_q _bl_n _bl_tone _bl_x || : # an empty file: nothing, even under set -e
    while IFS=' ' read -r _bl_k _bl_rest; do
      case $_bl_k in
        merge) _bl_merge=$_bl_rest ;;
        usage) _bl_usage=$_bl_rest ;;
        ctx) _bl_ctx=$_bl_rest ;;
        slow) _bl_slow=$_bl_rest ;;
        mac) _bl_mac=$_bl_rest ;;
        vm) _bl_vm=$_bl_rest ;;
      esac
    done
  } <"$_bl_f"
fi
# the VM's load (1/5/15 min: lxcfs passes /proc/loadavg through, SESSION-BOARD.md → Watchers) over its cores: live, so it needs no tower
if [ -n "$_bl_own" ] && read -r _bl_l1 _bl_l5 _bl_l15 _bl_x 2>/dev/null <"${APERTURE_LOADAVG:-/proc/loadavg}"; then
  _bl_re='^[0-9]+(\.[0-9]+)?$'
  if [[ "$_bl_l1" =~ $_bl_re ]] && [[ "$_bl_l5" =~ $_bl_re ]] && [[ "$_bl_l15" =~ $_bl_re ]]; then
    _bl_cx=; [[ "$_bl_vm" =~ ^[0-9]+$ ]] && _bl_cx="/$_bl_vm"
    printf -v _bl_vmt ' \033[2m· vm %.0f %.0f %.0f%s\033[0m' "$_bl_l1" "$_bl_l5" "$_bl_l15" "$_bl_cx"
  fi
fi
if [[ "$_bl_w" =~ ^[0-9]+$ ]]; then
  if [ $((_bl_now - _bl_w)) -gt 180 ]; then
    printf '%s \033[31m· tower down (board.line %s min old)\033[0m' "$_bl_vmt" $(((_bl_now - _bl_w) / 60))
  else
    if [ -n "$_bl_own" ]; then
      read -r _bl_m1 _bl_m5 _bl_m15 _bl_mn _bl_x <<<"$_bl_mac"
      [[ "$_bl_m1" =~ ^[0-9]+$ ]] && [[ "$_bl_m5" =~ ^[0-9]+$ ]] && [[ "$_bl_m15" =~ ^[0-9]+$ ]] && [[ "$_bl_mn" =~ ^[0-9]+$ ]] &&
        printf ' \033[2m· mac %s %s %s/%s\033[0m' "$_bl_m1" "$_bl_m5" "$_bl_m15" "$_bl_mn"
      printf '%s' "$_bl_vmt"
      # the slowdown: "<ok|warn|bad> <text>", dim, amber or red like the tower's CONTAINER tile
      _bl_slt=${_bl_slow%% *} _bl_slx=${_bl_slow#* }
      if [[ "$_bl_slow" == *' '* ]] && [ -n "$_bl_slx" ]; then
        case $_bl_slt in ok) printf ' \033[2m· %s\033[0m' "$_bl_slx" ;; warn) printf ' \033[33m· %s\033[0m' "$_bl_slx" ;; bad) printf ' \033[31m· %s\033[0m' "$_bl_slx" ;; esac
      fi
    fi
    # the usage line, while under 15 min old: "<atEpoch> <text>"
    _bl_ua=${_bl_usage%% *}
    [[ "$_bl_ua" =~ ^[0-9]+$ ]] && [ $((_bl_now - _bl_ua)) -le 900 ] && printf ' \033[2m· %s\033[0m' "${_bl_usage#* }"
    # sessions over the context lines: "<n≥40> <n≥50> <names≥50,…|->"
    read -r _bl_c40 _bl_c50 _bl_cn <<<"$_bl_ctx"
    if [[ "$_bl_c40" =~ ^[0-9]+$ ]] && [[ "$_bl_c50" =~ ^[0-9]+$ ]] && [ "$_bl_c40" -gt 0 ]; then
      if [ "$_bl_c50" -gt 0 ]; then
        _bl_sx=; [ $((_bl_c40 - _bl_c50)) -gt 0 ] && _bl_sx=" · $((_bl_c40 - _bl_c50)) ≥40"
        printf ' \033[31m· ctx ≥50 %s%s\033[0m' "${_bl_cn//,/, }" "$_bl_sx"
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
else
  printf '%s' "$_bl_vmt" # no board.line, or a garbled one: the live load alone
fi
unset _bl_slow _bl_mac _bl_vm _bl_vmt _bl_own _bl_l1 _bl_l5 _bl_l15 _bl_re _bl_cx _bl_m1 _bl_m5 _bl_m15 _bl_mn _bl_slt _bl_slx
unset _bl_sx _bl_f _bl_now _bl_merge _bl_usage _bl_ctx _bl_c40 _bl_c50 _bl_cn _bl_w _bl_q _bl_n _bl_tone _bl_k _bl_rest _bl_ua _bl_c _bl_age _bl_m _bl_txt _bl_at _bl_hm _bl_what _bl_mark _bl_x
