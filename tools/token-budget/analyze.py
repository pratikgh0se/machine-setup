#!/usr/bin/env python3
"""Token-budget analysis: ledger + manifests + transcripts -> regressions + proposals.

Pure, deterministic, stdlib only. No network, no subprocess, no LLM, no randomness.
Exit: 0 ok; 2 ledger missing/empty; 3 malformed ledger line; 4 manifest missing.
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tblib as T  # noqa: E402

WINDOW_DAYS = 30
MIN_HISTORY_DAYS = 14
POS_EXCLUDE = {"system_tools_deferred", "mcp_tools_deferred", "free_space", "autocompact_buffer"}
KIND_ORDER = ["overhead_up", "new_skill", "new_mcp", "new_plugin", "plugin_version", "cli_version"]
SRC_PRIO = {"project": 0, "user": 1}


class Fail(Exception):
    def __init__(self, code, msg):
        Exception.__init__(self, msg)
        self.code = code
        self.msg = msg


def load_ledger(state):
    path = os.path.join(state, "ledger.jsonl")
    if not os.path.isfile(path):
        raise Fail(2, "ledger missing: %s" % path)
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for n, ln in enumerate(f, 1):
            if not ln.strip():
                continue
            try:
                obj = json.loads(ln)
                if not isinstance(obj, dict):
                    raise ValueError("not an object")
            except Exception:
                raise Fail(3, "malformed ledger line %d" % n)
            rows.append(obj)
    if not rows:
        raise Fail(2, "ledger empty")
    return rows


def load_manifest(state, row):
    rel = row.get("manifest")
    if not rel:
        return None
    p = os.path.join(state, rel)
    try:
        with open(p, "r", encoding="utf-8") as f:
            m = json.load(f)
    except (OSError, ValueError):
        raise Fail(4, "manifest referenced but missing/unreadable: %s" % rel)
    return m if isinstance(m, dict) else {}


# ---------- transcripts ----------
SLASH_RE = re.compile(r"^\s*/([A-Za-z0-9_:.\-]+)")
CMD_RE = re.compile(r"<command-name>\s*/?([A-Za-z0-9_:.\-]+)\s*</command-name>")


def scan_transcripts(ch, now):
    files = sorted(glob.glob(os.path.join(ch, "projects", "*", "*.jsonl")) +
                   glob.glob(os.path.join(ch, "projects", "*", "*", "subagents", "*.jsonl")))
    cutoff = now - timedelta(days=WINDOW_DAYS)
    st = {"skills": set(), "slash": set(), "tools": set(), "agents": set(),
          "scanned": len(files), "malformed": 0, "oldest": None}

    def see(ts):
        if st["oldest"] is None or ts < st["oldest"]:
            st["oldest"] = ts

    for fp in files:
        try:
            mtime = None
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                had_ts = False
                lines = f.readlines()
            for ln in lines:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    obj = json.loads(ln)
                except ValueError:
                    st["malformed"] += 1
                    continue
                if not isinstance(obj, dict):
                    st["malformed"] += 1
                    continue
                ts = None
                raw = obj.get("timestamp")
                if isinstance(raw, str):
                    try:
                        ts = T.parse_iso(raw)
                    except ValueError:
                        ts = None
                elif isinstance(raw, (int, float)):
                    try:
                        from datetime import datetime, timezone
                        v = raw / 1000.0 if raw > 1e11 else raw
                        ts = datetime.fromtimestamp(v, timezone.utc)
                    except (ValueError, OverflowError, OSError):
                        ts = None
                if ts is None:
                    if mtime is None:
                        from datetime import datetime, timezone
                        mtime = datetime.fromtimestamp(os.path.getmtime(fp), timezone.utc)
                    ts = mtime
                else:
                    had_ts = True
                see(ts)
                if ts < cutoff:
                    continue
                extract(obj, st)
        except OSError:
            continue
    return st


def extract(obj, st):
    msg = obj.get("message") if isinstance(obj.get("message"), dict) else obj
    role = msg.get("role") or obj.get("type")
    content = msg.get("content")
    blocks = []
    if isinstance(content, str):
        blocks = [{"type": "text", "text": content}]
    elif isinstance(content, list):
        blocks = [b for b in content if isinstance(b, dict)]
    if obj.get("type") == "tool_use" and "name" in obj:
        blocks.append(obj)
    for b in blocks:
        t = b.get("type")
        if t == "tool_use":
            name = b.get("name")
            inp = b.get("input") if isinstance(b.get("input"), dict) else {}
            if not isinstance(name, str):
                continue
            st["tools"].add(name)
            if name == "Skill" and isinstance(inp.get("skill"), str):
                st["skills"].add(inp["skill"])
            if name in ("Task", "Agent") and isinstance(inp.get("subagent_type"), str):
                st["agents"].add(inp["subagent_type"])
        elif t == "text" and role == "user":
            text = b.get("text")
            if isinstance(text, str):
                m = SLASH_RE.match(text)
                if m:
                    st["slash"].add(m.group(1))
                for m in CMD_RE.finditer(text):
                    st["slash"].add(m.group(1))


def skill_used(name, used, plugin=None):
    if name in used:
        return True
    return plugin is not None and ("%s:%s" % (plugin, name)) in used


# ---------- helpers ----------
def protect_sets(state):
    obj, _ = T.load_json_lenient(os.path.join(state, "protect.json"))
    out = {"skills": set(), "mcp": set()}
    for k in out:
        v = obj.get(k)
        if isinstance(v, list):
            for e in v:
                if isinstance(e, str):
                    out[k].add(e)
                elif isinstance(e, dict) and e.get("protected", True) and isinstance(e.get("name"), str):
                    out[k].add(e["name"])
    return out


def applied_state(state):
    cur = {}
    p = os.path.join(state, "applied.jsonl")
    if os.path.isfile(p):
        with open(p, "r", encoding="utf-8") as f:
            for ln in f:
                try:
                    o = json.loads(ln)
                except ValueError:
                    continue
                if isinstance(o, dict) and o.get("id"):
                    if o.get("action") == "apply":
                        cur[o["id"]] = True
                    elif o.get("action") == "revert":
                        cur[o["id"]] = False
    return {k for k, v in cur.items() if v}


def fmt_k(n):
    return "%+d" % n


def mk(id_, rule, title, evidence, saving, risk, action):
    return {"id": id_, "rule": rule, "title": title, "evidence": evidence,
            "est_saving_tokens": max(0, int(saving)), "risk": risk, "action": action,
            "command": "apply.sh %s" % id_}


def patch_action(ops):
    return {"type": "json_patch", "file": "settings", "ops": ops}


FLAG = {"type": "flag"}


# ---------- regressions ----------
def build_regressions(cur_row, prev_row, cm, pm, delta, cdelta):
    regs = []
    new_items = []
    cs = {(s["name"], s["source"]): s for s in cm.get("skills", [])}
    ps = {(s["name"], s["source"]) for s in pm.get("skills", [])}
    for k in sorted(cs):
        if k not in ps:
            new_items.append(("new_skill", "new skill: %s from %s" % k, cs[k].get("tokens", 0), "skills", k))
    pmcp = {s["name"] for s in pm.get("mcp_servers", [])}
    for s in sorted(cm.get("mcp_servers", []), key=lambda x: x["name"]):
        if s["name"] not in pmcp:
            new_items.append(("new_mcp", "new MCP: %s" % s["name"], s.get("always_loaded_tokens", 0), "mcp", s["name"]))
    pp = {p["name"]: p for p in pm.get("plugins", [])}
    for p in sorted(cm.get("plugins", []), key=lambda x: x["name"]):
        if p["name"] not in pp:
            new_items.append(("new_plugin", "new plugin: %s %s" % (p["name"], p.get("version", "")), 0, "plugin", p["name"]))
        elif pp[p["name"]].get("version") != p.get("version"):
            new_items.append(("plugin_version", "plugin %s %s -> %s" % (p["name"], pp[p["name"]].get("version"), p.get("version")), 0, "plugin", p["name"]))
    cv, pv = cur_row.get("cli_version"), prev_row.get("cli_version")
    cli_change = bool(cv and pv and cv != pv)
    if cli_change:
        new_items.append(("cli_version", "CLI %s -> %s" % (pv, cv), 0, "cli", None))

    pos = sorted(((k, v) for k, v in cdelta.items() if v > 0 and k not in POS_EXCLUDE),
                 key=lambda kv: (-kv[1], kv[0]))
    if delta > 1000:
        cause = "; ".join("%s +%d" % kv for kv in pos) or "total +%d" % delta
        posk = {k for k, _ in pos}
        expl = []
        for kind, text, _, cat, _ in new_items:
            if kind == "new_skill" and "skills" in posk:
                expl.append(text)
            elif kind == "new_mcp" and posk & {"mcp_tools", "mcp_server_instructions"}:
                expl.append(text)
            elif kind == "new_plugin" and posk & {"skills", "custom_agents", "mcp_tools", "mcp_server_instructions"}:
                expl.append(text)
            elif kind == "cli_version" and (cdelta.get("system_prompt") or cdelta.get("system_tools")):
                expl.append(text)
        if expl:
            cause += " (%s)" % "; ".join(expl)
        regs.append({"id": "reg-overhead-up", "kind": "overhead_up", "delta_tokens": delta,
                     "cause": cause, "evidence": [k for k, _ in pos]})
    for kind, text, tok, cat, subj in new_items:
        ev = {"new_skill": ["skills"], "new_mcp": ["mcp_servers"], "new_plugin": ["plugins"],
              "plugin_version": ["plugins"], "cli_version": ["cli_version"]}[kind]
        regs.append({"id": "reg-%s-%s" % (kind.replace("_", "-"), T.slug(text)), "kind": kind,
                     "delta_tokens": tok, "cause": text, "evidence": ev})
    regs.sort(key=lambda r: (KIND_ORDER.index(r["kind"]), r["cause"]))
    return regs


# ---------- proposals ----------
def build_proposals(cm, pm, settings, tr, history_ok, protect, applied, baseline, state, mcp_grew=False, spend_bd=None):
    props = {}

    def add(p):
        props.setdefault(p["id"], p)

    skills = cm.get("skills", [])
    overrides = dict(cm.get("skill_overrides") or {})
    if isinstance(settings.get("skillOverrides"), dict):
        overrides.update(settings["skillOverrides"])
    n_tr = tr["scanned"]

    # R1: long skill description listing (flag only; unused skills are kept)
    for s in skills:
        if s["source"] not in ("user", "project") or s["name"] in protect["skills"]:
            continue
        tok = s.get("tokens", 0)
        if tok > 150:
            n = s["name"]
            path = s.get("path") or "~/.claude/skills/%s" % n
            p = mk("skill-desc-long-%s" % T.slug(n), "R1", "Shorten the SKILL.md description of '%s'" % n,
                   "listing costs %d tokens (threshold 150)" % tok, tok - 60, "low",
                   {"type": "flag", "advice": "shorten the SKILL.md description"})
            p["command"] = "edit %s/SKILL.md (advisory; apply.sh exits 6)" % path
            add(p)

    # R2
    groups = {}
    for s in skills:
        groups.setdefault(s["name"], []).append(s)
    for name in sorted(groups):
        copies = groups[name]
        srcs = sorted({c["source"] for c in copies})
        if len(srcs) < 2 or name in protect["skills"]:
            continue
        plugin_copies = [c for c in copies if c["source"].startswith("plugin:")]
        local_copies = [c for c in copies if c["source"] in ("user", "project")]
        if plugin_copies:
            remove = local_copies
        else:
            keep = min(local_copies, key=lambda c: SRC_PRIO.get(c["source"], 9)) if local_copies else None
            remove = [c for c in local_copies if keep is not None and c["source"] != keep["source"]]
        for c in sorted(remove, key=lambda c: c["source"]):
            kept = ", ".join(sorted(x["source"] for x in copies if x is not c and x not in remove)) or "other copy"
            pid = "skill-dup-%s-%s" % (T.slug(name), T.slug(c["source"]))
            if c.get("path"):
                add(mk(pid, "R2", "Remove duplicate skill '%s' from %s (kept: %s)" % (name, c["source"], kept),
                       "same skill name under %d sources: %s" % (len(srcs), ", ".join(srcs)),
                       c.get("tokens", 0), "high",
                       {"type": "shell", "argv": ["rm", "-r", c["path"]]}))
            else:
                add(mk(pid, "R2", "Duplicate skill '%s' in %s (remove manually)" % (name, c["source"]),
                       "same skill name under %d sources: %s" % (len(srcs), ", ".join(srcs)),
                       0, "low", FLAG))
        if not local_copies and len(plugin_copies) >= 2:
            ordered = sorted(plugin_copies, key=lambda c: c["source"])
            for c in ordered[1:]:
                add(mk("skill-dup-%s-%s" % (T.slug(name), T.slug(c["source"])), "R2",
                       "Duplicate skill '%s' in %s (disable via /plugin)" % (name, c["source"]),
                       "same skill name under %d plugin sources: %s" % (len(srcs), ", ".join(srcs)),
                       0, "low", FLAG))

    # R3
    env = cm.get("env") or {}
    if env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") in (None, ""):
        add(mk("compact-window", "R3", "Set CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000",
               "unset in process env and settings; behavioural change (pins the auto-compact window), no direct token saving",
               0, "low", patch_action([{"op": "add", "path": "/env/CLAUDE_CODE_AUTO_COMPACT_WINDOW", "value": "400000"}])))

    # R4: both manifests carry `tools` for the server, tool name new, mcp_tools category grew
    if not baseline and mcp_grew:
        prev_srv = {s["name"]: s for s in pm.get("mcp_servers", [])}
        for s in cm.get("mcp_servers", []):
            p = prev_srv.get(s["name"])
            if p is None or not isinstance(s.get("tools"), list) or not isinstance(p.get("tools"), list):
                continue
            ptools = {t if isinstance(t, str) else t.get("name") for t in p["tools"]}
            for t in s["tools"]:
                tn = t if isinstance(t, str) else t.get("name")
                if tn is None or tn in ptools:
                    continue
                short = re.sub(r"^mcp__.*?__", "", tn) if tn.startswith("mcp__") else tn
                tok = t.get("tokens", 0) if isinstance(t, dict) else 0
                add(mk("mcp-new-%s-%s" % (T.slug(s["name"]), T.slug(short)), "R4",
                       "New always-loaded MCP tool '%s' on '%s'" % (short, s["name"]),
                       "tool absent from previous manifest and mcp_tools category grew", tok, "low", FLAG))

    # R5
    if not baseline:
        for key in ("user", "vault"):
            c = (cm.get("claude_md") or {}).get(key)
            p = (pm.get("claude_md") or {}).get(key)
            if c and p and p.get("bytes", 0) > 0 and c["bytes"] * 5 > p["bytes"] * 6:
                pct = (c["bytes"] - p["bytes"]) * 100.0 / p["bytes"]
                add(mk("claudemd-grew-%s" % key, "R5", "CLAUDE.md (%s) grew %.0f%%" % (key, pct),
                       "%d -> %d bytes since previous manifest" % (p["bytes"], c["bytes"]),
                       c.get("est_tokens", 0) - p.get("est_tokens", 0), "low", FLAG))

    # R6
    denied = {T.norm_key(d) for d in cm.get("denied_mcp_servers", [])}
    if history_ok:
        for s in cm.get("mcp_servers", []):
            if s.get("kind") != "connector" or T.norm_key(s["name"]) in denied or s["name"] in protect["mcp"]:
                continue
            pref = "mcp__%s__" % T.mcp_norm(s["name"])
            if any(t.lower().startswith(pref) for t in tr["tools"]):
                continue
            add(mk("mcp-deny-%s" % T.slug(s["name"]), "R6", "Deny unused connector '%s'" % s["name"],
                   "0 tool calls in %d days (%d transcripts)" % (WINDOW_DAYS, n_tr),
                   s.get("always_loaded_tokens", 0), "low",
                   patch_action([{"op": "add", "path": "/deniedMcpServers/-", "value": {"serverName": s["name"]}}])))

    # R7: only skills/agents-only plugins can be "unused"
    if history_ok:
        for p in cm.get("plugins", []):
            pn = p["name"]
            pl = pn.lower()
            surf = p.get("surfaces")
            if not isinstance(surf, list) or not surf or not set(surf) <= {"skills", "agents"}:
                continue
            used = tr["skills"] | tr["slash"]
            if any(u.startswith(pn + ":") or u.startswith(pl + ":") for u in tr["agents"]):
                continue
            pskills = [s for s in skills if s["source"] == "plugin:" + pn]
            if any(skill_used(s["name"], used, pn) for s in pskills):
                continue
            add(mk("plugin-unused-%s" % T.slug(pn), "R7", "Disable unused plugin '%s' via /plugin" % pn,
                   "no skill or agent invocations in %d days (%d transcripts)" % (WINDOW_DAYS, n_tr),
                   sum(s.get("tokens", 0) for s in pskills), "low", FLAG))

    # R8 / R9 (current ledger spend_breakdown)
    sb = spend_bd or {}
    total = sb.get("total_est_usd") or 0
    if total > 0:
        fs = sb.get("frontier_share")
        sub = (sb.get("cost_share") or {}).get("subagent")
        if isinstance(fs, (int, float)) and isinstance(sub, (int, float)) and fs > 0.70 and sub < 0.30:
            add(mk("spend-frontier-main", "R8", "Delegate more work to cheaper subagents",
                   "frontier_share %.4f (>0.70) with subagent cost share %.4f (<0.30) over %s days, total est. $%.2f"
                   % (fs, sub, sb.get("window_days", 7), total), 0, "low",
                   {"type": "flag", "advice": "delegate more work to cheaper subagents"}))
        cr = sb.get("cache_hit_ratio")
        if isinstance(cr, (int, float)) and cr < 0.80:
            add(mk("spend-cache-low", "R9", "Investigate cache-busting",
                   "cache_hit_ratio %.4f (<0.80) over %s days, total est. $%.2f" % (cr, sb.get("window_days", 7), total),
                   0, "low",
                   {"type": "flag", "advice": "investigate cache-busting (prompt prefix changes, long idle gaps)"}))

    # R10 / R11 (risky_sessions)
    for rs in sb.get("risky_sessions") or []:
        if not isinstance(rs, dict):
            continue
        sid = str(rs.get("session", ""))[:8]
        usd = rs.get("est_usd") or 0
        wa = rs.get("worst_agent") or {}
        if (rs.get("nested_spawns") or 0) > 0:
            add(mk("session-nested-%s" % T.slug(sid), "R10", "Constrain delegation depth in session %s" % sid,
                   "nested_spawns %d, subagent_count %d, session est. $%.2f"
                   % (rs["nested_spawns"], rs.get("subagent_count", 0), usd), 0, "low",
                   {"type": "flag", "advice": "subagents spawning subagents; constrain delegation depth"}))
        if (rs.get("max_subagent_steps") or 0) > 100 or (rs.get("max_subagent_context") or 0) > 300000:
            add(mk("session-runaway-%s" % T.slug(sid), "R11", "Cap steps and context of runaway subagent in session %s" % sid,
                   "worst_agent steps %d, max_context %d, est. $%.2f; session est. $%.2f"
                   % (wa.get("steps", 0), wa.get("max_context", 0), wa.get("est_usd", 0), usd), 0, "low",
                   {"type": "flag", "advice": "runaway subagent; cap steps and context"}))

    out = []
    for p in props.values():
        if p["id"] in applied:
            continue
        a = p["action"]
        if a["type"] == "json_patch":
            _, changed, err = T.patch_apply(settings, a["ops"])
            if err is None and not changed:
                continue
        out.append(p)
    out.sort(key=lambda p: (-p["est_saving_tokens"], p["id"]))
    return out


def run(args):
    now = T.now_utc(args.now)
    state = args.state_dir
    ch = args.claude_home or T.claude_home()
    sfile = args.settings or T.settings_file()
    rows = load_ledger(state)
    cur = rows[-1]
    week = cur.get("week") or T.week_id(now)
    prev = None
    for r in reversed(rows[:-1]):
        if str(r.get("week", "")) < str(week):
            prev = r
            break
    cm = load_manifest(state, cur) or {}
    pm = (load_manifest(state, prev) if prev else None) or {}
    baseline = prev is None
    settings, _ = T.load_json_lenient(sfile)

    tr = scan_transcripts(ch, now)
    oldest = tr["oldest"]
    insufficient = oldest is None or (now - oldest) < timedelta(days=MIN_HISTORY_DAYS)

    ccat = {k: v for k, v in (cur.get("categories") or {}).items() if isinstance(v, (int, float))}
    if baseline:
        delta, cdelta, regs = None, {}, []
    else:
        pcat = {k: v for k, v in (prev.get("categories") or {}).items() if isinstance(v, (int, float))}
        delta = cur["total_always_loaded"] - prev["total_always_loaded"]
        cdelta = {k: ccat.get(k, 0) - pcat.get(k, 0) for k in sorted(set(ccat) | set(pcat))}
        regs = build_regressions(cur, prev, cm, pm, delta, cdelta)

    mcp_grew = (not baseline) and cdelta.get("mcp_tools", 0) > 0
    props = build_proposals(cm, pm, settings, tr, not insufficient, protect_sets(state),
                            applied_state(state), baseline, state, mcp_grew,
                            cur.get("spend_breakdown"))
    res = {
        "schema": 1,
        "week": week,
        "generated_at": T.fmt_ts(now),
        "baseline": baseline,
        "current": {"ts": cur.get("ts"), "total_always_loaded": cur.get("total_always_loaded")},
        "previous": None if baseline else {"ts": prev.get("ts"), "total_always_loaded": prev.get("total_always_loaded")},
        "delta_tokens": delta,
        "category_deltas": cdelta,
        "spend": cur.get("spend") or {"daily_usd": None, "weekly_usd": None},
        "regressions": regs,
        "proposals": props,
        "stats": {"transcripts_scanned": tr["scanned"], "window_days": WINDOW_DAYS,
                  "malformed_lines": tr["malformed"], "insufficient_history": insufficient},
    }
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-dir", required=True)
    ap.add_argument("--now")
    ap.add_argument("--claude-home")
    ap.add_argument("--settings")
    ap.add_argument("--out-json")
    args = ap.parse_args()
    try:
        res = run(args)
        text = T.scrub_tokens(T.jdump(res))
        pdir = os.path.join(args.state_dir, "proposals")
        os.makedirs(pdir, mode=0o700, exist_ok=True)
        T.write_atomic(os.path.join(pdir, "%s.json" % res["week"]), text)
        if args.out_json:
            T.write_atomic(args.out_json, text)
        sys.stdout.write(text)
        return 0
    except Fail as e:
        sys.stderr.write("analyze: %s\n" % e.msg)
        return e.code
    except Exception as e:  # noqa
        sys.stderr.write("analyze: unexpected error: %r\n" % (e,))
        return 1


if __name__ == "__main__":
    sys.exit(main())
