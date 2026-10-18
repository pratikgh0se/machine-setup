# Architecture decision records

Decisions that shaped Bento, in MADR-lite form (Status, Date, Context, Decision, Alternatives, Consequences, References). Where the sources recorded no alternatives, the record says "Not recorded". References point to files in this repository.

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-compact-window-400k-with-handoff.md) | 400k auto-compact window plus handoff, instead of 1M | Accepted | 2026-10-15 |
| [0002](0002-code-blind-tests-in-separate-repo.md) | Code-blind tests in a separate repo | Accepted | 2026-10-11 |
| [0003](0003-public-repo-private-overlay.md) | Public repo plus private overlay | Accepted | 2026-10-16 |
| [0004](0004-model-delegation-policy.md) | Model delegation policy (orchestrator, builder, gatherer) | Accepted | 2026-10-11 |
| [0005](0005-mods-add-zero-model-context.md) | Mods add (near) zero tokens to model context | Accepted | 2026-10-11 |
| [0006](0006-subagent-nesting-guard.md) | Subagents never spawn subagents, with a nesting guard | Accepted | 2026-10-15 |
| [0007](0007-handoff-degraded-vs-reduced.md) | Handoff states: DEGRADED loud, REDUCED logged only | Accepted | 2026-10-16 |
| [0008](0008-handoffs-directory-under-local-state.md) | Handoffs live in `~/.local/state/claude-handoffs` | Accepted | 2026-10-15 |
| [0009](0009-mission-board-replaces-external-progress-plugin.md) | Mission Board replaces an external progress plugin | Accepted | 2026-10-12 |
| [0010](0010-rtk-integrated-headroom-skipped.md) | RTK integrated, Headroom skipped for now | Accepted | 2026-10-12 |
| [0011](0011-handoff-nudge-bounded-channel.md) | Handoff nudge through a bounded model-facing channel | Accepted | 2026-10-15 |
| [0012](0012-public-push-gate.md) | Public push gate | Accepted | 2026-10-18 |
