# 0004. Model delegation policy: orchestrator, Sonnet builder, Haiku gatherer

- Status: Accepted
- Date: 2026-10-11 (orchestrator mode default on: 2026-10-12)

## Context

Frontier models are expensive. Having them type code a cheaper model could write wastes budget, and a subagent call without an explicit model inherits the expensive main model.

## Decision

The frontier model orchestrates, decides and reviews. Sonnet builds all well-scoped implementation, tests and git operations. Haiku gathers (research, sweeps, reading). A stronger subagent is used only for hard diagnosis, with a stated reason. Every subagent call sets `model` explicitly. An always-on Orchestrator section of about 100 tokens (the `compact` plugin's `orch` mod) states this in every prompt, and the `agents` plugin's Delegation Guard checks that each spawn names a model (`warn` by default, `deny` optional).

## Alternatives

- Forcing the subagent model with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`: rejected, because it blocks deliberate escalation and overrides per-call and agent-definition models. Recommendation: do not force.
- `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` is kept only as a fallback.

## Consequences

- Cheaper workers need precise briefs: scope, files, constraints, acceptance check.
- The guard can run in warn or deny mode; the Orchestrator section works without it.
- Cheaper models alone did not stop runaway spend; nesting had to be guarded separately ([0006](0006-subagent-nesting-guard.md)).

## References

- `specs/compact.md` section 6 (Orchestrator mode) and section 8 (context budget)
- `specs/agents.md` section 4 (Delegation Guard)
- `docs/code-blind-tdd.md` section 2 (role table)
