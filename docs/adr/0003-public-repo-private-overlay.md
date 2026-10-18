# 0003. Public repo plus private overlay

- Status: Accepted
- Date: 2026-10-16 (approval date of the overlay spec; the split itself is not dated in the sources)

## Context

The setup tooling captures a Mac's Claude Code setup and launchd jobs. Captured values include repo lists, live settings, personal job definitions and identifiers, none of which may be published.

## Decision

The public repo holds the generic code: scripts under `setup/`, templates, generic hooks and generic launchd templates. All personal values live in a private overlay repo laid out as a mirror of the public tree. The overlay wins for files at the same path; `settings.json` is deep-merged (permission arrays unioned, other arrays replaced, `null` deletes a key). The overlay is found through `MACHINE_SETUP_PRIVATE`, else a sibling directory; `none` opts out. Export refuses to write personal files without an overlay.

## Alternatives

A single private repo is the implicit alternative; it is not recorded as rejected.

## Consequences

- A generic install works with no overlay, but export refuses and autosync does nothing.
- A leak scanner (pre-commit hook, export, CI) guards the public repo; reviewed exceptions go in an allowlist.
- Two repos must be kept in step; autosync commits both (see [0012](0012-public-push-gate.md)).

## References

- `OVERLAY.md`
- `specs/machine-setup-spec.md` sections 11.1 to 11.4 and 11.6, and 11.8 (leak guard)
