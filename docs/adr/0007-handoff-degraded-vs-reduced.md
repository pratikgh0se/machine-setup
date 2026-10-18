# 0007. Handoff states: DEGRADED is loud, REDUCED is logged only

- Status: Accepted
- Date: 2026-10-16

## Context

Every handoff failure path (hook crash, stale agent file, Haiku timeout, missing latest file) used to end in a silent exit. A compaction whose handoff is missing or stale must never be silent, but alerting on every harmless fallback would train users to ignore alerts.

## Decision

The PreCompact hook computes a status. DEGRADED means a section failed, a section is stale, or there is no fresh agent file and the Haiku fallback also failed: it raises a toast, a band chip and a warning line to the model. REDUCED means the handoff was usable but partial (no fresh agent file, Haiku fallback worked, no section errors): it is written to the health log with status `reduced` and counted in the weekly report, with no toast or chip. Health lines go to `~/.local/state/claude-handoffs/health.jsonl`, and a nightly canary exercises the whole chain.

## Alternatives

An earlier ruling that an absent agent file is always degraded was replaced by this split.

## Consequences

- Users see only true degradation, not every fallback.
- The weekly report (rule R12) fires when more than 10% of compactions were degraded, a canary night failed, or the canary has not run for 3 days; reduced handoffs never fire it.
- A minimum sample size before trusting the degraded-rate threshold is an open item.

## References

- `specs/handoff-hooks-spec.md` section F36 (F36.A to F36.G)
- `specs/compact.md` section F36
- `docs/token-budget-spec.md` (rule R12)
- `tools/handoff-canary/README.md`
