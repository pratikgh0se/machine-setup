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
    inner = ("Goal", "Decisions and why", "Done", "In progress", "Dead ends", "Exact next step")
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


def ledger_part_head(k, path):
    return (f"Project decisions for this repo (part {k} of the ledger; newest first; full ledger: {path}). "
            "Standing unless the user says otherwise:\n")


def emit_ledger_part(k, lines, path):
    """F39.10: parts are filled with whole lines, newest first; part 2 continues where part 1 stopped;
    entries left after part 2 are summarised by one final line. Total per part stays < LIMIT."""
    def fill(head, rest, reserve):
        out, used = [], len(head)
        for x in rest:
            if used + len(x) + 1 + reserve >= LIMIT:
                break
            out.append(x)
            used += len(x) + 1
        return out
    rest = lines
    out1 = fill(ledger_part_head(1, path), rest, 0)
    rest2 = rest[len(out1):]
    if k == 1:
        if out1:
            emit(ledger_part_head(1, path) + "\n".join(out1))
        return
    if not rest2:
        return
    head = ledger_part_head(2, path)
    out2 = fill(head, rest2, 0)
    if len(out2) < len(rest2):  # entries remain: leave room for the final summary line
        n = len(rest2)
        out2 = fill(head, rest2, len("- (%d older active decisions in the full ledger; read it before acting on anything older)" % n) + 1)
        out2.append("- (%d older active decisions in the full ledger; read it before acting on anything older)" % (n - len(out2)))
    emit(head + "\n".join(out2))


def ledger_mode(lpart=None):
    """F39.8: SessionStart startup/resume. Print the project's active decisions (read-only, no claude).
    F39.10: with lpart 1|2 (compact), print that part of the whole ledger instead (each part < 10,000 chars)."""
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
    act, sup = {}, set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for ln in f.read().splitlines():
            ln = ln.strip()
            m = re.match(r"^- D(\d+) \[\d{4}-\d{2}-\d{2}\] (SUPERSEDED by D\d+ \[\d{4}-\d{2}-\d{2}\]: .+ \| because: .+|.+ \| why: .+)$", ln)
            if m and int(m.group(1)) >= 1 and int(m.group(1)) not in act and int(m.group(1)) not in sup:
                (sup.add(int(m.group(1))) if m.group(2).startswith("SUPERSEDED by D") else act.__setitem__(int(m.group(1)), ln))
    lines = [act[i] for i in sorted(act, reverse=True)]
    if not lines:
        return
    if lpart:
        emit_ledger_part(lpart, lines, path)
        return
    if sum(len(x) + 1 for x in lines) > 4000:  # same whole-line cut as the handoff section (F39.4)
        room = 4000 - len("- (999 older active decisions in the full ledger)") - 1
        out, used = [], 0
        for x in lines:
            if used + len(x) + 1 > room:
                break
            out.append(x)
            used += len(x) + 1
        lines = out + [f"- ({len(act) - len(out)} older active decisions in the full ledger)"]
    emit("Project decisions from earlier sessions in this repo (newest first; full ledger: " + path
         + "). Treat them as standing unless the user says otherwise:\n" + "\n".join(lines))


if "--ledger" in sys.argv[1:]:
    if os.environ.get("HANDOFF_LEDGER") == "0":  # AC 100: ledger disabled, print nothing
        sys.exit(0)
    try:
        ledger_mode(PART if "--part" in sys.argv[1:] and PART in (1, 2) else None)
    except BaseException:
        pass
    sys.exit(0)

try:
    d = json.load(sys.stdin)
    sid = d.get("session_id")
    sid = sid.replace("/", "_") if isinstance(sid, str) else ""  # same rule as precompact-handoff.py; non-string = silent
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
            if not txt:
                if PART == 2:
                    raise SystemExit(0)
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
        except SystemExit:
            raise
        except BaseException:
            if txt and PART == 1:
                emit(plain)  # last resort: section 6 behaviour (uncut)
except BaseException:
    pass
sys.exit(0)
