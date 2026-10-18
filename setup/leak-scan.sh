#!/usr/bin/env bash
# leak-scan.sh: block personal values (home paths, emails, UUIDs, denylist terms) and secrets from the public repo.
#   leak-scan.sh [--root DIR] [--denylist FILE|--no-denylist] [--require-denylist] [--staged|--range REVRANGE]
# Output is `<file>:<line>: [<rule>]` only; matched text and denylist terms are never printed.
# Exit: 0 pass, 1 findings, 2 usage error, 4 --require-denylist and no denylist. Allow entries: .leak-scan-allow (see OVERLAY.md).
set -uo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)"
exec python3 -I "$SELF/lib/leak_scan.py" "$@"
