#!/usr/bin/env python3
"""SessionStart(compact) hook: re-inject the pre-compaction handoff. Silent on any problem,
except a DEGRADED handoff, which is flagged to the model (first line) and recorded in
<sid>-degraded.json for the compact plugin."""
import datetime, json, os, re, sys, time

HANDOFFS_DIR = (os.environ.get("HANDOFF_STATE_DIR") or "").strip() or os.path.join(
    os.path.expanduser("~"), ".local", "state", "claude-handoffs")
MAX_AGE_S = 15 * 60
TEXTS = {"agent_absent": "no agent handoff", "agent_stale": "agent handoff stale",
         "fallback_failed": "Haiku fallback failed", "fallback_timeout": "Haiku fallback timed out",
         "no_health": "no health record for this compaction", "handoff_missing": "no handoff file for this session",
         "handoff_old": "handoff not refreshed for this compaction"}
CODE_ORDER = ["agent_absent", "agent_stale", "fallback_failed", "fallback_timeout", "section_errors",
              "no_health", "handoff_missing", "handoff_old"]


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            o = json.load(f)
        return o if isinstance(o, dict) else None
    except Exception:
        return None


def age_ok(ts):
    try:
        t = datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        return (time.time() - t.timestamp()) <= MAX_AGE_S
    except Exception:
        return False


def age_ok_s(ts, seconds):
    try:
        t = datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        return (time.time() - t.timestamp()) <= seconds
    except Exception:
        return False


def warning_text(codes, errors):
    parts = []
    for c in CODE_ORDER:
        if c not in codes:
            continue
        if c == "section_errors":
            names = [e for e in (errors or []) if isinstance(e, str)]
            parts.append("sections unavailable: " + ", ".join(names))
        else:
            parts.append(TEXTS[c])
    return "; ".join(parts)


def write_degraded(sid, codes, trigger):
    tmp = None
    try:
        path = os.path.join(HANDOFFS_DIR, f"{sid}-degraded.json")
        tmp = f"{path}.tmp{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": 1, "sid": sid, "ts": utc_now(), "reasons": codes,
                       "trigger": trigger if isinstance(trigger, str) else "unknown",
                       "detected_by": "inject"}, f)
        os.replace(tmp, path)
    except BaseException:
        pass


PREFIX = "Pre-compaction handoff (auto-saved):\n"
LIMIT = 10000      # additionalContext of ONE hook must stay under this (Claude Code spills larger values to a file)
HARD_MAX = 9900    # each part's total output (warning + header + content + continuation line) stays <= this
INLINE_MAX = 9700  # content target per part
NAMES_MAX = 150    # the section-name list in a continuation line is cut to this many chars
MAX_PARTS = 3      # F37.6
HOOK_VERSION = "1.10.0"
_SID = ["unknown"]


def log_error(exc):
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
        tr = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).rstrip("\n").splitlines()[-20:]
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": utc_now(), "hook": "inject", "version": HOOK_VERSION, "sid": str(_SID[0])[:36],
                                "error": f"{type(exc).__name__}: {exc}"[:300], "trace": tr}) + "\n")
    except BaseException:
        pass


try:
    _a = sys.argv[1:]
    PART = int(_a[_a.index("--part") + 1]) if "--part" in _a else 1  # no arg = part 1 (old installs keep working)
except Exception:
    PART = 1
if PART not in (1, 2, 3):
    PART = 1


def header(k, first=""):
    return first + PREFIX if k == 1 else f"Pre-compaction handoff (auto-saved, part {k}):\n"


def cont_line(k, n, names, path):
    where = f"part {k + 1} (injected separately; parts may appear in any order) and in {path}" if k < MAX_PARTS else path
    return f"[Handoff continues in {where}: {n} more chars (sections: {names}). Read it before acting.]"


def names_of(rest):
    names = []
    for m in re.finditer(r"(?m)^## (.+)$", rest):
        nm = re.sub(r"\s*\(.*$", "", m.group(1)).strip()
        if nm and nm not in names:
            names.append(nm)
    out = ", ".join(names) if names else "rest of file"
    if len(out) > NAMES_MAX:
        cut = out.rfind(", ", 0, NAMES_MAX - 5)
        out = (out[:cut] if cut > 0 else out[:NAMES_MAX - 5]) + ", ..."
    return out


def agent_end(txt):
    """Index where the agent (or Haiku) section ends; 1 when there is none. Its own F35.A headings
    (## Goal ... ## Exact next step) belong to it."""
    am = re.search(r"(?m)^## (Agent handoff|Model-written handoff)", txt)
    if not am:
        return 1
    inner = ("Goal", "Parallel work running", "Decisions and why", "Done", "In progress", "Dead ends", "Exact next step")
    nxt = [m.start() for m in re.finditer(r"(?m)^## (.+?)\s*$", txt)
           if m.start() > am.start() and m.group(1) not in inner]
    return nxt[0] if nxt else len(txt) + 1


def render(first, txt, path):
    """F37.3/F37.5/F37.6: list of up to MAX_PARTS additionalContext strings. Part 1 equals the plain
    section 6 string when it fits under LIMIT. Every part is <= HARD_MAX chars."""
    parts, rest = [], txt
    for k in range(1, MAX_PARTS + 1):
        head = header(k, first)
        if len(head) + len(rest) < LIMIT:
            parts.append(head + rest)
            return parts
        # reserve the continuation line first (N has at most len(str(len(rest))) digits), then fit content
        reserve = len(cont_line(k, "9" * len(str(len(rest))), "x" * NAMES_MAX, path)) + 1
        budget = min(INLINE_MAX - len(head), HARD_MAX - len(head) - reserve)
        need = agent_end(rest) if k == 1 else 1
        fit = [m.start() for m in re.finditer(r"(?m)^## ", rest) if need <= m.start() <= budget]
        if fit:
            cut = max(fit)  # last whole-section boundary that fits
        else:  # no whole section fits (oversize section / agent section): last line boundary
            nl = rest.rfind("\n", 0, budget + 1)
            cut = nl + 1 if nl > 0 else max(budget, 0)
        inl = rest[:cut].rstrip("\n")
        left = rest[len(inl):]
        parts.append(head + inl + "\n" + cont_line(k, len(left), names_of(left), path))
        rest = left.lstrip("\n")
        if not rest:  # (cannot normally happen: the loop only cuts when content overflowed)
            return parts
    return parts


def emit(ctx):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}))


RECALL_LINE = ("- recall: earlier chats in this project are searchable word for word: python3 ~/.claude/hooks/recall.py "
               "search \"<words or regex>\" (then: recall.py open <id>; recall.py user --last 20). Use it before acting on "
               "anything vague here (exact commands, numbers, paths, names, the user's wording) and whenever the user "
               "refers to something said earlier; quote what you find instead of guessing. "
               "If recall and the decisions list disagree, the decisions list and the user's latest words win: "
               "recall shows history, not current rules.\n")


def recall_line():
    """F44.11(a): the F44.6 line, only when recall.py exists in ~/.claude/hooks (HOME from the environment) or next to this hook."""
    for p in (os.path.join(os.path.expanduser("~"), ".claude", "hooks", "recall.py"),
              os.path.join(os.path.dirname(os.path.abspath(__file__)), "recall.py")):
        if os.path.isfile(p):
            return RECALL_LINE
    return ""


def ledger_part_head(k, path):
    return (f"Project decisions for this repo (part {k} of the ledger; standing rules first, then decisions, then "
            f"tasks, newest first within each; full ledger: {path}). Standing unless the user says otherwise:\n"
            + (recall_line() if k == 1 else ""))


def index_note(path):
    return f"Index entries are summaries: read the full entry in {path} before acting on one.\n"


ACT_LINE_RE = re.compile(r"^- D(\d+) \[\d{4}-\d{2}-\d{2}\] (.+) \| why: .+$")
LOOSE_ACT_RE = re.compile(r"^- D(\d+) \[\d{4}-\d{2}-\d{2}\] (.+)$")  # F44.11(e): active-looking line, `| why:` optional
KIND_ORDER = {"rule": 0, "decision": 1, "task": 2}


def parse_ledger_file(path):
    """F42.1: active entries as dicts (id, kind rule|decision|task, line, text), in priority order: rules, then
    decisions (untagged count as decision), then tasks, each newest id first. SUPERSEDED and RESOLVED lines are skipped."""
    act, other, nowhy = {}, set(), []
    with open(path, encoding="utf-8", errors="replace") as f:
        for ln in f.read().splitlines():
            ln = ln.strip()
            m = re.match(r"^- D(\d+) \[\d{4}-\d{2}-\d{2}\] (SUPERSEDED by D\d+ \[\d{4}-\d{2}-\d{2}\]: .+ \| because: .+|RESOLVED \[\d{4}-\d{2}-\d{2}\]: .+ \| was: .+)$", ln)
            if m and int(m.group(1)) >= 1:
                other.add(int(m.group(1)))
                continue
            m = ACT_LINE_RE.match(ln)
            if not m:  # F44.11(e): inject an active line that lacks `| why:`; log its id
                lm = LOOSE_ACT_RE.match(ln)
                if lm and int(lm.group(1)) >= 1 and not re.match(r"^(SUPERSEDED by |RESOLVED \[)", lm.group(2)):
                    m = lm
                    if int(lm.group(1)) not in act and int(lm.group(1)) not in other:
                        nowhy.append(int(lm.group(1)))
            if m and int(m.group(1)) >= 1 and int(m.group(1)) not in act and int(m.group(1)) not in other:
                text = m.group(2)
                tm = re.match(r"^\[(rule|decision|task)\] (.*)$", text)
                act[int(m.group(1))] = {"id": int(m.group(1)), "kind": tm.group(1) if tm else "decision",
                                        "line": ln, "text": tm.group(2) if tm else text}
    if nowhy and PART == 1:  # one log line per entry, from the part-1 call only (parts 2-3 re-read the same file)
        for i in nowhy:
            if i in act:
                log_error(ValueError(f"active entry D{i} has no '| why:' (injected anyway)"))
    ents = sorted(act.values(), key=lambda e: (KIND_ORDER[e["kind"]], -e["id"]))
    return [e for e in ents if e["id"] not in other]


def index_line(e, width):
    t = " ".join(e["text"].split())
    return f"- D{e['id']} [{e['kind']}] " + (t[:width] + "\u2026" if len(t) > width else t)


def pack(full, idx, count_line, path):
    """Greedy whole-line packing of the stream (full-text lines, then the INDEX region) into <= MAX_PARTS parts of
    <= HARD_MAX chars. Returns the list of part texts or None when it does not fit."""
    stream = [("f", x) for x in full]
    if idx or count_line:
        stream.append(("m", "INDEX (active entries not shown in full above; same priority order):"))
        stream += [("i", x) for x in idx]
        if count_line:
            stream.append(("c", count_line))
    parts, k, pos = [], 1, 0
    while pos < len(stream) and k <= MAX_PARTS:
        in_idx = stream[pos][0] in ("m", "i", "c")
        head = ledger_part_head(k, path) + (index_note(path) if in_idx else "")
        out, used = [], len(head)
        while pos < len(stream):
            kind, x = stream[pos]
            if kind == "m" and not in_idx:  # the index starts in this part: its note must fit too
                need = len(index_note(path)) + len(x) + 1
                nxt = stream[pos + 1][1] if pos + 1 < len(stream) else ""
                if used + need + len(nxt) + 1 >= HARD_MAX:
                    break
                used += len(index_note(path))
                head += index_note(path)
                in_idx = True
            if used + len(x) + 1 >= HARD_MAX:
                break
            out.append(x)
            used += len(x) + 1
            pos += 1
        if not out:
            return None
        parts.append(head + "\n".join(out))
        k += 1
    return parts if pos >= len(stream) else None


def plan_ledger(ents, path):
    """F42.3: choose how many entries get full text (largest n whose layout fits with an index for the rest, index
    lines at 90 chars, else 50, else the oldest tasks and decisions dropped from the index, never rules). Rules
    keep full text first: n never drops below the rule count unless even that cannot fit."""
    N = len(ents)
    full_lines = [e["line"] for e in ents]
    nrules = sum(1 for e in ents if e["kind"] == "rule")
    for width in (90, 50):  # every standing rule keeps its full text while the index of the rest still fits
        idx_all = [index_line(e, width) for e in ents]
        for n in range(N, nrules - 1, -1):
            r = pack(full_lines[:n], idx_all[n:], "", path)
            if r is not None:
                return r
    idx_all = [index_line(e, 50) for e in ents]
    for n in range(min(nrules, N), -1, -1):
        rest = list(range(n, N))
        keep_floor = sum(1 for i in rest if ents[i]["kind"] == "rule")  # rules are never dropped
        lo, hi, best = 0, len(rest) - keep_floor, None  # d = number of oldest non-rule entries dropped
        while lo <= hi:
            mid = (lo + hi) // 2
            drop = set([i for i in reversed(rest) if ents[i]["kind"] != "rule"][:mid])
            kept = [idx_all[i] for i in rest if i not in drop]
            cl = f"- ({mid} more active entries not listed; read the full ledger)" if mid else ""
            r = pack(full_lines[:n], kept, cl, path)
            if r is not None:
                best, hi = r, mid - 1
            else:
                lo = mid + 1
        if best is not None:
            return best
    return []


def ledger_mode(lpart=1):
    """F39.8/F42.3: SessionStart (compact, startup, resume). Print part `lpart` (1-3) of the project's active
    decisions ledger (read-only, no claude); each part < 10,000 chars."""
    import hashlib, subprocess
    d = json.load(sys.stdin)
    cwd = d.get("cwd") if isinstance(d, dict) else None
    if not isinstance(cwd, str) or not cwd.strip():
        return
    root = cwd
    try:
        r = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and (r.stdout or "").strip():
            root = r.stdout.strip()
    except Exception:
        pass
    key = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(root.rstrip("/")))[:40] + "-" + \
        hashlib.sha1(root.encode("utf-8")).hexdigest()[:8]
    path = os.path.abspath(os.path.join(HANDOFFS_DIR, "projects", key, "decisions.md"))
    try:
        ents = parse_ledger_file(path)
    except FileNotFoundError:
        return  # no ledger for this project: nothing to say
    if not ents:
        return
    parts = plan_ledger(ents, path)
    if len(parts) >= lpart:
        emit(parts[lpart - 1])


RECOVER_CODES = ("handoff_missing", "no_health", "handoff_old")
RECOVERED_FIRST = ("HANDOFF RECOVERED: the pre-compaction hook did not run for this compaction; this handoff was "
                   "rebuilt from the transcript without a model summary. Use recall for detail.\n")


def precompact_script():
    for q in (os.path.join(os.path.dirname(os.path.abspath(__file__)), "precompact-handoff.py"),
              os.path.join(os.path.expanduser("~"), ".claude", "hooks", "precompact-handoff.py")):
        if os.path.isfile(q):
            return q
    return None


def fit_recovered(txt):
    """RECOVERED_FIRST + PREFIX + txt under HARD_MAX: drop whole sections other than the user's words from the end,
    then the oldest user lines (the newest are kept), then cut."""
    def total(t):
        return len(RECOVERED_FIRST) + len(PREFIX) + len(t)
    if total(txt) <= HARD_MAX:
        return txt
    first = re.search(r"(?m)^## ", txt)
    head = txt[:first.start()] if first else txt
    secs = [x for x in re.split(r"(?m)^(?=## )", txt[len(head):]) if x]

    def join():
        return head + "".join(secs)
    while total(join()) > HARD_MAX:
        idx = [i for i, x in enumerate(secs) if not x.startswith("## Last user messages")]
        if not idx:
            break
        del secs[idx[-1]]
    while total(join()) > HARD_MAX:
        ui = [i for i, x in enumerate(secs) if x.startswith("## Last user messages")]
        if not ui:
            break
        lines = secs[ui[0]].split("\n")
        body = [i for i, ln in enumerate(lines) if ln.startswith("- ")]
        if len(body) <= 1:
            break
        del lines[body[0]]
        secs[ui[0]] = "\n".join(lines)
    out = join()
    return out if total(out) <= HARD_MAX else out[: max(HARD_MAX - len(RECOVERED_FIRST) - len(PREFIX) - 1, 0)]


def write_json_atomic(path, obj):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def last_boundary_ts(path):
    """`timestamp` of the last compact_boundary record, read from the tail of the file (None if none)."""
    size = os.path.getsize(path)
    pos, buf = size, b""
    with open(path, "rb") as f:
        while pos > 0 and size - pos < 16 * 1024 * 1024:
            step = min(1 << 18, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + buf
            lines = buf.split(b"\n")
            for ln in reversed(lines[1:] if pos > 0 else lines):
                if b"compact_boundary" in ln:
                    try:
                        o = json.loads(ln)
                    except Exception:
                        continue
                    if isinstance(o, dict) and (o.get("subtype") == "compact_boundary" or o.get("type") == "compact_boundary"):
                        return o.get("timestamp") if isinstance(o.get("timestamp"), str) else None
    return None


def write_receipt(d, key, kind, text):
    """F47.a: append one line to <state>/receipts.jsonl for a handoff part 1 emitted. Never raises, never changes output."""
    try:
        import hashlib
        aid = d.get("agent_id")
        aid = aid.strip() if isinstance(aid, str) and aid.strip() else None
        psid = str(d.get("session_id") or "unknown").replace("/", "_")
        tp = d.get("transcript_path") if isinstance(d.get("transcript_path"), str) else ""
        if aid and tp and "/subagents/" not in tp:
            tp = os.path.join(os.path.dirname(tp), str(d.get("session_id")), "subagents", f"agent-{aid}.jsonl")
        try:
            bts = last_boundary_ts(tp) if tp else None
        except Exception:
            bts = None
        with open(os.path.join(HANDOFFS_DIR, f"{key}-latest.md"), "rb") as f:
            hsha = hashlib.sha256(f.read()).hexdigest()
        row = {"ts": utc_now(), "sid": psid[:8], "agent_id": aid, "key": key, "transcript": tp, "boundary_ts": bts,
               "kind": kind, "handoff_sha256": hsha, "part1_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
               "part1_head": text[:300]}
        with open(os.path.join(HANDOFFS_DIR, "receipts.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
    except BaseException as e:
        if not isinstance(e, KeyboardInterrupt):
            log_error(e)


def try_recover(d, sid):
    """F45.b: run `precompact-handoff.py --recover` with the same hook JSON (deadline 6 s). Returns the text to emit, or
    None after logging to hooks-error.jsonl (the caller then falls back to the DEGRADED text)."""
    try:
        import subprocess
        script = precompact_script()
        if not script:
            raise RuntimeError("precompact-handoff.py not found for recovery")
        r = subprocess.run([sys.executable, script, "--recover"], input=json.dumps(d), capture_output=True, text=True,
                           timeout=6)
        res = None
        for ln in reversed((r.stdout or "").splitlines()):
            try:
                res = json.loads(ln)
                break
            except Exception:
                continue
        if not isinstance(res, dict) or res.get("ok") is not True:
            raise RuntimeError("recovery failed: " + str((res or {}).get("error") or f"exit {r.returncode}")[:200])
        with open(os.path.join(HANDOFFS_DIR, f"{sid}-latest.md"), encoding="utf-8", errors="replace") as f:
            txt = f.read().strip()
        if not txt:
            raise RuntimeError("recovery wrote an empty handoff")
        return RECOVERED_FIRST + PREFIX + fit_recovered(txt)
    except BaseException as e:
        if isinstance(e, KeyboardInterrupt):
            raise
        log_error(e)
        return None


def _vers(path):
    try:
        m = re.search(r'(?m)^HOOK_VERSION = "([^"]*)"', open(path, encoding="utf-8", errors="replace").read())
        return m.group(1) if m else None
    except Exception:
        return None


def check_mode():
    """F45.d: one line `HANDOFF CHECK: ...` when the install is wrong, nothing when it is fine."""
    import hashlib
    home = os.path.expanduser("~")
    hooks_dir = os.path.join(home, ".claude", "hooks")
    problems = []
    try:
        with open(os.path.join(home, ".claude", "settings.json"), encoding="utf-8") as f:
            st = json.load(f)
        if not isinstance(st, dict):
            raise ValueError("not an object")
    except Exception:
        st = None
        problems.append("settings.json unreadable")
    managed = None  # F46.g: managed settings (system level) count as well as user settings
    try:
        mpath = (os.environ.get("HANDOFF_MANAGED_SETTINGS_PATH") or "").strip() or (
            "/Library/Application Support/ClaudeCode/managed-settings.json" if sys.platform == "darwin"
            else "/etc/claude-code/managed-settings.json")
        if os.path.isfile(mpath):
            with open(mpath, encoding="utf-8") as f:
                managed = json.load(f)
            if not isinstance(managed, dict):
                managed = None
    except Exception:
        managed = None
    if st is None and managed is not None and not os.path.exists(os.path.join(home, ".claude", "settings.json")):
        problems.clear()  # no user settings file at all, but the managed file is there: not a problem

    def runs(event, script, need_compact):
        for src in (st, managed):
            try:
                for g in (src.get("hooks") or {}).get(event) or []:
                    if need_compact and "compact" not in str(g.get("matcher") or ""):
                        continue
                    for h in g.get("hooks") or []:
                        if script in str(h.get("command") or ""):
                            return True
            except Exception:
                pass
        return False
    if st is not None or managed is not None:
        if not runs("PreCompact", "precompact-handoff.py", False):
            problems.append("no PreCompact hook runs precompact-handoff.py")
        if not runs("SessionStart", "postcompact-inject.py", True):
            problems.append("no SessionStart compact hook runs postcompact-inject.py")
    pre, post = os.path.join(hooks_dir, "precompact-handoff.py"), os.path.join(hooks_dir, "postcompact-inject.py")
    for fp in (pre, post):
        if not os.path.isfile(fp):
            problems.append(f"hook file missing: {os.path.basename(fp)}")
    if os.path.isfile(pre) and os.path.isfile(post):
        a, b = _vers(pre), _vers(post)
        if a != b:
            problems.append(f"version mismatch (precompact-handoff.py {a}, postcompact-inject.py {b})")
    try:
        mp = os.path.join(hooks_dir, ".handoff-manifest.json")
        if os.path.isfile(mp):
            with open(mp, encoding="utf-8") as f:
                files = (json.load(f) or {}).get("files") or {}
            for name, want in sorted(files.items()):
                fp = os.path.join(hooks_dir, name)
                if not os.path.isfile(fp):
                    if not any(name in x for x in problems):
                        problems.append(f"hook file missing: {name}")
                    continue
                with open(fp, "rb") as f:
                    if hashlib.sha256(f.read()).hexdigest() != want:
                        problems.append(f"{name} differs from the installed manifest")
    except Exception as e:
        log_error(e)
    rp = os.path.join(HANDOFFS_DIR, "reconcile.json")
    try:
        rj = read_json(rp)
        if rj:
            mi, kl = rj.get("missed_interactive") or 0, rj.get("killed") or 0
            if (mi > 0 or kl > 0) and str(rj.get("ts") or "") > str(rj.get("noticed_ts") or ""):
                problems.append(f"{mi if mi > 0 else kl} compactions without a handoff in the last "
                                f"{rj.get('days', 7)} days; see precompact-handoff.py --reconcile")
                rj["noticed_ts"] = utc_now()
                tmp = f"{rp}.tmp{os.getpid()}"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(rj, f)
                os.replace(tmp, rp)
    except Exception as e:
        log_error(e)
    try:  # F47.c: a proof run with failures, shown once
        prows = []
        with open(os.path.join(HANDOFFS_DIR, "proofs.jsonl"), encoding="utf-8", errors="replace") as f:
            for ln in f:
                try:
                    o = json.loads(ln)
                except Exception:
                    continue
                if isinstance(o, dict) and isinstance(o.get("ts"), str):
                    prows.append(o)
        if prows:
            newest = max(r["ts"] for r in prows)
            pnp = os.path.join(HANDOFFS_DIR, "proof-notice.json")
            pn = read_json(pnp) or {}
            if newest > str(pn.get("noticed_ts") or ""):
                nf = sum(1 for r in prows if r["ts"] == newest for v in (r.get("checks") or {}).values() if v == "fail")
                if nf > 0:
                    problems.append(f"proof failed: {nf} checks; see proof-report.md")
                write_json_atomic(pnp, {"noticed_ts": newest})
    except FileNotFoundError:
        pass
    except Exception as e:
        log_error(e)
    try:  # F48.d: failing or stale claims, shown once per change of the set
        cs = read_json(os.path.join(HANDOFFS_DIR, "claims-status.json"))
        if cs:
            bad = sorted(c.get("id") for c in (cs.get("claims") or []) if isinstance(c, dict) and c.get("status") in ("fail", "stale"))
            cnp = os.path.join(HANDOFFS_DIR, "claims-notice.json")
            cn = read_json(cnp) or {}
            if bad != (cn.get("set") if isinstance(cn.get("set"), list) else []):
                if bad:
                    problems.append(f"claims: {len(bad)} failing or stale; see claims-report.md")
                write_json_atomic(cnp, {"set": bad})
    except Exception as e:
        log_error(e)
    if problems:
        sys.stdout.write("HANDOFF CHECK: " + "; ".join(problems) + ". Run the installer again, then restart Claude Code.\n")


if "--check" in sys.argv[1:]:
    try:
        check_mode()
    except BaseException as _e:
        if not isinstance(_e, (SystemExit, KeyboardInterrupt)):
            log_error(_e)
    sys.exit(0)

if "--ledger" in sys.argv[1:]:
    if os.environ.get("HANDOFF_LEDGER") == "0":  # AC 100: ledger disabled, print nothing
        sys.exit(0)
    try:
        ledger_mode(PART)  # plain --ledger = --part 1 (F42.3)
    except BaseException as _e:
        log_error(_e)
    sys.exit(0)

try:
    d = json.load(sys.stdin)
    sid = d.get("session_id")
    sid = sid.replace("/", "_") if isinstance(sid, str) else ""  # same rule as precompact-handoff.py; non-string = silent
    _aid = d.get("agent_id")
    if sid and isinstance(_aid, str) and _aid.strip():  # F46.c: a subagent reads and writes only its own <sid>-a-<id> files
        sid = f"{sid}-a-{_aid.strip().replace('/', '_')}"
    _SID[0] = sid or "unknown"
    if sid:
        p = os.path.join(HANDOFFS_DIR, f"{sid}-latest.md")
        root = os.path.realpath(HANDOFFS_DIR)
        txt = ""
        if os.path.realpath(p).startswith(root + os.sep) and os.path.isfile(p):
            try:
                txt = open(p, encoding="utf-8", errors="replace").read().strip()
            except Exception:
                txt = ""
        plain = PREFIX + txt
        try:
            S = read_json(os.path.join(HANDOFFS_DIR, f"{sid}-last-health.json"))
            trig = S.get("trigger") if S else "unknown"
            # F45.b: parts run in parallel, so parts 2 and 3 decide from the state at their start
            if S and S.get("trigger") == "recovered" and age_ok_s(S.get("ts"), 60) and PART in (2, 3):
                raise SystemExit(0)
            need = not txt or S is None or not isinstance(S.get("ts"), str) or not age_ok(S["ts"])
            if need and PART in (2, 3):
                raise SystemExit(0)
            if need:
                rec = try_recover(d, sid)
                if rec is not None:
                    emit(rec)
                    write_receipt(d, sid, "recovered", rec)
                    raise SystemExit(0)
            if not txt:
                write_degraded(sid, ["handoff_missing"], trig)
                emit("HANDOFF DEGRADED: no handoff file for this session. "
                     "Read the transcript (see session metadata) before acting.")
            else:
                codes, errs = [], []
                if S is None or not isinstance(S.get("ts"), str):
                    codes = ["no_health"]
                else:
                    if S.get("degraded") is True:
                        codes = [c for c in (S.get("reasons") or []) if c in CODE_ORDER]
                        errs = S.get("errors") or []
                        if not codes:
                            codes = ["no_health"]
                    if not age_ok(S["ts"]):
                        codes.append("handoff_old")
                first = ("HANDOFF DEGRADED: " + warning_text(codes, errs)
                         + ". Verify the handoff against the transcript before acting.\n") if codes else ""
                if PART == 1 and codes:  # the warning and the degraded file belong to part 1
                    write_degraded(sid, codes, trig)
                outs = render(first, txt, os.path.abspath(p))
                if len(outs) >= PART:
                    emit(outs[PART - 1])
                    if PART == 1:
                        write_receipt(d, sid, "normal", outs[0])
        except SystemExit:
            raise
        except BaseException:
            if txt and PART == 1:
                emit(plain)  # last resort: section 6 behaviour (uncut)
except BaseException as _e:
    if not isinstance(_e, (SystemExit, KeyboardInterrupt)):
        log_error(_e)
sys.exit(0)
