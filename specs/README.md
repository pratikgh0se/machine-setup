# bento-mods build specs, batch 1

Written 2026-10-11 for Claude Code 2.1.295. Specs only: no plugin code exists yet.

**Status: specs closed 2026-10-11, ready to build.** All 18 questions are decided (each spec ends with a "Decisions (closed 2026-10-11)" section) and `$.process.run` is CONFIRMED to work in desktop-hosted sessions. Build order is under "Effort and build order" below. Decisions: `../research/09-decisions.md`. Board: `../research/brainstorm/mod-ideas.html`.

## Index
| File | What |
|---|---|
| `00-conventions.md` | Shared rules: layout, shared code, state, hook discipline, band composition, look, glyphs, toasts, process rules, privacy, test method |
| `usage.md` | Burn Meter, Cache Clock, Compaction Alert |
| `awareness.md` | Heads-Up (with Long Command Timer), Now Doing, Spec Tracker, Focus Timer |
| `agents.md` | Pets in Still Room (evolves agent-pets, renamed `agents`), Review Queue, Delegation Guard |
| `safety.md` | Protected Files, Auto-checkpoint |
| `dev.md` | PR Radar, Git chip, Session Diff, Test Pulse, Coverage Delta, Typecheck Feedback, Port Watch |

Source key. `T:n` = line n of `/private/tmp/claude-501/bundled-skills/2.1.295/b95d2396645c087f8b3e5ac4a3ca78fa/plugin-authoring/types/claude-code.d.ts`. `R:n` = line n of `.../plugin-authoring/reference.md`. `AP:` = `plugins/agent-pets/`. Line numbers belong to build 2.1.295; the file is regenerated, so re-grep the symbol if a number misses.
Status: CONFIRMED (typed and cited, or proven by running code), CONFIRMED (process-exec) (runs through `$.process.run`, T:3515; the types doc says "CLI only" T:3493, but a live probe on 2026-10-11 ran `git --version` from a `tool.call` hook in a desktop session with exitCode 0, so it works on both hosts; command shown; locally checked where noted), UNVERIFIED (no type evidence; the spec names a fallback).

## Feasibility table
| Plugin / mod | Data source or capability | Status | Evidence |
|---|---|---|---|
| usage / Burn Meter | 5h and 7d percent and resetsAt, pushed | CONFIRMED | `session.measure` T:4415, T:11095; `SessionRateLimit` T:11282 |
| usage / Burn Meter | Pull read at start | CONFIRMED | `$.session.usage()` T:2846, T:11704 |
| usage / Burn Meter | Session cost USD | CONFIRMED | `SessionCost` T:10980 |
| usage / Burn Meter | Gateway `spend_limit` window | CONFIRMED | kind string T:11287 (gateway only) |
| usage / Burn Meter | Per-model weekly buckets (Opus, Sonnet) | UNVERIFIED | no field in `SessionRateLimit`; not shown |
| usage / Burn Meter | Windows are exactly 5 h and 7 d (start = resetsAt - length) | UNVERIFIED | `03-usage-and-cache.md`; reset-jump guard in spec |
| usage / Burn Meter | Sample history across sessions | CONFIRMED | `$.store` T:3351, `keys()` T:3374; concurrent-write atomicity is UNVERIFIED (per-session keys used) |
| usage / Cache Clock | Main request start time | CONFIRMED | `turn.step` T:13430 + `$.clock.now` T:3426 |
| usage / Cache Clock | Cache read/creation tokens per request | CONFIRMED | step result `usage` T:13530, `ModelUsage` T:6440 |
| usage / Cache Clock | See cache-tax pings | CONFIRMED | `model.fork` event T:6855 |
| usage / Cache Clock | TTL from model-switch events | CONFIRMED | `cache_ttl` T:7825, T:7911 (only at a switch) |
| usage / Cache Clock | TTL from settings `promptCacheTtl` | UNVERIFIED | key named only in cache-tax README; `$.settings.read` T:3578; used only after the sources below |
| usage / Cache Clock | cache-tax installed? (`enabledPlugins` key `cache-tax@...`) | CONFIRMED | `$.settings.read` T:3560-3578, the user's settings.json line 161 |
| usage / Cache Clock | TTL follows cache-tax (1h constant, optional `pluginConfigs` option) | CONFIRMED | `TTL_MS` in cache-tax 2.2.1 `register.ts:4`; no userConfig, no `types/`, no `$.state`, so no dependency |
| usage / Cache Clock | cache-tax keepwarm status (pings, `/keepwarm` observed) | UNVERIFIED | its state is private `$.store` (T:3345); pings via `model.fork` T:6855 are CONFIRMED, observing another plugin's `command.run` is not; fallback `KEEPWARM unknown` |
| usage / Cache Clock | Live `prompt_cache.expires_at` | UNVERIFIED | statusline field, not exposed in T; expiry is computed |
| usage / Cache Clock | Cold flag and exact re-cache cost at resume | CONFIRMED | `classic.SessionStart` T:11660, T:11664 |
| usage / Cache Clock | Re-cache and savings dollars from a price table | UNVERIFIED | prices are estimates; dated table seeded from savvy-progress `register.tsx:299-305` |
| usage / Cache Clock | Pom still as `data:` image inside `<Svg>` | UNVERIFIED | `SvgProps` T:12272 says drawn as image, scrub strips scripts only; fallback block mark |
| usage / Cache Clock | Pom still in terminal | CONFIRMED | `Image` T:5315 (kitty/Ghostty only) |
| usage / Compaction Alert | Context tokens and percent | CONFIRMED | `SessionContextUsage` T:10950 |
| usage / Compaction Alert | Auto-compact threshold and on/off | CONFIRMED | `breakdown.autoCompactThreshold` T:10928, `isAutoCompactEnabled` T:10932 via `usage({breakdown:'summary'})` |
| usage / Compaction Alert | Compaction event | CONFIRMED | `session.compact` T:10795 |
| awareness / Heads-Up | Toast | CONFIRMED | `$.ui.toast` T:2447 (text + timeout only; mockup action buttons NOT possible) |
| awareness / Heads-Up | Emoji or not by surface | CONFIRMED | `$.session.surfaces()` T:2816 |
| awareness / Heads-Up | Idle detection | CONFIRMED | `turn.start` T:13374, `turn.complete` T:13324, `prompt.submit` T:9051 |
| awareness / Heads-Up | Weekly pace hot | CONFIRMED | `session.measure` T:4415 |
| awareness / Heads-Up | Cache expiring while idle | CONFIRMED | events above; TTL source rows under usage / Cache Clock |
| awareness / Heads-Up | Tool output huge | CONFIRMED | Bash `persistedOutputSize` T:20386, result `text` |
| awareness / Heads-Up | Long Command Timer (foreground) | CONFIRMED | hook awaits `next` T:12665 + `$.clock.after` T:3426 |
| awareness / Heads-Up | Background command finished | UNVERIFIED | `backgroundTaskId` T:20362; completion only as a `UserMessage` row T:8892 |
| awareness / Heads-Up | Context above 80 percent | CONFIRMED | T:10950 |
| awareness / Heads-Up | Subagent without explicit model | CONFIRMED | `agent.spawn.model` T:303 |
| awareness / Heads-Up | Ollama down, HTTP probe to localhost | UNVERIFIED | `$.http.fetch` T:3490; web-fetch policy for localhost unknown; no timeout option |
| awareness / Heads-Up | Ollama down, curl fallback | CONFIRMED (process-exec) | `curl -s -m 2 -o /dev/null -w %{http_code} http://127.0.0.1:11434/api/version` |
| awareness / Heads-Up | Vault configured | CONFIRMED | `$.env.get` T:3598, `$.fs.stat` T:3321 |
| awareness / Now Doing | Phase from main-thread tool calls | CONFIRMED | `tool.call` T:12665, `agentId` T:194, `isReadOnly` T:12759 |
| awareness / Now Doing | Checklist from TodoWrite/TaskCreate/TaskUpdate | CONFIRMED | `AP:hooks/register.tsx:243-300`; inputs T:16699-16745 |
| awareness / Now Doing | Model-callable phase tool | CONFIRMED | `$.tool.register` T:3003 |
| awareness / Now Doing | Waiting-on-agents sentence | CONFIRMED | `$.agent.list()` T:3187 |
| awareness / Spec Tracker | Read plan file and mtime | CONFIRMED | `$.fs.read` T:3242, `$.fs.stat` T:3321 |
| awareness / Spec Tracker | Watch the file for changes | UNVERIFIED | `classic.FileChanged` T:4811; how to register watch paths unknown; spec re-reads on edit and turn end |
| awareness / Focus Timer | Timers, persistence | CONFIRMED | `$.clock` T:3426, `$.store` T:3351 |
| awareness / Focus Timer | Native notification | CONFIRMED | `$.ui.notify` T:2465 |
| awareness / Focus Timer | Chime | CONFIRMED | `$.audio.play` T:2677 (macOS `afplay`; asset must be shipped) |
| agents / Pets | Spawn, list, turn events | CONFIRMED | T:264, T:3187, T:13324; proven by `AP:hooks/register.tsx` |
| agents / Pets | Pom/Carrot stills in `<Svg>` | UNVERIFIED | same as the usage / Cache Clock row |
| agents / Pets, Delegation Guard | Per-step usage with model id | CONFIRMED | T:13530, `TurnUsage.model` T:13656 |
| agents / Pets, Delegation Guard | Price table for tier spend | UNVERIFIED | estimates; `delegation.pricesJson` override |
| agents / Review Queue | Subagent tool calls identify their loop | CONFIRMED | `AgentLoop.agentId` T:194; model-spawned subagents only |
| agents / Review Queue | Test outcome from subagent Bash output | CONFIRMED | T:20352 + shared parser |
| agents / Review Queue | Agent end and usage | CONFIRMED | `turn.complete` T:13324, T:13315 |
| agents / Delegation Guard | Missing `model` on the Agent call | CONFIRMED | `AgentSpawnInput.model` T:303; Agent tool input T:15996 |
| agents / Delegation Guard | Deny a spawn | CONFIRMED | `AgentSpawnResult.deny` T:433 |
| agents / Delegation Guard | Agent definition's own pinned model | UNVERIFIED | not on the event; `allowTypes` globs instead |
| agents / Delegation Guard | Session total cost cross-check | CONFIRMED | T:10980 |
| safety / Protected Files | Write, Edit, NotebookEdit path fields | CONFIRMED | T:16792, T:16278, T:16402 |
| safety / Protected Files | MultiEdit | UNVERIFIED | no such tool in 2.1.295 types; matched by name string if a build has it |
| safety / Protected Files | Deny result | CONFIRMED | `ToolCallResult.deny` T:12710 |
| safety / Protected Files | Symlink-safe path resolution | CONFIRMED | `$.fs.stat({resolve:true})` T:3321, example R:165 |
| safety / Protected Files | Bash redirect and file-write detection | CONFIRMED | command string T:16190; best-effort parser, documented limits |
| safety / Protected Files | MCP write tools (desktop-commander, obsidian) | UNVERIFIED | argument names unknown; opt-in `protect.mcpRules` |
| safety / Protected Files | Hook still runs under `bypassPermissions` | UNVERIFIED | check in the manual list |
| safety / Auto-checkpoint | Temp-index plumbing (`add -A`, `write-tree`, `commit-tree`, `update-ref`) | CONFIRMED (process-exec) | verified 2026-10-11 on git 2.50.1: HEAD, index hash, status, stash list, worktree unchanged; `git stash create` rejected (rewrites the index) |
| safety / Auto-checkpoint | `env` merges over host env (GIT_INDEX_FILE) | CONFIRMED | `ProcessRunInit.env` T:8008 |
| safety / Auto-checkpoint | Dirty detection and trigger | CONFIRMED | `turn.complete` T:13324, `isReadOnly` T:12759 |
| safety, dev, awareness | `$.process` works in desktop-hosted sessions | CONFIRMED (live probe 2026-10-11) | `git --version` from a `tool.call` hook in a desktop session, exitCode 0; defensive start-up probe and `needs host commands` fallback kept in code only |
| dev / PR Radar, awareness | Toast limiting across plugins | CONFIRMED | any plugin reads another's `$.state`, owner writes (T:3381); `$.store` is private (T:3345); convention: self-limit plus published `lastShownAt` (00-conventions 7.5) |
| dev / PR Radar | Failing-check toast for own PRs | CONFIRMED (process-exec) | `gh pr list --json author,...` (field exists in gh 2.98.0), `gh api user --jq .login`; `$.ui.toast` T:2447 |
| dev / Git chip | `git status --porcelain=v2 --branch -z` | CONFIRMED (process-exec) | git 2.50.1 |
| dev / Git chip | Worktree detection `git rev-parse --git-dir --git-common-dir` | CONFIRMED (process-exec) | output shape checked locally |
| dev / Git chip | Refresh triggers | CONFIRMED | Bash `gitOperation` T:20392 |
| dev / Session Diff | Tree-to-tree `git diff --numstat` of snapshots | CONFIRMED (process-exec) | same plumbing as checkpoint |
| dev / Session Diff | Tool-only fallback counts | CONFIRMED | Edit `structuredPatch` T:20518, Write T:21420 |
| dev / Session Diff | Bash edits via `bashEditDiff` | UNVERIFIED | `@internal` T:20412 |
| dev / Session Diff | Open a file | CONFIRMED | `Link` with `file:` scheme, R:125 |
| dev / PR Radar | `git worktree list --porcelain` | CONFIRMED (process-exec) | output checked locally |
| dev / PR Radar | `gh pr list --state all --json ...` | CONFIRMED (process-exec) | all fields exist in gh 2.98.0 (checked) |
| dev / PR Radar | GitHub remote check | CONFIRMED | `$.session.repo()` T:2804 |
| dev / PR Radar | Rate-limit detection | CONFIRMED (process-exec) | gh stderr text; `ghRateLimitHint` T:20390 covers the model's own gh calls only |
| dev / Test Pulse | Test output in the Bash result | CONFIRMED | stdout/stderr T:20352 |
| dev / Test Pulse | Exit code | UNVERIFIED | no `exitCode` field (T:20350-20440); `isError` is a hint only, parsers read summaries |
| dev / Coverage Delta | Read lcov, summary json, cobertura, coverage.py json | CONFIRMED | `$.fs` T:3242, T:3321 |
| dev / Coverage Delta | `last-clean` baseline needs `git status` | CONFIRMED (process-exec) | `git status --porcelain` |
| dev / Typecheck Feedback | Run tsc, ruff, eslint | CONFIRMED (process-exec) | `tsc --noEmit --incremental`, `ruff check --output-format=concise`, `eslint -f json` |
| dev / Typecheck Feedback | Append errors to the edit's result | CONFIRMED | `ToolCallResult.context` T:12735 |
| dev / Typecheck Feedback | Hook-added `context` reaches the model | UNVERIFIED | type doc only; manual check (c) |
| dev / Port Watch | Listening ports and cwd | CONFIRMED (process-exec) | `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`, `lsof -a -p <pids> -d cwd -Fpn` (shape checked locally) |
| dev / Port Watch | Stop a stale server | CONFIRMED (process-exec) | `kill -TERM <pid>` after re-verification |
| all | AbovePrompt stacking with `next` | CONFIRMED | T:10255, `AP:hooks/register.tsx:368-433` |
| all | One Svg row, inline CSS animation | CONFIRMED | `AP:hooks/svg.ts:97-106` already ships it |
| all | `userConfig` options | CONFIRMED | `PluginOptions` T:7648; savvy-progress `plugin.json` |

## Counts
92 rows: 60 CONFIRMED (including the live `$.process` probe), 13 CONFIRMED (process-exec), 19 UNVERIFIED (each with a fallback). No row is blocked and process execution is no longer a risk.

## Top risks
1. ~~`$.process` may not exist in desktop-hosted sessions.~~ RESOLVED 2026-10-11: CONFIRMED by a live probe (`git --version` from a `tool.call` hook in a desktop session, exitCode 0). Dev, Auto-checkpoint, Port Watch, Typecheck Feedback and the Ollama curl fallback run as designed on both hosts. The start-up probe and the `needs host commands` message stay as defensive code only.
2. No live cache expiry and no exposed TTL: Cache Clock computes expiry from request times. Its TTL now follows `cache-tax` when that plugin is installed (CONFIRMED from its source: a 1h constant, no setting), else learns it or assumes `~1h` on a subscription. It can still be wrong after a hidden cache hit or an unannounced TTL change; it always shows the TTL's source. cache-tax's keepwarm status is inferred from pings and observed commands (UNVERIFIED, falls back to `KEEPWARM unknown`).
3. Toasts cannot carry buttons or colour, and mascot stills inside `<Svg>` (`data:` images) are untested. The mockups' toast actions become command hints in the text; mascots fall back to the block mark.
Also watch: a hook-added `context` reaching the model (Typecheck Feedback), plugin hooks under `bypassPermissions` (Protected Files), the cross-plugin toast gap being best effort (two plugins offering in the same tick can both show), and duplicated rows when `cache-tax` is installed.

## Decisions (closed 2026-10-11)
All 18 questions are decided; the full text is in each spec's "Decisions (closed 2026-10-11)" section.
| Q | Plugin | Decision |
|---|---|---|
| 1 | usage | Cache TTL when unknown: follow cache-tax (settings `enabledPlugins` + its 1h constant); no cache-tax: `~1h` assumed on subscription |
| 2 | usage | Burn Meter HOT when projected usage at reset >= 100% |
| 3 | awareness | "Agent without model" toast owned by Delegation Guard; Heads-Up `noModel` defaults OFF |
| 4 | awareness | Checklist band moves to Now Doing; `agents.showChecklist` stays false |
| 5 | awareness | ONE digest toast after a focus block |
| 6 | awareness | Spec Tracker: auto-discovery plus `/spec <path>` pin and `/spec clear` |
| 7 | agents | Rename agent-pets to `agents`; `/pets` kept; state starts fresh |
| 8 | agents | Review Queue manual only (`REVIEWED` button or `/review done [id\|all]`) |
| 9 | agents | Pom = working agents; Carrot = Review Queue and Delegation Guard headers |
| 10 | agents, usage | Static dated price table, `pricesJson` override, "estimate (prices as of <date>)", no network |
| 11 | safety | `bun.lock` added to the lockfile group |
| 12 | safety | MCP write tools not covered in v1; `protect.mcpRules` opt-in, empty |
| 13 | safety | `/checkpoint restore` prints the git command, never runs it |
| 14 | safety | `rm`/`mv` of protected files also denied, message explains the override |
| 15 | dev | Typecheck Feedback after each edit, 20 s budget, errors fed back |
| 16 | dev | Coverage baseline `session-first` default, `last-clean` optional |
| 17 | dev | Port Watch STOP enabled, two-step, OURS only, others list-only |
| 18 | dev, awareness | PR Radar toast when own PR checks flip to FAILING; `dev` toasts itself under the shared convention (00-conventions 7.5: self-limit plus published `lastShownAt`, peers read via `$.state`) |

## Effort and build order
| Plugin | Mods (S/M/L) | Order |
|---|---|---|
| shared kit | tokens, svgkit, band, toast, proc, pace, cache, prices, testparse, snapshot, mascots | first, with `scripts/sync-shared.ts` and `scripts/run-contract.sh` |
| safety | Protected Files S, Auto-checkpoint M | 2: highest value for least work |
| usage | Burn Meter M, Cache Clock M, Compaction Alert S | 3 |
| awareness | Heads-Up M, Now Doing M, Spec Tracker M, Focus Timer M | 4 (needs the pace and cache libs) |
| agents | Pets M, Review Queue M, Delegation Guard S | 5 (rename from agent-pets) |
| dev | PR Radar M, Git chip S, Session Diff M, Test Pulse M, Coverage Delta L, Typecheck Feedback S-M, Port Watch M | 6 |
Before any plugin: run the one remaining probe (mascot `data:` image in `<Svg>`) and record the result in the specs; the `$.process` probe is done (CONFIRMED 2026-10-11).

## Decisions respected
Five themed plugins as decided; Heads-Up toasts only, max 1/min, silent in focus; Protected Files list as decided, with a configurable list and an override; Delegation Guard warns by default with a deny option; Cache Clock never hard-codes a TTL (it follows cache-tax, else learns or assumes, and shows the source); Test Pulse and Coverage Delta parse pytest, vitest, jest, bun, go and cargo; PR Radar uses `gh` with backoff of at least 60 s; Auto-checkpoint writes to `refs/checkpoints/<session>` using a temporary index (verified not to touch HEAD, index, stash list or files); terminal uses plain text plus emoji and block symbols, desktop uses Still Room tokens; the adopt-list items (dcg, ggshield, tdd-guard) are not specced.
