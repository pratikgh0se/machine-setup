"""Shared stdlib helpers for the token-budget loop. No subprocess, no network."""
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone

SKIP_SUM = {"system_tools_deferred", "mcp_tools_deferred", "free_space", "autocompact_buffer"}
CATEGORY_KEYS = [
    "system_prompt", "system_tools", "system_tools_deferred", "mcp_server_instructions",
    "mcp_tools", "mcp_tools_deferred", "custom_agents", "memory_files", "skills",
    "messages", "free_space", "autocompact_buffer",
]

REDACT_RE = re.compile(r"(?i)(api[_-]?key|token|secret|password|authorization|bearer)\S*")
TOKEN_PATTERNS = [
    re.compile(r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"(?<![A-Za-z0-9_-])ghp_[A-Za-z0-9_]{8,}"),
    re.compile(r"(?<![A-Za-z0-9_-])xox[a-z]-[A-Za-z0-9-]{8,}"),
]


def redact(s):
    """Full section-8 redaction. Used for strings that originate from external data."""
    if not isinstance(s, str):
        return s
    s = REDACT_RE.sub("[REDACTED]", s)
    return scrub_tokens(s)


def scrub_tokens(s):
    for p in TOKEN_PATTERNS:
        s = p.sub("[REDACTED]", s)
    return s


# ---------- time ----------
def parse_iso(s):
    s = s.strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def now_utc(override=None):
    o = override if override is not None else os.environ.get("TOKEN_BUDGET_NOW")
    if o:
        return parse_iso(o).replace(microsecond=0)
    return datetime.now(timezone.utc).replace(microsecond=0)


def fmt_ts(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local(dt):
    return dt.astimezone()


def week_id(dt):
    y, w, _ = local(dt).isocalendar()
    return "%d-W%02d" % (y, w)


def local_date(dt):
    return local(dt).strftime("%Y-%m-%d")


def monday_of_week(dt):
    d = local(dt).date()
    return d - timedelta(days=d.weekday())


# ---------- paths / env ----------
def home():
    return os.environ.get("HOME") or os.path.expanduser("~")


def state_dir():
    return os.environ.get("TOKEN_BUDGET_STATE_DIR") or os.path.join(home(), ".local/state/token-budget")


def claude_home():
    return os.environ.get("CLAUDE_HOME") or os.path.join(home(), ".claude")


def settings_file():
    return os.environ.get("CLAUDE_SETTINGS_FILE") or os.path.join(claude_home(), "settings.json")


def home_abbrev(p):
    h = home().rstrip("/")
    if h and (p == h or p.startswith(h + "/")):
        return "~" + p[len(h):]
    return p


def expand(p):
    if p == "~" or p.startswith("~/"):
        return home().rstrip("/") + p[1:]
    return p


# ---------- io ----------
def jdump(obj):
    return json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def write_atomic(path, data, mode=0o600, copy_mode_from=None):
    d = os.path.dirname(path) or "."
    tmp = os.path.join(d, ".tb-tmp-%d-%s" % (os.getpid(), os.path.basename(path)))
    b = data if isinstance(data, bytes) else data.encode("utf-8")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, b)
    finally:
        os.close(fd)
    try:
        if copy_mode_from and os.path.exists(copy_mode_from):
            os.chmod(tmp, os.stat(copy_mode_from).st_mode & 0o7777)
        else:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def append_line(path, line):
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (line + "\n").encode("utf-8"))
    finally:
        os.close(fd)


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_json_lenient(path):
    """Return (obj, err). Missing file -> ({}, None)."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return {}, None
    except OSError as e:
        return {}, str(e)
    try:
        obj = json.loads(raw.decode("utf-8"))
    except Exception as e:  # noqa
        return {}, "invalid json: %s" % e
    if not isinstance(obj, dict):
        return {}, "not an object"
    return obj, None


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def norm_key(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def mcp_norm(server):
    return re.sub(r"[^A-Za-z0-9_-]", "_", server).lower()


# ---------- /context parsing ----------
def parse_tokens(cell):
    c = str(cell).strip().replace("`", "").replace("*", "")
    m = re.match(r"^<\s*([\d.,]+)", c)
    if m:
        return int(float(m.group(1).replace(",", "")) // 2)
    c = c.lstrip("~").strip()
    m = re.match(r"^([\d][\d,]*\.?\d*|\.\d+)\s*([kKmM])?", c)
    if not m:
        raise ValueError("bad token cell: %r" % cell)
    v = float(m.group(1).replace(",", ""))
    u = (m.group(2) or "").lower()
    if u == "k":
        v *= 1000
    elif u == "m":
        v *= 1000000
    return int(round(v))


def _row_cells(line):
    line = line.strip()
    if not line.startswith("|"):
        return None
    cells = [c.strip() for c in line.strip("|").split("|")]
    if all(re.match(r"^:?-{2,}:?$", c) for c in cells if c) and any(cells):
        return None
    return cells


def _cat_key(name):
    n = re.sub(r"\s+", " ", name.strip().lower())
    n = re.sub(r"\s*\(deferred\)", " deferred", n)
    return re.sub(r"[^a-z0-9]+", "_", n).strip("_")


def parse_context(text):
    """Parse /context output. Raises ValueError (-> exit 3) if unrecognisable."""
    denied_notices = 0
    lines = []
    for ln in text.splitlines():
        if "blocked by enterprise policy" in ln:
            denied_notices += 1
            continue
        lines.append(ln)
    total = window = None
    for ln in lines:
        m = re.search(r"Tokens:\**\s*([\d.,]+\s*[kKmM]?)\s*/\s*([\d.,]+\s*[kKmM]?)", ln)
        if m:
            total = parse_tokens(m.group(1))
            window = parse_tokens(m.group(2))
            break
    if total is None:
        raise ValueError("header 'Tokens: X / Y' missing")
    cats = {}
    other = {}
    skills = []
    mcp_rows = []
    section = None
    for ln in lines:
        h = re.match(r"^#{1,6}\s+(.*?)\s*$", ln)
        if h:
            section = h.group(1).strip().lower()
            continue
        cells = _row_cells(ln)
        if section and section.startswith("estimated usage by category"):
            if cells is None:
                m = re.match(r"^\s*[-*⛁⛀⛶⛝ ]*\s*([A-Za-z][A-Za-z ()]+?):\s*([<~\d.,]+\s*[kKmM]?)\s*tokens", ln)
                if m:
                    cells = [m.group(1), m.group(2)]
                else:
                    continue
            if len(cells) < 2 or cells[0].lower() in ("category", ""):
                continue
            try:
                v = parse_tokens(cells[1])
            except ValueError:
                continue
            k = _cat_key(cells[0])
            if k in CATEGORY_KEYS:
                cats[k] = v
            else:
                other[k] = v
        elif cells and section == "skills":
            if len(cells) >= 3 and cells[0].lower() != "skill":
                try:
                    skills.append((cells[0], cells[1], parse_tokens(cells[2])))
                except ValueError:
                    pass
        elif cells and section == "mcp tools":
            if len(cells) >= 3 and cells[0].lower() != "tool":
                try:
                    mcp_rows.append((cells[0], cells[1], parse_tokens(cells[2])))
                except ValueError:
                    pass
    if not cats and not other:
        raise ValueError("no category rows")
    categories = {k: cats.get(k, 0) for k in CATEGORY_KEYS}
    categories["other"] = dict(sorted(other.items()))
    csum = sum(v for k, v in cats.items() if k not in SKIP_SUM) + sum(other.values())
    warnings = []
    if total > 0 and abs(csum - total) / float(total) > 0.02:
        warnings.append("category_sum_mismatch")
    ver = None
    for ln in lines:
        m = re.search(r"(?i)\bversion:?\**\s*v?(\d+\.\d+\.\d+)", ln)
        if m:
            ver = m.group(1)
            break
    return {
        "total_always_loaded": total,
        "context_window": window,
        "category_sum_check": csum,
        "categories": categories,
        "skills": skills,
        "mcp_rows": mcp_rows,
        "denied_mcp_notices": denied_notices,
        "warnings": warnings,
        "cli_version": ver,
    }


# ---------- JSON patch subset (add/replace/remove) ----------
class PatchError(Exception):
    pass


def _ptr(path):
    if path == "":
        return []
    if not path.startswith("/"):
        raise PatchError("bad pointer %r" % path)
    return [p.replace("~1", "/").replace("~0", "~") for p in path[1:].split("/")]


def patch_apply(obj, ops):
    """Return (new_obj, changed, error_or_None). Pure; never mutates input.

    Extension to RFC 6902: `add` creates missing intermediate objects (and the list
    for a trailing `-`), because settings files often lack e.g. "env".
    """
    import copy
    doc = copy.deepcopy(obj)
    changed = False
    try:
        for op in ops:
            kind = op.get("op")
            toks = _ptr(op.get("path", ""))
            if not toks:
                raise PatchError("empty path")
            parent = doc
            for i_t, t in enumerate(toks[:-1]):
                if isinstance(parent, dict):
                    if t not in parent:
                        if kind == "add":
                            parent[t] = [] if (i_t == len(toks) - 2 and toks[-1] == "-") else {}
                        elif kind == "remove":
                            parent = None
                            break
                        else:
                            raise PatchError("path missing: %s" % op["path"])
                    parent = parent[t]
                elif isinstance(parent, list):
                    parent = parent[int(t)]
                else:
                    raise PatchError("cannot traverse %s" % op["path"])
            if parent is None:
                continue
            last = toks[-1]
            if kind == "add":
                val = op.get("value")
                if isinstance(parent, dict):
                    if last == "-":
                        raise PatchError("bad path")
                    if last in parent and parent[last] == val:
                        continue
                    parent[last] = val
                    changed = True
                elif isinstance(parent, list):
                    if last == "-":
                        if val in parent:
                            continue
                        parent.append(val)
                        changed = True
                    else:
                        parent.insert(int(last), val)
                        changed = True
                else:
                    raise PatchError("bad parent")
            elif kind == "replace":
                if isinstance(parent, dict):
                    if last not in parent:
                        raise PatchError("replace on missing path %s" % op["path"])
                    if parent[last] != op.get("value"):
                        parent[last] = op.get("value")
                        changed = True
                elif isinstance(parent, list):
                    i = int(last)
                    if i >= len(parent):
                        raise PatchError("replace on missing path %s" % op["path"])
                    if parent[i] != op.get("value"):
                        parent[i] = op.get("value")
                        changed = True
                else:
                    raise PatchError("bad parent")
            elif kind == "remove":
                if isinstance(parent, dict):
                    if last in parent:
                        del parent[last]
                        changed = True
                elif isinstance(parent, list):
                    i = int(last)
                    if i < len(parent):
                        del parent[i]
                        changed = True
            else:
                raise PatchError("unsupported op %r" % kind)
    except PatchError as e:
        return obj, False, str(e)
    except (ValueError, IndexError, KeyError, TypeError) as e:
        return obj, False, "patch failed: %s" % e
    return doc, changed, None
