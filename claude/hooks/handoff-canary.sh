#!/bin/bash
# Thin wrapper: the canary lives in tools/handoff-canary/ of the machine-setup repo (spec F36.E).
# In the repo it resolves relative to itself; an installed copy needs MACHINE_SETUP_REPO.
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="${MACHINE_SETUP_REPO:-$D/../..}"
[ -x "$R/tools/handoff-canary/run.sh" ] || { echo "handoff-canary: set MACHINE_SETUP_REPO to the machine-setup checkout" >&2; exit 2; }
exec "$R/tools/handoff-canary/run.sh" "$@"
