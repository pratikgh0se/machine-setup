#!/usr/bin/env python3
"""recall.py (F44): search this project's earlier Claude Code chats word for word.

Read-only over ~/.claude/projects/*/<sid>.jsonl, except its own cache <state>/recall-index.json.
Subcommands: search, open, user, handoffs. Python 3 stdlib only; uses `rg` as a prefilter when on
PATH (same output as the pure-Python scan).
"""
import argparse
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys

HOME = os.path.expanduser("~")
STATE_DIR = (os.environ.get("HANDOFF_STATE_DIR") or "").strip() or os.path.join(HOME, ".local", "state", "claude-handoffs")
PROJECTS_DIR = os.path.join(HOME, ".claude", "projects")
INDEX_FILE = os.path.join(STATE_DIR, "recall-index.json")

OUT_CAP = 12000
CUT_MARK = "[output cut at 12,000 chars; narrow the search]"

REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
WRAPPER_PREFIXES = ("<task-notification", "[SYSTEM NOTIFICATION", "<command-name", "<local-command",
                    "<command-message", "<command-args", "Caveat:", "<artifact-content-authored-by-others",
                    "<bash-input>", "<bash-stdout>", "<bash-stderr>", "This session is being continued")

SECRET_RES = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[abp]-[A-Za-z0-9-]{10,}"),
]
KV_RE = re.compile(r"(?:password|token|secret)=(\S+)", re.I)  # group 1 = the value
MARK = "[redacted]"


class UsageError(Exception):
    pass


# ---------------------------------------------------------------- helpers

def fmt_ts(ts):
    """ISO timestamp (UTC, as stored) -> 'YYYY-MM-DD HH:MM'."""
    if isinstance(ts, str) and len(ts) >= 16 and ts[10] in "T ":
        return ts[:10] + " " + ts[11:16]
    return "????-??-?? ??:??"


def project_root(cwd):
    """F39.1: git toplevel of cwd (5 s timeout), else cwd itself."""
    try:
        r = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, timeout=5)
        out = (r.stdout or "").strip()
        if r.returncode == 0 and out:
            return out
    except Exception:
        pass
    return cwd


def inside(path, root_real):
    p = os.path.realpath(path)
    return p == root_real or p.startswith(root_real.rstrip(os.sep) + os.sep)


def secret_spans(text):
    spans = []
    for rx in SECRET_RES:
        spans += [m.span() for m in rx.finditer(text)]
    spans += [m.span(1) for m in KV_RE.finditer(text)]
    spans.sort()
    merged = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def redact(text):
    spans = secret_spans(text)
    if not spans:
        return text
    out, pos = [], 0
    for s, e in spans:
        out.append(text[pos:s])
        out.append(MARK)
        pos = e
    out.append(text[pos:])
    return "".join(out)


def redacted_snippet(text, s, e, ctx=120):
    """Redact the whole text first (matching ran on the raw text), then cut the window around the
    match mapped into the redacted text, so a secret split by the window edge never leaks."""
    spans = secret_spans(text)
    if not spans:
        red, ns, ne = text, s, e
    else:
        def pos(i, end_side):
            delta = 0
            for a, b in spans:
                if b <= i:
                    delta += len(MARK) - (b - a)
                elif a < i < b:
                    return a + delta + (len(MARK) if end_side else 0)
                else:
                    break
            return i + delta
        red = redact(text)
        ns, ne = pos(s, False), pos(e, True)
    snip = red[max(0, ns - ctx):ne + ctx]
    return re.sub(r"\r?\n", " / ", snip)


# ---------------------------------------------------------------- transcripts

def strip_reminders(t):
    return REMINDER_RE.sub("", t).strip()


def typed_ok(t):
    t = t.strip()
    if not t:
        return False
    return not t.startswith(WRAPPER_PREFIXES)


def result_text(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and isinstance(b.get("text"), str))
    return ""


def segments(rec):
    """F44.3: record -> list of (role, text); role in user|assistant|tool."""
    typ = rec.get("type")
    if typ not in ("user", "assistant"):
        return []
    msg = rec.get("message")
    if not isinstance(msg, dict):
        return []
    c = msg.get("content")
    out = []
    if typ == "user":
        if rec.get("isMeta") or rec.get("isCompactSummary"):
            return []
        typed, tools = [], []
        if isinstance(c, str):
            typed.append(c)
        elif isinstance(c, list):
            for b in c:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and isinstance(b.get("text"), str):
                    typed.append(b["text"])
                elif b.get("type") == "tool_result":
                    tools.append(result_text(b.get("content")))
        t = strip_reminders("\n".join(typed))
        if typed_ok(t):
            out.append(("user", t))
        for x in tools:
            x = strip_reminders(x)
            if x:
                out.append(("tool", x))
        return out
    # assistant
    texts, tools = [], []
    if isinstance(c, str):
        texts.append(c)
    elif isinstance(c, list):
        for b in c:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and isinstance(b.get("text"), str):
                texts.append(b["text"])
            elif b.get("type") == "tool_use":
                inp = b.get("input")
                try:
                    s = json.dumps(inp, ensure_ascii=False) if not isinstance(inp, str) else inp
                except Exception:
                    s = str(inp)
                tools.append("%s %s" % (b.get("name") or "tool", s))
    t = strip_reminders("\n".join(texts))
    if t:
        out.append(("assistant", t))
    for x in tools:
        out.append(("tool", x))
    return out


def parse_line(line):
    try:
        d = json.loads(line)
    except Exception:
        return None
    return d if isinstance(d, dict) else None


class Transcript:
    def __init__(self, path, sub):
        self.path = path
        self.sub = sub
        stem = os.path.basename(path)[:-len(".jsonl")]
        if sub and stem.startswith("agent-"):
            stem = stem[len("agent-"):]
        self.sid = stem
        self.sid8 = stem[:8]
        try:
            self.mtime = os.stat(path).st_mtime
        except OSError:
            self.mtime = 0

    def records(self, want=None):
        """Yield (lineno, rec) for parseable records; `want`: optional set of line numbers."""
        try:
            f = open(self.path, encoding="utf-8", errors="replace")
        except OSError:
            return
        with f:
            for n, line in enumerate(f, 1):
                if want is not None and n not in want:
                    continue
                rec = parse_line(line)
                if rec is not None:
                    yield n, rec

    def visible(self, rec, include_sub):
        if rec.get("isSidechain") and not (include_sub or self.sub):
            return False
        return True


# ---------------------------------------------------------------- scoping + cache

def load_index():
    try:
        with open(INDEX_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_index(idx):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = INDEX_FILE + ".%d.tmp" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(idx, f)
        os.replace(tmp, INDEX_FILE)
    except Exception:
        pass


def first_cwd(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                if n > 3000:
                    break
                if '"cwd"' not in line:
                    continue
                rec = parse_line(line)
                if rec and isinstance(rec.get("cwd"), str) and rec["cwd"]:
                    return rec["cwd"]
    except OSError:
        pass
    return ""


def in_scope_transcripts(root, include_sub):
    root_real = os.path.realpath(root)
    idx = load_index()
    dirty = False
    files = [(p, False) for p in glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl"))]
    if include_sub:
        files += [(p, True) for p in glob.glob(os.path.join(PROJECTS_DIR, "*", "*", "subagents", "*.jsonl"))]
    res = []
    for p, sub in files:
        try:
            st = os.stat(p)
        except OSError:
            continue
        ent = idx.get(p)
        if not (isinstance(ent, dict) and ent.get("mtime") == st.st_mtime and ent.get("size") == st.st_size):
            ent = {"mtime": st.st_mtime, "size": st.st_size, "cwd": first_cwd(p)}
            idx[p] = ent
            dirty = True
        cwd = ent.get("cwd")
        if cwd and inside(cwd, root_real):
            res.append(Transcript(p, sub))
    if dirty:
        for k in [k for k in idx if not os.path.exists(k)]:
            del idx[k]
        save_index(idx)
    return res


def select_session(ts, sess):
    if not sess or sess == "all":
        return ts
    return [t for t in ts if t.sid.startswith(sess) or t.sid8.startswith(sess[:8])]


# ---------------------------------------------------------------- search

SAFE_RE = re.compile(r"^[A-Za-z0-9_ @:/=,|()?*+.#%&'<>!~;-]+$")
SAFE_FIXED_RE = re.compile(r"^[\x20\x21\x23-\x5b\x5d-\x7e]+$")  # printable ASCII except " and \
DOT_REPL = r"(?:\\u[0-9a-fA-F]{4}(?:\\u[0-9a-fA-F]{4})?|\\.|.)"


def rg_candidates(files, pattern, fixed):
    """Return {path: set(lineno)} of lines rg thinks may match, or None to use the full scan."""
    rg = shutil.which("rg")
    if not rg or not files:
        return None
    if fixed:
        if not SAFE_FIXED_RE.match(pattern):
            return None
        args = ["-F", "-e", pattern]
    else:
        if not SAFE_RE.match(pattern):
            return None
        args = ["-e", pattern.replace(".", DOT_REPL)]
    hits = {}
    paths = [t.path for t in files]
    for i in range(0, len(paths), 400):
        chunk = paths[i:i + 400]
        try:
            r = subprocess.run([rg, "-i", "-n", "--no-heading", "--with-filename", "--no-messages",
                                "--max-columns", "0"] + args + ["--"] + chunk,
                               capture_output=True, timeout=300)
        except Exception:
            return None
        if r.returncode > 1:
            return None
        # stdout lines: path:lineno:content (content may be huge; we only need the head)
        for raw in r.stdout.split(b"\n"):
            if not raw:
                continue
            m = re.match(rb"(.+?\.jsonl):(\d+):", raw)
            if m:
                hits.setdefault(m.group(1).decode("utf-8", "replace"), set()).add(int(m.group(2)))
    return hits


def cmd_search(a, root):
    try:
        rx = re.compile(re.escape(a.pattern) if a.fixed else a.pattern, re.I)
    except re.error as e:
        raise UsageError("bad pattern: %s" % e)
    limit = max(1, min(a.limit, 100))
    ts = select_session(in_scope_transcripts(root, a.subagents), a.session)
    cand = rg_candidates(ts, a.pattern, a.fixed)
    hits = []  # (ts, path, line, sid8, role, snippet)
    for t in ts:
        want = None
        if cand is not None:
            want = cand.get(t.path)
            if not want:
                continue
        for n, rec in t.records(want):
            if not t.visible(rec, a.subagents):
                continue
            for role, text in segments(rec):
                if a.role != "any" and role != a.role:
                    continue
                m = rx.search(text)
                if not m:
                    continue
                hits.append((rec.get("timestamp") or "", t.path, n, t.sid8, role,
                             redacted_snippet(text, m.start(), m.end()), t))
    # newest first
    hits.sort(key=lambda h: (h[0], h[1], h[2]), reverse=True)
    seen, shown = set(), []
    uniq = []
    for h in hits:  # one hit per (message line, role)
        k = (h[1], h[2], h[4])
        if k not in seen:
            seen.add(k)
            uniq.append(h)
    lines = []
    for h in uniq[:limit]:
        lines.append("%s:%d %s %s: %s" % (h[3], h[2], fmt_ts(h[0]), h[4], h[5]))
    lines.append("%d hits shown of %d (%d sessions searched)" % (min(limit, len(uniq)), len(uniq), len(ts)))
    return lines


# ---------------------------------------------------------------- open / user

def cap_body(text, full):
    cap = 40000 if full else 4000
    if len(text) <= cap:
        return text
    return text[:cap] + "\n[cut: %d more chars]" % (len(text) - cap)


def rec_message(rec):
    segs = segments(rec)
    if not segs:
        return None
    role = segs[0][0]
    parts = []
    for i, (r, t) in enumerate(segs):
        parts.append(t if i == 0 or r == role and r != "tool" else "[%s] %s" % (r, t))
    return role, "\n".join(parts)


def heading(t, n, rec, role):
    return "--- %s:%d %s %s" % (t.sid8, n, fmt_ts(rec.get("timestamp")), role)


def cmd_open(a, root):
    m = re.match(r"^([A-Za-z0-9_-]+):(\d+)$", a.id)
    if not m:
        raise UsageError("id must look like <sid8>:<line>")
    sid, line = m.group(1), int(m.group(2))
    if a.around < 0:
        raise UsageError("--around must be >= 0")
    around = min(a.around, 10)
    ts = in_scope_transcripts(root, True)
    # prefer main transcripts over subagent ones for the same prefix
    match = [t for t in ts if t.sid.startswith(sid)]
    mains = [t for t in match if not t.sub]
    match = mains or match
    if len(match) != 1:
        raise UsageError("unknown or ambiguous session id %s" % sid)
    t = match[0]
    msgs = []  # (lineno, rec, role, text)
    for n, rec in t.records():
        mm = rec_message(rec) if t.visible(rec, True) else None
        if mm:
            msgs.append((n, rec, mm[0], mm[1]))
    pos = next((i for i, x in enumerate(msgs) if x[0] == line), None)
    if pos is None:
        raise UsageError("no message at %s:%d" % (sid, line))
    out = []
    for n, rec, role, text in msgs[max(0, pos - around):pos + around + 1]:
        out.append(heading(t, n, rec, role))
        out.append(cap_body(redact(text), a.full))
    return out


def cmd_user(a, root):
    n_last = a.last
    if n_last < 1:
        raise UsageError("--last must be >= 1")
    n_last = min(n_last, 200)
    ts = select_session(in_scope_transcripts(root, False), a.session)
    ts.sort(key=lambda t: t.mtime, reverse=True)
    found = []  # (timestamp, path, line, transcript, rec, text)
    for t in ts:
        if len(found) >= n_last:
            kth = sorted((f[0] for f in found), reverse=True)[n_last - 1]
            iso = datetime.datetime.fromtimestamp(t.mtime, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
            if kth and iso < kth[:19]:  # nothing in this or later (older) files can beat the kth newest
                break
        try:
            f = open(t.path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with f:
            for n, line in enumerate(f, 1):
                if '"user"' not in line:
                    continue
                rec = parse_line(line)
                if not rec or rec.get("type") != "user" or not t.visible(rec, False):
                    continue
                for role, text in segments(rec):
                    if role == "user":
                        found.append((rec.get("timestamp") or "", t.path, n, t, rec, text))
    found.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)
    out = []
    for ts_, _p, n, t, rec, text in found[:n_last]:
        out.append(heading(t, n, rec, "user"))
        out.append(cap_body(redact(text), False))
    return out


# ---------------------------------------------------------------- handoffs

def cmd_handoffs(a, root):
    root_real = os.path.realpath(root)
    rows = []
    for p in glob.glob(os.path.join(STATE_DIR, "*.md")):
        base = os.path.basename(p)
        if not (base.endswith("-latest.md") or base.endswith("-agent.md")
                or re.search(r"-\d{8}T\d{6}Z\.md$", base)):
            continue
        cwd = None
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                for i, line in enumerate(f):
                    if i > 40:
                        break
                    if line.startswith("- cwd:"):
                        cwd = line[len("- cwd:"):].strip()
                        break
            st = os.stat(p)
        except OSError:
            continue
        if cwd and inside(cwd, root_real):
            rows.append((st.st_mtime, p, st.st_size))
    rows.sort(reverse=True)
    return ["%s %s %d" % (datetime.datetime.fromtimestamp(m, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M"), p, s)
            for m, p, s in rows]


# ---------------------------------------------------------------- main

class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError(message)


def build_parser():
    ap = Parser(prog="recall.py", description="Search this project's earlier chats word for word.")
    sub = ap.add_subparsers(dest="cmd")
    sub.required = True

    def common(p):
        p.add_argument("--cwd", default=None)

    p = sub.add_parser("search")
    p.add_argument("pattern")
    p.add_argument("--fixed", action="store_true")
    p.add_argument("--role", choices=["user", "assistant", "tool", "any"], default="any")
    p.add_argument("--session", default="all")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--subagents", action="store_true")
    common(p)
    p = sub.add_parser("open")
    p.add_argument("id")
    p.add_argument("--around", type=int, default=2)
    p.add_argument("--full", action="store_true")
    common(p)
    p = sub.add_parser("user")
    p.add_argument("--last", type=int, default=20)
    p.add_argument("--session", default="all")
    common(p)
    p = sub.add_parser("handoffs")
    common(p)
    return ap


def emit(lines):
    text = "\n".join(lines)
    if len(text) > OUT_CAP:
        text = text[:OUT_CAP] + "\n" + CUT_MARK
    sys.stdout.write(text + ("\n" if text else ""))


def main(argv):
    try:
        a = build_parser().parse_args(argv)
        cwd = os.path.expanduser(a.cwd) if a.cwd else os.getcwd()
        root = project_root(cwd)
        fn = {"search": cmd_search, "open": cmd_open, "user": cmd_user, "handoffs": cmd_handoffs}[a.cmd]
        emit(fn(a, root))
        return 0
    except UsageError as e:
        sys.stderr.write("recall.py: %s\n" % e)
        return 2
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit(130)
