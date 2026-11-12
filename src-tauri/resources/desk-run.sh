#!/bin/sh
# desk-run: keeps a coding agent running inside a sandbox after Desk disconnects.
#
# Desk uploads this file on every start, so an old copy never lingers. Each run
# gets a folder with append-only logs; any number of readers can follow it, and
# a reader that drops can pick up again from the line it last saw.
#
#   ~/.desk/runs/<run>/out.jsonl   every line the agent printed
#                      in.jsonl    every line sent to the agent
#                      err.log     what it printed on stderr
#                      env         variables for this run (0600), read once
#                      pid, exit   process group, exit code once it ends
#
#   desk-run start <run> <cwd> [--no-stdin] -- <argv...>   env lines on stdin
#   desk-run tail  <run> <from-line>     print from there, follow, end with desk_exit
#   desk-run send  <run>                 append stdin lines to in.jsonl
#   desk-run status <run>                one JSON line
#   desk-run stop  <run>                 end the agent and everything it started
#
# Env lines are NAME=value, or !NAME to unset. Only POSIX sh, tail, sed, wc and awk.

set -u
umask 077
ROOT="${DESK_RUNS:-$HOME/.desk/runs}"

die() { printf 'desk-run: %s\n' "$*" >&2; exit 2; }

run_dir() {
  case "$1" in
    ''|*[!A-Za-z0-9_-]*) die "bad run id: $1" ;;
  esac
  printf '%s/%s' "$ROOT" "$1"
}

# A short pause; fractional where sleep allows it.
nap() { sleep 0.25 2>/dev/null || sleep 1; }

json_escape() {
  awk 'BEGIN { ORS = "" }
    {
      gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "");
      gsub(/[\001-\037]/, "");
      if (NR > 1) printf "\\n";
      printf "%s", $0
    }'
}

lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }

alive() {
  [ -f "$1/pid" ] || return 1
  kill -0 "$(cat "$1/pid")" 2>/dev/null
}

emit_exit() {
  dir=$1
  code=$(cat "$dir/exit" 2>/dev/null || echo null)
  [ -n "$code" ] || code=null
  err=$(tail -n 40 "$dir/err.log" 2>/dev/null | json_escape)
  printf '{"type":"desk_exit","run":"%s","code":%s,"stderr":"%s"}\n' "$(basename "$dir")" "$code" "$err"
}

load_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '!'*) unset "${line#!}" 2>/dev/null ;;
      [A-Za-z_]*=*) export "$line" ;;
    esac
  done < "$1"
  rm -f "$1"
}

cmd_start() {
  [ $# -ge 3 ] || die "usage: start <run> <cwd> [--no-stdin] -- <argv...>"
  run=$1; dir=$(run_dir "$1") || exit 2; cwd=$2; shift 2
  stdin=yes
  if [ "${1:-}" = "--no-stdin" ]; then stdin=no; shift; fi
  [ "${1:-}" = "--" ] && shift
  [ $# -ge 1 ] || die "nothing to run"
  # Starting twice is harmless: a live run is left alone.
  if alive "$dir" && [ ! -f "$dir/exit" ]; then printf '{"run":"%s","started":false}\n' "$run"; return 0; fi
  mkdir -p "$dir" || die "can't create $dir"
  chmod 700 "$dir"
  cat > "$dir/env"
  chmod 600 "$dir/env"
  : >> "$dir/in.jsonl"; : >> "$dir/out.jsonl"; : >> "$dir/err.log"
  rm -f "$dir/exit" "$dir/pid"
  self=$0
  case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
  if command -v setsid >/dev/null 2>&1; then
    setsid sh "$self" _run "$dir" "$cwd" "$stdin" "$@" </dev/null >/dev/null 2>&1 &
  else
    nohup sh "$self" _run "$dir" "$cwd" "$stdin" "$@" </dev/null >/dev/null 2>&1 &
  fi
  # Wait until it has recorded itself, so tail and stop find it.
  i=0
  while [ ! -f "$dir/pid" ] && [ $i -lt 40 ]; do nap; i=$((i + 1)); done
  printf '{"run":"%s","started":true}\n' "$run"
}

# The detached half: owns the agent, feeds it in.jsonl, records how it ended.
cmd__run() {
  dir=$1; cwd=$2; stdin=$3; shift 3
  trap '' HUP
  echo $$ > "$dir/pid"
  load_env "$dir/env"
  cd "$cwd" 2>>"$dir/err.log" || { echo 127 > "$dir/exit"; exit 127; }
  if [ "$stdin" = yes ]; then
    rm -f "$dir/in.fifo"; mkfifo "$dir/in.fifo"
    tail -n +1 -f "$dir/in.jsonl" > "$dir/in.fifo" 2>/dev/null &
    feeder=$!
    "$@" < "$dir/in.fifo" >> "$dir/out.jsonl" 2>> "$dir/err.log" &
    agent=$!
    wait $agent; code=$?
    kill $feeder 2>/dev/null
    rm -f "$dir/in.fifo"
  else
    "$@" < /dev/null >> "$dir/out.jsonl" 2>> "$dir/err.log"
    code=$?
  fi
  echo $code > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
}

cmd_tail() {
  [ $# -ge 1 ] || die "usage: tail <run> [<from-line>]"
  dir=$(run_dir "$1") || exit 2; n=${2:-0}
  [ -d "$dir" ] || { printf '{"type":"desk_exit","run":"%s","code":null,"stderr":"No such run."}\n' "$1"; return 0; }
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  while :; do
    done_=no; [ -f "$dir/exit" ] && done_=yes
    total=$(lines "$dir/out.jsonl")
    if [ "$total" -gt "$n" ]; then
      sed -n "$((n + 1)),${total}p" "$dir/out.jsonl"
      n=$total
    fi
    # exit is written after the agent's last line, so nothing is lost here.
    if [ $done_ = yes ]; then emit_exit "$dir"; return 0; fi
    if ! alive "$dir" && [ ! -f "$dir/exit" ]; then
      # Gone without a word (the sandbox restarted, say).
      sleep 1
      [ -f "$dir/exit" ] || echo null > "$dir/exit"
    fi
    nap
  done
}

cmd_send() {
  [ $# -ge 1 ] || die "usage: send <run>"
  dir=$(run_dir "$1") || exit 2
  [ -d "$dir" ] || die "no such run: $1"
  # Line by line, so each message lands whole even while a reader follows.
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >> "$dir/in.jsonl"
  done
}

cmd_status() {
  [ $# -ge 1 ] || die "usage: status <run>"
  dir=$(run_dir "$1") || exit 2
  if [ ! -d "$dir" ]; then printf '{"run":"%s","exists":false}\n' "$1"; return 0; fi
  running=false; alive "$dir" && [ ! -f "$dir/exit" ] && running=true
  code=$(cat "$dir/exit" 2>/dev/null || echo null)
  [ -n "$code" ] || code=null
  printf '{"run":"%s","exists":true,"running":%s,"lines":%s,"exit":%s}\n' "$1" "$running" "$(lines "$dir/out.jsonl")" "$code"
}

cmd_stop() {
  [ $# -ge 1 ] || die "usage: stop <run>"
  dir=$(run_dir "$1") || exit 2
  [ -f "$dir/pid" ] || return 0
  pid=$(cat "$dir/pid")
  # A process group when setsid made one; the shell and its children otherwise.
  kill -TERM -- "-$pid" 2>/dev/null || { pkill -TERM -P "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; }
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do nap; i=$((i + 1)); done
  kill -KILL -- "-$pid" 2>/dev/null || { pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; }
  [ -f "$dir/exit" ] || echo 143 > "$dir/exit"
}

sub=${1:-}
[ $# -gt 0 ] && shift
case "$sub" in
  start) cmd_start "$@" ;;
  _run) cmd__run "$@" ;;
  tail) cmd_tail "$@" ;;
  send) cmd_send "$@" ;;
  status) cmd_status "$@" ;;
  stop) cmd_stop "$@" ;;
  *) die "usage: desk-run start|tail|send|status|stop <run> ..." ;;
esac
