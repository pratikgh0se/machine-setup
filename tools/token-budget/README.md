# token-budget

A weekly loop that measures how many tokens Claude Code loads into every session before you type anything (system prompt, tools, skills, MCP servers, CLAUDE.md, plugins), flags regressions against last week, breaks down where your spend goes, and proposes small, reversible fixes. It never changes anything by itself.

Python 3 standard library and bash only. macOS (launchd, `osascript`). The full design is in [`docs/token-budget-spec.md`](../../docs/token-budget-spec.md) (normative).

## Requirements

- `claude` (Claude Code CLI) on the PATH of a login shell, signed in. The weekly probe makes exactly **two Haiku calls** from an empty scratch directory (`/context`, and one trivial prompt).
- `python3` 3.10+.
- Optional: `ccusage` (`npm install -g ccusage`) for the daily and weekly dollar figures. Without it the report says `ccusage n/a`; the spend breakdown is computed from your local transcripts either way.
- Optional: an Obsidian vault (`OBSIDIAN_VAULT_PATH`) to receive the markdown report. Without it the report step is skipped; the ledger, proposals and notification still work.

## Install (weekly LaunchAgent)

```
tools/token-budget/install.sh
```

This creates the state directory (mode 700, default `~/.local/state/token-budget`), renders a LaunchAgent plist from `launchd/token-budget.plist.tmpl` into `~/Library/LaunchAgents/${LABEL_PREFIX:-com.machine-setup}.token-budget.plist`, lints it and loads it with `launchctl bootstrap`. It is idempotent (it unloads a loaded copy first) and prints the next fire time. The job runs `run.sh --catch-up` every Monday at 09:00 and once at load; the catch-up logic means a Mac that was asleep or off on Monday still runs it, and a week already recorded is not recorded twice.

- `LABEL_PREFIX` (default `com.machine-setup`) sets the launchd label prefix and plist file name: `LABEL_PREFIX=com.example tools/token-budget/install.sh`. Note: the shipped plist template currently hard-codes its `Label` as `com.machine-setup.token-budget`, so use the default prefix unless you edit the template (known issue).
- `install.sh --render-only PATH` renders and lints the plist to `PATH` and touches nothing else.
- Run it right now instead of waiting: `launchctl kickstart -k gui/$(id -u)/com.machine-setup.token-budget`, or `tools/token-budget/run.sh`. Status: `launchctl print gui/$(id -u)/com.machine-setup.token-budget`.

Try the measurement without writing anything: `tools/token-budget/probe.sh --dry-run` prints the ledger line it would append.

## What the weekly run does

`run.sh` = probe, then analyze, then report and notify, then a `last-run.json` marker. A failing stage stops the later ones, logs to `<state>/logs/run.log` and sends a `Token Budget failed: <stage>` notification.

| File | Role |
|---|---|
| `probe.sh` (+ `tb_probe.py`) | The two Haiku calls, then a manifest (skills, MCP servers, plugins, CLAUDE.md sizes, CLI version) and one line appended to the ledger. `--dry-run` writes nothing. |
| `analyze.py` | Deterministic comparison with last week (no model, no network) producing regressions and proposals in `proposals/<week>.json`. |
| `run.sh [--catch-up] [--force]` (+ `tb_run.py`) | Orchestrates the stages, writes the report, sends the macOS notification. |
| `apply.sh <id>` / `--revert <id>` / `--list` (+ `tb_apply.py`) | Human-only; applies one proposal at a time. |
| `install.sh` / `uninstall.sh` | LaunchAgent management. |
| `tb_spend.py` + `prices.json` | Offline estimate of the last 7 days of spend from transcripts (deduplicated); price table overridable with `TOKEN_BUDGET_PRICES`. |
| `tblib.py` | Shared helpers (clock, redaction, `/context` parser, JSON-patch subset). |

## The report

If `OBSIDIAN_VAULT_PATH` is set, the report is written to `$OBSIDIAN_VAULT_PATH/Reports/Token Budget YYYY-Www.md`. Re-running a week replaces only the block between `<!-- token-budget:begin -->` and `<!-- token-budget:end -->`; anything you add outside it survives. A macOS notification carries the headline, prefixed `REGRESSION:` when one was found.

Sections, in order:

1. **Headline**: `overhead 28.7k (-1.6k), spend $61.80 this week, 3 proposals`.
2. **Breakdown**: always-loaded tokens by category (system prompt, tools, MCP tools, custom agents, memory files, skills, ...) with the change since last week.
3. **Spend breakdown** (labelled `estimate (prices as of <date>)`): tokens and dollars by model family, cache hit ratio, main-thread versus subagent cost share, the top 5 sessions, and **Risky sessions**: up to 5 sessions that contain subagents spawning subagents (nested spawns), a subagent with more than 100 steps, or a subagent whose context passed 300,000 tokens, with their dollar estimate, subagent count, nesting count, maximum steps and context, and the reasons. Each risky session also yields an advisory proposal (`session-nested-<sid>`, `session-runaway-<sid>`). Pair this with the `agents` plugin's Delegation Guard.
4. **Regressions**: overhead up by more than 1,000 tokens (with the largest causes), new skills, new MCP servers, new plugins, plugin and CLI version changes.
5. **Proposals**: id, estimated saving, title and exact command (top 20).
6. **Applied since last report** and **Measurement notes**.

No message text or secrets are stored or shown: only names, counts, token numbers, timestamps and model ids. Everything written to disk passes a redaction step.

## Proposals: how they are approved and applied

Nothing is applied automatically; no flag or environment variable enables that. Each proposal has a stable id, a risk level and one of three kinds:

- **`json_patch`**: an edit to your Claude Code `settings.json` (for example adding `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, or adding an MCP server with no calls in 30 days to `deniedMcpServers`).
- **`shell`**: a command run as an argument list, such as removing a duplicate user-level skill directory. Needs `--yes`.
- **`flag`**: advice only (shorten a long skill description, a CLAUDE.md that grew, low cache hit ratio, too much main-thread frontier-model spend, risky sessions). `apply.sh` exits 6 for these.

```
tools/token-budget/apply.sh --list              # proposals from the newest week
tools/token-budget/apply.sh compact-window      # apply one
tools/token-budget/apply.sh --revert compact-window
```

Applying backs up the settings file to `<state>/backups/`, writes the change atomically, and logs a line in `applied.jsonl`. Re-applying is a no-op. `--revert` restores the backup, and refuses (exit 5) if the settings file changed since, unless `--force`. Unused skills are deliberately never proposed for removal (they load lazily, only their one-line listing costs tokens). To exclude skills or MCP servers from ever being proposed, list them in `<state>/protect.json`: `{"skills":["name"],"mcp":["server"]}`.

Exit codes: 0 ok or already applied; 1 error; 2 usage; 3 proposal not found; 4 patch cannot apply; 5 revert refused; 6 advisory only; 7 `--yes` needed; 8 settings file missing or invalid.

## State and configuration

State directory `~/.local/state/token-budget/` (override `TOKEN_BUDGET_STATE_DIR`): `ledger.jsonl` (append-only, one line per week), `manifests/`, `proposals/<year>-W<week>.json`, `applied.jsonl`, `backups/`, `logs/`, `last-run.json`.

Environment overrides: `TOKEN_BUDGET_STATE_DIR`, `CLAUDE_SETTINGS_FILE` (default `~/.claude/settings.json`), `CLAUDE_HOME` (default `~/.claude`), `OBSIDIAN_VAULT_PATH`, `TOKEN_BUDGET_NOW` (clock override for tests), `TOKEN_BUDGET_NOTIFY=0|1` (0 prints the notification text instead), `TOKEN_BUDGET_CLAUDE_BIN`, `TOKEN_BUDGET_CCUSAGE_BIN`, `TOKEN_BUDGET_PRICES` (inline JSON or a file path, shape of `prices.json`).

## Uninstall

```
tools/token-budget/uninstall.sh            # unload the LaunchAgent, delete the plist, keep state
tools/token-budget/uninstall.sh --purge    # also delete the state directory
tools/token-budget/uninstall.sh --dry-run  # list what would be removed
```

Backups of your settings file live in the state directory, so `--purge` also deletes them.

## Troubleshooting

- **Nothing happened on Monday.** `launchctl print gui/$(id -u)/com.machine-setup.token-budget` and `<state>/logs/launchd.err`; `last-run.json` shows the last status. The next login runs the catch-up.
- **`claude` not found in the job.** The job runs through a login shell (`bash -lc`); make sure `claude` is on the PATH set in your shell profile.
- **No report file.** `OBSIDIAN_VAULT_PATH` is unset or the directory is missing; the step is skipped silently. See `ledger.jsonl` and `proposals/`.
- **`ccusage n/a`.** Install `ccusage` or ignore it; the estimate does not depend on it.
- **Proposal commands cannot find `apply.sh`.** Run them from the repo root or use the full path.
