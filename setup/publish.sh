#!/usr/bin/env bash
# publish.sh: review and publish the public repo's unpushed commits (autosync only commits them locally; spec "Public push gate").
#   publish.sh           show `git log --oneline` and `git diff --stat` of @{u}..HEAD; pushes nothing
#   publish.sh --push    leak-scan the added lines of @{u}..HEAD, then `git push`; exit 1 on scan or push failure
# Operates on the public repo containing this script; never touches the overlay. Exit: 0 ok, 1 failure, 2 usage.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"   # setup/
REPO="$(cd "$ROOT/.." && pwd)"           # public repo
PUSH=0
case "${1:-}" in
  "") ;;
  --push) [ $# -eq 1 ] && PUSH=1 || { echo "usage: publish.sh [--push]" >&2; exit 2; };;
  *) echo "usage: publish.sh [--push]" >&2; exit 2;;
esac
K="$(git -C "$REPO" rev-list --count '@{u}..HEAD' 2>/dev/null)" || { echo "publish: no upstream configured" >&2; exit 1; }
if [ "$K" -eq 0 ]; then echo "nothing to publish"; exit 0; fi
if [ $PUSH -eq 0 ]; then
  git -C "$REPO" log --oneline '@{u}..HEAD'
  git -C "$REPO" diff --stat '@{u}..HEAD'
  echo "run setup/publish.sh --push to publish"
  exit 0
fi
if ! "$ROOT/leak-scan.sh" --root "$REPO" --range '@{u}..HEAD'; then
  echo "publish: leak scan failed; nothing pushed" >&2
  exit 1
fi
git -C "$REPO" push || { echo "publish: push failed" >&2; exit 1; }
echo "published $K commit(s)"
