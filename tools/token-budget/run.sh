#!/bin/bash
# Token-budget orchestrator: probe -> analyze -> report/notify -> last-run.json.
# Usage: run.sh [--catch-up] [--force]
# Exit: 0 ok/no-op; 10 probe failed; 11 analyze failed; 12 report failed.
set -u
export USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}"  # AC 86: claude/gh need USER for Keychain auth; launchd may not set it
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATCH=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --catch-up) CATCH=1 ;;
    --force) FORCE=1 ;;
    *) echo "usage: run.sh [--catch-up] [--force]" >&2; exit 64 ;;
  esac
done

STATE="${TOKEN_BUDGET_STATE_DIR:-$HOME/.local/state/token-budget}"
export TOKEN_BUDGET_STATE_DIR="$STATE"
mkdir -p "$STATE/logs" && chmod 700 "$STATE" 2>/dev/null || { echo "run: state dir unwritable: $STATE" >&2; exit 10; }
LOG="$STATE/logs/run.log"
TB="python3 $DIR/tb_run.py"

log() { echo "$($TB log-ts) $*" >>"$LOG"; }

if [ "$CATCH" -eq 1 ]; then
  if ! $TB catchup-needed; then
    log "catch-up: not needed"
    exit 0
  fi
fi

# Lock (mkdir is atomic); reclaim if holder is dead.
LOCK="$STATE/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  HOLDER="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null; then
    log "already running (pid $HOLDER)"
    echo "already running"
    exit 0
  fi
  log "reclaiming stale lock (pid ${HOLDER:-?})"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { log "lock race lost"; exit 0; }
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

finish() { # status exit stage
  $TB last-run "$1" "$2"
  if [ "$1" != "ok" ]; then
    log "stage failed: $3 (exit $2)"
    $TB notify "Token Budget failed: $3" "Token Budget"
  fi
  exit "$2"
}

WEEK="$($TB week)"
log "run start (week $WEEK, catch-up=$CATCH, force=$FORCE)"

# 1. probe (skipped when this week already has a ledger line, unless --force)
if [ "$FORCE" -eq 0 ] && $TB ledger-has-week; then
  log "probe skipped: ledger already has week $WEEK"
else
  "$DIR/probe.sh" >>"$LOG" 2>&1
  RC=$?
  [ "$RC" -eq 0 ] || { log "probe exit $RC"; finish failed 10 probe; }
fi

# 2. analyze
ARGS=(--state-dir "$STATE")
[ -n "${TOKEN_BUDGET_NOW:-}" ] && ARGS+=(--now "$TOKEN_BUDGET_NOW")
[ -n "${CLAUDE_HOME:-}" ] && ARGS+=(--claude-home "$CLAUDE_HOME")
[ -n "${CLAUDE_SETTINGS_FILE:-}" ] && ARGS+=(--settings "$CLAUDE_SETTINGS_FILE")
python3 "$DIR/analyze.py" "${ARGS[@]}" >/dev/null 2>>"$LOG"
RC=$?
[ "$RC" -eq 0 ] || { log "analyze exit $RC"; finish failed 11 analyze; }

# 3. report + notify
$TB report
RC=$?
[ "$RC" -eq 0 ] || { log "report exit $RC"; finish failed 12 report; }

log "run ok"
finish ok 0 done
