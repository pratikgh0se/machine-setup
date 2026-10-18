# 0012. Public push gate: autosync never pushes the public repo

- Status: Accepted
- Date: 2026-10-18

## Context

On 2026-10-16 the scheduled autosync committed and pushed an unreviewed working-tree edit to the public repository.

## Decision

Autosync commits the public repo locally and never pushes it. It logs and notifies that unpushed public commits await review. The maintainer reviews with `setup/publish.sh` (shows the log and diffstat of the unpushed range) and publishes with `setup/publish.sh --push`, which leak-scans the added lines of the range first and only then pushes. The private overlay keeps pushing automatically.

## Alternatives

Not recorded.

## Consequences

- Public history only advances after a human looks at it and the leak scan passes.
- Unpushed public commits can accumulate until published; the notification repeats while any are pending.

## References

- `specs/machine-setup-spec.md` section "Public push gate" (acceptance items 87 to 90), sections 8 and 11.7
- `setup/README.md`
