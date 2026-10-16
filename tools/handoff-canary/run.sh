#!/bin/bash
# Handoff canary entry point. Usage: run.sh [--catch-up] [--probe]
# Exit: 0 pass/skip/no-op, 1 fail, 2 usage or lock held, 3 isolation violated.
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/canary.py" "$@"
