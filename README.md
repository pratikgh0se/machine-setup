# machine-setup

A Claude Code setup you can install piece by piece: six small plugins (the **Bento** marketplace) that add live panes, a status band above the prompt, toasts and guard rails; a weekly token-budget loop; hooks that preserve your thread across compaction; and macOS scripts that bootstrap a machine with all of it. Everything is plain files: TypeScript hooks, shell, Python (standard library only) and markdown specs.

<!-- screenshot: pets pane (running subagents with model chips, review queue) -->
<!-- screenshot: the band above the prompt (usage row: burn meter, context, cache clock; dev row: git, tests, typecheck) -->
<!-- screenshot: delegation pane (spend by model tier, nesting guard) -->

## Quick start

Requires Claude Code (see [Requirements](#requirements)).

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install agents@bento
claude plugin install usage@bento
```

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
- **Machine bootstrap** (`setup/`, `launchd/`): scripts that check prerequisites, link or copy this setup into place, install launchd jobs and scan for secrets before export. See [`setup/README.md`](setup/README.md) (to be written).

## Requirements

- Claude Code with plugin support (developed against 2.1.29x). The plugins themselves need nothing else.
- Per feature: `git` (safety, dev), `gh` signed in (dev PR Radar), `lsof` and `afplay` on macOS (dev Port Watch, awareness chime), `ccusage` (optional, status line and token-budget spend figures).
- The token-budget job, launchd templates and `setup/` scripts are macOS only. Full list: [`PREREQS.md`](PREREQS.md).

## Public and private overlay

This repository is the generic, public half of a personal setup. Everything specific to one person's machine (exact settings, repo lists, personal launchd jobs, vendored third-party skills, private notes tooling) lives in a private overlay repository applied on top. [`OVERLAY.md`](OVERLAY.md) lists what stays out and why, and which public template replaces each private file. Fork this repo and add your own overlay the same way; do not commit personal data here (`setup/secret-scan.sh` guards exports). Setup details: see [`setup/README.md`](setup/README.md).

Autosync commits this repo locally and never pushes it; after review you publish with `setup/publish.sh --push`.

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
