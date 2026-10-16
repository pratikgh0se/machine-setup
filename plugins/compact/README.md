# compact

Compact at the right moment and keep the thread across it. Version 1.0.7. Mods: a cost-aware Compact Coach, a two-step `/handoff`, a Resume loader, a Handoff nudge and an optional Orchestrator mode. Spends no tokens except the model-visible pieces listed under Context cost.

## Install

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install compact@bento
```

## Mods

**Compact Coach** (`mod_coach_enabled`). A band chip once context passes `coach_showFromTokens` (100k) or while a handoff is in progress:

```
🥕 CTX 350k · $0.07→$0.01/turn · ~8 turns · ✅ GOOD MOMENT · /handoff
```

It shows the estimated cost per turn now (warm and cold), at the target size (`coach_targetTokens`), the saving per turn, how many warm turns until compaction pays back, and a moment verdict with a score from 0 to 8: +3 prompt cache cold or expiring, +2 a phase just finished (from `awareness`, if installed), +2 no running subagents, +1 you returned from idle (`coach_idleReturnMin`). Verdict: 5 or more `GOOD MOMENT`, 3-4 `OK`, below 3 `NOT NOW`. It is forced to `NOT NOW` (and the chip says why) when context is below the minimum, the saving per turn is under `coach_minSavingUsd`, or a compaction is running. One toast per strong moment (`coach_toast`, at least `coach_toastMinGapMin` apart): `COMPACT · good moment at 350k. Saves ~$0.06/turn. Run /handoff.` All dollars are estimates labelled with the price date; `pricesJson` overrides the built-in table. Dollars are a yardstick; subscription quota weights are unpublished.

**/handoff** (`mod_handoff_enabled`). Compaction is irreversible and writing a file is not, so it takes two steps:

1. `/handoff [slug]` asks the model to write a handoff file with eight fixed headings (goal, your standing rules, what exists with paths, verified facts, decisions, running background agents, next steps, a paste-ready resume prompt) to `<repo>/handoff/<date>-<slug>.md`, or `~/.local/state/claude-handoffs/` outside a repo. The plugin checks the file exists, is at least `handoff_minBytes` and has all headings; if not it says `failed` and `/handoff retry` asks again (three failures stop). Add `handoff/` to `.gitignore` in shared repos.
2. When ready, the chip and a notice say compaction is irreversible. Only you can type `/handoff go` (within `handoff_confirmTtlMin` minutes), which compacts with instructions naming the file as the source of truth. `/handoff cancel` drops it; the file stays. With `--no-compact` it stops after saving.

No timer, hook or toast ever compacts for you.

**Resume loader** (`mod_resume_enabled`). After a compaction that follows a saved handoff, the first prompt carries one short line pointing at the file (`Context was compacted. Read <file> first ...`), once. A handoff older than `handoff_resumeMaxAgeMin` is not used.

**Handoff nudge** (`mod_nudge_enabled`, default on). When context reaches `nudge_atPercent` (75) of the auto-compact window, and again every `nudge_everyTokens` (50,000) of growth, one short `[compact]` note is appended to the next tool result (or prompt) asking the working model to write its own handoff to `~/.local/state/claude-handoffs/<session>-agent.md`. No extra turn, nothing in the band, never blocks. The window is `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, else the session's measured window, else a model table (`windowsJson` overrides). If an automatic compaction then happens without a `/handoff`, the Resume loader points the next prompt at that agent file when it is fresh (see contract below).

**Orchestrator mode** (`mod_orch_enabled`, `orch_enabled`). Adds a roughly 100 token section to the system prompt: you reason and review, Sonnet builds, Haiku gathers, always set `model` on Agent calls, one scoped brief per agent. On by default. Toggling changes the system prompt and costs one cold turn, so `/orch on|off` asks for `--yes`; prefer toggling right after a compaction or at session start. It cooperates with the `agents` Delegation Guard but works without it.

### Agent handoff file contract

- `~/.local/state/claude-handoffs/<session>-agent.md`: written by the model with six headings: `## Goal`, `## Decisions and why`, `## Done`, `## In progress`, `## Dead ends`, `## Exact next step`. The plugin never writes its body.
- `~/.local/state/claude-handoffs/<session>-agent.meta.json`: written by the plugin: `{v:1, sessionId, window, ctxTokens, lastNudgeAt, lastNudgeTokens, nudgeCount, agentWrittenAt?, agentWrittenAtTokens?}`. Epoch milliseconds and counts only: no text, no file bodies.
- Fresh means: size at least 300 bytes and, with a meta file, written after the last nudge or within 50,000 tokens of the current context; with no meta file, modified within 30 minutes. The `PreCompact` hook in `claude/hooks/` applies this rule and only reads the meta.

## Commands

| Command | Effect |
|---|---|
| `/coach` | Full Coach card: inputs, both cost formulas, price source and date, signals, and `handoff nudge: next at <T>k · last <never\|HH:MM> · agent file <fresh\|stale\|none>`. |
| `/handoff [--no-compact] [slug]` | Ask the model to write a handoff file. |
| `/handoff go` | Compact now (irreversible; you must type it). |
| `/handoff cancel` / `retry` | Drop the pending handoff / ask again. |
| `/orch on` \| `off` \| `status` | Orchestrator mode; `on`/`off` need `--yes`. |

Examples: `/handoff auth-refactor`, `/handoff --no-compact notes`, `/orch off --yes`.

Limitation: `/handoff` and `/handoff go` do not work in one-shot `claude -p` runs (the host refuses them from a command); use an interactive session. Commands themselves are registered in `-p`.

## What you see

A band row with the Coach chip only (own row, hidden when fewer than `minBandRows` rows are free). Handoff states replace the verdict: `HANDOFF writing → <path>`, `HANDOFF ready · compaction is irreversible · /handoff go (~$0.47) or /handoff cancel`, `HANDOFF saved (no compact)`, then `COMPACTED 351k → 41k`. One toast type (Coach). No pane. Without a band: `CTX 350k · save $0.06/turn · GOOD`.

## Hooks registered

| When | What it does |
|---|---|
| Context/cost measurements, each request | Recompute the Coach; record model for prices and the cache stamp. |
| End of a turn | Detects that the handoff file was written; refreshes the agent list; offers the Coach toast. |
| Before a prompt is sent | Appends the Orchestrator section; adds the Resume line after a compaction; may add the nudge note. |
| After tool results | May append the nudge note; notices writes to the agent handoff file. |
| Commands, band rendering | Serve the commands and draw the chip. |

The repo also ships independent Claude Code hooks (not part of this plugin) in `claude/hooks/`: a `PreCompact` hook that writes a deterministic handoff file (no model, always exits 0) and a `SessionStart` hook for the `compact` source that re-injects it. See `claude/settings.template.md`.

## Context cost

Always loaded: about 100 tokens for the Orchestrator section when on (0 when off). Only when used: about 300 tokens for the `/handoff` prompt. The nudge adds one short note a few times per long session.

## Options

| Option | Default | Values | Effect |
|---|---|---|---|
| `mod_coach_enabled` | `true` | boolean | Show the compaction cost chip and toast |
| `mod_handoff_enabled` | `true` | boolean | Enable the /handoff command |
| `mod_resume_enabled` | `true` | boolean | Remind the model to read the handoff after compaction |
| `mod_orch_enabled` | `true` | boolean | Enable /orch and the orchestrator prompt section |
| `mod_nudge_enabled` | `true` | boolean | Remind the working model to write its own handoff before compaction (one short note, no extra turn) |
| `coach_showFromTokens` | `100000` | number | Context size from which the chip shows |
| `coach_targetTokens` | `40000` | number | Wanted size after compaction; the measured floor wins if higher |
| `coach_summaryOutTokens` | `4000` | number | Expected size of the compaction summary |
| `coach_handoffOutTokens` | `3000` | number | Expected size of the handoff file the model writes |
| `coach_minSavingUsd` | `0.02` | number | Below this saving per warm turn the verdict is NOT NOW |
| `coach_strongAt` | `5` | number | Score from which the verdict is GOOD MOMENT |
| `coach_idleReturnMin` | `10` | number | A turn starting after this gap scores +1 |
| `coach_toast` | `true` | boolean | Raise one toast per strong moment |
| `coach_toastMinGapMin` | `20` | number | Minimum minutes between Coach toasts |
| `coach_passAssumesCacheHit` | `true` | boolean | Price the compaction pass at cache-read rates when the cache is warm (set false if a real compaction shows otherwise) |
| `pricesJson` | (empty) | string | Optional per-family price overrides, USD per MTok; empty keeps the built-in table |
| `cache_expiringSec` | `300` | number | Seconds before expiry from which the cache counts as expiring |
| `handoff_minBytes` | `800` | number | Smaller handoff files are rejected |
| `handoff_confirmTtlMin` | `30` | number | How long /handoff go stays available after the file is ready |
| `handoff_resumeMaxAgeMin` | `240` | number | A handoff saved longer ago than this is not used to resume |
| `nudge_atPercent` | `75` | number | First nudge at this percent of the auto-compact window (10 to 95) |
| `nudge_everyTokens` | `50000` | number | Another nudge each time context grows by this much (minimum 10000) |
| `orch_enabled` | `true` | boolean | First-run default for Orchestrator mode; /orch overrides it once used |
| `minBandRows` | `4` | number | The band stays silent when fewer rows are free |
| `windowsJson` | (empty) | string | JSON {"asOf":"YYYY-MM-DD","sonnet":200000,"opus":1000000} tokens per family (or a model-id substring). Empty = built-in table. |

## Privacy

The plugin writes only: the handoff files you ask for and the six-heading agent files the model writes (the contents are what the model chooses to put there, so keep secrets out of your instructions), the small meta files above, and its own store (Orchestrator on/off). Nothing leaves your machine.

## Troubleshooting

- **No chip.** Context is below `coach_showFromTokens`, or fewer than `minBandRows` rows are free.
- **Chip says `NOT NOW`.** It now names the gate (too small, saving too low, compaction running).
- **`Nothing to compact. Run /handoff first.`** `/handoff go` only works after a handoff is ready; it expires after `handoff_confirmTtlMin`.
- **`Turn running. Run /handoff go when it ends.`** Compaction cannot start while a turn runs.
- **`/handoff` does nothing in `claude -p`.** See Limitation above.
- **Dollar figures look wrong.** Prices are a dated built-in table; if a real compaction shows different cache behaviour, set `coach_passAssumesCacheHit` to `false` or supply `pricesJson`.
- **Unverified live:** whether a `SessionStart` fires with source `compact` after an in-session compaction, and whether the prompt cache is reused around compaction.

## Common behaviour (all Bento plugins)

- **Setting options.** Options are plugin `userConfig` values. Set them in the `/plugin` menu, or in `~/.claude/settings.json` under `pluginConfigs["compact@bento"].options`. Keys use underscores (`mod_x_enabled`); the dotted spelling used in the specs (`mod.x.enabled`) is also read.
- **Disabled mods cost nothing.** A mod whose `mod_<id>_enabled` is `false` registers no hooks, draws nothing and adds no command.
- **Band row.** Bento plugins each draw at most one row above the prompt. The row stays hidden when fewer than `minBandRows` rows are free. Rows from other plugins that draw above the prompt without passing the rest of the chain on can hide Bento rows; disable that plugin to confirm.
- **Command names.** Each command registers under its bare name. If Claude Code or another plugin already owns the name, it registers as `compact-<name>` instead.
- **Terminal and desktop.** Every band text has an equivalent for terminal sessions (plain text and a few emoji glyphs) and for the desktop app (an SVG). Toasts carry text only; when a desktop surface is attached they omit emoji.
- **Estimates.** Any dollar figure is an estimate from a built-in price table with a date; it is labelled as such and can be replaced with `pricesJson` where that option exists.
- **Checking the install.** `claude plugin validate plugins/compact` (from a clone of this repo) must report no errors. Spec (normative, more detail): [specs/compact.md](../../specs/compact.md), shared rules in [specs/00-conventions.md](../../specs/00-conventions.md).
