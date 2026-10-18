#!/usr/bin/env bash
# autosync.sh: daily pull, export, commit of the public repo (held locally for review: publish with setup/publish.sh --push) and commit+push of the private overlay (launchd job: <prefix>.machine-setup-autosync).
# No overlay configured: logs it and exits 0 (nothing to sync). Any failure sends a macOS notification and exits non-zero;
# nothing is committed in either repo if export (including its secret/leak scans) fails. Overlay: see lib/overlay.sh.
set -uo pipefail
export USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}"  # AC 86: claude/gh need USER for Keychain auth; launchd may not set it
ROOT="$(cd "$(dirname "$0")" && pwd)"   # setup/
REPO="$(cd "$ROOT/.." && pwd)"           # public repo
. "$ROOT/lib/overlay.sh"
ms_resolve_overlay
LOGDIR="$HOME/.local/state/machine-setup"; LOG="$LOGDIR/autosync.log"
mkdir -p "$LOGDIR"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
fail() {  # fail STAGE
  log "FAILED ($1)"
  osascript -e "display notification \"machine-setup: autosync failed ($1)\" with title \"machine-setup\"" >/dev/null 2>&1 || true
  exit 1
}
log "start"
log "overlay: ${OVERLAY:-none}"
if [ -z "$OVERLAY" ]; then log "no overlay configured; nothing to sync"; exit 0; fi

OV_GIT=0
if [ "$(git -C "$OVERLAY" rev-parse --show-toplevel 2>/dev/null)" = "$OVERLAY" ]; then OV_GIT=1; fi
cd "$REPO" || fail cd
git -C "$REPO" pull --ff-only >>"$LOG" 2>&1 || fail pull
if [ $OV_GIT -eq 1 ]; then git -C "$OVERLAY" pull --ff-only >>"$LOG" 2>&1 || fail pull
else log "overlay is not a git repo; skipping its git steps"; fi

MACHINE_SETUP_PRIVATE="$OVERLAY" "$ROOT/export.sh" >>"$LOG" 2>&1 || fail export

COMMIT_FAIL=0; PUSH_OV=0
# commit_repo DIR NAME : commit pending changes; sets the matching PUSH_* flag
commit_repo() {
  local dir="$1" name="$2" n
  if [ -z "$(git -C "$dir" status --porcelain)" ]; then log "no changes ($name)"; return 0; fi
  if [ "$name" = public ]; then
    case "$(git -C "$dir" config user.email 2>/dev/null)" in
      *@users.noreply.github.com) ;;
      *) log "public repo author email is not a noreply address"; COMMIT_FAIL=1; return 0;;
    esac
  fi
  git -C "$dir" add -A >>"$LOG" 2>&1 || { COMMIT_FAIL=1; log "add failed ($name)"; return 0; }
  n="$(git -C "$dir" diff --cached --name-only | wc -l | tr -d ' ')"
  git -C "$dir" commit -q -m "autosync: $(date +%Y-%m-%d) ($n files)" >>"$LOG" 2>&1 || { COMMIT_FAIL=1; log "commit failed ($name)"; return 0; }
  log "committed $n files ($name)"
  if [ "$name" != public ]; then PUSH_OV=1; fi
}
commit_repo "$REPO" public
if [ $OV_GIT -eq 1 ]; then commit_repo "$OVERLAY" overlay; fi

PUSH_FAIL=0
# Public push gate (AC 87-90): the public repo is never pushed here; the user reviews and runs setup/publish.sh --push.
K="$(git -C "$REPO" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
if [ "${K:-0}" -gt 0 ]; then
  log "public push held for review ($K unpushed)"
  osascript -e "display notification \"machine-setup: $K public commit(s) awaiting review\" with title \"machine-setup\"" >/dev/null 2>&1 || true
fi
if [ $PUSH_OV -eq 1 ]; then if git -C "$OVERLAY" push >>"$LOG" 2>&1; then log "pushed (overlay)"; else log "push failed (overlay)"; PUSH_FAIL=1; fi; fi
[ $COMMIT_FAIL -eq 1 ] && fail commit
[ $PUSH_FAIL -eq 1 ] && fail push
exit 0
