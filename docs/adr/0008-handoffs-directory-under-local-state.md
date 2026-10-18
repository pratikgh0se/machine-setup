# 0008. Handoffs live in `~/.local/state/claude-handoffs`

- Status: Accepted
- Date: 2026-10-15

## Context

A live probe showed that Claude Code treats every path under its own config directory as a sensitive file. The model's writes there were denied even with an explicit allow rule.

## Decision

Handoff files are written to `~/.local/state/claude-handoffs/`. A user-level allow rule for that path (`Edit(~/.local/state/claude-handoffs/**)`) makes it writable. The earlier `<repo>/handoff/` location is superseded for the agent handoff (the `/handoff` command still uses it inside a repo).

## Alternatives

- Keeping the files under the config directory with an allow rule: denied by the harness.
- A repo-local `handoff/` directory: superseded.

## Consequences

- The directory sits outside the config tree, so bootstrap must create it; it is in the default directory list.
- Hooks, the nudge, the canary and the health log all share this one location.

## References

- `specs/compact.md` F33.12
- `specs/machine-setup-spec.md` section 3 (default directories) and section 11.4
