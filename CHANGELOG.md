# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
