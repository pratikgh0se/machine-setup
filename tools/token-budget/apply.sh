#!/bin/bash
# Apply ONE proposal by hand (never run by launchd/run.sh/analyze.py). See spec 4.4.
#   apply.sh <id> [--yes] [--json]     apply
#   apply.sh --revert <id> [--force]   revert
#   apply.sh --list                    list proposals
# Exit: 0 ok; 1 error; 2 usage; 3 not found; 4 patch; 5 revert refused; 6 advisory; 7 need --yes; 8 settings bad.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$DIR/tb_apply.py" "$@"
