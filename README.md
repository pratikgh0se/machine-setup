# machine-setup

**Bento** is a Claude Code setup you can install piece by piece: six small plugins (the `bento` marketplace) that add live panes, a status band above the prompt, toasts and guard rails; a weekly token-budget loop; hooks that preserve your thread across compaction; and macOS scripts that bootstrap a machine with all of it. Everything is plain files: TypeScript hooks, shell, Python (standard library only) and markdown specs. Version 1.0.0; see the [changelog](CHANGELOG.md).

## Screenshots

<!-- screenshots pending -->

| Plugin | Screenshot |
|---|---|
| `safety` | ![safety: protected-file denial and checkpoint list](docs/screenshots/safety.png) |
| `usage` | ![usage: band row with burn meter, context and cache clock](docs/screenshots/usage.png) |
| `awareness` | ![awareness: heads-up toast and phase band](docs/screenshots/awareness.png) |
| `agents` | ![agents: pets pane, delegation spend by model tier, mission board](docs/screenshots/agents.png) |
| `dev` | ![dev: git, tests, coverage and typecheck chips](docs/screenshots/dev.png) |
| `compact` | ![compact: coach chip and handoff flow](docs/screenshots/compact.png) |

## Quick start

Requires Claude Code (see [Requirements](#requirements)).

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install agents@bento
claude plugin install usage@bento
```

To set up a whole machine (hooks, settings, plugins, optional launchd jobs) instead of single plugins, clone the repo and run the bootstrap; start with `--dry-run`, which changes nothing:

```
setup/bootstrap.sh --dry-run
setup/bootstrap.sh --launchd     # also installs the scheduled jobs
```

See [`PREREQS.md`](PREREQS.md) and [`setup/README.md`](setup/README.md).

Install any subset: `safety`, `usage`, `awareness`, `agents`, `dev`, `compact` (all `@bento`). Restart Claude Code or start a new session, then try a command from the plugin's README, for example `/burn` or `/delegation status`. Options are set in the `/plugin` menu or in `~/.claude/settings.json`; each plugin README lists every option with its default.

## The plugins

Every plugin spends no tokens on its own (the few model-visible additions are listed in each README) and every part can be switched off with a `mod_<name>_enabled` option.

| Plugin | What it does | Commands |
|---|---|---|
| [`safety`](plugins/safety/README.md) | Refuses edits to `.env*`, lockfiles and other protected paths; takes private git-ref snapshots of your working tree after each turn so you can roll back. | `/protect`, `/checkpoint` |
| [`usage`](plugins/usage/README.md) | Band row with your 5-hour and weekly limits and pace, a prompt-cache countdown with the cost of a cold return, and a context-fill alert. | `/burn`, `/cacheclock` |
| [`awareness`](plugins/awareness/README.md) | Rate-limited toasts (cache expiring, long command, context, pace), a phase band (research, plan, build, verify, report), plan-checkbox progress and a focus timer that silences toasts. | `/focus`, `/headsup`, `/spec`, `/nowdoing` |
| [`agents`](plugins/agents/README.md) | Pane of running subagents ("pets"), a Review Queue for finished work, Delegation Guard (explicit model per subagent, spend by model tier, nesting guard, runaway warning) and Mission Board (plan progress across all agents). | `/pets`, `/agents-review`, `/delegation`, `/mission` |
| [`dev`](plugins/dev/README.md) | Git branch and changes, session diff, test results, coverage delta, type-check errors fed back to Claude, PR check status, listening ports. | `/prs`, `/changes`, `/pulse`, `/coverage`, `/typecheck`, `/ports` |
| [`compact`](plugins/compact/README.md) | Compact Coach (is now a good moment, and what it saves), two-step `/handoff` that writes a handoff file before you compact, a Resume loader, a nudge for the model to write its own handoff, and an optional Orchestrator prompt. | `/coach`, `/handoff`, `/orch` |

## Beyond the plugins

- **Token-budget loop** ([`tools/token-budget`](tools/token-budget/README.md)): a weekly launchd job that measures Claude Code's always-loaded token overhead, reports regressions and spend (including sessions with runaway or nested subagents), and proposes reversible fixes you apply one at a time.
- **Handoff hooks** ([`claude/hooks`](claude/settings.template.md)): a `PreCompact` hook that writes a deterministic handoff file and a `SessionStart` hook that re-injects it after compaction; plus guard hooks that block `git stash` and recursive scans from `/` or your home folder. Specified in [`specs/handoff-hooks-spec.md`](specs/handoff-hooks-spec.md).
- **Settings and CLAUDE.md templates** ([`claude/settings.template.md`](claude/settings.template.md)): a documented starting point for `~/.claude/settings.json` and a delegation-policy `CLAUDE.md`.
- **Machine bootstrap** (`setup/`, `launchd/`): scripts that check prerequisites, link or copy this setup into place, install launchd jobs and scan for secrets before export. See [`setup/README.md`](setup/README.md).

## How handoff works

Bento runs Claude Code with a 400k auto-compact window instead of 1M: cheaper turns, slower weekly-limit use, better quality, at the cost of more compactions. To make compaction safe, at 75% of the window (300k) the `compact` plugin asks the model to write its own handoff file (`~/.local/state/claude-handoffs/<session>-agent.md`: Goal, Decisions and why, Done, In progress, Dead ends, Exact next step). A `PreCompact` hook then writes the deterministic handoff around it, a `SessionStart` hook re-injects it after compaction, every compaction is logged to `health.jsonl`, and a nightly canary checks the chain. A broken handoff is loud (toast, band chip and a warning to the model); a merely reduced one is only logged. Full sequence: [ARCHITECTURE.md](ARCHITECTURE.md#handoff-lifecycle).

## Requirements

- Claude Code with plugin support (developed against 2.1.29x). The plugins themselves need nothing else.
- Per feature: `git` (safety, dev), `gh` signed in (dev PR Radar), `lsof` and `afplay` on macOS (dev Port Watch, awareness chime), `ccusage` (optional, status line and token-budget spend figures).
- The token-budget job, launchd templates and `setup/` scripts are macOS only. Full list: [`PREREQS.md`](PREREQS.md).

## Public and private overlay

This repository is the generic, public half of a personal setup. Everything specific to one person's machine (exact settings, repo lists, personal launchd jobs, vendored third-party skills, private notes tooling) lives in a private overlay repository applied on top. [`OVERLAY.md`](OVERLAY.md) lists what stays out and why, and which public template replaces each private file. Fork this repo and add your own overlay the same way; do not commit personal data here (`setup/secret-scan.sh` guards exports). Setup details: see [`setup/README.md`](setup/README.md).

Autosync commits this repo locally and never pushes it; after review you publish with `setup/publish.sh --push`.

## Documentation map

| Where | What |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Components, state locations, handoff lifecycle, testing and delegation models, with diagrams |
| [`docs/adr/`](docs/adr/README.md) | Architecture decision records |
| [`specs/`](specs/) | Behaviour contracts, one per plugin plus setup and handoff hooks |
| [`OVERLAY.md`](OVERLAY.md) | What stays in the private overlay and why |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Process and the checks you can run |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes |

## Specs

Behaviour is specified before it is coded, in [`specs/`](specs/): [conventions](specs/00-conventions.md) and one spec per plugin ([safety](specs/safety.md), [usage](specs/usage.md), [awareness](specs/awareness.md), [agents](specs/agents.md) with [Mission Board](specs/mission-board.md), [dev](specs/dev.md), [compact](specs/compact.md)). Where a plugin README and its spec disagree, the code and `plugin.json` are the truth.

## How it is tested

Plugins are tested with "code-blind" contract tests: one agent writes tests from the spec without seeing the code, another writes the code without seeing the tests, and a referee reads both and writes separate briefs when they disagree. The tests live in a separate private repository, so the public checks are `claude plugin validate` and `tsc`. The process, with its limits, is described in [`docs/code-blind-tdd.md`](docs/code-blind-tdd.md). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to run what you can.

## Known limitations

- Toasts carry text only (no buttons); every toast names the command to run.
- Cache expiry is computed from request times because Claude Code does not expose it; the TTL source is always shown.
- Several rows depend on live behaviour of the host that could not be verified everywhere; each plugin README says which.
- Another plugin that draws above the prompt without passing the rest of the chain on can hide Bento's rows.

## License

MIT. See [`LICENSE`](LICENSE).
