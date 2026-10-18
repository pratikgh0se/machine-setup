# 0005. Mods add (near) zero tokens to model context

- Status: Accepted
- Date: 2026-10-11

## Context

Users on a subscription cannot absorb extra per-request context cost, and plugins were expected not to add to the context.

## Decision

Every mod must have a near-zero model-visible cost. Mods render through UI surfaces and hooks. Where a mod must speak to the model, it uses a bounded, one-shot channel, for example the handoff nudge delivered as a `tool.call` context entry, and the cost is counted against a published budget.

## Alternatives

Not recorded.

## Consequences

- Each plugin carries a stated budget; the Orchestrator section costs about 100 tokens when on and zero when off, and the whole suite stays within a 500 token cap.
- Command and skill listings must be kept short.
- The weekly token-budget report keeps the footprint under review.

## References

- `specs/compact.md` section 8 (budget table) and F33.1 (model-facing channel)
- `tools/token-budget/README.md`
