#!/bin/bash
# Sourced by coi-reverse-shell-guard.sh (Bash) and coi-grep-guard.sh (Grep): COI v0.15.0's CRITICAL
# reverse-shell rules that fire in ANY process, mirrored with builtins only ([[ ]], case, ${//}) — nothing
# here spawns a process, so no flagged literal reaches an argv. Re-derive on every COI upgrade from
# localNotes/code-on-incus/APERTURE-ANALYSIS.md (§1, §6.A). No `set` flags — sourced into hooks.
COI_TOK='(^|[^[:alnum:]_.-])'   # COI's token anchor: not glued to a letter/digit/_/./- (process.go:458-476)
COI_REASON='' COI_CLASS=''

# COI's network indicator (process.go:500-508). Loopback host:port is exempt in COI; file.ext:N is not mirrored.
coi_net_indicator() {
  case "$1" in *socket*|*fsockopen*|*sockaddr*|*tcp*|*udp*) return 0 ;; esac
  local quad='(^|[[:space:]])[0-9]{1,3}(\.[0-9]{1,3}){3}([[:space:]]|$)'
  local hostport='[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+:[0-9]{1,5}'
  local t=${1//127.0.0.1:/}
  [[ $1 =~ $quad || $t =~ $hostport ]]
}

# 0 + COI_REASON/COI_CLASS when lowercased $1 carries a shape COI kills on in any process.
coi_kill_shape() {
  local t=$1
  local shells="${COI_TOK}(bash|sh|zsh|ksh|dash|ash|fish|csh|tcsh|mksh|oksh|lksh|posh|yash|rbash) -i"
  local netcat="${COI_TOK}(nc|ncat|nc\.traditional|nc\.openbsd) -e"
  local perlio="${COI_TOK}perl -mio(::socket|[^:[:alnum:]_]|$)"
  local oneliner="${COI_TOK}(python3? -c|perl -e|php -r|ruby -e)"
  COI_CLASS=strong
  if [[ $t =~ $shells ]]; then COI_REASON='an interactive shell (bash -i, sh -i, or another shell with -i)'; return 0; fi
  if [[ $t =~ $netcat ]]; then COI_REASON='netcat with -e'; return 0; fi
  case "$t" in *socket.socket*|*fsockopen*|*system.net.sockets*|*"ruby -rsocket"*)
    COI_REASON='a socket API name (socket.socket, fsockopen, System.Net.Sockets, ruby -rsocket)'; return 0 ;; esac
  if [[ $t =~ $perlio ]]; then COI_REASON='perl -MIO / -MIO::Socket'; return 0; fi
  case "$t" in *socat*|*powershell*)
    if coi_net_indicator "$t" || [[ $t == *socat* && ( $t == *exec:* || $t == *system:* ) ]]; then
      COI_REASON='socat/powershell with a network token (or socat with exec:/system:)'; return 0; fi ;; esac
  if [[ $t =~ $oneliner ]] && coi_net_indicator "$t"; then
    COI_CLASS=oneliner; COI_REASON='an interpreter one-liner on a line that also carries a network token (tcp, udp, socket, an IP, host:port)'; return 0; fi
  return 1
}

coi_deny() {  # message over stdin, never argv
  printf '%s' "$1" | jq -Rs '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:.}}'
  exit 0
}
