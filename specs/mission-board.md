# Spec: Mission Board (plan progress across all agents), a mod of the `agents` plugin

Read `00-conventions.md` first; builds on `agents.md` (Pets, Review Queue) and `awareness.md` (Now Doing, Spec Tracker). Written 2026-10-11 against Claude Code 2.1.295. Citation key as in conventions (`T:` types file, `R:` reference.md, `AP:`), plus `SP:` = `~/.claude/plugins/cache/claude-kit/savvy-progress/1.2.0/hooks/register.tsx` (kept as the reference for the parity list in section 3b; nothing is read from it at runtime). Decided by the user: "50 things planned, 5 running: show overall % of the 50, each running task's own %, and let me click to see everything that is left." Budget rule: `research/11-context-budget.md` (Design rule 4 and the Mission Board row). Version: ships in `agents` 1.1.0. Updated 2026-10-12: the user's answers (section 10) are folded in; Mission Board REPLACES savvy-progress (section 3b), Explore scouts get the spawn line, and the shared "plan all done" atom is defined in section 4.

## 0. Purpose and placement
One glance answers: how much of the whole plan is done, what is running and how far along each is, and what is still ahead. Mod id `mission` (`hooks/mods/mission.tsx`), one band segment, one pane `mission`, one command `/mission`, one deferred tool `mcp__agents__step`. It spends no tokens except the budget in section 7.
**Placement: the `agents` plugin (recommended), not `awareness`.** Why: (a) the truth for "running" and "done" is the agents run table and the Review Queue (`PetRun.status`, `reviewed`, `model`, `costume`, agents.md section 6), which `agents` owns; hosting there makes the critical state a same-plugin read, with no cross-plugin atom, so "done" can never silently degrade to a guess when a peer is missing (conventions 2.4); (b) `agents` already owns the `agent.spawn` hook, the 1 s pet tick, the Pom-in-costume art and the pane/band plumbing; (c) awareness owns only the plan SOURCES, and those are cheap to read (section 2). Rejected: `awareness` (would have to read every run field from `agents` atoms and cannot compute Done without the Review Queue). Rejected: a sixth plugin (a sixth band row for one segment). Cost of the choice: agents.md says "Spends no tokens" and lists a three-segment band; this spec amends both additively (section 8, cross-spec notes). Closed specs are not edited.

## 1. UI
**Band segment `mission`** (order 0, leftmost; priority 1, ties broken by order; shown when the merged plan has >= 1 item; same hide rules as conventions 4.1). Variants: full -> `12/50 · 5 run · 2 rev` -> `24%`. Percent is `done / total`, rounded to integer; the segment is a `Button` beside the Svg that opens the pane (conventions 4.4). On the terminal the Mission Board is reached by `/mission`; no separate `plan` label is drawn beside the segment. On desktop the segment keeps its pressable Button.
- Terminal full: `📋 Plan 12/50 done · 5 running · 2 review · 31 queued  ██░░░░░░░░░░ 24%` (the `review` and `blocked` parts appear only when > 0; `queued` = total - done - running - review - blocked). Medium: `📋 12/50 · 5 run · 2 rev`. Minimal: `📋 24%`.
- Desktop full: Space Mono `PLAN 12/50 DONE · 5 RUNNING · 31 QUEUED`, then a THIN bar (6 px high, 120 px wide, one solid `--ok` fill for done, a 50%-opacity `--rival` stripe for the summed fractional progress of running tasks, `--bg-2` track, 2 px edge). The number never includes the stripe: the stripe is shown work in flight, not done work. Alt text = terminal text.
- `$.ui.status` fallback (`-p`, `hasBand` false): `plan 12/50 · 5 running`.
**Pane `mission`** (desktop 360 px wide, scrolls; terminal text below). Opened by the band Button or `/mission`; never auto-opens except once per session when the plan first reaches >= 5 items and >= 2 agents run ("plan start", the savvy-progress parity rule, section 3b), and only if `e.viewport.isFullscreen` (conventions 4.6). Sections:
1. Header: 40 px Pom still (cast rule: Pom = working agents, conventions 5.5; fallback block mark), caps `MISSION BOARD`, plan name (basename of the source, or `checklist`).
2. Overall: 12-cell segment meter (cells = round(pct*12/100), at least 1 when pct > 0, full only at 100), `24%`, then count chips `12 DONE · 5 RUNNING · 2 REVIEW · 31 QUEUED · 0 BLOCKED`; a chip is a `Button` that filters the tile grid to that state (second press clears).
3. RUNNING NOW (n): one row per running item, 56 px, same bevelled tile as agents.md section 2: 40 px Pom in the task's costume, task title (Chivo 13, clip 60), model chip (tier colours, agents.md section 2), `mm:ss`, own 12-cell meter and `70%`. Label right of the meter: `step 7/10 · wiring table` when the agent reported (note clip 40), else `est.` with a hatched meter (diagonal 2 px steps pattern, no gradient) and the percent prefixed `~`. The row is a `Button` (opens the detail card). Several agents on one item: one row, label `3 agents`, mean percent.
4. EVERYTHING LEFT (n = not done): tile grid. Each tile is a `Button` with a `Text` child glyph (ButtonProps, T:1060; key = item id) in a wrapping `Box`: 14 px tiles on desktop (ink glyph 9 px minimum), colour by state: done `--ok`, running `--rival` (steps blink under reduced-motion allowed), review `--warn`, blocked `--danger`, queued dim edge, empty fill. Each tile also carries a non-colour mark: `✓` done, `▶` running, `?` review, `✕` blocked, none queued. Done tiles are drawn after the rest and dimmed. Order: plan order. Cap `mission.maxTiles` 120; above it the remaining tiles collapse into one `+N more` Button that opens the list view (text rows). The cap `mission.maxTiles` also bounds the terminal text grid: at most `maxTiles` glyphs, then a line `+{N} more · /mission list`. `/mission list` toggles the text list view (all items as `#n state title`). Pressing a tile sets `mission.selected` and shows the detail card under the grid.
5. Detail card: title (full, clip 120), state word, agent(s) (`type`, model chip, `mm:ss`), progress (`step 3/5 · note` or `~40% est.`), source (`checklist #12` | `spec x.md line 34` | `plan x.md line 8`, basenames only), and for review items the Review Queue status (`TESTS PASSED`, `UNTESTED`, ...) with a `REVIEWED` Button that does exactly what agents.md section 3 does. Close = `CLOSE` Button.
**Terminal pane** (`/mission`, the engine's text pane, same data):
```
📋 MISSION · checklist + spec x.md           24% ██░░░░░░░░░░
12 done · 5 running · 2 review · 31 queued · 0 blocked
RUNNING NOW (5)
 🔧 BUILD  Wire pricing table     SONNET 08:12  ███████░░░ 70%  step 7/10 · wiring table
 🔍 SCOUT  Map auth flow          HAIKU  01:40  ██░░░░░░░░ ~20% est.
EVERYTHING LEFT (38)   ▶ running  📥 review  ⛔ blocked  ▫ queued
 ✅✅✅✅✅✅✅✅✅✅✅✅ ▶▶▶▶▶ 📥📥 ▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫▫
 25 per line, numbered by plan order. /mission 17 shows item 17.
```
Glyphs are existing ones (`✅ ⛔ 📥 ▶ ▫`, conventions 6, awareness.md section 2); no new glyph. `/mission <n>` prints the detail card as text: `#17 · running · Wire pricing table · sonnet 08:12 · step 7/10 · checklist #17`.

## 2. Data sources and plan model
| source | priority | how | status |
|---|---|---|---|
| Main-thread checklist: TodoWrite, TaskCreate, TaskUpdate (incl. `deleted`); present only when the host exposes those tools. Claude Code 2.1.296 hides them for current models (haiku-5.5, opus-5.5) unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. The board works without it: sources #2 (spec globs) and #3 (`/mission plan`). | 1 | `tool.call` of the main loop (no `agentId`, T:194-203) parsed by `shared/checklist.ts` (same code Now Doing uses, awareness.md section 2); read-only here, no second checklist row is drawn | CONFIRMED (AP code) |
| Spec Tracker file checkboxes | 2 | the same discovery and parsing rules as awareness.md section 3 (globs, pin, fenced blocks skipped, 256 KB cap), via shared `glob.ts` and `plan.ts` (new, a pure `parseCheckboxes(text)` returning `{line, checked, text}[]`) | CONFIRMED (`$.fs.read`, `$.fs.stat`) |
| Registered plan | 3 | `/mission plan <path>` (markdown with checkboxes, same parser), `/mission plan clear`; path (absolute, never contents) kept in `$.store['mission:plan:<root-hash>']` `{v:1, path, root}`, where `root` is `$.session.root()` (fallback cwd). The plan is scoped to the project root: another root never sees it; two sessions in one root share it (last write wins); at `session.start` it loads only if `root` matches and the file exists with >= 1 checkbox, else it is dropped. `/mission plan clear` removes this root's key only. The legacy global key `mission:plan` is ignored. | CONFIRMED |
| Peer atom `awareness.plan` | not used | decided (Q1): Mission Board reads plan files itself with the shared parser; the closed awareness spec stays closed and no `awareness.plan` atom is read or requested | CLOSED |
| Agents and review state | n/a | own atoms: `runs` (`PetRun`), refreshed by `$.agent.list()` (T:3187) and `turn.complete{agentId}` (T:13276) as agents.md section 2 | CONFIRMED |
| Step reports | n/a | section 3 | tool CONFIRMED (SP:679-739 proves registration and `agentId` routing); a subagent reaching a deferred tool UNVERIFIED (Q2: first-run probe, Bash fallback) |
**Reuse, not duplication.** The checklist and spec counts here must equal Now Doing's (`awareness.now.done/total/specDone/specTotal`) when both plugins are installed (contract 24); if `awareness` is absent the board works alone. Labels (<= 60 chars) live in `$.state`, never `$.store` (conventions 2.5).
**Item** = `{ id, n, title, srcs: ('checklist'|'spec'|'plan')[], src: {kind, ref, line?}, srcState: 'todo'|'doing'|'done' }`; `n` is the 1-based plan order shown to the user; `id` = TaskCreate id (`T<id>`), else `S<line>` (spec), `P<line>` (registered). Max 500 items.
**Merge rules** (deterministic): (1) items are never merged within one source; (2) across sources, two items are the same when `norm(title)` is equal or their token Jaccard >= 0.8 (`norm` = lowercase, non-alphanumerics to spaces, drop `a an the to of and for`, collapse); (3) the higher-priority source supplies `title`, `srcState` and `src`; the lower is recorded in `srcs`; (4) a checklist `completed` or checked box means `srcState done`, `in_progress` means `doing`; (5) `deleted` checklist items vanish and their lines are not resurrected from a lower source of the same title; (6) order = source priority, then source order; (7) when a checklist exists it is the plan and spec/registered items that match nothing are APPENDED (they are part of the 50); (8) a source that disappears (file deleted, `/mission plan clear`) drops only its unmatched items.
**State per item** (`stateOf`, pure): no linked run: `srcState` done -> `done`, doing -> `running` (agent `main`, percent `--`, no meter), todo -> `queued`. With linked runs: any running -> `running`; else any failed -> `blocked`; else all finished and all `reviewed` -> `done`; else `review`. A linked running run beats `srcState done`. A failed run never makes `done`: `blocked` until `srcState` is done (then `done`). **Done = agent finished AND marked reviewed in the Review Queue (agents.md section 3, manual only, Q8)**; finished-unreviewed = `review`. Backfilled runs (`isBackfilled`) are never linked.
**Mapping plan items to agents** (run once at `agent.spawn` after `next` returns an `agentId`, then frozen; ordered rules, first hit wins; one run links to at most one item, one item may have several runs):
1. Explicit id: the spawn `prompt` contains `[task:<id>]` or `(task <id>)` or `Task #<n>`, `<id>` an existing item id (T-id, `S<line>`, `P<line>`) -> that item. Only the id is kept, never the prompt (conventions 2.5, 9).
2. Exact: `norm(description) == norm(title)`.
3. Fuzzy: best Jaccard of `norm(description)` vs open (not done) item titles >= 0.6 and strictly greater than the runner-up; a tie or a score below the threshold is no match.
4. No match -> UNPLANNED: the run appears in RUNNING NOW and the grid's trailing `UNPLANNED` group, is counted as `+N unplanned` in the pane header, and does NOT change the denominator or the percent. `/mission link <item n> <run n>` (run n = number from `/pets` order) links by hand; `/mission unlink <run n>`.
5. Also: when rule 1 hits or rule 2/3 matches at spawn, the spawn line (section 3) carries `[task:<id>]` so later `description` edits cannot unlink it.
TaskCreate results are read from the host record or its text `Task #<n> created successfully: <subject>`; any other result adds nothing. A TaskUpdate to `in_progress` on an item with no run does not create a run. A plan with 0 items hides the segment; running agents still show in the pets pane.

## 3. Per-task percent: the `step` tool and the spawn line
**Tool.** `$.tool.register({ name:'step', description, inputSchema })` in `session.start` (R:205-211, T:13117-13140): NO `isDeferred` field (default = deferred behind ToolSearch, name cost only). Full name `mcp__agents__step`. Description <= 200 chars: `Report your own progress to the mission board. Call with done/total after reading the brief, then after each step. Silent.` Schema, 3 fields: `done` integer >= 0 (required), `total` integer >= 1, `note` string (<= 60 kept). Served by `tool.call{tool:'mcp__agents__step'}` returning `{result:'ok'}`; a call with no `agentId` (main loop) returns `{result:'ignored: only subagents report steps'}`; it never changes another tool's result (conventions 3.3). Report stored per `e.agentId`: `{done: min(done,total), total, note, at}`; `total` may change between calls (a new plan); `done > total` is clamped; `total` missing keeps the last.
**Own tool only; savvy-progress is replaced, not read (decided, Q7).** Mission Board is the single source of step reports. There is NO passive read of `mcp__savvy-progress__step` or of savvy's atom, and no `savvy-progress.agents` slice in `peers.d.ts`. Precedence is: own step report (`mcp__agents__step`, or the Bash fallback), then the `est.` estimate. Registering our tool costs ~15 tokens (name) and, once savvy-progress is uninstalled, nothing is duplicated. savvy-flow workers have `mcp__savvy-progress__step` hard-coded in their prompts; the spawn line below is added to EVERY spawn (savvy-flow workers included), so after savvy-progress is gone they report to `mcp__agents__step` instead. Until then a worker may see two step instructions; its calls to the savvy tool are simply not read. Uninstall savvy-progress only after Mission Board passes its tests (section 3b); show the uninstall command to the user first.

**Spawn line.** `agent.spawn` hook (R: hook list; T:4091, the rewrite allowance T:258, `prompt` T:273): AFTER the guard's decision (guard registered first, agents.md section 4; a denied spawn never reaches us), rewrite `e.prompt` to `e.prompt + '\n' + LINE` where `LINE = "Progress (required): first ToolSearch \"select:mcp__agents__step\", then call it {done,total,note} now and after each step. [task:<id>]"` (the `[task:<id>]` part only when mapped; <= 160 characters, about 35 tokens, constant text so subagent prompts of the same task stay stable; the ToolSearch step is needed because the tool is deferred and trivial tasks otherwise skip it, observed live 2026-10-12). Skipped (prompt untouched) when: `e.fork` or `e.isTeammate` (T:334, T:341), `mission.stepLine` false, the prompt already contains `mcp__agents__step` (idempotent), a workflow agent (its content is not rewritable, T:258; those get `est.` only). Explore scouts DO get the line (decided, Q6): about 35 tokens per scout, and every agent then reports real steps, or the rewrite is refused (the spawn proceeds untouched, R:79). The line is appended once and never edited later. If `mission.stepVia = 'bash'` (fallback for Q2) the line is `Progress: run Bash 'echo MISSION_STEP done/total note' ...` and a `tool.call{tool:'Bash'}` observer with `agentId` set parses `^\s*echo\s+MISSION_STEP\s+(\d+)/(\d+)\s*(.*)$`, calls `next(e)` unchanged (the echo runs harmlessly), and stores the same report.
**Percent rules.** Reported: `pct = done/total` (no estimate shown, label `step d/t`). Unreported: `est = min(0.9, turns / typical)`, `turns` = this agent's `turn.step` events (T:13430 via agents.md), `typical` = median `turns` of the last 20 FINISHED runs of the same `subagentType` this session when >= 3 exist, else the table `Explore 8, general-purpose 20, other 15` (option `mission.typicalTurns` JSON). An estimate is capped at 90% until the run finishes, always labelled `est.` (terminal `~NN% est.`, desktop hatched meter), and never contributes to the DONE count. A finished run is 100% (state `review`). A running run that stalls does not move. Item percent = mean of its runs.

## 3b. Parity with savvy-progress (Mission Board replaces it)
the user: "this will be our own repo; we don't want other people's apps." Mission Board must cover every savvy-progress feature that is in use before savvy-progress is uninstalled. The language setting (en/ru) is NOT needed. Parity list, each with its test in section 8:
| savvy-progress feature | Mission Board equivalent | test |
|---|---|---|
| Plan progress bar above the prompt | band segment `mission` (section 1) | 2, 7 |
| Worker step reports (`step`) | `mcp__agents__step` plus the spawn line on every spawn (section 3) | 15, 16, 19 |
| Per-agent context, tokens, cost, step count from `turn.step` | per-agent fields in the RUNNING NOW row and detail card, fed by the `turn.step` count (section 3) plus the agent's usage from the run table (`PetRun`, agents.md section 6); a field the engine does not expose is shown as `--`, never guessed | 33 |
| Auto-open pane on plan start | pane `mission` auto-opens once per session at plan start (section 1 rule) | 34 |
Exit gate: contract statements 33 and 34 and the whole suite pass. Only then: show the exact uninstall command for savvy-progress to the user, and run it only on a yes. The compare of savvy's auto-open threshold against ours happens at that parity test, not before.

## 4. State and types contract (outline)
```ts
export type MissionState = 'queued'|'running'|'review'|'done'|'blocked'
export type StepReport = { done: number; total: number; note?: string; at: number; via: 'own'|'bash' }
export type MissionItem = { id: string; n: number; title: string; srcs: ('checklist'|'spec'|'plan')[]; src: { kind: 'checklist'|'spec'|'plan'; ref: string; line?: number }; srcState: 'todo'|'doing'|'done'; runIds: string[] }
export type MissionView = { items: (MissionItem & { state: MissionState; pct?: number; isEst?: boolean; label?: string })[]; counts: Record<MissionState, number>; total: number; pct: number; stripePct: number; unplanned: number; planName: string; selected?: string; filter?: MissionState }
declare module 'claude-code' { interface PluginState { agents: { /* agents.md keys */ mission: { view: MissionView; steps: Record<string, StepReport>; links: Record<string, string>; plan?: { path: string; count: number }; allDone: boolean } } } }
```
**Shared "plan all done" atom (additive, decided Housekeeping 3).** The state key above is published as the peer atom `{plugin:'agents', key:'mission'}`; its field `allDone: boolean` is the shared signal. Definition: `allDone = view.total >= 1 && counts.done === total && counts.running === 0 && counts.review === 0 && counts.blocked === 0` (so unplanned running agents do not count, but a running or unreviewed linked run does). It is recomputed with the view, stays true after the last item is done (it survives prompts, section 5) and resets on `/mission plan clear`, a new plan, or when a new item appears. Absent atom = no information for every reader. `compact.md` (Compact Coach, `phase finished` signal) reads `agents.mission.allDone`; it is declared in `peers.d.ts` as an optional slice. Nothing in a closed spec is edited.
Store: `mission:plan:<root-hash>` only. The view is recomputed in hooks (never in a render hook) on: checklist change, spec refresh, run table change, step report, link/unlink, plan change; memoised by a version counter. Renders read `mission.view` and write nothing. Module variables are caches only (conventions 2.3).

## 5. Hooks (all `.catch(next)` except where noted; every observer calls `next`)
`session.start` (register tool `step` and command `mission`; collision rule conventions 1.6 -> `agents-mission`; load this root's `mission:plan:<root-hash>`; peers probe), `agent.spawn` (prompt rewrite as section 3; after `next`, if `agentId`, link the run per section 2; on `.catch` return `next(e)` with the original event), `tool.call` (main loop: checklist and spec path discovery, the same events agents already observe; `mcp__agents__step` handler, the only call answered by this mod; Bash observer for `stepVia` bash, gated by a cheap prefix test before any regex), `turn.step` (count turns per `agentId`), `turn.complete` (run finished; spec refresh when `mtimeMs` changed), `prompt.submit` (nothing; the plan survives prompts; "all done" stays until `/mission plan clear` or the next new plan), `command.run{mission}`, `ui.render{AbovePrompt}` (segment via `segments(ctx)`), `ui.render{Pane, requestId:'mission'}`. Subcommands: `/mission` toggle pane, `/mission <n>` detail text, `/mission list` toggle text list view, `/mission plan <path>|clear`, `/mission link <item> <run>`, `/mission unlink <run>`, `/mission status` (one line).

## 6. Performance and privacy
No process execution, no network. Recompute <= 20 ms for 500 items x 100 runs (Jaccard on pre-tokenised sets; matching only at spawn, not per render). No new timer: the elapsed clocks ride the existing pets 1 s tick (agents.md section 8), which already runs only while a pet runs. `$.agent.list()` calls are the pets sync's (>= 3 s apart), none added. Spec reads follow awareness.md section 3 (on `turn.complete` with changed `mtimeMs`, never a timer). State holds titles (<= 60), counts, ids, step notes (<= 60), basenames and line numbers; never prompts (only the extracted task id), answers, file contents or full paths.

## 7. Context budget (hard rule, `research/11-context-budget.md`)
| item | always-loaded (main thread) | per subagent | notes |
|---|---|---|---|
| band, pane, status, tiles | 0 | 0 | UI-only hooks, `ui.render` |
| `mcp__agents__step` | ~15 (name only, deferred by default) | ~120 only if the subagent loads the schema via ToolSearch (description <= 200 chars, 3 fields) | never `isDeferred:false`; measured reference: savvy-progress's 2 deferred tools = 784 deferred tokens when loaded, 0 until then (section "Measured") |
| `/mission` command | ~25 (assumed in the listing, Q2 of research 11) | 0 | one command; description <= 60 chars; subcommands via `command.describe` |
| spawn line | 0 | <= 40 (about 35, <= 160 chars) | in the subagent's prompt, not the main thread; skipped for fork, teammate and workflows only; Explore scouts get it (Q6) |
| skills, registered agent types, `prompt.compose`, `prompt.context`, SessionStart text | 0 | 0 | none registered |
| TOTAL | **40 tokens** (matches the planned row in research 11) | **<= 40** | main thread never sees the spawn line |
Regression test (conventions 10, research 11 rule 6): with the mod on, `$.session.usage({breakdown:'summary'})` `slashCommands + mcpTools` grows by <= 40 tokens versus off. `mission.enabled` false registers no tool, no command, rewrites nothing. The `agents` plugin budget row becomes 50 + 40 = 90.
Cross-spec notes (additive, nothing closed is edited; the user to fold into the closed docs when convenient): agents.md section 1 "Spends no tokens" -> "except section 7 of mission-board.md"; agents.md section 5 band order gains `[mission]` first; research 11 plugin table `agents` row 50 -> 90; conventions 4.6 pane list gains `mission`; `peers.d.ts` gains the optional `agents.mission` slice (`allDone`, read by compact.md). No `awareness.plan` and no `savvy-progress.agents` slice (decided).

## 8. Behaviour contract (code-blind tester)
Clock mocked; runs injected through `agent.spawn`/`turn.complete` events and `$.agent.list`; tool calls through `tool.call` events. Every UI statement runs on `terminal` and `desktop`; alt == terminal text.
1. No plan items: band absent (inner tree returned), `mission.view.total` 0. Five `TaskCreate` results -> band text contains `0/5 done`.
2. Plan of 50 (50 TaskCreate), 12 `TaskUpdate completed`, 5 `in_progress` each with a running run linked, 2 runs finished unreviewed -> band text contains `12/50 done`, `5 running`, `2 review`, `31 queued`, `24%`; terminal meter has 3 `█` and 9 `░`.
3. Marking one of the 2 review runs reviewed (`/review done 1`) -> done becomes 13 and review 1 (band `13/50`); marking nothing leaves done at 12 however long the clock runs (30 min mocked).
4. A finished, unreviewed run whose checklist item is `completed` -> item `review`, not done.
5. A running run linked to an item whose `srcState` is done -> `running`.
6. A failed run -> `blocked`; after the item is `completed` in the checklist -> `done`; a failed run marked reviewed with `srcState` todo stays `blocked`.
7. `stripePct` = sum of running items' fractional progress / total; the band number (`24%`) never changes with it.
8. `TodoWrite` and a Spec file (12 boxes, 7 checked) with 3 matching titles -> total = checklist items + 9 (spec items matched by Jaccard >= 0.8 are not added); the matched items take checklist `title` and `srcState`; unmatched spec items are appended and queued.
9. Titles `Fix login bug` vs `fix  the login bug!` merge (norm equal); `Fix login` vs `Fix logout flow` (Jaccard < 0.8) do not.
10. Checklist `deleted` item disappears and a spec line with the same title is not resurrected.
11. `/mission plan docs/plans/x.md` with 4 boxes and no checklist -> total 4, `plan` source names basename `x.md` only; `plan clear` removes its unmatched items; the store holds `{v:1, path}` and no contents.
12. Mapping rule 1: spawn prompt containing `[task:T3]` links to item T3 even if the description differs; rule 2: description equal after `norm`; rule 3: Jaccard 0.7 with a unique best -> linked; two items tied at 0.7 -> unlinked.
13. Unlinked run: listed under UNPLANNED, header contains `+1 unplanned`, `total` and `pct` unchanged.
14. `/mission link 5 2` links item 5 to run 2; `/mission unlink 2` removes it; a bad number prints `No item 99` and changes nothing.
15. Step tool: registered as `mcp__agents__step` with NO `isDeferred:false`, description <= 200 chars, schema with <= 3 properties; a call with `agentId:'a1'` `{done:7,total:10,note:'wiring table'}` returns `{result:'ok'}`, and the pane running row for a1 contains `70%` and `step 7/10` and does NOT contain `est.`.
16. A step call with no `agentId` returns a result containing `ignored` and changes no state; `done:12,total:10` shows `100%` of that item's running progress but state stays `running` until the run finishes.
17. A run without reports, mock typical 20 turns, 4 `turn.step` events -> row contains `~20%` and `est.`; 40 steps -> `~90%` (capped) and still `est.`; on `turn.complete` -> state `review`, percent 100, no `est.`.
18. Estimate learning: after 3 finished `general-purpose` runs with 10, 12, 14 turns, a new run's estimate uses 12 as typical.
19. Spawn line: a spawn with `prompt:'Do X'` yields a rewritten prompt that starts with `Do X`, ends with a line containing `mcp__agents__step`, whose appended text is <= 160 characters, appended exactly once (a second pass over the result changes nothing), and contains `[task:T3]` only when mapped.
20. No line for `fork:true`, `isTeammate:true`, a workflow agent, `mission.stepLine=false`; a spawn with `subagentType:'Explore'` DOES get the line (<= 160 characters, once); `mission.enabled=false` -> no tool registered, no rewrite, no command, no band.
21. A guard-denied spawn (delegation deny) never reaches the rewrite and records no run; a spawn whose rewrite is refused still starts with the original prompt.
22. `stepVia='bash'`: a subagent Bash `echo MISSION_STEP 3/5 reading` stores a 3/5 report and the call result is passed through unchanged; the same command from the main loop stores nothing.
23. Precedence: an own report 2/4 for an agent -> `50%`; no report -> estimate (`~NN% est.`); a `savvy-progress` atom entry for the same agent, present or absent, is never read and changes nothing (no exception, no `via:'savvy'`).
24. With `awareness.now` `{done:3,total:5}` present, the board's checklist counts for the same events are 3 and 5; with the atom absent the board still works.
25. Tile grid: 50 items -> 50 `Button`s with keys equal to item ids, each carrying a state mark (`✓ ▶ ? ✕`); a chip Button for `REVIEW` filters to review items only; pressing a tile sets the detail card to contain the title, state word, source basename and `step 7/10` or `est.`; `maxTiles=10` on 50 items -> 10 tiles plus one `+40 more` Button.
26. Terminal pane for the section-1 sample matches the shown line formats (`RUNNING NOW (5)`, `EVERYTHING LEFT (38)`, `~20% est.`, 25 glyphs per line).
27. Hidden when `hasSurvey`, `view.agentId` set, or `maxRows < 4`; inner tree preserved; fallback status `plan 12/50 · 5 running` when `hasBand` false.
28. Privacy: after a spawn whose prompt contains `SECRET123 [task:T3]`, no atom, store value, toast or band/pane text contains `SECRET123`.
29. A thrown error in any mission hook leaves every tool, spawn and command result unchanged and still calls `next`.
30. `session.usage` regression: enabling the mod adds <= 40 tokens to `slashCommands + mcpTools`; no skill, agent type or `prompt.*` section is registered.
31. `allDone` atom: 5 items, all done, nothing running -> `agents.mission.allDone` true; one item reopened, or one linked run still running or unreviewed -> false; an unplanned running agent alone does not make it false; `/mission plan clear` or a new plan resets it; total 0 -> false.
32. Savvy independence: with no `savvy-progress` plugin or atom present, every statement above passes unchanged; no hook reads `mcp__savvy-progress__*` calls.
33. Parity, per-agent figures: a running agent after 4 `turn.step` events with injected usage shows its own context, tokens, cost and `step n/m` or step count in the detail card and RUNNING NOW row; a field with no source shows `--`; terminal text equals desktop alt.
34. Parity, auto-open: with `e.viewport.isFullscreen` true, the first time the plan reaches >= 5 items with >= 2 running agents the pane `mission` opens once; a second occurrence in the session does not reopen it; not fullscreen: never opens.

## 9. Acceptance
`claude plugin validate`, `tsc`, `claude plugin test` (34 statements x 2 surfaces) for `agents`; the 32-statement agents suite still passes. Manual on this Mac: (1) create a 10-item checklist, spawn 3 real subagents (haiku Explore, sonnet builder, general-purpose) with matching descriptions; watch 3 running rows, each with a `step n/m` once it obeys the line (the Explore scout included; `est.` only until its first report); (2) finish one, confirm it shows `review` and the band does not count it; `/review done` moves it to done; (3) probe Q2 in the first run (does a Haiku subagent call the deferred tool unaided; if not, switch `stepVia` to `bash`); (4) `/context`: confirm <= 40 tokens added; (5) tile click on desktop, 120+ tiles scroll check with the lag probe (switch to SVG tiles plus a picker if slow); light/dark; mascot fallback; (6) parity check against the running savvy-progress (plan bar, step reports, per-agent figures, auto-open), then show the uninstall command for savvy-progress and run it only on the user's yes.

## 10. Decisions (closed 2026-10-12)
Source: `docs/2026-10-11-decisions-batch2.md`.
1. Plan source: Mission Board reads plan files itself with the shared parser. No `awareness.plan` atom; the awareness spec stays closed.
2. Step reports: the deferred `step` tool; a first-run probe decides; fallback is Bash `echo MISSION_STEP n/m` if subagents cannot call it.
3. A failed-then-reviewed task stays `blocked` until the plan source marks it done.
4. Estimates: Explore 8, general-purpose 20, other 15 turns; session median after 3 samples; always labelled `est.`.
5. Tile grid: cap 120 clickable tiles plus a `+N more` list; lag probe in the first test run; if slow, switch to SVG tiles plus a picker.
6. CHANGED from the default: Explore scouts ALSO get the spawn line (about 35 tokens per scout; every agent then reports real steps). Fork, teammate and workflow agents are still skipped.
7. CHANGED from the default: Mission Board REPLACES savvy-progress. The passive savvy source is removed; precedence is own step report, then `est.`. Parity list in section 3b. Uninstall savvy-progress only after Mission Board passes its tests (command shown first). savvy-flow workers fall back to our spawn line.
Housekeeping 3: the shared "plan all done" signal is `agents.mission.allDone` (section 4); `compact.md` reads it.

## 11. Effort and order
M overall. Order: `shared/plan.ts` + `glob.ts` (pure parsers, `norm`/Jaccard) -> `stateOf` and merge with tests -> step tool, spawn line, Bash fallback -> estimate and learning -> band segment -> pane (rows, then tiles, then detail card) -> per-agent figures and auto-open (parity, section 3b) -> `allDone` atom -> acceptance probes -> savvy-progress uninstall (after tests pass).

## Build clarifications (orchestrator, 2026-10-12, from the contract referee)
- 8.21 (refused rewrite): the kit can only simulate refusal with a failing bottom; the plugin retries once with the original event. The faithful check moves to the manual acceptance list (real engine); the kit test stays as a robustness check.
- Tiles and chip Buttons are desktop-only; the terminal pane shows text glyph rows (a glyph row contains only `✅ ▶ 📥 ⛔ ▫` and spaces; the legend line is not one).
- Relative `/mission plan <path>` resolves against the session cwd.
- `/mission unlink <run n>` on a run that exists but has no link prints `Run {n} is not linked.` and changes nothing; a link actually removed prints `Unlinked run {n}.`; a missing run prints `No run {n}`.

## Parity backlog (decided 2026-10-12)
Why: the user uninstalled savvy-progress on 2026-10-12 (acceptance 6.9; docs/acceptance-results.md) and wants the data it showed. Five fields (a, b, c, e, f), UI only; decisions closed 2026-10-12 (see Decisions at the end). Citations: `T:` types file, `AP:` plugins/agents code read 2026-10-12. Status words as conventions: CONFIRMED (typed or proven by code) / UNVERIFIED (needs a live probe, fallback given). All line numbers are from the 2026-10-12 types file; re-grep the symbol if one misses.
**Hard rules for every field.** Zero model-visible tokens: no new tool, command, prompt section, skill or tool-description growth; hooks only read events and write `$.state`. Section 7 budget stays at 40 tokens (contract 30 and 49). No new glyph (conventions 6: `·`, `█ ░`, `✅`, `⚠`, `📋`, `📥` only; `~` and `%` are plain text). Money is always an estimate: prefixed `~`, priced from `shared/prices.ts` (`PRICES_AS_OF`, `pricesJson` override), never from an invoice. Render hooks read atoms only (conventions 3.1a); every figure below is computed in `turn.step`/`turn.complete`/the pets sync and stored on `PetRun` or `mission.view`. `--` = unknown, never a guess. Terminal text == desktop Svg `alt`.
**Already built (verified in AP 2026-10-12, do not rebuild):** `PetRun` already carries `turns`, `ctx` (last request's input tokens), `tokens` (running sum), `usd` (running sum), updated in the `turn.step` hook (`register.tsx` ~857-870, `stepCostUsd`); `figures(r)` in `mission-core.ts` already prints `ctx 61k · tok 120k · $0.42 · steps 7`; `progressOf` already prints `step d/t · note` (note clipped to 40). The backlog is therefore mostly display, a window table, totals and effort.

### (a) Per-agent context %, tokens, cost
- Shown: RUNNING NOW row (second line on terminal, second text line under the title on desktop), and the detail card (same text plus `peak ctx`). Finished runs keep their last figures in review/done rows and the detail card.
- Format: `ctx 41% · 38k tok · ~$0.42`. Context = last request's input tokens / that model's window. Window unknown: `ctx 61k` (tokens, today's behaviour). No request yet: `ctx --`. Tokens = all four counts summed (`fmtTokens`: `950`, `38k`, `1.2M`). Cost `~$0.42`, under a cent `~<$0.01`, no usage `~$--`. Context >= 80%: line gets a trailing `⚠` and the desktop edge turns `--warn`. Example: `ctx 82% ⚠ · 412k tok · ~$3.10`.
- Source: tokens and cost CONFIRMED: `turn.step` result `usage` with `e.agentId` (T:13530 `usage: TurnUsage|null`, T:13651-13656 `TurnUsage = ModelUsage & {model}`, T:6409-6444 four counts; `agentId` T:13463); built (AP). Context numerator CONFIRMED (same usage; input + cache read + cache write). Context window per model: UNVERIFIED in the types. `SessionContextUsage.window/percent` (T:10950-10964) is the SESSION model's only, so it is wrong for a Haiku scout; no per-model window field was found in the types. Decided: a static dated table `shared/windows.ts` (family -> window, `asOf`, same pattern as prices) plus a `windowsJson` override option; one live cross-check: compare an Opus subagent's computed % with `$.session.usage().context.percent` at the same moment.
- Fallback: window unknown -> tokens form; `usage` null (aborted, failed request) -> keep the previous figures, never zero them; unknown model -> `(default price)` suffix in the detail card only, row unchanged.
- Width: desktop row >= 340 px: all three; < 340 px: `ctx 41% · ~$0.42`; < 260 px: `41% ~$0.42`. Terminal >= 100 cols: second line shown in full; 80-99: tokens dropped; < 80: only `41%` appended to line 1. Band: unchanged.

### (b) Run totals: cost, tokens, elapsed
- Shown: one line directly under the pane header's counts row, and in `/mission status` (appended). Not in the band.
- Format: `RUN · ~$3.18 est. · 412k tok · 14:02 · 5 agents`. Elapsed `mm:ss`, `h:mm:ss` from one hour. `agents` = runs counted (unplanned included, backfilled excluded). Desktop: Space Mono 10 px, same text as `alt`; label `RUN` in caps.
- Source: sums of the per-run `usd`/`tokens` (CONFIRMED, built) over the subagent runs in `mission.view` (so the total equals the sum of the rows; main-thread spend is not included); elapsed = now - earliest `startedAt` of the current plan's runs (`PetRun.startedAt`, CONFIRMED, AP). The clock stops at `allDone` (value frozen) and restarts from zero when a new plan is registered. Clock rides the existing pets 1 s tick (section 6; no new timer).
- Fallback: no runs -> line hidden. Any run with unknown cost -> `~$3.18+ est.` (the `+` marks a floor).
- Width: desktop 360 px pane: one line. Terminal < 80 cols: drop `agents`, then tokens.
Clarification (2026-10-15, acceptance F26): with no plan items (`view.total` 0) no clock epoch or `allDone` exists, so elapsed follows the current burst instead of the whole session. A burst is a chain of subagent runs (backfilled excluded) where each run starts less than 30 min after every earlier run in the chain has ended (a running run counts as ending now). Elapsed = end - start of the latest burst: start = earliest `startedAt` in it; end = now while any run in it is running, else the latest `endedAt` (the value is frozen while idle). A run starting 30 min or more after the last one ended opens a new burst and elapsed restarts at `00:00`. Cost, tokens and `N agents` still sum all runs. With a plan (`view.total >= 1`) the rule above (epoch, freeze at `allDone`, restart on a new plan) is unchanged. Test 42b-42d.


### (c) Per-agent effort level
- Shown: lowercase word after the model chip on the row and in the detail card (`SONNET high`, `HAIKU low`). Integer budget: `SONNET b8k`.
- Format: `low|medium|high|xhigh|max` as given (`medium` written `med` on the row only). Detail card line: `effort high (spawn)` or `effort high (step)` for the source.
- Source: TYPED, population for subagents UNVERIFIED. `AgentInfo.effort?: string|number` (T:476-479) via `$.agent.list()` (T:3187; the existing pets sync, no extra call); per-request `TurnStepInput.effort` (T:13447-13449; absent "for a model without effort") with `e.agentId` (T:13463); `agent.spawn` has NO effort field (the Agent tool input has one, T:15997-15998, reachable only via `tool.call`). Probe in the first live run: spawn one subagent with `effort:'low'` and one without; log `AgentInfo.effort` and `turn.step` `e.effort`. Order: `turn.step` effort (latest) over `AgentInfo.effort`.
- Fallback: absent -> row shows nothing (no `?`); detail card `effort --`. A model without effort support never shows a level.
- Width: chip is the first thing dropped on a narrow row (< 300 px desktop; < 90 cols terminal).

(d) plan phase: dropped 2026-10-12 (Now Doing shows it).

### (e) Step note text
- Shown: RUNNING NOW row label (exists, clip 40), plus FULL note (<= 60 stored) on the detail card line `note: wiring table`, with age `12 s ago`.
- Format: row `step 7/10 · wiring table`; card `step 7/10 · note: wiring table · 12 s ago`. A report with no note: `step 7/10`. Note with only whitespace is treated as none.
- Source: CONFIRMED. `mcp__agents__step` stores `{done,total,note,at}` per `agentId` (section 3; `progressOf`, AP `mission-core.ts:101`). Gap to close: acceptance 6.9 listed note text as missing, but AP already renders it; first re-verify live that it appears on desktop and terminal, then only add the card's full text and age. No new tool field (description stays <= 200 chars, schema 3 fields).
- Fallback: no report -> `est.` label as today. After the run finishes the last note stays on the card; a note older than 120 s on a running agent is dimmed (plain text color change only).
- Width: row clips to 40 (terminal >= 100 cols), 24 (80-99), none (< 80); desktop clips to the free width, ellipsis `…` is plain text in the existing clip function.

### (f) Accepted vs planned
- Shown: pane Overall section, one more chip after the count chips; not a band segment.
- Format: `ACCEPTED 9 of 50 planned`. Accepted = items whose state is `done` with >= 1 linked run and all linked runs `reviewed`; planned = `view.total`. Items done only by checklist or file checkbox are listed as `3 checked off by hand` after it. Example line: `ACCEPTED 9 of 50 planned · 3 checked off by hand · 2 awaiting review`.
- Source: CONFIRMED, derived from `stateOf` and `PetRun.reviewed` (section 2; Review Queue manual-only, agents.md section 3). Pure function of `mission.view`; nothing new fetched.
- Fallback: total 0 -> hidden; no linked runs at all -> `ACCEPTED 0 of 50 planned`. Overlap: `done` in the band already equals accepted + by-hand items, so this field only splits them.
- Width: wraps below the chips on desktop; terminal drops the `by hand` and `awaiting` parts below 80 cols.

### Wireframes (Running row and run totals)
Desktop pane (360 px, row 56 px; second line Space Mono 10 px; Pom 40 px left of both lines):
```
[Pom] Wire pricing table            SONNET high  08:12   (title Chivo 13, chip, clock)
      ███████░░░░░ 70%  step 7/10 · wiring table          (12-cell meter + label)
      ctx 41% · 38k tok · ~$0.42                          (figures, 10 px)
RUN · ~$3.18 est. · 412k tok · 14:02 · 5 agents           (under the counts chips)
ACCEPTED 9 of 50 planned · 3 checked off by hand
```
Terminal (>= 100 cols; today's line 1 plus an indented line 2):
```
📋 MISSION · plan x.md 24% ██░░░░░░░░░░
12 done · 5 running · 2 review · 31 queued · 0 blocked
RUN · ~$3.18 est. · 412k tok · 14:02 · 5 agents
ACCEPTED 9 of 50 planned · 3 checked off by hand
RUNNING NOW (5)
 🔧 BUILD  Wire pricing table  SONNET high 08:12  ███████░░░ 70%  step 7/10 · wiring table
           ctx 41% · 38k tok · ~$0.42
 🔍 SCOUT  Map auth flow       HAIKU 01:40  ██░░░░░░░░ ~20% est.
           ctx 12% · 9k tok · ~$0.01
```
Narrow (< 80 cols): `🔧 BUILD Wire pricing…  SONNET 08:12 70% 41%` and no line 2.

### Contract cases (code-blind tester; numbering continues section 8)
35. After 3 `turn.step` results for agent a1 with usage `{input_tokens:1000,cache_read_input_tokens:9000,cache_creation_input_tokens:0,output_tokens:500, model:'claude-sonnet-5-5'}` each, the pane row for a1 contains `tok`, the summed 31,500 tokens formatted by `fmtTokens` (`31.5k` or `32k`, never 10.5k), and a cost starting `~$`.
36. Cost uses the shared price table: with `pricesJson` sonnet `{input:2,output:10,cacheRead:0.2,write5m:2.5}` and one step of 1,000,000 input tokens, the row shows `~$2.00`; no `$` figure appears without a `~`.
37. Context percent: with a configured window of 200000 for the model and last-request input of 82000, the row shows `ctx 41%`; with 170000 it shows `ctx 85%` and `⚠`; with no known window (and no `windowsJson` entry) it shows `ctx` followed by a token count and no `%`; a `windowsJson` override changes the percent.
38. A `turn.step` result with `usage: null` for a1 leaves a1's earlier figures unchanged; an agent with no step yet shows `ctx --` and `~$--`.
39. Two agents' figures never mix: usage with `agentId:'a2'` does not change a1's row; a main-loop step (no `agentId`) changes no row.
40. Run totals line (subagent runs only): two finished runs (cost 0.40 and 0.20, tokens 1000 and 3000) plus one running (0.10, 500) at 14:02 elapsed -> pane contains `RUN`, `~$0.70`, `est.`, `4.5k tok` (or `5k`), `14:02`, `3 agents`. No runs -> no `RUN` line. `/mission status` text contains the same `RUN` line and the band tree does not.
41. One run with unknown cost among known -> total shows `~$` figure ending `+`; a backfilled run is not counted in `agents`.
42. Elapsed follows the mocked clock; after `allDone` becomes true the elapsed value stops changing while the clock advances 10 minutes; registering a new plan restarts it from `00:00`.
42b. No plan, one run finished 3 days ago and one running now that started 5 min ago -> elapsed `05:00`.
42c. No plan, last run ended 10:20 after starting 10:00, mock clock advanced 2 h -> elapsed stays `20:00`.
42d. No plan, runs 10:00-10:20 and 10:40-10:50 (gap 20 min) -> elapsed `50:00`.
43. Effort: an agent whose `$.agent.list()` row has `effort:'high'` shows `high` after the model chip; a later `turn.step` for it with `e.effort:'low'` changes the row to `low`; an agent with no effort anywhere shows no effort word on the row and `effort --` on the card; numeric `8000` shows `b8k`.
44. Step note: a step report `{done:7,total:10,note:'wiring table'}` makes the row contain `step 7/10 · wiring table` and the detail card contain `note: wiring table`; a 90-character note is stored as 60 and the row clips to 40; a report with no note shows `step 7/10` and no `·`.
45. Accepted: 5 items, 3 linked runs reviewed, 1 item checked off by hand, 1 queued -> Overall contains `ACCEPTED 3 of 5 planned` and `1 checked off by hand`; marking a 4th run reviewed -> `ACCEPTED 4 of 5`; total 0 -> no `ACCEPTED` text.
46. Width: at desktop `px` 300 the row drops effort first, then tokens, and keeps `%` and cost; terminal at 70 cols shows no second line and line 1 ends with the context percent.
47. Terminal text equals Svg `alt` for the row, the totals line and the accepted line (conventions 10.2).
48. Privacy and tokens: no figure line contains prompt text; `session.usage` `slashCommands + mcpTools` is unchanged versus before this backlog (0 added tokens); no new tool, command or prompt section is registered.
49. A throwing usage reader (malformed `usage`) leaves tool, spawn and step results unchanged and still calls `next`.

### Decisions (closed 2026-10-12)
1. Context % denominator: static dated per-model window table `shared/windows.ts` with a `windowsJson` override (same pattern as prices).
2. Run totals scope: subagent runs only (totals = sum of rows).
3. Plan phase (d): dropped (Now Doing shows it).
4. Accepted-vs-planned: chip in the pane's Overall section.
5. Effort unknown: show nothing.
6. Run totals appear in the pane and `/mission status` only, not the band.
7. Elapsed clock: stops at `allDone`, restarts on a new plan.

## Parity build clarifications (builder, 2026-10-12)
- Default windows (as of 2026-10-11, https://code.claude.com/docs/en/model-config): 1M for Fable, Sonnet 5+, Haiku 5.5+, Opus 4.7+ and the bare aliases (they resolve to the 5.5 family) and any `[1m]`/`-1m` id; 200k for older models (Opus <= 4.6, Sonnet 4.x, Haiku < 5.5); unknown model = no percent (tokens form). Override with `windowsJson` (`{"sonnet":200000,"<model-id substring>":1000000}`).
- Context % is computed in `turn.step` and stored on `PetRun.ctxPct` (plus `peak`, `effort`, `effortSrc`); a `usage` that is not an object with finite non-negative counts is treated as no usage.
- Terminal row is two lines (line 1 as before, line 2 `ctx .. · .. tok · ~$..`); width comes from `bodyColumns`. Desktop row px is pane width minus 40; the effort chip drops at <= 300 px.
- Run-total clock: `mission.clock {epoch, frozen}`; `/mission plan <path>` and `plan clear` set `epoch`, `allDone` sets `frozen`, reopening clears it.
- Step note older than 120 s on a running agent: the desktop row text is dimmed (`V.text2`); terminal text is unchanged.
