# awareness

Tells you what is happening and what needs you, without noise. Version 1.0.4. Four mods: Heads-Up toasts, a Now Doing phase band, a Spec Tracker and a Focus Timer. Spends no tokens, except the few tokens of the optional `mcp__awareness__phase` tool when the model chooses to call it.

## Install

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install awareness@bento
```

## Mods

**Heads-Up** (`mod_headsup_enabled`). Toasts only, at most one per `headsup_minGapMs` (60 s). Others wait in a queue (by priority, newest per trigger, expiring after `headsup_queueTtlMin`). Each trigger has its own switch:

| Trigger (`headsup_trigger_*`) | Fires when | Toast text |
|---|---|---|
| `cache` | You are idle (no turn or prompt for `headsup_idleSec`), the prompt cache has under `headsup_cache_warnSec` left, and the context is at least `headsup_cache_minCtxTokens`. | `CACHE · 60 S: Prompt cache expires soon; the next message re-caches ~$0.42.` |
| `longCommand` | A foreground shell command runs longer than `headsup_longSec` (120 s). A second toast reports its duration when it ends. Only the program name is shown, never arguments. Background commands are skipped. | `COMMAND · 2 MIN: <exe> is still running.` |
| `context` | Context crosses `headsup_context_warnAt` percent (re-arms below 70% or after a compaction). | `CONTEXT · 82%: compaction is near. Run /compact or start fresh.` |
| `pace` | Weekly pace turns HOT (also the 5-hour window if `headsup_pace_five`). | `WEEKLY PACE · HOT: limit lands <time> at this rate. Run /burn.` |
| `bigOutput` | One tool result is at least `headsup_bigOutput_kb` KB. | `OUTPUT · 120 KB from Bash. Narrow the command next time.` |
| `ollama` | Only if `OBSIDIAN_VAULT_PATH` names an existing directory: a local Ollama server (127.0.0.1:11434) fails two probes in a row. | `VAULT · KEYWORD ONLY: Ollama is down; search quality is reduced.` |
| `noModel` | Off by default (the `agents` Delegation Guard owns this toast). | `AGENT · NO MODEL SET: ...` |

Heads-Up is silent during a focus block. Triggers that fire then are counted and, when the block ends, one digest toast says `While you focused: N notices (...). Run /headsup.` (`headsup_digestAfterFocus`). `/headsup mute 30m` silences everything for a while. Hints such as `Run /burn.` appear only when that command exists.

**Now Doing** (`mod_nowdoing_enabled`). A band segment shown while a turn runs, a checklist exists, a command has run for `nowdoing_showAfterSec` (10 s), or a spec is tracked. Five phase chips (RESEARCH, PLAN, BUILD, VERIFY, REPORT; visited, current, unvisited), a `now:` sentence (for example `Editing register.tsx`; basenames only), and a progress meter when a checklist or tracked spec exists. The phase is inferred from the main thread's tool calls (reads and searches = research; planning tools or edits to plan files = plan; edits and other shell commands = build; test, typecheck, lint and build commands = verify; a final answer with no tool use = report). A long command shows as `⏱ npm 01:42`. If `nowdoing_tool` is on, the plugin registers a deferred tool `mcp__awareness__phase` (`phase`, `note`, `done`, `total`) that lets the model state its phase and a short note itself. `nowdoing_phaseMap` adds your own tool-to-phase pairs as JSON, for example `{"mcp__my__search":"research"}`.

**Spec Tracker** (`mod_spec_enabled`). Counts markdown checkboxes (`- [ ]` / `- [x]`, nested items by default, fenced code ignored) in a plan or spec file and shows `SPEC 7/12` plus `next: <first unchecked>`. The file is auto-discovered as the most recently edited file matching `spec_globs` that holds at least one checkbox, or pinned with `/spec <path>`. A checklist from the model's task tools, when present, drives the percent instead. Files over `spec_maxKb` are not parsed.

**Focus Timer** (`mod_focus_enabled`). A pomodoro: `FOCUS 25:00` with a 12-cell meter, `Focus 2 of 4` and `Heads-Up quiet until 14:25`; then a break, and a long break after every `focus_longEvery` blocks. When a block ends you get a native notification (`focus_notify`) and a short chime on macOS (`focus_sound`). The timer survives a session restart by wall clock; if it expired while the app was closed for over 5 minutes the block is not credited.

## Commands

| Command | Effect |
|---|---|
| `/focus start [min]` | Start a focus block (default `focus_focusMin`). |
| `/focus pause` \| `resume` \| `stop` \| `skip` \| `status` | Control or inspect the timer. |
| `/headsup status` | Muted/quiet/active, last toast, ids of held-back notices. |
| `/headsup mute <dur>` \| `unmute` | For example `/headsup mute 30m`. |
| `/headsup test <id>` | Show a sample toast for a trigger id (`cache`, `longCommand`, ...). |
| `/spec <path>` | Pin a file (must exist and contain a checkbox). |
| `/spec clear` | Unpin; fall back to auto-discovery. |
| `/spec` | Print `Tracking <path> (pinned\|auto)` or `No spec tracked`. |
| `/nowdoing` | Print the current phase and sentence; when idle, `last turn: <PHASE> · now: ...`. |
| `/nowdoing reset` | Reset the Now Doing state (phase, checklist). |

## What you see

One band row: Focus segment, then Now Doing (chips shrink first to the current phase, then to `VERIFY 60%`). The row shows only while something is active. Toasts come only from Heads-Up. Without a band, the status line shows `now: ... 60%`. The completion sound is `sounds/done.wav` (a generated 0.4 s tone).

## Hooks registered

| When | What it does |
|---|---|
| Prompt submitted, turn start/end | Tracks idleness, resets the phase, refreshes the tracked spec. |
| Each model request and measurement | Feeds the cache, context and pace triggers. |
| Tool calls | Infers the phase, reads checklist updates, notes edits to spec files, measures output size, times foreground shell commands. |
| Subagent spawn | Feeds the optional `noModel` trigger. |
| Compaction, model switch, resume | Re-arm context and cache triggers. |
| Commands, band rendering | Serve the commands above and draw the row. |

## Options

| Option | Default | Values | Effect |
|---|---|---|---|
| `mod_headsup_enabled` | `true` | boolean | Toasts for cache, long commands, context, pace, big output, Ollama. |
| `mod_nowdoing_enabled` | `true` | boolean | Phase chips, checklist progress and long command timer above the prompt. |
| `mod_spec_enabled` | `true` | boolean | Count checkboxes of the plan or spec file being edited. |
| `mod_focus_enabled` | `true` | boolean | Pomodoro band segment; Heads-Up stays quiet during focus. |
| `minBandRows` | `4` | number | The band stays hidden when fewer rows are free. |
| `mascots` | `auto` | `auto`, `on`, `off` | auto and on draw Pom as an image on the desktop; off draws a block mark. |
| `headsup_minGapMs` | `60000` | number | Minimum time between two Heads-Up toasts. |
| `headsup_idleSec` | `120` | number | No turn and no prompt for this long counts as idle. |
| `headsup_queueTtlMin` | `5` | number | A held toast expires after this long. |
| `headsup_digestAfterFocus` | `true` | boolean | One toast after a focus block summarising what was held back. |
| `headsup_trigger_cache` | `true` | boolean | Warn before the prompt cache expires. |
| `headsup_trigger_longCommand` | `true` | boolean | Long Command Timer. |
| `headsup_trigger_context` | `true` | boolean | Warn when the context window is nearly full. |
| `headsup_trigger_pace` | `true` | boolean | Warn when the weekly pace turns HOT. |
| `headsup_trigger_bigOutput` | `true` | boolean | Warn about a very large tool result. |
| `headsup_trigger_ollama` | `true` | boolean | Warn when the local Ollama is down (needs OBSIDIAN_VAULT_PATH). |
| `headsup_trigger_noModel` | `false` | boolean | Off by default: Delegation Guard owns this toast. |
| `headsup_cache_warnSec` | `60` | number | Warn when this many seconds of cache remain. |
| `headsup_cache_minCtxTokens` | `50000` | number | No cache warning below this context size. |
| `cache_ttl` | `auto` | `auto`, `5m`, `1h` | auto learns the TTL; 5m or 1h fixes it. |
| `cache_followCacheTax` | `true` | boolean | Use the cache-tax plugin's TTL when it is installed. |
| `headsup_longSec` | `120` | number | A foreground command running this long raises a toast. |
| `headsup_context_warnAt` | `80` | number | Warn when context use crosses this percent. |
| `headsup_pace_five` | `false` | boolean | Also warn about the 5-hour window. |
| `headsup_bigOutput_kb` | `100` | number | Decimal KB of one tool result. |
| `headsup_ollama_intervalMin` | `5` | number | Minutes between probes. |
| `headsup_noModel_allowTypes` | `savvy-*,*:savvy-*` | string | Comma-separated globs of agent types that need no model. |
| `nowdoing_mascot` | `false` | boolean | Show Pom (20 px) in the Now Doing segment. |
| `nowdoing_showAfterSec` | `10` | number | A running command shows in the band after this long. |
| `nowdoing_tool` | `true` | boolean | Register mcp__awareness__phase so the model can set the phase and a note. |
| `nowdoing_phaseMap` | (empty) | string | JSON object mapping tool names to research, plan, build, verify or report. |
| `spec_enabled` | `true` | boolean | Same switch as mod.spec.enabled. |
| `spec_globs` | `**/docs/**/*plan*.md,**/docs/**/*spec*.md,**/plans/**/*.md,**/specs/**/*.md,**/PLAN.md,**/SPEC.md,**/.claude/plans/**/*.md` | string | Comma-separated globs of plan and spec files to auto-discover. |
| `spec_nested` | `all` | `all`, `top` | all counts nested items; top counts top-level only. |
| `spec_maxKb` | `256` | number | Larger files are not parsed. |
| `spec_auto` | `true` | boolean | Off means pin-only (/spec <path>). |
| `focus_focusMin` | `25` | number | Length of a focus block. |
| `focus_breakMin` | `5` | number | Short break. |
| `focus_longBreakMin` | `15` | number | Break after every Nth block. |
| `focus_longEvery` | `4` | number | Blocks before a long break. |
| `focus_sound` | `chime` | `chime`, `off` | chime plays a short tone when a block ends (macOS). |
| `focus_notify` | `true` | boolean | Native notification when a block ends. |
| `focus_autoBreak` | `true` | boolean | Start the break when a block ends. |

## Privacy

Band and toast text never contains command arguments, prompts, file contents or full paths (basenames and program names only). Persisted in the plugin store: focus timer state and per-day block counts. Checklist labels (60 characters at most) live in session state only. The Ollama probe is one local HTTP request every `headsup_ollama_intervalMin` minutes and runs only when `OBSIDIAN_VAULT_PATH` is set; it falls back to `curl` against localhost.

## Troubleshooting

- **No toasts.** You may be in a focus block, muted (`/headsup status`), or inside the 60-second gap; the next one is queued. Toasts also stop when you are not idle for the `cache` trigger.
- **No Now Doing row.** It shows only while a turn runs, a command is long, or a checklist/spec exists; also needs `minBandRows` free rows.
- **No checklist.** Claude Code may hide its task tools for some models. Set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, or track a plan file with `/spec <path>`.
- **No chime.** The chime uses macOS `afplay`; on other systems only the notification fires.
- **A background command finishing gives no toast.** Only foreground commands are timed.

## Common behaviour (all Bento plugins)

- **Setting options.** Options are plugin `userConfig` values. Set them in the `/plugin` menu, or in `~/.claude/settings.json` under `pluginConfigs["awareness@bento"].options`. Keys use underscores (`mod_x_enabled`); the dotted spelling used in the specs (`mod.x.enabled`) is also read.
- **Disabled mods cost nothing.** A mod whose `mod_<id>_enabled` is `false` registers no hooks, draws nothing and adds no command.
- **Band row.** Bento plugins each draw at most one row above the prompt. The row stays hidden when fewer than `minBandRows` rows are free. Rows from other plugins that draw above the prompt without passing the rest of the chain on can hide Bento rows; disable that plugin to confirm.
- **Command names.** Each command registers under its bare name. If Claude Code or another plugin already owns the name, it registers as `awareness-<name>` instead.
- **Terminal and desktop.** Every band text has an equivalent for terminal sessions (plain text and a few emoji glyphs) and for the desktop app (an SVG). Toasts carry text only; when a desktop surface is attached they omit emoji.
- **Estimates.** Any dollar figure is an estimate from a built-in price table with a date; it is labelled as such and can be replaced with `pricesJson` where that option exists.
- **Checking the install.** `claude plugin validate plugins/awareness` (from a clone of this repo) must report no errors. Spec (normative, more detail): [specs/awareness.md](../../specs/awareness.md), shared rules in [specs/00-conventions.md](../../specs/00-conventions.md).
