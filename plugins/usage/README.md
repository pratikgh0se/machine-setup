# usage

One band row that answers three questions: how fast am I spending my plan limits, is the prompt cache still warm, and how close is the context to auto-compact. Version 1.0.5. Spends no tokens and adds nothing the model sees.

## Install

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install usage@bento
```

## Mods

**Burn Meter** (`mod_burn_enabled`). Shows the 5-hour (`5H`) and weekly (`7D`) limits as 12-cell meters with percent, a pace chip and a forecast sentence, for example `5H 62%  7D 71%  HOT · weekly limit Thu 14:00 (resets Fri 09:00)`. Percentages come from the limits Claude Code reports; they match the built-in `/usage` to within a point.

- Pace chip: `ON PACE`, `PLENTY` (projected use at reset below `burn_plentyBelow`), `HOT` (projected use at reset at or above `burn_hotAt`), `LIMIT` (100% reached) or `LEARNING` (not enough elapsed time yet; see `burn_minElapsed*`). The chip shows the worse of the two windows.
- Projection: weekly uses the average rate since the window started; the 5-hour window uses the recent rate over `burn_recentWindowMin` minutes when at least 3 samples span 15 minutes.
- The mascot carrot is nibbled as the weekly limit fills (`burn_bites`). On API or gateway setups with a spend limit a third `$` meter appears (`burn_showSpend`). With no plan limits reported the segment says `No plan limits reported` and shows session cost.
- The segment dims and ends `· N min old` if no reading arrived for `burn_staleMin` minutes.

**Cache Clock** (`mod_cache_enabled`). A chip with a countdown to the end of the prompt-cache window: `CACHE ██████████░░ 38:12 warm · saves $6.80 today`, or `cache cold · return costs ~$0.42`. Pane `cache-clock` adds a ring, the TTL and where it came from, hit ratio of the last 20 requests, cold writes this session and savings today.

- TTL source, in order: your `cache_ttl` setting if fixed; the TTL reported on a model switch; learned from your own request pattern; the `cache-tax` plugin's TTL if installed (`cache_followCacheTax`); an assumption (`cache_assumeSubscriptionTtl` on a rate-limited plan, `cache_assumeApiTtl` otherwise), shown with `~`. The pane always names the source.
- The cache counts as cold right after a compaction, a model switch or `/clear`, and shows unknown until the first request. Expiry is computed from request times (Claude Code does not expose it), so it can be wrong after a hidden cache hit.
- The `KEEPWARM` line reflects the `cache-tax` plugin's keep-warm state when it can be inferred; otherwise `KEEPWARM unknown`. Absent if `cache-tax` is not installed.

**Compaction Alert** (`mod_compaction_enabled`). Appears once context fill passes `compaction_showFrom`: `CTX ███████░░░░░ 78% · 12% to compact`; warning colour from `compaction_warnAt`, danger from `compaction_dangerAt`; after a compaction `COMPACTED 91% → 23%` for a minute, then `×N` compactions this session (`compaction_showCount`). If auto-compact is off it shows `CTX 78% · auto-compact off`.

## Commands

| Command | Effect |
|---|---|
| `/burn` | Text card: both windows with percent and reset time, pace, projected percent at reset, session cost, sample count, age of the last reading, context fill. |
| `/cacheclock` | Opens or closes the `cache-clock` pane. |


## What you see

One band row, left to right: Burn Meter, Compaction Alert, Cache Clock. When the row is too narrow the lowest-priority chips shrink or drop (cache first). Pane: `cache-clock`. No toasts; the `awareness` plugin's Heads-Up owns the cache, context and pace warnings. Without a band (`claude -p`), a one-line status such as `5H 62% 7D 71% HOT · cache 38:12` is used instead, and cleared when a desktop surface attaches.

## Hooks registered

| When | What it does |
|---|---|
| Rate-limit/context measurements | Update limits, samples, pace and context fill. |
| Each model request | Stamps the cache clock; after it, reads token usage to learn the TTL and add up savings. |
| Cache-tax keep-warm pings | Counted as cache activity. |
| Compaction, `/clear`, model switch, resume | Set the cache cold/warm state and record compactions. |
| `/keepwarm` (observer only) | Notes a keep-warm window typed for the `cache-tax` plugin; never answers it. |
| Commands, band and pane rendering | Serve `/burn`, `/cacheclock` and draw the row. |

## Options

| Option | Default | Values | Effect |
|---|---|---|---|
| `mod_burn_enabled` | `true` | boolean | Show the 5-hour and weekly limits with pace and forecast |
| `mod_cache_enabled` | `true` | boolean | Show the prompt-cache countdown, the cold-return cost and the pane |
| `mod_compaction_enabled` | `true` | boolean | Show how close the context is to auto-compact |
| `minBandRows` | `4` | number | Below this many free rows the usage row stays silent |
| `mascots` | `auto` | `auto`, `on`, `off` | auto and on draw the Carrot and Pom stills; off draws the block mark instead |
| `pricesJson` | (empty) | string | Optional JSON replacing price rows by family, e.g. {"asOf":"2026-10-12","sonnet":{"input":2,"cacheRead":0.1,"write5m":2.5,"write1h":4}}. Empty uses the built-in table |
| `burn_hotAt` | `100` | number | A window is HOT when its projected use at reset reaches this percent |
| `burn_plentyBelow` | `60` | number | A window is PLENTY when its projected use at reset is below this percent |
| `burn_recentWindowMin` | `60` | number | Minutes of samples behind the 5-hour recent rate |
| `burn_minElapsedFiveMin` | `10` | number | Minutes of the 5-hour window before a pace is shown |
| `burn_minElapsedSevenHr` | `3` | number | Hours of the weekly window before a pace is shown |
| `burn_showSpend` | `true` | boolean | Show a third meter for a gateway spend limit |
| `burn_bites` | `true` | boolean | Nibble the Carrot as the weekly limit fills |
| `burn_staleMin` | `30` | number | Dim the meter when no reading arrived for this long |
| `cache_ttl` | `auto` | `auto`, `5m`, `1h` | auto follows events, learning, cache-tax and a subscription guess; or fix 5m or 1h |
| `cache_followCacheTax` | `true` | boolean | Use cache-tax's TTL when it is installed and no better source exists |
| `cache_keepwarmLine` | `true` | boolean | Show the cache-tax keepwarm status in the pane |
| `cache_expiringSec` | `300` | number | Warn colour when the cache has this many seconds left |
| `cache_assumeSubscriptionTtl` | `1h` | `5m`, `1h` | TTL assumed on a plan with rate limits when nothing else is known |
| `cache_assumeApiTtl` | `5m` | `5m`, `1h` | TTL assumed without rate limits when nothing else is known |
| `cache_showSavings` | `true` | boolean | Show what the cache saved today |
| `cache_pane_autoOpen` | `false` | boolean | Open the cache-clock pane once per session at the first request |
| `compaction_showFrom` | `60` | number | Show the context chip from this fill |
| `compaction_warnAt` | `80` | number | Warn colour from this fill |
| `compaction_dangerAt` | `90` | number | Danger colour from this fill |
| `compaction_showCount` | `true` | boolean | Append the number of compactions this session |

`pricesJson` example: `{"asOf":"2026-10-12","sonnet":{"input":2,"cacheRead":0.1,"write5m":2.5,"write1h":4}}` (USD per million tokens, replaces all rows of that model family).

## Privacy

Only percentages, token counts, dollar estimates and reset times are kept. Samples are stored per session under the plugin's own store (thinned after 6 hours, dropped after 7 days); daily savings keys older than today are deleted at session start. No prompts, paths or secrets are stored. No network calls, no processes.

## Troubleshooting

- **Row missing.** Fewer than `minBandRows` free rows, or another plugin is hiding the row (see Common behaviour).
- **`LEARNING` for a long time.** Pace needs 10 minutes of the 5-hour window and 3 hours of the weekly window before it shows a pace (`burn_minElapsed*`).
- **`No plan limits reported`.** You are not on a plan that reports limits, or no response has arrived yet in this session.
- **Cache says `~1h` but you expect 5 minutes.** The TTL is assumed; set `cache_ttl` to `5m` or `1h`.
- **The `COMPACTED` chip overflows its slot for about a minute.** Known cosmetic issue (not fixed).

## Common behaviour (all Bento plugins)

- **Setting options.** Options are plugin `userConfig` values. Set them in the `/plugin` menu, or in `~/.claude/settings.json` under `pluginConfigs["usage@bento"].options`. Keys use underscores (`mod_x_enabled`); the dotted spelling used in the specs (`mod.x.enabled`) is also read.
- **Disabled mods cost nothing.** A mod whose `mod_<id>_enabled` is `false` registers no hooks, draws nothing and adds no command.
- **Band row.** Bento plugins each draw at most one row above the prompt. The row stays hidden when fewer than `minBandRows` rows are free. Rows from other plugins that draw above the prompt without passing the rest of the chain on can hide Bento rows; disable that plugin to confirm.
- **Command names.** Each command registers under its bare name. If Claude Code or another plugin already owns the name, it registers as `usage-<name>` instead.
- **Terminal and desktop.** Every band text has an equivalent for terminal sessions (plain text and a few emoji glyphs) and for the desktop app (an SVG). Toasts carry text only; when a desktop surface is attached they omit emoji.
- **Estimates.** Any dollar figure is an estimate from a built-in price table with a date; it is labelled as such and can be replaced with `pricesJson` where that option exists.
- **Checking the install.** `claude plugin validate plugins/usage` (from a clone of this repo) must report no errors. Spec (normative, more detail): [specs/usage.md](../../specs/usage.md), shared rules in [specs/00-conventions.md](../../specs/00-conventions.md).
