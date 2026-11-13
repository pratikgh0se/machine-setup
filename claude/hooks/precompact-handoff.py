#!/usr/bin/env python3
"""PreCompact hook: deterministic handoff file. No LLM, no network. Always exits 0."""
import json, os, sys, time, subprocess, shutil, glob, datetime, tempfile, re, hashlib, threading
try:
    import fcntl
except Exception:  # pragma: no cover (non-POSIX): ledger updates are skipped
    fcntl = None

if os.environ.get("HANDOFF_HOOK_CHILD"):  # spawned by our own summary call: never recurse
    sys.exit(0)

_T0 = time.monotonic()
HOOK_VERSION = "1.7.1"
HOME = os.path.expanduser("~")
HANDOFFS_DIR = (os.environ.get("HANDOFF_STATE_DIR") or "").strip() or os.path.join(HOME, ".local", "state", "claude-handoffs")
HEALTH_FILE = os.path.join(HANDOFFS_DIR, "health.jsonl")
HEALTH_MAX_LINES = 5000
SECTION_NAMES = ["warning", "agent", "fallback", "user_messages", "decisions", "files", "tasks",
                 "open_tasks", "background_agents", "git", "bash", "assistant"]
FAULTS = {x.strip() for x in (os.environ.get("HANDOFF_TEST_FAULT") or "").split(",") if x.strip()}
CAP = 14000  # F39.6 (was 20,000, F37.1): file cap. The inject hook inlines at most ~9,700 chars per part.
INJECT_PREFIX = "Pre-compaction handoff (auto-saved):\n"  # same literal as postcompact-inject.py


def trunc(s, n):
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 3] + "..."


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def genuine(t):
    t = t.strip()
    if not t:
        return False
    for p in ("<task-notification", "[SYSTEM NOTIFICATION", "<system-reminder", "<command-name",
              "<local-command", "<command-message", "Caveat:",
              "<artifact-content-authored-by-others", "<bash-input>", "<bash-stdout>", "<bash-stderr>",  # F40.3
              "This session is being continued"):
        if t.startswith(p):
            return False
    return True


def ts_ms(v):
    """ISO-8601 string -> epoch ms, or None."""
    try:
        if not isinstance(v, str) or not v:
            return None
        return datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return None


def result_text(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and isinstance(b.get("text"), str))
    return ""


def one_line(v, n):
    return trunc(str(v if v is not None else "").replace("\r", " ").replace("\n", " "), n)


QA_RE = re.compile(r'"([^"]*)"="([^"]*)"')


def parse(path):
    """Single pass over the transcript. Returns a dict; never raises."""
    P = {"users": [], "asst": "", "files": [], "tasks": {}, "cmds": [], "todos": None,
         "qa": [], "bg": [], "user_events": [], "tool_events": [], "last_user": None}
    n_created = 0
    asks = {}  # tool_use_id -> list of (header, question)
    bgs = {}   # tool_use_id -> bg record
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except Exception:
        return P
    with fh:
        for line in fh:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if not isinstance(o, dict):
                continue
            if "<task-id>" in line and re.search(r"completed|failed|killed", line):
                for r in P["bg"]:
                    if not r["done"] and r["id"] and f"<task-id>{r['id']}</task-id>" in line:
                        r["done"] = True
            msg = o.get("message")
            if not isinstance(msg, dict):
                continue
            t = o.get("type")
            ts = ts_ms(o.get("timestamp"))
            try:
                if t == "user":
                    c = msg.get("content")
                    tx_all = text_of(c).strip() if not isinstance(c, str) else c.strip()
                    if tx_all.startswith("<task-notification"):
                        for r in P["bg"]:
                            if r["done"]:
                                continue
                            if (r["id"] and r["id"] in tx_all) or (not r["id"] and r["desc"] and r["desc"] in tx_all):
                                r["done"] = True
                    if o.get("isMeta"):
                        continue
                    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                        tur = o.get("toolUseResult")
                        for b in c:
                            if not isinstance(b, dict) or b.get("type") != "tool_result":
                                continue
                            tid = b.get("tool_use_id")
                            if tid in asks:
                                extract_answers(P, asks.pop(tid), b, tur)
                            if tid in bgs:
                                r = bgs.pop(tid)
                                aid = tur.get("agentId") if isinstance(tur, dict) else None
                                if not isinstance(aid, str) or not aid:
                                    m = re.search(r"agent_?[iI]d:\s*(\S+)", result_text(b.get("content")))
                                    aid = m.group(1).strip(".,;") if m else None
                                r["id"] = aid
                        continue
                    tx = text_of(c)
                    if genuine(tx):
                        P["users"].append(tx.strip())
                        if ts is not None:
                            P["last_user"] = ts
                            P["user_events"].append(ts)
                elif t == "assistant":
                    c = msg.get("content")
                    tx = text_of(c).strip()
                    if tx:
                        P["asst"] = tx
                    if not isinstance(c, list):
                        continue
                    for b in c:
                        if not isinstance(b, dict) or b.get("type") != "tool_use":
                            continue
                        if ts is not None:
                            P["tool_events"].append(ts)
                        name, inp = b.get("name", ""), b.get("input") or {}
                        if not isinstance(inp, dict):
                            continue
                        files, tasks = P["files"], P["tasks"]
                        if name in ("Edit", "Write", "NotebookEdit", "MultiEdit"):
                            fp = inp.get("file_path") or inp.get("notebook_path")
                            if fp:
                                if fp in files:
                                    files.remove(fp)
                                files.append(fp)
                        elif name == "Bash" and inp.get("command"):
                            P["cmds"].append(inp["command"])
                        elif name == "TaskCreate":
                            n_created += 1
                            tasks[str(n_created)] = {"subject": inp.get("subject", ""), "status": "pending"}
                        elif name == "TaskUpdate":
                            tid = str(inp.get("taskId", ""))
                            d = tasks.setdefault(tid, {"subject": "", "status": "pending"})
                            if inp.get("subject"):
                                d["subject"] = inp["subject"]
                            if inp.get("status"):
                                d["status"] = inp["status"]
                        elif name == "TodoWrite":
                            td = inp.get("todos")
                            if isinstance(td, list):
                                P["todos"] = [x for x in td if isinstance(x, dict)]
                        elif name == "AskUserQuestion":
                            qs = inp.get("questions")
                            if isinstance(qs, list) and isinstance(b.get("id"), str):
                                asks[b["id"]] = [(q.get("header"), q.get("question")) for q in qs
                                                 if isinstance(q, dict) and isinstance(q.get("question"), str)]
                        elif (name == "Agent" or (name == "Task" and inp.get("subagent_type"))) \
                                and inp.get("run_in_background") is True:
                            r = {"desc": str(inp.get("description") or ""), "model": inp.get("model"),
                                 "id": None, "done": False}
                            P["bg"].append(r)
                            if isinstance(b.get("id"), str):
                                bgs[b["id"]] = r
            except Exception:
                continue
    return P


def answer_pairs(qs, block, tur):
    """Pair the questions of one AskUserQuestion call with their answers: [(header, question, answer, note)]."""
    out = []
    if block.get("is_error") is True:
        return out
    answers, ann = None, {}
    if isinstance(tur, dict):
        if isinstance(tur.get("answers"), dict):
            answers = tur["answers"]
        if isinstance(tur.get("annotations"), dict):
            ann = tur["annotations"]
    if answers is None:
        answers = dict(QA_RE.findall(result_text(block.get("content"))))
    for header, q in qs:
        a = answers.get(q)
        if isinstance(a, list):
            a = ", ".join(str(x) for x in a)
        if a is None or not isinstance(a, (str, int, float)) or str(a).strip() == "":
            continue
        note = ann.get(q).get("notes") if isinstance(ann.get(q), dict) else None
        out.append((header, q, a, note))
    return out


def extract_answers(P, qs, block, tur):
    for header, q, a, note in answer_pairs(qs, block, tur):
        line = "- " + (f"[{one_line(header, 200)}] " if isinstance(header, str) and header.strip() else "")
        line += f"{one_line(q, 200)} -> {one_line(a, 200)}"
        if isinstance(note, str) and note.strip():
            line += f" (notes: {one_line(note, 200)})"
        P["qa"].append(line)


def git(cwd):
    try:
        if not cwd or not os.path.isdir(cwd):
            return None
        r = subprocess.run(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"],
                           capture_output=True, text=True, timeout=3)
        if r.returncode != 0:
            return None
        b = subprocess.run(["git", "-C", cwd, "branch", "--show-current"],
                           capture_output=True, text=True, timeout=3).stdout.strip()
        s = subprocess.run(["git", "-C", cwd, "status", "--short"],
                           capture_output=True, text=True, timeout=3).stdout.strip()
        return b, s
    except Exception:
        return None


AGENT_CAP = 5000
FRESH_TOKENS = 50000
FRESH_NO_META_MS = 30 * 60 * 1000
MIN_AGENT_BYTES = 300
FRESH_GRACE_MS = 600000
STALE_USER_TURNS = 3
STALE_TOOL_CALLS = 40
HEADINGS = ["Goal", "Parallel work running", "Decisions and why", "Done", "In progress", "Dead ends", "Exact next step"]
STALE_NAMES = ["Parallel work running", "In progress", "Exact next step"]
SUMMARY_TIMEOUT_DEFAULT = 75
SUMMARY_MSG_CAP = 4000
SUMMARY_EXCERPT_CAP = 120000
SUMMARY_TEXT_CAP = 4000  # F39.6 (was 6,000)
SUMMARY_SYSTEM = ("You write handoff notes for an AI coding agent that will resume this session after its "
                  "context is compacted. Output only the note.")
SUMMARY_PROMPT = ("The conversation since the last compaction is on stdin. Write the handoff with exactly these "
                  "headings: ## Goal, ## Parallel work running, ## Decisions and why, ## Done, ## In progress, "
                  "## Dead ends, ## Exact next step. Under Parallel work running list every background agent, subagent, builder "
                  "or long-running job that is running or queued (name, task, branch or id, state), or \"none\". Describe the state at the END of the conversation, including the user's "
                  "latest request and any rules they set (what needs their approval, what not to touch). "
                  "Under Done list only work confirmed by a tool result; put anything started but unconfirmed "
                  "under In progress prefixed \"unverified:\". "
                  "Keep it under 3500 chars. Use real paths, commands and ids; no secrets.")
STANDING_HEAD = ("STANDING DECISIONS (do not contradict; if the conversation conflicts, "
                 "say so under Decisions):\n")
AUTHORITY = ("- authority: the user's latest words > Project decisions > Agent handoff > Fresh summary > "
             "Claude Code's summary > Facts. If two disagree, the newer statement from the user wins; "
             "if unsure, ask.\n")
RECALL_LINE = ("- recall: earlier chats in this project are searchable word for word: python3 ~/.claude/hooks/recall.py "
               "search \"<words or regex>\" (then: recall.py open <id>; recall.py user --last 20). Use it before acting on "
               "anything vague here (exact commands, numbers, paths, names, the user's wording) and whenever the user "
               "refers to something said earlier; quote what you find instead of guessing. "
               "If recall and the decisions list disagree, the decisions list and the user's latest words win: "
               "recall shows history, not current rules.\n")


def recall_path():
    """F44.11(a): ~/.claude/hooks/recall.py (HOME from the environment) or recall.py next to this hook; None if neither."""
    for p in (os.path.join(os.path.expanduser("~"), ".claude", "hooks", "recall.py"),
              os.path.join(os.path.dirname(os.path.abspath(__file__)), "recall.py")):
        if os.path.isfile(p):
            return p
    return None


def recall_line():
    return RECALL_LINE if recall_path() else ""


def summary_enabled():
    return os.environ.get("HANDOFF_SUMMARY") != "0" and os.environ.get("HANDOFF_HAIKU_FALLBACK") != "0"


def summary_model():
    m = os.environ.get("HANDOFF_SUMMARY_MODEL") or ""
    return m if re.fullmatch(r"[A-Za-z0-9._-]+", m) else "sonnet"


def summary_timeout():
    v = (os.environ.get("HANDOFF_SUMMARY_TIMEOUT") or "").strip()
    if re.fullmatch(r"\d+", v) and 1 <= int(v) <= 300:
        return int(v)
    return SUMMARY_TIMEOUT_DEFAULT


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def is_fresh(meta, size, mtime_ms, now_ms):
    """Agent handoff freshness. meta=None means no meta file."""
    if size is None or size < MIN_AGENT_BYTES:
        return False
    if not isinstance(meta, dict):
        return (now_ms - mtime_ms) <= FRESH_NO_META_MS
    written = _num(meta.get("agentWrittenAt"))
    if written is None:
        return False
    nudge = _num(meta.get("lastNudgeAt"))
    if nudge is not None and written >= nudge:
        return True
    ctx, wt = _num(meta.get("ctxTokens")), _num(meta.get("agentWrittenAtTokens"))
    return ctx is not None and wt is not None and (ctx - wt) <= FRESH_TOKENS


def section_hashes(text):
    """F35.1 hashes: heading (no '## ') -> first 12 hex of SHA-256 of the body, or 'absent'."""
    bodies, cur = {}, None
    for ln in text.replace("\r\n", "\n").split("\n"):
        if ln.startswith("## "):
            h = ln[3:]
            cur = [] if (ln == "## " + h and h in HEADINGS and h not in bodies) else None
            if cur is not None:
                bodies[h] = cur
            continue
        if cur is not None:
            cur.append(ln)
    return {h: (hashlib.sha256("\n".join(bodies[h]).rstrip().encode("utf-8")).hexdigest()[:12]
                if h in bodies else "absent") for h in HEADINGS}


def utc(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def read_agent(sid, P):
    """Return (body, warning, stale_sections). body None = no usable agent file (missing, unreadable,
    < 300 bytes). warning None = fresh. Never raises."""
    try:
        ap = os.path.join(HANDOFFS_DIR, f"{sid}-agent.md")
        st = os.stat(ap)
        if st.st_size < MIN_AGENT_BYTES:
            return None, None, []
        with open(ap, encoding="utf-8", errors="replace") as f:
            raw = f.read()
        body = raw.strip()
        meta = None
        try:
            with open(os.path.join(HANDOFFS_DIR, f"{sid}-agent.meta.json"), encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            meta = None
        if not isinstance(meta, dict):
            meta = None
        mtime_ms = st.st_mtime * 1000
        reasons = []
        # (a) stale sections: meta says so, or the hook re-derives it
        stale = False
        stale_names = []
        if meta is not None:
            ss = meta.get("stale_sections")
            if isinstance(ss, list) and any(isinstance(x, str) for x in ss):
                stale = True
                stale_names = [x for x in ss if isinstance(x, str)]
            secs, nudge_at = meta.get("sections"), _num(meta.get("lastNudgeAt"))
            if not stale and isinstance(secs, dict) and nudge_at is not None:
                cur = section_hashes(raw)
                if all(isinstance(secs.get(h), str) and cur[h] == secs[h] for h in STALE_NAMES):
                    users = sum(1 for x in P["user_events"] if x > nudge_at)
                    tools = sum(1 for x in P["tool_events"] if x > nudge_at)
                    stale = users >= STALE_USER_TURNS or tools >= STALE_TOOL_CALLS
                    if stale:
                        stale_names = list(STALE_NAMES)
        if stale:
            na = _num(meta.get("lastNudgeAt")) if meta else None
            reasons.append(f"{', '.join(STALE_NAMES)} unchanged since {utc(na if na is not None else mtime_ms)}")
        lu = P["last_user"]
        if lu is not None and mtime_ms < lu - FRESH_GRACE_MS:
            reasons.append(f"file written {utc(mtime_ms)} is older than the last user message by more than 10 min")
        if not is_fresh(meta, st.st_size, mtime_ms, time.time() * 1000):
            reasons.append("not updated since the last nudge")
        return body, ("; ".join(reasons) if reasons else None), stale_names
    except Exception:
        return None, None, []


def excerpt(path, limit=SUMMARY_EXCERPT_CAP):
    """F38.2 + F39.7: genuine user/assistant messages after the last compact_boundary; tool uses as
    one-liners ending `-> ok`, `-> error: <first line>` or `-> no result`."""
    items = []
    results = {}  # tool_use_id -> suffix
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if not isinstance(o, dict):
                    continue
                if o.get("type") == "system" and o.get("subtype") == "compact_boundary":
                    items = []
                    continue
                msg = o.get("message")
                if not isinstance(msg, dict):
                    continue
                t, c = o.get("type"), msg.get("content")
                if t == "user" and not o.get("isMeta") and not o.get("isCompactSummary"):
                    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                        for b in c:
                            if isinstance(b, dict) and b.get("type") == "tool_result" and isinstance(b.get("tool_use_id"), str):
                                if b.get("is_error") is True:
                                    first = (result_text(b.get("content")).strip().split("\n") or [""])[0]
                                    results[b["tool_use_id"]] = ("error: " + trunc(first, 200)).rstrip()
                                else:
                                    results[b["tool_use_id"]] = "ok"
                        continue
                    tx = text_of(c).strip()
                    if genuine(tx):
                        items.append(["USER: " + trunc(tx, SUMMARY_MSG_CAP)])
                elif t == "assistant":
                    parts = []
                    tx = text_of(c).strip()
                    if tx:
                        parts.append(trunc(tx, SUMMARY_MSG_CAP))
                    if isinstance(c, list):
                        for b in c:
                            if isinstance(b, dict) and b.get("type") == "tool_use":
                                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                                key = (inp.get("file_path") or inp.get("command") or inp.get("pattern")
                                       or inp.get("description") or inp.get("prompt") or inp.get("subject") or "")
                                parts.append((f"[tool {b.get('name')}: {trunc(str(key), 300)}]", b.get("id")))
                    if parts:
                        items.append(["ASSISTANT: "] + parts)
    except Exception:
        return ""
    msgs = []
    for it in items:
        if len(it) == 1:
            msgs.append(it[0])
            continue
        lines = []
        for x in it[1:]:
            if isinstance(x, tuple):
                lines.append(x[0] + " -> " + results.get(x[1], "no result"))
            else:
                lines.append(x)
        msgs.append(it[0] + "\n".join(lines))
    sizes = [len(x) for x in msgs]
    total = sum(sizes) + 2 * max(len(msgs) - 1, 0)
    i = 0
    while total > limit and len(msgs) - i > 1:
        total -= sizes[i] + 2
        i += 1
    out = "\n\n".join(msgs[i:])
    return out[-limit:] if limit > 0 else ""


def run_claude(stdin_text, system, prompt, model, timeout):
    """One isolated headless `claude` call (F38.3 argv). Returns (stdout, None) or (None, reason). Never raises."""
    try:
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_AUTO_COMPACT_WINDOW"}
        env["HANDOFF_HOOK_CHILD"] = "1"
        with tempfile.TemporaryDirectory(prefix="handoff-hk-") as td:
            proc = subprocess.Popen(
                ["claude", "-p", "--model", model, "--output-format", "text", "--no-session-persistence",
                 "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                 "--disable-slash-commands", "--tools", "",
                 "--system-prompt", system, prompt],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, cwd=td, env=env, start_new_session=True)
            try:
                stdout, _ = proc.communicate(input=stdin_text, timeout=timeout)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, 9)
                except Exception:
                    proc.kill()
                try:
                    proc.communicate(timeout=5)
                except Exception:
                    pass
                return None, f"timeout after {timeout}s"
            finally:
                try:
                    os.killpg(proc.pid, 9)  # stragglers holding our pipes
                except Exception:
                    pass
        if proc.returncode != 0:
            return None, f"claude exited {proc.returncode}"
        return stdout or "", None
    except FileNotFoundError:
        return None, "claude binary not found"
    except Exception as e:
        return None, type(e).__name__


def summary_handoff(tp, model, timeout, standing="(none)"):
    """Return (text, None) or (None, reason). Never raises."""
    try:
        pre = STANDING_HEAD + standing + "\n\nCONVERSATION:\n"
        ex = excerpt(tp, max(SUMMARY_EXCERPT_CAP - len(pre), 1000))
        if not ex:
            return None, "no transcript excerpt"
        out, err = run_claude(pre + ex, SUMMARY_SYSTEM, SUMMARY_PROMPT, model, timeout)
        if err:
            return None, err
        out = out.strip()
        if len(out) < 50:
            return None, "empty or too-short output"
        return trunc(out, SUMMARY_TEXT_CAP), None
    except Exception as e:
        return None, type(e).__name__


# ---- F39 project decisions ledger ----------------------------------------------------------------
LEDGER_LINE_MAX = 700  # F39.11 (was 400)
LEDGER_SECTION_CAP = 4000
MERGE_INPUT_CAP = 40000  # F40.2 (was 60,000)
LEDGER_TIMEOUT_DEFAULT = 100  # F40.2
LOCK_WAIT_S = 10
BACKUPS_KEEP = 20
LEDGER_SYSTEM = "You maintain a project's decisions ledger for an AI coding agent. Output only the ledger."
LEDGER_PROMPT = ("Stdin has the CURRENT LEDGER, then NEW CONVERSATION since it was last updated. "
                 "Output only the changes, one per line, nothing else: new decisions as "
                 "\"- D<n> [YYYY-MM-DD] [rule|decision|task] <decision> | why: <reason>\" with n continuing after the highest "
                 "existing id, and replacements as \"SUPERSEDE D<old> BY D<new>: <reason>\" where D<new> is an "
                 "existing or newly added id. Output \"NO CHANGES\" if nothing qualifies. Rules: keep every existing entry and its id. "
                 "Add an entry only for a decision the user made or explicitly approved (a choice, a rule, a "
                 "constraint, a permission, a rejected option), dated with the day it was made. When the user "
                 "replaces an earlier decision, rewrite that entry as SUPERSEDED by the new id with the reason; "
                 "never delete entries. Do not record plans, progress or the assistant's own unapproved proposals. "
                 "Format of active lines: \"- D<n> [YYYY-MM-DD] [rule|decision|task] <decision> | why: <reason>\". Format of superseded "
                 "lines: \"- D<n> [YYYY-MM-DD] SUPERSEDED by D<m> [YYYY-MM-DD]: <old decision> | because: <reason>\". "
                 "Keep the ledger lean: when a new decision changes, narrows or repeats an older one, rewrite the "
                 "older entry as SUPERSEDED by the new id (because: replaced, narrowed or merged). Two active "
                 "entries must never say the same thing or contradict each other. When you merge or narrow "
                 "entries, keep every concrete value from both (names, numbers, paths, limits, schedules). "
                 # F42.2
                 "Tag each new entry [rule], [decision] or [task]. Record operating modes and the user's working "
                 "preferences as [rule] entries the moment the user states them (for example how many agents run in "
                 "parallel, priority order, who writes tests, how to ask the user questions), with the concrete "
                 "numbers. One-off approvals and status updates are [task]. When an active [task] is done or was a "
                 "one-off already acted on, output \"RESOLVE D<n>: <reason>\". When two active entries contradict "
                 "each other, SUPERSEDE the older one. For untagged existing entries you may output "
                 "\"KIND D<n> rule|decision|task\" (at most 40).")
MAINT_PROMPT = ("Stdin has a project's decisions LEDGER (one entry per line). Output ONLY maintenance lines, one per "
                "line, nothing else, no prose: \"KIND D<n> rule|decision|task\" to tag an untagged active entry; "
                "\"RESOLVE D<n>: <reason>\" for an active task or untagged entry that is finished or was a one-off "
                "approval, action or status already acted on; \"SUPERSEDE D<old> BY D<new>: <reason>\" when two "
                "active entries contradict each other or say the same thing (old and new are existing ids; the newer "
                "entry is D<new>). Kinds: rule = a standing rule, preference, priority, operating mode or process "
                "that applies until replaced (how many builders run in parallel, who writes tests, how the user wants "
                "to be asked, what to never do, naming, priority order); decision = a design, product or technical "
                "choice; task = a one-off approval, action or status that is finished once done. Tag every untagged "
                "active entry. Never add entries, never edit entry text, never RESOLVE a rule. Output \"NO CHANGES\" "
                "if nothing applies.")
ACT_RE = re.compile(r"^- D(\d+) \[(\d{4}-\d{2}-\d{2})\] (.+?) \| why: (.+)$")
RES_RE = re.compile(r"^- D(\d+) \[(\d{4}-\d{2}-\d{2})\] RESOLVED \[(\d{4}-\d{2}-\d{2})\]: (.+?) \| was: (.+)$")
TAG_RE = re.compile(r"^\[(rule|decision|task)\] ")
SUP_RE = re.compile(r"^- D(\d+) \[(\d{4}-\d{2}-\d{2})\] SUPERSEDED by D(\d+) \[(\d{4}-\d{2}-\d{2})\]: (.+?) \| because: (.+)$")


def ledger_enabled():
    return os.environ.get("HANDOFF_LEDGER") != "0"


def ledger_timeout():
    v = (os.environ.get("HANDOFF_LEDGER_TIMEOUT") or "").strip()
    if re.fullmatch(r"\d+", v) and 1 <= int(v) <= 300:
        return int(v)
    return LEDGER_TIMEOUT_DEFAULT


def ledger_model():
    m = os.environ.get("HANDOFF_LEDGER_MODEL") or ""
    return m if re.fullmatch(r"[A-Za-z0-9._-]+", m) else summary_model()


def project_root(cwd):
    """F39.1: git toplevel of cwd (5 s timeout), else cwd itself; None without a cwd."""
    if not isinstance(cwd, str) or not cwd.strip():
        return None
    try:
        r = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, timeout=5)
        out = (r.stdout or "").strip()
        if r.returncode == 0 and out:
            return out
    except Exception:
        pass
    return cwd


def project_key(root):
    base = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(root.rstrip("/")))[:40]
    return base + "-" + hashlib.sha1(root.encode("utf-8")).hexdigest()[:8]


def ledger_dir(root):
    return os.path.abspath(os.path.join(HANDOFFS_DIR, "projects", project_key(root)))


def parse_entry(line, cap=True):
    """One ledger line -> dict(id, kind, line, by, tag) or None. kind is act|sup|res; tag (F42.1) is
    rule|decision|task|None for an active entry. Over-long lines are cut with `...` (F39.2)."""
    line = (line or "").rstrip("\r\n").strip()
    m = RES_RE.match(line)
    if m:
        pre = f"- D{m.group(1)} [{m.group(2)}] RESOLVED [{m.group(3)}]: {m.group(4)} | was: "
        was = m.group(5)
        # F44.11(c): RESOLVED lines are exempt from LEDGER_LINE_MAX (never injected); `was:` is kept whole
        return None if int(m.group(1)) < 1 else {"id": int(m.group(1)), "kind": "res", "line": pre + was, "by": None, "tag": None}
    m = SUP_RE.match(line)
    if m:
        pre = f"- D{m.group(1)} [{m.group(2)}] SUPERSEDED by D{m.group(3)} [{m.group(4)}]: "
        dec, sep, why = m.group(5), " | because: ", m.group(6)
        kind, by = "sup", int(m.group(3))
    else:
        m = ACT_RE.match(line)
        if not m:
            return None
        pre = f"- D{m.group(1)} [{m.group(2)}] "
        dec, sep, why = m.group(3), " | why: ", m.group(4)
        kind, by = "act", None
    if int(m.group(1)) < 1:
        return None
    full = pre + dec + sep + why
    if cap and len(full) > LEDGER_LINE_MAX and kind == "act":  # F44.11(c): SUPERSEDED lines are exempt from the cap
        # F39.11: parsed first; cut the why/because text (ending ...), then the decision text; never dropped
        over = len(full) - LEDGER_LINE_MAX
        keep = max(len(why) - over - 3, 0)
        if keep or len(why) - over >= 3:
            why = why[:keep] + "..."
        else:
            over -= len(why) - 3
            why = "..."
            dec = dec[: max(len(dec) - over - 3, 0)] + "..."
        full = pre + dec + sep + why
    tm = TAG_RE.match(dec) if kind == "act" else None
    return {"id": int(m.group(1)), "kind": kind, "line": full, "by": by, "tag": tm.group(1) if tm else None}


def parse_ledger(text):
    out = {}
    for ln in (text or "").splitlines():
        e = parse_entry(ln, cap=False)  # F44.11(c): the cap applies to new model lines only, never to stored entries
        if e and e["id"] not in out:
            out[e["id"]] = e
    return out


def ledger_text(root, entries):
    return f"# Project decisions: {root}\n" + "".join(entries[i]["line"] + "\n" for i in sorted(entries))


def active_lines(entries):
    """F39.4: active entries, newest id first, cut by whole lines to LEDGER_SECTION_CAP chars."""
    act = [entries[i]["line"] for i in sorted(entries, reverse=True) if entries[i]["kind"] == "act"]
    if sum(len(x) + 1 for x in act) <= LEDGER_SECTION_CAP:
        return act
    room = LEDGER_SECTION_CAP - len("- (999 older active decisions in the full ledger)") - 1
    out, used = [], 0
    for x in act:
        if used + len(x) + 1 > room:
            break
        out.append(x)
        used += len(x) + 1
    out.append(f"- ({len(act) - len(out)} older active decisions in the full ledger)")
    return out


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except Exception:
        return ""


def merge_items(path, since_ms):
    """F39.3 + F40.2 merge input: ([item text], ts string of the newest item sent or None). Items are taken
    OLDEST first up to MERGE_INPUT_CAP chars (whole items), so a backlog is caught up over several
    compactions. Never raises."""
    units, asks, last_asst = [], {}, ""  # unit: (text, ms, ts_s)
    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except Exception:
        return [], None
    with fh:
        for line in fh:
            try:
                o = json.loads(line)
                if not isinstance(o, dict) or not isinstance(o.get("message"), dict):
                    continue
                msg, t = o["message"], o.get("type")
                c = msg.get("content")
                ts_s = o.get("timestamp") if isinstance(o.get("timestamp"), str) else None
                ms = ts_ms(ts_s)
                newer = since_ms is None or (ms is not None and ms > since_ms)
                if t == "assistant":
                    tx = text_of(c).strip()
                    if tx:
                        last_asst = tx
                    if isinstance(c, list):
                        for b in c:
                            if (isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "AskUserQuestion"
                                    and isinstance(b.get("id"), str) and isinstance((b.get("input") or {}).get("questions"), list)):
                                asks[b["id"]] = [(q.get("header"), q.get("question")) for q in b["input"]["questions"]
                                                 if isinstance(q, dict) and isinstance(q.get("question"), str)]
                elif t == "user":
                    if o.get("isMeta") or o.get("isCompactSummary"):
                        continue
                    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                        tur = o.get("toolUseResult")
                        for b in c:
                            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") in asks:
                                qs = asks.pop(b["tool_use_id"])
                                if not newer:
                                    continue
                                for _h, q, a, note in answer_pairs(qs, b, tur):
                                    ln = f"ANSWER {ts_s or '?'}: {one_line(q, 200)} -> {one_line(a, 200)}"
                                    if isinstance(note, str) and note.strip():
                                        ln += f" (notes: {one_line(note, 200)})"
                                    units.append((ln, ms, ts_s))
                        continue
                    tx = text_of(c).strip()
                    if genuine(tx):
                        if newer:
                            u = f"USER {ts_s or '?'}: " + trunc(tx, 4000)
                            if last_asst:
                                u = "ASSISTANT: " + last_asst[-1500:] + "\n\n" + u
                            units.append((u, ms, ts_s))
                        last_asst = ""
            except Exception:
                continue
    sent, total, newest = [], 0, None
    for text, ms, ts_s in units:
        add = len(text) + (2 if sent else 0)
        if sent and total + add > MERGE_INPUT_CAP:
            break
        sent.append(text)
        total += add
        if ms is not None and (newest is None or ms >= newest[0]):
            newest = (ms, ts_s)
    if sent and total > MERGE_INPUT_CAP:
        sent = [sent[0][:MERGE_INPUT_CAP]]
    return sent, (newest[1] if newest else None)


SUPERSEDE_RE = re.compile(r"^SUPERSEDE D(\d+) BY D(\d+): (.+)$")
RESOLVE_RE = re.compile(r"^RESOLVE D(\d+): (.+)$")
KIND_RE = re.compile(r"^KIND D(\d+) (rule|decision|task)$")
KIND_LIMIT = 40  # F42.2: KIND lines applied per merge


def apply_changes(prev, out_text, allow_new=True, kind_limit=KIND_LIMIT, stats=None):
    """F40.1 + F42.2: apply the model's ADD / KIND / RESOLVE / SUPERSEDE lines to the previous entries.
    Returns (entries, n_changes); entries is a new dict, `prev` is untouched. Invalid lines are ignored.
    Never removes an entry. allow_new=False (maintenance) ignores new entries; kind_limit None = no limit.
    `stats` (dict) receives counts add/kind/resolved/superseded."""
    res = dict(prev)
    st = {"add": 0, "kind": 0, "resolved": 0, "superseded": 0}
    prev_max = max(prev) if prev else 0
    lines = [(ln or "").strip() for ln in (out_text or "").splitlines()]
    today = datetime.date.today().isoformat()
    if allow_new:
        for ln in lines:
            e = parse_entry(ln)
            if e and e["kind"] == "act" and e["id"] > prev_max and e["id"] not in res:
                res[e["id"]] = e
                st["add"] += 1
    for ln in lines:  # F42.2 KIND: tag an untagged active entry (text otherwise unchanged)
        m = KIND_RE.match(ln)
        if not m or (kind_limit is not None and st["kind"] >= kind_limit):
            continue
        i = int(m.group(1))
        am = ACT_RE.match(res[i]["line"]) if i in res and res[i]["kind"] == "act" and res[i].get("tag") is None else None
        if not am:
            continue
        e = parse_entry(f"- D{i} [{am.group(2)}] [{m.group(2)}] {am.group(3)} | why: {am.group(4)}")
        if e:
            res[i] = e
            st["kind"] += 1
    for ln in lines:  # F42.2 RESOLVE: only an active task or untagged entry; a rule is never resolved
        m = RESOLVE_RE.match(ln)
        if not m:
            continue
        i, why = int(m.group(1)), m.group(2).strip()
        if i not in res or res[i]["kind"] != "act" or res[i].get("tag") not in (None, "task") or not why:
            continue
        pm = re.match(r"^(- D\d+ \[\d{4}-\d{2}-\d{2}\]) (.+)$", res[i]["line"])
        if not pm:
            continue
        e = parse_entry(f"{pm.group(1)} RESOLVED [{today}]: {why} | was: {pm.group(2)}")
        if e:
            res[i] = e
            st["resolved"] += 1
    for ln in lines:
        m = SUPERSEDE_RE.match(ln)
        if not m:
            continue
        old, new, why = int(m.group(1)), int(m.group(2)), m.group(3).strip()
        if old == new or old not in res or new not in res or res[old]["kind"] != "act" or not why:
            continue
        am = ACT_RE.match(res[old]["line"])
        if not am:
            continue
        sup = parse_entry(f"- D{old} [{am.group(2)}] SUPERSEDED by D{new} [{today}]: {am.group(3)} | because: {why}")
        if sup:
            res[old] = sup
            st["superseded"] += 1
    if stats is not None:
        stats.update(st)
    return res, sum(st.values())


def prune_backups(ddir):
    try:
        for old in sorted(glob.glob(os.path.join(ddir, "decisions.[0-9]*T*Z.md")))[:-BACKUPS_KEEP]:
            try:
                os.remove(old)
            except Exception:
                pass
    except Exception:
        pass


def ledger_counts(entries):
    return (sum(1 for e in entries.values() if e["kind"] == "act"),
            sum(1 for e in entries.values() if e["kind"] == "sup"),
            sum(1 for e in entries.values() if e["kind"] == "res"))


def ledger_error_of(err):
    """Map a run_claude failure reason to the F40.4 ledger_error value."""
    err = str(err)
    if err.startswith("timeout"):
        return "timeout"
    m = re.match(r"claude exited (-?\d+)", err)
    if m:
        return "exit " + m.group(1)
    if err == "claude binary not found":
        return "FileNotFoundError"
    return err or "failed"


def ledger_merge(sid, tp, root, led, timeout):
    """Thread body: lock, merge the new conversation into the ledger as a delta, write. Fills `led`
    (status ok|unchanged|failed|locked, restored, error). `timeout` covers the lock wait and the claude
    call together (F40.2). Never raises."""
    t0 = time.monotonic()
    deadline = t0 + timeout
    lock = None
    try:
        if fcntl is None:
            led["status"], led["error"] = "failed", "NoFcntl"
            return
        ddir = ledger_dir(root)
        os.makedirs(ddir, exist_ok=True)
        lock = open(os.path.join(ddir, "decisions.lock"), "a+")
        wait_until = t0 + min(LOCK_WAIT_S, timeout)
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= wait_until:
                    led["status"], led["error"] = "locked", "locked"
                    return
                time.sleep(0.1)
        lpath, spath = os.path.join(ddir, "decisions.md"), os.path.join(ddir, "decisions.state.json")
        prev_text = read_text(lpath)
        prev = parse_ledger(prev_text)
        try:
            st = json.loads(read_text(spath))
            state = st if isinstance(st, dict) else {}
        except Exception:
            state = {}
        last_ts = state.get("lastEntryTs") if isinstance(state.get("lastEntryTs"), str) else None
        items, newest = merge_items(tp, ts_ms(last_ts) if last_ts else None)
        if not items:
            led["status"] = "unchanged"
            return
        stdin_text = ("CURRENT LEDGER:\n" + (prev_text.rstrip("\n") if prev_text.strip() else "(empty)")
                      + "\n\nNEW CONVERSATION:\n" + "\n\n".join(items))
        remaining = max(1.0, deadline - time.monotonic())
        out, err = run_claude(stdin_text, LEDGER_SYSTEM, LEDGER_PROMPT, ledger_model(), remaining)
        if err or out is None:
            led["status"], led["error"] = "failed", ledger_error_of(err)
            return
        res, changes = apply_changes(prev, out)
        if changes:
            if prev_text.strip():
                ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                write_atomic(os.path.join(ddir, f"decisions.{ts}.md"), prev_text)
                prune_backups(ddir)
            write_atomic(lpath, ledger_text(root, res))
        write_atomic(spath, json.dumps({"v": 1, "root": root, "updatedAt": int(time.time() * 1000), "lastSid": sid,
                                        "lastEntryTs": newest or last_ts}))
        led["status"] = "ok" if changes else "unchanged"
        led["restored"] = 0
    except BaseException as e:
        led["status"], led["error"] = "failed", type(e).__name__
    finally:
        try:
            if lock is not None:
                lock.close()  # releases the flock
        except Exception:
            pass


MAINTAIN_TIMEOUT = 300  # F42.4


def ledger_maintain(dirarg):
    """F42.4: `--ledger-maintain <dir>`: one maintenance pass over the whole ledger of the repo containing <dir>.
    Asks the merge model ONLY for KIND / RESOLVE / SUPERSEDE lines (no new entries, no text edits), applies them under
    the ledger lock, prints one summary line. Input checks run first, before HANDOFF_LEDGER and before anything is
    created: <dir> not an existing directory -> stderr `ledger-maintain: no such directory: <dir>`, exit 2; no
    decisions.md for its project -> stdout `no ledger for <dir>`, exit 0 (no folder or lock created). Otherwise
    returns normally (exit 0)."""
    if not os.path.isdir(dirarg):
        print(f"ledger-maintain: no such directory: {dirarg}", file=sys.stderr)
        sys.exit(2)
    root = project_root(os.path.abspath(dirarg))
    ddir = ledger_dir(root)
    lpath = os.path.join(ddir, "decisions.md")
    if not os.path.exists(lpath):
        print(f"no ledger for {dirarg}")
        return
    if not ledger_enabled():
        return
    if fcntl is None:
        print("maintain failed: NoFcntl")
        return
    lock = None
    try:
        os.makedirs(ddir, exist_ok=True)
        lock = open(os.path.join(ddir, "decisions.lock"), "a+")
        t0 = time.monotonic()
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() - t0 >= LOCK_WAIT_S:
                    print("maintain failed: locked")
                    return
                time.sleep(0.1)
        prev_text = read_text(lpath)
        prev = parse_ledger(prev_text)
        before = ledger_counts(prev)[0]
        if not prev:
            print(f"kind=0 resolved=0 superseded=0 active_before=0 active_after=0")
            return
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        write_atomic(os.path.join(ddir, f"decisions.{ts}.md"), prev_text)  # F39.6 backup first
        prune_backups(ddir)
        out, err = run_claude("LEDGER:\n" + prev_text.rstrip("\n"), LEDGER_SYSTEM, MAINT_PROMPT, ledger_model(), MAINTAIN_TIMEOUT)
        if err or out is None:
            print(f"maintain failed: {ledger_error_of(err)}")
            return
        stats = {}
        res, changes = apply_changes(prev, out, allow_new=False, kind_limit=None, stats=stats)
        if changes:
            write_atomic(lpath, ledger_text(root, res))
        print(f"kind={stats.get('kind', 0)} resolved={stats.get('resolved', 0)} superseded={stats.get('superseded', 0)} "
              f"active_before={before} active_after={ledger_counts(res)[0]}")
    finally:
        try:
            if lock is not None:
                lock.close()
        except Exception:
            pass


def ledger_repair(dirarg):
    """F44.11(d): `--ledger-repair <dir>`: restore RESOLVED/SUPERSEDED lines whose `was:` (or superseded decision)
    text was cut to end in `...`, from the newest timestamped backup decisions.<ts>.md that holds the entry as an
    active line. Takes the ledger lock, writes a backup first (only when something is repaired), prints
    `repaired <n> of <m> cut lines`. <dir> not a directory -> stderr + exit 2; no ledger -> `no ledger for <dir>`."""
    if not os.path.isdir(dirarg):
        print(f"ledger-repair: no such directory: {dirarg}", file=sys.stderr)
        sys.exit(2)
    root = project_root(os.path.abspath(dirarg))
    ddir = ledger_dir(root)
    lpath = os.path.join(ddir, "decisions.md")
    if not os.path.exists(lpath):
        print(f"no ledger for {dirarg}")
        return
    if not ledger_enabled():
        return
    if fcntl is None:
        print("repair failed: NoFcntl")
        return
    lock = None
    try:
        lock = open(os.path.join(ddir, "decisions.lock"), "a+")
        t0 = time.monotonic()
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() - t0 >= LOCK_WAIT_S:
                    print("repair failed: locked")
                    return
                time.sleep(0.1)
        text = read_text(lpath)
        backups = sorted(glob.glob(os.path.join(ddir, "decisions.[0-9]*T*Z.md")), reverse=True)
        cache = {}

        def original(i, cut_prefix):
            """Full `[tag] text | why: reason` of active entry i from the newest backup that has it (and agrees with the cut text)."""
            for b in backups:
                if b not in cache:
                    d = {}
                    for ln in read_text(b).splitlines():
                        m = ACT_RE.match(ln.strip())
                        if m and int(m.group(1)) not in d:
                            d[int(m.group(1))] = (m.group(3), m.group(4))
                    cache[b] = d
                if i in cache[b]:
                    dec, why = cache[b][i]
                    if (dec + " | why: " + why).startswith(cut_prefix):
                        return dec, why
            return None

        lines = text.split("\n")
        total = fixed = 0
        for n, raw in enumerate(lines):
            ln = raw.rstrip("\r").strip()
            m = RES_RE.match(ln)
            if m and m.group(5).endswith("..."):
                total += 1
                o = original(int(m.group(1)), m.group(5)[:-3])
                if o:
                    lines[n] = f"- D{m.group(1)} [{m.group(2)}] RESOLVED [{m.group(3)}]: {m.group(4)} | was: {o[0]} | why: {o[1]}"
                    fixed += 1
                continue
            m = SUP_RE.match(ln)
            if m and m.group(5).endswith("..."):
                total += 1
                o = original(int(m.group(1)), m.group(5)[:-3])
                if o:
                    lines[n] = (f"- D{m.group(1)} [{m.group(2)}] SUPERSEDED by D{m.group(3)} [{m.group(4)}]: "
                                f"{o[0]} | because: {m.group(6)}")
                    fixed += 1
        if fixed:
            ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            write_atomic(os.path.join(ddir, f"decisions.{ts}.md"), text)  # F39.6 backup first
            prune_backups(ddir)
            write_atomic(lpath, "\n".join(lines))
        print(f"repaired {fixed} of {total} cut lines")
    finally:
        try:
            if lock is not None:
                lock.close()
        except Exception:
            pass


AGENT_HEAD = "## Agent handoff (written by the working agent)\n"
SUMMARY_HEAD_FMT = "## Fresh summary at compaction ({}; verify against facts)\n"


class Rep(str):
    """A fail-safe replacement line: never dropped by cap trimming."""


def guard(name, info, fn, default=""):
    """Run one section builder; on any Exception return a replacement line and record the name."""
    try:
        if name in FAULTS:
            raise RuntimeError("injected")
        return fn()
    except Exception as e:
        info["errors"].append(name)
        return Rep(f"(section {name} unavailable: {type(e).__name__})")


def _f_users(P, cwd):
    return ("## Last user messages (oldest first)\n" +
            "\n".join("- " + trunc(u, 600).replace("\n", " ") for u in P["users"][-8:]) + "\n") if P["users"] else ""


def _f_files(P, cwd):
    return "## Files touched (last 30)\n" + "\n".join(f"- {f}" for f in P["files"][-30:]) + "\n" if P["files"] else ""


def _f_tasks(P, cwd):
    tasks = P["tasks"]
    return "## Task state\n" + "\n".join(
        f"- [{v['status']}] {trunc(v['subject'], 150)}" for v in tasks.values()) + "\n" if tasks else ""


def _f_open(P, cwd):
    op = [f"- [{v['status']}] {one_line(v['subject'], 150)}" for v in P["tasks"].values() if v["status"] != "completed"]
    if isinstance(P["todos"], list):
        for x in P["todos"]:
            st = x.get("status")
            if isinstance(st, str) and st != "completed":
                op.append(f"- [{st}] {one_line(x.get('content'), 150)}")
    if not op:
        return ""
    return "## Open tasks\n" + "\n".join(op[:20] + ([f"- ... +{len(op) - 20} more"] if len(op) > 20 else [])) + "\n"


def _f_bg(P, cwd):
    bg = [f"- {one_line(r['desc'], 100)} (model: {r['model'] if isinstance(r['model'], str) and r['model'] else 'default'})"
          for r in P["bg"] if not r["done"]][:10]
    return "## Background agents\n" + "\n".join(bg) + "\n" if bg else ""


def _f_git(P, cwd):
    g = git(cwd)
    return f"## Git\n- branch: {g[0]}\n```\n{trunc(g[1], 1500)}\n```\n" if g else ""


def _f_cmds(P, cwd):
    return "## Last Bash commands\n" + "\n".join(
        "- `" + trunc(c, 200).replace("\n", " ") + "`" for c in P["cmds"][-5:]) + "\n" if P["cmds"] else ""


def _f_asst(P, cwd):
    return "## Last assistant message\n" + trunc(P["asst"], 1500) + "\n" if P["asst"] else ""


# internal key -> (section name, builder), in the F35.D display order
FACTS = [("users", "user_messages", _f_users), ("files", "files", _f_files),
         ("tasks", "tasks", _f_tasks), ("open", "open_tasks", _f_open), ("bg", "background_agents", _f_bg),
         ("git", "git", _f_git), ("cmds", "bash", _f_cmds), ("asst", "assistant", _f_asst)]
# F37.2: the user's own words (users) go last
DROP_ORDER = ["files", "cmds", "git", "tasks", "asst", "bg", "open", "users"]  # F39.6: no more `qa`


def build(d, info):
    sid = d.get("session_id", "unknown")
    cwd = d.get("cwd", "")
    tp = d.get("transcript_path", "")
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    header = (f"# Handoff (pre-compaction)\n- session: {sid}\n- cwd: {cwd}\n- trigger: {d.get('trigger')}\n"
              f"- time: {now}\n- transcript: {tp}\n{AUTHORITY}{recall_line()}")
    footer = f"\nFull transcript: {tp}. Read it for exact details before guessing.\n"
    P = parse(tp)
    if "toplevel" in FAULTS:
        raise RuntimeError("injected")
    enabled = summary_enabled()
    model = summary_model() if enabled else ""
    timeout = summary_timeout()
    l_timeout = ledger_timeout()
    info["summary_model"] = model

    body, warn, stale_names = read_agent(str(sid).replace("/", "_"), P)
    info["agent_file"] = "absent" if body is None else ("fresh" if warn is None else "stale")
    info["stale_sections"] = stale_names if (body is not None and warn is not None) else []

    wtxt = guard("warning", info, lambda: f"Agent handoff may be stale: {warn}\n" if (body and warn) else "")
    atxt = guard("agent", info, lambda: AGENT_HEAD + trunc(body, AGENT_CAP) + "\n\n" if body else "")
    if isinstance(atxt, Rep):
        atxt = Rep(atxt + "\n\n")
    if isinstance(wtxt, Rep):
        wtxt = Rep(wtxt + "\n")
    pre = wtxt + atxt

    # F39: ledger root, previous active lines (for the summary), merge thread
    led = {"status": "disabled", "restored": 0}
    root = None
    if ledger_enabled():
        root = project_root(cwd)
        led["status"] = "none" if root is None else "pending"
    prev_active = []
    if root is not None:
        try:
            prev_active = active_lines(parse_ledger(read_text(os.path.join(ledger_dir(root), "decisions.md"))))
        except Exception:
            prev_active = []
    standing = "\n".join(prev_active) if prev_active else "(none)"
    mthread = None
    if root is not None:
        mthread = threading.Thread(target=ledger_merge, args=(str(sid).replace("/", "_"), tp, root, led, l_timeout),
                                   daemon=True)
        mthread.start()
        m_start = time.monotonic()

    htext, hline = None, ""

    def run_summary():
        nonlocal htext, hline
        if not enabled:
            info["fallback"] = "disabled"
            return ""
        text, err = summary_handoff(tp, model, timeout, standing)
        if text:
            info["fallback"] = "ok"
            htext = text
        else:
            info["fallback"] = "timeout" if str(err).startswith("timeout after") else "failed"
            hline = f"Fresh summary failed: {err}\n\n"
        return ""

    info["fallback"] = "disabled" if not enabled else "failed"
    f_out = guard("fallback", info, run_summary)
    if isinstance(f_out, Rep):
        htext, hline = None, f_out + "\n\n"
        if "fallback" not in info["errors"]:
            info["errors"].append("fallback")

    if mthread is not None:
        mthread.join(max(0.0, m_start + l_timeout + 6 - time.monotonic()))
        if led["status"] == "pending":
            led["status"], led["error"] = "failed", "timeout"
    info["ledger"] = led["status"]
    info["ledger_restored"] = led["restored"]
    info["ledger_error"] = led.get("error", "") if led["status"] in ("failed", "locked") else ""
    lblock = ""
    if root is not None:
        def _ledger_section():
            ents = parse_ledger(read_text(os.path.join(ledger_dir(root), "decisions.md")))
            info["ledger_active"], info["ledger_superseded"], info["ledger_resolved"] = ledger_counts(ents)
            info["ledger_chars"] = sum(len(e["line"]) for e in ents.values() if e["kind"] == "act")
            return ""  # F39.10: the ledger is injected by postcompact-inject.py --ledger --part 1|2, not in latest.md
        lblock = guard("decisions", info, _ledger_section)
        if isinstance(lblock, Rep):
            lblock = Rep(lblock + "\n\n")

    secs, protected = {}, set()
    for key, name, fn in FACTS:
        out = guard(name, info, lambda fn=fn: fn(P, cwd))
        if isinstance(out, Rep):
            secs[key] = Rep(out + "\n")
            protected.add(key)
        elif out:
            secs[key] = out

    attempted = bool(htext) or bool(hline)

    def total(hblock):
        lead = pre + hblock + hline
        if lead or attempted:
            lead += "## Facts (auto-extracted)\n"
        return len(header) + len(lblock) + len(lead) + len(footer) + sum(len(v) + 1 for v in secs.values()), lead

    # F38.5: facts (F37.2 order, all but the user's words) first, then shorten the summary, then the user's words
    hblock = SUMMARY_HEAD_FMT.format(model) + htext + "\n\n" if htext else ""
    n, lead = total(hblock)
    for k in DROP_ORDER:
        if n <= CAP or k == "users":
            continue
        if k in secs and k not in protected:
            del secs[k]
            info["truncated"] = True
            n, lead = total(hblock)
    if n > CAP and htext:
        info["truncated"] = True
        head = SUMMARY_HEAD_FMT.format(model)
        room = len(htext) - (n - CAP)
        hblock = head + trunc(htext, room) + "\n\n" if room >= 200 else ""
        n, lead = total(hblock)
    if n > CAP and "users" in secs and "users" not in protected:
        del secs["users"]
        info["truncated"] = True
        n, lead = total(hblock)
    order = [k for k, _, _ in FACTS]
    info["errors"] = [e for e in SECTION_NAMES if e in info["errors"]] + [e for e in info["errors"] if e not in SECTION_NAMES]
    return header + "\n" + lblock + lead + "\n".join(secs[k] for k in order if k in secs) + footer


def minimal_handoff(d, sid, exc_name):
    """Top-level failure output: string formatting plus one guarded git call. Never raises."""
    try:
        tp = d.get("transcript_path", "")
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
        out = (f"# Handoff (minimal: hook failed with {exc_name})\n- session: {sid}\n- cwd: {d.get('cwd')}\n"
               f"- trigger: {d.get('trigger')}\n- time: {now}\n- transcript: {tp}\n")
        try:
            cwd = d.get("cwd")
            if isinstance(cwd, str) and cwd and os.path.isdir(cwd):
                r = subprocess.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
                                   capture_output=True, text=True, timeout=5)
                b = (r.stdout or "").strip()
                if r.returncode == 0 and b:
                    out += f"- git branch: {b}\n"
        except BaseException:
            pass
        return out + f"Full transcript: {tp}. Read it for exact details before guessing.\n"
    except BaseException:
        return f"# Handoff unavailable (hook failed)\n- session: {sid}\n"


def compute_status(info):
    af, ff, errs, ss = info["agent_file"], info["fallback"], info["errors"], info["stale_sections"]
    if errs or ss or (af != "fresh" and ff in ("failed", "timeout", "disabled")):
        reasons = []
        if af == "absent":
            reasons.append("agent_absent")
        if af == "stale" or ss:
            reasons.append("agent_stale")
        if ff == "failed":
            reasons.append("fallback_failed")
        if ff == "timeout":
            reasons.append("fallback_timeout")
        if errs:
            reasons.append("section_errors")
        return "degraded", reasons
    if af != "fresh" and ff == "ok":
        return "reduced", ["agent_absent" if af == "absent" else "agent_stale"]
    return "ok", []


def write_atomic(path, text):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def append_health(line):
    with open(HEALTH_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    try:
        with open(HEALTH_FILE, "rb") as f:
            lines = f.readlines()
        if len(lines) > HEALTH_MAX_LINES:
            tmp = HEALTH_FILE + f".tmp{os.getpid()}"
            with open(tmp, "wb") as f:
                f.writelines(lines[-HEALTH_MAX_LINES:])
            os.replace(tmp, HEALTH_FILE)
    except Exception:
        pass


def log_error(sid, exc):
    """F42.6: one JSON line {ts, hook, version, sid, error, trace} in <state>/hooks-error.jsonl (rotated to .1 above
    1,000,000 bytes). Never raises."""
    try:
        import traceback
        path = os.path.join(HANDOFFS_DIR, "hooks-error.jsonl")
        os.makedirs(HANDOFFS_DIR, exist_ok=True)
        try:
            if os.path.getsize(path) > 1000000:
                os.replace(path, path + ".1")
        except OSError:
            pass
        tr = traceback.format_exception(type(exc), exc, exc.__traceback__)
        tr = "".join(tr).rstrip("\n").splitlines()[-20:]
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                "hook": "precompact", "version": HOOK_VERSION, "sid": str(sid)[:36],
                                "error": f"{type(exc).__name__}: {exc}"[:300], "trace": tr}) + "\n")
    except BaseException:
        pass


def is_subagent(d):
    """F42.5. A subagent compaction is recognised by a non-empty `agent_id` in the input, or a transcript_path under
    /subagents/. Verified against Claude Code 2.1.316 (binary strings, 2026-11-08) and 102 recorded handoffs: the
    PreCompact input is built from the SESSION (session_id = parent's, transcript_path = the parent's main
    transcript, no agent_id), so a subagent compaction currently looks identical to a parent one and neither test
    fires. Both are kept for versions that add the field (SubagentStop already carries agent_id and
    agent_transcript_path)."""
    aid = d.get("agent_id")
    tp = d.get("transcript_path")
    return (isinstance(aid, str) and bool(aid.strip())) or (isinstance(tp, str) and "/subagents/" in tp)


def start_indexer(d, sid):
    """F44.9/F44.11(b): start `recall.py index --cwd <cwd> --max-seconds 600` fully detached after the handoff is
    written. Never waited on; any error goes to hooks-error.jsonl."""
    try:
        rp = recall_path()
        cwd = d.get("cwd")
        if not rp or not isinstance(cwd, str) or not cwd.strip():
            return
        rdir = os.path.join(HANDOFFS_DIR, "recall")
        os.makedirs(rdir, exist_ok=True)
        log = open(os.path.join(rdir, "index.log"), "ab")
        try:
            subprocess.Popen([sys.executable, rp, "index", "--cwd", cwd, "--max-seconds", "600"],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                             start_new_session=True, close_fds=True)
        finally:
            log.close()
    except BaseException as e:
        if not isinstance(e, KeyboardInterrupt):
            log_error(sid, e)


def main():
    try:
        d = json.load(sys.stdin)
        if not isinstance(d, dict):
            d = {}
    except Exception:
        d = {}
    sid_raw = d.get("session_id")
    sid = str(sid_raw or "unknown").replace("/", "_")
    if is_subagent(d):  # F42.5: health line only; no dump, no latest, no ledger merge, no sidecar, no cleanup
        try:
            os.makedirs(HANDOFFS_DIR, exist_ok=True)
        except Exception:
            pass
        sub = {"agent_file": "absent", "stale_sections": [], "fallback": "skipped", "errors": [], "truncated": False,
               "ledger": "skipped"}
        write_health(d, sid, sub, "", status_override="subagent", sidecar=False)
        return
    info = {"agent_file": "absent", "stale_sections": [], "fallback": "skipped", "errors": [], "truncated": False,
            "ledger": "none" if ledger_enabled() else "disabled", "ledger_active": 0, "ledger_superseded": 0,
            "ledger_resolved": 0, "ledger_restored": 0, "ledger_chars": 0, "ledger_error": ""}
    body = ""
    try:
        try:
            os.makedirs(HANDOFFS_DIR, exist_ok=True)
        except Exception:
            pass
        try:
            body = build(d, info)
        except BaseException as e:
            info["errors"].append("toplevel")
            info["hard_error"] = True  # F42.6: health status "error"
            log_error(sid, e)
            body = minimal_handoff(d, sid, type(e).__name__)
        try:
            ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            p = os.path.join(HANDOFFS_DIR, f"{sid}-{ts}.md")
            with open(p, "w", encoding="utf-8") as f:
                f.write(body)
            shutil.copyfile(p, os.path.join(HANDOFFS_DIR, f"{sid}-latest.md"))
        except Exception:
            body = ""
    finally:
        try:
            write_health(d, sid, info, body)
        except BaseException:
            pass
    if body:
        start_indexer(d, sid)
    try:
        cutoff = time.time() - 14 * 86400
        for pat in ("*.md", "*-degraded.json", "*-last-health.json"):
            for old in glob.glob(os.path.join(HANDOFFS_DIR, pat)):
                try:
                    if os.path.isfile(old) and os.path.getmtime(old) < cutoff:
                        os.remove(old)
                except Exception:
                    pass
    except Exception:
        pass


def write_health(d, sid, info, body, status_override=None, sidecar=True):
    status, reasons = compute_status(info)
    if status_override:
        status = status_override
    elif info.get("hard_error"):
        status = "error"  # F42.6; the sidecar stays degraded so the inject hook still flags it
    trig = d.get("trigger")
    line = {
        "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sid": sid[:8] if d.get("session_id") else "unknown",
        "trigger": trig if trig in ("auto", "manual") else "unknown",
        "agent_file": info["agent_file"],
        "stale_sections": info["stale_sections"],
        "fallback": info["fallback"],
        "summary_model": info.get("summary_model", ""),
        "ledger": info.get("ledger", "none"),
        "ledger_active": info.get("ledger_active", 0),
        "ledger_superseded": info.get("ledger_superseded", 0),
        "ledger_resolved": info.get("ledger_resolved", 0),
        "ledger_restored": info.get("ledger_restored", 0),
        "ledger_chars": info.get("ledger_chars", 0),
        "ledger_error": info.get("ledger_error", ""),
        "duration_ms": int((time.monotonic() - _T0) * 1000),
        "output_chars": len(body),
        "truncated": bool(info["truncated"]),
        "inline_cut": len(INJECT_PREFIX) + len(body.strip()) >= 10000,  # F37.4 prediction
        "errors": info["errors"],
        "status": status,
        "hook_version": HOOK_VERSION,
        "canary_child": bool(os.environ.get("HANDOFF_CANARY")),
    }
    try:
        side = dict(line)
        side["reasons"] = reasons
        side["degraded"] = status in ("degraded", "error")
        if not sidecar:
            raise OSError("no sidecar")
        write_atomic(os.path.join(HANDOFFS_DIR, f"{sid}-last-health.json"), json.dumps(side))
    except Exception:
        pass
    try:
        if not d.get("session_id") and not (os.environ.get("HANDOFF_STATE_DIR") or "").strip() and sys.stdin.isatty():
            return  # F42.6: a manual run with no session id never touches the live log
        append_health(json.dumps(line))
    except Exception:
        pass


_exit_code = 0
try:
    if "--ledger-maintain" in sys.argv[1:]:
        _a = sys.argv[1:]
        _i = _a.index("--ledger-maintain")
        ledger_maintain(_a[_i + 1] if _i + 1 < len(_a) else os.getcwd())
    elif "--ledger-repair" in sys.argv[1:]:
        _a = sys.argv[1:]
        _i = _a.index("--ledger-repair")
        ledger_repair(_a[_i + 1] if _i + 1 < len(_a) else os.getcwd())
    else:
        main()
except BaseException as _e:
    if isinstance(_e, SystemExit):
        _exit_code = _e.code if isinstance(_e.code, int) else 0  # F42.4: --ledger-maintain exits 2 on a bad dir
    elif not isinstance(_e, KeyboardInterrupt):
        log_error("unknown", _e)
sys.exit(_exit_code)
