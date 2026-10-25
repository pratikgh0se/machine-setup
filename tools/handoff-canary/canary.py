#!/usr/bin/env python3
"""Handoff canary driver (spec specs/handoff-hooks-spec.md F36.E).

Proves end to end, with real headless Claude Code sessions, that PreCompact fires, a handoff is
written, SessionStart(compact) injects it and the resumed model acts on it. Two variants, one
compaction each: A (agent file present) and B (absent; fresh summary).

Usage: run.sh [--catch-up] [--probe]
Exit: 0 pass/skip/no-op, 1 fail, 2 usage or lock held, 3 isolation violated.
Env: HANDOFF_CANARY_WINDOW (default 60000, >= 40000), HANDOFF_CANARY_MAX_USD (0.25),
HANDOFF_CANARY_TIMEOUT_S (720), HANDOFF_CANARY_NOTIFY (0 disables osascript, prints NOTIFY: line),
HANDOFF_CANARY_NOW (ISO-8601 or epoch seconds; catch-up only), HANDOFF_CANARY_STATE_DIR.
"""
import datetime, json, os, random, shutil, signal, subprocess, sys, tempfile, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import check as chk  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
HOME = os.path.expanduser("~")
STATE = os.environ.get("HANDOFF_CANARY_STATE_DIR") or os.path.join(HOME, ".local", "state", "handoff-canary")
REAL_HEALTH = os.environ.get("HANDOFF_HEALTH_FILE") or os.path.join(HOME, ".local", "state", "claude-handoffs", "health.jsonl")
TURN_TIMEOUT = 300
MAX_PAD_TURNS = 12
KEEP_DAYS = 14
HEALTH_MAX_LINES = 5000


class Abort(Exception):
    def __init__(self, reason, code=1):
        self.reason, self.code = reason, code


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def env_float(name, default):
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return float(default)


# ---------------------------------------------------------------- catch-up
def effective_now():
    v = os.environ.get("HANDOFF_CANARY_NOW")
    if not v:
        return datetime.datetime.now().astimezone()
    try:
        return datetime.datetime.fromtimestamp(float(v)).astimezone()
    except ValueError:
        dt = datetime.datetime.fromisoformat(v.replace("Z", "+00:00"))
        return dt.astimezone() if dt.tzinfo else dt.astimezone()  # naive = local


def catch_up_needed():
    try:
        with open(os.path.join(STATE, "last-run.json"), encoding="utf-8") as f:
            last = datetime.datetime.fromisoformat(json.load(f)["ts"].replace("Z", "+00:00"))
    except Exception:
        return True
    now = effective_now()
    boundary = now.replace(hour=3, minute=30, second=0, microsecond=0)
    if boundary > now:
        boundary -= datetime.timedelta(days=1)
    return last < boundary


# ---------------------------------------------------------------- files
def write_json(path, obj):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def append_health(line):
    """Same semantics as the hook (F36.B): append, rotate to the last 5000 lines, swallow failures."""
    try:
        os.makedirs(os.path.dirname(REAL_HEALTH), exist_ok=True)
        with open(REAL_HEALTH, "a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
        with open(REAL_HEALTH, "rb") as f:
            lines = f.readlines()
        if len(lines) > HEALTH_MAX_LINES:
            tmp = REAL_HEALTH + f".tmp{os.getpid()}"
            with open(tmp, "wb") as f:
                f.writelines(lines[-HEALTH_MAX_LINES:])
            os.replace(tmp, REAL_HEALTH)
    except Exception:
        pass


def canary_child_lines():
    n = 0
    try:
        with open(REAL_HEALTH, encoding="utf-8", errors="replace") as f:
            for ln in f:
                try:
                    if json.loads(ln).get("canary_child") is True:
                        n += 1
                except Exception:
                    pass
    except Exception:
        pass
    return n


def read_health(path):
    return chk.load_lines(path)


# ---------------------------------------------------------------- session driver
class Run:
    def __init__(self, window, cap, deadline, probe):
        self.window, self.cap, self.deadline, self.probe = window, cap, deadline, probe
        self.cost = {}      # variant -> LAST total_cost_usd (cumulative per session)
        self.turn_log = []  # probe output

    def total_cost(self):
        return sum(self.cost.values())

    def claude(self, v, proj, env, sid, first, prompt, slash=False):
        """One non-interactive turn. Returns the parsed JSON object. Raises Abort on any problem."""
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Abort("timeout")
        cmd = ["claude", "-p", "--session-id" if first else "--resume", sid,
               "--model", "haiku", "--setting-sources", "project",
               "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
        if not slash:
            cmd.append("--disable-slash-commands")
        cmd += ["--output-format", "json", "--permission-mode", "acceptEdits",
                "--allowedTools", "Read Write Edit", "--max-budget-usd", f"{self.cap:.2f}", prompt]
        p = subprocess.Popen(cmd, cwd=proj, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            out, err = p.communicate(timeout=min(TURN_TIMEOUT, remaining))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except Exception:
                pass
            p.communicate()
            raise Abort("timeout")
        try:
            o = json.loads(out)
            if not isinstance(o, dict):
                raise ValueError
        except ValueError:
            low = (out + err).lower()
            if "log in" in low or "login" in low or "not authenticated" in low:
                raise Abort("claude_missing", 0)
            raise Abort("error")
        c = o.get("total_cost_usd")
        if isinstance(c, (int, float)):
            self.cost[v] = float(c)
        if self.probe:
            u = o.get("usage") if isinstance(o.get("usage"), dict) else {}
            self.turn_log.append({"variant": v, "turn": len(self.turn_log) + 1, "cost": self.cost.get(v),
                                  "session_id": o.get("session_id"),
                                  "input_tokens": u.get("input_tokens"),
                                  "cache_read": u.get("cache_read_input_tokens"),
                                  "cache_creation": u.get("cache_creation_input_tokens")})
            print("probe turn", json.dumps(self.turn_log[-1]))
        if self.total_cost() > self.cap:
            raise Abort("cost_cap")
        if p.returncode != 0 or o.get("is_error") is True:
            raise Abort("error")
        return o


WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa "
         "quebec romeo sierra tango uniform victor whiskey xray yankee zulu ember quartz willow cobalt "
         "marble thistle harbor lantern meadow orchid pewter saddle timber velvet walnut zephyr").split()


def make_padding(proj, n_files=6, lines=450):
    rnd = random.Random(20261016)  # deterministic synthetic text, never real data
    names = []
    for i in range(1, n_files + 1):
        name = f"pad{i}.txt"
        with open(os.path.join(proj, name), "w", encoding="utf-8") as f:
            for ln in range(lines):
                f.write(f"{i}.{ln:04d} " + " ".join(rnd.choice(WORDS) for _ in range(14)) + "\n")
        names.append(name)
    return names


def write_settings(proj):
    os.makedirs(os.path.join(proj, ".claude"))
    pre = f"python3 {os.path.join(REPO, 'claude', 'hooks', 'precompact-handoff.py')}"
    post = f"python3 {os.path.join(REPO, 'claude', 'hooks', 'postcompact-inject.py')}"
    post2 = post + " --part 2"  # F37.5/F37.6: a long handoff is delivered in up to three parts
    post3 = post + " --part 3"
    post = post + " --part 1"
    write_json(os.path.join(proj, ".claude", "settings.json"), {"hooks": {
        "PreCompact": [{"hooks": [{"type": "command", "command": pre, "timeout": 90}]}],
        "SessionStart": [{"matcher": "compact", "hooks": [{"type": "command", "command": post, "timeout": 10},
                                                     {"type": "command", "command": post2, "timeout": 10},
                                                     {"type": "command", "command": post3, "timeout": 10}]}]}})


def write_agent_file(handoffs, sid, token):
    ms = int(time.time() * 1000)
    body = ("## Goal\nCanary run: create s1.txt, s2.txt, s3.txt and finally done.txt in this directory.\n\n"
            "## Decisions and why\nSteps are done one per turn; the final step waits for GO FINAL.\n\n"
            "## Done\nSteps 1 and 2 (s1.txt, s2.txt) are complete.\n\n"
            "## In progress\nStep 3 (s3.txt containing THREE) is next.\n\n"
            "## Dead ends\nNone.\n\n"
            f"## Exact next step\ncreate done.txt containing {token}\n")
    with open(os.path.join(handoffs, f"{sid}-agent.md"), "w", encoding="utf-8") as f:
        f.write(body)
    write_json(os.path.join(handoffs, f"{sid}-agent.meta.json"), {"agentWrittenAt": ms, "lastNudgeAt": ms - 1000})


def run_variant(run, v, token, other, base_env):
    """Drive one session through one compaction. Returns a result dict; raises Abort for fatal errors."""
    tmp = tempfile.mkdtemp(prefix=f"handoff-canary-{v}-", dir=os.environ.get("TMPDIR") or None)
    tmp_real, root_real = os.path.realpath(tmp), os.path.realpath(os.environ.get("TMPDIR") or tempfile.gettempdir())
    if not (tmp_real + os.sep).startswith(root_real + os.sep):
        raise Abort("isolation", 3)
    proj, handoffs = os.path.join(tmp, "proj"), os.path.join(tmp, "handoffs")
    os.makedirs(proj)
    os.makedirs(handoffs)
    write_settings(proj)
    pads = make_padding(proj)
    sid = str(uuid.uuid4())
    env = dict(base_env, HANDOFF_STATE_DIR=handoffs, HANDOFF_CANARY="1",
               CLAUDE_CODE_AUTO_COMPACT_WINDOW=str(run.window),
               HANDOFF_SUMMARY_MODEL="haiku",  # F38.6: keep the fresh-summary call cheap
               HANDOFF_LEDGER="0")  # F39: the canary proves the handoff path only; no ledger merge call
    for k in ("HANDOFF_TEST_FAULT", "HANDOFF_HAIKU_FALLBACK", "HANDOFF_SUMMARY", "HANDOFF_HOOK_CHILD"):
        env.pop(k, None)
    health = os.path.join(handoffs, "health.jsonl")
    t0 = time.monotonic()
    res = {"variant": v, "sid": sid, "tmp": tmp, "handoffs": handoffs, "token": token, "reason": None,
           "answer": "", "hook_version": None}
    try:
        task = ("You are running a canary. Do these steps in order, one per turn, in this directory: "
                "step 1 create s1.txt containing ONE; step 2 create s2.txt containing TWO; "
                "step 3 create s3.txt containing THREE; final step 4 create done.txt containing the text "
                + (f"`{token}`" if v == "B" else "recorded in your handoff file")
                + ". After each turn I will tell you to proceed. Never do step 4 until I say `GO FINAL`. "
                "If asked what your next step is, answer with the exact text to be written in done.txt. "
                "Now do step 1 only, then reply `ok`.")
        run.claude(v, proj, env, sid, True, task)
        run.claude(v, proj, env, sid, False, "Proceed: do step 2 only, then reply `ok`.")
        if v == "A":
            write_agent_file(handoffs, sid, token)
        seen, compacted, slash_tried = len(read_health(health)), False, False
        for i in range(MAX_PAD_TURNS):  # 2 setup turns + padding + the /compact fallback = at most 12
            if i < MAX_PAD_TURNS - 3:
                pad = pads[i % len(pads)]
                run.claude(v, proj, env, sid, False,
                           f"Read {pad} completely with the Read tool, then reply only `ok`.")
            elif not slash_tried:
                slash_tried = True  # fallback driver: manual /compact (slash commands enabled for this turn)
                run.claude(v, proj, env, sid, False, "/compact", slash=True)
            else:
                break
            if len(read_health(health)) > seen:
                compacted = True
                break
        if not compacted:
            res["reason"] = "no_compaction"
            return res
        o = run.claude(v, proj, env, sid, False,
                       "State your exact next step, in one line, quoting the text to write in done.txt. Do not do it.")
        res["answer"] = o.get("result") if isinstance(o.get("result"), str) else ""
    except Abort as a:
        res["reason"], res["abort"] = a.reason, a
        return res
    finally:
        res["elapsed_s"] = time.monotonic() - t0
    return res


def evaluate(run, res, other):
    if res["reason"]:
        return False
    hl = read_health(os.path.join(res["handoffs"], "health.jsonl"))
    for o in hl:
        if isinstance(o, dict) and isinstance(o.get("hook_version"), str):
            res["hook_version"] = o["hook_version"]
    latest = None
    try:
        with open(os.path.join(res["handoffs"], f"{res['sid']}-latest.md"), encoding="utf-8", errors="replace") as f:
            latest = f.read()
    except Exception:
        pass
    ok, reason = chk.check_variant(
        res["variant"], res["token"], other, hl, latest,
        os.path.exists(os.path.join(res["handoffs"], f"{res['sid']}-degraded.json")), res["answer"],
        res["elapsed_s"], run.cost.get(res["variant"], 0.0), run.cap, 720)
    res["reason"] = reason
    return ok


# ---------------------------------------------------------------- main
def notify(msg):
    if os.environ.get("HANDOFF_CANARY_NOTIFY") == "0":
        print("NOTIFY: " + msg)
        return
    try:
        subprocess.run(["osascript", "-e", f'display notification "{msg}" with title "Handoff canary"'],
                       timeout=10, capture_output=True)
    except Exception:
        print("NOTIFY: " + msg)


def prune_runs():
    cutoff = time.time() - KEEP_DAYS * 86400
    base = os.path.join(STATE, "runs")
    try:
        for n in os.listdir(base):
            p = os.path.join(base, n)
            if os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)
    except Exception:
        pass


def acquire_lock():
    lock = os.path.join(STATE, "lock")
    for _ in range(2):
        try:
            os.mkdir(lock)
            write_json(os.path.join(lock, "pid"), os.getpid())
            return lock
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock) > 30 * 60:
                    shutil.rmtree(lock, ignore_errors=True)
                    continue
            except Exception:
                pass
            return None
    return None


def finish(result, reason, variants, started, cost, sid, hook_version, run_dir, keep):
    ts = iso(now_utc())
    line = {"ts": ts, "sid": sid[:8], "trigger": "canary", "result": result, "reason": reason,
            "variants": variants, "duration_ms": int((time.monotonic() - started) * 1000),
            "est_cost_usd": round(cost, 4), "hook_version": hook_version, "canary_child": False}
    append_health(line)
    write_json(os.path.join(STATE, "last-run.json"), {"ts": ts, "result": result, "reason": reason,
                                                       "next_run_hint": "daily 03:30 (launchd); see run.sh --catch-up"})
    if result == "fail":
        notify(f"Handoff canary FAILED ({reason})")
    if not keep:
        shutil.rmtree(run_dir, ignore_errors=True)
    print(f"handoff canary: {result}" + (f" ({reason})" if reason else "") + f" cost ${cost:.4f}")
    return 1 if result == "fail" else 0


def main(argv):
    catch = probe = False
    for a in argv:
        if a == "--catch-up":
            catch = True
        elif a == "--probe":
            probe = True
        else:
            print("usage: run.sh [--catch-up] [--probe]", file=sys.stderr)
            return 2
    try:
        window = int(os.environ.get("HANDOFF_CANARY_WINDOW") or 60000)
    except ValueError:
        window = 0
    if window < 40000:
        print("handoff canary: HANDOFF_CANARY_WINDOW must be an integer >= 40000", file=sys.stderr)
        return 2
    cap = env_float("HANDOFF_CANARY_MAX_USD", "0.25")
    timeout_s = env_float("HANDOFF_CANARY_TIMEOUT_S", "720")
    os.makedirs(STATE, exist_ok=True)
    try:
        os.chmod(STATE, 0o700)
    except Exception:
        pass
    if catch and not catch_up_needed():
        return 0
    started = time.monotonic()
    lock = acquire_lock()
    if lock is None:
        print("handoff canary: another run holds the lock", file=sys.stderr)
        return 2
    try:
        prune_runs()
        run_dir = os.path.join(STATE, "runs", now_utc().strftime("%Y%m%dT%H%M%SZ"))
        os.makedirs(run_dir, exist_ok=True)
        if shutil.which("claude") is None:
            return finish("skip", "claude_missing", {"A": "skip", "B": "skip"}, started, 0.0, str(uuid.uuid4()),
                          None, run_dir, False)
        run = Run(window, cap, started + timeout_s, probe)
        child_before = canary_child_lines()
        tokens = {}
        rid = uuid.uuid4().hex[:10]
        tokens = {"A": f"A-{rid}", "B": f"B-{rid}"}
        base_env = dict(os.environ)
        results, fatal = {}, None
        for v in (["A"] if probe else ["A", "B"]):
            other = tokens["B" if v == "A" else "A"]
            r = run_variant(run, v, tokens[v], other, base_env)
            results[v] = r
            ok = evaluate(run, r, other)
            r["ok"] = ok
            if not ok and r["reason"] in ("timeout", "cost_cap", "isolation", "claude_missing"):
                fatal = r["reason"]
                break
        # elapsed check uses per-variant time; global timeout handled via Abort("timeout")
        if canary_child_lines() > child_before:
            fatal = "isolation"
            return_code = 3
        else:
            return_code = None
        for v, r in results.items():  # keep hook outputs of failing runs (synthetic content only)
            if not r.get("ok") and r.get("handoffs"):
                shutil.copytree(r["handoffs"], os.path.join(run_dir, v), dirs_exist_ok=True)
        hv = next((r.get("hook_version") for r in results.values() if r.get("hook_version")), None)
        sidA = results.get("A", {}).get("sid", str(uuid.uuid4()))
        variants = {v: ("pass" if results[v].get("ok") else "fail") if v in results else "fail" for v in ("A", "B")}
        if probe:
            variants.pop("B", None)
        first_fail = fatal or next((results[v]["reason"] or "error" for v in ("A", "B")
                                    if v in results and not results[v].get("ok")), None)
        result = "skip" if first_fail == "claude_missing" else ("fail" if first_fail else "pass")
        if probe:
            write_json(os.path.join(run_dir, "probe-result.json"), probe_booleans(run, results.get("A", {})))
            for r in results.values():
                if r.get("handoffs"):
                    shutil.copytree(r["handoffs"], os.path.join(run_dir, "A"), dirs_exist_ok=True)
            print("probe run dir kept:", run_dir)
        rc = finish(result, first_fail, variants, started, run.total_cost(), sidA, hv, run_dir,
                    keep=(result == "fail" or probe))
        for r in results.values():
            if r.get("tmp"):
                shutil.rmtree(r["tmp"], ignore_errors=True)
        return 3 if return_code == 3 else rc
    except Abort as a:
        return a.code
    finally:
        shutil.rmtree(lock, ignore_errors=True)


def probe_booleans(run, r):
    hl = read_health(os.path.join(r["handoffs"], "health.jsonl")) if r.get("handoffs") else []
    costs = [t["cost"] for t in run.turn_log if t.get("cost") is not None]
    line = chk.hook_line(hl)
    if line:
        print("probe health line", json.dumps(line))
    return {"precompact_fires": line is not None,
            "trigger": line.get("trigger") if line else None,
            "window": run.window,
            "sessionstart_injected": bool(r.get("answer")) and r.get("token", "\0") in r.get("answer", ""),
            "cost_cumulative": costs == sorted(costs),
            "session_id_stable": len({t.get("session_id") for t in run.turn_log if t.get("session_id")}) <= 1,
            "last_cost_usd": costs[-1] if costs else None}


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        sys.exit(1)
