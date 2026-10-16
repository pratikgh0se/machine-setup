#!/usr/bin/env python3
"""Strict regex secret scan over the given file list (one path per line on stdin). Exit 1 on findings.
Allowlist: .secret-scan-allow (lines: `path-glob<TAB>regex` or just `regex`), reviewed by a human.
Importable: leak_scan.py reuses PATS, BAD_NAMES and load_allow()."""
import fnmatch, os, re, sys

PATS = [
 ("private-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
 ("openai/anthropic-key", r"\bsk-[A-Za-z0-9_\-]{20,}"),
 ("github-token", r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"),
 ("slack-token", r"\bxox[abprso]-[A-Za-z0-9\-]{10,}"),
 ("aws-key", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
 ("google-key", r"\bAIza[0-9A-Za-z_\-]{35}\b"),
 ("jwt", r"\beyJ[A-Za-z0-9_\-]{15,}\.[A-Za-z0-9_\-]{10,}\."),
 ("bearer", r"[Bb]earer\s+[A-Za-z0-9._\-]{20,}"),
 ("secret-assignment", r"(?i)(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_]*[\"']?\s*[:=]\s*[\"']?(?!__SECRET:|\$|<|\{|None|null|true|false|os\.|process\.|\.\.\.)[A-Za-z0-9/+_\-]{20,}[\"']?\s*[,;]?\s*$"),
 ("url-credentials", r"://[^/\s:@]+:[^/\s:@]{4,}@"),
]
BAD_NAMES = re.compile(r"(^|/)(\.credentials.*|\.env(\..*)?|.*\.env|settings\.local\.json|.*\.pem|id_rsa.*|.*\.p12|.*\.keychain.*)$")


def load_allow(root):
    allow = []
    ap = os.path.join(root, ".secret-scan-allow")
    if os.path.exists(ap):
        for ln in open(ap, encoding="utf-8", errors="replace"):
            ln = ln.rstrip("\n")
            if not ln or ln.startswith("#"): continue
            g, _, r = ln.partition("\t")
            allow.append((g, re.compile(r)) if r else ("*", re.compile(g)))
    return allow


def main():
    root = sys.argv[1]
    allow = load_allow(root)
    # Only an explicit overlay scan (SECRET_SCAN_OVERLAY=1, set by export.sh) may hold a root config.env; content rules still apply.
    overlay_root = os.environ.get("SECRET_SCAN_OVERLAY") == "1"
    cp = [(n, re.compile(p)) for n, p in PATS]
    bad = 0
    for rel in sys.stdin.read().split("\n"):
        if not rel: continue
        p = os.path.join(root, rel)
        if not os.path.isfile(p) or os.path.islink(p): continue
        if BAD_NAMES.search(rel) and rel != ".gitignore" and not (overlay_root and rel == "config.env"):
            print("FORBIDDEN-FILENAME %s" % rel); bad += 1; continue
        try: data = open(p, "rb").read()
        except OSError: continue
        if b"\0" in data[:4096]: continue
        for i, line in enumerate(data.decode("utf-8", "replace").split("\n"), 1):
            if len(line) > 4000: line = line[:4000]
            for n, r in cp:
                m = r.search(line)
                if not m: continue
                if any(fnmatch.fnmatch(rel, g) and a.search(line) for g, a in allow): continue
                print("%s:%d: [%s] %s" % (rel, i, n, line.strip()[:120])); bad += 1
    print("regex-scan: %d finding(s)" % bad)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
