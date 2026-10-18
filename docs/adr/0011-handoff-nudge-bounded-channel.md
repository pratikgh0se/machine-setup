# 0011. Handoff nudge through a bounded model-facing channel

- Status: Accepted
- Date: 2026-10-15

## Context

Only the agent that did the work holds the full context. The `/handoff` command needs the user to type it, and a deterministic fact dump taken at compaction time is not enough on its own.

## Decision

A `nudge` mod in the `compact` plugin asks the working model to write an agent handoff file when context reaches 75% of the auto-compact window, and again every 50k tokens. The note is delivered as a single `context` entry appended to the next tool result (or prompt), so it costs no extra turn and nothing in the band. The file has six fixed headings: Goal, Decisions and why, Done, In progress, Dead ends, Exact next step. The plugin writes only a small meta file (counts and timestamps, no text). The PreCompact hook uses the agent file when it is fresh and the Resume loader falls back to it when no `/handoff` was saved. Version 1.1.0 added staleness detection for the two volatile headings.

## Alternatives

Not recorded.

## Consequences

- It adds a one-shot model-visible note, so the budget rules of [0005](0005-mods-add-zero-model-context.md) apply (about 130 tokens per delivery, zero always loaded).
- The model may ignore the note; nothing blocks or compacts for it.
- A stale or missing agent file degrades the handoff ([0007](0007-handoff-degraded-vs-reduced.md)).

## References

- `specs/compact.md` F33 (F33.1 to F33.12) and F35
- `specs/handoff-hooks-spec.md` F35 and section 4
