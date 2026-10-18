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
PREFIX2 = "Pre-compaction handoff (auto-saved, part 2):\n"
PART = 2 if sys.argv[1:3] == ["--part", "2"] else 1  # no arg = part 1 (old installs keep working)
LIMIT = 10000   # additionalContext must stay under this (Claude Code spills larger values to a file)
INLINE_MAX = 9700  # F37.3: cut target, leaves room for the continuation line


def split_part1(first, txt, path):
    """F37.3: returns (inlined, rest). rest == "" when everything fits under LIMIT (no cut)."""
    head = first + PREFIX
    if len(head) + len(txt) < LIMIT:
        return txt, ""
    budget = _budget(len(head), path, True)
    heads = [m.start() for m in re.finditer(r"(?m)^## ", txt)]
    # the agent (or Haiku) section must lie wholly inside the inlined part
    need = 1
    am = re.search(r"(?m)^## (Agent handoff|Model-written handoff)", txt)
    if am:
        # the agent body has its own "## Goal" ... "## Exact next step" headings (F35.A); they are
        # part of the agent section, which ends at the first other heading
        inner = ("Goal", "Decisions and why", "Done", "In progress", "Dead ends", "Exact next step")
        nxt = [m.start() for m in re.finditer(r"(?m)^## (.+?)\s*$", txt)
               if m.start() > am.start() and m.group(1) not in inner]
        need = nxt[0] if nxt else len(txt) + 1
    fit = [h for h in heads if need <= h <= budget]
    if fit:
        cut = max(fit)  # last whole-section boundary that fits
    else:  # header + agent section do not fit: last line boundary that fits
        nl = txt.rfind("\n", 0, budget + 1)
        cut = nl + 1 if nl > 0 else max(budget, 0)
    inl = txt[:cut].rstrip("\n")
    return inl, txt[len(inl):]


HARD_MAX = 9900     # each part's total output (warning + header + content + continuation line) stays <= this
NAMES_MAX = 250     # the section-name list in a continuation line is cut to this many chars


def _line(rest_len, names, path, p1):
    where = f"part 2 below and in {path}" if p1 else path
    return f"[Handoff continues in {where}: {rest_len} more chars (sections: {names}). Read it before acting.]"


def _budget(head_len, path, p1):
    """Max chars of content that may be inlined: the continuation line is sized for its worst case
    (8-digit N, full-length names list) BEFORE content is fitted, so the total can never pass HARD_MAX."""
    worst = len(_line(99999999, "x" * (NAMES_MAX + 5), path, p1))
    return min(INLINE_MAX - head_len, HARD_MAX - head_len - 1 - worst)


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


def part1(first, txt, path):
    inl, rest = split_part1(first, txt, path)
    out = first + PREFIX + inl
    if rest:
        out += "\n" + _line(len(rest), names_of(rest), path, True)
    return out


def part2(first, txt, path):
    """F37.5: remaining content from the next whole section; None when nothing is left."""
    inl, rest = split_part1(first, txt, path)
    rest = rest.lstrip("\n")
    if not rest:
        return None
    if len(PREFIX2) + len(rest) < LIMIT:
        return PREFIX2 + rest.rstrip("\n")
    budget = _budget(len(PREFIX2), path, False)
    fit = [m.start() for m in re.finditer(r"(?m)^## ", rest) if 0 < m.start() <= budget]
    if fit:
        cut = max(fit)
    else:
        nl = rest.rfind("\n", 0, budget + 1)
        cut = nl + 1 if nl > 0 else max(budget, 0)
    inl2 = rest[:cut].rstrip("\n")
    left = rest[len(inl2):]
    return PREFIX2 + inl2 + "\n" + _line(len(left), names_of(left), path, False)


def emit(ctx):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}))


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
                ap = os.path.abspath(p)
                if PART == 2:  # part 2 only continues the content; the warning and the degraded file belong to part 1
                    o2 = part2(first, txt, ap)
                    if o2:
                        emit(o2)
                else:
                    if codes:
                        write_degraded(sid, codes, trig)
                    emit(part1(first, txt, ap))
        except SystemExit:
            raise
        except BaseException:
            if txt and PART == 1:
                emit(plain)  # last resort: section 6 behaviour (uncut)
except BaseException:
    pass
sys.exit(0)
