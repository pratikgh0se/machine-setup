#!/usr/bin/env python3
"""Merge two plugins.json files: marketplaces by name, plugins by id; overlay entry wins; sorted like plugins.py.
Usage: merge_plugins.py PUBLIC OVERLAY OUT   (either may be absent; neither: OUT not written)."""
import json, os, sys

def load(p):
    if p and os.path.isfile(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return None

def main():
    docs = [load(sys.argv[1]), load(sys.argv[2])]
    if all(d is None for d in docs):
        return 0
    mk, pl = {}, {}
    for d in docs:
        for m in (d or {}).get("marketplaces", []):
            mk[m["name"]] = m
        for p in (d or {}).get("plugins", []):
            pl[p["id"]] = p
    res = {"marketplaces": [mk[k] for k in sorted(mk)], "plugins": [pl[k] for k in sorted(pl)]}
    with open(sys.argv[3], "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2); f.write("\n")
    return 0

if __name__ == "__main__":
    sys.exit(main())
