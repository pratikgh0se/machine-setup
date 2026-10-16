"""Offline spend breakdown from local transcripts (spec 4.1.4). Stdlib only.

Reads only message.usage, message.model, message.id, requestId, type and timestamp.
No message text is ever read into the output.
"""
import glob
import json
import os
from datetime import timedelta

import tblib as T

FAMILIES = ["fable", "opus", "sonnet", "haiku", "other"]
PKEYS = ("input", "output", "cache_read", "cache_write5m")
BUILTIN = {
    "asOf": "2026-10-11",
    "families": {
        "fable": {"input": 10, "output": 50, "cache_read": 0.25, "cache_write5m": 12.5},
        "opus": {"input": 4, "output": 20, "cache_read": 0.2, "cache_write5m": 5},
        "sonnet": {"input": 2, "output": 10, "cache_read": 0.1, "cache_write5m": 2.5},
        "haiku": {"input": 0.1, "output": 0.5, "cache_read": 0.01, "cache_write5m": 0.125},
        "other": {"input": 4, "output": 20, "cache_read": 0.2, "cache_write5m": 5},
    },
}


def _valid(obj):
    if not isinstance(obj, dict) or not isinstance(obj.get("families"), dict):
        return False
    for fam, row in obj["families"].items():
        if fam not in FAMILIES or not isinstance(row, dict):
            return False
        for k, v in row.items():
            if k in PKEYS and (isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0):
                return False
    return True


def _merge(base, over):
    fams = {f: dict(base["families"][f]) for f in FAMILIES}
    for f, row in over["families"].items():
        for k in PKEYS:
            if k in row:
                fams[f][k] = row[k]
    return {"asOf": over.get("asOf") if isinstance(over.get("asOf"), str) else base["asOf"], "families": fams}


def load_prices():
    """Return (prices, warnings)."""
    warnings = []
    prices = BUILTIN
    default_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prices.json")
    try:
        with open(default_path, "r", encoding="utf-8") as f:
            d = json.load(f)
        if _valid(d):
            prices = _merge(BUILTIN, d)
    except (OSError, ValueError):
        pass
    ov = os.environ.get("TOKEN_BUDGET_PRICES")
    if ov is not None and ov.strip():
        try:
            if ov.lstrip().startswith("{"):
                d = json.loads(ov)
            else:
                with open(ov, "r", encoding="utf-8") as f:
                    d = json.load(f)
            if not _valid(d):
                raise ValueError("bad shape")
            prices = _merge(BUILTIN, d)
        except (OSError, ValueError):
            warnings.append("prices_override_invalid")
            prices = BUILTIN
    return prices, warnings


def family(model):
    m = (model or "").lower()
    for f in ("fable", "opus", "sonnet", "haiku"):
        if f in m:
            return f
    return "other"


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def compute(claude_home, now, prices, ccusage_weekly=None):
    start = now - timedelta(days=7)
    mains = sorted(glob.glob(os.path.join(claude_home, "projects", "*", "*.jsonl")))
    subs = sorted(glob.glob(os.path.join(claude_home, "projects", "*", "*", "subagents", "*.jsonl")))
    files = sorted([(p, False) for p in mains] + [(p, True) for p in subs], key=lambda x: x[0])
    chosen = {}      # dedupe key -> record
    keyless = []
    dropped = 0
    seq = 0
    for path, is_sub in files:
        rel = os.path.relpath(path, os.path.join(claude_home, "projects")).split(os.sep)
        project = rel[0]
        session = rel[1] if is_sub else os.path.splitext(rel[1])[0]
        try:
            fh = open(path, "r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for ln in fh:
                if '"usage"' not in ln:
                    continue
                try:
                    o = json.loads(ln)
                except ValueError:
                    continue
                if not isinstance(o, dict) or o.get("type") != "assistant":
                    continue
                msg = o.get("message")
                if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
                    continue
                if msg.get("model") == "<synthetic>":
                    continue
                raw = o.get("timestamp")
                if not isinstance(raw, str):
                    continue
                try:
                    ts = T.parse_iso(raw)
                except ValueError:
                    continue
                if ts < start or ts > now:
                    continue
                u = msg["usage"]
                rec = {"fam": family(msg.get("model")),
                       "input": _num(u.get("input_tokens")), "output": _num(u.get("output_tokens")),
                       "cache_read": _num(u.get("cache_read_input_tokens")),
                       "cache_creation": _num(u.get("cache_creation_input_tokens")),
                       "sub": is_sub, "project": project, "session": session, "seq": seq,
                       "file": os.path.basename(path), "agents": []}
                if is_sub and isinstance(msg.get("content"), list):
                    for blk in msg["content"]:
                        if (isinstance(blk, dict) and blk.get("type") == "tool_use" and blk.get("name") == "Agent"
                                and isinstance(blk.get("id"), str) and blk["id"]):
                            rec["agents"].append(blk["id"])
                seq += 1
                mid, rid = msg.get("id"), o.get("requestId")
                mid = mid if isinstance(mid, str) and mid else None
                rid = rid if isinstance(rid, str) and rid else None
                if mid is None and rid is None:
                    keyless.append(rec)
                    continue
                k = (mid, rid)
                old = chosen.get(k)
                if old is None:
                    chosen[k] = rec
                else:
                    dropped += 1
                    if rec["output"] > old["output"]:
                        chosen[k] = rec
    recs = list(chosen.values()) + keyless
    recs.sort(key=lambda r: r["seq"])

    P = prices["families"]

    def cost(r):
        p = P[r["fam"]]
        return (r["input"] * p["input"] + r["output"] * p["output"] +
                r["cache_read"] * p["cache_read"] + r["cache_creation"] * p["cache_write5m"]) / 1e6

    fam = {f: {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "usd": 0.0} for f in FAMILIES}
    main_usd = sub_usd = 0.0
    sessions = {}
    for r in recs:
        c = cost(r)
        a = fam[r["fam"]]
        for k in ("input", "output", "cache_read", "cache_creation"):
            a[k] += r[k]
        a["usd"] += c
        if r["sub"]:
            sub_usd += c
        else:
            main_usd += c
        s = sessions.setdefault((r["project"], r["session"]), {"usd": 0.0, "fam": {}, "files": {}, "nested": set()})
        s["usd"] += c
        if r["sub"]:
            fa = s["files"].setdefault(r["file"], {"steps": 0, "max_context": 0, "usd": 0.0})
            fa["steps"] += 1
            fa["usd"] += c
            fa["max_context"] = max(fa["max_context"], r["input"] + r["cache_read"] + r["cache_creation"])
            s["nested"].update(r["agents"])
        s["fam"][r["fam"]] = s["fam"].get(r["fam"], 0.0) + c
    total = sum(a["usd"] for a in fam.values())
    den = sum(a["input"] + a["cache_read"] + a["cache_creation"] for a in fam.values())
    reads = sum(a["cache_read"] for a in fam.values())
    ranked = sorted(sessions.items(), key=lambda kv: (-kv[1]["usd"], kv[0][0], kv[0][1]))
    top = ranked[:5]

    def sub_stats(v):
        files = v["files"]
        st = {"subagent_count": len(files), "nested_spawns": len(v["nested"]),
              "max_subagent_steps": max([x["steps"] for x in files.values()] or [0]),
              "max_subagent_context": max([x["max_context"] for x in files.values()] or [0])}
        worst = None
        if files:
            fn = sorted(files, key=lambda n: (-files[n]["steps"], -files[n]["max_context"], n))[0]
            w = files[fn]
            worst = {"steps": w["steps"], "max_context": w["max_context"], "est_usd": round(w["usd"], 4)}
        return st, worst

    risky = []
    for k, v in ranked:
        st, worst = sub_stats(v)
        reasons = []
        if st["nested_spawns"] > 0:
            reasons.append("nested")
        if st["max_subagent_steps"] > 100:
            reasons.append("steps")
        if st["max_subagent_context"] > 300000:
            reasons.append("context")
        if reasons:
            e = {"project": k[0], "session": k[1][:8], "est_usd": round(v["usd"], 4)}
            e.update(st)
            e["worst_agent"] = worst
            e["reasons"] = sorted(reasons)
            risky.append(e)
        if len(risky) >= 20:
            break
    by_family = {}
    for f in FAMILIES:
        a = fam[f]
        by_family[f] = {"input": a["input"], "output": a["output"], "cache_read": a["cache_read"],
                        "cache_creation": a["cache_creation"], "est_usd": round(a["usd"], 4)}
    out = {
        "window_days": 7,
        "prices_as_of": prices["asOf"],
        "messages_counted": len(recs),
        "duplicates_dropped": dropped,
        "by_family": by_family,
        "total_est_usd": round(total, 4),
        "cache_hit_ratio": round(reads / den, 4) if den > 0 else None,
        "cost_share": {"main": round(main_usd / total, 4) if total > 0 else 0,
                       "subagent": round(sub_usd / total, 4) if total > 0 else 0},
        "frontier_share": round((fam["fable"]["usd"] + fam["opus"]["usd"]) / total, 4) if total > 0 else 0,
        "top_sessions": [{"project": k[0], "session": k[1][:8], "est_usd": round(v["usd"], 4),
                          "dominant_model": max(sorted(v["fam"]), key=lambda f: v["fam"][f]),
                          **sub_stats(v)[0]} for k, v in top],
        "risky_sessions": risky,
        "ccusage_weekly_usd": ccusage_weekly,
    }
    return out, (["no_transcripts"] if not recs else [])
