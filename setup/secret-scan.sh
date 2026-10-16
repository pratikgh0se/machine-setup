#!/usr/bin/env bash
# Scan the tree that would be committed (tracked + untracked, not ignored). Exit 1 on any finding.
# Uses gitleaks if installed, and ALWAYS the strict regex scan too.
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)"   # setup/
ROOT="$(cd "${1:-$SELF/..}" && pwd)"      # tree to scan (default: repo root)
cd "$ROOT"
rc=0
if git rev-parse --git-dir >/dev/null 2>&1; then
  FILES="$(git ls-files -co --exclude-standard)"
else
  FILES="$(find . -type f -not -path './.git/*' | sed 's|^\./||')"
fi
echo "secret-scan: $(printf '%s\n' "$FILES" | grep -c .) files"
if command -v gitleaks >/dev/null 2>&1; then
  echo "secret-scan: gitleaks $(gitleaks version 2>/dev/null)"
  if gitleaks dir --help >/dev/null 2>&1; then gitleaks dir . --no-banner --redact -v || rc=1
  else gitleaks detect --no-git --source . --no-banner --redact -v || rc=1; fi
else
  echo "secret-scan: gitleaks not installed (brew install gitleaks); using regex scan only"
fi
printf '%s\n' "$FILES" | python3 "$SELF/lib/regex_scan.py" "$ROOT" || rc=1
[ $rc -eq 0 ] && echo "secret-scan: PASS" || echo "secret-scan: FAIL"
exit $rc
