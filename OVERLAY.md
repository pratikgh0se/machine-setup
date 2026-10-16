# Private overlay: what does NOT live in this repo

This repo is the public, generic part. Everything below stays in a private overlay repo that is applied on top. "Source" means the private machine-setup repo at the time of the split.

## How the overlay is found and applied
- Discovery (same in `setup/bootstrap.sh`, `setup/export.sh`, `setup/autosync.sh`): `MACHINE_SETUP_PRIVATE=<dir>`, else `../machine-setup-private`; `MACHINE_SETUP_PRIVATE=none` disables it; a value that is not a directory exits 2.
- Layout: a mirror of the public tree. `claude/settings.json` (merged over `claude/settings.template.json`: objects deep-merge, `permissions.allow|deny|ask` are unioned, other arrays are replaced, `null` deletes a key), `claude/CLAUDE.md` (replaces the template), extra `claude/{hooks,commands,skills,agents,output-styles}`, `claude/plugins.json`, `*.links.tsv`, `hook-deps.tsv`, `placeholders.txt`, `agents/`, `launchd/*.plist` + `deps.tsv` + `links.tsv`, `repos.tsv`, `repos.optional`, `dirs.txt`, `manual-steps.txt`, `config.env` (`LABEL_PREFIX=`; parsed, never sourced), `leak-denylist.txt`, `leak-allow.txt`.
- Without an overlay, bootstrap is a generic install, export refuses (exit 3) and autosync does nothing.
- `setup/leak-scan.sh` (pre-commit, export, CI) keeps personal values out of this repo; reviewed exceptions go in `.leak-scan-allow` or an inline `leak-scan: allow=<rule>` marker.

## Machine data
| Item | Why private |
|---|---|
| `repos.tsv`, `repos.optional` | Lists private repo names and clone URLs (about 99 entries). `repos.optional` only names two public upstreams but belongs with `repos.tsv`. |
| `lib/repos.sh` | Enumerates local checkouts and the notes vault to produce `repos.tsv`. |
| `lib/launchd_deps.py` | Maps personal launchd jobs to the repos they need. |
| `claude/settings.json` | Exact live settings: personal env, hook paths into private repos, the full permission list, `skillOverrides`, `deniedMcpServers`, `autoMode` text naming private repos. Public replacement: `claude/settings.template.json`. |
| `claude/CLAUDE.md` | Personal global instructions (notes-vault section, names). Public replacement: `claude/CLAUDE.md.template`. |
| `claude/plugins.json` | Exact marketplace and plugin list with personal identifiers. |
| `claude/placeholders.txt`, `claude/hook-deps.tsv`, `claude/commands.links.tsv`, `claude/skills.links.tsv` | Generated link and dependency maps containing personal paths. |
| Project-specific hooks | The four generic hooks (`precompact-handoff.py`, `postcompact-inject.py`, `no-git-stash.sh`, `no-root-walks.py`) are public, with project-specific wording removed. |
| `claude/skills/<private-project>-progress/` | Progress-board skill for a private project (SKILL.md, two HTML pages, two JSON files, render.py). |
| `launchd/<owner-prefix>.*.plist`, `launchd/deps.tsv`, `launchd/links.tsv` | All personal jobs: the private-project jobs (backup, cleanup, deps-sync, fork-sync, heal, ledger-reconcile, obs-inventory, obs-probe, quality-nightly, restore-verify, two ticks), the notes-vault jobs (agent-review, architect, close, health, inbox, morning, nightly, report, retrieval-eval, security, sprint-plan, sprint-sync, weekly), `ollama-serve`, and the personal copies of `token-budget` and `machine-setup-autosync`. Public replacements: `launchd/*.plist.tmpl`. |
| `.secret-scan-allow` personal entries | The public file keeps only the spec placeholder entry. |
| `PREREQS.md` personal parts | Tools for the private project and notes vault (uv, rtk, dcg, ollama, hermes, docker). The public file is generic. |
| Old private README and docs | Anything naming private projects. |

## Vendored third-party skills (`agents/`)
`agents/skill-lock.json`, `agents/skills-lock.json`, `agents/skills.all.txt`, and `agents/skills/` (108 skill directories captured from `~/.agents/skills`). Licensing is mixed (about 20 carry a LICENSE.txt, about 88 do not), so none are republished.

Recoverable upstream sources, from `agents/skill-lock.json` (bootstrap re-installs them with `npx skills add <source> -g -y --skill <name>`):
- `JuliusBrussee/caveman`: 20 skills (the caveman family).
- `vercel-labs/skills`: 1 skill.

The remaining skills are not in the lock file, so their upstream is not recoverable from this data. Many look like Anthropic or other vendor skills (docx, pdf, pptx, xlsx, skill-creator, mcp-builder, claude-api, frontend-design, webapp-testing, internal-comms, web-artifacts-builder, slack-gif-creator, theme-factory, brand-guidelines, canvas-design, algorithmic-art, ui-ux-pro-max, ui-styling). Keep the list in the overlay and re-fetch each from its publisher.

## History
The private repos keep their own history (author metadata with a personal email, session ids, cost figures). This repo starts from fresh history.
