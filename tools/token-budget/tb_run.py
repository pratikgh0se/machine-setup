#!/usr/bin/env python3
"""Orchestration helpers for run.sh: week id, catch-up check, report + notification.

Subcommands:
  week                          print current ISO week id (local)
  ledger-has-week               exit 0 if the ledger already has a line for the current week
  catchup-needed                exit 0 if a catch-up run is needed, 1 if not
  last-run STATUS EXIT          write last-run.json
  report                        write vault report + send notification (uses newest ledger line)
  notify TEXT [TITLE]           send a notification (or NOTIFY: line)
  log-ts                        print timestamp for run.log
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tblib as T  # noqa: E402

BEGIN = "<!-- token-budget:begin -->"
END = "<!-- token-budget:end -->"


def ledger_rows(state):
    p = os.path.join(state, "ledger.jsonl")
    rows = []
    if os.path.isfile(p):
        with open(p, "r", encoding="utf-8") as f:
            for ln in f:
                if ln.strip():
                    try:
                        rows.append(json.loads(ln))
                    except ValueError:
                        pass
    return rows


def notify(text, title):
    if os.environ.get("TOKEN_BUDGET_NOTIFY", "1") == "0":
        print("NOTIFY: " + text)
        return
    t = text.replace('"', "").replace("\\", "")
    ti = title.replace('"', "").replace("\\", "")
    try:
        subprocess.run(["osascript", "-e", 'display notification "%s" with title "%s"' % (t, ti)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    except Exception:
        pass


def fk(n):
    return "%.1fk" % (abs(n) / 1000.0)


def headline(res):
    over = res["current"]["total_always_loaded"]
    if res.get("baseline") or res.get("delta_tokens") is None:
        d = "(baseline)"
    else:
        dt = res["delta_tokens"]
        d = "(%s%s)" % ("-" if dt < 0 else "+", fk(dt))
    wk = (res.get("spend") or {}).get("weekly_usd")
    sp = "spend $%.2f" % wk if isinstance(wk, (int, float)) else "spend n/a"
    return "overhead %s %s, %s, %d proposals" % (fk(over), d, sp, len(res["proposals"]))


def esc(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def build_block(res, rows, cur, state, today):
    h = headline(res)
    cats = cur.get("categories", {})
    cd = res.get("category_deltas") or {}
    L = [BEGIN, "## Headline", "%s (as of %s)" % (h, today), "",
         "## Breakdown",
         "Measured on %s (as of %s); see [[Bento]] for context." % (cur.get("ts"), today),
         "", "| Category | Tokens | Delta |", "|---|---|---|"]
    L.append("| total_always_loaded | %d | %s |" % (
        cur["total_always_loaded"],
        "n/a" if res.get("delta_tokens") is None else "%+d" % res["delta_tokens"]))
    for k, v in cats.items():
        if k == "other" or not isinstance(v, (int, float)):
            continue
        L.append("| %s | %d | %s |" % (k, v, "n/a" if res.get("baseline") else "%+d" % cd.get(k, 0)))
    L += ["", "## Spend breakdown"]
    sb = cur.get("spend_breakdown")
    if not isinstance(sb, dict):
        L.append("n/a")
    else:
        lab = "estimate (prices as of %s)" % sb.get("prices_as_of")
        L += ["Window: last %s days, %s messages counted, %s duplicate lines dropped (as of %s)."
              % (sb.get("window_days"), sb.get("messages_counted"), sb.get("duplicates_dropped"), today), "",
              "| Family | input | output | cache_read | cache_creation | est. USD |", "|---|---|---|---|---|---|"]
        for f in ("fable", "opus", "sonnet", "haiku", "other"):
            x = sb["by_family"].get(f, {})
            L.append("| %s | %d | %d | %d | %d | $%.4f |" % (
                f, x.get("input", 0), x.get("output", 0), x.get("cache_read", 0),
                x.get("cache_creation", 0), x.get("est_usd", 0)))
        cw = sb.get("ccusage_weekly_usd")
        L.append("")
        L.append("- Total: $%.4f, %s" % (sb.get("total_est_usd", 0), lab))
        L.append("- ccusage weekly: %s" % ("$%.2f (ccusage, as of %s)" % (cw, today) if isinstance(cw, (int, float)) else "ccusage n/a"))
        chr_ = sb.get("cache_hit_ratio")
        L.append("- Cache hit ratio: %s" % ("n/a" if chr_ is None else "%.4f" % chr_))
        cs = sb.get("cost_share") or {}
        L.append("- Cost share: main %.4f, subagent %.4f; frontier (fable+opus) %.4f"
                 % (cs.get("main", 0), cs.get("subagent", 0), sb.get("frontier_share", 0)))
        L.append("")
        L.append("Top sessions (%s):" % lab)
        L += ["", "| project | session | est. USD | dominant model |", "|---|---|---|---|"]
        for s in sb.get("top_sessions", []):
            L.append("| %s | %s | $%.4f | %s |" % (esc(s["project"]), esc(s["session"]), s["est_usd"], s["dominant_model"]))
        if not sb.get("top_sessions"):
            L.append("| none | | | |")
        L += ["", "### Risky sessions", ""]
        rk = sorted(sb.get("risky_sessions") or [], key=lambda r: (-r.get("est_usd", 0), r.get("project", ""), r.get("session", "")))[:5]
        if not rk:
            L.append("None")
        else:
            L += ["| project | session | est. USD | subagents | nested | max steps | max context | reasons |",
                  "|---|---|---|---|---|---|---|---|"]
            for r in rk:
                L.append("| %s | %s | $%.4f | %d | %d | %d | %d | %s |" % (
                    esc(r["project"]), esc(r["session"]), r["est_usd"], r.get("subagent_count", 0),
                    r.get("nested_spawns", 0), r.get("max_subagent_steps", 0), r.get("max_subagent_context", 0),
                    esc(", ".join(r.get("reasons", [])))))
    L += ["", "## Regressions"]
    if res["regressions"]:
        for r in res["regressions"]:
            L.append("- %s: %s (as of %s)" % (r["kind"], esc(r["cause"]), today))
    else:
        L.append("None (as of %s)" % today)
    L += ["", "## Proposals"]
    if res["proposals"]:
        L += ["| id | est. saving | title | command |", "|---|---|---|---|"]
        for p in res["proposals"][:20]:
            L.append("| %s | %d | %s | `%s` |" % (esc(p["id"]), p["est_saving_tokens"], esc(p["title"]), esc(p["command"])))
        if len(res["proposals"]) > 20:
            L.append("")
            L.append("+%d more in proposals/%s.json" % (len(res["proposals"]) - 20, res["week"]))
        L.append("")
        L.append("(as of %s; apply one at a time via `tools/token-budget/apply.sh <id>`)" % today)
    else:
        L.append("None (as of %s)" % today)
    L += ["", "## Applied since last report"]
    prev_ts = (res.get("previous") or {}).get("ts")
    ap = []
    pth = os.path.join(state, "applied.jsonl")
    if os.path.isfile(pth):
        with open(pth, "r", encoding="utf-8") as f:
            for ln in f:
                try:
                    o = json.loads(ln)
                except ValueError:
                    continue
                if isinstance(o, dict) and (prev_ts is None or str(o.get("ts", "")) >= prev_ts):
                    ap.append(o)
    if ap:
        L += ["| ts | action | id |", "|---|---|---|"]
        for o in ap:
            L.append("| %s | %s | %s |" % (o.get("ts"), o.get("action"), esc(o.get("id"))))
    else:
        L.append("None")
    L += ["", "## Measurement notes"]
    notes = []
    for w in cur.get("warnings", []):
        notes.append("warning: %s (as of %s)" % (w, today))
    if (cur.get("spend") or {}).get("weekly_usd") is None:
        notes.append("ccusage unavailable, spend unknown (as of %s)" % today)
    for r in res["regressions"]:
        if r["kind"] == "cli_version":
            notes.append("%s (as of %s)" % (r["cause"], today))
    notes.append("CLI %s, model %s, context window %s (as of %s)" % (
        cur.get("cli_version"), cur.get("model"), cur.get("context_window"), today))
    if cur.get("denied_mcp_notices"):
        notes.append("%d denied-MCP notices ignored (expected, as of %s)" % (cur["denied_mcp_notices"], today))
    if res["stats"].get("insufficient_history"):
        notes.append("less than 14 days of transcripts: unused-skill/connector/plugin rules suppressed (as of %s)" % today)
    L += ["- " + n for n in notes]
    L.append(END)
    return "\n".join(L) + "\n"


def cmd_report():
    state = T.state_dir()
    now = T.now_utc()
    today = T.local_date(now)
    rows = ledger_rows(state)
    if not rows:
        raise RuntimeError("empty ledger")
    cur = rows[-1]
    with open(os.path.join(state, "proposals", "%s.json" % cur["week"]), "r", encoding="utf-8") as f:
        res = json.load(f)
    h = headline(res)
    week = res["week"]
    vault = os.environ.get("OBSIDIAN_VAULT_PATH")
    if not vault or not os.path.isdir(vault):
        print("report: skipped (OBSIDIAN_VAULT_PATH unset or missing)")
    else:
        block = build_block(res, rows, cur, state, today)
        rdir = os.path.join(vault, "Reports")
        os.makedirs(rdir, exist_ok=True)
        path = os.path.join(rdir, "Token Budget %s.md" % week)
        wk = (res.get("spend") or {}).get("weekly_usd")
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                old = f.read()
            b, e = old.find(BEGIN), old.find(END)
            if b != -1 and e != -1 and e > b:
                new = old[:b] + block.rstrip("\n") + old[e + len(END):]
            else:
                new = old.rstrip("\n") + "\n\n" + block
        else:
            fm = ["---", "type: report", "date: %s" % today, "week: %s" % week,
                  "tags: [token-budget, bento, report]",
                  "overhead_tokens: %d" % res["current"]["total_always_loaded"],
                  "delta_tokens: %s" % ("null" if res.get("delta_tokens") is None else res["delta_tokens"]),
                  "spend_weekly_usd: %s" % ("null" if not isinstance(wk, (int, float)) else wk),
                  "spend_est_usd_7d: %s" % (cur.get("spend_breakdown") or {}).get("total_est_usd", "null"),
                  "proposals: %d" % len(res["proposals"]),
                  "generated_by: bento-mods/tools/token-budget", "---"]
            pre = ["# Token Budget %s" % week, "", "## For future agent",
                   "Weekly always-loaded token overhead report for [[Bento]]. Measured %s (CLI %s). "
                   "Compare tokens, not percentages. Proposals are advisory; apply only via "
                   "`tools/token-budget/apply.sh <id>`." % (today, cur.get("cli_version")), ""]
            new = "\n".join(fm) + "\n" + "\n".join(pre) + "\n" + block
        T.write_atomic(path, new, mode=0o644)
        print("report: wrote %s" % path)
    msg = h
    if res["regressions"]:
        msg = "REGRESSION: " + msg
    notify(msg, "Token Budget %s" % week)


def recent_monday_9(now):
    nl = T.local(now)
    d = nl.date() - timedelta(days=nl.weekday())
    m9 = datetime(d.year, d.month, d.day, 9, 0, 0).astimezone()
    if m9 > nl:
        m9 -= timedelta(days=7)
        d2 = d - timedelta(days=7)
        m9 = datetime(d2.year, d2.month, d2.day, 9, 0, 0).astimezone()
    return m9


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    state = T.state_dir()
    now = T.now_utc()
    if cmd == "week":
        print(T.week_id(now))
    elif cmd == "log-ts":
        print(T.fmt_ts(now))
    elif cmd == "ledger-has-week":
        w = T.week_id(now)
        return 0 if any(r.get("week") == w for r in ledger_rows(state)) else 1
    elif cmd == "catchup-needed":
        obj, err = T.load_json_lenient(os.path.join(state, "last-run.json"))
        if err or obj.get("status") != "ok" or not obj.get("ts"):
            return 0
        try:
            ts = T.parse_iso(obj["ts"])
        except ValueError:
            return 0
        return 0 if ts < recent_monday_9(now).astimezone(ts.tzinfo) else 1
    elif cmd == "last-run":
        T.write_atomic(os.path.join(state, "last-run.json"),
                       json.dumps({"ts": T.fmt_ts(now), "week": T.week_id(now), "status": sys.argv[2],
                                   "exit": int(sys.argv[3])}, sort_keys=True) + "\n")
    elif cmd == "report":
        try:
            cmd_report()
        except Exception as e:  # noqa
            sys.stderr.write("report failed: %r\n" % (e,))
            return 12
    elif cmd == "notify":
        notify(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "Token Budget")
    else:
        sys.stderr.write(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
