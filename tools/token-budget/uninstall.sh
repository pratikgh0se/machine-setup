#!/bin/bash
# Remove the LaunchAgent (spec section 5). State is kept unless --purge.
#   uninstall.sh [--purge] [--render-only|--dry-run]
# --render-only/--dry-run lists what would be removed and changes nothing.
set -u
LABEL="${LABEL_PREFIX:-com.machine-setup}.token-budget"
STATE="${TOKEN_BUDGET_STATE_DIR:-$HOME/.local/state/token-budget}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PURGE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --render-only|--dry-run) DRY=1 ;;
    *) echo "usage: uninstall.sh [--purge] [--render-only|--dry-run]" >&2; exit 2 ;;
  esac
done

if [ "$DRY" -eq 1 ]; then
  echo "would bootout: gui/$(id -u)/$LABEL"
  echo "would remove: $PLIST"
  if [ "$PURGE" -eq 1 ]; then echo "would purge state: $STATE"; else echo "state kept: $STATE"; fi
  exit 0
fi

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "removed: $PLIST"
if [ "$PURGE" -eq 1 ]; then
  case "$STATE" in
    ""|"/"|"$HOME"|"$HOME/") echo "refusing to purge unsafe path: '$STATE'" >&2; exit 1 ;;
  esac
  rm -rf "$STATE"
  echo "purged state: $STATE"
else
  echo "state kept: $STATE"
fi
