# Handoff hooks: behaviour contract

Scope: `precompact-handoff.py` (PreCompact) and `postcompact-inject.py` (SessionStart, matcher `compact`).
Installed at `~/.claude/hooks/`; byte-identical repo copies in `claude/hooks/`. Tests target either copy by path.
Freshness rule source of truth: Bento spec `bento-mods/specs/compact.md` F33.4 (restated in section 4 and AC 5-11).
This spec is written for a code-blind tester: it describes behaviour only.

**Named constant (single place to change if the directory moves):**
`HANDOFFS_DIR = $HOME/.local/state/claude-handoffs` (moved 2026-10-15: Claude Code denies model writes under `~/.claude/` as sensitive files; see Bento specs/compact.md F33.12). Every other mention of the handoffs directory in this document means `$HANDOFFS_DIR`; tests should define it once.

## 1. Purpose

Before Claude Code compacts a session, write a deterministic handoff file so the post-compaction session can recover its working state.
`precompact-handoff.py` writes it. `postcompact-inject.py` feeds `<sid>-latest.md` back as `additionalContext` on the post-compact SessionStart.
Both are best-effort and must never block or fail compaction: they always exit 0.

Registration (`~/.claude/settings.json`): `hooks.PreCompact[0].hooks[0]` = `python3 ~/.claude/hooks/precompact-handoff.py`, timeout 90 s.
`hooks.SessionStart[]` entry with `matcher: "compact"` = `python3 ~/.claude/hooks/postcompact-inject.py`, timeout 10 s.
(settings.json stores absolute paths; the repo copy stores `__HOME__`.)

## 2. Inputs

### 2.1 precompact-handoff.py
stdin: one JSON object. Fields used:
- `session_id` (string; default `"unknown"`; any `/` replaced with `_` for filenames)
- `cwd` (string; used for the git section and echoed in the header)
- `transcript_path` (string; JSONL file)
- `trigger` (echoed; if absent the header prints the literal `None`)

Env vars:
- `HOME`: root of everything. Output dir is `$HANDOFFS_DIR`.
- `HANDOFF_HOOK_CHILD`: if set to any non-empty value, exit 0 immediately and write nothing (recursion guard).
- `HANDOFF_HAIKU_FALLBACK`: exactly `"0"` disables the Haiku fallback. Any other value (or unset) leaves it enabled.
- `PATH`: used to resolve `claude` and `git`.

Files read:
- the transcript JSONL (tolerates missing file / bad lines)
- `<dir>/<sid>-agent.md` and `<dir>/<sid>-agent.meta.json` (agent-written handoff and its meta)

Transcript line format: one JSON object per line.
- `{"type":"user","message":{"content": <str | [blocks]>}, "isMeta"?: bool}`
- `{"type":"assistant","message":{"content": <str | [blocks]>}}` with blocks `{"type":"text","text":..}` and `{"type":"tool_use","name":..,"input":{..}}`.
- A user entry whose content list contains a `tool_result` block is ignored. `isMeta: true` entries are ignored.
- User text is "genuine" only if non-empty after strip and NOT starting with any of: `<task-notification`, `[SYSTEM NOTIFICATION`, `<system-reminder`, `<command-name`, `<local-command`, `<command-message`, `Caveat:`, `This session is being continued`.
- Tool uses: `Edit|Write|NotebookEdit|MultiEdit` give files (`file_path` or `notebook_path`; re-touching a file moves it to the end, no duplicates); `Bash` gives commands (`input.command`); `TaskCreate` creates task id `"1","2",...` (counter of TaskCreate calls) with status `pending` and `subject`; `TaskUpdate` (`taskId`, optional `subject`, optional `status`) updates or creates that id.

### 2.2 postcompact-inject.py
stdin: JSON object with `session_id`. Env: `HOME` only (via `~` expansion). File read: `$HANDOFFS_DIR/<sid>-latest.md`.

## 3. Outputs: precompact-handoff.py

stdout and stderr: always empty. Exit code: always 0.

Files written to `$HANDOFFS_DIR` (dir created if missing):
1. `<sid>-<YYYYMMDDTHHMMSSZ>.md` (UTC timestamp, second resolution)
2. `<sid>-latest.md`: byte-identical copy of (1).

If stdin has no usable `session_id`, `<sid>` is `unknown`.

### 3.1 File layout (headings in this order; any section may be absent)
```
# Handoff (pre-compaction)
- session: <sid>
- cwd: <cwd>
- trigger: <trigger>
- time: <YYYY-MM-DD HH:MM:SSZ>
- transcript: <transcript_path>
<blank line>
<LEAD, optional>
<sections joined by "\n", optional>
<blank line>
Full transcript: <transcript_path>. Read it for exact details before guessing.
```
LEAD, when non-empty, is one of the following (see section 4), followed by the line `## Facts (auto-extracted)` (the Facts line follows any non-empty lead, including the failure line):
- `## Agent handoff (written by the working agent)` + newline + agent body (stripped, max 5000 chars; truncated form ends in `...`), then a blank line
- `## Model-written handoff (Haiku fallback; verify against facts)` + newline + Haiku text (max 4000 chars), then a blank line
- a single line `Haiku fallback failed: <reason>`, then a blank line

Auto-extracted sections, in this order (each only when it has content):
1. `## Last user messages (oldest first)`: last 8 genuine user messages, each `- ` + text truncated to 600 chars with newlines replaced by spaces.
2. `## Files touched (last 30)`: `- <path>` for the last 30 distinct files, oldest first.
3. `## Task state`: `- [<status>] <subject truncated to 150>` per task in insertion order.
4. `## Git`: only if `cwd` is an existing dir inside a git work tree: `- branch: <branch>` then a fenced block of `git status --short` truncated to 1500 chars. Detached HEAD gives an empty branch.
5. `## Last Bash commands`: last 5 commands as ``- `cmd` `` (truncated to 200 chars, newlines to spaces).
6. `## Last assistant message`: last non-empty assistant text, truncated to 1500 chars.

`trunc(s,n)`: strip; if longer than n, first n-3 chars + `...`.

### 3.2 Char cap and trim order
Total file length is at most 9,500 chars (keeps SessionStart context under 10k). Header, LEAD and footer are never trimmed.
While over the cap, whole auto-extracted sections are dropped in this order: Last user messages, Files touched, Task state, Git, Last Bash commands, Last assistant message (so the last assistant message is the last to go). Sections are removed whole, never cut mid-section.

### 3.3 Degraded file
If building the body raises an unexpected exception, the file is instead:
```
# Handoff (pre-compaction, degraded)
- session: ..
- cwd: ..
- trigger: ..
- transcript: ..
- error: <repr(exception)>
```
and is still written to both paths. (Hard to provoke from outside; not covered by an AC.)

### 3.4 Cleanup
After writing, every `*.md` directly in the handoffs dir whose mtime is older than 14 days is deleted (this includes `*-agent.md` and `*-latest.md` of old sessions). Non-`.md` files (e.g. `*-agent.meta.json`, `*.txt`) and subdirectories are never deleted. The files just written are never deleted.

## 4. Lead selection: fresh vs stale vs no-meta vs fallback

`A = <dir>/<sid>-agent.md`, `M = <dir>/<sid>-agent.meta.json` (sid with `/` replaced by `_`).
A is FRESH when it exists, size >= 300 bytes, AND:
- M missing, unreadable, invalid JSON or not an object ("no meta"): mtime of A within the last 30 minutes (<= 30 min).
- M valid object: `agentWrittenAt` (number, not bool) present, AND either
  (a) `lastNudgeAt` is a number and `agentWrittenAt >= lastNudgeAt`, OR
  (b) `ctxTokens` and `agentWrittenAtTokens` are numbers and `ctxTokens - agentWrittenAtTokens <= 50000`.
  No `agentWrittenAt` means STALE. Non-number fields are treated as absent. mtime is ignored when meta is valid.
- Size < 300 bytes: STALE regardless of meta.

Decision:
1. FRESH: LEAD = Agent handoff section; Haiku is NOT invoked (even when fallback is enabled).
2. Not fresh and `HANDOFF_HAIKU_FALLBACK == "0"`: LEAD empty, and NO `## Facts (auto-extracted)` line is emitted.
3. Not fresh and fallback enabled: build an excerpt of the transcript (last 40 genuine user/assistant messages, each text truncated to 2500 chars, tool uses rendered `[tool <Name>: <key input truncated to 300>]`, whole excerpt cut to its last 30000 chars). If the excerpt is empty (missing/empty transcript) the result is failure reason `no transcript excerpt` and `claude` is not run. Otherwise run `claude` (resolved via `PATH`): argv starts `claude -p --model haiku --output-format text --no-session-persistence --setting-sources project --strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands --tools ""`, the handoff prompt is the final argument, the excerpt goes on stdin; cwd = a fresh temp dir; env = parent env minus `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, plus `HANDOFF_HOOK_CHILD=1`; timeout 75 s.
   - exit 0 and stdout (stripped) >= 50 chars: LEAD = Model-written handoff section (text cut to 4000).
   - otherwise LEAD = `Haiku fallback failed: <reason>`, reason one of `claude exited <rc>`, `empty or too-short output`, `timeout after 75s`, `claude binary not found`, `no transcript excerpt`, or an exception class name.

## 5. Isolation for tests

- Overrides that exist: `HOME` (all paths derive from `~`; verified: with `HOME=<tmp>` the hook writes only under `<tmp>/.claude/handoffs/ (= HANDOFFS_DIR)`, and inject reads only from there), `HANDOFF_HAIKU_FALLBACK`, `HANDOFF_HOOK_CHILD`, `PATH`.
- There is NO env override for the handoffs dir, cap, freshness thresholds or timeout. They are constants. Tests must set `HOME` to a temp dir.
- Stubbing `claude`: it is invoked by bare name, so put an executable `claude` shim first on `PATH`. The shim gets the excerpt on stdin and the argv above; it can record them and print Haiku text. `git` is also resolved through `PATH`.
- Pass `HANDOFF_HAIKU_FALLBACK=0` in every test that is not about the fallback, so the real `claude` is never called.
- Time control: freshness uses real mtimes; set with `os.utime`. The 30-min rule and the 14-day cleanup are tested by setting mtimes, not by faking a clock. Meta freshness uses only meta numbers.
- Git section: needs `git` and a temp git repo as `cwd`.

### Testability gaps
- The `claude` path is not hard-coded (good), but the 75 s timeout cannot be shortened. Test the failure path with a shim exiting non-zero; a timeout test costs 75 s.
- Timestamped filenames have second resolution, so two runs in one second overwrite the same file. Sleep >= 1.1 s if two dumps are needed.
- `time:` header line is wall-clock: match with a regex.
- The degraded-file path (3.3) cannot be provoked from outside.

## 6. Outputs: postcompact-inject.py

Let `sid` = `session_id` (string) with every `/` replaced by `_` (the same rule precompact applies). If `sid` is non-empty and `$HANDOFFS_DIR/<sid>-latest.md` is a file, and its stripped content is non-empty, print exactly one line to stdout (`json.dumps` default separators):
```
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "Pre-compaction handoff (auto-saved):\n<stripped file content>"}}
```
(Compare by parsing JSON; `\n` there is a real newline in the decoded string.) In every other case (missing file, empty file, bad JSON, bad/absent/empty session_id, non-dict JSON) print nothing. stderr always empty. Exit 0 always. No size cap of its own.

## 7. Error handling summary
- Malformed/empty stdin to precompact is treated as `{}`; the hook still writes `unknown-<ts>.md` and `unknown-latest.md` (`session: unknown`, empty transcript).
- Non-object JSON stdin (`[]`, `5`): same as `{}`.
- Unwritable handoffs dir or any I/O error: swallowed, exit 0.
- Transcript missing/unreadable, non-JSON lines, non-dict JSON lines, entries without `message`: skipped; extraction continues.
- `BaseException` is caught at top level; exit is always 0.

## 8. Acceptance criteria (temp `HOME`; `HANDOFF_HAIKU_FALLBACK=0` unless stated)

Exit / IO
1. For stdin = valid payload, `{}`, `[]`, `garbage`, empty string: exit code 0, stdout empty, stderr empty.
2. Valid payload with `session_id: "S"`: `S-latest.md` and exactly one `S-YYYYMMDDTHHMMSSZ.md` exist in `$HANDOFFS_DIR`, with identical bytes.
3. Garbage stdin writes `unknown-latest.md` containing `- session: unknown`.
4. `HANDOFF_HOOK_CHILD=1`: exit 0, `$HANDOFFS_DIR` is not created, nothing written. Same with fallback enabled.

Freshness
5. Agent file >= 300 bytes, no meta, mtime now, fallback enabled: output contains `## Agent handoff (written by the working agent)` followed by the body, then `## Facts (auto-extracted)`; the claude shim is NOT invoked.
6. No meta, mtime 29 min old: fresh; 31 min old: stale (no agent section).
7. 299-byte agent file with otherwise fresh meta: stale. 300 bytes: fresh.
8. Meta `{agentWrittenAt:100, lastNudgeAt:100}`: fresh. Meta `{agentWrittenAt:99,lastNudgeAt:100,ctxTokens:60000,agentWrittenAtTokens:10001}` (diff 49,999): fresh; diff exactly 50,000: fresh; `agentWrittenAtTokens:9999` (diff 50,001): stale.
9. Meta without `agentWrittenAt` is stale even if the file mtime is now.
10. Valid-but-stale meta with file mtime now: still stale (mtime ignored when meta is valid).
11. Invalid-JSON meta behaves as no meta (mtime rule).
12. Agent body longer than 5000 chars appears cut to 5000 chars ending `...`.

Haiku fallback
13. Stale/no agent file, fallback enabled, shim `claude` printing >= 50 chars: output has `## Model-written handoff (Haiku fallback; verify against facts)` and the shim text; the shim saw argv containing `-p`, `--model`, `haiku`, `--tools`; stdin containing `USER: <a user message>` from the transcript; env `HANDOFF_HOOK_CHILD=1`; and no `CLAUDE_CODE_AUTO_COMPACT_WINDOW` even if the test set it.
14. Shim exits 3: output contains `Haiku fallback failed: claude exited 3`. Shim prints < 50 chars: `Haiku fallback failed: empty or too-short output`. No `claude` on PATH: `Haiku fallback failed: claude binary not found`. Missing transcript: `Haiku fallback failed: no transcript excerpt` and the shim is not invoked. In each case `## Facts (auto-extracted)` follows.
15. Shim output over 4000 chars is truncated to 4000 chars.
16. `HANDOFF_HAIKU_FALLBACK=0` with stale agent file: shim never invoked; output has neither the Haiku heading, the failure line, nor `## Facts (auto-extracted)`. Values `1` and empty string still enable the fallback.
17. Fresh agent file with fallback enabled: shim never invoked.

Content and ordering
18. Header lines appear in order session, cwd, trigger, time, transcript; the last line is `Full transcript: <path>. Read it for exact details before guessing.`
19. A transcript with every content kind (>8 user messages, >30 files, tasks, git-repo cwd with dirty tree, >5 Bash commands, assistant text): headings appear in the exact order of 3.1 items 1-6. Only the last 8 users, last 30 files and last 5 commands appear; a file touched twice appears once at its latest position.
20. Two TaskCreate then TaskUpdate `taskId:"2" status:"completed"` yields `- [pending] <s1>` and `- [completed] <s2>`.
21. Messages starting with each noise prefix in 2.1, `isMeta` entries, and tool_result user entries never appear in the user list. The last non-empty assistant text is used.
22. cwd not a git repo or non-existent: no `## Git` section, exit 0.
23. Malformed transcript lines (invalid JSON, a JSON array, `{"type":"user"}` with no message) are skipped; valid lines around them are still extracted.
24. Over-cap: file length <= 9,500 chars; sections drop in the order Last user messages, Files touched, Task state, Git, Last Bash commands, Last assistant message; each remaining section is whole. With a fresh 5000-char agent body plus large sections, header, agent section and footer stay intact.
25. Under the cap, nothing is dropped.

Cleanup
26. A `*.md` with mtime 15 days old (e.g. `old-latest.md`, `x-agent.md`) is deleted; one 13 days old is kept; a 15-day-old `x-agent.meta.json` and `notes.txt` are kept; a 15-day-old directory named `d.md` is kept.

Inject
27. With `S-latest.md` non-empty: stdout parses as one JSON object equal to `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Pre-compaction handoff (auto-saved):\n"+<content stripped>}}`; exit 0.
28. Missing latest file, empty/whitespace-only file, `session_id` missing or empty, invalid JSON stdin: stdout empty, exit 0.
29. Sanitising parity (normative, ruled 2026-10-15): for `session_id` `a/b`, precompact writes `a_b-latest.md` and inject given `{"session_id":"a/b"}` outputs that file's content (not nothing). Known to FAIL against current code (inject skips ids containing `/`); the code is to be fixed.
30. End to end: additionalContext produced from a hook-written file has length < 10,000.

## 9. Rulings and notes
- Sanitising: ruled a bug in inject; fixed by AC 29 (same `/` to `_` rule in both hooks).
- Cleanup deleting old `*-agent.md` is intended (documented in 3.4).
- Header prints literal `trigger: None` when `trigger` is absent (cosmetic).
- The 14-day cleanup also removes old `<sid>-agent.md` files (the model-written ones), since it globs all `*.md`; intended (ruled). Meta `.json` files are never cleaned, so they accumulate.
- If header + lead + footer alone exceed 9,500 chars (very long paths) the cap cannot be honoured.
- With fallback enabled and no shim, a real `claude -p` runs in tests (up to 75 s).
