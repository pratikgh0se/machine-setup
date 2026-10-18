# 0006. Subagents never spawn subagents, with a nesting guard

- Status: Accepted
- Date: 2026-10-15

## Context

Spend analysis over a week of use showed that most subagents had been spawned by other subagents. Each nested agent starts with a large context, and the worst ones looped for hundreds of calls.

## Decision

The `agents` plugin's Delegation Guard has a nesting guard with three modes: `warn` (default), `deny` and `off`. A nested spawn is detected from the parent agent id. In `deny` mode the spawn is refused with a message telling the subagent to return to the orchestrator. Forks are not exempt. A runaway warning fires once per threshold per agent above 100 steps or 300k tokens of context (toast only). The rule is also written into the delegation policy ("subagents never spawn subagents").

## Alternatives

Cheaper models alone were explicitly judged not to be the fix. Detecting the parent through a `tool.call` hook is kept as a fallback if the parent id is missing on a nested spawn.

## Consequences

- A subagent that needs more help must stop and return to the orchestrator.
- `warn` is the default, so violations are visible but not blocked.
- The type allowlist does not apply to nesting; it only applies to the model check.
- The weekly token-budget report lists risky sessions (nested spawns, more than 100 steps, context over 300k).

## References

- `specs/agents.md` section F34 (F34.1 to F34.4)
- `tools/token-budget/README.md` (Spend breakdown, Risky sessions)
