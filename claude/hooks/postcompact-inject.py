#!/usr/bin/env python3
"""SessionStart(compact) hook: re-inject the pre-compaction handoff. Silent on any problem."""
import json, os, sys

HANDOFFS_DIR = os.path.join(os.path.expanduser("~"), ".local", "state", "claude-handoffs")

try:
    d = json.load(sys.stdin)
    sid = str(d.get("session_id") or "").replace("/", "_")  # same rule as precompact-handoff.py
    if sid:
        p = os.path.join(HANDOFFS_DIR, f"{sid}-latest.md")
        root = os.path.realpath(HANDOFFS_DIR)
        if os.path.realpath(p).startswith(root + os.sep) and os.path.isfile(p):
            txt = open(p, encoding="utf-8", errors="replace").read().strip()
            if txt:
                print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                      "additionalContext": "Pre-compaction handoff (auto-saved):\n" + txt}}))
except BaseException:
    pass
sys.exit(0)
