# Bento

**Bento** is a set of add-ons for [Claude Code](https://claude.com/claude-code). It gives you six small plugins that add live panes, a status band above the prompt, toasts and guard rails; hooks that keep your thread alive when a long session compacts; a weekly token-budget report; and macOS scripts that rebuild the whole setup on a new Mac. Install one plugin or all of them. Everything is plain files: TypeScript hooks, shell, Python (standard library only) and markdown specs. Version 1.0.0; see the [changelog](CHANGELOG.md).

This repository is called `machine-setup`. The plugin marketplace inside it is called `bento`.

![Overview: Claude Code, six plugins, machine hooks, launchd jobs, public repo and private overlay](docs/img/overview.svg)

## Why

- **See what your agents are doing.** Subagents, plan progress, git state, test results, rate limits and the prompt cache are visible while you work, not buried in logs.
- **Keep long sessions cheap and safe across compaction.** A 400k auto-compact window keeps turns cheaper. A handoff file means the model keeps its goal, decisions and next step when the context is compacted.
- **Rebuild your setup on a new Mac in one command.** `setup/bootstrap.sh` installs hooks, settings, plugins and scheduled jobs from this repo plus your private overlay.

## The plugins

Every plugin spends no tokens on its own (the few model-visible additions are listed in each plugin README), and every part can be switched off with a `mod_<name>_enabled` option. The images below are illustrations drawn from the plugin READMEs, not screenshots. Real screenshots will replace them.

### usage

One band row answers three questions: how fast am I spending my plan limits, is the prompt cache still warm, and how close is the context to auto-compact.

![usage: burn meter, compaction alert and cache clock](docs/img/usage.svg)

| Command | What it does |
|---|---|
| `/burn` | Text card with both limit windows, pace, projection and session cost. |
| `/cacheclock` | Opens or closes the `cache-clock` pane. |

Details: [`plugins/usage`](plugins/usage/README.md)

### safety

Two guards for agent-driven editing. Protected Files refuses edits to `.env*`, lockfiles and other paths. Auto-checkpoint snapshots your working tree to a private git ref after each turn that changed files, without touching your branch, index or stash.

![safety: protected-file denial, toast, status line and checkpoint list](docs/img/safety.svg)

| Command | What it does |
|---|---|
| `/protect`, `/protect list` | Show the mode and the protected set. |
| `/protect allow <path> 10m` | Allow a path for a short time. Only you can run it, not the model. |
| `/checkpoint list`, `/checkpoint diff <n>` | List snapshots, or diff one against the working tree. |
| `/checkpoint restore <id> [path]` | Prints the `git restore` command. It never runs it. |

Details: [`plugins/safety`](plugins/safety/README.md)

### awareness

Tells you what is happening and what needs you, without noise: rate-limited toasts, a phase band (research, plan, build, verify, report), plan-checkbox progress and a focus timer that silences toasts.

![awareness: toasts, focus timer, phase band and spec tracker](docs/img/awareness.svg)

| Command | What it does |
|---|---|
| `/focus start [min]` | Start a focus block; toasts wait until it ends. |
| `/headsup mute 30m`, `/headsup status` | Silence or inspect toasts. |
| `/spec <path>` | Pin a plan or spec file to track its checkboxes. |
| `/nowdoing` | Print the current phase and sentence. |

Details: [`plugins/awareness`](plugins/awareness/README.md)

### agents

Everything about subagents: a pane of running agents ("pets"), a Review Queue for finished work, Delegation Guard (every subagent names a model, spend by model tier, a nesting guard, a runaway warning) and Mission Board (plan progress across all agents).

![agents: pets pane, review queue, delegation toasts and mission board](docs/img/agents.svg)

| Command | What it does |
|---|---|
| `/pets` | Show or hide the pets pane. |
| `/agents-review`, `/agents-review done <id>` | List the Review Queue, or mark items reviewed. |
| `/delegation`, `/delegation deny`, `/delegation nesting deny` | Show status, or set the model check and nesting guard mode. |
| `/mission`, `/mission plan <path>` | Open the Mission Board, or register a markdown plan. |

Details: [`plugins/agents`](plugins/agents/README.md)

### dev

Makes the state of the code visible while agents work: git branch and changes, session diff, test results, coverage delta, type-check errors fed back to Claude, PR check status and listening ports.

![dev: git, test, coverage, typecheck, PR and diff chips with the changes, pr-radar and ports panes](docs/img/dev.svg)

| Command | What it does |
|---|---|
| `/prs`, `/changes`, `/ports` | Open the PR Radar, Session Diff or Port Watch pane. |
| `/pulse`, `/coverage`, `/typecheck` | Print test, coverage or type-check status. |

Details: [`plugins/dev`](plugins/dev/README.md)

### compact

Compact at the right moment and keep the thread across it: a cost-aware Compact Coach, a two-step `/handoff` that writes a handoff file before you compact, a Resume loader, a nudge that asks the model to write its own handoff, an alert when a handoff is degraded, and an optional Orchestrator prompt.

![compact: coach chip, handoff flow and degraded alert](docs/img/compact.svg)

| Command | What it does |
|---|---|
| `/coach` | Full Compact Coach card. |
| `/handoff [slug]`, `/handoff go`, `/handoff cancel` | Write a handoff file, then compact only when you type `go`. |
| `/orch on`, `/orch off` | Orchestrator mode (needs `--yes`). |

Details: [`plugins/compact`](plugins/compact/README.md)

## Beyond the plugins

- **Token-budget loop** ([`tools/token-budget`](tools/token-budget/README.md)): a weekly launchd job that measures Claude Code's always-loaded token overhead, reports regressions and spend, and proposes reversible fixes that only you apply.
- **Handoff hooks** ([`claude/hooks`](claude/settings.template.md)): a `PreCompact` hook that writes a deterministic handoff file and a `SessionStart` hook that re-injects it after compaction, plus guard hooks that block `git stash` and recursive scans from `/` or your home folder. Specified in [`specs/handoff-hooks-spec.md`](specs/handoff-hooks-spec.md).
- **Handoff canary** ([`tools/handoff-canary`](tools/handoff-canary/README.md)): a nightly job that proves compaction plus handoff still works end to end.
- **Settings and CLAUDE.md templates** ([`claude/settings.template.md`](claude/settings.template.md)): a documented starting point for `~/.claude/settings.json` and a delegation-policy `CLAUDE.md`.
- **Machine bootstrap** (`setup/`, `launchd/`): scripts that check prerequisites, install this setup, install launchd jobs and scan for secrets before export. See [`setup/README.md`](setup/README.md).

## Install

### Plugins only (any platform Claude Code runs on)

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install usage@bento
claude plugin install agents@bento
```

Pick any of `safety`, `usage`, `awareness`, `agents`, `dev`, `compact` (all `@bento`). Restart Claude Code or start a new session, then try a command from the plugin's README, for example `/burn` or `/delegation status`. Options are set in the `/plugin` menu or in `~/.claude/settings.json`; each plugin README lists every option with its default.

### Whole machine (macOS)

Clone the repo and run the bootstrap. Start with `--dry-run`, which changes nothing:

```
setup/bootstrap.sh --dry-run
setup/bootstrap.sh --launchd     # also installs the scheduled jobs
```

Bootstrap installs hooks, a merged `settings.json`, `CLAUDE.md`, plugins and, with `--launchd`, the scheduled jobs. It backs up anything it overwrites to `~/.machine-setup-backup/<timestamp>/`. To add your own settings, repo lists and personal jobs, put them in a private overlay repo; the bootstrap finds it through `MACHINE_SETUP_PRIVATE` or a sibling directory. See [`OVERLAY.md`](OVERLAY.md), [`PREREQS.md`](PREREQS.md) and [`setup/README.md`](setup/README.md).

### Requirements

- Claude Code with plugin support (developed against 2.1.29x). The plugins themselves need nothing else.
- Per feature: `git` (safety, dev), `gh` signed in (dev PR Radar), `lsof` and `afplay` on macOS (dev Port Watch, awareness chime), `ccusage` (optional, status line and token-budget spend figures).
- The token-budget job, launchd templates and `setup/` scripts are macOS only. Full list: [`PREREQS.md`](PREREQS.md).

## How handoff works

Bento runs Claude Code with a 400k auto-compact window instead of 1M. Turns are cheaper, the weekly limit lasts longer and quality holds up better, at the cost of more compactions. To make compaction safe, the `compact` plugin asks the model to write its own handoff file at 75% of the window (300k), and again every 50k tokens. The file has six headings: Goal, Decisions and why, Done, In progress, Dead ends, Exact next step. Claude Code compacts at about the window minus a ~33k buffer (about 367k), so the nudge lands with margin. A `PreCompact` hook then builds a deterministic handoff around the agent file, a `SessionStart` hook injects it after compaction (up to three parts), and every compaction appends a line to `health.jsonl`. On every compaction the hook also asks Sonnet for a fresh summary of the recent conversation and adds it to the handoff (about $0.05 to $0.10 and 15 to 30 seconds per compaction); set `HANDOFF_SUMMARY=0` to turn it off, `HANDOFF_SUMMARY_MODEL` to change the model (default `sonnet`) or `HANDOFF_SUMMARY_TIMEOUT` to change the timeout in seconds (default 75). A broken handoff is loud (toast, band chip and a warning to the model); a merely reduced one is only logged. A nightly canary checks the whole chain.

What to expect: in a blind quiz after compaction (scores out of 100), the compaction summary alone scored 62.

Adding the agent handoff file raised it to 68.

Adding the fresh Sonnet summary raised it to 75 to 76.

Perfect recent memory, the ceiling, scored 85.

![Timeline from 0 to 400k tokens: nudge at 300k, re-nudge at 350k, compaction at about 367k, handoff injected](docs/img/handoff-timeline.svg)

Why this design: [ADR 0001](docs/adr/0001-compact-window-400k-with-handoff.md). Full sequence: [ARCHITECTURE.md](ARCHITECTURE.md#handoff-lifecycle).

## Public and private overlay

This repository is the generic, public half of a personal setup. Everything specific to one person's machine (exact settings, repo lists, personal launchd jobs, vendored third-party skills, private notes tooling) lives in a private overlay repository applied on top. [`OVERLAY.md`](OVERLAY.md) lists what stays out and why, and which public template replaces each private file. Fork this repo and add your own overlay the same way, for example `machine-setup-private`.

## Keeping it safe to publish

Personal values must never reach the public repo. `setup/export.sh` sends them to the overlay, a pre-commit hook (enable it with `git config core.hooksPath setup/githooks`) and CI run `setup/leak-scan.sh`, and `setup/secret-scan.sh` scans exports.

Autosync commits this repo locally and never pushes it; after review you publish with `setup/publish.sh --push`. Run `setup/publish.sh` with no arguments to see the pending commits and diffstat; `--push` leak-scans the unpushed range first and pushes only if it is clean ([ADR 0012](docs/adr/0012-public-push-gate.md)).

## How it is tested

Plugins are tested with "code-blind" contract tests: one agent writes tests from the spec without seeing the code, another writes the code without seeing the tests, and a referee reads both and writes separate briefs when they disagree. The tests live in a separate public repository, [pratikgh0se/bento-mods-tests](https://github.com/pratikgh0se/bento-mods-tests) (about 2,100 tests across nine suites). The process, with its limits, is described in [`docs/code-blind-tdd.md`](docs/code-blind-tdd.md).

CI in this repo ([`.github/workflows/leak-scan.yml`](.github/workflows/leak-scan.yml)) runs only the leak scan. `claude plugin validate` and `tsc` are local checks; [`CONTRIBUTING.md`](CONTRIBUTING.md) shows how to run them.

## Docs map

| Where | What |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Components, state locations, handoff lifecycle, testing and delegation models, with diagrams |
| [`docs/adr/`](docs/adr/README.md) | Architecture decision records |
| [`specs/`](specs/) | Behaviour contracts, one per plugin plus setup and handoff hooks. Where a plugin README and its spec disagree, the code and `plugin.json` are the truth. |
| [`OVERLAY.md`](OVERLAY.md) | What stays in the private overlay and why |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Process and the checks you can run |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes |

## Known limitations

- Toasts carry text only (no buttons); every toast names the command to run.
- Cache expiry is computed from request times because Claude Code does not expose it; the TTL source is always shown.
- Several rows depend on live behaviour of the host that could not be verified everywhere; each plugin README says which.
- Another plugin that draws above the prompt without passing the rest of the chain on can hide Bento's rows.

## License

MIT. See [`LICENSE`](LICENSE).
