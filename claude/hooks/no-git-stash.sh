#!/bin/bash
# Policy hook: no agent may run `git stash` (any subcommand except `list`).
# PreToolUse hook for the Bash tool: reads the tool call JSON on stdin, exits 2 to block.
input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))
except Exception: print("")')
if printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9_-])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+stash([[:space:]]|$)' && ! printf '%s' "$cmd" | grep -Eq 'git([[:space:]]+-[^[:space:]]+)*[[:space:]]+stash[[:space:]]+list'; then
  echo "Blocked by the no-stash rule: stashing is forbidden for agents; make a WIP commit instead." >&2
  exit 2
fi
exit 0
