# 0002. Code-blind tests in a separate repo, written from behaviour contracts

- Status: Accepted
- Date: 2026-10-11

## Context

An agent that writes both code and tests tends to fit one to the other, so the tests prove what the code does rather than what the spec says. Tests that an agent can see can also be gamed.

## Decision

The specs are the oracle. A tester writes contract tests from the behaviour spec alone, in a separate repo. Dev agents and the orchestrator never read the tests; only counts and failing test names flow back. A referee sees both code and tests and writes separate blind briefs when they disagree. A test that passes on old code must be shown failing against a clean copy of the previous commit, because `git stash` is blocked by a hook.

## Alternatives

Not recorded.

## Consequences

- Specs must be precise enough for a blind tester; a vague spec leads to guessing. This is the main risk.
- No published evaluation exists for the blind-tester, builder and referee loop. It is described as having worked here, not as proven.
- Outside contributors cannot run the contract tests, which live in a private repo; public checks are `claude plugin validate` and `tsc`.

## References

- `docs/code-blind-tdd.md` sections 1 and 2
- `CONTRIBUTING.md`
- `specs/machine-setup-spec.md` (header), `specs/compact.md` section 10
