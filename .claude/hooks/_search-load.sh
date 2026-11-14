#!/bin/bash
# Sourced by coi-reverse-shell-guard.sh after _coi-patterns.sh (it uses COI_TOK). The search-load rule — NOT a COI
# rule: it protects the VM's memory (docs/ops/COI-INCIDENTS.md → Incident I). Builtins only, like the COI patterns,
# so no searched-for text reaches an argv. Quoted spans are text and heredoc bodies are dropped (the
# board-heavy-guard.sh idiom). No `set` flags — sourced into hooks.
SEARCH_REASON=''
_sl_norm() { local p=$1; while [[ $p == ./* ]]; do p=${p#./}; done; [[ $p == / ]] || p=${p%/}; printf '%s' "${p:-.}"; }
_sl_isroot() { # $1 absolute dir ('' = unknown → assume a root), $2 the main checkout
  local d=$1 m=$2
  [[ -z $d || $d == / || $d == "$m" || $d == "${HOME:-/nonexistent}" || $d == "$m/.claude" || $d == "$m/.claude/worktrees" ]] && return 0
  [[ $d == "$m"/.claude/worktrees/* && ${d#"$m"/.claude/worktrees/} != */* ]] && return 0
  [[ $d == /* && -e $d/.git ]]
}
_sl_outer() { # $1 path as written, $2 effective cwd, $3 main — home, /, a `..` chain, the worktrees parent
  local p; p=$(_sl_norm "$1")
  case $p in /|\~|\$HOME|\$\{HOME\}|"${HOME:-/nonexistent}"|"$3/.claude"|"$3/.claude/worktrees") return 0 ;; esac
  [[ $p =~ ^\.\.(/\.\.)*$ ]] && return 0
  [[ $2 == "$3" && ( $p == .claude || $p == .claude/worktrees ) ]]
}
_sl_repo() { # a checkout root, as `.`/`./`/$PWD or an absolute path
  local p; p=$(_sl_norm "$1")
  case $p in .|\$PWD) _sl_isroot "$2" "$3" ;; /*) _sl_isroot "$p" "$3" ;; *) return 1 ;; esac
}

# 0 + SEARCH_REASON (pad|scope) when the RAW command $1 (flag case matters) runs a costly search. $2 the session's
# cwd, $3 the main checkout. pad: a .{M,N} (or BRE .\{M,N\}) with N >= 20 in a grep / git grep / rg that reads
# files — a pipe's output passes. scope: an ignore-blind recursive search (grep -r, rg -u/--no-ignore, git grep
# --no-index/--untracked) on a checkout root, home, / or the worktrees dir. Plain git grep and rg read only what
# git tracks or doesn't ignore, so they pass at the root.
search_load_shape() {
  local c=$1 ecwd=${2%/} main=${3%/} line end='' body='' seg a ch v tool vals i p gcwd rest
  local q="\"[^\"]*\"|'[^']*'" pad='\.\\?\{[0-9]*,([0-9]+)\\?\}'
  local gate="${COI_TOK}(e?grep|fgrep|rgrep|ugrep|rg)([[:space:]]|\$)"
  local -a w pos
  local piped xa rec unr noidx pat dd wide=0 files walk
  SEARCH_REASON=''
  [[ $c =~ $gate ]] || return 1
  while IFS= read -r line; do # drop heredoc bodies, keep the opening line
    if [[ -n $end ]]; then [[ ${line//[[:space:]]/} == "$end" ]] && end=''; continue; fi
    body+=$line$'\n'
    if [[ $line =~ \<\<-?[[:space:]]*[\'\"]?([A-Za-z_][A-Za-z0-9_]*) ]]; then end=${BASH_REMATCH[1]}; fi
  done <<<"$c"
  rest=$body # padding is read before the quotes are blanked: it lives inside them
  while [[ $rest =~ $pad ]]; do
    v=${BASH_REMATCH[1]}
    if (( ${#v} > 3 || 10#$v >= 20 )); then wide=1; break; fi
    rest=${rest#*"${BASH_REMATCH[0]}"}
  done
  c=$body
  while [[ $c =~ $q ]]; do c=${c/"${BASH_REMATCH[0]}"/Q}; done
  c=${c//2>&1/ }; c=${c//|&/|}; c=${c//||/$'\n'}; c=${c//|/$'\n'@pipe }; c=${c//&&/$'\n'}; c=${c//;/$'\n'}; c=${c//&/$'\n'}
  c=${c//\(/$'\n'}; c=${c//\`/$'\n'}; c=${c//)/ }
  while IFS= read -r seg; do
    read -r -a w <<<"$seg"
    piped=0 xa=0
    while (( ${#w[@]} )); do
      case ${w[0]} in
        @pipe) piped=1 ;;
        xargs) xa=1 ;;
        *=*|env|timeout|time|nice|ionice|nohup|setsid|stdbuf|command|exec|sudo|-*|[0-9]*|"{}"|"{"|"}"|"!"|if|then|do|else|elif|while|until) ;;
        *) break ;;
      esac
      w=("${w[@]:1}")
    done
    (( ${#w[@]} )) || continue
    tool=${w[0]##*/} i=1 gcwd=$ecwd
    case $tool in
      cd|pushd) p=${w[1]:-\~}; if [[ $p == /* ]]; then ecwd=$(_sl_norm "$p"); else ecwd='?'; fi; continue ;;
      git)
        tool=''
        while (( i < ${#w[@]} )); do
          case ${w[i]} in
            -C) p=${w[i+1]:-}; if [[ $p == /* ]]; then gcwd=$(_sl_norm "$p"); else gcwd='?'; fi; i=$((i + 2)) ;;
            -c|--git-dir|--work-tree|--namespace) i=$((i + 2)) ;;
            -*) i=$((i + 1)) ;;
            grep) tool=gitgrep; i=$((i + 1)); break ;;
            *) break ;;
          esac
        done ;;
    esac
    case $tool in # short options that take a value
      grep|egrep|fgrep|rgrep|ugrep) vals=efABCmdD ;;
      rg) vals=efABCmgtTdjMrE ;;
      gitgrep) vals=efABCm ;;
      *) continue ;;
    esac
    rec=0 unr=0 noidx=0 pat=0 dd=0 pos=()
    [[ $tool == rgrep ]] && rec=1
    for (( ; i < ${#w[@]}; i++ )); do
      a=${w[i]}
      if (( dd )); then pos+=("$a"); continue; fi
      case $a in
        --) dd=1 ;;
        --recursive|--dereference-recursive) rec=1 ;;
        --no-index|--untracked) noidx=1 ;;
        --no-ignore*|--unrestricted) unr=1 ;;
        --regexp|--file) pat=1; i=$((i + 1)) ;;
        --regexp=*|--file=*) pat=1 ;;
        --include|--exclude|--exclude-dir|--glob|--iglob|--type|--type-not|--max-count|--context|--after-context|--before-context|--max-depth|--threads|--max-columns|--replace|--encoding|--sort|--sortr|--color|--colors|--max-filesize) i=$((i + 1)) ;;
        --*) ;;
        -?*)
          v=${a#-}
          while [[ -n $v ]]; do
            ch=${v:0:1} v=${v:1}
            case $tool:$ch in rg:u) unr=1 ;; rg:*|gitgrep:*) ;; *:r|*:R) rec=1 ;; esac
            if [[ $vals == *"$ch"* ]]; then
              [[ $ch == [ef] ]] && pat=1
              [[ -z $v ]] && i=$((i + 1))
              break
            fi
          done ;;
        [0-9]\>|[0-9]\>\>|\>|\>\>|\<|\&\>) i=$((i + 1)) ;;
        [0-9]\>*|\>*|\<*|\&\>*) ;;
        *) pos+=("$a") ;;
      esac
    done
    if (( pat == 0 && ${#pos[@]} )); then pos=("${pos[@]:1}"); fi # the first positional is the pattern
    files=0
    if [[ $tool == gitgrep ]] || (( !piped || rec || xa || ${#pos[@]} )); then files=1; fi
    if (( wide && files )); then SEARCH_REASON=pad; return 0; fi
    (( xa )) && continue
    case $tool in gitgrep) walk=$noidx ;; rg) walk=$unr ;; *) walk=$rec ;; esac # does it ignore .gitignore?
    if (( ${#pos[@]} == 0 )); then
      if (( walk )) && _sl_isroot "$gcwd" "$main"; then SEARCH_REASON=scope; return 0; fi
      continue
    fi
    for p in "${pos[@]}"; do
      if [[ $tool != gitgrep || $noidx == 1 ]] && _sl_outer "$p" "$gcwd" "$main"; then SEARCH_REASON=scope; return 0; fi
      if (( walk )) && _sl_repo "$p" "$gcwd" "$main"; then SEARCH_REASON=scope; return 0; fi
    done
  done <<<"$c"
  return 1
}
