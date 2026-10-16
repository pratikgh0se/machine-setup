#!/usr/bin/env python3
"""Scrub ~/.claude/settings.json: secret-looking env/header values -> "__SECRET:<NAME>__";
$HOME -> __HOME__. Deterministic output. Usage: scrub_settings.py IN OUT HOME [secrets-list-out]"""
import json, re, sys
src, dst, home = sys.argv[1:4]
secrets_out = sys.argv[4] if len(sys.argv) > 4 else None
NAME_RE = re.compile(r"(key|token|secret|passw|bearer|credential|auth|cookie)", re.I)
VAL_RE = re.compile(r"(sk-[A-Za-z0-9_\-]{10,}|ghp_[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xox[abpors]-[A-Za-z0-9\-]{5,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_\-]{20,}\.|[Bb]earer\s+\S{8,})")
found = []
def scrub(node, ctx=None, path=""):
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            in_secret_ctx = k in ("env", "headers", "environment")
            if ctx and isinstance(v, str) and (NAME_RE.search(k) or VAL_RE.search(v)) and not v.startswith("__SECRET:"):
                nm = re.sub(r"[^A-Za-z0-9_]", "_", (path + "_" + k).strip("_")).upper()
                found.append(nm); out[k] = "__SECRET:%s__" % nm
            elif isinstance(v, str) and VAL_RE.search(v):
                nm = re.sub(r"[^A-Za-z0-9_]", "_", (path + "_" + k).strip("_")).upper()
                found.append(nm); out[k] = "__SECRET:%s__" % nm
            else:
                out[k] = scrub(v, in_secret_ctx, path + "_" + k if path else k)
        return out
    if isinstance(node, list):
        return [scrub(x, ctx, path) for x in node]
    if isinstance(node, str):
        return node.replace(home, "__HOME__")
    return node
d = json.load(open(src))
res = scrub(d)
with open(dst, "w") as f:
    json.dump(res, f, indent=2, ensure_ascii=False); f.write("\n")
if secrets_out is not None:
    with open(secrets_out, "w") as f:
        f.write("".join(n + "\n" for n in sorted(set(found))))
