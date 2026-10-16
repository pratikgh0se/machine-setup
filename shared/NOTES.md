# shared/ notes (ambiguities resolved 2026-10-12)

- Added `checklist.ts` (not in 1.3's list): agents.md and mission-board.md name `shared/checklist.ts` (agent-pets checklist code as a pure reducer).
- `toastGlyph(surfaces, name='warn')`: spec gives only `(surfaces)`; the glyph name is a second arg. Returns '' when any surface is `desktop`.
- `createLimiter().offer(ports, id, text, {priority, timeoutMs})` takes `ToastPorts` first (`now`, `toast`, `readPeer`; see Ports pattern). Lower priority number = more important. Queued toasts show on `flush(ports)`; plugins call it from a timer or `turn.complete`. `peers` is a closed list (`awareness.headsup|focus`, `dev.toast`, `compact.coach`) because `$.state.get` refs must be literals in register.tsx for `claude plugin validate` (`PEER_REFS` maps names to refs for facades). Publish `lastShownAt` via the `onShown` callback.
- `composeRow` fits desktop (px) and terminal (cells) independently; `alt == text` holds whenever both fits pick the same variants (always when everything fits). The terminal row is one `<Text>` with no per-segment colour.
- `peers.d.ts` is a module of exported types (no ambient `declare module`), because redeclaring a plugin's own `PluginState` key would conflict. Use `PeerSlices<'self'>` in a plugin's `types/index.d.ts`.
- `prices.ts`: Sonnet 5 (non-.5) has no row in 12d s2, so it uses the Sonnet 5.5 row. Unknown models use the Opus 5.5 row with `isDefault: true`. Haiku 5.5 prompts over 100k use `HAIKU_OVER_100K` (pass `promptTokens`). Overrides (`pricesJson`) are keyed by family and replace all rows of that family. List prices as of 2026-10-11.
- `snapshot.ts` runs `cp -p` and `rm -f` through `proc.run` (allowed by safety.md s2). `proc.ts` `run(ports, ...)` returns `ok:true` whenever the command ran, whatever the exit code; use `isOk` for exit 0.
- Runtime: node (native TS stripping). `bun` is not installed.

## Ports pattern (2026-10-12)

`claude plugin validate` follows `$` only inside register.tsx and local functions, so no shared helper takes `$`. Each takes a small ports object of plain functions that register.tsx (or a local function there) builds from `$`. Verified in a scratch plugin before rollout; all six plugins validate.

- `band.tsx`: `renderBand(ports: {resolve(e)}, e, next, opts)` with `resolve: x => $.ui.resolve(x)`. Opts: `segments` (array or lazy function run after the gates), `minBandRows`, `buttons`, `reservePx`, `flat` (Svg directly in the column, no row Box), `tolerantNext` (a throwing `next` counts as engine-only), `viewportFallback` (`e.viewport.columns` when `bodyColumns` is unset). Pure pieces for plugins with their own gate order: `bandLine(t, surface, row|null, {flat, buttons})` and `bandStack(t, inner, line)` (agents uses these).
- `toast.ts`: `ToastPorts = { now(), toast(text, {timeoutMs}), readPeer(name) }`; `offer/flush/nextInMs(ports, ...)`. `readPeer` returns the peer slice value (literal `$.state.get` refs live in register.tsx, or via `PEER_REFS` on a facade). `toastWaitMs(ports, {now, lastShownAt, minGapMs, peers, respectQuiet})` is the bare gap + quiet rule (compact uses it with its own one-slot queue).
- `proc.ts`: `ProcPorts = { run(argv, init), now() }` (`run: (a, i) => $.process.run(a, i)`, `now: () => $.clock.now()`); `run`, `bindRunner`, `probeHost`, `createProcManager` take it.
- `testparse.ts`: `parseTestOutput(runner, output, command?)`, `parseBashTest` pass the command. Go: package-count form unless verbose (`-v`/`-test.v` in the command, or `--- PASS:` / `=== RUN` in the output; a lone `--- FAIL:` is not verbose; failing names still collected). `parseGo` and `isGoVerbose` are exported; with no package line a verbose-looking `--- X:` listing still parses per test.
- Left local: safety's checkpoint failure pauses and per-path throttle, compact's single-slot toast queue and hold timer (different semantics from the limiter), usage/awareness/dev tick logic.
