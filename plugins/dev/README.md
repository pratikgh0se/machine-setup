# dev

Makes the state of the code visible while agents work. Version 1.0.4. One band row above the prompt plus three panes. Spends no tokens; the only model-visible text is Typecheck Feedback's error lines appended to an edit result.

## Install

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install dev@bento
```

Requirements: `git` on PATH. PR Radar needs `gh` (signed in with `gh auth login`). Port Watch needs `lsof` (macOS). Typecheck Feedback uses `tsc` (project `node_modules/.bin/tsc`, else `npx --no-install tsc`), `ruff` and `eslint` when present. Mods whose tool is missing go quiet.

## Mods

| Mod | Chip / pane | Command |
|---|---|---|
| `git` | `🌿 main* ↑2 +3 ~5 ?1 · wt auth-flow` | none |
| `pulse` (Test Pulse) | `🧪 12 pass 3 fail · 2.3s · pytest` | `/pulse` |
| `coverage` | `📈 83.2% (+0.4)` | `/coverage` |
| `typecheck` | `⚠ TSC 2 errors · fed back to Claude` | `/typecheck` |
| `pr` (PR Radar) | `🔀 #412 ✅ checks · APPROVED`, pane `pr-radar` | `/prs [refresh]` |
| `ports` (Port Watch) | `🔌 2 ports (3000, 5173)`, pane `ports` | `/ports` |
| `diff` (Session Diff) | `📝 5 files +120 −34`, pane `changes` | `/changes [open <n>]` |

**Git chip.** Branch, `*` when dirty, ahead/behind (`↑ ↓`, only with an upstream), `+` staged, `~` unstaged, `?` untracked, `!` conflicts, and the linked-worktree name. Detached HEAD shows `HEAD@abc1234`. Refreshes after turns, edits and git-related shell commands, never on a timer, at most every `git_minRefreshSec`. Hidden outside a repo.

**Session Diff.** Files and line counts changed since the session started (relative to the session-start tree, not HEAD, and including edits made through shell commands). Pane `changes` lists files by churn with `A/M/D/R`, `+x −y`, a bar and a link that opens the file. `/changes` forces a fresh snapshot and prints up to 5 files.

**Test Pulse.** After a recognised test run in the main thread (pytest, vitest, jest, bun test, go test, cargo test, and similar), shows pass/fail/skip counts, duration and runner. After a later successful edit it appends `· stale (2 edits)`. A test that fails and then passes with no edit in between is tracked as flaky (`⚠ 1 flaky`). Only runner summaries are parsed; output of `cat`, `grep` and the like never counts.

**Coverage Delta.** After a test run, reads the newest coverage file under the repo root (`coverage/coverage-summary.json`, `coverage/lcov.info`, `lcov.info`, `coverage.xml`, `cobertura-coverage.xml`, `coverage.json`) and shows the total with the change versus the baseline. A drop beyond `coverage_warnDropPts` uses the warning look. `coverage_baseline`: `session-first` (first reading of the session) or `last-clean` (stored reading from a clean tree). No coverage file: the chip is hidden and `/coverage` explains how to produce one.

**Typecheck Feedback.** After each successful Write/Edit/NotebookEdit (including by subagents), runs the right checker on the touched file and appends its errors to that edit's result, so the model fixes them (`tc_mode: context`). Only error lines, never source lines, at most `tc_maxLines`; errors in files you touched come first; the same set is not repeated. When errors clear, one line `TYPECHECK: clean (tsc).` is added. `band` shows the chip only; `off` disables. If the checker exceeds `tc_timeoutSec`, the edit result returns unchanged and the outcome goes to the chip and the next edit.

**PR Radar.** Pane `pr-radar` lists each worktree with its PR number, checks (`pass`, `running`, `fail`, `none`), review state, `CONFLICT` when relevant, title and link. The band chip shows the current branch's PR. Uses one `gh pr list` call per cycle: every 60 s while checks run, 180 s when settled, with backoff on errors and 15 minutes after a rate limit; polling pauses after `idleMinutes` without input. One toast when checks on your own open PR turn failing: `PR #418 · CHECKS FAILING: <title>. Run /prs.` (`pr_toastOnFail`). Needs a GitHub remote.

**Port Watch.** Lists TCP listeners (`lsof`) that appeared since the session started, marking those whose working directory is inside the repo or its worktrees as yours, and stale after `ports_stale_min`. A STOP button exists only for your own listeners; it needs two presses within 5 seconds and sends `kill -TERM` only. Other listeners are listed, never killable. Only the short command name is shown, never the command line.

## Commands

| Command | Effect |
|---|---|
| `/prs` / `/prs refresh` | Open or refresh the PR Radar pane (refresh may bypass the interval but not the 60 s floor). |
| `/changes` | Open the Session Diff pane and print the top changed files. |
| `/changes open <n>` | Open file number `n` using `changes_openCommand` (default `open {path}`). |
| `/pulse` | Last 5 test runs, flaky tests, up to 5 failing test names. |
| `/coverage` | Total, delta, baseline, worst changed files (lcov only). |
| `/typecheck` | Current checker status and errors. |
| `/ports` | Open the Port Watch pane. |

## What you see

One band row in this order: git, pulse, coverage, typecheck, pr, ports, diff. When narrow, diff and ports drop first and typecheck last. Panes: `pr-radar`, `changes`, `ports`. Toasts: the PR failing-check toast only. Without a band, a status line such as `main* · 12 pass 3 fail · 2 tsc errors`.

## Hooks registered

| When | What it does |
|---|---|
| Session start | Probes `git`, takes the baseline snapshot of the tree and open ports, checks `gh auth status`, registers commands. |
| After each tool call | Marks git refresh; counts edits; parses test output; runs the type checker and appends its errors; schedules port scans after server-like commands. |
| End of a turn | Refreshes git, diff and ports. |
| Directory change | Re-resolves the repo. |
| Commands, band and pane rendering | Serve the commands and draw the UI. |

A disabled mod registers none of its hooks.

## Options

| Option | Default | Values | Effect |
|---|---|---|---|
| `mod_git_enabled` | `true` | boolean | Turn the Git chip mod on or off. Off registers no hooks and draws nothing. |
| `mod_diff_enabled` | `true` | boolean | Turn the Session Diff mod on or off. Off registers no hooks and draws nothing. |
| `mod_pulse_enabled` | `true` | boolean | Turn the Test Pulse mod on or off. Off registers no hooks and draws nothing. |
| `mod_coverage_enabled` | `true` | boolean | Turn the Coverage Delta mod on or off. Off registers no hooks and draws nothing. |
| `mod_typecheck_enabled` | `true` | boolean | Turn the Typecheck Feedback mod on or off. Off registers no hooks and draws nothing. |
| `mod_pr_enabled` | `true` | boolean | Turn the PR Radar mod on or off. Off registers no hooks and draws nothing. |
| `mod_ports_enabled` | `true` | boolean | Turn the Port Watch mod on or off. Off registers no hooks and draws nothing. |
| `minBandRows` | `4` | number | The band stays silent when the screen has fewer free rows than this. |
| `idleMinutes` | `30` | number | Background polling (gh, lsof) pauses when there was no user input for this long. |
| `git_minRefreshSec` | `5` | number | Minimum seconds between git status refreshes. |
| `git_untracked` | `normal` | `normal`, `no` | normal counts untracked files; no skips them (huge repos). |
| `git_showWorktree` | `true` | boolean | Append the linked worktree name to the git chip. |
| `changes_minRefreshSec` | `5` | number | Minimum seconds between tree snapshots. |
| `changes_maxRows` | `50` | number | Rows shown in the changes pane before '+N more'. |
| `changes_openCommand` | `open {path}` | string | Command run by /changes open <n>; {path} is the absolute file path. |
| `pr_enabled` | `true` | boolean | Fetch pull requests with gh. |
| `pr_intervalSec` | `60` | number | Base seconds between gh calls (never below 60). |
| `pr_maxPrs` | `100` | number | Maximum pull requests listed per gh call. |
| `pr_toastOnFail` | `true` | boolean | Raise one toast when checks on your own open PR flip to failing. |
| `pulse_includeSubagents` | `false` | boolean | Count test runs made by subagents. |
| `pulse_flaky` | `true` | boolean | Track tests that fail and then pass with no edits between. |
| `pulse_maxNames` | `20` | number | Maximum failing test names kept per run. |
| `coverage_baseline` | `session-first` | `session-first`, `last-clean` | session-first: first reading this session; last-clean: stored reading from a clean tree. |
| `coverage_warnDropPts` | `1.0` | number | A drop beyond this many percentage points uses the warning look. |
| `coverage_metric` | `lines` | `lines`, `statements` | Which istanbul total to read. |
| `tc_mode` | `context` | `context`, `band`, `off` | context: feed errors back to Claude; band: chip only; off. |
| `tc_tsc` | `true` | boolean | Run incremental tsc on edited TypeScript files. |
| `tc_ruff` | `true` | boolean | Run ruff on edited Python files. |
| `tc_eslint` | `true` | boolean | Run eslint on edited JS/TS files when the project has a config. |
| `tc_timeoutSec` | `20` | number | Seconds the edit result waits for tsc before returning unchanged. |
| `tc_maxLines` | `10` | number | Maximum error lines appended to a tool result. |
| `ports_enabled` | `true` | boolean | Watch listening ports started by agents. |
| `ports_stale_min` | `30` | number | Listeners older than this are marked stale?. |
| `ports_kill` | `true` | boolean | Show a two-step STOP button for listeners started by this session's agents. |

## Privacy

Command arguments, environment, `gh` tokens, source lines and file contents never enter state, toasts or logs. `git` and `gh` output is parsed and discarded; only derived numbers and short labels persist (test names and file paths are the most detail kept). Background load is bounded: about one `gh` call per minute, one `lsof` pair per 15 s with the Ports pane open, a few `git` calls per turn.

## Troubleshooting

- **No PR chip.** Not a GitHub remote, `gh` not signed in, no PR for this branch, or polling paused by `idleMinutes`.
- **No coverage chip.** Run the tests with coverage first; the file must be newer than the test run.
- **Typecheck says `tsc: n/a`.** No `tsconfig.json` found above the edited file, or `tsc` is not installed in the project.
- **First type check is slow.** The first incremental `tsc` run in a large project can take a minute; it finishes in the background.
- **Port Watch shows nothing.** It needs `lsof`; only listeners that started after the session began are shown as yours.
- **Chip cut off at 80 columns.** Known: the diff chip can be clipped mid-chip when the terminal is narrow.
- **Known gaps.** Two pre-existing `tsc` errors exist in the plugin's own source (`diff.tsx` setTimeout, `pulse.tsx` duplicate `'fail'`). STOP has no keyboard route, and `/coverage` with real data has not been exercised live.

## Common behaviour (all Bento plugins)

- **Setting options.** Options are plugin `userConfig` values. Set them in the `/plugin` menu, or in `~/.claude/settings.json` under `pluginConfigs["dev@bento"].options`. Keys use underscores (`mod_x_enabled`); the dotted spelling used in the specs (`mod.x.enabled`) is also read.
- **Disabled mods cost nothing.** A mod whose `mod_<id>_enabled` is `false` registers no hooks, draws nothing and adds no command.
- **Band row.** Bento plugins each draw at most one row above the prompt. The row stays hidden when fewer than `minBandRows` rows are free. Rows from other plugins that draw above the prompt without passing the rest of the chain on can hide Bento rows; disable that plugin to confirm.
- **Command names.** Each command registers under its bare name. If Claude Code or another plugin already owns the name, it registers as `dev-<name>` instead.
- **Terminal and desktop.** Every band text has an equivalent for terminal sessions (plain text and a few emoji glyphs) and for the desktop app (an SVG). Toasts carry text only; when a desktop surface is attached they omit emoji.
- **Estimates.** Any dollar figure is an estimate from a built-in price table with a date; it is labelled as such and can be replaced with `pricesJson` where that option exists.
- **Checking the install.** `claude plugin validate plugins/dev` (from a clone of this repo) must report no errors. Spec (normative, more detail): [specs/dev.md](../../specs/dev.md), shared rules in [specs/00-conventions.md](../../specs/00-conventions.md).
