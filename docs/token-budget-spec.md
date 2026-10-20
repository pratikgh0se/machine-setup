---
type: spec
status: draft-for-review
date: 2026-10-15
tags: [bento, token-budget, spec]
---

# Token Budget Loop: design spec

## For future agent
Spec for a weekly measure -> analyze -> report -> (manual) apply loop that tracks Claude Code's always-loaded token overhead on the user's machine. Tests are written code-blind from THIS document in `~/CodeBase/bento-mods-tests` against fixtures; every I/O format and exit code is therefore normative. Words MUST/SHOULD/MAY are used in the RFC sense. Related: [[Bento]]. Spec date 2026-10-15; CLI behaviour claims reflect measurements of 2026-10-15 and may drift.

## 1. Goal
Weekly, cheaply (two Haiku calls), measure always-loaded context overhead, detect regressions versus last week, name the cause, and propose reversible, individually-applied fixes with estimated savings. Output: JSONL ledger, manifest snapshot, Obsidian report, macOS notification.

## 2. Non-goals
- No auto-apply, ever. `apply.sh` runs only when a human invokes it with one proposal id.
- No Claude Desktop / app measurement in v1 (CLI `claude -p` only).
- No LLM in analysis (analyze.py is pure Python, deterministic).
- No git commits of the vault or of any state files.
- No measurement of per-turn conversation growth; only the empty-session baseline.

## 3. Layout and paths
| Thing | Path |
|---|---|
| Scripts | `<repo>/tools/token-budget/{probe.sh,analyze.py,apply.sh,run.sh,install.sh,uninstall.sh}` |
| LaunchAgent template | `<repo>/launchd/token-budget.plist.tmpl` (single source; `install.sh` and `setup/bootstrap.sh` both render it) |
| State dir | `$TOKEN_BUDGET_STATE_DIR` default `~/.local/state/token-budget/` |
| Ledger | `<state>/ledger.jsonl` (append-only) |
| Manifests | `<state>/manifests/<ts>.json` (`ts` = ledger `ts` with `:` replaced by `-`) |
| Proposals | `<state>/proposals/<YYYY>-W<ww>.json` |
| Applied log | `<state>/applied.jsonl` |
| Backups | `<state>/backups/settings.<UTC compact ts>.json` |
| Logs | `<state>/logs/run.log`, `launchd.out`, `launchd.err` |
| Last run marker | `<state>/last-run.json` |
| Price table | `<repo>/tools/token-budget/prices.json` (override: `TOKEN_BUDGET_PRICES`) |
| Settings file | `$CLAUDE_SETTINGS_FILE` default `~/.claude/settings.json` |
| Vault | `$OBSIDIAN_VAULT_PATH` (report goes to `Reports/Token Budget YYYY-Www.md`) |

All paths MUST be overridable by env vars so tests can point at fixtures: `TOKEN_BUDGET_STATE_DIR`, `CLAUDE_SETTINGS_FILE`, `CLAUDE_HOME` (default `~/.claude`), `OBSIDIAN_VAULT_PATH`, `TOKEN_BUDGET_NOW` (ISO-8601 UTC override of the clock), `TOKEN_BUDGET_NOTIFY=0|1` (default 1; 0 prints the notification text to stdout prefixed `NOTIFY: ` instead of calling `osascript`), `TOKEN_BUDGET_CLAUDE_BIN` (default `claude`), `TOKEN_BUDGET_CCUSAGE_BIN` (default `ccusage`), `TOKEN_BUDGET_PRICES` (either inline JSON starting with `{`, or a path to a JSON file, in the `prices.json` shape of 4.1.4).

Week id: ISO-8601 week of the run date in local time, format `YYYY-Www` (e.g. `2026-W42`).

## 4. Components

### 4.1 probe.sh
Usage: `probe.sh [--dry-run]`. `--dry-run` runs all steps but writes nothing and prints the ledger line to stdout.

Steps (in order):
1. Create fresh empty scratch dir (`mktemp -d`), `cd` into it, trap-delete on exit. Scratch dir MUST contain no CLAUDE.md, `.claude/`, or git repo.
2. `claude -p --model haiku "/context"` -> capture stdout (text table). Parse it (see 4.1.1).
3. `claude -p --model haiku --output-format json "reply with the single word ok"` -> parse `usage` (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) and `total_cost_usd`.
4. `ccusage` daily + weekly spend (USD). If binary missing or non-zero exit: set `spend` fields to `null`, add `"ccusage"` to `warnings`, continue.
5. Compute `spend_breakdown` from local transcripts (4.1.4); no extra model call.
6. Build manifest (4.1.2), write it, then append the ledger line (4.1.3). Manifest is written first; ledger line is the commit point (a manifest without a ledger line is ignorable).

Cost: exactly 2 `claude` invocations (both Haiku). Probe MUST NOT call any other model.

#### 4.1.1 `/context` parsing
Input is the markdown/text output of `/context`. Parser MUST:
- Extract categories as `{name -> tokens}` from the category summary rows. Token values may be written `1.2k`, `627`, `12,345`; normalise to integers (`k` = x1000, rounded).
- Recognised category keys (snake_case in output): `system_prompt`, `system_tools`, `system_tools_deferred`, `mcp_server_instructions` (row "MCP server instructions"), `mcp_tools`, `mcp_tools_deferred`, `custom_agents`, `memory_files`, `skills`, `messages`, `free_space`, `autocompact_buffer`. Unknown rows go into `other` (object name->tokens), never dropped silently.
- `total_always_loaded` MUST equal the "used" value X from the `/context` header line `**Tokens:** X / Y (P%)`. This header is the authoritative total and it includes `messages`. `context_window` = Y. Header missing -> exit 3.
- `category_sum_check` = sum of all categories except `*_deferred`, `free_space`, `autocompact_buffer`. If `|category_sum_check - total_always_loaded| / total_always_loaded > 0.02`, add warning `category_sum_mismatch` (run still succeeds).
- Per-skill token cells: `< 20` parses as 10; `~110` as 110; otherwise as normal numbers.
- Ignore per-item detail tables for totals (see pitfalls 7.1).
- Ignore the line matching `blocked by enterprise policy` (see 7.4); record its count as `denied_mcp_notices`.
- If no category rows are parseable: exit 3 (section 6), write nothing.

#### 4.1.2 Manifest schema (`manifests/<ts>.json`)
```json
{
  "schema": 1,
  "ts": "2026-10-19T09:00:03Z",
  "cli_version": "2.1.88",
  "skills": [
    {"name": "brainstorming", "source": "user", "path": "~/.claude/skills/brainstorming", "override": null, "tokens": 41}
  ],
  "mcp_servers": [
    {"name": "obsidian-second-brain", "kind": "local", "deferred": false, "tool_count": 12, "always_loaded_tokens": 0},
    {"name": "claude.ai Claude Docs", "kind": "connector", "deferred": false, "tool_count": 3, "always_loaded_tokens": 627}
  ],
  "denied_mcp_servers": ["claude.ai Slack"],
  "plugins": [{"name": "superpowers", "version": "5.0.7", "source": "marketplace-name", "surfaces": ["agents", "hooks", "skills"]}],
  "claude_md": {
    "user": {"path": "~/.claude/CLAUDE.md", "bytes": 4210, "est_tokens": 1053},
    "vault": {"path": "~/second-brain/_CLAUDE.md", "bytes": 9120, "est_tokens": 2280}
  },
  "hooks": [{"event": "SessionStart", "matcher": "", "command": "<first 120 chars, secrets-redacted>"}],
  "skill_overrides": {"some-skill": "off"},
  "env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400000"}
}
```
Rules:
- `mcp_servers[]` MAY include `tools: [{"name", "tokens"}]`, filled by probe from the `/context` MCP tools detail table (clarified 2026-10-15). `tool_count` alone never triggers R4.
- `skills[].name` is the base skill name (no `plugin:` prefix) and `skills[].source` is one of `user`, `project`, `plugin:<name>`, `builtin`. Skills come from the `/context` skills detail plus a filesystem scan of `$CLAUDE_HOME/skills` and enabled plugin dirs; on conflict `/context` wins.
- `plugins[].surfaces` = sorted subset of `skills`, `agents`, `hooks`, `mcp`, `commands`, `statusline`, detected from the enabled install dir: `skills` (a `skills/` dir), `agents` (an `agents/` dir), `hooks` (`hooks/hooks.json`, a non-empty `hooks` key in `plugin.json`, or a mods `hooks/register.*`), `mcp` (`mcpServers` in `plugin.json` or a `.mcp.json`), `commands` (`commands/` dir or `commands` key in `plugin.json`), `statusline` (a `statusLine` key in `plugin.json` or a mods status-line module). Unreadable dir -> `[]`.
- `est_tokens` for CLAUDE.md = `ceil(bytes / 4)`.
- `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` is `null` if unset in both process env and settings `env` block.
- Arrays MUST be sorted by `name` (then `source`) for determinism. Object keys sorted.
- `hooks[].command` MUST be redacted by section 8 rules and truncated to 120 chars.
- Sources: `$CLAUDE_SETTINGS_FILE`, `$CLAUDE_HOME/settings.local.json` if present, `$CLAUDE_HOME/plugins/installed_plugins.json` (or equivalent), `claude mcp list` output is NOT used (extra process); MCP info comes from settings + `/context`.

#### 4.1.3 Ledger line schema (one JSON object per line, no embedded newlines)
```json
{
  "schema": 1,
  "ts": "2026-10-19T09:00:03Z",
  "week": "2026-W43",
  "cli_version": "2.1.88",
  "model": "haiku",
  "total_always_loaded": 28700,
  "category_sum_check": 28500,
  "categories": {
    "system_prompt": 3300, "system_tools": 11200, "system_tools_deferred": 22500, "mcp_server_instructions": 513,
    "mcp_tools": 0, "mcp_tools_deferred": 67000, "custom_agents": 521, "memory_files": 1800, "skills": 9900,
    "messages": 1500, "free_space": 138300, "autocompact_buffer": 33000, "other": {}
  },
  "context_window": 400000,
  "trivial_turn": {"input_tokens": 9, "output_tokens": 5, "cache_creation_input_tokens": 28600, "cache_read_input_tokens": 0, "total_cost_usd": 0.0123},
  "spend": {"daily_usd": 14.2, "weekly_usd": 61.8},
  "spend_breakdown": {"window_days": 7, "...": "see 4.1.4"},
  "manifest": "manifests/2026-10-19T09-00-03Z.json",
  "denied_mcp_notices": 1,
  "warnings": []
}
```
- `ts` UTC, `Z` suffix, second precision. `week` per section 3 (local date).
- `spend.*` are `null` when ccusage is unavailable. `weekly_usd` = ISO week to date.
- Missing categories parse as `0`, never absent.
- Ledger is append-only; probe MUST NOT rewrite existing lines. Append uses a single `write` of line + `\n`.
- Probe exit codes: 0 ok (warnings allowed), 2 `claude` binary missing, 3 `/context` unparseable, 4 trivial-turn JSON unparseable, 5 state dir unwritable.

#### 4.1.4 Spend breakdown (`spend_breakdown` in the ledger line)
Computed offline from transcripts, window = lines with `timestamp` in `[now-7d, now]` (`now` = `TOKEN_BUDGET_NOW` or the clock). Files: `$CLAUDE_HOME/projects/*/*.jsonl` (main) and `$CLAUDE_HOME/projects/*/*/subagents/*.jsonl` (subagent). Malformed lines are skipped.
- Count only lines with `type == "assistant"` and a `message.usage`; skip `message.model == "<synthetic>"`.
- Dedupe (the same response is written on several lines): key = `(message.id, requestId)`, applied across ALL files; a line missing either id uses the one it has; a line with neither is never deduped. Of duplicates keep the one with the greatest `output_tokens` (ties: first in path-sorted, line order). `duplicates_dropped` counts the rest.
- Family from `message.model` (case-insensitive substring): `fable`, `opus`, `sonnet`, `haiku`, else `other`.
- Per family: `input` = `input_tokens`, `output` = `output_tokens`, `cache_read` = `cache_read_input_tokens`, `cache_creation` = `cache_creation_input_tokens`; `est_usd` = (input*P.input + output*P.output + cache_read*P.cache_read + cache_creation*P.cache_write5m) / 1e6, full precision, rounded to 4 dp on output.
- Prices: `tools/token-budget/prices.json`, overridable via `TOKEN_BUDGET_PRICES` (invalid override -> built-in table + warning `prices_override_invalid`). Seeded 2026-10-15 from `shared/prices.ts` (family rows: fable = `fable-5.1`, opus = `opus-5.5`, sonnet = `sonnet-5.5`, haiku = `haiku-5.5` at <= 100k, other = opus-5.5 row):
```json
{"asOf": "2026-10-11", "source": "https://platform.claude.com/docs/en/about-claude/pricing", "families": {
  "fable": {"input": 10, "output": 50, "cache_read": 0.25, "cache_write5m": 12.5},
  "opus": {"input": 4, "output": 20, "cache_read": 0.2, "cache_write5m": 5},
  "sonnet": {"input": 2, "output": 10, "cache_read": 0.1, "cache_write5m": 2.5},
  "haiku": {"input": 0.1, "output": 0.5, "cache_read": 0.01, "cache_write5m": 0.125},
  "other": {"input": 4, "output": 20, "cache_read": 0.2, "cache_write5m": 5}}}
```
- `cache_hit_ratio` = cache_read / (input + cache_read + cache_creation), all families; `null` when the denominator is 0. `cost_share` = `{main, subagent}` fractions of total `est_usd` (0 when total is 0). `frontier_share` = (fable + opus `est_usd`) / total (0 when total is 0).
- Per-session subagent stats (same window and dedupe; a "step" is a deduped assistant message in one subagent file; step context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`):
  - `subagent_count`: subagent files of the session with >= 1 counted step.
  - `nested_spawns`: distinct `tool_use` ids with `name == "Agent"` in counted assistant messages of subagent files (`projects/*/<sid>/subagents/*.jsonl`); an `Agent` call in the main file is NOT nested.
  - `max_subagent_steps`: max steps of any one subagent file; `max_subagent_context`: max step context of any subagent step.
  - `worst_agent` = the subagent file with the most steps (ties: greater max context, then file name): `{steps, max_context, est_usd}`.
- `risky_sessions` = every session with `nested_spawns` > 0 OR `max_subagent_steps` > 100 OR `max_subagent_context` > 300000 (all strict), sorted by `est_usd` desc, then project, session; capped at 20 entries. Entries carry the 4 stats above, `worst_agent`, `project`, `session`, `est_usd`, and `reasons` (sorted subset of `nested`, `steps`, `context`). Same no-text rule as `top_sessions`.
- A session = a main file stem (session id); its subagent files (`<session-id>/subagents/`) count toward it. `top_sessions` = 5 highest by `est_usd`, ties by project then session; fields only `project` (the `projects/` dir name), `session` (first 8 chars of id), `est_usd`, `dominant_model` (family with the highest cost in that session), plus the 4 subagent stats below. No message text, prompts, or paths beyond the dir name are ever read into output.
```json
"spend_breakdown": {
  "window_days": 7, "prices_as_of": "2026-10-11", "messages_counted": 1840, "duplicates_dropped": 960,
  "by_family": {
    "fable": {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "est_usd": 0},
    "opus": {"input": 1000000, "output": 100000, "cache_read": 2000000, "cache_creation": 200000, "est_usd": 7.4},
    "sonnet": {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "est_usd": 0},
    "haiku": {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "est_usd": 0},
    "other": {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "est_usd": 0}},
  "total_est_usd": 7.4, "cache_hit_ratio": 0.6250, "cost_share": {"main": 0.8, "subagent": 0.2}, "frontier_share": 1.0,
  "top_sessions": [{"project": "-Users-alice-code-demo", "session": "a1b2c3d4", "est_usd": 5.1, "dominant_model": "opus", "subagent_count": 3, "nested_spawns": 0, "max_subagent_steps": 12, "max_subagent_context": 80000}],
  "risky_sessions": [{"project": "-Users-alice-code-demo", "session": "e5f6a7b8", "est_usd": 1200.0, "subagent_count": 430, "nested_spawns": 331, "max_subagent_steps": 280, "max_subagent_context": 960000, "worst_agent": {"steps": 280, "max_context": 960000, "est_usd": 41.2}, "reasons": ["context", "nested", "steps"]}],
  "ccusage_weekly_usd": 61.8
}
```
All five families are always present. `ccusage_weekly_usd` copies `spend.weekly_usd` (`null` if unavailable). No transcripts in window -> zeros, `cache_hit_ratio: null`, warning `no_transcripts`.

### 4.2 analyze.py
Usage: `analyze.py --state-dir DIR [--now ISO] [--claude-home DIR] [--settings FILE] [--out-json FILE]`. Python 3 stdlib only. No network, no subprocess, no LLM, no randomness. Reads ledger + manifests + transcripts; writes `proposals/<week>.json` and prints the analysis JSON (same content) to stdout. Same inputs + same `--now` MUST produce byte-identical output (sorted keys, 2-space indent, trailing newline).

Previous week = the latest ledger line whose `week` is earlier than the newest line's `week` (not necessarily week-1). If none exists: `"baseline": true`, no regressions, proposals still produced.

Analysis output schema:
```json
{
  "schema": 1,
  "week": "2026-W43",
  "generated_at": "2026-10-19T09:00:10Z",
  "baseline": false,
  "current": {"ts": "...", "total_always_loaded": 28700},
  "previous": {"ts": "...", "total_always_loaded": 30300},
  "delta_tokens": -1600,
  "category_deltas": {"skills": -1500, "mcp_tools": 0},
  "spend": {"daily_usd": 14.2, "weekly_usd": 61.8},
  "regressions": [
    {"id": "reg-overhead-up", "kind": "overhead_up", "delta_tokens": 1200, "cause": "skills +1100 (new skill: foo from plugin:bar)", "evidence": ["skills"]}
  ],
  "proposals": [ "<proposal objects, see below>" ],
  "stats": {"transcripts_scanned": 412, "window_days": 30}
}
```

#### Regression rules
| kind | Trigger (current vs previous) | `cause` text |
|---|---|---|
| `overhead_up` | `delta_tokens > 1000` (strictly greater) | Largest positive category delta(s), plus any new item from the lists below that explains it. Format: `"<category> +<n>"` joined by `"; "`, sorted by n descending then name. |
| `new_skill` | skill `(name, source)` absent previously | `"new skill: <name> from <source>"` |
| `new_mcp` | MCP server name absent previously | `"new MCP: <name>"` |
| `new_plugin` | plugin name absent previously | `"new plugin: <name> <version>"` |
| `plugin_version` | same plugin, version changed | `"plugin <name> <old> -> <new>"` (informational) |
| `cli_version` | CLI version changed | `"CLI <old> -> <new>"` (informational; also attached as cause hint to `overhead_up` when system_prompt/system_tools changed) |
`regressions` sorted by kind order above, then cause. New-item regressions fire even if overhead did not rise.

#### Proposal schema
```json
{
  "id": "skill-desc-long-brainstorming",
  "rule": "R1",
  "title": "Shorten the SKILL.md description of 'brainstorming'",
  "evidence": "listing costs 210 tokens (threshold 150)",
  "est_saving_tokens": 150,
  "risk": "low",
  "action": {"type": "flag", "advice": "shorten the SKILL.md description"},
  "command": "edit ~/.claude/skills/brainstorming/SKILL.md (advisory; apply.sh exits 6)"
}
```
- `id`: stable, derived only from rule + subject, never from date/order: `skill-desc-long-<skill>`, `skill-dup-<skill>-<source>`, `compact-window`, `mcp-new-<server>-<tool>`, `claudemd-grew-<user|vault>`, `mcp-deny-<server>`, `plugin-unused-<plugin>`, `spend-frontier-main`, `spend-cache-low`, `session-nested-<short sid>`, `session-runaway-<short sid>`. Slugs: lowercase, non-alnum -> `-`.
- `action.type` is `json_patch` (RFC 6902 subset: `add`, `replace`, `remove`, applied to the settings file) or `shell` (`{"type":"shell","argv":["rm","-r","<path>"]}`, argv array, never a shell string), or `flag` (no action; advisory only; `apply.sh` exits 6 for it).
- `est_saving_tokens`: integer >= 0, from manifest numbers (skill `tokens`, server `always_loaded_tokens`, etc.); flags use the rule table's "Est. saving" column (e.g. R4 tool tokens, R5 est_tokens delta).
- `command` is the exact human-runnable invocation.
- `proposals` sorted by `est_saving_tokens` desc, then `id` asc. Duplicates by `id` collapsed.
- Proposals already recorded in `applied.jsonl` (and not reverted) MUST be omitted. A proposal whose patch is already a no-op against the current settings MUST be omitted.

#### Rule table
| Rule | Id pattern | Trigger | Action | Est. saving |
|---|---|---|---|---|
| R1 | `skill-desc-long-<name>` | `user` or `project` skill (never `plugin:*`, never builtin) whose manifest listing `tokens` > 150 (strict). Skills are kept even when unused: they load lazily and only the listing costs tokens, so NO rule proposes turning a skill off for being unused. Uses no usage data | `flag`: "shorten the SKILL.md description" | `tokens` - 60 |
| R2 | `skill-dup-<name>-<source>` | Same skill `name` under 2+ sources. Only `user`/`project` copies are ever removed (keep `project` over `user`; a plugin copy is never removed, so a user/project copy duplicated by a plugin copy is removed). If every copy is a plugin copy -> advisory | `shell` rm of that copy's dir (user/project); `flag` ("disable via /plugin") when all copies are plugins | removed copy's `tokens`; 0 for flag |
| R3 | `compact-window` | `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` is null (fires only when unset) | `add /env/CLAUDE_CODE_AUTO_COMPACT_WINDOW = "400000"` | 0 (behavioural; note in evidence) |
| R4 | `mcp-new-<server>-<tool>` | Both manifests carry `tools` for the server, a tool name is new, AND the `mcp_tools` (non-deferred) category grew. Flag only | `flag` | tool tokens if known else 0 |
| R5 | `claudemd-grew-<user\|vault>` | CLAUDE.md `bytes` grew > 20% vs previous manifest (strict) | `flag` | `est_tokens` delta |
| R6 | `mcp-deny-<server>` | Connector (`kind: connector`) with 0 tool calls in 30 days and not already in `denied_mcp_servers` | `add /deniedMcpServers/-` value `{"serverName":"<server>"}` | `always_loaded_tokens` |
| R7 | `plugin-unused-<plugin>` | Enabled plugin whose `surfaces` is non-empty and a subset of `{skills, agents}` (plugins with hooks, mcp, commands or statusline are never "unused"), and none of whose skills, or agents (`Task` subagent_type `<plugin>:*`) were invoked in 30 days | `flag`: "disable via /plugin" | sum of the plugin's skill `tokens` |
| R8 | `spend-frontier-main` | Current ledger `spend_breakdown`: `frontier_share` > 0.70 AND `cost_share.subagent` < 0.30 (both strict; not evaluated when `total_est_usd` is 0) | `flag`: "delegate more work to cheaper subagents" | 0 (numbers in evidence) |
| R9 | `spend-cache-low` | `cache_hit_ratio` < 0.80 (strict; not when `null`) | `flag`: "investigate cache-busting (prompt prefix changes, long idle gaps)" | 0 (numbers in evidence) |
| R10 | `session-nested-<short sid>` | A `risky_sessions` entry with `nested_spawns` > 0 (strict) | `flag`: "subagents spawning subagents; constrain delegation depth" | 0; evidence: `nested_spawns`, `subagent_count`, session `est_usd` |
| R11 | `session-runaway-<short sid>` | A `risky_sessions` entry with `max_subagent_steps` > 100 OR `max_subagent_context` > 300000 (strict) | `flag`: "runaway subagent; cap steps and context" | 0; evidence: `worst_agent` steps, `max_context` and `est_usd` |
Notes:
- Skill usage = occurrences of a `Skill` tool_use with `input.skill == <name>` (or `input.skill == <plugin>:<name>` for a skill with source `plugin:<plugin>`) or a user message beginning `/<name>` in transcripts `$CLAUDE_HOME/projects/*/*.jsonl` and subagent transcripts `$CLAUDE_HOME/projects/*/*/subagents/*.jsonl` whose line `timestamp` is within 30 days before `--now`. Malformed JSONL lines are skipped and counted in `stats.malformed_lines`.
- MCP usage = `tool_use` names starting `mcp__<server-normalised>__`.
- Verified 2026-10-15: skill overrides do not affect plugin skills (per docs), and `"off"` removes a skill from the `/context` Skills table, whereas `"user-invocable-only"` skills are still listed and counted, so the loop never proposes either (see R1: unused skills are kept).
- R6/R7 MUST NOT fire if fewer than 14 days of transcripts exist (oldest transcript timestamp within 14 days of `--now`); emit `stats.insufficient_history: true`.
- Skills tagged `"protected": true` in an optional `<state>/protect.json` (`{"skills":[],"mcp":[]}`) MUST NOT be proposed.

Exit codes: 0 ok; 2 ledger missing/empty; 3 malformed ledger line (reports line number on stderr); 4 manifest referenced but missing.

### 4.3 Report and notification (run by `run.sh`, step after analyze)
Skipped silently (exit 0, log line) if `OBSIDIAN_VAULT_PATH` unset or directory missing. Path: `$OBSIDIAN_VAULT_PATH/Reports/Token Budget YYYY-Www.md`. Create `Reports/` if absent. If the file exists, re-run overwrites ONLY the block between `<!-- token-budget:begin -->` and `<!-- token-budget:end -->`; text outside is preserved. Never run git in the vault.

Required structure:
```markdown
---
type: report
date: 2026-10-19
week: 2026-W43
tags: [token-budget, bento, report]
overhead_tokens: 28700
delta_tokens: -1600
spend_weekly_usd: 61.8
spend_est_usd_7d: 7.4
proposals: 3
generated_by: bento-mods/tools/token-budget
---
# Token Budget 2026-W43

## For future agent
Weekly always-loaded token overhead report for [[Bento]]. Measured 2026-10-19 (CLI 2.1.88). Compare tokens, not percentages. Proposals are advisory; apply only via `tools/token-budget/apply.sh <id>`.

<!-- token-budget:begin -->
## Headline
overhead 28.7k (-1.6k), spend $61.80 this week, 3 proposals (as of 2026-10-19)

## Breakdown
| Category | Tokens | Delta |
...
## Spend breakdown
(table by family: input | output | cache_read | cache_creation | est. USD; total labelled "estimate (prices as of <asOf>)"; cache hit ratio; main vs subagent cost share; top 5 sessions as project | session (8 chars) | est. USD | dominant model; ccusage weekly USD beside the estimate, or "ccusage n/a"; window 7 days; then a `### Risky sessions` subsection: at most 5 `risky_sessions` by est. USD as project | session | est. USD | subagents | nested | max steps | max context | reasons, or "None")
## Regressions
(list with cause, or "None")
## Proposals
(table: id | est. saving | title | command; at most the top 20 proposals by the 4.2 sort order, followed by the line `+N more in proposals/<week>.json` when more exist)
## Applied since last report
(rows from applied.jsonl, or "None")
## Measurement notes
(warnings, ccusage missing, CLI version change)
<!-- token-budget:end -->
```
- Sections MUST appear in exactly that order with exactly those `##` headings.
- Every claim about external state carries a recency marker `(as of YYYY-MM-DD)`.
- At least one `[[Bento]]` wikilink in the body.
- `## Spend breakdown` MUST label dollar figures "estimate (prices as of YYYY-MM-DD)" and MUST NOT contain message text. `### Risky sessions` is the only H3 allowed and sits inside `## Spend breakdown` after its other content. If the ledger line lacks `spend_breakdown`, the section says "n/a".
- Headline format: `overhead <X.Xk> (<+|-><X.Xk>), spend $<N.NN>, <N> proposals`; `k` = value/1000 to 1 decimal; sign uses ASCII `-`/`+`; first run: `(baseline)` in place of the delta; unknown spend: `spend n/a`.
- Notification: `osascript -e 'display notification "<headline>" with title "Token Budget <week>"'` (headline sanitised of `"` and `\`). If regressions exist, prefix headline with `REGRESSION: `.

### 4.4 apply.sh
Usage: `apply.sh <proposal-id>` | `apply.sh --revert <proposal-id>` | `apply.sh --list`.
- Proposal is looked up by `id` in the newest `proposals/*.json` (by filename sort); not found -> exit 3.
- Applies EXACTLY ONE proposal per invocation. Multiple args -> exit 2.
- Never invoked by launchd, `run.sh`, or analyze.py. No flag or env var may enable auto-apply.
- Apply sequence: (1) if already applied and not reverted -> exit 0 with message `already applied`, no new backup, no new log line (idempotent). (2) copy settings file to `backups/settings.<UTC YYYYMMDDTHHMMSSZ>.json` (preserving mode). (3) apply ops to a temp file, validate it parses as JSON, atomic `mv` onto the settings file; other keys and key order preserved, 2-space indent. (4) append a line to `applied.jsonl`.
- `applied.jsonl` line:
```json
{"schema":1,"ts":"2026-10-19T09:30:00Z","action":"apply","id":"compact-window","backup":"backups/settings.20261019T093000Z.json","settings_file":"$HOME/.claude/settings.json","sha256_before":"...","sha256_after":"...","est_saving_tokens":0}
```
- `--revert <id>`: finds the latest `apply` line for id with no later `revert` line; restores that backup onto the settings file (atomic), appends `{"action":"revert","id":...,"restored_from":...}`. If the settings file's sha256 != `sha256_after` (changed since apply) -> exit 5 and change nothing unless `--force` is passed. If not applied (or already reverted) -> exit 0 with `not applied`, no write (idempotent).
- Apply patch semantics: `add` to an existing path with the same value = no-op (counts as already applied); `replace` on a missing path -> exit 4; array `-` append skips if an equal element exists; `add` creates missing parent objects (e.g. absent `env` or `skillOverrides`).
- `flag` proposals -> exit 6, message explains it is advisory. `shell` proposals print the argv and require `--yes`; without it exit 7 (no change).
- Exit codes: 0 ok / idempotent no-op; 1 unexpected error; 2 usage error; 3 proposal not found; 4 patch cannot apply; 5 revert refused (settings drifted) or backup missing; 6 advisory-only proposal; 7 confirmation required (`shell` without `--yes`); 8 settings file missing or invalid JSON (nothing written).
- Stdout is human text; with `--json` it prints one JSON object `{"status":"applied|already_applied|reverted|not_applied","id":...}`.

### 4.5 run.sh (orchestrator)
`run.sh [--catch-up]`: probe -> analyze -> report/notify -> write `last-run.json` `{"ts","week","status":"ok|failed","exit":N}`. Each stage failing stops later stages, logs to `logs/run.log`, and (if notifications enabled) sends `Token Budget failed: <stage>`. With `--catch-up`: runs when `last-run.json` is absent, has `status` other than `ok`, or its `ts` is before the most recent Monday 09:00 local (relative to `TOKEN_BUDGET_NOW`); otherwise exits 0 with log `catch-up: not needed` (AC 40 is normative).
Exit codes: 0 ok/no-op; 10 probe failed; 11 analyze failed; 12 report failed (non-fatal to ledger).

## 5. Schedule (launchd)
Label `${LABEL_PREFIX:-com.machine-setup}.token-budget`. Plist installed at `~/Library/LaunchAgents/${LABEL_PREFIX:-com.machine-setup}.token-budget.plist`, generated from the template by `install.sh` (substitutes absolute repo path and `$HOME`).
- `StartCalendarInterval`: `{Weekday: 1, Hour: 9, Minute: 0}` runs `run.sh`.
- Catch-up: one LaunchAgent; BOTH triggers (calendar and `RunAtLoad: true`) run `run.sh --catch-up` (fires at login/boot and on load). A Mac asleep at Monday 09:00 runs the missed job on wake via launchd calendar coalescing; `--catch-up` covers a powered-off Monday. Both paths call the same idempotent `run.sh`; a run for a week already present in the ledger with `status: ok` MUST NOT append a second ledger line unless `--force`.
- `ProgramArguments`: `/bin/bash -lc '<repo>/tools/token-budget/run.sh'` (login shell so `claude` and `ccusage` are on PATH). `StandardOutPath`/`StandardErrorPath` -> `<state>/logs/launchd.{out,err}`. `EnvironmentVariables` MUST NOT contain secrets.
- `install.sh`: create state dir (mode 700), render plist, `plutil -lint`, `launchctl bootstrap gui/$(id -u) <plist>`; idempotent (bootout first if loaded). Prints the label and next fire time.
- `uninstall.sh`: `launchctl bootout gui/$(id -u)/${LABEL_PREFIX:-com.machine-setup}.token-budget`, remove the plist, leave state dir and ledger intact unless `--purge`.
- Manual: `launchctl kickstart -k gui/$(id -u)/${LABEL_PREFIX:-com.machine-setup}.token-budget`; status: `launchctl print gui/$(id -u)/${LABEL_PREFIX:-com.machine-setup}.token-budget`.

## 6. Error handling
| Condition | Behaviour |
|---|---|
| `ccusage` missing/fails | spend `null`, warning `ccusage`, run succeeds |
| `claude` missing | probe exit 2, notification `Token Budget failed: probe`, nothing written |
| `/context` format unrecognised | probe exit 3; raw output saved to `logs/context-raw.<ts>.txt` (redacted); nothing appended |
| Network/API failure on trivial turn | probe exit 4; no partial ledger line |
| Vault unset/missing | report skipped, log line, exit 0 |
| Ledger line corrupt | analyze exit 3 with line number; never auto-repaired |
| Transcript JSONL malformed line | skip line, count in stats |
| Concurrent runs | `run.sh` takes `mkdir <state>/lock`; if held and holder PID alive -> exit 0 `already running`; stale lock (dead PID) is reclaimed |
| Settings file invalid JSON | apply exit 8; probe records `settings_error` warning and empty hooks/overrides |
| Crash mid-write | ledger/applied appends are single writes; settings changes are temp + atomic rename |
All failures MUST leave existing ledger, manifests, and settings byte-identical to before the failing step.

## 7. Known measurement pitfalls
1. `/context` lists ALL MCP tools in its detail table, deferred ones included. Only the category row "MCP tools" (as distinct from "MCP tools (deferred)") counts as always-loaded. Example: the 627 tokens measured on 2026-10-15 were the 3 claude.ai Claude Docs connector tools, not Bento's.
2. Setting `CLAUDE_CODE_AUTO_COMPACT_WINDOW` changes the displayed window (1M -> 200k), so the percentage columns shift. Compare token counts only; never store or compare percentages. Record `context_window` as context only.
3. `--plugin-dir` does not load under `claude -p`; the probe therefore measures installed/enabled plugins only. Dev-mode plugins are invisible to this loop.
4. `deniedMcpServers` entries print a "blocked by enterprise policy" line in output. This is expected; the parser ignores it (counted in `denied_mcp_notices`) and it MUST NOT be raised as an error or warning.
5. First turn in a fresh scratch dir may include cache-creation tokens that dwarf later turns; use `total_always_loaded` from `/context`, not trivial-turn usage, as the trend metric. Trivial-turn usage is a cross-check only.
6. Always run from an empty scratch dir; a repo CLAUDE.md or project `.claude/` would pollute `memory_files` and `skills`.
7. Transcripts repeat one API response across several lines (streaming/content blocks); summing lines without dedupe (4.1.4) inflates spend several-fold. Estimates also ignore 1h cache writes (priced as 5m), the Haiku >100k tier and per-version opus rows of `shared/prices.ts`; they will differ from `ccusage`.

## 8. Security
- MUST NOT read, write, copy, or log credentials: no `~/.claude/.credentials*`, keychain, `.env`, `~/.config/*/auth*`, OAuth tokens, or MCP server `env`/`headers` values.
- When reading settings/`.mcp.json`, extract only: server names, kind, and enabled/denied status. Never emit `env`, `headers`, `args` containing `--token`/`--key`, or URLs with query strings.
- No tokens or keys in the ledger, manifest, proposals, report, logs, or notification. Redaction pass (applied to every string written to disk): replace matches of `(?i)(api[_-]?key|token|secret|password|authorization|bearer)\S*` with `[REDACTED]` and any `(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}` (must not fire inside ordinary names such as `planning-and-task-breakdown`; skill, plugin and server names are never redacted)/`ghp_...`/`xox[a-z]-...` patterns with `[REDACTED]`.
- Hook commands are truncated and redacted; MCP server configs are never serialised wholesale.
- Transcripts are read locally for tool-name, slash-command counts and, for 4.1.4, `message.usage`/`message.model`/ids/timestamps only; no message text is stored or output.
- The only network use is the two Haiku calls (via `claude`) and whatever `ccusage` does locally.
- State dir mode 700; files 600. `apply.sh` writes only: the settings file, `backups/`, `applied.jsonl`.
- Report goes to the vault only; never git add/commit/push in the vault or repo.

## 9. Acceptance criteria
Tests use fixtures: fake `claude` and `ccusage` executables (via the `TOKEN_BUDGET_*_BIN` vars), fixture `/context` outputs, fixture transcripts, a temp state dir and temp vault.

Probe
1. Probe invokes the fake `claude` exactly twice, both with `--model haiku`; the second with `--output-format json`.
2. Probe's cwd for both invocations is an empty dir that is deleted afterwards.
3. A ledger line is appended matching the 4.1.3 schema; the file gains exactly 1 line; prior lines unchanged.
4. `total_always_loaded` equals the `/context` header "Tokens: X / Y" used value X (includes messages); `context_window` equals Y; `category_sum_check` equals the sum of non-deferred, non-free, non-buffer categories; a fixture differing by more than 2% yields warning `category_sum_mismatch`. Deferred MCP tools listed in the detail table do not affect `mcp_tools` (pitfall 1).
5. Tokens written as `1.2k`, `627`, `12,345` parse to 1200, 627, 12345; per-skill `< 20` parses to 10 and `~110` to 110. Rows "MCP server instructions" and "System tools (deferred)" map to `mcp_server_instructions` and `system_tools_deferred`.
6. With `ccusage` absent, probe exits 0, `spend.daily_usd` and `spend.weekly_usd` are `null`, and `warnings` contains `"ccusage"`.
7. "blocked by enterprise policy" lines do not cause non-zero exit and increment `denied_mcp_notices`.
8. Unparseable `/context` -> exit 3 and ledger unchanged.
9. Manifest conforms to 4.1.2: arrays sorted, `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` is `null` when unset and `"400000"` when set, `denied_mcp_servers` populated from settings.
10. A fixture settings file containing `"env":{"X_API_KEY":"sk-abc12345678"}` or MCP `headers` yields no occurrence of the secret strings anywhere in state dir output.
11. `--dry-run` writes no files.

Analyze
12. Same fixtures + same `--now` give byte-identical output across two runs.
13. `delta_tokens` of exactly +1000 yields no `overhead_up`; +1001 does, with a `cause` naming the largest category.
14. A new skill, MCP server, or plugin in the manifest each produce `new_skill`/`new_mcp`/`new_plugin` even if overhead is flat.
15. Only one ledger line: `baseline: true`, `regressions: []`.
16. R1: `user`/`project` skill with listing `tokens` 151 -> `flag` proposal `skill-desc-long-<name>` with `est_saving_tokens` 91; exactly 150 -> none; plugin skills -> none. No proposal of any kind contains a `skillOverrides` patch or "off", regardless of usage data (also with no transcripts at all).
17. R6/R7 suppressed with `stats.insufficient_history: true` when transcripts span < 14 days; R1, R8, R9 are unaffected by that guard.
18. R2: a skill name in two sources yields removal proposals for non-preferred copies only, following the stated source priority; only `user`/`project` copies get `shell` removals; all-plugin duplicates give a `flag`.
19. R3: unset window -> `compact-window` proposal with value `"400000"`; set to any value -> none.
20. R4: a new tool name in `tools` with `mcp_tools` category grown -> `flag` proposal; new name with `mcp_tools` unchanged -> none; `tool_count` growth without `tools` -> none.
21. R5: CLAUDE.md grown 20% exactly -> none; 21% -> `claudemd-grew-*`.
22. R6: connector with 0 calls in 30 days -> `mcp-deny-<server>`; already denied -> none.
23. Proposals match the 4.2 schema, ids are stable across runs with different `--now` for the same subject, and are sorted by saving desc then id.
24. Already-applied (not reverted) and no-op proposals are omitted.
25. analyze.py imports no network/LLM modules and makes no subprocess calls (static check of imports acceptable).

Report
26. With vault set, `Reports/Token Budget 2026-W43.md` exists with frontmatter keys type, date, week, tags; `## For future agent` is the first H2; the other H2s follow the 4.3 order (Headline, Breakdown, Spend breakdown, Regressions, Proposals, Applied since last report, Measurement notes); contains `[[Bento]]` and at least one `(as of YYYY-MM-DD)`.
27. Headline matches `overhead 28.7k (-1.6k), spend $61.80, 3 proposals` form for fixture values; first run shows `(baseline)`.
28. Re-run preserves text outside the begin/end markers and replaces inside; no duplicate sections.
29. Vault unset or missing -> exit 0, no file created anywhere.
30. With `TOKEN_BUDGET_NOTIFY=0`, stdout contains one `NOTIFY: ` line with the headline; no `osascript` invocation.
31. No `.git` change in vault (git status/log identical before and after).

Apply
32. `apply.sh compact-window` creates exactly one new backup, modifies only the targeted key (rest of settings semantically identical), appends one `applied.jsonl` line, exits 0.
33. Running the same apply twice: second call exits 0, creates no backup, appends no line, leaves settings unchanged.
34. `apply.sh --revert compact-window` restores settings byte-identical to the pre-apply file, appends a `revert` line, exits 0; repeating it exits 0 with no change.
35. Revert after the settings file was edited by hand -> exit 5, settings untouched; with `--force` it restores.
36. Unknown id -> exit 3; two ids -> exit 2; `flag` proposal -> exit 6; `shell` proposal without `--yes` -> exit 7 and no change; invalid settings JSON -> exit 8 and no change.
37. Failure at any step leaves settings byte-identical (simulate with unwritable backup dir).
38. No code path other than a human `apply.sh <id>` invocation modifies the settings file (run `run.sh` end-to-end against fixtures; settings sha256 unchanged).

Schedule
39. `install.sh` produces a plist that passes `plutil -lint`, has label `${LABEL_PREFIX:-com.machine-setup}.token-budget` (`com.machine-setup.token-budget` when `LABEL_PREFIX` is unset), `StartCalendarInterval` Weekday 1 Hour 9 Minute 0, and `RunAtLoad` true (test with `--render-only` writing to a given path, no `launchctl`).
40. `run.sh --catch-up` runs when `last-run.json` is absent or older than the most recent Monday 09:00 (using `TOKEN_BUDGET_NOW`), and is a no-op otherwise.
41. Two `run.sh` runs in the same ISO week append only one ledger line unless `--force`.
42. `uninstall.sh --render-only`/dry mode lists removal of the plist and leaves state intact; `--purge` is the only way state is deleted.
43. R7: a plugin with no skill/agent/MCP invocation in 30 days -> `plugin-unused-<plugin>` `flag` proposal (apply exits 6); a plugin with one skill invocation 29 days ago -> none.
44. Real captures `context-{before,after,after2}.txt` (see Decisions 1) parse without error and satisfy AC 4.
45. R7: a plugin with `surfaces: ["hooks","skills"]` (or mcp, commands, statusline) and 0 invocations in 30 days -> no `plugin-unused-*`; a skills-only plugin with 0 invocations -> proposal; with `surfaces: []` -> none. Manifest `surfaces` detection works for each marker in 4.1.2 (fixture plugin dirs).
46. Spend dedupe: a fixture with the same `(message.id, requestId)` on 3 lines (also split across a main and a subagent file) counts once, keeping the greatest `output_tokens`; `duplicates_dropped` = 2; a line with no ids is never dropped.
47. Spend math: fixture with one opus message (input 1,000,000, output 100,000, cache_read 2,000,000, cache_creation 200,000) gives `est_usd` 7.4 under the seed prices; per-family sums are correct across fable/opus/sonnet/haiku/other (e.g. `claude-foo-1` -> other); `<synthetic>` and lines older than 7 days are excluded; `TOKEN_BUDGET_PRICES` override changes the result and an invalid one warns `prices_override_invalid`.
48. `cache_hit_ratio` = cache_read / (input + cache_read + cache_creation) (the 47 fixture gives 0.6250); `null` with no data.
49. `cost_share` main/subagent matches fixture files under and outside `subagents/`; `top_sessions` has at most 5 entries ordered by `est_usd` desc then project then session, includes subagent cost in the parent session, `session` is 8 chars, and none of the output (ledger, report) contains any fixture message text or prompt.
50. R8: `frontier_share` 0.70 -> none, 0.71 with subagent share 0.29 -> `spend-frontier-main`; subagent share 0.30 -> none. R9: ratio 0.80 -> none, 0.79 -> `spend-cache-low`; `null` -> none. Both are `flag`, saving 0, with the numbers in `evidence`; both skipped when `total_est_usd` is 0.
51. Report `## Spend breakdown` lists all five families, the label "estimate (prices as of ...)", the cache ratio, main/subagent shares, the top sessions, and ccusage weekly beside the estimate (or "ccusage n/a").
52. Nested detection: a fixture subagent file containing an `Agent` tool_use increments `nested_spawns` of its session (distinct tool_use ids; the same message duplicated across lines counts once); an `Agent` tool_use in the main file does not; a session with 0 gives no R10.
53. Boundaries: a subagent with 100 steps and max context 300000 -> no R11; 101 steps -> R11 (`reasons` has `steps`); context 300001 -> R11 (`reasons` has `context`); steps/context are computed on deduped messages (a fixture with 101 lines but 100 unique messages -> no R11); context = input + cache_read + cache_creation.
54. R10/R11 are `flag` proposals (saving 0, `apply.sh` exit 6) with ids `session-nested-<8 chars>` / `session-runaway-<8 chars>`, evidence containing the counts and cost; the session appears in `risky_sessions` and in the report's `### Risky sessions` (max 5, est. USD desc).
55. No-text rule: fixture transcripts containing a unique marker string in message text/prompts/tool inputs -> the marker appears nowhere in the ledger, proposals, report or logs; sessions are identified only by project dir name + 8-char id.
56. `LABEL_PREFIX` env overrides the label prefix for `install.sh` and `uninstall.sh`: with `LABEL_PREFIX=com.example.me`, `install.sh --render-only` renders a plist whose label is `com.example.me.token-budget` (and `uninstall.sh` dry mode targets `com.example.me.token-budget` and `~/Library/LaunchAgents/com.example.me.token-budget.plist`); with it unset, both use `com.machine-setup.token-budget`.

## 10. Decisions (2026-10-15)
1. `/context` is parsed as text, with versioned fixtures (`fixtures/context/<cli-version>/`). The orchestrator copies the real 2026-10-15 captures (`context-before.txt`, `context-after.txt`, `context-after2.txt`) into `~/CodeBase/bento-mods-tests/token-budget/fixtures/context/`.
2. Skill overrides: plugin skills are unaffected by `skillOverrides`; `"off"` removes a skill from the Skills table while `"user-invocable-only"` does not (measured 2026-10-15). Amendment (the user, 2026-10-15): skills are kept even when unused (lazy loading; only the listing costs tokens), so no rule proposes turning a skill off. R1 is now `skill-desc-long` (flag, > 150 tokens). R7 only considers skills/agents-only plugins. Spend breakdown (4.1.4, R8, R9) added.
3. Thresholds (30-day usage window, 14-day minimum history for R6/R7; 7-day spend window) are fine.
4. `weekly_usd` comes from `ccusage weekly`.
5. Regression notification is a standard banner (no persistent alert).
6. The ledger is kept forever (no rotation).
7. Auto-compact window value is 400000.

## 11. Open questions
1. R2 wording: for a user copy duplicated by a plugin copy, this spec removes the user copy (the only removable one); plugin-vs-user priority is otherwise unspecified. Confirm.
2. `ccusage weekly` week boundary may differ from the ISO `week` id; the ledger stores its value as-is. Confirm acceptable.

## Handoff health (2026-10-16)
Draft for approval. Why: compaction plus handoff is what long jobs depend on; the weekly report is the one place the user already reads, so a DEGRADED handoff rate or a failing nightly canary must show up there (specs/handoff-hooks-spec.md "F36 Handoff reliability" defines the log and the canary). Amends 4.1.3 (ledger line), 4.2 (inputs, rule table), 4.3 (report structure) and 9 (ACs 57+).

### H.1 Input and ledger
`analyze.py` gains an optional input `--handoff-health <path>` (default `$HOME/.local/state/claude-handoffs/health.jsonl`; test override env `HANDOFF_HEALTH_FILE`). The file is JSONL (hook spec F36.B): compaction lines (have `agent_file`) and canary lines (`trigger: "canary"`). Lines that fail to parse, lack `ts`, or have `canary_child` true are ignored (counted in `ignored`). Window = the same 7 days as `spend_breakdown` (`ts` >= now - 7 days, UTC). Missing or unreadable file: `handoff_health` is `null`, `warnings` gains `"handoff-health"`, exit stays 0. The ledger line gains an optional key `handoff_health` (absent in old lines; readers tolerate absence; `schema` stays 1):
```json
"handoff_health": {"window_days": 7, "compactions": 12, "auto": 10, "manual": 2, "ok": 8, "reduced": 1, "degraded": 3, "degraded_rate": 0.25,
  "agent_file": {"fresh": 8, "stale": 1, "absent": 3},
  "fallback": {"skipped": 8, "ok": 2, "failed": 1, "timeout": 0, "disabled": 1},
  "errors_total": 0, "truncated": 2,
  "top_reasons": [{"reason": "agent_absent", "count": 2}, {"reason": "agent_stale", "count": 1}, {"reason": "fallback_failed", "count": 1}],
  "canary": {"pass": 6, "fail": 1, "skip": 0, "nights": [{"date": "2026-10-13", "result": "pass"}], "last_ts": "2026-10-19T03:41:02Z"},
  "ignored": 0}
```
- `compactions` = compaction lines in the window; `auto`/`manual` count `trigger` (other values only in the total). Status per line is RECOMPUTED from fields (hook spec F36.D; old lines without a `status` key work, and no `status`/`degraded` key is trusted): `degraded` iff `errors` non-empty OR `stale_sections` non-empty OR (`agent_file != "fresh"` AND `fallback in {"failed","timeout","disabled"}`); else `reduced` iff `agent_file != "fresh"` AND `fallback == "ok"`; else `ok`. `ok + reduced + degraded = compactions`. `degraded_rate` = degraded / compactions rounded to 4 places; `null` when `compactions` is 0. `reduced` is counted and reported but never part of `degraded_rate` and never fires R12 (user decision 2026-10-16).
- `top_reasons`: reason codes per DEGRADED line only (`agent_absent`, `agent_stale` (stale file or non-empty `stale_sections`), `fallback_failed`, `fallback_timeout`, `section_error:<name>` per name in `errors`; a line contributes one count per code it has), at most 3, sorted by count desc then code; codes are the only strings (no text, no ids). Reduced lines contribute no reasons.
- `canary`: counts of canary lines in the window by `result`; `nights` = at most the last 7 calendar days (local date of `ts`, newest last) one entry per date: the LAST canary line of that date wins; dates without a line are omitted; `last_ts` = the newest canary `ts` in the whole file (not only the window), `null` if none ever.
- No message text, paths, cwd, session ids or exception messages in `handoff_health` (only counts, dates, codes).

### H.2 Report subsection (amends 4.3)
`### Handoff health` is added INSIDE `## Regressions`, as the last content of that section (the section's own list or the literal `None` for overhead regressions comes first and is not affected). The "only H3" rule in 4.3 is amended: the allowed H3s are exactly `### Risky sessions` (inside `## Spend breakdown`, after its other content) and `### Handoff health` (inside `## Regressions`, after its other content); each appears at most once, only in that section. Content, in this order:
1. A one-line summary: `compactions <N> (auto <a>, manual <m>), ok <o>, reduced <r>, degraded <d> (<P>%), window 7 days (as of YYYY-MM-DD)`; `<P>` = `degraded_rate` x 100 rounded to 1 decimal (reduced is not in it); `degraded n/a` (with `ok 0, reduced 0`) when 0 compactions.
2. `fallback: ok <n>, failed <n>, timeout <n>, skipped <n>, disabled <n>` and `agent file: fresh <n>, stale <n>, absent <n>` (one line each).
3. `canary: <pass> pass / <fail> fail / <skip> skip in the last 7 nights` followed by a one-line strip of the nights, oldest first, as `YYYY-MM-DD pass|fail|skip` joined by ` · `; `canary: no runs recorded` when `last_ts` is null; if the newest canary `ts` is more than 3 days before `now`, append `(last run <date>, stale)`.
4. `top reasons: <code> x<n>, ...` or `top reasons: none`.
When `handoff_health` is `null` (no/unreadable file) the subsection is still present with the single line `n/a`. When there are 0 compactions and 0 canary lines it says `no data in window`. If R12 fired, the line `FLAG handoff-degraded: <trigger names>` follows the other lines. The subsection MUST NOT contain message text. The recency marker `(as of YYYY-MM-DD)` appears once, in the summary line. The headline (4.3) and the notification are unchanged.
Required ordering stays: Headline, Breakdown, Spend breakdown, Regressions (with the new H3), Proposals, Applied since last report, Measurement notes.

### H.3 Rule R12 (amends the rule table of 4.2)
| Rule | Id | Trigger | Action | Est. saving |
|---|---|---|---|---|
| R12 | `handoff-degraded` | Current ledger `handoff_health` is non-null AND ANY of: (a) `compactions` > 0 and `degraded * 10 > compactions` (degraded rate strictly > 10%, integer arithmetic); (b) `canary.fail` >= 1 in the window; (c) a canary has ever run (`canary.last_ts` non-null) but the newest canary `ts` is more than 3 days before `now` (the nightly job silently stopped). One proposal per run, not per trigger | `flag`: "handoff reliability degraded; check handoff health and the canary" | 0; evidence: `compactions`, `degraded`, `degraded_rate`, `canary_fail`, `canary_last_ts`, `top_reasons`, `triggers` (array of `rate`, `canary_fail`, `canary_stale`, in that order) |
- Trigger (c) is an addition beyond the two conditions requested, so that a dead canary cannot fail silently; drop it if unwanted.
- `flag` proposals follow the 4.2 schema, `apply.sh` exit 6, ids stable; R12 is not suppressed by `insufficient_history` (it reads the health log, not transcripts).
- No minimum-sample guard (1 degraded of 1 compaction = 100% flags); the evidence carries the counts (open question 1).
- Exactly 10.0% degraded does not fire (strict). 0 compactions with no canary failure does not fire. `handoff_health` null: no R12.
- Canary `skip` alone never fires R12 (it is reported in the strip).
- `reduced` compactions never count in (a): 10 compactions of which 10 are reduced and 0 degraded do not fire. R12 counts only degraded compactions, canary failures and a canary not run for more than 3 days.

### H.4 Acceptance criteria (continuing 9; fixtures under `fixtures/handoff-health/`, `--now` fixed)
57. Parsing: a fixture `health.jsonl` with 12 in-window compaction lines (mix of fresh/stale/absent, ok/failed/disabled, auto/manual), 2 older than 7 days, 1 malformed line, 1 line with `canary_child:true`, and 7 canary lines yields `handoff_health` with `compactions` 12, counts exactly matching a hand-computed table, `ignored` 2, and `ok`/`reduced`/`degraded` per the recomputed definition (a line with `errors:["git"]` and everything else healthy is degraded; `agent_file:"absent"` + `fallback:"ok"` is REDUCED; `absent` + `failed`/`timeout`/`disabled` is degraded; `stale` with non-empty `stale_sections` + `ok` is degraded; `stale` with `stale_sections:[]` + `ok` is reduced); `ok + reduced + degraded` equals `compactions`; a line whose own `status` key disagrees with its fields is classified by the fields.
58. `degraded_rate` = degraded/compactions to 4 places (reduced lines not counted in the numerator); `null` when no compactions in window; `top_reasons` has at most 3 entries, ordered by count desc then code asc, uses `section_error:<name>` per name, and contains no other strings; reduced lines add no reasons.
59. Canary strip: for a night with two canary lines the later one wins; nights without a line are omitted; at most 7 nights, oldest first; `last_ts` is the newest canary line overall even if outside the window; `pass/fail/skip` counts cover in-window lines.
60. Missing health file: ledger line has `handoff_health: null`, `warnings` contains `"handoff-health"`, exit 0, report subsection is exactly `### Handoff health` followed by `n/a`, no R12. Unreadable (a directory in place of the file) behaves the same. A ledger written before this feature (no key) is readable by analyze/report without error and shows `n/a`.
61. Report structure: with data, `## Regressions` contains the overhead list (or `None`) first, then `### Handoff health` with the lines of H.2 in order (summary, fallback, agent file, canary, top reasons); the order of all other H2 sections is unchanged; the only H3s in the whole report are `### Risky sessions` and `### Handoff health`; the summary line matches `^compactions \d+ \(auto \d+, manual \d+\), ok \d+, reduced \d+, degraded \d+ \(\d+(\.\d)?%\), window 7 days \(as of \d{4}-\d\d-\d\d\)$` (or `degraded n/a` form); any earlier AC that asserted "no H3 other than Risky sessions" (AC 26) is updated accordingly.
62. No-text rule (AC 55 extended): a unique marker placed in every string field of the health fixture (including unknown extra keys, `sid`, `reason`) appears nowhere in the ledger, proposals, report or logs; the subsection contains only digits, dates, the fixed words and reason codes.
63. R12 (a): 10 compactions with 1 degraded (10.0%) -> no R12; 10 with 2 degraded -> R12 with `triggers:["rate"]`; 1 compaction 1 degraded -> R12; 0 compactions -> none from (a); 10 compactions all reduced -> none; 10 compactions with 8 reduced and 2 degraded -> R12 (rate is degraded only). Integer arithmetic: 20 compactions 2 degraded -> none; 21 with 3 -> R12.
64. R12 (b): any in-window canary line with `result:"fail"` -> R12 with `canary_fail` in `triggers`, even with 0 compactions; a canary fail dated 8 days ago -> none from (b); only `skip` lines -> none.
65. R12 (c): newest canary `ts` exactly 3 days before `now` -> none; 3 days plus one second -> `canary_stale`; no canary line ever -> none; several triggers together are listed in the order `rate`, `canary_fail`, `canary_stale`.
66. R12 proposal shape: id `handoff-degraded`, action `flag`, saving 0, evidence keys as in the table; `apply.sh handoff-degraded` exits 6 with no change; one proposal even when all three triggers fire; it appears in `## Proposals` in the 4.2 sort order and counts in the headline's `N proposals`; the report subsection shows the `FLAG handoff-degraded:` line with the same trigger names; no R12 when `handoff_health` is null.
67. Determinism and idempotence: same fixtures and `--now` give byte-identical output across two runs (AC 12 extended); a re-run in the same ISO week keeps one ledger line (AC 41) and replaces the subsection inside the markers without duplicating it (AC 28); vault unset -> exit 0, no file (AC 29).
68. `analyze.py` still imports no network/LLM modules and makes no subprocess calls (AC 25) with the new reader; the health reader performs only reads.

### H.5 Open questions
(1) A minimum-sample guard for R12 (a) (for example >= 5 compactions) is a candidate once the first weeks of data exist. (2) A reduced-rate report threshold or flag is not defined (reduced is reported only; decided 2026-10-16); add one if the weekly counts show reduced creeping up. (3) Whether `skip` nights (claude missing or logged out) should themselves raise a flag after N consecutive nights. (4) Retention: `health.jsonl` rotates at 5000 lines (hook spec F36.B); the ledger keeps the weekly `handoff_health` summary forever (Decision 6).

## Vault path under launchd (2026-10-20)

launchd does not load the user's shell env, so the weekly job saw `OBSIDIAN_VAULT_PATH` unset and logged `report: skipped (OBSIDIAN_VAULT_PATH unset or missing)`. Claude Code users usually set the variable in `~/.claude/settings.json` under `env`.

69. When `OBSIDIAN_VAULT_PATH` is unset or empty, the entry script reads `env.OBSIDIAN_VAULT_PATH` from `$HOME/.claude/settings.json` (JSON; missing file, invalid JSON, missing key or a non-string value = still unset, no error). A leading `~/` is expanded to `$HOME/`. A non-empty environment value always wins. The value is exported before the run starts, so the report step sees it. The log line on skip is unchanged.
