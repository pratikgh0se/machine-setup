#!/bin/bash
# Token-budget probe: 2 Haiku calls -> ledger line + manifest. See docs/token-budget-spec.md 4.1.
# Usage: probe.sh [--dry-run]
# Exit: 0 ok, 2 claude missing, 3 /context unparseable, 4 trivial-turn unparseable, 5 state dir unwritable.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: probe.sh [--dry-run]" >&2; exit 64 ;;
esac

CLAUDE_BIN="${TOKEN_BUDGET_CLAUDE_BIN:-claude}"
STATE="${TOKEN_BUDGET_STATE_DIR:-$HOME/.local/state/token-budget}"
export TOKEN_BUDGET_STATE_DIR="$STATE"

if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "probe: claude binary not found: $CLAUDE_BIN" >&2
  exit 2
fi

if [ "$DRY" -eq 0 ]; then
  if ! { mkdir -p "$STATE" && chmod 700 "$STATE" && [ -w "$STATE" ]; } 2>/dev/null; then
    echo "probe: state dir not writable: $STATE" >&2
    exit 5
  fi
fi

SCRATCH="$(mktemp -d)" || exit 1
WORK="$(mktemp -d)" || { rm -rf "$SCRATCH"; exit 1; }
cleanup() { cd / 2>/dev/null; rm -rf "$SCRATCH" "$WORK"; }
trap cleanup EXIT
cd "$SCRATCH" || exit 1

DRYARG=""
[ "$DRY" -eq 1 ] && DRYARG="--dry-run"

# Step 2: /context
"$CLAUDE_BIN" -p --model haiku "/context" >"$WORK/context.txt" 2>"$WORK/context.err" </dev/null
python3 "$DIR/tb_probe.py" ctx-check "$WORK/context.txt" $DRYARG || exit $?

# Step 3: trivial turn
"$CLAUDE_BIN" -p --model haiku --output-format json "reply with the single word ok" >"$WORK/turn.json" 2>"$WORK/turn.err" </dev/null
TURN_RC=$?
if [ "$TURN_RC" -ne 0 ]; then
  echo "probe: trivial turn failed (rc=$TURN_RC)" >&2
  exit 4
fi

# Steps 4-5: ccusage, manifest, ledger (cwd stays the scratch dir; helper never writes there)
python3 "$DIR/tb_probe.py" build --context "$WORK/context.txt" --turn "$WORK/turn.json" $DRYARG
exit $?
