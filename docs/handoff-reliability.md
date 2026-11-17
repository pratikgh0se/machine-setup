# Handoff reliability: misses, subagents, headless runs, proof

Handoff hooks 1.10.0 (F45 to F48). Contract: [`specs/handoff-hooks-spec.md`](../specs/handoff-hooks-spec.md). A hook cannot force Claude Code to run it, so the design is defence in depth: write early, recover after, detect every miss, check the install, and keep evidence.

## When a compaction is missed

| Step | What happens | Where |
|---|---|---|
| Write early | PreCompact writes `<sid>-pending.json` first, then a deterministic handoff (facts and the user's last messages) before the first model call. The health line removes the pending file. A hook killed at its timeout still leaves a handoff. | `precompact-handoff.py` |
| Recover | If the compaction still has no handoff, the SessionStart `compact` hook rebuilds one from the transcript (no model call, 6 s deadline) and prints `HANDOFF RECOVERED` on the first line. | `precompact-handoff.py --recover`, called by `postcompact-inject.py` |
| Install check | At SessionStart `startup` and `resume`, one `HANDOFF CHECK:` line appears when a hook is not wired, a hook file is missing or changed since install, the two hooks' versions differ, or reconcile found compactions without a handoff. Silent when all is well. | `postcompact-inject.py --check` |
| Nightly reconcile and proof | `--reconcile --prove --days 30` at 04:15 counts every `compact_boundary` in your transcripts against `health.jsonl` and proves each receipt. | launchd job `com.<prefix>.handoff-reconcile` (`launchd/handoff-reconcile.plist.tmpl`) |

`--check` also reads the manifest `~/.claude/hooks/.handoff-manifest.json` that `setup/bootstrap.sh` writes (a hash per installed hook file). Restart open Claude Code sessions after installing: hooks load when a session starts.

Real result, first 30-day reconcile on 2026-11-17: 188 of 192 main compactions covered. Of the 4 missed, 3 came from a deliberate sandbox probe run with user settings turned off and 1 was on 2026-10-23. For subagents, 0 of 28 compactions were covered; all of those predate this change.

## Subagents

When a subagent compacts, Claude Code fires the hooks with `agent_id` set but with the parent's `session_id` and `transcript_path`. The hooks now treat that as its own compaction.

- Each compacting subagent gets its own handoff, built from its own transcript (`<session>/subagents/agent-<agent_id>.jsonl` next to the parent transcript). Files are keyed `<sid>-a-<agent_id>`.
- The main session's handoff files are never read or written by a subagent event, and the other way round.
- A subagent run never merges the decisions ledger and never starts the indexer. The ledger rules are still injected into the subagent, as for the main agent.
- If the subagent transcript is missing, the health row says `degraded` / `agent_transcript_missing` and no handoff is written.
- The `compact` plugin (1.5.0) never nudges subagents.
- Compaction summariser forks (`agent_type` empty) are ignored.

## Headless runs

`claude -p` and the Agent SDK load user hooks by default. They skip them only with:

- `--bare`
- `disableAllHooks`
- `--setting-sources` without `user`
- SDK `settingSources: []`

Optional: `setup/bootstrap.sh --managed-hooks`. It is a standalone mode (it does nothing else). It writes `~/.local/state/machine-setup/managed-settings.json` (the existing system file, if any, merged with the handoff hook entries) and prints a `sudo install ...` command for you to run. The script never runs sudo. With managed hooks installed, only `--bare` can skip them. `--check` accepts hooks from user or managed settings. Reconcile counts headless sessions separately and reports any compaction that still got no handoff.

## Proof

Every handoff that `postcompact-inject.py` injects appends a receipt. `precompact-handoff.py --prove` checks receipts with plain code, no model and no cost.

| File (in `~/.local/state/claude-handoffs/`) | Written by | Holds |
|---|---|---|
| `receipts.jsonl` | `postcompact-inject.py` | One line per injected handoff: transcript, boundary time, hashes, first 300 chars |
| `proofs.jsonl` | `--prove` | One verdict per receipt (already proven receipts are skipped) |
| `proof-report.md` | `--prove` | Summary line first, then failed checks and skip counts |

| Check | Passes when |
|---|---|
| `lossless` | 5 sampled messages from the transcript come back word for word through recall's own commands (skipped if recall is absent or the transcript is short) |
| `right_agent` | every quoted user line in the handoff occurs in the receipt's own transcript |
| `delivered` | the transcript after the boundary holds the injected text |
| `decisions_safe` | no ledger id present before a merge is missing after it, and no superseded id came back |

Coverage is not a per-receipt check: it is reconcile's numbers. Receipts start with the first compaction after install, so earlier compactions have none.

| Command | Does |
|---|---|
| `precompact-handoff.py --reconcile [--days N]` | Counts compactions against handoffs; writes `reconcile.json` |
| `precompact-handoff.py --prove [--days N]` | Proves receipts, writes `proof-report.md`, evaluates the claims register |
| `precompact-handoff.py --claims` | Prints the claims table |
| `precompact-handoff.py --claims-lint <file.md>` | Checks `[C<n>]` markers in a document |
| `postcompact-inject.py --check` | Install check; also shows `proof failed` and `claims` alerts once |

## Claims register

`claude/hooks/claims.json` lists every public claim with its evidence source, window, refresh time and minimum rate. Each `--prove` run writes `claims-status.json` and `claims-report.md`.

| Status | Meaning |
|---|---|
| `pass` | rate at or above the minimum, evidence present and fresh |
| `fail` | rate below the minimum |
| `stale` | evidence older than its refresh time |
| `no-data` | no evidence in the window (neither failing nor stale) |

Before publishing a document that cites claims, run `--claims-lint <file.md>`: it fails on an unknown, failing or stale `[C<n>]`. The register holds only ids, texts, counts, rates and dates.

## State files

All in `~/.local/state/claude-handoffs/` unless noted.

| File | Purpose |
|---|---|
| `<sid>-pending.json` | Marker while PreCompact runs; removed by the health line |
| `<sid>-a-<agent_id>*` | Per-subagent twins of the handoff, latest, pending and note files |
| `health.jsonl` | One row per compaction (subagent rows carry `agent_id`, `agent_type`; merge rows carry ledger ids) |
| `reconcile.json` | Last reconcile result, plus the notice marker for `--check` |
| `receipts.jsonl`, `proofs.jsonl`, `proof-report.md`, `proof-notice.json` | Proof (above) |
| `claims-status.json`, `claims-report.md` | Claims evaluation |
| `reconcile.log` | Output of the nightly job |
| `~/.claude/hooks/.handoff-manifest.json` | Installed hook file hashes |
