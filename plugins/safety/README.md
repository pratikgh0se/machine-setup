# safety

Two guards for agent-driven editing. Version 1.0.3. Spends no tokens and adds nothing the model sees (apart from the text of a denial).

- **Protected Files** (`protect`): refuses edits to files that should not be hand-edited.
- **Auto-checkpoint** (`checkpoint`): after each turn that changed files, saves a snapshot of your working tree to a private git ref, without touching your branch, index or stash.

## Install

```
claude plugin marketplace add pratikgh0se/machine-setup
claude plugin install safety@bento
```

## Protected Files

A hook runs before every `Write`, `Edit`, `NotebookEdit` (and `MultiEdit` if your build has it), in the main thread and in every subagent. If the target path is protected, the call is refused and the model reads a message such as `Protected file: <path> (may hold secrets). Edit blocked by the safety plugin. ... To allow it once, ask the user to run: /protect allow <path> 10m`. You also get one toast per path per 30 seconds.

Default protected set (each group has a switch):

| Group | Matches |
|---|---|
| env (`protect_group_env`) | `.env` and `.env.*` anywhere, except the names in `protect_allow` (`.env.example`, `.env.sample`, `.env.template`, ...) |
| lockfiles (`protect_group_lockfiles`) | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`, `uv.lock` |
| vault (`protect_group_vault`) | `Boards/Engineering.md`, `.obsidian/**` and `Ledger/**` inside the Obsidian vault at `$OBSIDIAN_VAULT_PATH` (default `~/second-brain`). Irrelevant if you have no such vault; switch it off |
| extra | your own globs in `protect_globs`, plus anything added with `/protect add` |

Paths are resolved through symlinks, so a link to `.env` is caught (a hard link is not).

**Bash.** With `protect_bash` on, shell commands are also checked on a best-effort basis: redirects (`>`, `>>`), `tee`, `sed -i`, `cp`/`mv`/`install`/`ln`/`rsync` destinations, `dd of=`, and deletes or moves (`rm`, `unlink`, `shred`, `truncate`, `git rm`, `mv`) of protected files. Package-manager commands (`npm`, `pnpm`, `yarn`, `bun`, `cargo`, `poetry`, `uv`, `pip`) are always allowed so lockfiles can be regenerated. This is a guard against mistakes, not against an adversary: it does not see `find -delete`, `git clean`, globs, `$VAR` operands, directory operands such as `rm -r .`, or code run through `python -c` and similar. MCP write tools are not inspected unless you list them in `protect_mcpRules`.

Modes (`protect_mode`): `deny` blocks, `warn` lets the edit through and shows a toast, `off` disables.

## Auto-checkpoint

After a main-thread turn in which files changed (at most once per `checkpoint_minIntervalSec`), the plugin builds a tree from your working tree (tracked changes plus untracked files that are not ignored) using a temporary index file, commits it with `git commit-tree` and moves `refs/checkpoints/<session>` to it. HEAD, your branch, the real index, the stash and your files are never touched. No toast on success. An unchanged tree makes no new checkpoint.

- Files matching `checkpoint_exclude` (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `*.sqlite`, `*.kdbx` by default) are left out.
- Checkpoints are skipped, with one toast, when more than `checkpoint_maxUntracked` untracked files exist (add build output to `.gitignore`). A session stops checkpointing after `checkpoint_maxPerSession`. Refs older than `checkpoint_keepDays` are deleted when a session starts.
- Works in linked worktrees (each session has its own temporary index). Requires `git` and a git repository.
- The refs are local: `refs/checkpoints/` is not in the default push or fetch refspecs.

## Commands

| Command | Effect |
|---|---|
| `/protect` or `/protect status` | Mode, enabled groups, blocked count, last block, active allowances. |
| `/protect list` | The effective protected set and allowances with minutes left. |
| `/protect add <glob>` / `remove <glob>` | Add or remove your own globs (built-in groups cannot be removed here). Persisted. |
| `/protect allow <path\|glob> [10m]` | Allow a path for a limited time (default 10 minutes, maximum `protect_maxAllowMin`). Session only. The model cannot run this; only you can. |
| `/protect off` \| `warn` \| `deny` | Set the mode. Applies globally (all sessions), not per session. |
| `/checkpoint` | Count, last time, ref name and tree id. |
| `/checkpoint list` | The last 10 checkpoints: `#n hh:mm +add -del files`. |
| `/checkpoint diff <n>` | `git diff --stat` of checkpoint `n` against the working tree. |
| `/checkpoint now` | Take a checkpoint immediately. |
| `/checkpoint restore <id> [path]` | Prints the exact `git restore --source=refs/checkpoints/... -- <path>` command. It never runs it. |

Examples:

```
/protect allow package-lock.json 15m
/protect add secrets/**
/checkpoint diff 3
/checkpoint restore 3 src/app.ts
```

## What you see

No band row. One status line under the prompt (`checkpoint_statusLine`), for example `🔒 protect: deny · 2 blocked · 📸 #12 3 min ago`. Toasts: `FILE PROTECTED · Edit blocked: <path> is a secrets file.` (per path, at most every 30 s), and one `CHECKPOINT · FAILED` or `SKIPPED` message when a checkpoint cannot be taken.

## Hooks registered

| When | What it does |
|---|---|
| Before file-writing tool calls | Judges the path and denies if protected (also under `--dangerously-skip-permissions`, verified live). If the check itself fails it still blocks a literal `.env` write and otherwise lets the call through. |
| After tool calls | Marks the tree dirty; never changes a result. |
| End of a turn | Takes a checkpoint when dirty. |
| Session start | Registers commands, finds the vault, prunes old checkpoint refs. |
| Command run | Serves `/protect` and `/checkpoint`. |

## Options

| Option | Default | Values | Effect |
|---|---|---|---|
| `mod_protect_enabled` | `true` | boolean | Enable the protect mod (gates writes to protected paths). |
| `mod_checkpoint_enabled` | `true` | boolean | Enable the checkpoint mod (side-ref snapshots of the working tree). |
| `protect_mode` | `deny` | `deny`, `warn`, `off` | deny blocks the write, warn only shows a toast, off disables. |
| `protect_group_env` | `true` | boolean | Protect .env and .env.* (except example/sample/template). |
| `protect_group_lockfiles` | `true` | boolean | Protect package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, bun.lockb, Cargo.lock, poetry.lock, uv.lock. |
| `protect_group_vault` | `true` | boolean | Protect the Obsidian vault's Boards/Engineering.md, .obsidian/** and Ledger/**. |
| `protect_globs` | (empty) | string | Comma list of globs (*, **, ?), absolute, ~ or repo-relative. |
| `protect_allow` | `.env.example,.env.sample,.env.template,.env.*.example,.env.*.sample` | string | Comma list of basename globs never treated as secrets. |
| `protect_bash` | `true` | boolean | Best-effort check of shell writes, deletes and moves. |
| `protect_maxAllowMin` | `60` | number | Upper bound for /protect allow durations. |
| `protect_caseInsensitive` | `true` | boolean | Compare paths case-insensitively (macOS). |
| `protect_mcpRules` | `[]` | string | JSON list [{"tool":"mcp__x__y","arg":"path"}] of MCP tools to inspect. Empty by default. |
| `checkpoint_enabled` | `true` | boolean | Take checkpoints after turns that changed files. |
| `checkpoint_minIntervalSec` | `120` | number | Minimum seconds between checkpoints. |
| `checkpoint_keepDays` | `14` | number | Checkpoint refs older than this are deleted at session start. |
| `checkpoint_maxUntracked` | `2000` | number | Skip checkpoints when more untracked files than this exist. |
| `checkpoint_maxPerSession` | `500` | number | Stop checkpointing after this many in one session. |
| `checkpoint_exclude` | `.env*,*.pem,*.key,*.p12,id_rsa*,*.sqlite,*.kdbx` | string | Comma list of globs kept out of checkpoints. |
| `checkpoint_statusLine` | `true` | boolean | Show the one-line safety status under the prompt. |

## Privacy

- Denial messages and toasts show paths relative to the repo (or vault), never file contents.
- Allowances live in session memory only. Persisted data: your extra globs (`protect_*` store keys), the protect mode, and a per-session checkpoint counter.
- Checkpoint commits are authored `claude-checkpoint <checkpoint@localhost>` and live only in the local `.git`. They include untracked, non-ignored files that are not excluded, so a stray notes file in the repo ends up in `.git` objects. Extend `checkpoint_exclude` for anything sensitive.

## Troubleshooting

- **A legitimate edit is blocked.** Run `/protect allow <path> 10m`, or `/protect warn`.
- **Lockfile edits by the package manager fail.** They should not; commands starting with `npm`, `pnpm`, `yarn`, `bun`, `cargo`, `poetry`, `uv` or `pip` are always allowed. A direct redirect or `cp`/`sed -i` into a lockfile is denied by design.
- **`/checkpoint` says unavailable.** Not a git repo, or `git` cannot be run by the host. The status line then reads `needs host commands`.
- **No checkpoint after an edit.** The minimum interval (120 s) has not passed, the tree did not change, or the untracked-file cap was hit.
- **Delete old checkpoints now.** `git for-each-ref refs/checkpoints` then `git update-ref -d <ref>`.

## Common behaviour (all Bento plugins)

- **Setting options.** Options are plugin `userConfig` values. Set them in the `/plugin` menu, or in `~/.claude/settings.json` under `pluginConfigs["safety@bento"].options`. Keys use underscores (`mod_x_enabled`); the dotted spelling used in the specs (`mod.x.enabled`) is also read.
- **Disabled mods cost nothing.** A mod whose `mod_<id>_enabled` is `false` registers no hooks, draws nothing and adds no command.
- **Band row.** Bento plugins each draw at most one row above the prompt. The row stays hidden when fewer than `minBandRows` rows are free. Rows from other plugins that draw above the prompt without passing the rest of the chain on can hide Bento rows; disable that plugin to confirm.
- **Command names.** Each command registers under its bare name. If Claude Code or another plugin already owns the name, it registers as `safety-<name>` instead.
- **Terminal and desktop.** Every band text has an equivalent for terminal sessions (plain text and a few emoji glyphs) and for the desktop app (an SVG). Toasts carry text only; when a desktop surface is attached they omit emoji.
- **Estimates.** Any dollar figure is an estimate from a built-in price table with a date; it is labelled as such and can be replaced with `pricesJson` where that option exists.
- **Checking the install.** `claude plugin validate plugins/safety` (from a clone of this repo) must report no errors. Spec (normative, more detail): [specs/safety.md](../../specs/safety.md), shared rules in [specs/00-conventions.md](../../specs/00-conventions.md).
