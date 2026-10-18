#!/usr/bin/env python3
"""Leak guard (spec 11.8): keeps personal values and secrets out of the public repo.
Never prints matched text, lines or denylist terms: only `<relpath>:<line>: [<rule>]`.
Called by setup/leak-scan.sh. Exit: 0 pass, 1 findings, 2 usage error, 4 --require-denylist without a denylist."""
import fnmatch, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import regex_scan  # noqa: E402  (secret rules shared with secret-scan.sh)

PUBLIC = os.path.dirname(os.path.dirname(HERE))  # repo root (parent of setup/)

# Every pattern literal below is a rule definition, not a leak.
HOME_PATHS = re.compile(r"/Users/[^/\s]+/|/home/[^/\s]+/|[A-Za-z]:\\Users\\[^\\\s]+\\")  # leak-scan: allow=home-path
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})")
UUID = re.compile(r"(?<![0-9A-Fa-f\-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f\-])")
INLINE = re.compile(r"leak-scan:\s*allow=([A-Za-z0-9_*:#,\-]+)")
BASE_RULES = ("home-path", "email", "uuid")
MAXLINE = 4000


def usage(msg):
    sys.stderr.write("leak-scan: %s\n" % msg)
    sys.stderr.write("usage: leak-scan.sh [--root DIR] [--denylist FILE|--no-denylist] [--require-denylist] [--staged|--range REVRANGE]\n")
    sys.exit(2)


def find_overlay():
    v = os.environ.get("MACHINE_SETUP_PRIVATE", "")
    if v:
        if v == "none":
            return None
        if not os.path.isdir(v):
            sys.stderr.write("overlay: MACHINE_SETUP_PRIVATE=%s is not a directory\n" % v)
            sys.exit(2)
        return os.path.realpath(v)
    sib = os.path.join(os.path.dirname(os.path.realpath(PUBLIC)), "machine-setup-private")
    return os.path.realpath(sib) if os.path.isdir(sib) else None


def git(root, *args):
    return subprocess.run(["git", "-C", root] + list(args), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def list_files(root, staged, rng=None):
    """Returns [(rel, reader)] where reader() gives bytes or None (skip)."""
    out = []
    in_git = git(root, "rev-parse", "--is-inside-work-tree").returncode == 0
    if rng:
        if not in_git:
            usage("--range needs a git work tree")
        r = git(root, "diff", "--name-only", "--diff-filter=ACMR", "-z", "--relative", rng)
        if r.returncode != 0:
            usage("--range: bad revision range")
        for n in sorted(x.decode("utf-8", "replace") for x in r.stdout.split(b"\0") if x):
            def rd(n=n):  # added lines only; other lines blanked so line numbers stay true
                d = git(root, "diff", "-U0", "--no-color", "--no-ext-diff", rng, "--", n).stdout.decode("utf-8", "replace")
                lines, cur = [], 0
                for l in d.split("\n"):
                    m = re.match(r"@@ -\S+ \+(\d+)", l)
                    if m: cur = int(m.group(1)); continue
                    if cur and l.startswith("+") and not l.startswith("+++"):
                        lines.extend([""] * (cur - 1 - len(lines))); lines.append(l[1:]); cur += 1
                return "\n".join(lines).encode()
            out.append((n, rd))
        return out
    if staged:
        if not in_git:
            usage("--staged needs a git work tree")
        names = git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--relative").stdout.split(b"\0")
        modes = {}
        for rec in git(root, "ls-files", "--stage", "-z").stdout.split(b"\0"):
            if not rec: continue
            meta, _, path = rec.partition(b"\t")
            modes[path.decode("utf-8", "replace")] = meta.split()[0]
        for n in sorted(x.decode("utf-8", "replace") for x in names if x):
            def rd(n=n):
                if modes.get(n) == b"120000":
                    return None
                r = git(root, "show", ":./" + n)
                return r.stdout if r.returncode == 0 else None
            out.append((n, rd))
        return out
    if in_git:
        names = git(root, "ls-files", "-co", "--exclude-standard", "-z").stdout.split(b"\0")
        rels = sorted(set(x.decode("utf-8", "replace") for x in names if x))
    else:
        rels = []
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if d != ".git"]
            for f in fn:
                rels.append(os.path.relpath(os.path.join(dp, f), root))
        rels.sort()
    for rel in rels:
        p = os.path.join(root, rel)
        def rd(p=p):
            if os.path.islink(p) or not os.path.isfile(p):
                return None
            try:
                with open(p, "rb") as f:
                    return f.read()
            except OSError:
                return None
        out.append((rel, rd))
    return out


def load_denylist(path):
    entries = []  # (number, kind, matcher)
    with open(path, encoding="utf-8", errors="replace") as f:
        for n, ln in enumerate(f, 1):
            ln = ln.rstrip("\r\n")
            s = ln.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("re:"):
                try:
                    entries.append((n, "re", re.compile(s[3:], re.I)))
                except re.error:
                    continue
            else:
                entries.append((n, "fixed", re.compile(re.escape(s), re.I)))
    return entries


def load_allow(path):
    rules = []
    if not path or not os.path.isfile(path):
        return rules
    with open(path, encoding="utf-8", errors="replace") as f:
        for ln in f:
            ln = ln.rstrip("\r\n")
            if not ln.strip() or ln.lstrip().startswith("#"):
                continue
            parts = ln.split("\t", 2)
            if len(parts) != 3:
                continue
            try:
                rules.append((parts[0], parts[1], re.compile(parts[2])))
            except re.error:
                continue
    return rules


def main():
    argv = sys.argv[1:]
    root = None; denyfile = None; nodeny = False; require = False; staged = False; rng = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--root" and i + 1 < len(argv): root = argv[i + 1]; i += 2; continue
        if a == "--range" and i + 1 < len(argv): rng = argv[i + 1]; i += 2; continue
        if a == "--denylist" and i + 1 < len(argv): denyfile = argv[i + 1]; i += 2; continue
        if a == "--no-denylist": nodeny = True
        elif a == "--require-denylist": require = True
        elif a == "--staged": staged = True
        else: usage("unknown or incomplete argument: %s" % a)
        i += 1
    root = os.path.abspath(root if root is not None else PUBLIC)
    if not os.path.isdir(root):
        usage("--root is not a directory")
    overlay = find_overlay()
    deny = None
    if denyfile is not None and not nodeny:
        if not os.path.isfile(denyfile) or not os.access(denyfile, os.R_OK):
            usage("--denylist is not readable")
        deny = load_denylist(denyfile)
    elif not nodeny and overlay and os.path.isfile(os.path.join(overlay, "leak-denylist.txt")):
        deny = load_denylist(os.path.join(overlay, "leak-denylist.txt"))
    if denyfile is not None and nodeny is False and deny is None:
        usage("--denylist is not readable")
    if require and deny is None:
        sys.stderr.write("leak-scan: --require-denylist given but no denylist found\n")
        sys.exit(4)

    pub_allow = load_allow(os.path.join(root, ".leak-scan-allow"))
    ov_allow = load_allow(os.path.join(overlay, "leak-allow.txt")) if overlay else []
    secret_allow = regex_scan.load_allow(root)
    secret_pats = [(n, re.compile(p)) for n, p in regex_scan.PATS]

    def allowed(rel, rule, text, line):
        if rule.startswith("secret:") or rule == "denylist-file":
            return False
        is_deny = rule.startswith("denylist")
        if line is not None and not is_deny:
            for m in INLINE.finditer(line):
                names = m.group(1).split(",")
                if rule in names or "*" in names:
                    return True
        sets = ov_allow if is_deny else pub_allow + ov_allow
        for g, r, rx in sets:
            if (r == rule or r == "*") and fnmatch.fnmatch(rel, g) and rx.search(text):
                return True
        return False

    files = list_files(root, staged, rng)
    findings = set()

    def add(rel, line, rule):
        findings.add((rel, line, rule))

    for rel, reader in files:
        base = os.path.basename(rel)
        if base in ("leak-denylist.txt", "leak-allow.txt"):
            add(rel, 0, "denylist-file"); continue
        if regex_scan.BAD_NAMES.search(rel) and rel != ".gitignore":
            add(rel, 0, "secret:forbidden-filename"); continue
        if deny:
            for n, kind, rx in deny:
                m = rx.search(rel)
                if m and not allowed(rel, "denylist-path#%d" % n, m.group(0), None):
                    add(rel, 0, "denylist-path#%d" % n)
        data = reader()
        if data is None or b"\0" in data[:4096]:
            continue
        for ln, line in enumerate(data.decode("utf-8", "replace").split("\n"), 1):
            if len(line) > MAXLINE:
                line = line[:MAXLINE]
            if not line.strip():
                continue
            for name, rx in secret_pats:
                if rx.search(line) and not any(fnmatch.fnmatch(rel, g) and a.search(line) for g, a in secret_allow):
                    add(rel, ln, "secret:" + name)
            for m in HOME_PATHS.finditer(line):
                if not allowed(rel, "home-path", m.group(0), line): add(rel, ln, "home-path")
            for m in EMAIL.finditer(line):
                d = m.group(1).lower()
                if d == "users.noreply.github.com" or d == "example.com" or d.endswith(".example.com"):
                    continue
                if not allowed(rel, "email", m.group(0), line): add(rel, ln, "email")
            for m in UUID.finditer(line):
                if not allowed(rel, "uuid", m.group(0), line): add(rel, ln, "uuid")
            if deny:
                for n, kind, rx in deny:
                    m = rx.search(line)
                    if m and not allowed(rel, "denylist#%d" % n, m.group(0), line):
                        add(rel, ln, "denylist#%d" % n)

    gl_fail = False
    if not staged and not rng:
        import shutil
        if shutil.which("gitleaks"):
            try:
                r = subprocess.run(["gitleaks", "dir", ".", "--no-banner", "--redact"], cwd=root,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if r.returncode != 0:
                    gl_fail = True
            except OSError:
                pass

    out = sorted(findings, key=lambda t: (t[0].encode(), t[1], t[2].encode()))
    sys.stdout.write("leak-scan: %d files\n" % len(files))
    sys.stdout.write("leak-scan: denylist: %s\n" % ("%d entries" % len(deny) if deny is not None else "none"))
    for rel, ln, rule in out:
        sys.stdout.write("%s:%d: [%s]\n" % (rel, ln, rule))
    if gl_fail:
        sys.stdout.write("leak-scan: gitleaks reported findings (run gitleaks locally for details)\n")
    n = len(out) + (1 if gl_fail else 0)
    sys.stdout.write("leak-scan: %d finding(s)\n" % n)
    sys.stdout.write("leak-scan: %s\n" % ("FAIL" if n else "PASS"))
    sys.exit(1 if n else 0)


if __name__ == "__main__":
    main()
