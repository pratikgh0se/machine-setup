#!/usr/bin/env python3
# Policy hook: no recursive walk rooted at /, /Users, the home folder, or a glob over them,
# because such a walk can pass through protected folders (e.g. ~/Library, ~/Movies). PreToolUse hook for the Bash tool: reads the call JSON on stdin,
# exits 2 to block. Walks over a named subfolder (e.g. ~/Pictures/ScouterScratch) stay allowed.
import json, os, re, shlex, sys

HOME = os.path.expanduser("~")
ROOTS = {"/", "/Users", HOME}
WALKERS = {"du", "find", "tree", "rsync", "ncdu", "fd", "rg", "mdfind"}
RECURSIVE_FLAG = {"ls": "R", "grep": "rR", "cp": "rR", "chmod": "R", "chown": "R"}


def is_root(arg):
    a = arg.replace("${HOME}", HOME).replace("$HOME", HOME)
    if a == "~" or a.startswith("~/"):
        a = HOME + a[1:]
    a = a.rstrip("/") or "/"
    if a.endswith("/*"):
        a = a[:-2] or "/"
    return a in ROOTS


def blocked(cmd):
    for seg in re.split(r"\|\||&&|;|\||\n", cmd):
        try:
            words = shlex.split(seg)
        except ValueError:
            words = seg.split()
        while words and (words[0] in ("sudo", "env", "time", "nice") or "=" in words[0]):
            words = words[1:]
        if not words:
            continue
        prog, args = words[0].rsplit("/", 1)[-1], words[1:]
        flags = "".join(a[1:] for a in args if a.startswith("-") and not a.startswith("--"))
        recursive = prog in WALKERS or any(f in flags for f in RECURSIVE_FLAG.get(prog, ""))
        if recursive and any(is_root(a) for a in args if not a.startswith("-")):
            return True
    return False


try:
    command = json.load(sys.stdin).get("tool_input", {}).get("command", "")
except Exception:
    command = ""
if blocked(command):
    print("Blocked by the forbidden-walk rule: no recursive command "
          "rooted at /, /Users or the home folder. Name the exact subfolder instead.", file=sys.stderr)
    sys.exit(2)
sys.exit(0)
