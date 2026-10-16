# agents

Everything about subagents in one plugin. Version 1.2.0. Four mods:

- **Pets** (`pets`): a pane that shows each running subagent as a small character with its model, task and clock.
- **Review Queue** (`review`): finished agents wait there until you mark them reviewed.
- **Delegation Guard** (`delegation`): checks that every subagent call names a model, watches spend by model tier, refuses or warns about subagents that start subagents (nesting guard), and warns about runaway subagents.
- **Mission Board** (`mission`): overall plan progress across all agents, with a clickable view of everything still to do.

Spends no tokens. The only model-visible text is one line appended to each subagent prompt (see Mission Board), about 35 tokens per spawn. It replaces the older `agent-pets` plugin: uninstall that first (`claude plugin uninstall agent-pets`); nothing migrates.

## Install

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install agents@bento
```

## Pets

Each subagent gets a row: costume tag (SCOUT, LAB, PLAN, DOCS, BUILD), description, a tier chip (FABLE, OPUS, SONNET, HAIKU, OTHER), agent type, status (`WORKING`, `DONE`, `FAILED`) and a `mm:ss` clock. A band button `N working` (terminal: `🐾 N working`) opens the pane while any agent runs. The pane auto-opens once per session on the first spawn (`pets_autoOpen`). The pane footer shows spend: `SPEND $9.35 · F $3.10 O $4.90 S $1.20 H $0.15`. The pane also shows the Review Queue and recently finished agents.

## Review Queue

A subagent that finishes (done or failed) while the session is open enters the queue. Each item shows description, tier, duration, files touched, and test outcome. A test outcome counts only when the agent ran a recognised test runner (pytest, vitest, jest, bun test, go test, cargo test or nextest, npm/pnpm/yarn test) and the output has a parsed summary. States, in sort order: FAILED, UNTESTED (wrote files, ran no tests), TESTS FAILED, TESTS PASSED, NO EDITS. Items leave only when you mark them reviewed (button `REVIEWED`, or the command). Nothing is marked automatically. The band shows `REVIEW n` (terminal `📥 3 to review`), with the oldest age and a warning edge after `review_remindMin` minutes. The queue is per session.

## Delegation Guard

**Model check.** Every `Agent` call must set `model`. Calls of types listed in `delegation_allowTypes` (default `savvy-*,*:savvy-*`, agent definitions that pin their own model) and forks are exempt.

| `delegation_mode` | Model-less spawn |
|---|---|
| `warn` (default) | Passes. Toast `AGENT · NO MODEL SET: "<description>" started without a model. Add model: haiku or sonnet.` and a violation row in the pane. |
| `deny` | Refused with a message telling the model to retry with an explicit model (haiku for search/read/bulk, sonnet for build/tests/docs, opus or fable for hard design only). |
| `off` | Passes silently; spend is still tracked. |

**Spend by tier.** The `delegation` pane shows a stacked bar of estimated dollars per tier, `Explicit model: k of n spawns`, and a footnote `estimate (prices as of <date>) · session total $X` that flags when the estimate differs from Claude Code's own total by more than 15%.

**Nesting guard.** A spawn made by a subagent (not by the main thread) is a nested spawn. `nesting_mode`: `warn` (default) lets it through with one toast and a pane row, `deny` refuses it with a message telling the subagent to return to the orchestrator, `off` ignores it. Forks are not exempt; workflow-script spawns are. `nesting_allowTypes` lists agent types that may nest. Why it exists: subagents that spawn subagents each start with a large context, and a single session of this kind once cost over $1,000 on its own.

**Runaway warning.** Per subagent, the plugin counts steps and tracks the context size of the latest step. When one reaches `runaway_maxSteps` (100) or `runaway_maxContext` (300,000 tokens), it toasts once per threshold per agent (`AGENT RUNAWAY · "<description>" · 112 steps · 340k ctx · consider stopping it`), marks the pet row `⚠ RUNAWAY` and shows a band segment `⚠ RUNAWAY ×n` that opens the pets pane. It never stops, interrupts or denies anything.

## Mission Board

One glance answers: how much of the whole plan is done, what is running and how far along each task is, and what is still ahead.

**Plan sources** (merged by title, checklist first): the model's task list (TodoWrite / TaskCreate / TaskUpdate; Claude Code may hide these tools for some models, set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to enable them), markdown checkboxes in a spec or plan file found from edits (`mission_specGlobs`, the same discovery as the `awareness` Spec Tracker), or a file you register with `/mission plan <path>` (scoped to the project root). Plans have at most 500 items.

**States.** `done` means the agent finished and you marked it reviewed. `running`, `review` (finished, not yet reviewed), `blocked` (a linked agent failed), `queued`. Agents are linked to items by an explicit `[task:<id>]` tag, then by matching title, then by fuzzy match; otherwise they appear as `UNPLANNED` and do not change the percentage. Link by hand with `/mission link`.

**Band.** `PLAN 12/50 DONE · 5 RUNNING · 31 QUEUED` with a thin progress bar (terminal: `📋 Plan 12/50 done · 5 running · 2 review · 31 queued  ██░░░░░░░░░░ 24%`). Running agents' fractional progress is drawn separately and never counted as done.

**Pane `mission`.** Overall meter and count chips (press one to filter), `RUNNING NOW` rows with each agent's own progress, a tile grid of everything left (`mission_maxTiles` tiles, then `+N more`), and a detail card per item. It auto-opens once per session when a plan first reaches 5 items and 2 agents run.

**Per-task percent.** The plugin registers a deferred tool `mcp__agents__step` (`done`, `total`, `note`). When `mission_stepLine` is on, one line is appended to every subagent prompt: `Progress (required): first ToolSearch "select:mcp__agents__step", then call it {done,total,note} now and after each step.` Subagents then report steps (`step 7/10 · wiring table`). Without reports the board shows an estimate (`~40% est.`, capped at 90%, hatched meter) based on turn counts (`mission_typicalTurns`). `mission_stepVia` can be set to `bash` for a fallback that reads `echo MISSION_STEP n/m`. The line is skipped for forks, teammates, and prompts that already contain it.

## Commands

| Command | Effect |
|---|---|
| `/pets` | Show or hide the pets pane. |
| `/review` | List the Review Queue (numbered). Claude Code's built-in `/review` owns that name, so here it registers as `/agents-review`. |
| `/agents-review done <id>` \| `done all` | Mark one item (by list number) or all items reviewed. Bare `done` marks nothing. |
| `/delegation` or `/delegation status` | Mode, spawn and violation counts, nesting mode and nested count. |
| `/delegation warn` \| `deny` \| `off` | Set the model-check mode. Persisted. |
| `/delegation nesting warn` \| `deny` \| `off` | Set the nesting guard mode. Persisted. |
| `/mission` | Open the Mission Board pane. |
| `/mission list` | Toggle the text list of all items. |
| `/mission <n>` | Detail card for item `n`. |
| `/mission plan <path>` / `plan clear` | Register or clear a markdown plan for this project. |
| `/mission link <item n> <run n>` / `unlink <run n>` | Link an agent (numbers from `/pets`) to a plan item by hand. |
| `/mission status` | One-line summary. |

If Claude Code or another plugin already owns a bare name, the command registers as `agents-<name>` (for example `/agents-pets`, `/agents-mission`).

Examples:

```
/delegation deny
/delegation nesting deny
/agents-review done all
/mission plan docs/plan.md
```

## What you see

One band row: Mission Board segment (leftmost), pets button, review segment, delegation segment (`⚠ NO MODEL ×2`), runaway segment. The row shows only when something is non-empty. Panes: `pets` (also holds the Review Queue), `delegation`, `mission`. Toasts: model-less spawn, nested spawn, runaway (each limited as described). Without a band, a status line such as `agents 2 working · 3 to review`.

## Hooks registered

| When | What it does |
|---|---|
| Before a subagent starts | Guard decisions (nesting first, then model); appends the progress line to the prompt; links the agent to a plan item. |
| Each subagent step | Counts steps and context for runaway detection, learns the model, adds up spend. |
| Subagent tool calls | Counts files touched; parses test results for the Review Queue. |
| Subagent finishes | Moves it to Done / the Review Queue. |
| Main-thread task tools | Reads the checklist for the Mission Board. |
| Edits to plan/spec files | Discovers the plan file. |
| Commands, band and pane rendering | Serve the commands above and draw the UI. |

## Options

| Option | Default | Values | Effect |
|---|---|---|---|
| `mod_pets_enabled` | `true` | boolean | Enable the pets mod (pane, pets button). |
| `mod_review_enabled` | `true` | boolean | Enable the review queue mod. |
| `mod_delegation_enabled` | `true` | boolean | Enable the delegation guard mod. |
| `mod_mission_enabled` | `true` | boolean | Enable the mission board mod (also mission.enabled). |
| `mission_enabled` | `true` | boolean | Same switch as mod.mission.enabled; false turns the mod off. |
| `minBandRows` | `4` | number | Below this many free rows the band row is hidden. |
| `pets_mascots` | `auto` | `auto`, `on`, `off` | auto and on draw the Pom/Carrot stills; off draws the block mark. |
| `pets_terminalStills` | `false` | boolean | Reserved: draw stills in kitty/Ghostty terminals (not implemented yet). |
| `pets_maxRuns` | `100` | number | Runs kept in the pets list. |
| `pets_maxDone` | `12` | number | Finished pets shown in the pane. |
| `pets_autoOpen` | `true` | boolean | Open the pets pane once, on the first spawn of a session. |
| `showChecklist` | `false` | boolean | Show the TodoWrite/TaskCreate checklist in the band (awareness Now Doing owns it by default). |
| `review_remindMin` | `10` | number | Minutes before the review segment shows the oldest age and a warn edge. |
| `review_includeBackfilled` | `false` | boolean | Also queue agents first seen through the live agent list. |
| `review_toast` | `false` | boolean | Reserved: no toast is raised by default. |
| `delegation_mode` | `warn` | `warn`, `deny`, `off` | warn toasts, deny blocks a model-less Agent call, off only tracks spend. /delegation overrides and persists. |
| `delegation_allowTypes` | `savvy-*,*:savvy-*` | string | Comma globs of agent types that pin their own model. |
| `delegation_toast` | `true` | boolean | Toast on a model-less spawn in warn mode. |
| `delegation_minGapMs` | `30000` | number | Minimum gap between guard toasts. |
| `nesting_mode` | `warn` | `warn`, `deny`, `off` | warn toasts when a subagent starts a subagent, deny refuses the call, off ignores it. /delegation nesting overrides and persists. |
| `nesting_allowTypes` | (empty) | string | Comma globs of agent types a subagent may start. |
| `nesting_toast` | `true` | boolean | Toast on a nested spawn in warn mode. |
| `nesting_minGapMs` | `30000` | number | Minimum gap between nesting toasts. |
| `runaway_maxSteps` | `100` | number | Warn when one subagent reaches this many steps (0 = off). |
| `runaway_maxContext` | `300000` | number | Warn when one subagent step reaches this many context tokens (0 = off). |
| `runaway_toast` | `true` | boolean | Toast when a runaway threshold fires (the row mark and band segment always show). |
| `pricesJson` | (empty) | string | JSON {"asOf":"YYYY-MM-DD","opus":{"input":..,"output":..,"cacheRead":..,"write5m":..}} per MTok. Empty = built-in table. |
| `windowsJson` | (empty) | string | JSON {"asOf":"YYYY-MM-DD","sonnet":200000,"opus":1000000} tokens per family (or a model-id substring). Empty = built-in table. |
| `mission_stepLine` | `true` | boolean | Append the progress line to every subagent prompt. |
| `mission_stepVia` | `tool` | `tool`, `bash` | tool = deferred mcp__agents__step; bash = echo MISSION_STEP n/m. |
| `mission_typicalTurns` | `{"Explore":8,"general-purpose":20,"other":15}` | string | JSON {"Explore":8,"general-purpose":20,"other":15} used for estimates. |
| `mission_maxTiles` | `120` | number | Clickable tiles in the pane before a +N more button. |
| `mission_specGlobs` | `**/docs/**/*plan*.md,**/docs/**/*spec*.md,**/plans/**/*.md,**/specs/**/*.md,**/PLAN.md,**/SPEC.md,**/.claude/plans/**/*.md` | string | Comma globs of plan/spec files discovered from edits. |

`pricesJson` example: `{"asOf":"2026-10-11","opus":{"input":5,"output":25,"cacheRead":0.5,"write5m":6.25}}` (USD per million tokens; unknown keys ignored; invalid JSON is ignored and the built-in table stays).

## Privacy

State is per session and held in memory, except: the guard modes (`guard:mode`, `nesting:mode`) and the registered plan path per project root (a path, never contents). Descriptions are already visible to the model; they appear in the pane and toasts, truncated. For a spawn, only a task id from the prompt is kept, never the prompt. Test names, file contents and tool output are not stored (only counts).

## Troubleshooting

- **Pets pane never opens.** It opens only on the first spawn of a session and only if the prompt area is fullscreen; use `/pets`.
- **Mission Board hidden.** It needs a plan with at least one item. Enable the task tools (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`) or use `/mission plan <file>`.
- **Subagents do not report steps.** Check `mission_stepLine`. The agent needs to find the deferred tool via ToolSearch; if your model never does, try `mission_stepVia: bash`. Until then the board shows `est.`.
- **`/review` runs the built-in command.** Use `/agents-review`.
- **Model-less spawns are not caught for a custom agent type.** Agent definitions pin their model where hooks cannot see it; list the type in `delegation_allowTypes`.
- **Another AbovePrompt plugin hides the row.** Remove or disable it to confirm.
- **Not verified live:** the effort word per subagent on the board, row dimming after 120 s on the desktop app, and the 1M-context percent cross-check.

## Common behaviour (all Bento plugins)

- **Setting options.** Options are plugin `userConfig` values. Set them in the `/plugin` menu, or in `~/.claude/settings.json` under `pluginConfigs["agents@bento"].options`. Keys use underscores (`mod_x_enabled`); the dotted spelling used in the specs (`mod.x.enabled`) is also read.
- **Disabled mods cost nothing.** A mod whose `mod_<id>_enabled` is `false` registers no hooks, draws nothing and adds no command.
- **Band row.** Bento plugins each draw at most one row above the prompt. The row stays hidden when fewer than `minBandRows` rows are free. Rows from other plugins that draw above the prompt without passing the rest of the chain on can hide Bento rows; disable that plugin to confirm.
- **Command names.** Each command registers under its bare name. If Claude Code or another plugin already owns the name, it registers as `agents-<name>` instead.
- **Terminal and desktop.** Every band text has an equivalent for terminal sessions (plain text and a few emoji glyphs) and for the desktop app (an SVG). Toasts carry text only; when a desktop surface is attached they omit emoji.
- **Estimates.** Any dollar figure is an estimate from a built-in price table with a date; it is labelled as such and can be replaced with `pricesJson` where that option exists.
- **Checking the install.** `claude plugin validate plugins/agents` (from a clone of this repo) must report no errors. Spec (normative, more detail): [specs/agents.md](../../specs/agents.md), shared rules in [specs/00-conventions.md](../../specs/00-conventions.md).
