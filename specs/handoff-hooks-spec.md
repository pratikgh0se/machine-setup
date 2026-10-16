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

- Overrides that exist: `HOME` (all paths derive from `~`; verified: with `HOME=<tmp>` the hook writes only under `<tmp>/.local/state/claude-handoffs/ (= HANDOFFS_DIR)`, and inject reads only from there), `HANDOFF_HAIKU_FALLBACK`, `HANDOFF_HOOK_CHILD`, `PATH`.
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

## F35 additions (2026-10-16)
Draft for approval. Why: see `specs/compact.md` "F35 Handoff quality". These additions amend sections 2.1, 3.1, 3.2 and 4 of this contract; where a statement here conflicts with an earlier AC, the F35 statement wins and the amended earlier ACs are listed in AC 46. Code touched (for the builder): `claude/hooks/precompact-handoff.py` `parse()` (:39), `is_fresh()` (:134), `read_agent()` (:150), `lead_section()` (:238), `build()` (:251). `postcompact-inject.py` is unchanged.

### F35.A Inputs added
- Transcript entries may carry `"timestamp"` (ISO-8601 UTC string, e.g. `2026-10-16T10:32:05.123Z`). `lastUser` = the timestamp of the last GENUINE user message (same filter as 2.1) that has a parseable timestamp, in epoch ms. No such entry: `lastUser` is absent and the grace rule is skipped.
- Meta (`<sid>-agent.meta.json`) optional fields written by the compact plugin (compact.md F35.1): `sections` (heading name to 12-hex hash), `prevSections`, `stale_sections` (array of strings), `lastNudgeAt`, `lastUserMsgAt`. Non-array `stale_sections` and non-string members are treated as absent.
- Section hash: first 12 hex chars of SHA-256 of the section body (bytes after the heading line up to the next line starting `## ` or EOF, trailing whitespace stripped, `\r\n` as `\n`). Headings recognised: the six exact lines `## Goal`, `## Decisions and why`, `## Done`, `## In progress`, `## Dead ends`, `## Exact next step`.
- Tool results: a user entry whose `message.content` list holds a `tool_result` block with `tool_use_id` is read ONLY for the three F35 extractions below; it is still excluded from "Last user messages".

### F35.B Freshness v2 and staleness (supersedes the Decision in section 4)
Constants: `FRESH_GRACE_MS = 600000`, `STALE_USER_TURNS = 3`, `STALE_TOOL_CALLS = 40`.
`present` = the agent file exists and size >= 300 bytes. `fresh` = `present` AND the section-4 rule holds AND (`lastUser` absent OR file mtime ms >= `lastUser` - 600000) AND `stale_sections` (meta) is empty or absent AND NOT `hookStale`. `hookStale` = meta has `sections` AND the current hashes of "In progress" and "Exact next step" both equal the meta `sections` values AND, counting transcript entries whose timestamp is later than meta `lastNudgeAt`, genuine user messages >= 3 OR assistant `tool_use` blocks >= 40 (entries without timestamps are not counted; no `sections` or no `lastNudgeAt`: `hookStale` false).
Staleness reasons, in this order, joined with `; `: (a) meta `stale_sections` non-empty, or `hookStale`: `<names joined with ", "> unchanged since <T>` where names are `In progress, Exact next step` and `<T>` = UTC `YYYY-MM-DD HH:MM:SSZ` of meta `lastNudgeAt` (if absent, of the file mtime); (b) grace failed: `file written <T> is older than the last user message by more than 10 min` with `<T>` = file mtime UTC; (c) section-4 rule failed while `present`: `not updated since the last nudge`.
Decision (replaces section 4 steps 1-3):
1. Not `present` (missing, unreadable, < 300 bytes): as old steps 2 and 3 (no agent section; Haiku per `HANDOFF_HAIKU_FALLBACK`).
2. `present` and `fresh`: LEAD = Agent handoff section only; Haiku NOT invoked (unchanged).
3. `present` and not `fresh`: LEAD = the warning line `Agent handoff may be stale: <reasons>`, then the heading `## Agent handoff (written by the working agent)` and the agent body (stripped, max 5000 chars, `...` form as before), then a blank line, then, unless `HANDOFF_HAIKU_FALLBACK` is exactly `0`, the Haiku section or `Haiku fallback failed: <reason>` line exactly as section 4 (agent first, Haiku below). Then `## Facts (auto-extracted)`. The warning line is a bare line (no `#`), directly above the agent heading, no blank line between.
Byte layout of a stale lead: `Agent handoff may be stale: ...\n## Agent handoff (written by the working agent)\n<body>\n\n## Model-written handoff (Haiku fallback; verify against facts)\n<text>\n\n## Facts (auto-extracted)\n`.

### F35.C Cap (supersedes 3.2 for the lead)
Cap stays 9,500. Header, warning line, agent section and footer are never trimmed (agent body already <= 5000). When the total is over the cap because of the Haiku text, FIRST shorten the Haiku text (cut to fit, ending `...`); if less than 200 chars of it would remain, omit the whole Haiku section (the `Haiku fallback failed:` line, being short, is kept). Only then drop auto-extracted sections by the order in F35.D.

### F35.D Facts dump additions
New sections, with the final order in 3.1: 1 Last user messages, 2 `## Decisions via questions`, 3 Files touched, 4 Task state, 5 `## Open tasks`, 6 `## Background agents`, 7 Git, 8 Last Bash commands, 9 Last assistant message. Each only when non-empty. Drop order when over the cap (supersedes 3.2): Last user messages, Files touched, Task state, Git, Last Bash commands, Last assistant message, Background agents, Open tasks, Decisions via questions (the new three are the last to go, the question answers first of all being kept). No redaction exists in the current dump; the new sections add none and carry only the fields below (no message bodies, no tool inputs beyond them), each cut with `trunc` and newlines turned into spaces.
- `## Decisions via questions`: pair each assistant `tool_use` named `AskUserQuestion` (`input.questions[]` with `question`, optional `header`, `options[].label`) with the answer in the later user entry whose `tool_result.tool_use_id` matches. Answer source, in order: the entry's `toolUseResult.answers` map (question text to chosen label string; multi-select answers are the labels joined with `, `); else the result text pattern `"<question>"="<answer>"` repeated. Notes: `toolUseResult.annotations[<question>].notes` if present. A question with no answer (tool_result error, rejection, or missing) is skipped. Keep the LAST 10 pairs in transcript order, oldest first. Line: `- [<header>] <question> -> <answer>` with ` (notes: <notes>)` appended when notes exist; `[<header>] ` omitted when no header; question, answer and notes each `trunc(.., 200)`.
- `## Open tasks`: the latest task state with status != `completed`. Two sources, listed in this order: (i) `TaskCreate`/`TaskUpdate` state exactly as the existing `## Task state` builds it; (ii) `TodoWrite`, where the last `TodoWrite` call's `input.todos[]` (`content`, `status`) replaces all earlier TodoWrite state. Line `- [<status>] <subject-or-content trunc 150>`; statuses shown verbatim (`pending`, `in_progress`). Max 20 lines, then `- ... +<n> more`. `## Task state` is unchanged (it lists all tasks incl. completed).
- `## Background agents`: assistant `tool_use` named `Agent` (or `Task` when `input.subagent_type` is present) with `input.run_in_background` true. Its id = `agentId: <id>` (or `agent_id: <id>`) in the matching `tool_result` text; no id found: unfinished by definition until a notification names its `description`. Finished when a later user entry whose text starts `<task-notification` contains that id (or, with no id, the description string). Unfinished ones, in transcript order, max 10: `- <description trunc 100> (model: <input.model or "default">)`. No prompt text, no subagent_type, no ids.

### F35.E Acceptance criteria 31-48 (temp `HOME`; `HANDOFF_HAIKU_FALLBACK=0` unless stated; fixtures built with `os.utime`, meta JSON and transcript JSONL)
Freshness v2 and staleness
31. Agent file 400 bytes, no meta (mtime 1 min ago), transcript whose last genuine user message has timestamp 11 min after the file's mtime: output has the warning line `Agent handoff may be stale: file written <T> is older than the last user message by more than 10 min` directly above the agent heading, body present. Timestamp exactly 10 min after the mtime: no warning, plain agent section.
32. Same agent file with a transcript with no `timestamp` fields: no warning (grace skipped); tool_result user entries and noise-prefixed messages are not "last user message".
33. Meta valid, fresh by section 4, `stale_sections:["In progress","Exact next step"]`, `lastNudgeAt` = 2026-10-16T10:32:00Z, fallback enabled with a `claude` shim printing >= 50 chars: output order is exactly warning line (`Agent handoff may be stale: In progress, Exact next step unchanged since 2026-10-16 10:32:00Z`), agent heading and body, Haiku heading and shim text, `## Facts (auto-extracted)`. The shim is invoked once.
34. Agent file present (>= 300 bytes) but mtime 40 min old with no meta (section-4 rule fails), fallback enabled with shim: warning line contains `not updated since the last nudge`; agent section AND Haiku section both present, agent first. With the file mtime 20 min old: fresh, shim not invoked, no warning.
35. Stale agent file with `HANDOFF_HAIKU_FALLBACK=0`: warning line and agent section present, shim never invoked, no Haiku heading or failure line, `## Facts (auto-extracted)` present.
36. Stale agent file, shim fails (exit 3): warning, agent section, `Haiku fallback failed: claude exited 3`, then Facts.
37. Both reasons present (stale_sections and grace failed): one warning line with the two reasons joined by `; ` in the order of F35.B. A file of 299 bytes with stale meta: no agent section, no warning (behaves as not present).
38. `hookStale`: meta `{agentWrittenAt, lastNudgeAt: T0, sections:{"In progress":H1,"Exact next step":H2}}` with file sections hashing to H1 and H2, and 3 genuine user messages with timestamps after T0: stale warning produced without `stale_sections` in meta. With 2 user messages and 39 tool_use blocks after T0: no warning; with 40 tool_use blocks: warning. If only one of the two hashes matches: no warning.
Size
39. Stale file with a 5000-char agent body and shim output of 4000 chars, plus a full transcript: file length <= 9,500; Haiku text is shortened (ends `...`) while all sections that fit remain; if even the agent body + header leaves < 200 chars, the Haiku section is absent but the agent section and warning are intact. Facts drop order follows F35.D only after Haiku is gone.
Facts
40. `AskUserQuestion` with two questions, answers via `toolUseResult.answers`: `## Decisions via questions` has two lines `- [<header>] <question> -> <answer>`; positioned directly after `## Last user messages (oldest first)`; the answer entry never appears in "Last user messages".
41. Multi-select answer `["A","B"]` renders `A, B`; notes render as ` (notes: <notes>)`; question, answer, notes at 201+ chars are each cut to 200 chars ending `...`; 12 answered questions yield exactly the last 10, oldest first; an unanswered question (tool_result `is_error` or none) is absent; answer given only as result text `"Q"="A"` is parsed.
42. Open tasks: TaskCreate x3, TaskUpdate completes #2: `## Open tasks` lists #1 and #3 as `- [pending] ...`, not #2; all completed: section absent. `## Task state` is unchanged and still lists all three.
43. TodoWrite: two calls, the second replaces the first (the first's items do not appear); `in_progress` and `pending` items listed, `completed` not; 25 open items give 20 lines then `- ... +5 more`.
44. Background agents: two `Agent` tool_use with `run_in_background:true` (descriptions D1 model `haiku`, D2 no model), ids `a1`, `a2` in their tool_results, and a later `<task-notification` user entry naming `a1`: section lists only `- D2 (model: default)`. A foreground `Agent` call is never listed. Neither prompt text nor ids appear in the output.
45. Section order and trim: a transcript with all nine sections lists them in the F35.D order; under cap pressure the new three are the last dropped (Decisions via questions last of all); sections are dropped whole.
46. Amended earlier ACs: AC 6 (31 min, no meta) now yields the agent section WITH warning (reason (c)); AC 7: 299 bytes unchanged (no agent section); AC 8 and 9 and 10 "stale" cases now yield warning + agent section (Haiku per fallback setting; with `0` none) instead of no agent section; AC 5, 8 (fresh cases) and 17 unchanged when the transcript has no timestamps; AC 16 amended to the stale-lead layout of AC 35; AC 24 trim order replaced by F35.D (the six old sections keep their relative order); AC 19 heading order replaced by F35.D order.
47. Unchanged behaviour: AC 1-4 (exit 0, empty stdout/stderr, `HANDOFF_HOOK_CHILD`), AC 18, 26 (cleanup), 27-30 (inject) pass with the F35 fixtures included; the `postcompact-inject` output built from a stale-lead file is `Pre-compaction handoff (auto-saved):\n` + content with length < 10,000 (AC 30).
48. Robustness: invalid timestamps, non-array `stale_sections`, non-string `sections` values, `toolUseResult` missing or not an object, `input.questions` not a list, and truncated JSONL lines never raise; exit 0, empty stdout/stderr, and the affected section is simply absent.

### F35.F Rulings and open questions
- Transcript timestamps and the `toolUseResult.answers` / `annotations` shape and the `agentId:` text in background-agent results are taken from observed transcript formats and MUST be re-verified against a real transcript before build (builder: dump one sample of each and record the finding here). If `toolUseResult` is absent, the result-text pattern is the fallback (AC 41).
- The hook never writes meta (unchanged); `hookStale` therefore compares against the last nudge's hashes only.
- The handoffs dir named in section 5 (`~/.local/state/claude-handoffs`) is stale text; the code uses `~/.local/state/claude-handoffs` (precompact-handoff.py:9, compact.md F33.12); F35 fixtures use the code's path.
- E2E acceptance (real compaction, Haiku fallback exercised end to end) lives in `specs/compact.md` F35.7; record results there.

### F35 transcript shapes (verified by the orchestrator against a real transcript, 2026-10-16)
- AskUserQuestion: the tool_result line's `toolUseResult` is `{questions: [...], answers: {<question text>: <chosen label(s), comma-joined for multiSelect>}}`; `annotations` (per-question `notes`/`preview`) is present only when the user added notes. Pair = question `header` (from `questions[i].header`) + answer.
- Background Agent call: `toolUseResult` is `{agentId, isAsync: true, description, resolvedModel, status, outputFile, ...}`. Completion = a later transcript line of ANY type (verified 2026-10-16: completions appear mostly in `attachment` and `queue-operation` lines, only some in `user` lines) whose raw text contains `<task-notification>` with `<task-id>{agentId}</task-id>` and `<status>completed</status>` (or `failed`/`killed`). A background agent is open iff no such completion line exists after its call.
- The section 5 path is `~/.local/state/claude-handoffs` (stale `~/.claude/handoffs` text replaced).

## F36 Handoff reliability (2026-10-16)
Draft for approval. Why: the user runs long jobs that depend on auto-compaction plus handoff. It must be reliable, verified continuously, and never fail silently. Today every failure path (hook crash, stale agent file, Haiku timeout, missing `latest.md`) ends in "exit 0, nothing visible". F36 adds (A) a health log, (B) per-section fail-safe output, (C) a three-level status (`ok` / `reduced` / `degraded`) where only `degraded` reaches the model and the user, (D) a nightly canary that proves the whole pipeline end to end. Code touched (for the builder): `claude/hooks/precompact-handoff.py` (`build()`, main, new `health` helpers), `claude/hooks/postcompact-inject.py`, new `tools/handoff-canary/`, `launchd/handoff-canary.plist.tmpl`, `launchd/deps.tsv`. Amends sections 3.4, 5, 6 and 7 and ACs 1, 28 (listed in AC 71). Every earlier statement not named in AC 71 stands. Written code-blind: no AC needs the code.

### F36.A Definitions and test seams
- `HANDOFFS_DIR` gains an OPTIONAL override: env `HANDOFF_STATE_DIR` (absolute path) replaces `$HOME/.local/state/claude-handoffs` for BOTH hooks when set and non-empty; unset keeps the section 5 behaviour (tests may still use `HOME`). Reason: the canary must not write into the real dir. All "`$HANDOFFS_DIR`" below means the effective dir.
- `HEALTH_FILE = $HANDOFFS_DIR/health.jsonl`. `HOOK_VERSION` = a named semver string constant in `precompact-handoff.py` (value set by the builder; bumped to the next minor for F36; the canary and tests read it from the health line, never from source).
- Section names (the closed set used in `errors` and in `(section <name> unavailable: ...)`): `agent`, `warning`, `fallback`, `user_messages`, `decisions`, `files`, `tasks`, `open_tasks`, `background_agents`, `git`, `bash`, `assistant`. `warning` = the `Agent handoff may be stale:` line builder; `fallback` = the Haiku section builder including the excerpt; the others are the F35.D facts sections (`Last user messages`, `Decisions via questions`, `Files touched`, `Task state`, `Open tasks`, `Background agents`, `Git`, `Last Bash commands`, `Last assistant message` respectively; `tasks` = `## Task state`).
- Test-only fault seam: env `HANDOFF_TEST_FAULT=<section name>[,<section name>...]` makes the named section builder(s) raise `RuntimeError("injected")` at their start; `HANDOFF_TEST_FAULT=toplevel` makes the section assembly raise outside any section (exercises F36.C). Any other value is ignored. The seam changes nothing when unset. Real runs never set it.
- Test-only: `HANDOFF_CANARY=1` adds `"canary_child": true` to the health line and nothing else (set by the canary so its hook lines are distinguishable). `HANDOFF_HOOK_CHILD=1` (AC 4) still means: no file, no health line.

### F36.B Health log (1.a)
Every PreCompact run (every run that is not a `HANDOFF_HOOK_CHILD` run) appends exactly ONE JSON object, one line, to `HEALTH_FILE`, even when the hook failed at top level, and also when stdin was garbage. Fields (all always present, in this order; `json.dumps` default separators):
`ts` (UTC `YYYY-MM-DDTHH:MM:SSZ`), `sid` (first 8 chars of the sanitised session id; `unknown` when absent), `trigger` (`auto` | `manual`; absent or unrecognised is recorded as the string `unknown`), `agent_file` (`absent` | `fresh` | `stale`; `absent` = not `present` per F35.B, `stale` = present but not fresh), `stale_sections` (array of the heading names that caused staleness reason (a) of F35.B, `[]` otherwise), `fallback` (`skipped` = agent file fresh so Haiku not wanted | `ok` | `failed` | `timeout` | `disabled` = `HANDOFF_HAIKU_FALLBACK` is `0`), `duration_ms` (integer, whole hook, monotonic clock), `output_chars` (integer, length of the `latest.md` content written; 0 if none written), `truncated` (bool, true when the cap of 3.2/F35.C removed or shortened anything), `errors` (array of section names that raised, in assembly order, plus `toplevel` if F36.C applied; `[]` if none), `status` (`ok` | `reduced` | `degraded`, defined in F36.D), `hook_version`, `canary_child` (bool, always present, default false).
Rulings: `fallback: timeout` iff the fallback reason is `timeout after 75s`; every other fallback failure reason is `failed`. A stale agent file with fallback `0` is `agent_file: stale, fallback: disabled`. No agent file and fallback `0`: `absent`/`disabled`.
The line carries NO message text, no paths, no cwd, no transcript content, no exception messages (types only, and only inside the handoff itself, never in the health line).
Rotation: after appending, if the file has more than 5000 lines, rewrite it to its last 5000 lines (write a temp file in the same dir, then atomic rename). Rotation failure is swallowed and never loses the just-appended line. A health write failure (unwritable dir) is swallowed; exit stays 0 (it cannot be reported from the hook; the sidecar and canary are the detectors).
Sidecar: the hook ALSO writes `$HANDOFFS_DIR/<sid>-last-health.json` (full sanitised sid): the same object plus `reasons` (array of reason codes, F36.D; for `reduced` it holds the informational code `agent_absent` or `agent_stale`, for `ok` it is `[]`) and `degraded` (bool, true iff `status` is `degraded`), overwritten on every run. This is the only channel `postcompact-inject.py` reads.

### F36.C Fail-safe assembly (1.b)
1. Each output section is built by its own function inside its own `try/except Exception`. A raising section is replaced IN PLACE by exactly one line `(section <name> unavailable: <ExceptionType>)` (`<ExceptionType>` = `type(e).__name__`, never the message) and its name is appended to `errors`. Placement: the replacement line sits where the section's heading would have been; for `warning` it sits directly above the agent heading; for `agent` it replaces the agent section (and Haiku still runs per F35.B as if the file were not present... if the agent builder raised, `agent_file` is recorded from the freshness decision made before the raise, default `absent`).
2. The replacement line counts toward the 9,500 cap but is never itself dropped by cap trimming; a section replaced by this line is not a candidate for trimming.
3. The hook always emits whatever succeeded and exits 0 with empty stdout/stderr (AC 1 unchanged). Header and footer are built from the stdin fields with no section logic and cannot be skipped.
4. Top-level failure: any exception outside the section functions (parse of stdin aside, which already degrades to `{}`) or a `BaseException` during assembly writes, instead of the normal file, the MINIMAL HANDOFF (to both `<sid>-latest.md` and the timestamped file, as usual):
```
# Handoff (minimal: hook failed with <ExceptionType>)
- session: <sid>
- cwd: <cwd>
- trigger: <trigger>
- time: <UTC ts>
- transcript: <path>
- git branch: <branch>          <- line omitted if `git -C <cwd> rev-parse --abbrev-ref HEAD` fails, git is missing, or cwd is not a repo
Full transcript: <path>. Read it for exact details before guessing.
```
   The minimal builder uses only string formatting and a single guarded `git` call (5 s timeout) and has its own `try/except`; if even it fails, the hook writes the single line `# Handoff unavailable (hook failed)` plus `- session: <sid>`. In all top-level cases `errors` contains `toplevel`, `agent_file`/`fallback` are recorded as known at failure time (defaults `absent`/`skipped`).
5. Order of effects: write handoff files first, then the sidecar, then the health line (last, in a `finally`), so a crash in logging cannot lose the handoff.

### F36.D Degraded flag and injection (1.c)
Reason codes (closed set) and their human text used in the warning line, in this order:
`agent_absent` -> `no agent handoff`, `agent_stale` -> `agent handoff stale`, `fallback_failed` -> `Haiku fallback failed`, `fallback_timeout` -> `Haiku fallback timed out`, `section_errors` -> `sections unavailable: <names joined ", ">` (names from `errors`, including `toplevel`), `no_health` -> `no health record for this compaction`, `handoff_missing` -> `no handoff file for this session`, `handoff_old` -> `handoff not refreshed for this compaction`.
**Status (computed by the hook; decided by the user 2026-10-16, replacing the earlier "absent agent file is always degraded" ruling).** Three levels, evaluated in this order:
1. `degraded` iff ANY of: `errors` non-empty (any section error or `toplevel`); `stale_sections` non-empty; `agent_file != fresh` AND `fallback in (failed, timeout, disabled)` (no fresh agent file and no working Haiku summary).
2. else `reduced` iff `agent_file != fresh` AND `fallback == ok` (no fresh agent file, but the Haiku fallback succeeded and nothing raised). Reduced is expected in sessions without the compact plugin's nudge; the Haiku summary is the designed fallback, so it is logged and counted but never alerted.
3. else `ok` (`agent_file == fresh`, `errors` empty).
`reasons` (codes in the order above): for `degraded`, every code that applies (`agent_absent` when `agent_file` is `absent`, `agent_stale` when `agent_file` is `stale` or `stale_sections` is non-empty, `fallback_failed`, `fallback_timeout`, `section_errors`); for `reduced`, exactly `agent_absent` or `agent_stale` (informational, never shown to the model or the user); for `ok`, `[]`. A `disabled` fallback adds no code of its own (the text for `agent_absent` already says there is no agent handoff). Missing or old handoff and missing health record are detected at inject time (`handoff_missing`, `no_health`, `handoff_old` below) and are `degraded`.
Injection by status: `ok` and `reduced` inject exactly the section 6 string with NO prefix and NO neutral note (decision: a note would cost context tokens on every reduced compaction, which is routine, and would train the model to ignore the prefix; the health log and weekly report carry the information). Only `degraded` adds the warning line.

`postcompact-inject.py` (extends section 6):
- Let `S` = `<sid>-last-health.json` and `L` = `<sid>-latest.md`.
- Normal: `L` non-empty and `S` readable valid object with `ts` within the last 15 minutes and `degraded` false (`status` `ok` or `reduced`): output exactly as section 6 (AC 27), no prefix, no note. No `-degraded.json` is written (an existing one is left untouched).
- Degraded: `S.degraded` true: `additionalContext` = `HANDOFF DEGRADED: <human texts joined "; ">. Verify the handoff against the transcript before acting.\n` + the section 6 string (`Pre-compaction handoff (auto-saved):\n<content>`). The warning is the FIRST line of `additionalContext`. And it writes `<sid>-degraded.json` = `{"v":1,"sid":"<sid>","ts":"<now UTC>","reasons":[<codes>],"trigger":"<S.trigger>","detected_by":"inject"}` (atomic: temp + rename; overwrite). An existing file for an earlier compaction is overwritten and loses any `clearedAt`.
- Silent-failure cases, all treated as degraded with a minimal injection: `L` missing/empty/unreadable -> reason `handoff_missing`, `additionalContext` = `HANDOFF DEGRADED: no handoff file for this session. Read the transcript (see session metadata) before acting.`; `L` present but `S` missing/unreadable/invalid -> `no_health` and `L` still injected below the warning; `S.ts` older than 15 min or unparseable -> `handoff_old` and `L` injected below the warning (it may belong to an earlier compaction). In these cases `-degraded.json` is written with the code(s). Session id missing/empty/non-string stays silent: no output, no file (nothing to key on).
- Healthy path unchanged: stdout one JSON line or nothing, stderr empty, exit 0 always. Any exception while computing degradation falls back to the section 6 behaviour for `L` and, if that is also impossible, prints nothing.
- Size: the warning line counts toward the same < 10,000 bound as AC 30 (the file is capped 9,500; warning <= 300 chars; total < 10,000).
Cleanup (amends 3.4): after writing, `*-degraded.json` and `*-last-health.json` directly in the dir older than 14 days are deleted; `health.jsonl` is never deleted by cleanup (it rotates by F36.B); other non-`.md` files keep the 3.4 rule.

### F36.E Handoff canary (1.d)
Purpose: prove nightly, with a real headless Claude Code session, that PreCompact fires, a handoff is written, SessionStart(compact) injects it, and the resumed model acts on it. Location: `tools/handoff-canary/` (`run.sh` orchestrator; `check.py` pure checker; `fixtures/`). The phrase "`claude/hooks/handoff-canary.sh`" in the request is satisfied by a thin `claude/hooks/handoff-canary.sh` that just `exec`s `tools/handoff-canary/run.sh "$@"` (so the hooks dir lists it; installed copy byte-identical like the other hooks).

**Schedule.** `launchd/handoff-canary.plist.tmpl`, label `__LABEL_PREFIX__.handoff-canary`, `StartCalendarInterval` `{Hour:3, Minute:30}` (daily, no Weekday key), `RunAtLoad` true with `--catch-up` semantics (run only if `last-run.json` is absent or older than the most recent 03:30; a no-op otherwise), `ProgramArguments` `/bin/bash -lc '__REPO__/tools/handoff-canary/run.sh --catch-up'`, logs to `__HOME__/.local/state/handoff-canary/logs/launchd.{out,err}`, `EnvironmentVariables` = `HOME` and `PATH` per AC 85 of specs/machine-setup-spec.md (structure copied from `token-budget.plist.tmpl`). `launchd/deps.tsv` row: `__LABEL_PREFIX__.handoff-canary<TAB>-<TAB>-<TAB>-`. Install/uninstall piggyback on the existing launchd machinery (`setup/bootstrap.sh --launchd`); `plutil -lint` must pass; `--render-only` works; `LABEL_PREFIX` override honoured like AC 56 of docs/token-budget-spec.md. State dir `~/.local/state/handoff-canary/` (mode 700): `last-run.json`, `runs/<ts>/` (kept 14 days), `logs/`.

**Isolation (hard).** Every canary session: cwd = a fresh `mktemp -d` project containing only `.claude/settings.json` that registers exactly the two handoff hooks (absolute repo paths, same timeouts as the template: PreCompact 90 s, SessionStart `compact` 10 s) and no other hooks; invoked with `--setting-sources project` so user settings/hooks are not loaded, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, `--disable-slash-commands`, `--model haiku`, `--output-format json`, `--permission-mode acceptEdits`, `--allowedTools "Read Write Edit Bash"` limited by a `Bash` allow-list prefix of the temp dir only where the CLI supports it. Env: `HANDOFF_STATE_DIR=<tmp>/handoffs` (so hooks write only there), `HANDOFF_CANARY=1`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<W>`, `HOME` unchanged (auth needs it). The canary never reads or writes any real project, the real handoffs dir, or the vault. Session ids are fresh UUIDs passed with `--session-id`. A run aborts (result `fail`, reason `isolation`) if the temp dir is not under `$TMPDIR` or any hook line appears in the REAL `health.jsonl` with `canary_child` true. User-level `~/.claude/CLAUDE.md` is NOT loaded under `--setting-sources project` (verified 2026-10-16); the checks below are token-based anyway. Every `claude` invocation redirects stdin from `/dev/null` (`-p` otherwise waits 3 s for stdin).

**Forcing compaction (the choice).** Primary: AUTO compaction by a small window. `W = 60000` (default; env `HANDOFF_CANARY_WINDOW` overrides; values below 40000 are rejected with exit 2 because the CLI does not honour them, see Verified). Justification: 60,000 is the value the existing F35.7 manual E2E already uses; the measured isolated baseline context is about 30.1k tokens, so 60000 leaves about 30k of headroom, reached in 2-3 padding reads. Each padding file is deterministic text the canary generates (never real data), about 9k tokens, and MUST be multi-line (for example up to 2000 lines): the Read tool truncates at about 42k characters per line, so a single-line file cannot be paged. The session is driven as a chain of non-interactive turns: turn 1 `claude -p --session-id <uuid> ...`, later turns `claude -p --resume <uuid> ...` (one process per turn; each turn's JSON gives `total_cost_usd` and `session_id`). Padding turns use `--allowedTools Read` with `--permission-mode acceptEdits` (verified to work). Compaction is expected inside the 2nd-3rd padding read; the driver reads the PreCompact health line to detect it (a new line in `<tmp>/handoffs/health.jsonl`) and stops padding. Cap: at most 12 turns per compaction attempt; if no PreCompact line appears, the variant FAILS with reason `no_compaction` (this itself is a valuable signal: auto-compaction not triggering in `-p`). Fallback driver, used only if the primary fails: `claude -p --resume <uuid> "/compact"`, verified to run a manual compaction under `-p` and to fire PreCompact with `trigger: manual` and SessionStart `compact` (the canary's own sessions use `--disable-slash-commands`, so the fallback driver omits that flag for that turn only). The post-compaction answer is always requested on the turn IMMEDIATELY after the compaction: the injected context of an earlier compaction is not repeated after a second compaction (verified), which is also why `HANDOFF_CANARY_DOUBLE=1` checks the token only after the last compaction. Each variant forces compaction exactly once; "twice" in the request = once per variant, in two separate sessions (A then B), so each hook path is exercised and a single compaction per session keeps cost low. (A run MAY do a second compaction in the same session when `HANDOFF_CANARY_DOUBLE=1`, to cover the `latest.md` overwrite case; default off.)

**Scripted task.** Fixture-driven and deterministic: the canary generates a random 10-hex run token `R` per run. Task prompt (turn 1): "You are running a canary. Do these steps in order, one per turn, in this directory: step 1 create s1.txt containing ONE; step 2 create s2.txt containing TWO; step 3 create s3.txt containing THREE; final step 4 create done.txt containing the text `<TOKEN_X>`. After each turn I will tell you to proceed. Never do step 4 until I say `GO FINAL`. If asked what your next step is, answer with the exact text to be written in done.txt."
- Variant A (agent file present): `TOKEN_X = A-<R>`. After step 2 and before padding, the canary itself writes `<tmp>/handoffs/<sid>-agent.md` (>= 300 bytes, six headings, "Exact next step" = `create done.txt containing A-<R>`) and a matching `<sid>-agent.meta.json` (`agentWrittenAt` = now, `lastNudgeAt` = 1 s earlier, so FRESH by F35.B). Crucially the prompts never contain `A-<R>` anywhere in the transcript: the token exists only in the agent file. (The model is told the final step "is recorded in your handoff file" and nothing else.) Expected health line: `agent_file: fresh`, `fallback: skipped`, `errors: []`; DEGRADED false.
- Variant B (agent file absent -> fallback): `TOKEN_X = B-<R>`, stated in turn 1 (so it is in the transcript the Haiku fallback summarises). No agent file is created. Expected health line: `agent_file: absent`, `fallback: ok`, `errors: []`, `status: reduced` (reason `agent_absent`, informational); no degraded file and no warning in the injected context (expected, not a failure). The canary therefore exercises the `ok` and `reduced` paths; the `degraded` inject path is covered by fixtures (ACs 62-65).
Post-compaction turn (both): `claude -p --resume <uuid> "State your exact next step, in one line, quoting the text to write in done.txt. Do not do it."`.

**Checks (pure function `check.py`, fixture-testable).** Variant passes iff ALL hold: (1) a health line exists in `<tmp>/handoffs/health.jsonl` with `trigger` `auto` (or `manual` when the `/compact` driver is used) and `canary_child` true; (2) the line matches the expected `agent_file`/`fallback`/`errors`/`status` for the variant (A: fresh/skipped/[]/ok; B: absent/ok/[]/reduced); (3) `<sid>-latest.md` exists and contains `TOKEN_X` (A: inside `## Agent handoff`; B: anywhere, expected inside the Haiku section or Facts); (4) the SessionStart hook ran and injected without a warning: `<sid>-degraded.json` absent for BOTH variants (A is `ok`, B is `reduced`) and the health line `status` is `ok` (A) / `reduced` (B); (5) the answer of the turn immediately after the compaction (from the JSON `result`) contains `TOKEN_X` as a substring (case-sensitive) AND does not contain the other variant's token; (6) no `Haiku fallback failed:` line in `latest.md` (B); (7) total elapsed under the timeout; (8) cost under the cap. Variant A check (5) is the strong one: the token is only reachable through the injected handoff. Variant B check (5) can also be satisfied by the compaction summary alone, so (3) and (6) carry the Haiku path's proof. A failed check records the FIRST failing check number as `reason` (`c1`..`c8`, or `no_compaction`, `timeout`, `claude_missing`, `isolation`, `cost_cap`, `error`).

**Limits.** Hard wall-clock timeout 12 minutes per run (watchdog started with the orchestrator; implemented without GNU `timeout`, using a background `sleep`+`kill` of the process group, because macOS lacks `timeout`), 5 minutes per `claude` turn. Cost cap: env `HANDOFF_CANARY_MAX_USD` default `0.25` per run; `total_cost_usd` in a turn's JSON is CUMULATIVE per session (verified), so the cost of a session is its LAST value, never a sum over turns; the run cost is the sum of the two sessions' last values; exceeding the cap stops the run (`cost_cap`, result `fail`). `--max-budget-usd` exists and is passed per turn as defence in depth, but its stopping behaviour is untested (UNVERIFIED), so the 12-minute watchdog stays the hard stop. Expected cost (measured 2026-10-16): about $0.02-0.05 per session (a 7-turn session with 2 compactions ended at $0.030), so about $0.04-0.10 per nightly run. `claude` not on PATH or not logged in: result `skip` (reason `claude_missing`), NOT pass and NOT fail; skips are shown in the report. Only one canary at a time (lock dir in the state dir; a stale lock older than 30 min is broken).
**Output.** Appends one line to the REAL `$HOME/.local/state/claude-handoffs/health.jsonl` (via the same append+rotation code path semantics as F36.B; the canary writes it itself): `{"ts","sid":"<first 8 of variant A session id>","trigger":"canary","result":"pass"|"fail"|"skip","reason":null|"<code>","variants":{"A":"pass|fail","B":"pass|fail"},"duration_ms","est_cost_usd","hook_version":"<from the hook lines seen, else null>","canary_child":false}`. Same field set rules otherwise as far as applicable (the compaction-only fields `agent_file`, `fallback`, `stale_sections`, `output_chars`, `truncated`, `errors` are absent on canary lines, readers must key on `trigger`). Also writes `last-run.json` (`ts`, `result`, `reason`, `next_run_hint`). On `fail`: a macOS notification `Handoff canary FAILED (<reason>)` via `osascript` (suppressed when `HANDOFF_CANARY_NOTIFY=0`, in which case stdout carries one `NOTIFY: ` line) and the run dir is kept 14 days with the hook outputs (synthetic content only). On `pass` the run dir is deleted. Exit codes: 0 pass or skip, 1 fail, 2 usage/lock held, 3 isolation violated.

**Verified (probed by hand 2026-10-16, claude 2.1.296, haiku, `--setting-sources project`; evidence in the probe notes `canary-probe/FINDINGS.md`, kept outside the repo).**
- PreCompact fires under `claude -p --resume` with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000` (trigger `auto`) after 2-3 Read turns. `claude -p --resume <uuid> "/compact"` runs a manual compaction and fires PreCompact (trigger `manual`) and SessionStart `compact`.
- Windows 60000, 50000 and 40000 are honoured; 30000 is NOT (no compaction). The canary uses 60000 and requires W >= 40000.
- Isolated baseline context is about 30.1k tokens.
- SessionStart `compact` fires after compaction in `-p` and its `additionalContext` reaches the model (a token never present in any prompt was quoted by the next turn). After a SECOND compaction the earlier token was not repeated, so the token is checked on the turn immediately after the compaction.
- `--session-id <uuid>` then `--resume <uuid>` keeps the same `session_id`; `total_cost_usd` is cumulative per session (use the last value, never sum).
- `--max-budget-usd` exists (flag accepted; stopping behaviour not tested). `--bare` exists (unused by the canary; auth under it untested).
- Hooks inherit the environment of the `claude` command (`HANDOFF_STATE_DIR`, `HANDOFF_CANARY` reach the hooks).
- `~/.claude/CLAUDE.md` is NOT loaded under `--setting-sources project`.
- Cost about $0.02-0.05 per session; all probes together under $0.10.
- `-p` waits 3 s on stdin unless it is redirected from `/dev/null`; Read truncates at about 42k characters per line (padding must be multi-line); `--allowedTools Read` with `--permission-mode acceptEdits` works for padding turns.

**Still UNVERIFIED (genuinely unknown).** (U1) What `--max-budget-usd` does when exceeded (the watchdog is the hard stop). (U2) Whether `--bare` keeps subscription auth (unused; only relevant if it is ever adopted). (U3) Behaviour on future CLI versions: `run.sh --probe` is kept as a RE-CHECK mode (runs variant A only, keeps the run dir, prints each turn's token counts and the health line, writes `probe-result.json` with booleans for the Verified items above); run it after a CLI upgrade or when the canary starts failing with `no_compaction`. If PreCompact stops firing headless, the fallback design is a `script`-driven interactive session (pty) with the same task and this section is amended. Until the job is first enabled the user runs `run.sh --probe` once; `bootstrap.sh --launchd` installs the job.

### F36.F Acceptance criteria 49-71 (temp `HOME`; `HANDOFF_HAIKU_FALLBACK=0` unless stated; all fixtures from F35 reused)
Health log
49. One valid PreCompact run appends exactly one line to `$HANDOFFS_DIR/health.jsonl`; it parses as a JSON object with exactly the keys of F36.B in that order; `sid` is the first 8 chars of the session id (`unknown` for `{}`/garbage); `ts` matches `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$`; `duration_ms` is an integer >= 0; `output_chars` equals the length of `S-latest.md`; `status` is one of `ok`/`reduced`/`degraded`; `hook_version` is a non-empty string; two runs append two lines.
50. The line never contains the marker string placed in user messages, assistant text, file paths, cwd or exception messages (fixtures with a unique marker everywhere); no value in it is a path (no value contains `/`).
51. Classification matrix, one run each: fresh agent file -> `agent_file:fresh, fallback:skipped`; stale agent file (AC 31/34 fixtures) + fallback `0` -> `stale, disabled`, and with `stale_sections` meta the array equals the listed names; no agent file + shim ok -> `absent, ok`; shim exit 3 -> `absent, failed`; a shim that sleeps past 75 s gives `absent, timeout` (costs 75 s; tests may mark it slow or skip it, a testability gap as in section 5). Status per row (F36.D): fresh -> `ok`; absent + ok -> `reduced`; absent + failed / timeout / disabled -> `degraded`; stale with non-empty `stale_sections` + shim ok -> `degraded`; stale without `stale_sections` + shim ok -> `reduced`; stale + disabled -> `degraded`; fresh + any `HANDOFF_TEST_FAULT` section -> `degraded`; `toplevel` -> `degraded`. `trigger` `auto`, `manual` pass through; absent/other -> `unknown`.
52. `truncated` is true for the AC 39 over-cap fixture and false for a small transcript; `errors` is `[]` for all F35 fixtures.
53. `HANDOFF_HOOK_CHILD=1` appends no health line and writes no sidecar (AC 4 extended). Unwritable dir: exit 0, empty stdout/stderr.
54. Rotation: a health file with 5000 lines plus one run -> 5000 lines whose last line is the new one and whose first line is the old line 2; 4999 lines plus one run -> 5000 lines, first unchanged; 7000 lines -> 5000. Content of kept lines byte-identical. A read-only temp file used for rotation leaves the appended line present.
55. Sidecar: `S-last-health.json` exists after each run, parses, equals the health line plus `reasons` and `degraded`; for `absent, ok` the status is `reduced`, `reasons` is `["agent_absent"]` and `degraded` is false; for `absent, failed` the status is `degraded`, `reasons` is `["agent_absent","fallback_failed"]` and `degraded` is true; for fresh/skipped/[] reasons `[]`, status `ok`, `degraded` false.
Fail-safe
56. For each section name in F36.A, `HANDOFF_TEST_FAULT=<name>`: exit 0, stdout/stderr empty, `S-latest.md` contains exactly one line `(section <name> unavailable: RuntimeError)` at the position that section would have held (facts sections: in the F35.D order; `warning`: directly above the agent heading), all OTHER sections of the F35 full fixture are still present and correct, header and footer intact, health `errors` equals `[<name>]`, sidecar `degraded` true, `status` `degraded`, with a `section_errors` reason.
57. Two faults (`HANDOFF_TEST_FAULT=git,bash`): two replacement lines, `errors` equals `["git","bash"]` (assembly order), everything else intact. A replacement line is never removed by cap trimming (over-cap fixture + fault: the line survives).
58. `HANDOFF_TEST_FAULT=agent` with a fresh agent file and fallback enabled + shim: no agent body in the output; the replacement line present; `errors` `["agent"]`. (Whether Haiku then runs is not asserted.)
59. `HANDOFF_TEST_FAULT=toplevel`: exit 0, stdout/stderr empty; `S-latest.md` and the timestamped file are byte-identical and equal the MINIMAL HANDOFF layout of F36.C.4 with the fixture's session, cwd, trigger, transcript, and `git branch: <branch>` for a temp git repo cwd; non-repo or non-existent cwd -> that line absent; `errors` `["toplevel"]`; health line and sidecar written; the line `# Handoff (minimal: hook failed with RuntimeError)` is first.
60. Garbage stdin with `HANDOFF_TEST_FAULT=toplevel`: `unknown-latest.md` contains `- session: unknown` and the minimal layout; exit 0.
Degraded flag and inject
61. Inject with `S-latest.md` + a fresh non-degraded sidecar (ts now): output byte-identical to AC 27; no `-degraded.json` written.
62. Inject with a degraded sidecar (`reasons:["agent_absent","fallback_failed"]`): the decoded `additionalContext` starts with `HANDOFF DEGRADED: no agent handoff; Haiku fallback failed. Verify the handoff against the transcript before acting.\n` followed by `Pre-compaction handoff (auto-saved):\n<content>`; `<sid>-degraded.json` exists with `v:1`, `sid`, `ts` (UTC), `reasons` equal to the sidecar's, `trigger`, `detected_by:"inject"`, no `clearedAt`; total length < 10,000. Reason text mapping covers every code (one fixture per code, including `section_errors` listing names).
63. Inject with `S-latest.md` missing, or empty/whitespace: output `HANDOFF DEGRADED: no handoff file for this session. Read the transcript (see session metadata) before acting.` as additionalContext; degraded file with `["handoff_missing"]`. Latest present but sidecar missing/invalid JSON/non-object: warning `no health record for this compaction` + the file; code `no_health`. Sidecar `ts` 16 min old (fresh content otherwise): `handoff_old`; 14 min old: no warning.
64. Missing/empty/non-string `session_id` or invalid stdin: still no output and no file (AC 28's silent cases that have no sid); exit 0, empty stderr. Reason strings used in the warning line are exactly those of F36.D for every code.
65. End to end hooks-only: (i) precompact with shim fallback ok and no agent file (status `reduced`) then inject for the same sid/HOME: the injected context is byte-identical to the plain section 6 form (starts with `Pre-compaction handoff (auto-saved):`), no `-degraded.json`, health `status: reduced`; (ii) shim fallback failing (exit 3), no agent file (status `degraded`): the injected context starts with `HANDOFF DEGRADED: no agent handoff; Haiku fallback failed.` and `-degraded.json` has `["agent_absent","fallback_failed"]`; (iii) fresh agent file: plain form, no degraded file, status `ok`. A pre-existing `-degraded.json` with `clearedAt` is overwritten without `clearedAt` by a later degraded inject, and is left untouched by a later `ok` or `reduced` inject.
66. Cleanup: a 15-day-old `x-degraded.json` and `x-last-health.json` are deleted; 13-day-old kept; `health.jsonl` of any age is kept; `notes.txt` and `x-agent.meta.json` of 15 days are kept (3.4 unchanged otherwise).
67. `HANDOFF_STATE_DIR=<tmp2>` (absolute) with a different `HOME`: all files (handoffs, health, sidecar, degraded) appear only under `<tmp2>`; the temp HOME gets nothing. Unset or empty: section 5 behaviour.
68. `HANDOFF_CANARY=1` sets `canary_child:true` in the health line and changes no other output byte of `latest.md`.
Canary (fixtures, shim `claude`, no network)
69. `check.py` contract with recorded fixtures (dir `fixtures/canary/<case>/` holding `health.jsonl`, `latest.md`, optional `degraded.json`, `answer.txt`, `meta.json` with elapsed/cost): case A-pass -> result pass; each single defect -> fail with the first failing check code: wrong `agent_file` or `status` (`c2`), token missing from `latest.md` (`c3`), A or B with a degraded file, or a `status` not matching the variant (`c4`), answer lacks token (`c5`), answer contains the other variant's token (`c5`), `Haiku fallback failed:` in B (`c6`), elapsed > 720 s (`c7`), cost > cap (`c8`), no health line (`c1`); several defects report the lowest-numbered check.
70. `run.sh` against a PATH shim `claude` that behaves like a healthy Claude Code (writes a health line via the real hooks by invoking them on a synthetic transcript, echoes the token on the final turn): exit 0, one health line appended to the REAL-HOME-fixture health file with `trigger:"canary"`, `result:"pass"`, `variants` both pass, `est_cost_usd` the shim-reported sum; the run dir is removed; the tmp project contains only the files `.claude/settings.json` plus task output; the shim's recorded argv contains `--setting-sources project`, `--model haiku`, `--strict-mcp-config`, the shim's stdin is `/dev/null`, `HANDOFF_CANARY_WINDOW=30000` exits 2 with no `claude` invocation, the cost is the LAST `total_cost_usd` of each session (a shim reporting cumulative values 0.01, 0.02, 0.03 yields 0.03 per session, not 0.06), the cap defaults to `0.25`, and the shim's env contains `CLAUDE_CODE_AUTO_COMPACT_WINDOW=60000`, `HANDOFF_STATE_DIR` under `$TMPDIR`, `HANDOFF_CANARY=1`. Shims that (a) never trigger a PreCompact line -> exit 1, `fail`, reason `no_compaction`, notify path used; (b) report cost above the cap -> `cost_cap` and no further turns; (c) hang -> killed by the watchdog (test with `HANDOFF_CANARY_TIMEOUT_S=2`), `timeout`; (d) absent `claude` -> exit 0, `result:"skip"`, `reason:"claude_missing"`; (e) answer lacks the token -> `fail` `c5`. No test touches the network or a real `claude`.
71. Amended earlier statements: AC 1 (empty stdout) unchanged for precompact; AC 28's "missing latest file -> stdout empty" now applies ONLY when `session_id` is missing/empty/invalid (a valid sid with a missing/empty latest file yields the AC 63 warning); AC 27 requires a non-degraded sidecar to produce the plain form (a missing sidecar makes it `no_health`, so AC 27/30 fixtures must supply a sidecar or accept the warning prefix); AC 29 parity unchanged; section 3.4 gains the F36.D cleanup rule; section 7 "Unwritable handoffs dir ... swallowed" stands for health/sidecar writes. The launchd template: `plutil -lint` passes; label `com.machine-setup.handoff-canary` when `LABEL_PREFIX` unset; `StartCalendarInterval` Hour 3 Minute 30 and no Weekday; `deps.tsv` has the row with a tab-separated 4 columns; `RunAtLoad` true; `EnvironmentVariables` has exactly the keys `HOME` and `PATH` (AC 85 of specs/machine-setup-spec.md); `ProgramArguments` ends with `tools/handoff-canary/run.sh --catch-up`. `--catch-up` with `last-run.json` older than the most recent 03:30 (using `HANDOFF_CANARY_NOW`) runs; newer: no-op, exit 0, no `claude` invocation.

### F36.G Decisions and open questions
Decided 2026-10-16 (user): the DEGRADED / REDUCED split (formerly open question F36.G.1). `reduced` (no fresh agent file, Haiku fallback ok, no section errors) is logged with `status: reduced` and counted in the weekly report, but has no toast, no band chip, no degraded file and no inject prefix (the inject adds no neutral note either). `degraded` is everything else non-ok (F36.D). Canary B is `reduced`.
Open: (1) 15-minute sidecar freshness for `handoff_old` is a guess; a very slow compaction could false-positive. (2) Whether the canary should also run on CLI upgrade (detect `claude --version` change and run once immediately) is deferred. (3) `--max-budget-usd` stopping behaviour (U1 above). (4) No reduced-rate flag is defined; reduced is reported only.
