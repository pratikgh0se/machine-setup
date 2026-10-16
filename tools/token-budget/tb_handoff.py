"""Handoff health summary from health.jsonl (docs/token-budget-spec.md "Handoff health" H.1). Stdlib only.

Read-only. Only counts, dates and reason codes leave this module: no message text, paths, ids or
exception messages, whatever the input lines contain.
"""
import json
import os
from datetime import timedelta

import tblib as T

WINDOW_DAYS = 7
SECTIONS = {"warning", "agent", "fallback", "user_messages", "decisions", "files", "tasks", "open_tasks",
            "background_agents", "git", "bash", "assistant", "toplevel"}
AGENT = ("fresh", "stale", "absent")
FALLBACK = ("skipped", "ok", "failed", "timeout", "disabled")


def default_path():
    return os.environ.get("HANDOFF_HEALTH_FILE") or os.path.join(T.home(), ".local", "state", "claude-handoffs", "health.jsonl")


def explicit_path(arg=None):
    """The path when the caller named one (flag or HANDOFF_HEALTH_FILE), else None."""
    return arg or os.environ.get("HANDOFF_HEALTH_FILE") or None


def classify(o):
    """(status, codes) recomputed from the fields; a stored `status` is never trusted."""
    af = o.get("agent_file")
    fb = o.get("fallback")
    errs = [e for e in (o.get("errors") if isinstance(o.get("errors"), list) else []) if isinstance(e, str) and e in SECTIONS]
    nerr = len(o["errors"]) if isinstance(o.get("errors"), list) else 0
    ss = o.get("stale_sections")
    ss = isinstance(ss, list) and len(ss) > 0
    if nerr or ss or (af != "fresh" and fb in ("failed", "timeout", "disabled")):
        codes = []
        if af == "absent":
            codes.append("agent_absent")
        if af == "stale" or ss:
            codes.append("agent_stale")
        if fb == "failed":
            codes.append("fallback_failed")
        if fb == "timeout":
            codes.append("fallback_timeout")
        codes += ["section_error:" + e for e in errs]
        return "degraded", codes
    if af != "fresh" and fb == "ok":
        return "reduced", []
    return "ok", []


def _ts(o):
    v = o.get("ts")
    if not isinstance(v, str):
        return None
    try:
        return T.parse_iso(v)
    except Exception:
        return None


def compute(path, now):
    """Return (summary_dict | None, warning | None). None + 'handoff-health' when the file is unreadable."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read().splitlines()
    except (OSError, ValueError):
        return None, "handoff-health"
    start = now - timedelta(days=WINDOW_DAYS)
    comp, canary_all, ignored = [], [], 0
    for ln in raw:
        if not ln.strip():
            continue
        try:
            o = json.loads(ln)
        except ValueError:
            ignored += 1
            continue
        t = _ts(o) if isinstance(o, dict) else None
        if t is None or o.get("canary_child") is True:
            ignored += 1
            continue
        if o.get("trigger") == "canary":
            if o.get("result") in ("pass", "fail", "skip"):
                canary_all.append((t, o["result"]))
        elif "agent_file" in o:
            comp.append((t, o))
    win = [o for t, o in comp if t >= start]
    n = len(win)
    out = {"window_days": WINDOW_DAYS, "compactions": n, "auto": 0, "manual": 0, "ok": 0, "reduced": 0, "degraded": 0,
           "degraded_rate": None, "agent_file": {k: 0 for k in AGENT}, "fallback": {k: 0 for k in FALLBACK},
           "errors_total": 0, "truncated": 0}
    reasons = {}
    for o in win:
        if o.get("trigger") in ("auto", "manual"):
            out[o["trigger"]] += 1
        st, codes = classify(o)
        out[st] += 1
        if o.get("agent_file") in AGENT:
            out["agent_file"][o["agent_file"]] += 1
        if o.get("fallback") in FALLBACK:
            out["fallback"][o["fallback"]] += 1
        if isinstance(o.get("errors"), list):
            out["errors_total"] += len(o["errors"])
        if o.get("truncated") is True:
            out["truncated"] += 1
        for c in codes:
            reasons[c] = reasons.get(c, 0) + 1
    if n:
        out["degraded_rate"] = round(out["degraded"] / n, 4)
    top = sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    out["top_reasons"] = [{"reason": k, "count": v} for k, v in top]
    cw = [(t, r) for t, r in canary_all if t >= start]
    nights = {}
    for t, r in sorted(cw, key=lambda x: x[0]):
        nights[T.local_date(t)] = r
    keep = sorted(nights)[-WINDOW_DAYS:]
    last = max((t for t, _ in canary_all), default=None)
    out["canary"] = {"pass": sum(1 for _, r in cw if r == "pass"), "fail": sum(1 for _, r in cw if r == "fail"),
                     "skip": sum(1 for _, r in cw if r == "skip"),
                     "nights": [{"date": d, "result": nights[d]} for d in keep],
                     "last_ts": T.fmt_ts(last) if last else None}
    out["ignored"] = ignored
    return out, None


def r12(hh, now):
    """Triggers of rule R12 (list, possibly empty) for a handoff_health dict."""
    if not isinstance(hh, dict):
        return []
    trig = []
    n, d = hh.get("compactions") or 0, hh.get("degraded") or 0
    if n > 0 and d * 10 > n:
        trig.append("rate")
    can = hh.get("canary") or {}
    if (can.get("fail") or 0) >= 1:
        trig.append("canary_fail")
    last = can.get("last_ts")
    if last:
        try:
            if now - T.parse_iso(last) > timedelta(days=3):
                trig.append("canary_stale")
        except Exception:
            pass
    return trig
