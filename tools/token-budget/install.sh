#!/bin/bash
# Install the weekly LaunchAgent (spec section 5).
#   install.sh                     create state dir, render plist, lint, bootstrap (idempotent)
#   install.sh --render-only PATH  only render the plist to PATH (no launchctl, no state dir)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
LABEL="${LABEL_PREFIX:-com.machine-setup}.token-budget"
STATE="${TOKEN_BUDGET_STATE_DIR:-$HOME/.local/state/token-budget}"
TMPL="$REPO/launchd/token-budget.plist.tmpl"   # single source of truth (also used by setup/bootstrap.sh)
LP="${LABEL_PREFIX:-com.machine-setup}"

render() { # dest
  sed -e "s|__LABEL_PREFIX__|$LP|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__/.local/state/token-budget|$STATE|g" -e "s|__HOME__|$HOME|g" "$TMPL" >"$1"
}

if [ "${1:-}" = "--render-only" ]; then
  [ -n "${2:-}" ] || { echo "usage: install.sh --render-only PATH" >&2; exit 2; }
  render "$2" || exit 1
  plutil -lint "$2" >/dev/null || exit 1
  echo "rendered $2"
  exit 0
fi
[ $# -eq 0 ] || { echo "usage: install.sh [--render-only PATH]" >&2; exit 2; }

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$STATE/logs" && chmod 700 "$STATE" || exit 1
mkdir -p "$(dirname "$PLIST")" || exit 1
render "$PLIST" || exit 1
plutil -lint "$PLIST" || exit 1
UIDN="$(id -u)"
launchctl bootout "gui/$UIDN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UIDN" "$PLIST" || exit 1
echo "installed: $LABEL"
python3 - <<'EOF'
from datetime import datetime, timedelta
n = datetime.now().astimezone()
d = n.date() + timedelta(days=(7 - n.weekday()) % 7)
t = datetime(d.year, d.month, d.day, 9, 0).astimezone()
if t <= n:
    t += timedelta(days=7)
print("next fire time: %s" % t.strftime("%Y-%m-%d %H:%M %Z"))
EOF
