# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.6.0] - 2026-11-14

### Added

- Handoff hooks 1.8.0 (F44.13): the recall meaning index now refreshes for every project, not only on compaction. `recall.py index --all [--max-seconds N]` indexes every git project with Claude Code history (newest first, stops once if the embedding server is down). A new `SessionEnd` hook runs `recall.py session-end`, which starts a detached `index --cwd` for the ended session's project. A daily 03:30 launchd job (`launchd/recall-index.plist.tmpl`) runs `index --all --max-seconds 3000`.

## [1.5.1] - 2026-11-14

### Fixed

- Handoff hooks 1.7.1 (F44.12): `recall.py open --full` prints messages up to 40,000 chars and `--from <N>` pages through longer ones (a 14,300-char message was cut at the old 12,000-char output cap). Meaning search waits up to 30 s for a cold embedding model and keeps it loaded (`keep_alive`). The recall line says the decisions list and the user's latest words win over recall when they disagree.

## [1.5.0] - 2026-11-14

### Added

- Handoff hooks 1.7.0 (F44): `recall.py`, based on the LCM paper (Ehrlich and Blackman, "LCM: Lossless Context Management", arXiv:2605.04050). It searches every earlier chat in the same project word for word and by meaning (hybrid: keyword plus a local `bge-m3` embedding index via Ollama, keyword-only when Ollama is off). Subcommands: `search`, `open`, `user`, `handoffs`, `index`. Secrets are redacted before printing and before embedding.
- One recall line in every handoff and in ledger part 1, telling Claude to look up exact commands, numbers and the user's wording instead of guessing. The settings template allows `python3 ~/.claude/hooks/recall.py` without a prompt.
- PreCompact starts a detached meaning-index update after writing the handoff.
- `--ledger-repair <repo>` restores finished-item text that older versions cut short.

### Fixed

- RESOLVED and SUPERSEDED lines keep their full original text (they were cut at 700 chars, dropping `| why:`).
- Active ledger lines without `| why:` are injected instead of silently skipped, and logged to `hooks-error.jsonl`.
- `--ledger-maintain` rejects a missing folder (exit 2) and creates nothing when a project has no ledger.

## [1.4.0] - 2026-11-09

### Added

- Handoff hooks 1.6.0 (F42): each decision is tagged as a rule, decision or task, and finished items can be marked RESOLVED. After compaction and at startup or resume, rules go in first in full, and an index covers the rest so no decision is dropped (3 parts). `--ledger-maintain <repo>` tidies an existing list. Hook errors are logged to `hooks-error.jsonl`.
- Compact plugin 1.4.0 (F43.7): a seventh generic heading, "Parallel work running".

### Changed

- Compact plugin 1.4.0 (F43): the reminder ceiling now uses the real compaction point (about 367k), and the final reminder fires about 12k before it. Fill is measured live during long turns (on tool calls, at most once per 10 s). A standing-rules line is added. The skip log is written once per cycle.
- Compact plugin 1.4.0 (F43.8): the stale-note warning persists until the current-state sections are rewritten, and the pending reminder is rebuilt from the live size.
- Autosync no longer overwrites repo files that are newer than the live copy.

## [1.3.0] - 2026-10-27

### Changed

- Compact plugin 1.3.0 (F41, D11): the handoff nudge now repeats every 25,000 tokens (was 50,000) from 75% of the window, so the agent handoff is fresher at compaction.

### Added

- Faster, fresher decisions ledger (F40, handoff hooks 1.5.0): the merge now returns only the changes (new decisions and `SUPERSEDE` lines) and code applies them, so the call is much shorter and nothing is ever dropped. It has its own timeout `HANDOFF_LEDGER_TIMEOUT` (1 to 300 s, default 100), reads messages oldest first up to 40,000 characters so a backlog is caught up over several compactions, and ignores synthetic entries (tool output, command echoes, task notifications) when judging freshness. The health line gains `ledger_error`. The PreCompact hook timeout is now 150.
- Compact plugin: final nudge at `nudge_finalPercent` (default 90%, 0 disables) worded "Compaction is imminent", a delivery-time safety net that re-derives the due step from the last measured size on every tool call and prompt, and a debug log `nudge-debug.jsonl` (`nudge_debugLog`, rotated at 1 MB).

## [1.2.0] - 2026-10-25

### Added

- Project decisions ledger (F39 and F39.10 to F39.11, handoff hooks): a per-project ledger keyed by git root, merged by Sonnet at each compaction with code validation (supersede, never delete), injected in its own two parts with an authority line, and also at startup and resume. The handoff budget is 14k and the summary is state-honest. New switches `HANDOFF_LEDGER` (`0` disables) and `HANDOFF_LEDGER_MODEL`. See [ADR 0014](docs/adr/0014-project-decisions-ledger.md).

### Changed

- "Decisions via questions" is no longer injected as a section.

### Fixed

- The example key in the token-budget spec (AC 10) is now a plain placeholder, so gitleaks no longer flags it.

### Removed

- `.gitleaksignore`, no longer needed after the placeholder fix.

## [1.1.0] - 2026-10-23

### Added

- Fresh summary at every compaction (F38, handoff hooks): the PreCompact hook now runs a Sonnet-written summary on every compaction, whether the agent file is fresh, stale or absent. It replaces the Haiku fallback. New switches `HANDOFF_SUMMARY` (`0` disables), `HANDOFF_SUMMARY_MODEL` (default `sonnet`) and `HANDOFF_SUMMARY_TIMEOUT` (1 to 300 s, default 75); the legacy `HANDOFF_HAIKU_FALLBACK=0` still disables it. The health line gains `summary_model`. See [ADR 0013](docs/adr/0013-fresh-summary-at-compaction.md).

### Fixed

- token-budget reads `OBSIDIAN_VAULT_PATH` from `settings.json` when run under launchd.

## [1.0.0] - 2026-10-19

First release with full documentation.

### Plugins (marketplace `bento`)

| Plugin | Version |
|---|---|
| `safety` | 1.0.3 |
| `usage` | 1.0.5 |
| `awareness` | 1.0.4 |
| `agents` | 1.2.0 |
| `dev` | 1.0.4 |
| `compact` | 1.2.0 |

### Added

- Initial public release: six plugins with 26 mods, the token-budget weekly loop, handoff hooks, settings and `CLAUDE.md` templates, and macOS setup scripts with a private overlay and a leak guard.
- Handoff nudge (F33): the `compact` plugin asks the model to write an agent handoff file at 75% of the auto-compact window; handoffs moved to `~/.local/state/claude-handoffs`.
- Handoff quality (F35, `compact` 1.1.0): stale-section detection, freshness rules, and decisions, tasks and agents in the facts dump.
- Handoff reliability (F36, `compact` 1.2.0): health log, fail-safe handoff sections, the DEGRADED and REDUCED split, the `handoffalert` mod, a nightly handoff canary (launchd, 03:30), and a handoff-health section plus rule R12 in the token-budget report.
- Public push gate: `setup/publish.sh` to review and publish unpushed public commits, with a leak scan of the range before `--push`.
- Handoff keeps the user's words (F37, handoff hooks 1.2.0): the handoff file cap rises from 9,500 to 20,000 characters, "Last user messages" is the last section dropped when over the cap, and the post-compaction handoff is injected in up to three SessionStart parts (each under the 10,000-character hook limit; verified live that all parts reach the model).
- Documentation: `ARCHITECTURE.md`, architecture decision records in `docs/adr/`, a README with an overview diagram, a handoff timeline and one illustration per plugin, and this changelog. Contract tests are public at [pratikgh0se/bento-mods-tests](https://github.com/pratikgh0se/bento-mods-tests).

### Changed

- Autosync commits the public repo locally and never pushes it; it logs and notifies that commits await review. The private overlay still pushes.
- Setup: overlay-owned files take precedence, and the overlay `config.env` is exempt from the leak scan.

### Fixed

- launchd jobs now set `PATH` in their environment.
- launchd entry scripts default `USER` and `LOGNAME` (needed for Keychain-backed `claude` and `gh` auth under launchd).
- Bootstrap skips `__pycache__` and `*.pyc` when installing files into `~/.claude`.
- Handoffs directory path fix in the setup scripts.
