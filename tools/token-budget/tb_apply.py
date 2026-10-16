#!/usr/bin/env python3
"""apply.sh backend. Applies exactly one proposal per human invocation. Never auto-run.

Exit: 0 ok/idempotent; 1 unexpected; 2 usage; 3 not found; 4 patch cannot apply;
5 revert refused / backup missing; 6 advisory only; 7 confirmation required;
8 settings missing or invalid JSON.
"""
import glob
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tblib as T  # noqa: E402


class Exit(Exception):
    def __init__(self, code, msg=""):
        Exception.__init__(self, msg)
        self.code = code
        self.msg = msg


def usage():
    sys.stderr.write("usage: apply.sh [--json] [--yes] <proposal-id> | --revert [--force] <proposal-id> | --list\n")
    return 2


def read_applied(state):
    out = []
    p = os.path.join(state, "applied.jsonl")
    if os.path.isfile(p):
        with open(p, "r", encoding="utf-8") as f:
            for ln in f:
                try:
                    o = json.loads(ln)
                except ValueError:
                    continue
                if isinstance(o, dict):
                    out.append(o)
    return out


def active_apply(applied, pid):
    """Latest apply line for pid with no later revert, else None."""
    last = None
    for o in applied:
        if o.get("id") == pid:
            last = o if o.get("action") == "apply" else None
    return last


def newest_proposals(state):
    files = sorted(glob.glob(os.path.join(state, "proposals", "*.json")))
    if not files:
        return None, []
    try:
        with open(files[-1], "r", encoding="utf-8") as f:
            d = json.load(f)
        return files[-1], d.get("proposals", []) if isinstance(d, dict) else []
    except (OSError, ValueError):
        return files[-1], []


def emit(js, status, pid, text):
    if js:
        print(json.dumps({"status": status, "id": pid}))
    else:
        print(text)


def backup_path(state, now):
    d = os.path.join(state, "backups")
    os.makedirs(d, mode=0o700, exist_ok=True)
    t = now
    from datetime import timedelta
    for _ in range(600):
        p = os.path.join(d, "settings.%s.json" % t.strftime("%Y%m%dT%H%M%SZ"))
        if not os.path.exists(p):
            return p
        t = t + timedelta(seconds=1)
    raise Exit(1, "cannot pick backup name")


def do_apply(state, pid, yes, js):
    now = T.now_utc()
    applied = read_applied(state)
    if active_apply(applied, pid):
        emit(js, "already_applied", pid, "already applied")
        return 0
    pf, props = newest_proposals(state)
    prop = next((p for p in props if isinstance(p, dict) and p.get("id") == pid), None)
    if prop is None:
        raise Exit(3, "proposal not found: %s" % pid)
    action = prop.get("action") or {}
    typ = action.get("type")
    if typ == "flag":
        raise Exit(6, "proposal %s is advisory only (no automatic action): %s" % (pid, prop.get("title", "")))
    if typ == "shell":
        argv = action.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
            raise Exit(4, "bad shell argv")
        argv = [T.expand(a) for a in argv]
        if not yes:
            print("would run: %s" % " ".join(argv))
            raise Exit(7, "confirmation required: re-run with --yes")
        r = subprocess.run(argv)
        if r.returncode != 0:
            raise Exit(1, "command failed with exit %d" % r.returncode)
        os.makedirs(state, mode=0o700, exist_ok=True)
        T.append_line(os.path.join(state, "applied.jsonl"), json.dumps(
            {"schema": 1, "ts": T.fmt_ts(now), "action": "apply", "id": pid, "backup": None,
             "settings_file": None, "sha256_before": None, "sha256_after": None,
             "est_saving_tokens": prop.get("est_saving_tokens", 0)}, separators=(",", ":")))
        emit(js, "applied", pid, "applied %s (shell, not revertible)" % pid)
        return 0
    if typ != "json_patch":
        raise Exit(4, "unknown action type %r" % typ)

    sfile = T.settings_file()
    try:
        with open(sfile, "rb") as f:
            raw = f.read()
        doc = json.loads(raw.decode("utf-8"))
        if not isinstance(doc, dict):
            raise ValueError("not an object")
    except (OSError, ValueError) as e:
        raise Exit(8, "settings file missing or invalid: %s (%s)" % (sfile, e))
    new, changed, err = T.patch_apply(doc, action.get("ops", []))
    if err:
        raise Exit(4, "patch cannot apply: %s" % err)
    if not changed:
        emit(js, "already_applied", pid, "already applied")
        return 0
    before = T.sha256_file(sfile)
    bk = backup_path(state, now)
    shutil.copy2(sfile, bk)
    text = json.dumps(new, indent=2, ensure_ascii=False) + "\n"
    json.loads(text)  # validate
    T.write_atomic(sfile, text, copy_mode_from=sfile)
    after = T.sha256_file(sfile)
    T.append_line(os.path.join(state, "applied.jsonl"), json.dumps(
        {"schema": 1, "ts": T.fmt_ts(now), "action": "apply", "id": pid,
         "backup": os.path.relpath(bk, state), "settings_file": sfile,
         "sha256_before": before, "sha256_after": after,
         "est_saving_tokens": prop.get("est_saving_tokens", 0)}, separators=(",", ":")))
    emit(js, "applied", pid, "applied %s (backup: %s)" % (pid, os.path.relpath(bk, state)))
    return 0


def do_revert(state, pid, force, js):
    now = T.now_utc()
    applied = read_applied(state)
    ap = active_apply(applied, pid)
    if not ap:
        emit(js, "not_applied", pid, "not applied")
        return 0
    if not ap.get("backup"):
        raise Exit(5, "cannot revert %s: no settings backup (shell action)" % pid)
    bk = ap["backup"] if os.path.isabs(ap["backup"]) else os.path.join(state, ap["backup"])
    if not os.path.isfile(bk):
        raise Exit(5, "backup missing: %s" % bk)
    sfile = ap.get("settings_file") or T.settings_file()
    cur_sha = T.sha256_file(sfile) if os.path.isfile(sfile) else None
    if cur_sha != ap.get("sha256_after") and not force:
        raise Exit(5, "settings changed since apply (sha256 mismatch); use --force to restore anyway")
    with open(bk, "rb") as f:
        data = f.read()
    T.write_atomic(sfile, data, copy_mode_from=bk)
    T.append_line(os.path.join(state, "applied.jsonl"), json.dumps(
        {"schema": 1, "ts": T.fmt_ts(now), "action": "revert", "id": pid,
         "restored_from": ap["backup"], "settings_file": sfile,
         "sha256_before": cur_sha, "sha256_after": T.sha256_file(sfile)}, separators=(",", ":")))
    emit(js, "reverted", pid, "reverted %s (restored from %s)" % (pid, ap["backup"]))
    return 0


def do_list(state):
    pf, props = newest_proposals(state)
    applied = read_applied(state)
    if not props:
        print("no proposals")
        return 0
    for p in props:
        st = "applied" if active_apply(applied, p.get("id")) else p.get("action", {}).get("type", "?")
        print("%-40s %6s  %-10s %s" % (p.get("id"), p.get("est_saving_tokens", 0), st, p.get("title", "")))
    return 0


def main(argv):
    revert = force = yes = js = lst = False
    ids = []
    for a in argv:
        if a == "--revert":
            revert = True
        elif a == "--force":
            force = True
        elif a == "--yes":
            yes = True
        elif a == "--json":
            js = True
        elif a == "--list":
            lst = True
        elif a.startswith("-"):
            return usage()
        else:
            ids.append(a)
    state = T.state_dir()
    try:
        if lst:
            return do_list(state) if not ids else usage()
        if len(ids) != 1:
            return usage()
        if revert:
            return do_revert(state, ids[0], force, js)
        return do_apply(state, ids[0], yes, js)
    except Exit as e:
        if e.msg:
            sys.stderr.write("apply: %s\n" % e.msg)
        return e.code
    except Exception as e:  # noqa
        sys.stderr.write("apply: unexpected error: %r\n" % (e,))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
