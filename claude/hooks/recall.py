#!/usr/bin/env python3
"""recall.py (F44): search this project's earlier Claude Code chats word for word.

Read-only over ~/.claude/projects/*/<sid>.jsonl, except its own cache <state>/recall-index.json.
Subcommands: search, open, user, handoffs. Python 3 stdlib only; uses `rg` as a prefilter when on
PATH (same output as the pure-Python scan).
"""
import argparse
import array
import datetime
import fcntl
import glob
import hashlib
import json
import math
import operator
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
STATE_DIR = (os.environ.get("HANDOFF_STATE_DIR") or "").strip() or os.path.join(HOME, ".local", "state", "claude-handoffs")
PROJECTS_DIR = os.path.join(HOME, ".claude", "projects")
INDEX_FILE = os.path.join(STATE_DIR, "recall-index.json")

OUT_CAP = 12000
CHUNK_MAX, MIN_CHUNK, BATCH, MEANING_TOP = 1500, 20, 32, 50
QUERY_TIMEOUT, INDEX_TIMEOUT = 30, 60  # F44.12(b): cold model load needs > 5 s
CUT_MARK = "[output cut at 12,000 chars; narrow the search]"
OPEN_FULL_CAP = 45000  # F44.12(a): total stdout cap for `open --full`
MSG_CAP_FULL = 40000

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


def keyword_hits(a, ts, rx, pattern, fixed):
    """F44.1 keyword hits, newest first, one per (message line, role). Each: dict."""
    cand = rg_candidates(ts, pattern, fixed)
    hits = []
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
                hits.append({"ts": rec.get("timestamp") or "", "path": t.path, "line": n, "sid8": t.sid8,
                             "sid": t.sid, "role": role, "tag": "word",
                             "snippet": redacted_snippet(text, m.start(), m.end())})
    hits.sort(key=lambda h: (h["ts"], h["path"], h["line"]), reverse=True)
    seen, uniq = set(), []
    for h in hits:
        k = (h["path"], h["line"], h["role"])
        if k not in seen:
            seen.add(k)
            uniq.append(h)
    return uniq


def fmt_hit(h):
    return "%s:%d %s %s [%s]: %s" % (h["sid8"], h["line"], fmt_ts(h["ts"]), h["role"], h["tag"], h["snippet"])


def cmd_search(a, root):
    limit = max(1, min(a.limit, 100))
    if a.keyword and a.meaning:
        raise UsageError("--keyword and --meaning are exclusive")
    fixed = a.fixed
    pattern = a.pattern
    try:
        rx = re.compile(re.escape(pattern) if fixed else pattern, re.I)
    except re.error as e:
        if a.keyword:
            raise UsageError("bad pattern: %s" % e)
        fixed = True  # F44.9: not a valid regex -> fixed string for the keyword part
        rx = re.compile(re.escape(pattern), re.I)
    ts = select_session(in_scope_transcripts(root, a.subagents), a.session)

    mode_line, mhits, off_reason = None, [], None
    if a.keyword:
        off_reason = "--keyword"
    elif a.role not in ("any", "user", "assistant"):
        off_reason = "role %s is not indexed" % a.role
    else:
        mhits, mode_line, off_reason = meaning_hits(a, root, ts)
    if off_reason is not None:
        mode_line = "mode: keyword only (meaning search off: %s)" % off_reason

    if a.meaning and not off_reason:
        kw = []
    else:
        kw = keyword_hits(a, ts, rx, pattern, fixed)
        if not a.keyword and not off_reason:
            kw = kw[:200]

    if off_reason is not None:
        merged = kw
    else:
        merged = rrf_merge(kw, mhits)
    shown = merged[:limit]
    fill_meaning_snippets(shown, ts)
    lines = [mode_line]
    lines += [fmt_hit(h) for h in shown]
    lines.append("%d hits shown of %d (%d sessions searched)" % (len(shown), len(merged), len(ts)))
    return lines


# ---------------------------------------------------------------- meaning search (F44.9)

def embed_cfg():
    return {
        "url": (os.environ.get("RECALL_EMBED_URL") or "http://localhost:11434").rstrip("/"),
        "model": os.environ.get("RECALL_EMBED_MODEL") or "bge-m3",
        "backend": (os.environ.get("RECALL_EMBED_BACKEND") or "ollama").lower(),
        "key": os.environ.get("RECALL_EMBED_KEY") or "",
    }


def embed(texts, timeout):
    """-> list of unit-normalised array('f'). Raises RuntimeError with a short reason."""
    cfg = embed_cfg()
    if cfg["backend"] == "openai":
        url = cfg["url"] + "/v1/embeddings"
    else:
        url = cfg["url"] + "/api/embed"
    headers = {"Content-Type": "application/json"}
    if cfg["backend"] == "openai" and cfg["key"]:
        headers["Authorization"] = "Bearer " + cfg["key"]
    payload = {"model": cfg["model"], "input": texts}
    if cfg["backend"] != "openai":
        payload["keep_alive"] = "30m"  # F44.12(b): keep the model loaded between calls
    body = json.dumps(payload).encode("utf-8")
    try:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError("embedding backend HTTP %s" % e.code)
    except Exception as e:
        reason = getattr(e, "reason", None) or e
        raise RuntimeError("embedding backend unreachable (%s)" % str(reason)[:120])
    try:
        if cfg["backend"] == "openai":
            vecs = [x["embedding"] for x in d["data"]]
        else:
            vecs = d["embeddings"]
        if len(vecs) != len(texts):
            raise ValueError("count")
        out = []
        for v in vecs:
            arr = array.array("f", v)
            norm = math.sqrt(sum(x * x for x in arr)) or 1.0
            out.append(array.array("f", (x / norm for x in arr)))
        return out
    except Exception:
        raise RuntimeError("embedding backend returned an unexpected reply")


def project_key(root):
    base = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(root.rstrip("/")))[:40]
    return base + "-" + hashlib.sha1(root.encode("utf-8")).hexdigest()[:8]


def index_paths(root):
    d = os.path.join(STATE_DIR, "recall")
    k = project_key(root)
    return d, os.path.join(d, k + ".sqlite"), os.path.join(d, k + ".lock")


def open_db(path, create):
    db = sqlite3.connect(path, timeout=30)
    if create:
        db.executescript(
            "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);"
            "CREATE TABLE IF NOT EXISTS files(sid TEXT PRIMARY KEY, path TEXT, off INTEGER, lines INTEGER, msgs INTEGER);"
            "CREATE TABLE IF NOT EXISTS chunks(sid TEXT, line INTEGER, chunk INTEGER, ts TEXT, role TEXT, vec BLOB,"
            " PRIMARY KEY(sid, line, chunk));")
    return db


def chunk_text(text, size=CHUNK_MAX):
    """Split on paragraph, then sentence boundaries, into pieces of at most `size` chars."""
    text = text.strip()
    if len(text) <= size:
        return [text] if text else []
    pieces = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= size:
            pieces.append(para)
            continue
        for sent in re.split(r"(?<=[.!?])\s+", para):
            while len(sent) > size:
                pieces.append(sent[:size])
                sent = sent[size:]
            if sent.strip():
                pieces.append(sent.strip())
    out, cur = [], ""
    for p in pieces:
        if cur and len(cur) + 2 + len(p) > size:
            out.append(cur)
            cur = p
        else:
            cur = (cur + "\n\n" + p) if cur else p
    if cur:
        out.append(cur)
    return out


def message_chunks(rec):
    """-> list of (role, chunk_text) for the indexed units of one record (user/assistant text only)."""
    out = []
    for role, text in segments(rec):
        if role not in ("user", "assistant"):
            continue
        for c in chunk_text(redact(text)):
            if len(c) >= MIN_CHUNK:
                out.append((role, c))
    return out


def meaning_hits(a, root, ts):
    """-> (hits, mode_line, off_reason). hits: list of dicts ranked best first (top 50 chunks, one per message)."""
    cfg = embed_cfg()
    _d, dbp, _l = index_paths(root)
    if not os.path.exists(dbp):
        return [], None, "no meaning index yet (run: recall.py index)"
    try:
        db = open_db(dbp, False)
        meta = dict(db.execute("SELECT k, v FROM meta").fetchall())
        if meta.get("model") != cfg["model"] or not meta.get("dim"):
            return [], None, "index was built with model %s, not %s" % (meta.get("model"), cfg["model"])
        dim = int(meta["dim"])
        i = db.execute("SELECT COUNT(DISTINCT sid || ':' || line) FROM chunks").fetchone()[0]
        if not i:
            return [], None, "meaning index is empty (run: recall.py index)"
        known, off_sum, size_sum = 0, 0, 0
        frows = {r[0]: r for r in db.execute("SELECT sid, path, off, lines, msgs FROM files")}
    except sqlite3.Error as e:
        return [], None, "meaning index unreadable (%s)" % str(e)[:80]
    try:
        q = embed([a.pattern], QUERY_TIMEOUT)[0]
    except RuntimeError as e:
        return [], None, str(e)
    if len(q) != dim:
        return [], None, "query vector size %d differs from index size %d" % (len(q), dim)

    by_sid = {t.sid: t for t in ts if not t.sub}
    # coverage: indexed vs known messages, plus an estimate for bytes not yet scanned
    known = sum(r[4] or 0 for sid, r in frows.items() if sid in by_sid)
    done_bytes = sum(r[2] or 0 for sid, r in frows.items() if sid in by_sid)
    todo_bytes = 0
    for sid, t in by_sid.items():
        try:
            size = os.stat(t.path).st_size
        except OSError:
            continue
        todo_bytes += max(0, size - ((frows.get(sid) or (0, 0, 0))[2] or 0))
    est = int(known * todo_bytes / done_bytes) if done_bytes and todo_bytes else 0
    n = max(known + est, i)

    sql = "SELECT sid, line, chunk, ts, role, vec FROM chunks"
    params = []
    if a.role in ("user", "assistant"):
        sql += " WHERE role = ?"
        params.append(a.role)
    dot = getattr(math, "sumprod", None)
    scored = []
    cur = db.execute(sql, params)
    while True:
        rows = cur.fetchmany(2000)
        if not rows:
            break
        for sid, line, chunk, ts_, role, blob in rows:
            if sid not in by_sid:
                continue
            v = array.array("f")
            v.frombytes(blob)
            if len(v) != dim:
                continue
            s = dot(q, v) if dot else sum(map(operator.mul, q, v))
            scored.append((s, sid, line, chunk, ts_, role))
    db.close()
    scored.sort(key=lambda x: x[0], reverse=True)
    hits, seen = [], set()
    for s, sid, line, chunk, ts_, role in scored[:MEANING_TOP]:
        k = (sid, line, role)
        if k in seen:
            continue
        seen.add(k)
        t = by_sid[sid]
        hits.append({"ts": ts_ or "", "path": t.path, "line": line, "sid8": t.sid8, "sid": sid, "role": role,
                     "tag": "meaning", "chunk": chunk, "snippet": None})
    mode = "mode: hybrid (meaning index covers %d of %d messages)" % (i, n)
    return hits, mode, None


def rrf_merge(kw, mh, k=60):
    """Reciprocal-rank fusion, equal weights; a message found both ways counts once ([both])."""
    scores, items = {}, {}
    for rank, h in enumerate(kw):
        key = (h["path"], h["line"], h["role"])
        scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank + 1)
        items[key] = dict(h)
    for rank, h in enumerate(mh):
        key = (h["path"], h["line"], h["role"])
        scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank + 1)
        if key in items:
            items[key]["tag"] = "both"
        else:
            items[key] = dict(h)
    order = sorted(items, key=lambda x: (scores[x], items[x]["ts"], x[0], x[1]), reverse=True)
    return [items[x] for x in order]


def fill_meaning_snippets(shown, ts):
    """Meaning-only hits carry no text yet: re-read the transcript line and take the matched chunk."""
    need = {}
    for h in shown:
        if h.get("snippet") is None:
            need.setdefault(h["path"], {})[h["line"]] = h
    for t in ts:
        m = need.get(t.path)
        if not m:
            continue
        for n, rec in t.records(set(m)):
            h = m[n]
            chunks = [c for r, c in message_chunks(rec) if r == h["role"]]
            c = chunks[h["chunk"]] if h.get("chunk", 0) < len(chunks) else (chunks[0] if chunks else "")
            h["snippet"] = re.sub(r"\r?\n", " / ", c[:240])
    for h in shown:
        if h.get("snippet") is None:
            h["snippet"] = "(message no longer readable)"


# ---------------------------------------------------------------- index (F44.9)

def cmd_index(a, root):
    t0 = time.time()
    deadline = t0 + a.max_seconds if a.max_seconds else None
    d, dbp, lockp = index_paths(root)
    os.makedirs(d, exist_ok=True)
    lockf = open(lockp, "a+")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return ["index busy"]
    cfg = embed_cfg()
    db = open_db(dbp, True)
    meta = dict(db.execute("SELECT k, v FROM meta").fetchall())
    if meta.get("model") != cfg["model"] and meta:
        db.executescript("DELETE FROM chunks; DELETE FROM files; DELETE FROM meta;")
        db.commit()
        meta = {}
    dim = int(meta["dim"]) if meta.get("dim") else None
    ts = [t for t in in_scope_transcripts(root, False) if not t.sub]
    ts.sort(key=lambda t: t.mtime, reverse=True)
    frows = {r[0]: r for r in db.execute("SELECT sid, path, off, lines, msgs FROM files")}
    total, skipped = 0, None
    avg_bytes = 4000.0
    stopped = False
    remaining = 0

    def rest_estimate(from_idx):
        b = 0
        for t in ts[from_idx:]:
            try:
                size = os.stat(t.path).st_size
            except OSError:
                continue
            b += max(0, size - ((frows.get(t.sid) or (0, 0, 0))[2] or 0))
        return int(b / avg_bytes)

    for ti, t in enumerate(ts):
        try:
            size = os.stat(t.path).st_size
        except OSError:
            continue
        row = frows.get(t.sid)
        off, lines, msgs = (row[2] or 0, row[3] or 0, row[4] or 0) if row else (0, 0, 0)
        if size < off:  # truncated or replaced: start over for this transcript
            db.execute("DELETE FROM chunks WHERE sid = ?", (t.sid,))
            off, lines, msgs = 0, 0, 0
        if size == off:
            continue
        # scan new complete lines into items
        items = []  # (line, ts, role, chunk_i, text, end_off)
        pos, n = off, lines
        with open(t.path, "rb") as f:
            f.seek(off)
            for raw in f:
                end = pos + len(raw)
                n += 1
                if not raw.endswith(b"\n"):
                    rec = parse_line(raw.decode("utf-8", "replace"))
                    if rec is None:  # incomplete last line: leave for the next run
                        n -= 1
                        break
                pos = end
                if (b'"user"' not in raw and b'"assistant"' not in raw):
                    continue
                rec = parse_line(raw.decode("utf-8", "replace"))
                if not rec or rec.get("isSidechain"):
                    continue
                cs = message_chunks(rec)
                if not cs:
                    continue
                msgs_seen = {}
                for role, c in cs:
                    ci = msgs_seen.get(role, 0)
                    msgs_seen[role] = ci + 1
                    items.append((n, rec.get("timestamp") or "", role, len(items), c, pos))
        new_end_line, new_end_pos = n, pos
        # chunk index must be per (line, role)
        per, fixed_items = {}, []
        for (ln, tsx, role, _gi, c, endp) in items:
            ci = per.get((ln, role), 0)
            per[(ln, role)] = ci + 1
            fixed_items.append((ln, tsx, role, ci, c, endp))
        items = fixed_items
        new_msgs = len({(it[0], it[2]) for it in items})
        if not items:
            db.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?,?)", (t.sid, t.path, new_end_pos, new_end_line, msgs))
            db.commit()
            frows[t.sid] = (t.sid, t.path, new_end_pos, new_end_line, msgs)
            continue
        pending = len(items)
        i = 0
        while i < len(items):
            if deadline and time.time() >= deadline:
                stopped = True
                break
            batch = items[i:i + BATCH]
            try:
                vecs = embed([b[4] for b in batch], INDEX_TIMEOUT)
            except RuntimeError as e:
                skipped = str(e)
                break
            if dim is None:
                dim = len(vecs[0])
                db.execute("INSERT OR REPLACE INTO meta VALUES ('model', ?)", (cfg["model"],))
                db.execute("INSERT OR REPLACE INTO meta VALUES ('dim', ?)", (str(dim),))
            elif len(vecs[0]) != dim:  # model dimension changed: rebuild
                db.executescript("DELETE FROM chunks; DELETE FROM files; DELETE FROM meta;")
                db.execute("INSERT OR REPLACE INTO meta VALUES ('model', ?)", (cfg["model"],))
                dim = len(vecs[0])
                db.execute("INSERT OR REPLACE INTO meta VALUES ('dim', ?)", (str(dim),))
                frows.clear()
                skipped = "embedding size changed; index reset, run again"
                break
            db.executemany("INSERT OR REPLACE INTO chunks VALUES (?,?,?,?,?,?)",
                           [(t.sid, b[0], b[3], b[1], b[2], v.tobytes()) for b, v in zip(batch, vecs)])
            i += len(batch)
            total += len(batch)
            # advance the offset to the end of the last line whose chunks are all stored
            done_line = items[i - 1][0] if i >= len(items) or items[i][0] != items[i - 1][0] else None
            if i >= len(items):
                row_off, row_lines = new_end_pos, new_end_line
            elif done_line is not None:
                row_off, row_lines = items[i - 1][5], done_line
            else:
                row_off, row_lines = None, None
            if row_off is not None:
                share = new_msgs * i // len(items) if i < len(items) else new_msgs
                db.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?,?)",
                           (t.sid, t.path, row_off, row_lines, msgs + share))
                frows[t.sid] = (t.sid, t.path, row_off, row_lines, msgs + share)
            db.commit()
            if (total // BATCH) % 10 == 0 and i < len(items):
                print("indexed %d chunks, %d remaining" % (total, pending - i + rest_estimate(ti + 1)), flush=True)
        if skipped or stopped:
            remaining = pending - i + rest_estimate(ti + 1)
            break
        avg_bytes = max(500.0, (size - off) / max(1, pending))
    db.commit()
    db.close()
    out = []
    if skipped:
        out.append("meaning index skipped: %s" % skipped)
    out.append("indexed %d chunks, %d remaining" % (total, remaining))
    out.append("%.1f chunks/s over %.1f s" % (total / max(0.001, time.time() - t0), time.time() - t0)) if total else None
    return [x for x in out if x]


# ---------------------------------------------------------------- open / user

def cap_body(text, full, mid=None, start=0):
    """Body text capped at 4,000 chars (40,000 with full), starting at char `start`. A cut body ends with a marker
    naming the next offset (F44.12(a))."""
    cap = MSG_CAP_FULL if full else 4000
    seg = text[start:start + cap]
    end = start + len(seg)
    if end >= len(text):
        return seg
    return seg + "\n[cut: %d more chars; continue with: recall.py open %s --full --from %d]" % (len(text) - end, mid or "<id>", end)


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
    if a.from_ is not None:
        if a.from_ < 0:
            raise UsageError("--from must be >= 0")
        n, rec, role, text = msgs[pos]
        text = redact(text)
        mid = "%s:%d" % (t.sid8, n)
        seg_end = min(len(text), a.from_ + MSG_CAP_FULL)
        out.append("%s [chars %d-%d of %d]" % (heading(t, n, rec, role), min(a.from_, len(text)), seg_end, len(text)))
        out.append(cap_body(text, True, mid, a.from_))
        return out
    for n, rec, role, text in msgs[max(0, pos - around):pos + around + 1]:
        out.append(heading(t, n, rec, role))
        out.append(cap_body(redact(text), a.full, "%s:%d" % (t.sid8, n)))
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
    p.add_argument("--keyword", action="store_true")
    p.add_argument("--meaning", action="store_true")
    common(p)
    p = sub.add_parser("open")
    p.add_argument("id")
    p.add_argument("--around", type=int, default=2)
    p.add_argument("--full", action="store_true")
    p.add_argument("--from", dest="from_", type=int, default=None)
    common(p)
    p = sub.add_parser("user")
    p.add_argument("--last", type=int, default=20)
    p.add_argument("--session", default="all")
    common(p)
    p = sub.add_parser("index")
    p.add_argument("--max-seconds", type=float, default=0)
    common(p)
    p = sub.add_parser("handoffs")
    common(p)
    return ap


def emit(lines, cap=OUT_CAP):
    text = "\n".join(lines)
    if len(text) > cap:
        text = text[:cap] + "\n" + CUT_MARK.replace("12,000", "{:,}".format(cap))
    sys.stdout.write(text + ("\n" if text else ""))


def main(argv):
    try:
        a = build_parser().parse_args(argv)
        cwd = os.path.expanduser(a.cwd) if a.cwd else os.getcwd()
        root = project_root(cwd)
        fn = {"search": cmd_search, "open": cmd_open, "user": cmd_user, "index": cmd_index, "handoffs": cmd_handoffs}[a.cmd]
        big = a.cmd == "open" and (a.full or a.from_ is not None)
        emit(fn(a, root), OPEN_FULL_CAP if big else OUT_CAP)
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
