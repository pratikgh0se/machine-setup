# handoff-canary

Nightly proof that compaction plus handoff works end to end. Spec: `specs/handoff-hooks-spec.md` section F36.

Two headless Claude Code sessions (Haiku, project settings only, no MCP, a temp project with just the two handoff hooks) are driven past one compaction each: variant A has an agent handoff file, variant B relies on the Haiku fallback. Each passes only if PreCompact fired and logged a health line, the handoff holds the run token, SessionStart injected it without a warning, and the turn right after compaction quotes the token.

```
tools/handoff-canary/run.sh             # run now
tools/handoff-canary/run.sh --catch-up  # run only if last-run.json is older than the most recent 03:30 (launchd uses this)
tools/handoff-canary/run.sh --probe     # re-check mode after a CLI upgrade: variant A only, keeps the run dir, writes probe-result.json
```

- Result line appended to `~/.local/state/claude-handoffs/health.jsonl` (`trigger: "canary"`); state in `~/.local/state/handoff-canary/` (`last-run.json`, `runs/` kept 14 days on failure).
- Cost about $0.03-0.10 per run; cap `HANDOFF_CANARY_MAX_USD` (0.25). Hard stop `HANDOFF_CANARY_TIMEOUT_S` (720). Window `HANDOFF_CANARY_WINDOW` (60000, minimum 40000).
- `claude` missing or logged out: result `skip`. Failure: macOS notification (`HANDOFF_CANARY_NOTIFY=0` prints a `NOTIFY:` line instead).
- Exit: 0 pass/skip, 1 fail, 2 usage or lock held, 3 isolation violated.
- Schedule: `launchd/handoff-canary.plist.tmpl` (daily 03:30, installed by `setup/bootstrap.sh --launchd`). `check.py` is the pure checker; `claude/hooks/handoff-canary.sh` is a thin wrapper.
- Test seams: `HANDOFF_CANARY_STATE_DIR`, `HANDOFF_HEALTH_FILE`, `HANDOFF_CANARY_NOW`.
