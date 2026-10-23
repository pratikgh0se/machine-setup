# 0013. Fresh Sonnet summary at every compaction, replacing the Haiku fallback

- Status: Accepted
- Date: 2026-10-23

## Context

A blind resume quiz measured how much a model remembers after compaction, scored out of 100. The compaction summary alone scored 62. Adding the agent handoff file raised it to 68. Adding a fresh Sonnet-written note raised it to 75 to 76. Perfect recent memory scored 85. Prompt variants for the summary did not move the score. The agent notes were written about 15k tokens before compaction, so the gain comes from a fresh, focused writer reading the latest conversation, not from wording.

The previous design ran a Haiku summary only when no fresh agent file existed.

## Decision

The PreCompact hook runs a Sonnet summary on every compaction, whether the agent file is fresh, stale or absent, and adds it as its own section (F38 in `specs/handoff-hooks-spec.md`). The Haiku fallback is removed. The model is `sonnet` by default; the excerpt is the conversation after the last compact boundary, capped at 120,000 characters; the call has a 75 s timeout.

## Alternatives

- Keep the Haiku fallback only when the agent file is missing: rejected, the quiz gain comes from freshness, which the agent file cannot give.
- Prompt tuning: tried, no measurable gain.

## Consequences

- Cost is about $0.05 to $0.10 and 15 to 30 seconds per compaction.
- A failed or timed-out summary is logged (`fallback: failed|timeout`) and shown as a failure line; with no fresh agent file this is DEGRADED ([0007](0007-handoff-degraded-vs-reduced.md)).
- The nightly canary sets `HANDOFF_SUMMARY_MODEL=haiku` to stay cheap.
- Disable switches: `HANDOFF_SUMMARY=0` (or the legacy `HANDOFF_HAIKU_FALLBACK=0`). Also `HANDOFF_SUMMARY_MODEL` and `HANDOFF_SUMMARY_TIMEOUT` (1 to 300 s).

## References

- `specs/handoff-hooks-spec.md` section F38 and acceptance criteria 81 to 92
- [0007](0007-handoff-degraded-vs-reduced.md), [0001](0001-compact-window-400k-with-handoff.md)
