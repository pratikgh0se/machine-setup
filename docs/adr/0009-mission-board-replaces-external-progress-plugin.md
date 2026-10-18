# 0009. Mission Board replaces an external progress plugin

- Status: Accepted
- Date: 2026-10-12

## Context

An external progress plugin supplied step reports and a checklist band. The maintainer wanted tooling kept inside this repo rather than depending on another project's app.

## Decision

Mission Board, a mod of the `agents` plugin, becomes the single source of step reports and plan progress. Parity gaps (per-agent context, tokens, cost, run totals, effort, step text, accepted versus planned) were added afterwards. The external plugin was uninstalled only after Mission Board passed its tests.

## Alternatives

- Placing Mission Board in `awareness`: rejected, because the truth about what is running or done lives in the `agents` run table.
- Reading the external plugin's state passively: rejected; it is replaced, not read.

## Consequences

- Band rows from several plugins had to be designed to stack through the next hook in the chain.
- A parity backlog existed and was closed in `agents` 1.1.3 to 1.1.5.

## References

- `specs/mission-board.md` sections 0 and 3b, "Parity backlog"
- `specs/agents.md` section 1
