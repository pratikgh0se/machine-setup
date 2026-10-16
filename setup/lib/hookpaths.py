#!/usr/bin/env python3
"""List absolute paths referenced by hook/statusLine commands in settings.json (HOME-relative, __HOME__ token form).
Output TSV: path<TAB>kind  where kind = claude (under ~/.claude) | repo:<CodeBase repo> | other"""
import json, re, sys
d = json.load(open(sys.argv[1])); home = sys.argv[2]
cmds = []
def walk(n):
    if isinstance(n, dict):
        if isinstance(n.get("command"), str): cmds.append(n["command"])
        for v in n.values(): walk(v)
    elif isinstance(n, list):
        for v in n: walk(v)
walk(d.get("hooks", {})); walk(d.get("statusLine", {}))
paths = set()
for c in cmds:
    for m in re.findall(r"(?:%s|__HOME__|~)(/[^\s\"']+)" % re.escape(home), c):
        paths.add(m)
for p in sorted(paths):
    if p.startswith("/.claude/"): kind = "claude"
    else:
        m = re.match(r"/CodeBase/([^/]+)/", p)
        kind = "repo:" + m.group(1) if m else "other"
    print("__HOME__%s\t%s" % (p, kind))
