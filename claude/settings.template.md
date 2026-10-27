# settings.template.json: key reference

`settings.template.json` is a starting point for `~/.claude/settings.json`. JSON has no comments, so every key is explained here. `__HOME__` is replaced by your home directory when you copy it (`sed "s|__HOME__|$HOME|g"`); `setup/bootstrap.sh` does not overwrite an existing `settings.json`. Your real, personal values (exact plugin list, skill overrides, MCP deny list, project trust text) belong in the private overlay, see `OVERLAY.md`.

| Key | What it does |
|---|---|
| `cleanupPeriodDays` | How long Claude Code keeps session transcripts before deleting them. |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` | Default model for subagents that do not name one. A cost safety net for the delegation policy in `CLAUDE.md.template`. |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Context size (tokens) at which auto-compact triggers. |
| `permissions.allow` | Tool calls that never prompt. Keep to read-only commands plus the handoff directory the compact hooks write to. |
| `permissions.deny` | Tool calls that are always refused. Add folders you never want read (the template blocks build output and `node_modules`). |
| `model` | Default model for the main thread. |
| `hooks.SessionStart` (matcher `compact`) | Re-injects the handoff written before a compaction (`claude/hooks/postcompact-inject.py`). Five commands: `--part 1`, `--part 2` and `--part 3` (each hook's `additionalContext` is capped at 10,000 chars, so a long handoff is split across up to three), then `--ledger --part 1` and `--ledger --part 2` (the project's whole active decisions ledger in two parts, newest first, each under 10,000 chars). |
| `hooks.SessionStart` (matchers `startup`, `resume`) | `postcompact-inject.py --ledger` prints the project's active decisions (the per-project ledger the PreCompact hook maintains under `~/.local/state/claude-handoffs/projects/`) into new and resumed sessions. Read-only, no model call. |
| `hooks.PreCompact` (timeout 150 s) | Writes the deterministic handoff file before compaction (`claude/hooks/precompact-handoff.py`, always exits 0). The summary call and the ledger merge each have their own timeout (`HANDOFF_SUMMARY_TIMEOUT` default 75 s, `HANDOFF_LEDGER_TIMEOUT` default 100 s) and run in parallel. |
| `hooks.PreToolUse` (Bash) | `no-git-stash.sh` blocks stashing by agents; `no-root-walks.py` blocks recursive commands rooted at `/`, `/Users` or the home folder. |
| `statusLine` | Command whose output is the status line. The template uses `ccusage` (`npm install -g ccusage`). Remove if you do not use it. |
| `enabledPlugins` | Plugins switched on. The six `@bento` ids come from this repo's marketplace. |
| `extraKnownMarketplaces` | Marketplaces registered at start-up. `bento` points at this repo; change `repo` if you fork it. The marketplace and plugin names stay `bento`, `safety`, `usage`, ... so ids like `agents@bento` keep working. |
| `sandbox` | Bash sandbox. Off in the template; turn it on if you want it. |
| `effortLevel` | Default reasoning effort. |
| `theme` | UI theme. |
| `skillOverrides` | Per-skill visibility, e.g. `"some-skill": "user-invocable-only"` or `"off"`. Empty here; use it to shrink always-loaded skill descriptions. |
| `deniedMcpServers` | MCP servers to refuse by name: `[{"serverName": "..."}]`. Empty here. |
| `autoMode.soft_deny` / `autoMode.environment` | Classifier guidance for auto mode: extra soft-deny rules (keep `$defaults`) and plain-text lines describing your repos, trusted domains and sensitive locations. Empty here. |
| `outputStyle` | Output style name. |

Handoff directory: the hooks use `~/.local/state/claude-handoffs`, because Claude Code treats everything under `~/.claude/` as sensitive and denies model writes there. See `specs/handoff-hooks-spec.md`.
