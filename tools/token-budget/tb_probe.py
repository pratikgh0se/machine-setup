#!/usr/bin/env python3
"""Probe helper: parse captures, build manifest + ledger line. Called by probe.sh.

Subcommands:
  ctx-check FILE            parse /context output; on failure save redacted raw and exit 3
  build --context FILE --turn FILE [--dry-run]
"""
import argparse
import itertools
import json
import math
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tblib as T  # noqa: E402
import tb_spend  # noqa: E402


def read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def save_raw(text, dry):
    if dry:
        return
    try:
        st = T.state_dir()
        logs = os.path.join(st, "logs")
        os.makedirs(logs, mode=0o700, exist_ok=True)
        ts = T.fmt_ts(T.now_utc()).replace(":", "-")
        T.write_atomic(os.path.join(logs, "context-raw.%s.txt" % ts), T.redact(text))
    except Exception:
        pass


def cmd_ctx_check(a):
    text = read(a.file)
    try:
        T.parse_context(text)
    except ValueError as e:
        sys.stderr.write("probe: /context unparseable: %s\n" % e)
        save_raw(text, a.dry_run)
        return 3
    return 0


# ---------- turn ----------
def parse_turn(text):
    try:
        obj = json.loads(text)
    except Exception:
        return None
    if isinstance(obj, list):
        res = [o for o in obj if isinstance(o, dict) and o.get("type") == "result"]
        obj = res[-1] if res else next((o for o in reversed(obj) if isinstance(o, dict) and "usage" in o), None)
    if not isinstance(obj, dict) or not isinstance(obj.get("usage"), dict):
        return None
    u = obj["usage"]

    def gi(k):
        v = u.get(k, 0)
        return int(v) if isinstance(v, (int, float)) else 0
    cost = obj.get("total_cost_usd")
    if cost is None:
        cost = obj.get("cost_usd")
    return {
        "input_tokens": gi("input_tokens"),
        "output_tokens": gi("output_tokens"),
        "cache_creation_input_tokens": gi("cache_creation_input_tokens"),
        "cache_read_input_tokens": gi("cache_read_input_tokens"),
        "total_cost_usd": cost if isinstance(cost, (int, float)) else None,
        "_version": obj.get("claude_code_version") or obj.get("version"),
    }


# ---------- ccusage ----------
def _sum_cost(obj, key):
    rows = None
    if isinstance(obj, dict):
        rows = obj.get(key)
        if rows is None:
            for v in obj.values():
                if isinstance(v, list):
                    rows = v
                    break
        if rows is None:
            t = obj.get("totals")
            if isinstance(t, dict) and "totalCost" in t:
                return float(t["totalCost"])
            if "totalCost" in obj:
                return float(obj["totalCost"])
            raise ValueError("no rows")
    elif isinstance(obj, list):
        rows = obj
    tot = 0.0
    for r in rows:
        if isinstance(r, dict):
            for k in ("totalCost", "cost", "total_cost", "totalCostUSD"):
                if k in r and isinstance(r[k], (int, float)):
                    tot += r[k]
                    break
    return round(tot, 6)


def run_ccusage(binname, sub, since, until):
    argv = [binname, sub, "--json", "--since", since]
    if until:
        argv += ["--until", until]
    p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90,
                       stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        raise RuntimeError("ccusage rc=%d" % p.returncode)
    return _sum_cost(json.loads(p.stdout.decode("utf-8", "replace")), sub)


def get_spend(now):
    binname = os.environ.get("TOKEN_BUDGET_CCUSAGE_BIN") or "ccusage"
    today = T.local(now).strftime("%Y%m%d")
    monday = T.monday_of_week(now).strftime("%Y%m%d")
    try:
        d = run_ccusage(binname, "daily", today, today)
        w = run_ccusage(binname, "weekly", monday, None)
        return {"daily_usd": d, "weekly_usd": w}, None
    except Exception:
        return {"daily_usd": None, "weekly_usd": None}, "ccusage"


# ---------- manifest ----------
def first_str(v, n=120):
    return v if len(v) <= n else v[:n]


def collect_hooks(settings_objs):
    out = []
    for s in settings_objs:
        hooks = s.get("hooks")
        if not isinstance(hooks, dict):
            continue
        for ev, groups in hooks.items():
            if not isinstance(groups, list):
                continue
            for g in groups:
                if not isinstance(g, dict):
                    continue
                m = g.get("matcher", "")
                for h in g.get("hooks", []) if isinstance(g.get("hooks"), list) else []:
                    if isinstance(h, dict) and isinstance(h.get("command"), str):
                        out.append({"event": ev, "matcher": m if isinstance(m, str) else "",
                                    "command": first_str(T.redact(h["command"]))})
    out.sort(key=lambda x: (x["event"], x["matcher"], x["command"]))
    return out


def plugin_list(settings_objs, ch):
    inst, _ = T.load_json_lenient(os.path.join(ch, "plugins", "installed_plugins.json"))
    plugins = inst.get("plugins", inst) if isinstance(inst, dict) else {}
    enabled = {}
    for s in settings_objs:
        ep = s.get("enabledPlugins")
        if isinstance(ep, dict):
            enabled.update(ep)
    res = []
    for key, val in plugins.items():
        if not isinstance(key, str):
            continue
        if enabled and not enabled.get(key, False):
            continue
        ent = val[0] if isinstance(val, list) and val else val
        if not isinstance(ent, dict):
            ent = {}
        name, _, src = key.partition("@")
        res.append({"name": name, "version": str(ent.get("version", "unknown")),
                    "source": src, "surfaces": detect_surfaces(ent.get("installPath")),
                    "_path": ent.get("installPath")})
    res.sort(key=lambda p: (p["name"], p["source"]))
    return res


def detect_surfaces(path):
    """Sorted subset of skills/agents/hooks/mcp/commands/statusline found in a plugin install dir."""
    if not path or not os.path.isdir(path):
        return []
    out = set()
    try:
        if os.path.isdir(os.path.join(path, "skills")):
            out.add("skills")
        if os.path.isdir(os.path.join(path, "agents")):
            out.add("agents")
        if os.path.isdir(os.path.join(path, "commands")):
            out.add("commands")
        pj = {}
        for cand in (os.path.join(path, ".claude-plugin", "plugin.json"), os.path.join(path, "plugin.json")):
            obj, _ = T.load_json_lenient(cand)
            if obj:
                pj = obj
                break
        if pj.get("hooks"):
            out.add("hooks")
        if pj.get("mcpServers"):
            out.add("mcp")
        if pj.get("commands"):
            out.add("commands")
        if pj.get("statusLine"):
            out.add("statusline")
        if os.path.isfile(os.path.join(path, "hooks", "hooks.json")):
            out.add("hooks")
        import glob as _g
        if _g.glob(os.path.join(path, "hooks", "register.*")):
            out.add("hooks")
        if os.path.isfile(os.path.join(path, ".mcp.json")):
            out.add("mcp")
        for d in (os.path.join(path, "hooks", "mods"), os.path.join(path, "mods")):
            for f in _g.glob(os.path.join(d, "*")):
                b = os.path.basename(f).lower()
                if "status" in b and "line" in b.replace("-", "").replace("_", ""):
                    out.add("statusline")
    except OSError:
        return []
    return sorted(out)


def scan_skill_dir(base):
    out = []
    try:
        for n in sorted(os.listdir(base)):
            d = os.path.join(base, n)
            if os.path.isfile(os.path.join(d, "SKILL.md")):
                out.append((n, d))
    except OSError:
        pass
    return out


def map_source(src, name):
    s = src.strip()
    low = s.lower()
    if low == "user":
        return "user", name
    if low == "project":
        return "project", name
    if low.startswith("built"):
        return "builtin", name
    m = re.match(r"(?i)plugin\s*\((.+)\)", s)
    if m:
        p = m.group(1).strip()
        base = name[len(p) + 1:] if name.startswith(p + ":") else name
        return "plugin:" + p, base
    return T.slug(s) or "unknown", name


def build_skills(ctx, plugins, ch):
    sk = {}
    for name, src, tok in ctx["skills"]:
        source, base = map_source(src, name)
        sk[(base, source)] = {"name": base, "source": source, "path": None, "override": None, "tokens": tok}
    for n, d in scan_skill_dir(os.path.join(ch, "skills")):
        key = (n, "user")
        e = sk.setdefault(key, {"name": n, "source": "user", "path": None, "override": None, "tokens": 0})
        e["path"] = T.home_abbrev(d)
    for p in plugins:
        if p.get("_path"):
            for n, d in scan_skill_dir(os.path.join(p["_path"], "skills")):
                key = (n, "plugin:" + p["name"])
                e = sk.setdefault(key, {"name": n, "source": "plugin:" + p["name"], "path": None,
                                        "override": None, "tokens": 0})
                if e["path"] is None:
                    e["path"] = T.home_abbrev(d)
    return sk


def server_display(raw, denied, configured):
    if raw.startswith("claude_ai_"):
        guess = "claude.ai " + raw[len("claude_ai_"):].replace("_", " ")
        kind = "connector"
        pool = list(denied)
    else:
        guess = raw
        kind = "local"
        pool = list(configured)
    for cand in pool:
        if T.norm_key(cand) == T.norm_key(guess):
            return cand, kind
    return guess, kind


def pick_always_loaded(servers, target):
    """servers: {name: total_tokens}. Return set of names whose sum matches `target`."""
    if target <= 0 or not servers:
        return set()
    names = sorted(servers)
    if len(names) > 18:
        return set()
    tol = max(5, int(target * 0.03))
    best, best_key = None, None
    for r in range(1, len(names) + 1):
        for combo in itertools.combinations(names, r):
            diff = abs(sum(servers[n] for n in combo) - target)
            if diff <= tol:
                key = (diff, r)
                if best_key is None or key < best_key:
                    best, best_key = combo, key
    return set(best) if best else set()


def build_manifest(ctx, ts, settings_objs, warnings, turn_version):
    ch = T.claude_home()
    denied = []
    configured = []
    for s in settings_objs:
        d = s.get("deniedMcpServers")
        if isinstance(d, list):
            for e in d:
                nm = e.get("serverName") if isinstance(e, dict) else (e if isinstance(e, str) else None)
                if isinstance(nm, str) and nm not in denied:
                    denied.append(nm)
        m = s.get("mcpServers")
        if isinstance(m, dict):
            configured += [k for k in m if k not in configured]
    mj, _ = T.load_json_lenient(os.path.join(ch, ".mcp.json"))
    if isinstance(mj.get("mcpServers"), dict):
        configured += [k for k in mj["mcpServers"] if k not in configured]

    plugins = plugin_list(settings_objs, ch)
    skills = build_skills(ctx, plugins, ch)
    overrides = {}
    for s in settings_objs:
        so = s.get("skillOverrides")
        if isinstance(so, dict):
            overrides.update({str(k): v for k, v in so.items()})
    for e in skills.values():
        if e["name"] in overrides and e["source"] in ("user", "project"):
            e["override"] = overrides[e["name"]]

    by_server = {}
    for tool, server, tok in ctx["mcp_rows"]:
        by_server.setdefault(server, []).append((tool, tok))
    totals = {s: sum(t for _, t in rows) for s, rows in by_server.items()}
    loaded = pick_always_loaded(totals, ctx["categories"]["mcp_tools"])
    servers = {}
    for raw, rows in by_server.items():
        disp, kind = server_display(raw, denied, configured)
        pref = "mcp__%s__" % raw
        tools = []
        for tool, tok in rows:
            short = tool[len(pref):] if tool.startswith(pref) else tool
            tools.append({"name": short, "tokens": tok})
        tools.sort(key=lambda x: x["name"])
        servers[disp] = {"name": disp, "kind": kind, "deferred": raw not in loaded,
                         "tool_count": len(rows), "tools": tools,
                         "always_loaded_tokens": totals[raw] if raw in loaded else 0}
    for nm in configured:
        if not any(T.norm_key(nm) == T.norm_key(k) for k in servers):
            servers[nm] = {"name": nm, "kind": "local", "deferred": False, "tool_count": 0,
                           "tools": [], "always_loaded_tokens": 0}

    claude_md = {}
    for key, path in (("user", os.path.join(ch, "CLAUDE.md")),
                      ("vault", os.path.join(os.environ.get("OBSIDIAN_VAULT_PATH", ""), "_CLAUDE.md")
                       if os.environ.get("OBSIDIAN_VAULT_PATH") else None)):
        if path and os.path.isfile(path):
            b = os.path.getsize(path)
            claude_md[key] = {"path": T.home_abbrev(path), "bytes": b, "est_tokens": int(math.ceil(b / 4.0))}

    win = os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
    if not win:
        for s in settings_objs:
            e = s.get("env")
            if isinstance(e, dict) and e.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") not in (None, ""):
                win = str(e["CLAUDE_CODE_AUTO_COMPACT_WINDOW"])
    manifest = {
        "schema": 1,
        "ts": ts,
        "cli_version": turn_version,
        "skills": sorted(skills.values(), key=lambda e: (e["name"], e["source"])),
        "mcp_servers": sorted(servers.values(), key=lambda e: (e["name"], e["kind"])),
        "denied_mcp_servers": sorted(denied),
        "plugins": [{k: v for k, v in p.items() if not k.startswith("_")} for p in plugins],
        "claude_md": claude_md,
        "hooks": collect_hooks(settings_objs),
        "skill_overrides": {k: overrides[k] for k in sorted(overrides)},
        "env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": win or None},
    }
    return manifest


def detect_version(ctx, turn):
    if ctx.get("cli_version"):
        return ctx["cli_version"]
    if turn.get("_version"):
        return str(turn["_version"])
    b = os.environ.get("TOKEN_BUDGET_CLAUDE_BIN") or "claude"
    try:
        p = b if os.sep in b else None
        if p is None:
            for d in os.environ.get("PATH", "").split(os.pathsep):
                c = os.path.join(d, b)
                if os.access(c, os.X_OK):
                    p = c
                    break
        if p:
            m = re.search(r"(\d+\.\d+\.\d+)", os.path.realpath(p))
            if m:
                return m.group(1)
    except Exception:
        pass
    return "unknown"


def cmd_build(a):
    ctx = T.parse_context(read(a.context))
    turn = parse_turn(read(a.turn))
    if turn is None:
        sys.stderr.write("probe: trivial-turn JSON unparseable\n")
        return 4
    now = T.now_utc()
    ts = T.fmt_ts(now)
    warnings = list(ctx["warnings"])
    st = T.state_dir()

    settings_objs = []
    for p in (T.settings_file(), os.path.join(T.claude_home(), "settings.local.json")):
        obj, err = T.load_json_lenient(p)
        if err:
            if "settings_error" not in warnings:
                warnings.append("settings_error")
            obj = {}
        settings_objs.append(obj)

    spend, w = get_spend(now)
    if w:
        warnings.append(w)
    prices, pw = tb_spend.load_prices()
    warnings += pw
    breakdown, bw = tb_spend.compute(T.claude_home(), now, prices, spend["weekly_usd"])
    warnings += bw
    version = detect_version(ctx, turn)
    manifest = build_manifest(ctx, ts, settings_objs, warnings, version)
    mrel = "manifests/%s.json" % ts.replace(":", "-")
    line = {
        "schema": 1, "ts": ts, "week": T.week_id(now), "cli_version": version, "model": "haiku",
        "total_always_loaded": ctx["total_always_loaded"],
        "category_sum_check": ctx["category_sum_check"],
        "categories": ctx["categories"],
        "context_window": ctx["context_window"],
        "trivial_turn": {k: v for k, v in turn.items() if not k.startswith("_")},
        "spend": spend,
        "spend_breakdown": breakdown,
        "manifest": mrel,
        "denied_mcp_notices": ctx["denied_mcp_notices"],
        "warnings": warnings,
    }
    text = T.scrub_tokens(json.dumps(line, separators=(",", ":"), ensure_ascii=False))
    if a.dry_run:
        print(text)
        return 0
    try:
        for sub in ("", "manifests", "logs"):
            os.makedirs(os.path.join(st, sub), mode=0o700, exist_ok=True)
        os.chmod(st, 0o700)
        mtext = T.scrub_tokens(T.jdump(manifest))
        T.write_atomic(os.path.join(st, mrel), mtext)
        T.append_line(os.path.join(st, "ledger.jsonl"), text)
    except OSError as e:
        sys.stderr.write("probe: state dir unwritable: %s\n" % e)
        return 5
    print("probe: ledger line appended (%s, %s)" % (ts, line["week"]))
    return 0


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    c = sp.add_parser("ctx-check")
    c.add_argument("file")
    c.add_argument("--dry-run", action="store_true")
    b = sp.add_parser("build")
    b.add_argument("--context", required=True)
    b.add_argument("--turn", required=True)
    b.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    return {"ctx-check": cmd_ctx_check, "build": cmd_build}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
