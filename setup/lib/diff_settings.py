#!/usr/bin/env python3
"""Inverse of merge_settings.py: write the overlay settings.json that, merged over TEMPLATE, yields LIVE.
Usage: diff_settings.py TEMPLATE LIVE OUT   (TEMPLATE may be absent: OUT is then LIVE in full).
Prints '  warning: template permission entry not expressible in overlay' once if a union entry of the template is
absent from LIVE (an overlay cannot remove template permission entries)."""
import json, os, sys

UNION = {("permissions", "allow"), ("permissions", "deny"), ("permissions", "ask")}
NOTHING = object()
warned = []

def diff(t, l, path=()):
    if isinstance(t, dict) and isinstance(l, dict):
        out = {}
        for k, v in l.items():
            if k not in t:
                out[k] = v
            else:
                d = diff(t[k], v, path + (k,))
                if d is not NOTHING:
                    out[k] = d
        for k in t:
            if k not in l:
                out[k] = None
        return out if out else NOTHING
    if isinstance(t, list) and isinstance(l, list) and path in UNION:
        if any(x not in l for x in t):
            warned.append(1)
        new = [x for x in l if x not in t]
        return new if new else NOTHING
    return NOTHING if t == l else l

def main():
    tp, lp, out = sys.argv[1:4]
    t = json.load(open(tp, encoding="utf-8")) if os.path.isfile(tp) else {}
    l = json.load(open(lp, encoding="utf-8"))
    d = diff(t, l)
    if d is NOTHING:
        d = {}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2, ensure_ascii=False); f.write("\n")
    if warned:
        print("  warning: template permission entry not expressible in overlay")

if __name__ == "__main__":
    main()
