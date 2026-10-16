# Spec: `awareness` plugin (Heads-Up, Now Doing, Spec Tracker, Focus Timer)

Read `00-conventions.md` first. Board: `#idea-3` (Heads-Up, toasts mockup), `#idea-4` (Now Doing), `#idea-7` (Focus Timer), `#swe-10` (Long Command Timer, folded into Heads-Up), `#swe-15` (Spec Tracker, no mockup). Version 1.0.0.

## 0. Purpose and mods
Tells the user what is happening and what needs him, without noise: at most one toast a minute, a phase band while a turn runs, plan progress, and a pomodoro that silences the toasts.
Mods: `headsup` (incl. Long Command Timer), `nowdoing` (absorbs the TodoWrite/TaskCreate/TaskUpdate checklist of agent-pets), `spec` (feeds `nowdoing`), `focus` (Pom). Band row (order): focus, nowdoing (+spec chip). Commands: `/focus`, `/headsup`, `/spec`, `/nowdoing`. Registers one model-callable tool `mcp__awareness__phase` (T:3003 `$.tool.register`). Spends no tokens except the few tokens of that tool when the model chooses to call it.

## 1. Heads-Up (`headsup`)
**Behaviour.** Toasts only (conventions 7). Global limiter: `shown` at most 1 per `minGapMs` 60000; others queue by priority (lower number first), newest per trigger id, expire after `queueTtlMin` 5 or when the condition clears. Silent while Focus Timer is in a FOCUS phase: triggers that fire during FOCUS are NOT queued for later; they are counted (by trigger id, once each) and, after the block ends, Heads-Up shows exactly ONE digest toast summarising what it held back, `While you focused: N notices ({ids}). Run /headsup.` (option `digestAfterFocus`, default true; decision Q5), only if N >= 1. The digest is offered at priority 0 through the same limiter (so it respects the 1 per minute gap) and `/headsup status` lists the same ids until the digest is shown. `/headsup status|mute <dur>|unmute|test <id>`; `mute 30m` silences everything for 30 min (state `muted until HH:MM` in status).
Text: `TITLE · detail. Hint.` <= 140 chars, glyph prefix by `toastGlyph(surfaces)`. `Run /burn.` style hints appear only when `$.command.list()` (T:3064) contains that command.
**Idle** = no turn running and no `prompt.submit` for `idleSec` 120 (events T:13374 `turn.start`, T:13324 `turn.complete`, T:9051 `prompt.submit`; all CONFIRMED).
**Triggers** (id, priority, source, rule, default, text):
1. `cache` p1. CONFIRMED events; TTL partly UNVERIFIED (see usage.md section 2, same shared `cache.ts`, own plugin store). Fire once per cache entry when idle, remaining in (0, `cache.warnSec` 60], context tokens >= `cache.minCtxTokens` 50000. `CACHE · 60 S: Prompt cache expires soon; the next message re-caches ~$0.42.` (cost omitted if unknown).
2. `longCommand` p2 (Long Command Timer). Wrap Bash `tool.call`: `t0 = $.clock.now()`; start `$.clock.after(longSec*1000, alert)` BEFORE `next(e)`, cancel after. At `longSec` 120: `COMMAND · 2 MIN: {exe} is still running.` On finish with duration >= longSec: `COMMAND · DONE: {exe} took {mm:ss}.` Only `{exe}` = basename of the first word of `e.command` is ever shown (never arguments: they can hold tokens). Foreground only: commands with `run_in_background` or a result `backgroundTaskId` (T:20362) are skipped (UNVERIFIED: a completion event for background tasks; the `task-notification` UserMessage row, T:8892, is a later option). Also a live band segment `⏱ {exe} 01:42` after `showAfterSec` 10 (see 2).
3. `context` p3. CONFIRMED `session.measure.context.percent` (T:10950). Fire when it crosses `context.warnAt` 80 upward; re-arm below 70 or after `session.compact`. `CONTEXT · 82%: compaction is near. Run /compact or start fresh.`
4. `pace` p4. Weekly HOT per shared `pace.ts` (same maths as usage.md section 1, in-session samples only, `avgRate` for seven_day). Fire on entering HOT; re-arm after 30 min out of HOT or a reset. `WEEKLY PACE · HOT: limit lands {when} at this rate. Run /burn.` Option `pace.five` (default false) adds the 5-hour window.
5. `bigOutput` p5. A main-thread tool result with Bash `persistedOutputSize` (T:20386) or `text.length` >= `bigOutput.kb` 100 (decimal KB). `OUTPUT · {n} KB from {tool}. Narrow the command next time.`
6. `ollama` p6. UNVERIFIED. Only if `$.env.get('OBSIDIAN_VAULT_PATH')` (T:3598) names an existing directory (`$.fs.stat`, T:3321): every `ollama.intervalMin` 5, `$.http.fetch('http://127.0.0.1:11434/api/version')` (T:3490; no timeout option, so race it against `$.clock.sleep(3000)`). Two consecutive failures = DOWN. Whether the web-fetch policy allows localhost is UNVERIFIED; fallback CONFIRMED (process-exec): `curl -s -m 2 -o /dev/null -w %{http_code} <url>`. Fire on up->down, re-arm on down->up. `VAULT · KEYWORD ONLY: Ollama is down; search quality is reduced.`
7. `noModel` p7, default OFF (Delegation Guard in `agents` owns the "Agent without model" toast, decision Q3). CONFIRMED: `agent.spawn.model` undefined (T:303), type not `fork`, not in `noModel.allowTypes` (default `savvy-*,*:savvy-*`). `AGENT · NO MODEL SET: "{description}" started without a model. Add model: haiku or sonnet.`
**Peer toasts.** Heads-Up publishes `headsup.lastShownAt` and reads `dev.toast.lastShownAt` (conventions 7.5): a `dev` PR check-failing toast counts as a shown toast for the 1-per-minute gap, so the next Heads-Up toast waits until 60 s after it. Heads-Up also exposes `mutedUntil` and the `focus` atom so `dev` honours mute and focus quiet mode.
**States.** MUTED, QUIET (focus), ACTIVE. **Edge cases.** Two surfaces (terminal + desktop): glyph policy uses "any desktop -> no emoji". A toast of this plugin replaces its previous one on screen (engine rule, R:130), so `timeoutMs` is 6000. Limiter timers are `$.clock` based; no `setTimeout`.
**Options.** `headsup.minGapMs` 60000, `headsup.idleSec` 120, `headsup.queueTtlMin` 5, `headsup.digestAfterFocus` true, `headsup.trigger.<id>` booleans (defaults: noModel false, others true), the thresholds named above.

## 2. Now Doing (`nowdoing`)
**Behaviour.** Row segment shown while a turn runs, a checklist exists, a command runs >= 10 s, or a spec is tracked. Five phase chips RESEARCH, PLAN, BUILD, VERIFY, REPORT: visited = tile with solid edge, current = accent edge, unvisited = dim. Then `now: <sentence>` and, if a checklist or spec exists, a 12-cell meter and percent. Optional 20 px Pom (`nowdoing.mascot`, default false to save width).
**Phase inference** from the MAIN thread's `tool.call` (T:12665; subagent calls ignored via `agentId`), latest call wins, sticky until the next call, reset by `prompt.submit`:
- RESEARCH: Read, Grep, Glob, WebSearch, WebFetch, LSP, ToolSearch, Bash with `isReadOnly` (T:12759), Agent with `subagent_type` Explore.
- PLAN: TodoWrite, TaskCreate, ExitPlanMode, a Write/Edit to a path matching `specGlobs`.
- BUILD: Edit, Write, NotebookEdit, non-read-only Bash not matching VERIFY, Agent (other types).
- VERIFY: Bash matching test/typecheck/lint/build (`shared/testparse.ts` `isVerifyCommand`), `git diff`.
- REPORT: a main `turn.step` whose result has `toolUses` empty and non-empty `answer` (T:13503-13508); cleared at `turn.complete`.
`mcp__awareness__phase({phase, note?, done?, total?})` overrides phase and `now` for the turn (`isDeferred` true; option `nowdoing.tool`).
**Sentence** priority: tool `note` > checklist in_progress `activeForm` (clip 80) > derived: `Reading {basename}`, `Editing {basename}`, `Searching`, `Running {exe}`, `Waiting on {n} agents` (`$.agent.list()` T:3187). Paths are shown as basenames only.
**Checklist** (decision Q4: the checklist band lives here; the `agents` plugin keeps `showChecklist` default false) is the agent-pets logic moved verbatim (`AP:hooks/register.tsx:243-300`): TodoWrite, TaskCreate (id from result `task.id`, else `#N`, else sequence), TaskUpdate (incl. `deleted`); "all N done" stays until the next prompt. Percent = done/total.
**Strings.** Terminal: `▪RESEARCH ▪PLAN ▪BUILD ▶VERIFY ▫REPORT  now: reviewing the builder's code  ███████░░░░░ 60%`; compact `▶ VERIFY · now: ... 60%`; minimal `VERIFY 60%`. Long command: `⏱ npm 01:42`. Desktop wireframe = mockup 4 (chips 78 px, Space Mono sentence, 90 px meter).
**Tick.** 1 s only while a command timer is shown; otherwise event driven.
**Options.** `nowdoing.mascot` false, `nowdoing.showAfterSec` 10, `nowdoing.tool` true, `nowdoing.phaseMap` (JSON string of extra tool->phase pairs).

## 3. Spec Tracker (`spec`)
**Behaviour.** Counts markdown checkboxes in the tracked plan/spec file (pinned, else auto-discovered, decision Q6) and shows a chip `SPEC 7/12` (terminal `📋 SPEC 7/12`) plus `next: {first unchecked, clip 60}` when Now Doing has room. If a TodoWrite checklist exists it drives the percent and the spec shows as the chip only; otherwise the spec drives the percent.
**Discovery (decision Q6: auto-discovery plus pin).** Auto: the most recently EDITED file, i.e. the path of the last main-thread Write/Edit/NotebookEdit result matching `spec.globs` (default `**/docs/**/*plan*.md,**/docs/**/*spec*.md,**/plans/**/*.md,**/specs/**/*.md,**/PLAN.md,**/SPEC.md,**/.claude/plans/**/*.md`), accepted only if it holds >= 1 checkbox; Reads do not count; a later matching edit of a different file replaces it. `/spec <path>` PINS a file (repo-relative or absolute; must exist and hold >= 1 checkbox, else `Spec file has no checkboxes` and nothing changes): a pinned file wins over auto-discovery and is not replaced by later edits. `/spec clear` unpins and returns to auto-discovery (the tracked file is dropped until the next matching edit); `/spec` alone prints `Tracking {path} (pinned|auto)` or `No spec tracked`. The pin lives in `$.state` for the session only. Glob matching is the shared `glob.ts` (`*`, `**`, `?`).
**Parsing.** CONFIRMED sources: `$.fs.read` (T:3242; 4 MiB cap, we cap at 256 KB), `$.fs.stat.mtimeMs` (T:3321). Lines matching `^\s*([-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$`; fenced code blocks skipped; nested items count (option `spec.nested` all|top). Max 500 items.
**Refresh.** After a Write/Edit tool result on the tracked path; on each `turn.complete` if `mtimeMs` changed; never on a timer. `classic.FileChanged` (T:4811) is not used (how to register watch paths is UNVERIFIED).
**Edge cases.** File deleted: chip gone and `/spec` says `Spec file missing` (a pinned path stays pinned until `/spec clear`). 0 checked of N: `SPEC 0/N`. Labels (<= 60 chars) live in `$.state` only, never `$.store`. **Options.** `spec.enabled` true, `spec.globs`, `spec.nested` all, `spec.maxKb` 256, `spec.auto` true (false = pin-only).

## 4. Focus Timer (`focus`)
**Behaviour.** Pomodoro from the Pomodoro Widget Spec. `/focus start [min]`, `pause`, `resume`, `stop`, `skip`, `status`. Band segment: Pom still, `FOCUS` (Silkscreen), `25:00` tabular numerals, 12-cell meter filling with elapsed time, `Focus 2 of 4`, `Heads-Up quiet until 14:25`. Break: label `BEAN`, copy `{n} of {total} bites` optional. Done: toast-free: `$.ui.notify("POWER UP · 25 MIN", {title:"Focus"})` (T:2465) and `$.audio.play({asset:'sounds/done.wav'})` (T:2677; macOS `afplay` only; the asset is a 0.4 s tone the builder generates with `scripts/gen-chime.ts`, CC0). Terminal: `🍅 FOCUS 25:00 ░░░░░░░░░░░░ · Focus 2 of 4 · Heads-Up quiet until 14:25`; paused `🍅 PAUSED 12:31`; break `🍅 BEAN 05:00`; long break after every 4th block (`longEvery`).
**State.** `$.state` `focus: {phase:'idle'|'focus'|'break'|'paused', endsAt, startedAt, remainingMs?, count, ofTotal}`; `$.store['focus:state']` and `$.store['focus:day:<date>']` `{count}` so a restarted session resumes by wall clock. If `endsAt` passed while the app was closed by more than 5 min: idle, block not credited.
**Edge cases.** Two sessions: the one that started it owns the notify/audio; the other shows the band from the store but does not fire. Daylight changes irrelevant (epoch ms). **Tick** 1 s while running. **Options.** `focus.focusMin` 25, `focus.breakMin` 5, `focus.longBreakMin` 15, `focus.longEvery` 4, `focus.sound` chime|off, `focus.notify` true, `focus.autoBreak` true.

## 5. UI placement
Band row (one Svg): `[focus][nowdoing]` priorities focus 1, nowdoing 2 (chips shrink first: full -> current phase only -> `VERIFY 60%`). Toasts: Heads-Up only. `$.ui.status` fallback: `now: ... 60%`. No pane.

## 6. State and contract outline
```ts
export type Phase = 'research'|'plan'|'build'|'verify'|'report'
export type NowView = { phase?: Phase; visited: Phase[]; now: string; done: number; total: number; isComplete: boolean; cmd?: {exe: string; startedAt: number}; specDone?: number; specTotal?: number; specNext?: string }
export type FocusView = { phase: 'idle'|'focus'|'break'|'paused'; endsAt?: number; remainingMs?: number; count: number; ofTotal: number }
export type HeadsUpView = { mutedUntil?: number; queued: string[]; lastShownAt?: number; shown: number }
declare module 'claude-code' { interface PluginState { awareness: { now: NowView; focus: FocusView; headsup: HeadsUpView; clock: number } } }
```
Store keys: `focus:state`, `focus:day:<date>`, `headsup:digest:<sid>`, `cache:learned` (own copy).

## 7. Hooks (all `.catch(next)`; all call `next`)
`session.start` (commands, tool, load focus, start probes/timer), `session.measure` (context, pace), `prompt.submit` (idle reset, phase reset, checklist reset), `turn.start`, `turn.step` generator (stamp cache request, REPORT detection, usage for cache learning), `turn.complete` (idle start, spec refresh, clear REPORT), `tool.call` (phase, checklist, spec, bigOutput, longCommand wrap, `mcp__awareness__phase` handler), `agent.spawn` (noModel), `model.fork`, `session.compact`, `session.end`, `classic.PreModelSwitch|PostModelSwitch|SessionStart` (cache), `command.run`, `ui.render{AbovePrompt}`. The `mcp__awareness__phase` handler returns the plain string `ok` and is the only `tool.call` answered by this plugin.

## 8. Performance and privacy
One timer (1 s) only while a focus block runs, a command >= 10 s runs, or a cache countdown is within 60 s; otherwise a 30 s timer for cache/ollama checks. Ollama probe <= 1 request per 5 min and only with the vault env set. No process execution (except the curl fallback of the Ollama probe, CONFIRMED to work on both hosts). Toast and band text never contain command arguments, prompts, file contents or full paths.

## 9. Behaviour contract (code-blind tester)
Clock mocked; limiter ticks every 1 s of mocked time. Toasts are read from captured `ui.toast` calls.
1. `session.measure` with `context.percent: 82` -> one toast whose text contains `CONTEXT` and `82%` and is <= 140 chars.
2. Same trigger again at 83%: no second toast. Percent 65 then 85: toast again.
3. Two triggers at the same instant (context 85 and a bigOutput result): first toast at t0 is `CONTEXT`-or-higher priority (`context` p3 before `bigOutput` p5); the other appears at t0+60 s; at t0+59 s only one toast exists.
4. Five triggers at t0: after 4 minutes at most 5 toasts total and never two within 60 s.
5. A queued trigger whose condition cleared (context back to 60 before delivery) is not shown.
6. Weekly HOT (seven_day p=71, resets in 3 d) -> toast with `WEEKLY PACE` and `HOT`; seven_day ON PACE -> none; five_hour HOT only -> none (default).
7. Cache: ttl option 1h, context 120000, last main request at t0, no turn running, at t0+3540 s -> toast containing `CACHE` and `60 S`; at t0+3500 s none; with a turn running none; with context 30000 none; fired once.
8. Bash result with `persistedOutputSize: 300000` on the main thread -> toast containing `OUTPUT` and `300 KB`; same from a subagent (agentId set) -> none.
9. Bash `npm test --token=SECRET123` that takes 130 s -> toast at 120 s containing `COMMAND` and `npm`, never `SECRET123` nor `--token`; a 30 s command -> no toast; the Bash result reaches the caller unchanged.
10. Bash with `run_in_background: true` -> no toast.
11. Env var `OBSIDIAN_VAULT_PATH` unset -> zero `http.fetch` calls. Set to an existing dir and `http.fetch` rejecting twice (5 min apart) -> toast containing `KEYWORD ONLY`; ok again then failing again -> second toast.
12. `agent.spawn` without model: default options -> no toast; with `headsup.trigger.noModel=true` -> toast containing `NO MODEL SET` and the description; with `model:'haiku'` or `subagentType:'fork'` -> none.
13. Surfaces `['terminal']` -> toast text starts with an emoji; `['desktop']` or `['terminal','desktop']` -> starts with `A-Z`.
14. `/headsup mute 30m` -> triggers within 30 min show nothing; `/headsup status` text contains `muted`.
15. Focus: `/focus start` -> band text contains `FOCUS 25:00` and `Focus 1 of 4`; after 60 s `24:00`.
16. During FOCUS a trigger yields no toast; after the block ends exactly one toast containing `While you focused` and the count of suppressed triggers (`1 notice`, `2 notices`); with `digestAfterFocus=false` none.
17. Block end: `ui.notify` called once with text containing `POWER UP`, `audio.play` once (option chime), band shows `BEAN 05:00`, count increments; after the 4th block break is `15:00`.
18. `/focus pause` freezes the clock for 10 min; `resume` continues from the same value; `stop` removes the focus segment; `skip` ends the current phase.
19. Store `focus:state` with `endsAt` in the future at `session.start` -> the band shows the right remaining time; with `endsAt` 10 min ago -> idle.
20. Now Doing: no turn and no checklist -> no phase row. Main `tool.call` Read -> `▶RESEARCH`; then Edit -> `▪RESEARCH` and `▶BUILD`; then Bash `npm test` -> `▶VERIFY`; a text-only step -> `▶REPORT`; `prompt.submit` -> all unvisited again.
21. Subagent `tool.call` events (agentId set) never change phase or checklist.
22. Read of `/a/b/c.ts` -> `now:` contains `Reading c.ts`, never `/a/b`.
23. TodoWrite with 5 todos, 3 completed, 1 in_progress with activeForm `Reviewing code` -> contains `60%` and `now: Reviewing code`.
24. `mcp__awareness__phase({phase:'verify', note:'running the suite'})` -> `▶VERIFY` and `now: running the suite`, result `ok`.
25. All todos complete -> `all 5 done` until the next `prompt.submit`, then the row is gone.
26. Spec: Write to `docs/plans/x.md` with 12 checkboxes (7 `[x]`, fenced block containing 2 more ignored) -> `SPEC 7/12`; Edit checking one more -> `SPEC 8/12`; `/spec clear` -> no chip; a plain `notes.md` Write -> no chip; `/spec docs/plans/y.md` pins y.
27. Row hidden when `hasSurvey`, when `view.agentId` set, when `maxRows < 4`; returns the inner tree otherwise stacked above the row.
28. Every observed event is passed to `next`; a thrown error inside a hook does not change any tool result.
29. Spec auto-discovery (Q6): Write of `docs/plans/a.md` (3 checkboxes) then Write of `docs/specs/b.md` (5 checkboxes) -> chip counts `b`; a Read of `a.md` changes nothing; after `/spec docs/plans/a.md` (pin) a further Edit of `b.md` does not change the chip and `/spec` text contains `pinned`; `/spec clear` -> no chip and `/spec` text contains `No spec tracked`; the next matching Edit tracks it again (text `auto`); pinning a file without checkboxes returns text containing `no checkboxes` and keeps the previous state; `spec.auto=false` -> no auto-discovery.
30. Focus digest (Q5): during FOCUS a `context` and a `pace` trigger fire -> zero toasts; at block end exactly one toast containing `While you focused: 2 notices` and both ids; no toast for them later (not queued); a trigger id that fired twice counts once; when the block end coincides with a toast shown 20 s earlier the digest appears at that toast + 60 s.
31. Peer gap (Q18): `dev.toast.lastShownAt = now - 10 s` -> a Heads-Up trigger is not shown until now + 50 s; an absent `dev` atom changes nothing; `awareness.headsup.lastShownAt` is updated on every shown toast.

## 10. Acceptance
validate, tsc, `claude plugin test` (31 statements x 2 surfaces). Manual: real long command raises one toast at 2:00; a real 25-min or `/focus start 1` block fires notify and sound; Ollama stop/start via `launchctl` toggles the vault toast; spec file edit moves the chip; with `usage` and `dev` installed the three rows coexist; mascot probe note.

## 11. Decisions (closed 2026-10-11)
3. **Q3** The "Agent without model" toast is owned by Delegation Guard (`agents`). Heads-Up's `noModel` trigger exists but defaults OFF (`headsup.trigger.noModel` false).
4. **Q4** The TodoWrite/TaskCreate/TaskUpdate checklist band moves to Now Doing; the `agents` plugin keeps `showChecklist` default false.
5. **Q5** After a focus block Heads-Up shows ONE digest toast summarising what it held back (section 1; contract 30).
6. **Q6** Spec Tracker: auto-discovery (most recently edited plan/spec file matching the glob list) plus `/spec <path>` to pin and `/spec clear` to unpin (section 3; contract 29).
18. **Q18 (cross-plugin, owned by `dev`)** `dev` raises its own PR failing-check toast; Heads-Up only reads `dev.toast.lastShownAt` for the shared 1-per-minute gap (conventions 7.5; contract 31).

Process note: the Ollama curl fallback (trigger 6) is a CONFIRMED path now that `$.process.run` is confirmed on desktop (2026-10-11); the `$.http.fetch` probe stays the first choice.

## 12. Effort and order
Heads-Up M, Now Doing M, Spec Tracker S-M, Focus Timer S-M. Order: `toast.ts` limiter -> Focus Timer (quiet flag) -> Heads-Up (context, pace, bigOutput, longCommand, cache, ollama, noModel) -> Now Doing (port checklist, phases) -> Spec Tracker.

## Build clarifications (orchestrator, 2026-10-12, from the contract referee)
- Statement 17: band and notify are checked at the exact block end.
- Section 1: the phase tool is declared as `phase` and listed to the model as `mcp__awareness__phase` (deferred).

## Clarifications (referee, 2026-10-12)
The `mcp__awareness__phase` handler returns the plain string `ok` (never an object: the host rejects plugin-tool results that are not a string or an array of text blocks). Subagent calls return a string too and change nothing.
`/headsup status` lists, besides held digest ids, the currently queued ids; with nothing queued or held it prints `none` for each, and `/headsup test <id>` lists valid ids only in its usage text.
A submitted line that starts with `/` is a command, not a new task: it does not reset the phase or the now-text.

REPORT (decided 2026-10-12): REPORT becomes current as soon as the main thread streams its first non-empty text in a step and stays current until a tool call in that step (then the previous phase returns) or until `turn.complete`, which clears the row. It is not inferred only at the end of the step. The Long Command Timer chip belongs to one tool call: it is removed when that call's result arrives, at `turn.complete`, at `turn.start` and at `prompt.submit`, whichever is first, and never outlives the turn. Failures in these clear paths must not leave the chip or phase behind: the renderer hides the chip when its ticker is not running.

/nowdoing (decided 2026-10-12): the phase row clears at turn end, but `/nowdoing` does not. Idle, it prints the last turn's final state: `last turn: <PHASE> · now: <sentence> · ended HH:MM` (plus ` · done/total done` if a checklist existed); with nothing this session: `no phase yet`; during a turn: `phase <PHASE> · now: <sentence>` (plus counts). The last-turn record is replaced at each turn end, cleared by `/nowdoing reset` and by a new session, and is never drawn in the band.
REPORT (amends the 2026-10-12 rule): the visible REPORT state must not depend on a state write made from inside the `turn.step` stream; it may be a render-time overlay that the band reads, repainted within 1 s of the first non-empty main-thread text. Host fact: every other plugin that writes `$` state from inside a `turn.step` hook must be treated as unreliable until live-verified.
