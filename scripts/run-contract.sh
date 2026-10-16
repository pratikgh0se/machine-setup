#!/usr/bin/env bash
# Usage: scripts/run-contract.sh <plugin>
# Copies plugins/<plugin> to a temp dir, copies the WHOLE code-blind contract folder
# (${BENTO_TESTS_DIR:-$HOME/CodeBase/bento-mods-tests}/<plugin>/, helpers like harness.ts included, CONTRACT-MAP.md excluded)
# into <tmp>/contract/, runs `claude plugin test <tmp>`, prints ONLY pass/fail counts and failing test names.
# Never prints test source. Exit 1 when anything fails.
set -u
P="${1:?usage: run-contract.sh <plugin>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TESTS="${BENTO_TESTS_DIR:-$HOME/CodeBase/bento-mods-tests}/$P"
[ -d "$ROOT/plugins/$P" ] || { echo "no plugin: plugins/$P"; exit 2; }
[ -d "$TESTS" ] || { echo "no contract tests: $TESTS"; exit 2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp -R "$ROOT/plugins/$P/." "$TMP/"
rm -rf "$TMP/tests"   # the plugin's own tests are not the contract
mkdir -p "$TMP/contract"
( cd "$TESTS" && tar --exclude=CONTRACT-MAP.md --exclude=node_modules -cf - . ) | tar -xf - -C "$TMP/contract"
OUT="$TMP.out"
claude plugin test "$TMP" >"$OUT" 2>&1; CODE=$?
# Output format (bun-style): "(pass) name [ms]" / "(fail) name [ms]". Count them; print failing names only.
CLEAN="$(sed $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "$OUT")"
NP=$(printf '%s\n' "$CLEAN" | grep -c '^(pass) ')
NF=$(printf '%s\n' "$CLEAN" | grep -c '^(fail) ')
printf '%s\n' "$CLEAN" | grep '^(fail) ' | sed -E 's/ \[[0-9.]+m?s\]$//' | cut -c1-200
echo "pass=$NP fail=$NF exit=$CODE"
if [ "$CODE" -ne 0 ] && [ "$NP" -eq 0 ] && [ "$NF" -eq 0 ]; then
  echo "runner error: no test lines (load or compile failure; output withheld)"
fi
rm -f "$OUT"
exit $CODE
