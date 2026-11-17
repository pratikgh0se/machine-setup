# Architecture

Bento is three things that share one repo: a marketplace of six Claude Code plugins, a few command-line tools that run on a schedule (token budget), and macOS scripts that install all of it on a machine. This page describes how the parts fit together. Behaviour is specified in [`specs/`](specs/); decisions are recorded in [`docs/adr/`](docs/adr/README.md).

## Components

```mermaid
flowchart LR
  subgraph repo["machine-setup repo (public)"]
    PL["plugins/ : safety, usage, awareness, agents, dev, compact"]
    SH["shared/ : common TypeScript, copied into each plugin"]
    HK["claude/hooks/ : Bash guards"]
    TL["tools/ : token-budget"]
    ST["setup/ : bootstrap, export, autosync, publish, scans"]
    LD["launchd/ : job templates"]
    TM["claude/ : settings and CLAUDE.md templates"]
  end
  OV[("private overlay repo")]
  CC["Claude Code on this Mac"]
  SH -->|sync-shared.ts| PL
  PL -->|"/plugin install name@bento"| CC
  HK -->|"installed to ~/.claude/hooks"| CC
  TM --> ST
  ST -->|bootstrap| CC
  ST -->|bootstrap --launchd| LD
  LD --> TL
  OV -->|merged over templates| ST
```

### Plugins (marketplace `bento`)

Six plugins, 26 mods. Every mod can be switched off with a `mod_<name>_enabled` option, and none calls a model API unless its spec says so ([ADR 0005](docs/adr/0005-mods-add-zero-model-context.md)). A plugin cannot import another plugin; cross-plugin reads go through published state atoms ([`specs/00-conventions.md`](specs/00-conventions.md)).

| Plugin | Version | Mod | What it does |
|---|---|---|---|
| `safety` | 1.0.3 | `protect` | Refuses writes to `.env*`, lockfiles and other protected paths. |
| | | `checkpoint` | Snapshots the working tree to a private git ref after each turn that changed files. |
| `usage` | 1.0.5 | `burn` | Burn Meter: 5-hour and weekly limits with pace. |
| | | `cache` | Cache Clock: prompt-cache countdown and cold-return cost. |
| | | `compaction` | Compaction Alert: context fill and compaction count. |
| `awareness` | 1.0.4 | `headsup` | Rate-limited toasts (cache, long command, context, pace, big output). |
| | | `nowdoing` | Phase band: research, plan, build, verify, report. |
| | | `spec` | Spec Tracker: checkbox progress of a plan or spec file. |
| | | `focus` | Focus Timer that silences Heads-Up toasts. |
| `agents` | 1.2.0 | `pets` | Pane of running subagents with model, task and clock. |
| | | `review` | Review Queue for finished subagent work. |
| | | `delegation` | Delegation Guard: explicit model per spawn, spend by tier, nesting guard, runaway warning. |
| | | `mission` | Mission Board: plan progress across all agents, and the `step` progress tool. |
| `dev` | 1.0.4 | `git` | Branch, dirty and ahead/behind chip. |
| | | `diff` | Session Diff: files and lines changed since session start. |
| | | `pulse` | Test Pulse: pass/fail counts from recognised test runners. |
| | | `coverage` | Coverage Delta against a baseline. |
| | | `typecheck` | Runs the right type checker after edits and feeds errors back to the model. |
| | | `pr` | PR Radar: PR and check status per worktree. |
| | | `ports` | Port Watch: listeners started during the session. |
| `compact` | 1.2.0 | `coach` | Compact Coach: is now a good moment to compact, and what it saves. |
| | | `handoff` | Two-step `/handoff` that writes a handoff file before you compact. |
| | | `resume` | Points the first prompt after compaction at the saved handoff. |
| | | `nudge` | Asks the model to write its own agent handoff near the compaction threshold. |
| | | `handoffalert` | Toast and band chip when a compaction's handoff is degraded. |
| | | `orch` | Orchestrator mode: a short system-prompt section about delegation. |

Versions come from each `plugins/<name>/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Each plugin's `hooks/register.tsx` is the only place that calls the host API; mods under `hooks/mods/` are wired from there. Code used by more than one plugin lives in [`shared/`](shared/) and is copied into `plugins/*/hooks/_shared/` by `scripts/sync-shared.ts` (edit `shared/`, never the copies).

### Machine hooks

Plain command hooks installed to `~/.claude/hooks/` and registered by the settings template ([`claude/settings.template.md`](claude/settings.template.md)):

| Hook | Event | Purpose |
|---|---|---|
| `no-git-stash.sh` | `PreToolUse` (Bash) | Blocks `git stash` for agents. |
| `no-root-walks.py` | `PreToolUse` (Bash) | Blocks recursive walks rooted at `/` or the home folder. |

### Tools

- **token-budget** ([`tools/token-budget`](tools/token-budget/README.md)): weekly probe of always-loaded token overhead (two Haiku calls), deterministic analysis against last week, spend breakdown including risky subagent sessions, and reversible proposals that only a human applies. Spec: [`docs/token-budget-spec.md`](docs/token-budget-spec.md).

### Scheduled jobs

Rendered from `launchd/*.plist.tmpl` by bootstrap with `--launchd` (placeholders `__LABEL_PREFIX__`, `__HOME__`, `__REPO__`; each job gets `HOME` and a `PATH` in its environment). Dependencies are listed in `launchd/deps.tsv`.

| Job (label suffix) | Schedule | Runs |
|---|---|---|
| `machine-setup-autosync` | daily 21:00 | `setup/autosync.sh` (installed only when an overlay exists) |
| `token-budget` | Mondays 09:00, plus once at load | `tools/token-budget/run.sh --catch-up` |

### Setup scripts

| Script | Role |
|---|---|
| `setup/bootstrap.sh` | Installs the generic setup onto `$HOME`: directories, hooks, merged `settings.json`, `CLAUDE.md`, plugins, optional launchd jobs and repo clones. Idempotent; backs up anything it overwrites to `~/.machine-setup-backup/<timestamp>/`; `--dry-run` changes nothing. |
| `setup/export.sh` | Captures the live machine. Personal values go only to the overlay; the public repo changes only for generic files that already exist in it, and never reverts one whose repo version is newer than the live copy (`skip (repo newer)`). Refuses without an overlay. |
| `setup/autosync.sh` | Daily pull, export and commit in both repos; pushes the overlay, holds the public push ([ADR 0012](docs/adr/0012-public-push-gate.md)). |
| `setup/publish.sh` | Shows unpushed public commits; with `--push`, leak-scans them and pushes. |
| `setup/leak-scan.sh` | Blocks personal values and secrets from the public repo (pre-commit hook, export, publish, CI). |
| `setup/secret-scan.sh` | Regex scan (plus gitleaks if installed) of the tree that would be committed, used on both repos. |

### Overlay merge

The overlay is a private repo that mirrors the public tree and is found through `MACHINE_SETUP_PRIVATE` (else a sibling directory; `none` opts out). Files at the same path replace the public ones; `claude/settings.json` is deep-merged over `claude/settings.template.json` (objects merge, permission arrays are unioned, other arrays replaced, `null` deletes a key). Details: [`OVERLAY.md`](OVERLAY.md) and [`specs/machine-setup-spec.md`](specs/machine-setup-spec.md) section 11.

## Data and state locations

Everything lives under the home directory; nothing is sent anywhere by the plugins themselves.

| Path | Written by | Contents |
|---|---|---|
| `~/.local/state/token-budget/` (mode 700) | token-budget | `ledger.jsonl`, `manifests/`, `proposals/`, `applied.jsonl`, `backups/`, `logs/`, `last-run.json` |
| `~/.local/state/machine-setup/` | autosync | `autosync.log`, launchd output |
| `~/.machine-setup-backup/<timestamp>/` | bootstrap | copies of files it replaced |
| `~/.claude/` | bootstrap | hooks, merged `settings.json`, `CLAUDE.md` |

## Handoff system

The handoff system (PreCompact and SessionStart hooks, recall index, nightly canary and reliability docs) moved to [lossless-handoff](https://github.com/pratikgh0se/lossless-handoff). Its repo holds the lifecycle, the state locations and the specs.

This repo keeps the 400k auto-compact window ([ADR 0001](docs/adr/0001-compact-window-400k-with-handoff.md)) and the `compact` plugin, which nudges the model and shows the handoff state. Run `setup/bootstrap.sh --handoff` to install lossless-handoff with `--no-nudge`, because the `compact` plugin already nudges.

## Public and private repos, autosync and publish

```mermaid
flowchart TD
  L["launchd 21:00: autosync.sh"] --> X["pull, export.sh, secret and leak scans"]
  X -->|scan fails| F["notify, nothing committed in either repo"]
  X -->|ok| CP["commit public repo locally"]
  X -->|ok| CO["commit overlay repo"]
  CO --> PO["push overlay"]
  CP --> H["public push held: notify 'N public commits awaiting review'"]
  H --> R["you run publish.sh and review the log and diffstat"]
  R --> PP["publish.sh --push: leak-scan the unpushed range"]
  PP -->|clean| GH["git push public repo"]
  PP -->|findings| NP["nothing pushed, exit 1"]
```

Personal values never enter the public repo: `export.sh` routes them to the overlay, the pre-commit hook (enable with `git config core.hooksPath setup/githooks`) and CI run `leak-scan.sh`, and `publish.sh --push` scans the range again before pushing. Without an overlay, autosync does nothing and export refuses ([ADR 0003](docs/adr/0003-public-repo-private-overlay.md)).

## Testing model

Behaviour is written down as numbered contract statements in `specs/` before it is coded. Contract tests are written from those statements only, by an agent that has not read the implementation, and live in a separate public repo, [pratikgh0se/bento-mods-tests](https://github.com/pratikgh0se/bento-mods-tests). Builders never read the tests; only pass/fail counts and failing test names flow back. When the two sides disagree, a referee that sees both code and tests diagnoses the gap and writes separate blind briefs to each side. `scripts/run-contract.sh <plugin>` copies a plugin to a temp directory and runs the contract suite against it. The public checks are `claude plugin validate`, `tsc` and `node scripts/sync-shared.ts --check`. See [`docs/code-blind-tdd.md`](docs/code-blind-tdd.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) and [ADR 0002](docs/adr/0002-code-blind-tests-in-separate-repo.md). The method has no published evaluation; it is documented as having worked here.

## Delegation model

The recommended working pattern (and the default text of the `orch` mod) is: the strongest model orchestrates, decides and reviews; a mid-tier model builds well-scoped units from precise briefs; a small model gathers and summarises; stronger subagents are for hard diagnosis only. Every subagent call names its `model`. Subagents never spawn subagents; one that needs more help returns to the orchestrator. The `agents` plugin enforces this softly by default: Delegation Guard warns (or denies, if configured) on a missing model and on nested spawns, warns on runaway subagents, and Mission Board shows plan progress across agents through a `step` reporting tool. The weekly token-budget report lists sessions that broke these rules. See [ADR 0004](docs/adr/0004-model-delegation-policy.md) and [ADR 0006](docs/adr/0006-subagent-nesting-guard.md).
