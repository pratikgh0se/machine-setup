# 0014. Hook-owned project decisions ledger, injected after compaction

- Status: Accepted
- Date: 2026-10-25

## Context

Older decisions were lost across repeated compactions. Measured by how many compactions had happened since a decision was made, the share of decisions still recalled was 93%, 44%, 21% and 16%. Several causes were found:

- The agent note is rewritten at each nudge, and each rewrite loses about half of the earlier detail.
- The F38 fresh summary only reads the conversation after the last compact boundary, so it is blind to older segments.
- Old facts were "present but ignored": they were in the injected text but the model did not use them.
- Question-and-answer replay was undated, so old and new answers looked equally current.
- The earlier quiz only covered the latest segment, so it could not see any of this.

## Decision

The hooks own a per-project decisions ledger (F39 to F39.11 in `specs/handoff-hooks-spec.md`), not the agent.

- One ledger per project, keyed by the git root. The user chose per-project over per-session on 2026-10-25.
- At each compaction a Sonnet call merges the old ledger with the new segment. Code validates the result. Decisions are superseded, never deleted.
- The ledger is injected in its own two parts (F39.10), with an authority line telling the model the ledger outranks older prose. Authority order: the ledger, then the fresh summary, then the agent note.
- The handoff budget is 14k characters (F39.11 allows 700-character entries and parses before cutting, keeping concrete values).
- The summary is state-honest: it reports what is actually in force, not what was discussed.
- The ledger is also injected at session startup and resume, not only after compaction.
- The "Decisions via questions" section is no longer injected.

## Alternatives

- Per-session ledger: rejected: decisions are about the project and outlive any one session.
- Agent-maintained ledger: rejected: the agent already loses about half per rewrite, so it would repeat the same failure.
- A 4,000-character decisions section inside the handoff: measured 21.9 against 56.2 for the ledger.

## Results

Old-decision quiz, scored out of 100: 13.5 before, 56.2 with the ledger (ceiling 61.1). By age: 21 to 66, 10 to 56, 8 to 44. The recent-decision score stayed at 62.5. The merge made 19 supersessions; 10 of 10 spot-checked were correct.

## Consequences

- Two Sonnet calls per compaction, about $0.10 to $0.20 and 20 to 40 seconds.
- Parallel chats in one repository share one ledger; a file lock guards it.
- `HANDOFF_LEDGER=0` disables it; `HANDOFF_LEDGER_MODEL` sets the model.

## References

- `specs/handoff-hooks-spec.md` sections F39 to F39.11
- Code commits b850293, 0948192, 5d6e3f8, 0e36b26
- [0013](0013-fresh-summary-at-compaction.md), [0007](0007-handoff-degraded-vs-reduced.md)
