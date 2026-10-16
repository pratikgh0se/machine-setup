#!/usr/bin/env python3
"""Merge a private overlay settings.json over the public template (spec 11.4).
Usage: merge_settings.py TEMPLATE OVERLAY OUT   (either input may be absent; both absent: OUT is not written).
Objects merge recursively; scalars: overlay wins; overlay null deletes the key; arrays at permissions.allow|deny|ask
are unioned (template first); every other array is replaced by the overlay's."""
import json, os, sys

UNION = {("permissions", "allow"), ("permissions", "deny"), ("permissions", "ask")}

def merge(t, o, path=()):
    if isinstance(t, dict) and isinstance(o, dict):
        out = {}
        for k, v in t.items():
            if k in o:
                if o[k] is None:
                    continue
                out[k] = merge(v, o[k], path + (k,))
            else:
                out[k] = v
        for k, v in o.items():
            if k not in t and v is not None:
                out[k] = v
        return out
    if isinstance(t, list) and isinstance(o, list) and path in UNION:
        out = []
        for x in list(t) + list(o):
            if x not in out:
                out.append(x)
        return out
    return o

def load(p):
    if p and os.path.isfile(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return None

def main():
    t, o, out = load(sys.argv[1]), load(sys.argv[2]), sys.argv[3]
    if t is None and o is None:
        return 0
    res = t if o is None else (o if t is None else merge(t, o))
    with open(out, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2, ensure_ascii=False); f.write("\n")
    return 0

if __name__ == "__main__":
    sys.exit(main())
