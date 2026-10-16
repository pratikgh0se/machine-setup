# Spec: `usage` plugin (Burn Meter, Cache Clock, Compaction Alert)

Read `00-conventions.md` first. Board: `mod-ideas.html#idea-1` (Burn Meter), `#idea-2` (Cache Clock), `#swe-12` (Compaction Alert, no mockup; designed here). Version 1.0.0.

## 0. Purpose and mods
Shows how fast the user spends the 5-hour and weekly limits, how long the prompt cache stays warm and what a cold return costs, and how close the context is to auto-compact. Tokens spent by the plugin: zero.
Mods: `burn` (Carrot), `cache` (Pom), `compaction`. Band row (order): burn, compaction, cache. Panes: `cache-clock`. Commands: `/burn`, `/cacheclock`. Toasts: none (Heads-Up in `awareness` owns pace, cache and context toasts). Note: the installed `cache-tax` keeps its own band row and `/keepwarm`; this plugin does not replace it. Cache Clock FOLLOWS cache-tax: it reads cache-tax's configuration and observes its pings so both agree on the TTL (sections 2 and 11).

## 1. Burn Meter (`burn`)
**Behaviour.** One band segment: Carrot still, `5H` meter and percent, `7D` meter and percent, a pace chip, a forecast sentence. Carrot is "nibbled": `bites = round(sevenDay/25)` clamped 0..4 (71% -> 3), drawn as 3x3 px panel-coloured squares down the right edge of the still (as the mockup). `/burn` prints a text card: both windows, percent, reset time, pace, projected percent at reset, cost, sample count, last reading age.
**Data.**
- CONFIRMED: `session.measure` pushes `rateLimits[]` `{kind, percentUsed 0-100 (1 decimal), resetsAt ISO}` when a window moves a whole point (T:4415, input T:11095-11126, element T:11282-11297). `$.session.usage()` gives the same at start (T:2846, T:11704). `kind` is `five_hour`, `seven_day` or `spend_limit` (T:11287). `cost.usd` (T:10980).
- CONFIRMED but empty off a subscription or before the first response (T:11700-11726): then state EMPTY.
- UNVERIFIED: per-model weekly buckets (Opus/Sonnet): no type carries them. Not shown. UNVERIFIED: windows are exactly 5 h and 7 d long, so window start = `resetsAt - length`. If a reading contradicts it (percent falls by more than 20 points with the same `resetsAt`) the window's samples are discarded and state is LEARNING.
- Samples: `{t, five, seven}` appended on each changed reading; ring of 200 in memory; persisted per session `$.store['burn:samples:<sid>']` (thin to 1 per 5 min beyond 6 h old, drop beyond 7 d). On start merge all `burn:samples:*` (`$.store.keys()` T:3374) and keep samples whose window `resetsAt` matches the current one.
**Pace maths** (`shared/pace.ts`, pure). For a window with length L, reset R, now N, percent p, start S = R - L, elapsed E = N - S:
- `avgRate = p / E`. `recentRate` = least-squares slope of samples in the last `recentWindowMin` (needs >= 3 samples spanning >= 15 min), floored at 0.
- rate = `avgRate` for `seven_day`; for `five_hour` rate = `recentRate` when available else `avgRate`.
- `projected = p + rate * (R - N)`; `hitAt = N + (100 - p) / rate` when rate > 0, shown only if `hitAt < R`.
- State per window: LIMIT if p >= 100; LEARNING if E < minElapsed (10 min for 5H, 3 h for 7D); HOT if projected >= `hotAt`; PLENTY if projected < `plentyBelow`; else ON PACE. The chip shows the worse of the two windows (LIMIT > HOT > ON PACE > PLENTY > LEARNING); the forecast sentence names that window.
**States and strings** (terminal text; desktop `alt` identical):
- ON PACE: `On pace: ~{proj}% by reset {when}`. PLENTY: `Plenty left: ~{proj}% by reset {when}`. HOT: `At this pace: {weekly|5-hour} limit {when} (resets {when})`. LIMIT: `{weekly|5-hour} limit reached. Resets {when}.` LEARNING: `Gathering pace, {n} min of data`. EMPTY: `No plan limits reported` plus ` · cost ${usd}` when cost exists. Stale (no reading for 30 min): the whole segment is dim and ends ` · {n} min old`.
- `{when}` = local `HH:MM` if today else `Ddd HH:MM`. `{proj}` integer, capped at 999.
- Chip words: desktop `ON PACE`, `RUNNING HOT`, `PLENTY LEFT`, `LEARNING`, `LIMIT HIT`; terminal `ON PACE`, `🔥 HOT`, `🧊 PLENTY`, `LEARNING`, `⛔ LIMIT`.
- Meter fill = `round(p/100*12)` of 12 cells; fill colour accent, cells from index `round(0.8*12)` on warn, from `round(0.95*12)` on danger.
- `spend_limit` (gateway only): a third meter `$` after 7D when `showSpend` is true.
**Variants** (desktop px / terminal cells): full 560 / 110 (as wireframe); no forecast 400 / 62; meters only 250 / 40 (`🥕 5H 62% 7D 71% 🔥`); chip only 90 / 12 (`🥕 71% 🔥`).
**Wireframe (terminal)**
```
🥕 5H ███████░░░░░ 62%  7D █████████░░░ 71%  🔥 HOT · weekly limit Thu 14:00 (resets Fri 09:00)
```
Desktop: Carrot 32 px, then labels `5H` `7D` in Silkscreen 10 px, 12-cell meters, chip (bevelled tile with warn edge), forecast in Space Mono 10 px.
**Cadence.** Event driven by `session.measure`; a 60 s timer recomputes pace (time passes between readings). **Edge cases.** Two sessions open: samples merge; percent is account-wide. Clock jump back: samples with future `t` dropped. `resetsAt` missing: LEARNING. Percent > 100 on a spend limit: meter full, danger.
**Options.** `burn.hotAt` 100, `burn.plentyBelow` 60, `burn.recentWindowMin` 60, `burn.minElapsedFiveMin` 10, `burn.minElapsedSevenHr` 3, `burn.showSpend` true, `burn.bites` true, `burn.staleMin` 30.

## 2. Cache Clock (`cache`)
**Behaviour.** Band chip and a pane. Chip: Pom, a 12-cell countdown meter, `MM:SS` (or `1h02m`) and `warm`; cold: `cold · return costs ~$0.42`. Pane `cache-clock` (mockup 2): ring of 24 cells around the time, state word, "Saved by cache today", the TTL line, hit ratio of the last 20 requests, cold-write count and cost this session; Pom asleep (still at 55% opacity with `Z z`) when cold.
**TTL, never silent.** `resolveTtl()` order, and the pane's TTL line prints the source: (1) option `cache.ttl` = `5m|1h` fixed; (2) last `cache_ttl` from `classic.PreModelSwitch`/`PostModelSwitch` (T:7911, T:7825; only fires on a model switch; CONFIRMED but sparse); (3) learned from usage (below); (4) **follow cache-tax** (decision Q1, option `cache.followCacheTax` default true): when cache-tax is installed use its TTL, source word `cache-tax`, rendered `1h` without `~` because it is a configured value, not a guess; (5) `$.settings.read()` (T:3578) key `promptCacheTtl` (named only in the cache-tax README; key UNVERIFIED, any other value ignored); (6) assumed: `rateLimits` non-empty (subscription) -> `1h`, else `5m`, rendered `~1h` / `~5m` with the word `assumed`. Sources 3 and 6 render `~`. If a higher-priority source (2 or 3) disagrees with cache-tax's TTL the pane adds one line `cache-tax assumes 1h`. No statusline `prompt_cache.expires_at` is exposed to mods (UNVERIFIED, not in T), so expiry is computed.
**How Cache Clock reads cache-tax (CONFIRMED sources, one UNVERIFIED part).**
- *Installed?* `$.settings.read()` (T:3578; "nothing is filtered", T:3560) -> `enabledPlugins` has a key starting `cache-tax@` with value true (the user's file has `"cache-tax@claude-code-mods": true`). CONFIRMED. Re-read at `session.start` and on `config.set`. A cache-tax declared as `dependencies` in `plugin.json` is NOT used: cache-tax ships no `types/` contract and registers no `$.state` atoms and no `$.tool` (research `04-installed-mods.md`), so there is nothing typed to depend on, and a hard dependency would force-install it.
- *Its TTL.* cache-tax has no `userConfig` (its `plugin.json` declares none) and does not read `promptCacheTtl`; its TTL is the constant `TTL_MS = 60*60*1000` (`register.ts:4`, version 2.2.1). So `followCacheTax` resolves to `1h` while cache-tax is installed and enabled. Forward compatibility: if `pluginConfigs["cache-tax@<marketplace>"].options.ttl` (or `promptCacheTtl`) exists in settings and is `5m|1h`, it wins over the constant (the documented source is the userConfig in `~/.claude/settings.json` `pluginConfigs`; today it is empty). A cache-tax major version other than 2 is logged (`$.ui.log`) and the source falls back to (5)/(6).
- *Its keepwarm status.* cache-tax keeps keepwarm state in its own `$.store` and closure, which no other plugin can read (T:3345), so Cache Clock does NOT read it directly. UNVERIFIED but cheap: (a) pings are visible as `model.fork` events with `cache_read_input_tokens > 0` (CONFIRMED event, T:6855); the last ping time and `lastPing + 50 min` (cache-tax's `PING_AFTER_MS`) give `keepwarm: pinging · last ping 12 min ago · next ~38 min`; (b) an observer hook on `command.run` for `keepwarm` records `/keepwarm 6h|90m|2h30m|always|off` and derives `until HH:MM` (same duration grammar; whether another plugin's command reaches this observer is UNVERIFIED). Fallback when neither has been seen this session: `keepwarm: unknown (run /keepwarm status)`. The pane line is `KEEPWARM on · until 16:20 · last ping 12 min ago`, `KEEPWARM off`, or `KEEPWARM unknown`; when cache-tax is not installed the line is absent.
**Expiry model.** `lastReq` = `$.clock.now()` when a main-thread `turn.step` chain is entered (`agentId` undefined; the TTL counts from request start per `03-usage-and-cache.md`), or when a `model.fork` (T:6855) returns usage with `cache_read_input_tokens > 0` (keeps cache-tax pings visible). Subagent steps never count (their cache is separate). `expiresAt = lastReq + ttl`. COLD immediately after `session.compact` (T:10795), a model switch (T:7908 "a switch then forfeits it"), `session.end{reason:'clear'}`. UNKNOWN until the first main request. On `classic.SessionStart` with source `resume|fork`: if `prompt_cache_likely_expired` (T:11660) then COLD with cost `estimated_cache_write_usd` (T:11664, shown "est."), else WARM with `expiresAt = now + ttl - seconds_since_last_response`.
**Update points (F29).** The countdown and COLD/WARM state are published (atom, band, pane, status) at three events, not only on the tick: main-thread `turn.step` start (the stamp of `lastReq`, state turns WARM at once, even when the cold write is still being paid), main-thread `turn.complete`, and `session.measure`. A subagent step publishes nothing about the clock. Reading the clock between steps never shows COLD for a cache that a request has just started warming. A `session.compact` always forces COLD, including one that arrives while a main step is in flight: the compaction replaced the prefix, so the next request writes the new, smaller prefix and no countdown applies until that request starts (the next main `turn.step` start turns it WARM). A step that was in flight when the compaction finished does not turn the state back to WARM when it ends. COLD after compaction shows `return costs ~$X` for the post-compaction context (`tokensAfter` when the compact result gives it).
**Learning rule (CONFIRMED inputs: `usage` of the step result T:13530, fields T:6440-6444).** For main step n with gap g = start(n) - start(n-1) and previous input total P: if g > 5m+30s and cache_read >= 0.8 P then TTL >= g (set learned `1h`); if g > 5m and cache_creation >= 0.5 P and cache_read < 0.2 P then the entry expired at or before g: learned `5m` when g <= 65 min, learned `1h` when g > 65 min. Persist `$.store['cache:learned']` `{ttl, at}` with the model family; ignore values older than 7 days.
**Money.** Re-cache cost = `ctxTokens * writePrice(model, ttl) / 1e6`, `ctxTokens` = `context.tokens` (T:10952) else last input total; prefix `~`. Prices from `shared/prices.ts`: a table `[family, input, output, cacheRead, write5m, write1h]` per MTok with `asOf` and `source` fields, seeded from `savvy-progress register.tsx:299-305` (installed copy) and the multipliers in `03-usage-and-cache.md` (5m write 1.25x, 1h write 2x, read 0.1x; 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1). Prices are estimates; the pane footer prints `estimate (prices as of {asOf})` (decision Q10: static dated table, no network lookup); a `pricesJson` userConfig override (JSON, same row shape plus optional `asOf`) replaces rows by family and the footer then reads `estimate (prices as of {asOf}, custom)`. The builder re-checks the table against the pricing page on the build day. Unknown model: use the default row and add ` (default price)`.
**Savings today.** Per request: `saved = read * (input - cacheRead)/1e6 - creation * (write - input)/1e6`; sum for all requests (main and subagents) per local date in `$.store['cache:day:<YYYY-MM-DD>:<sid>']` `{saved, reads, writes, reqs}`; pane shows the sum over `cache:day:<today>:*`. Negative totals are shown with a minus. The cross-session total is computed outside render (at most once a minute, plus the own-session delta on each step) and published in the `cache` atom. Band and pane read it from there. On `session.start`, `cache:day` keys older than today are deleted.
**States.** UNKNOWN (`No request yet`), WARM, EXPIRING (remaining <= `expiringSec` 300; chip warn), COLD, and the chip is danger-free (cold is information, not an error). **Variants.** Full 300 / 56: `🍅 CACHE ██████████░░ 38:12 warm · saves $6.80 today`; short 150 / 26: `🍅 CACHE 38:12`; cold full: `🍅💤 CACHE cold · return costs ~$0.42`; cold short: `🍅💤 cold ~$0.42`.
Tiny variants (F28): warm tiny `🍅 38:12` is as wide as mascot plus the full countdown (never clipped to `38:`); cold tiny is `🍅💤 cold` (Z z plus the word), never a bare mascot. Whenever the row has room the chip uses the short or full variant (see 00-conventions s4 grow-back).
**Pane wireframe (terminal lines).**
```
CACHE CLOCK                         TTL 1h (cache-tax)
🍅 WARM  38:12 left   ring ████████████████████░░░░
KEEPWARM on · until 16:20 · last ping 12 min ago
Saved by cache today   $6.80     hit ratio 94% (last 20)
Cold writes this session  1  ~$0.42     estimate (prices as of 2026-10-11)
```
**Pane never truncates (F27).** Pane lines that carry a left and a right part (`CACHE CLOCK` | `TTL ...`, `Saved by cache today $x` | `hit ratio n% (last 20)`, `Cold writes this session n ~$x` | `estimate (prices as of ...)`) are laid out as a wrapping row: when both parts do not fit the pane width, the right part moves to its own line directly below the left part. No pane line ends in an ellipsis at any width, and every fact in the wireframe stays readable at 30 columns. The desktop ring Svg is never wider than the pane. The text of the lines (substrings used by s8) does not change.
**Cadence.** Tick 1 s while the pane is open or remaining <= 120 s, 5 s under 10 min, 30 s otherwise (only while the band chip is visible). **Edge cases.** Laptop sleep: wall clock passed `expiresAt` so COLD, correct. TTL source changes mid-session: recompute at once. Model with no price row: cost shows `n/a`. Context tokens unknown: cost `n/a`.
**Options.** `cache.ttl` auto, `cache.followCacheTax` true, `cache.keepwarmLine` true, `cache.expiringSec` 300, `cache.assumeSubscriptionTtl` 1h, `cache.assumeApiTtl` 5m, `cache.showSavings` true, `cache.pane.autoOpen` false, `pricesJson` "" (plugin-level userConfig, empty = built-in table).

## 3. Compaction Alert (`compaction`)
**Behaviour.** A band chip that appears when context fill passes `showFrom`: `CTX 78% · 12% to compact`; after a compaction a 60 s chip `COMPACTED 91% -> 23%`; counter `×2` after the first compaction in the session. `/burn` card also prints context. Toast: none here (Heads-Up owns "context > 80%").
**Data.** CONFIRMED: `session.measure.context` `{tokens?, window, percent?}` (T:10950-10970) with `changed` containing `context`; `$.session.usage({breakdown:'summary'})` (T:2846; "summary estimates locally, sends none") -> `context.breakdown.autoCompactThreshold` (T:10928) and `isAutoCompactEnabled` (T:10932). Refresh the threshold when the model changes, on `session.start`, and at most every 10 min. `session.compact` result `tokensBefore/tokensAfter` are optional (T:10795+): when absent use the last `percent` and the next reading.
**Maths.** `toCompact = (threshold - tokens) / window * 100` percentage points, floor 0. If auto-compact is off: no countdown, text `CTX 78%` only.
**States.** HIDDEN (< `showFrom` 60%), INFO (60-79), WARN (>= 80 or toCompact <= 15; warn colour), DANGER (>= 90 or toCompact <= 5), COMPACTED, UNKNOWN (no `percent` yet: hidden).
**Strings.** Terminal: `CTX ███████░░░░░ 78% · 12% to compact`, WARN `⚠ CTX ...`, DANGER `⛔ CTX ...`, off `CTX 78% · auto-compact off`, after `COMPACTED 91% → 23%`. Variants: 200 / 40, then `CTX 78%` 70 / 8. **Options.** `compaction.showFrom` 60, `compaction.warnAt` 80, `compaction.dangerAt` 90, `compaction.showCount` true.

## 4. UI placement
Band row (one `Svg` on desktop): `[burn][compaction][cache]`, priorities burn 1, compaction 2, cache 3 (drop cache first). Pane `cache-clock` opened by `/cacheclock` or the cache chip's `Button`. When there is no band (`-p`), `$.ui.status` shows `5H 62% 7D 71% HOT · cache 38:12`.
**Status line is a no-band fallback only (F30).** On every status write usage re-reads `$.session.surfaces()`: empty -> write `5H n% 7D n% WORD · cache ...` (refreshed on each measure, step and tick, so it equals what the band would show at that instant); not empty -> clear it once with `$.ui.status(undefined)` and write nothing. A status written while surfaces was empty is therefore never left behind when a surface attaches.

## 5. State and contract outline (`types/index.d.ts`)
```ts
export type UsageWindow = { kind: 'five_hour'|'seven_day'|'spend_limit'; percent: number; resetsAt?: number }
export type PaceState = 'learning'|'plenty'|'onpace'|'hot'|'limit'
export type PaceView = { five?: {state: PaceState; projected?: number; hitAt?: number}; seven?: {state: PaceState; projected?: number; hitAt?: number}; worst: PaceState; text: string }
export type CacheState = 'unknown'|'warm'|'expiring'|'cold'
export type CacheView = { state: CacheState; expiresAt?: number; ttl: '5m'|'1h'; ttlSource: 'option'|'event'|'learned'|'cache-tax'|'settings'|'assumed'; keepwarm?: {state: 'on'|'off'|'unknown'; untilAt?: number; lastPingAt?: number}; ctxTokens?: number; recacheUsd?: number; savedTodayUsd: number; hitRatio?: number; coldWrites: number; coldUsd: number }
export type ContextView = { percent?: number; toCompact?: number; autoCompact: boolean; compactions: number; lastCompact?: {before: number; after: number; at: number} }
declare module 'claude-code' { interface PluginState { usage: { limits: UsageWindow[]; pace: PaceView | null; cache: CacheView; context: ContextView | null; clock: number } } }
```
Store keys: `burn:samples:<sid>`, `cache:learned`, `cache:day:<date>:<sid>`, `cache:ttlEvent:<sid>`, `cache:keepwarm:<sid>` (derived `untilAt`, `lastPingAt` only). All `{v:1,...}`.

## 6. Hooks (all `.catch(next)`, all call `next`)
- `session.start`: register `/burn`, `/cacheclock`; load samples and learned TTL; first `usage()` read; start tick.
- `session.measure`: update `limits`, samples, `pace`; refresh `context`.
- `turn.step` (generator): main: stamp `lastReq`; after `yield* next(e)` read `result.usage` -> cache learning, savings, hit ratio. Subagent steps: savings only.
- `model.fork`: if usage has cache_read > 0 refresh `lastReq`, record `lastPingAt` (keepwarm inference), add to savings.
- `command.run{keepwarm}`: observer only (calls `next`, never answers); records the observed keepwarm window. `command.run{burn|cacheclock}` below answers its own commands.
- `session.compact`: after `next`, set cache COLD, record compaction.
- `session.end` (`reason:'clear'`): reset cache and compaction state; flush store.
- `classic.SessionStart` (resume/fork), `classic.PreModelSwitch`, `classic.PostModelSwitch`: seed/record/cold as above.
- `command.run{burn|cacheclock}`; `ui.render{AbovePrompt}`; `ui.render{Pane, requestId:'cache-clock'}`.

## 7. Performance and privacy
No process execution. Store writes: at most one per minute per key family, on `session.end`, and on learned-TTL change. Pace recompute is O(200). No prompt text, no file paths, no secrets; only percentages, token counts and dollars are kept.

## 8. Behaviour contract (code-blind tester)
Times relative to mocked `now`. `M(five,seven)` = a `session.measure` with `rateLimits` for the two windows, `changed:['rateLimits']`. "Band text" = text of the AbovePrompt tree on `terminal` (and equal to the `Svg` alt on `desktop`), 120 columns.
1. No `session.measure` yet: band contains no `5H`. With `rateLimits: []`: band contains `No plan limits reported`.
2. M(five 62% resets now+2h, seven 71% resets now+3d): band contains `5H`, `62%`, `7D`, `71%`; the 5H meter has 7 `█` and 5 `░`; the 7D meter 9 `█` and 3 `░` (terminal).
3. Seven_day p=71, resetsAt=now+3d (elapsed 4 d): state HOT, band contains `HOT` and `weekly limit`; the printed hit time is within 1 minute of now + 1 d 15 h 13 m (29 / (71/4 per day)).
3a. HOT boundary (decision Q2): a window whose projected percent at reset is exactly 100.0 is HOT; 99.9 with `plentyBelow` 60 is ON PACE; `burn.hotAt=120` turns the 100.0 case into ON PACE.
4. Five_hour p=10, resetsAt=now+4h (elapsed 1 h), no recent samples: state PLENTY, band contains `PLENTY` and `~50%`.
5. Five_hour p=30, resetsAt=now+4h: HOT; forecast contains `5-hour limit`.
6. Five_hour p=5, resetsAt=now+4h55m (elapsed 5 min): band contains `LEARNING` and `Gathering pace`.
7. Any window p=100: band contains `reached` and the reset time.
8. Chip shows the worse window: five PLENTY + seven HOT -> `HOT` and the weekly forecast.
9. Width 40 columns: still contains `71%` and never contains a line longer than 40 cells; at 24 columns contains `🥕` and a percent.
10. A second `session.measure` with an unchanged reading adds no sample (`$.store` value for `burn:samples:<sid>` keeps its length).
11. Seven_day reading with same `resetsAt` but percent dropping from 71 to 40: band shows `LEARNING`.
12. `/burn` returns text containing both percents, `resets`, and `samples`.
13. Cache: before any request the pane contains `No request yet`. After a main `turn.step` at t0 with option `cache.ttl='1h'`, at t0+38m12s the pane contains `21:48` and `WARM`.
14. TTL option `5m`: at t0+4m30s the pane contains `00:30`; at t0+6m it contains `COLD` and no countdown.
15. TTL line shows `TTL 1h` with option `1h`. Option `auto`, no event, nothing learned, `settings.read` mocked WITHOUT cache-tax: `rateLimits` non-empty -> `~1h` and `assumed`; `rateLimits: []` -> `~5m`.
15a. Option `auto`, no event, nothing learned, `settings.read` mocked with `enabledPlugins: {"cache-tax@claude-code-mods": true}` -> TTL line `TTL 1h (cache-tax)`, no `~`, for both `rateLimits` non-empty and `[]`; with `cache.followCacheTax=false` it falls to the rows of statement 15. cache-tax present but `enabledPlugins[...]` false -> as not installed.
15b. With cache-tax mocked in settings AND `pluginConfigs["cache-tax@claude-code-mods"].options.ttl = "5m"` -> `TTL 5m (cache-tax)`; a value `"90m"` is ignored (stays `1h`).
15c. A `classic.PostModelSwitch` event with `cache_ttl` `5m` beats cache-tax: TTL line `5m` with source `event` and the extra line `cache-tax assumes 1h`.
15d. Keepwarm line: a `model.fork` at t with `cache_read_input_tokens` 80000 -> pane contains `KEEPWARM on` and `last ping`, and the countdown extends to t + ttl; no fork and no observed command, cache-tax installed -> `KEEPWARM unknown`; an observed `command.run` `keepwarm` with args `2h` at t -> `KEEPWARM on · until` HH:MM equal to t + 2 h; observed `off` -> `KEEPWARM off`; cache-tax not installed -> no `KEEPWARM` text. The observer calls `next` exactly once and returns the beneath hook's result unchanged.
16. A subagent `turn.step` (agentId set) does not change the countdown.
17. `model.fork` returning `cache_read_input_tokens: 80000` at t1 sets lastReq = t1.
18. `session.compact` -> pane `COLD`; the next main step -> `WARM`.
19. `classic.SessionStart` source `resume` with `prompt_cache_likely_expired: true, estimated_cache_write_usd: 0.42` -> `COLD` and `0.42` and `est.`.
20. Learning (settings mocked without cache-tax): ttl option auto, steps at t0 (ctx 100k read 100k) and t0+20m (read 95k, creation 5k) -> pane TTL line `~1h` and source word `learned`. Steps at t0 and t0+20m with creation 90k, read 0 -> `~5m`.
21. Savings: one request model sonnet with the table's rates, read 100000 tokens -> saved = 100000*(input-read)/1e6 appears in `Saved by cache today` to 2 decimals; two sessions' keys for the same date are summed.
22. Re-cache cost for 200000 context tokens, 1h write price P -> pane shows `~$` + (200000*P/1e6, 2 decimals).
23. Unknown model id: cost reads `n/a` or ends `(default price)`; never throws.
24. Compaction: context percent 50 -> no `CTX` text; 78 with threshold such that toCompact=12 -> `CTX`, `78%`, `12% to compact`; 85 -> starts with `⚠`; 93 -> `⛔`.
25. Auto-compact off (`isAutoCompactEnabled:false`) -> text has no `to compact` and contains `auto-compact off`.
26. After `session.compact` (before 91, after 23) -> `COMPACTED 91% → 23%` for 60 s, then gone, and `×1` appears while context >= `showFrom`.
27. Every hook passes through: with the plugin loaded, a `tool.call` for Bash returns the engine's result unchanged; `ui.render` AbovePrompt with `hasSurvey:true` returns exactly the inner tree.
28. With `inner` = a sentinel tree from a hook beneath, the band tree contains the sentinel text and the usage row.
29. `maxRows: 2` (below `minBandRows`): the usage row is absent.
30. `mod.cache.enabled=false`: no `CACHE` text, no `/cacheclock` registered.

## 9. Acceptance
`claude plugin validate plugins/usage`; `tsc -p plugins/usage`; `claude plugin test` with the contract tests green (34 statements, both surfaces). Manual: (a) real session shows real percents within 1 point of `/usage`; (b) run one prompt, wait 5 minutes, chip counts down and the TTL line source reads sensibly; (c) `/compact` shows COMPACTED chip; (d) mascot probe (conventions 5.5) result recorded in the plugin README; (e) light and dark theme screenshots; (f) with `cache-tax` installed both rows show and agree on the TTL, and after a real `/keepwarm 1h` the KEEPWARM line turns `on` (confirms or refutes the UNVERIFIED observer and records the result in the plugin README).

## 10. Decisions (closed 2026-10-11)
1. **Q1 Cache TTL when unknown: follow cache-tax.** Cache Clock reads cache-tax's configuration and observed pings so both agree (cache-tax: 1h TTL, keepwarm pings every 50 min). Mechanism in section 2: installed-check via `$.settings.read()` `enabledPlugins` (CONFIRMED), TTL from `pluginConfigs["cache-tax@..."].options` if present else cache-tax's 1h constant (CONFIRMED from its source, 2.2.1), keepwarm status inferred from `model.fork` pings and an observed `command.run` for `keepwarm` (UNVERIFIED, fallback `KEEPWARM unknown`). cache-tax not installed: `1h` on a subscription, `5m` otherwise, shown `~` and `assumed`. cache-tax is an optional runtime relationship only: no `dependencies` entry (it has no typed contract).
2. **Q2 Burn Meter HOT when projected usage at reset >= 100%** (`burn.hotAt` 100). Tune after a week of data.

## 11. Effort and order
Burn Meter M, Cache Clock M (pane, learning, prices, cache-tax reader), Compaction Alert S. Order: `shared/pace.ts`, `prices.ts`, `band.tsx` -> Burn Meter -> Compaction Alert -> Cache Clock. Coexistence: with `cache-tax` installed the two cache displays agree on the TTL by construction (Cache Clock follows it) and Cache Clock adds the countdown, savings and learning cache-tax lacks; a learned or event TTL that contradicts cache-tax is shown with the extra line `cache-tax assumes 1h`.
- F32 (2026-10-15): the post-compaction COMPACTED chip obeys the F28 slot-fit rule at every width tier: full `COMPACTED 66% → 9%`, then `CMPCT 66%→9%`, then `→9%`, then glyph only; each variant's width is sized from its drawn text and never exceeds its slot.
