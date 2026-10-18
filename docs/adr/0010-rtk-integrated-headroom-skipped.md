# 0010. RTK output compression integrated; Headroom proxy skipped for now

- Status: Accepted
- Date: 2026-10-12

## Context

A token-saving survey produced many candidates. Two stood out: RTK, a Bash output rewriter, and Headroom, a request-level proxy.

## Decision

RTK is integrated fully (not as a trial), installed as a hook-only init, and the test parsers in the `dev` plugin accept RTK-rewritten output. Headroom is skipped for now and revisited after a week of measurement: a proxy that forwards the subscription OAuth token is a grey area even for one user, a shared proxy is not acceptable, and its MCP mode is safe but small. Its cache-prefix behaviour is the open unknown.

## Alternatives

- Trial-only RTK: rejected in favour of full integration.
- Headroom as a proxy: skipped.

## Consequences

- RTK coexists with the existing Bash guard hooks.
- Test-output parsers must accept compressed summaries.
- The Headroom decision depends on a measurement that is not recorded in this repo.

## References

- `specs/dev.md` section 0, "Rewritten output (decided 2026-10-12)"
