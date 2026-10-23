#!/usr/bin/env python3
"""Pure checker for one handoff-canary variant (spec F36.E "Checks"). No I/O except in main().

Usage: check.py <A|B> <case_dir> [--cap USD] [--timeout S] [--token T] [--other-token T]
<case_dir> holds health.jsonl, latest.md, optional degraded.json, answer.txt and meta.json
(elapsed|elapsed_s, cost|cost_usd|total_cost_usd, token, other_token). Prints one JSON line
{"variant","result","reason"}; exit 0 pass, 1 fail.
"""
import json, os, sys

EXPECT = {"A": {"agent_file": "fresh", "fallback": "ok", "errors": [], "status": "ok"},
          "B": {"agent_file": "absent", "fallback": "ok", "errors": [], "status": "reduced"}}
AGENT_HEAD = "## Agent handoff"


def agent_section(latest):
    i = latest.find(AGENT_HEAD)
    if i < 0:
        return ""
    ends = [k for k in (latest.find(m, i) for m in ("\n## Facts (auto-extracted)", "\n## Model-written")) if k >= 0]
    return latest[i: min(ends) if ends else len(latest)]  # the agent body has its own `## ` headings


def hook_line(lines):
    """The newest compaction health line written by a canary child (None if absent)."""
    best = None
    for o in lines:
        if isinstance(o, dict) and o.get("canary_child") is True and o.get("trigger") in ("auto", "manual"):
            best = o
    return best


def check_variant(variant, token, other_token, health_lines, latest, degraded_exists, answer,
                  elapsed_s, cost_usd, cap_usd=0.25, timeout_s=720):
    """Return (ok, reason). reason is None on pass, else the FIRST failing check c1..c8."""
    line = hook_line(health_lines)
    if line is None:
        return False, "c1"
    exp = EXPECT[variant]
    if any(line.get(k) != v for k, v in exp.items()):
        return False, "c2"
    latest = latest or ""
    if not token or token not in (agent_section(latest) if variant == "A" else latest):
        return False, "c3"
    if degraded_exists or line.get("status") != exp["status"]:
        return False, "c4"
    answer = answer or ""
    if token not in answer or (other_token and other_token in answer):
        return False, "c5"
    if variant == "B" and ("Fresh summary failed:" in latest or "Haiku fallback failed:" in latest):
        return False, "c6"
    if elapsed_s is None or elapsed_s > timeout_s:
        return False, "c7"
    if cost_usd is None or cost_usd > cap_usd:
        return False, "c8"
    return True, None


def _read(p):
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return None


def load_lines(path):
    out = []
    for ln in (_read(path) or "").splitlines():
        try:
            out.append(json.loads(ln))
        except Exception:
            pass
    return out


def main(argv):
    if len(argv) < 2 or argv[0] not in ("A", "B"):
        print("usage: check.py <A|B> <case_dir> [--cap USD] [--timeout S] [--token T] [--other-token T]", file=sys.stderr)
        return 2
    variant, d = argv[0], argv[1]
    opts = dict(zip(argv[2::2], argv[3::2]))
    meta = {}
    try:
        meta = json.loads(_read(os.path.join(d, "meta.json")) or "{}")
    except Exception:
        pass
    first = lambda *ks: next((meta[k] for k in ks if isinstance(meta.get(k), (int, float, str))), None)
    token = opts.get("--token") or first("token")
    other = opts.get("--other-token") or first("other_token")
    num = lambda v: float(v) if isinstance(v, (int, float, str)) and str(v).replace(".", "", 1).isdigit() else None
    ok, reason = check_variant(
        variant, token, other, load_lines(os.path.join(d, "health.jsonl")), _read(os.path.join(d, "latest.md")),
        os.path.exists(os.path.join(d, "degraded.json")), _read(os.path.join(d, "answer.txt")),
        num(first("elapsed_s", "elapsed")), num(first("cost_usd", "cost", "total_cost_usd")),
        float(opts.get("--cap", os.environ.get("HANDOFF_CANARY_MAX_USD", "0.25"))), float(opts.get("--timeout", 720)))
    print(json.dumps({"variant": variant, "result": "pass" if ok else "fail", "reason": reason}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
