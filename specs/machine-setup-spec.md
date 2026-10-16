# machine-setup: behaviour contract

Scope: `setup/bootstrap.sh`, `setup/export.sh`, `setup/autosync.sh`, `setup/secret-scan.sh`, `setup/leak-scan.sh`, `setup/lib/*` (scrub_settings.py, regex_scan.py, hookpaths.py, plugins.py, merge_settings.py, ...), `.secret-scan-allow`, `.leak-scan-allow`, `setup/githooks/pre-commit`, the generic templates (`claude/`, `launchd/*.plist.tmpl`), `OVERLAY.md`, README, and the private-overlay mechanism (section 11).
For a code-blind tester. Describes behaviour only. Platform: macOS (uses `sed -i ''`, `stat -f`, `plutil`, `launchctl`, `osascript`).

Layout of the public repo (generic, no personal value):
```
setup/            bootstrap.sh export.sh autosync.sh secret-scan.sh leak-scan.sh lib/ githooks/pre-commit
claude/           CLAUDE.md.template  settings.template.json  settings.template.md (documentation, never installed)  hooks/ (generic hooks)
launchd/          *.plist.tmpl  (generic job templates)
OVERLAY.md        what lives in the private overlay instead
PREREQS.md  README.md  .secret-scan-allow  .leak-scan-allow
```
The public tree has no `repos.tsv`, no `claude/settings.json`, no `claude/CLAUDE.md`, no `agents/` and no personal launchd plists; those exist only in a private overlay (section 11). Everything in sections 1-10 describes behaviour as amended by section 11; where they differ, section 11 wins.

## 1. Purpose
Capture a Mac's Claude Code setup and launchd jobs (`setup/export.sh`), scrub secrets, block secrets and personal values from entering the public repo (`setup/secret-scan.sh`, `setup/leak-scan.sh`), keep the repos current daily (`setup/autosync.sh`), and rebuild a new Mac (`setup/bootstrap.sh`). Copies not symlinks; `$HOME` is stored as the token `__HOME__`; secrets become `__SECRET:NAME__` placeholders. Personal values live only in the private overlay; the public repo is the code that runs plus generic templates.

## 2. Isolation: how a test sandboxes everything

- Every script resolves its repo root from its own location (`setup/` is the script dir; the public root is its parent). A test copies the whole public tree (at least `setup/`, `claude/`, `launchd/`, `.secret-scan-allow`, `.leak-scan-allow`, `.gitignore`) into a temp repo dir; scripts then operate on that copy. A temp public copy has no sibling `machine-setup-private` unless the test creates one next to it.
- Home: there is NO machine-setup-specific home override. Every path derives from `$HOME` (`$HOME/.claude`, `$HOME/.agents`, `$HOME/Library/LaunchAgents`, `$HOME/.local/state/...`, `$HOME/.machine-setup-backup/<ts>/`). The test must set `HOME` to a temp dir. With a temp `HOME`, export reads only that tree and bootstrap writes only under it (apart from the `claude` side effect in gap 2). The one environment variable that selects the private overlay is `MACHINE_SETUP_PRIVATE` (11.2); a test sets it explicitly (to a temp overlay dir, or to `none`).
- Temp work dir: `mktemp -d` (uses `$TMPDIR`), removed on exit.
- Commands found via `PATH` that a test should shim (put a shim dir first on `PATH`): `claude`, `launchctl`, `osascript`, `git` (rarely), `gitleaks` (if installed it is also run; shim it to exit 0 or make sure it is absent), `npx`, `gh` (only to be checked for presence), `plutil` (macOS builtin; works for real).
- Run bootstrap for real (non-dry) ONLY with `--no-repos --no-plugins` and without `--launchd`, or with stubbed `launchctl`/`claude`/`git`, `npx`. Otherwise it can load real launchd jobs or clone repos.

### Testability gaps
1. `launchctl` (print/bootstrap/bootout) is called by bare name and is not abstracted: stub via PATH shim. In `--dry-run --launchd` only `launchctl print` is called; without a shim the real one is queried (read-only) and, on a fake HOME, labels such as `com.machine-setup.*` may be genuinely loaded on the dev machine, which would make results machine-dependent. Always shim.
2. `claude plugin marketplace list` and `claude plugin list` are executed even in `--dry-run` (ruled acceptable: read-only). The script itself writes nothing under HOME in dry-run, but the real `claude` binary may create `~/.claude.json` and `~/.claude/backups/` in the fake HOME (observed). Tests MUST shim `claude` via PATH to assert "nothing written".
3. `autosync.sh` notification uses `osascript` by bare name: stubbable via PATH. Its log goes to `$HOME/.local/state/machine-setup/autosync.log` (HOME-relative, so sandboxable).
4. `git pull --ff-only` and `git push` in autosync need a real remote: use a local bare repo as `origin` with an upstream branch (one per repo, 11.7).
5. `export.sh` always runs `secret-scan.sh` and `leak-scan.sh`; the repo enumeration (`repos.tsv`, overlay only) enumerates `$HOME/CodeBase/*/` (a fake HOME with none yields an empty `repos.tsv`).
6. `plutil -lint` (bootstrap launchd step) needs macOS; not stubbed.
7. `npx` network work (`npx skills add`) only happens in non-dry runs with an overlay `agents/skill-lock.json`; shim `npx`.

## 3. bootstrap.sh

Usage: `setup/bootstrap.sh [--dry-run|-n] [--no-repos] [--all-repos] [--launchd] [--no-plugins] [-h|--help]`.
Launchd is OPT-IN: without `--launchd` step 7 does nothing but print `  skipped (pass --launchd to install launchd jobs)`; with `--launchd` it processes the job templates and any overlay jobs (11.4). (The former `--no-launchd` flag is withdrawn: it is now an unknown flag.)
Unknown flag: message `unknown flag: <x>` on stderr, exit 2. `-h`/`--help`: prints the header comment lines 2-7 of the script, exit 0, no side effects.

### 3.1 Output (stdout), in order
First line: `machine-setup bootstrap  HOME=<HOME>  (DRY RUN)` (the `(DRY RUN)` suffix only with `--dry-run`). Second line: `  overlay: <path>` or `  overlay: none (generic install)` (11.2).
Then sections, each preceded by a blank line, whose headings start with these exact numbered prefixes in this order (text after the prefix may add a parenthetical hint):
```
== 1. prerequisites (see PREREQS.md)
== 2. runtime directories
== 3. repositories
== 4. ~/.claude files
== 5. ~/.agents skills
== 6. Claude plugins
== 7. launchd jobs
== summary
```
Line formats (two-space indent; in dry-run, action lines are prefixed `[dry-run] ` after the indent):
- Prereqs, for each of `git python3 claude node npx gh ccusage jq rsync`: `  ok       <bin>` or `  WARN: missing  <bin>  (install per PREREQS.md)`.
- Dirs: `mkdir -p <path relative to HOME>` for each missing dir of the public default list `.local/state/claude-handoffs .claude/hooks .claude/skills .claude/commands .local/state/token-budget .local/state/machine-setup Library/LaunchAgents .agents/skills`, plus the overlay `dirs.txt` entries (11.4).
- Repos (from the OVERLAY's `repos.tsv`, columns path, kind, origin, branch, main; `__HOME__` expanded): `present  <name>` if `<dest>/.git` exists; kind `worktree` is skipped silently (counted in the summary); kind `local-only` not present goes to the Skipped list; names listed in the overlay `repos.optional` are skipped (Skipped list) unless `--all-repos`; otherwise `git clone <origin> <rel dest>` (action line). `--no-repos`: `  skipped (--no-repos)`. No overlay `repos.tsv`: `  skipped (no overlay repos.tsv)`.
- ~/.claude files: the effective file set (11.4: public templates and generic files merged with the overlay), rendered (11.5), excluding `plugins.json`, `placeholders.txt`, `hook-deps.tsv`, `*.links.tsv`, `*.template.md`, `.DS_Store`. Per file: `unchanged  .claude/<rel>` if the destination is a regular (non-symlink) file byte-identical to the rendered source; `overwrite (backup) .claude/<rel>` if the destination exists and differs (or is a symlink); `install    .claude/<rel>` if absent. Symlinks from the merged `claude/skills.links.tsv` and `claude/commands.links.tsv` (`name<TAB>target`): nothing printed if the link already points to the target; else `symlink    <rel> -> <target>` or `relink (backup) <rel> -> <target>`.
- Hook-script deps (merged `claude/hook-deps.tsv`, kind `repo:<name>`): nothing if the path exists; `hook script <rel> will come from repo <name> (cloned in step 3)` if `<name>` is a `kind=repo` row in the overlay `repos.tsv`; else `WARN: hook script missing: <rel> (repo <name> is not cloneable)` and the final exit code becomes 1.
- agents (overlay only): `(best-effort) npx --yes skills add <src> -g -y --skill <names...>` per source in the overlay `agents/skill-lock.json`; `agents/skills/` rsync line. Without overlay agents data the step prints `  skipped (no overlay agents data)`.
- Plugins (from the merged `claude/plugins.json`; ids ending `@builtin` and not-installed entries ignored): `marketplace present: <name>` / `claude plugin marketplace add <arg>   (<name>)`; `plugin already installed: <id>` / `claude plugin install <id>   (state: enabled|disabled)`. Existing state is read from `claude plugin marketplace list` (word match on name) and `claude plugin list` (lines ending in `id@marketplace`). `--no-plugins`: `  skipped (--no-plugins)`. No `plugins.json` anywhere: `  skipped (no plugins.json)`.
- launchd (only with `--launchd`; rows of the merged `launchd/deps.tsv`: label, required path, repo, needs; `#` and blank lines ignored; plists from public `launchd/*.plist.tmpl` and overlay `launchd/<name>.plist`, 11.4), per job:
  - `plutil -lint` failure on the rendered plist: `WARN: plutil -lint failed: <label>`, exit 1, job skipped.
  - Required path (with `__HOME__` expanded) missing, and (in dry-run only) its repo not a `kind=repo` row: `SKIP     <label>  (needs <path with ~>...; not present)` and a "launchd skipped: <label>" entry in the Skipped list. In dry-run, a missing path whose repo is listed in the overlay `repos.tsv` counts as OK ("will be cloned").
  - Loaded (`launchctl print gui/<uid>/<label>` exit 0) and rendered plist byte-identical to `~/Library/LaunchAgents/<label>.plist`: `  <label>: loaded, unchanged` (printed identically in dry and real runs, no `[dry-run]` prefix), nothing else done.
  - Loaded but file differs: `<label>: loaded, plist differs -> backup, bootout, copy, lint, bootstrap`.
  - Not loaded: `<label>: not loaded, plist installed -> bootstrap` (file identical), `<label>: not loaded, plist differs -> backup, copy, bootstrap` (file exists and differs), or `<label>: not loaded, not installed -> install, bootstrap`.
  - Overlay `launchd/links.tsv` (`link<TAB>target`) symlinks are created first with the same link rules.
- Summary: if the merged placeholder names are non-empty, `  Secret placeholders to fill in ~/.claude/settings.json:` followed by `    __SECRET:<NAME>__` per line, else `  Secret placeholders: none (settings.json has no secret values)`. Then `  Manual steps still needed:` with the single generic bullet `    - claude login (credentials are never stored in this repo)` plus the overlay `manual-steps.txt` lines. Optional `  Skipped / not recoverable:` list. `  Backups of overwritten files: <dir>` only if a backup dir exists. `  DRY RUN complete: nothing was changed.` in dry-run.

### 3.2 Side effects and exit code
- Real run: files installed with the source file's mode; existing destinations that would be overwritten are first copied to `$HOME/.machine-setup-backup/<YYYYmmdd-HHMMSS>/<path relative to HOME>`; step 2 dirs are created; `~/.local/state/token-budget` is chmod 700.
- `--dry-run`: no file/dir/symlink is created, changed or removed under `$HOME` by bootstrap itself, no backup dir, no `launchctl bootstrap/bootout`, no clone, no `claude plugin install/add`, no rsync, no `npx`. (Normative: the script itself writes nothing; the real `claude` binary may create `~/.claude.json`, see gap 2, hence tests shim it.)
- Exit code: 0 normally; 1 if any WARN-with-error occurred (clone failed, plugin/marketplace install failed, plutil lint failed, launchctl bootstrap failed, hook script missing and not cloneable, unresolved placeholder); 2 for an unknown flag or an overlay/config error (11.2, 11.5). Missing prerequisites alone only WARN and do not change the exit code.

## 4. export.sh

Run from anywhere; operates on its own public repo dir and the overlay (11.6). `set -euo pipefail`; exit non-zero if any step fails, in particular if a final scan fails. Idempotent: re-running with an unchanged machine produces byte-identical contents in both repos (no diff in `git status`). Usage: `setup/export.sh [--dry-run|-n]`.

Stdout sections in order: `== overlay`, `== claude`, `== agents (~/.agents)`, `== launchd`, `== repos`, `== secret scan`, `== leak scan`, with indented summary lines (11.6).

Inputs (all under `$HOME`): `.claude/settings.json`, `CLAUDE.md`, `keybindings.json`, `hooks/`, `agents/`, `output-styles/`, `commands/`, `skills/`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`; `.agents/.skill-lock.json`, `.agents/skills/`, `skills-lock.json`; `Library/LaunchAgents/<LABEL_PREFIX>.*.plist`; `CodeBase/*/` git repos; symlinks recorded in the overlay `launchd/links.tsv` when present.

Outputs (all personal values go to the OVERLAY, never to the public repo; 11.6): overlay `claude/settings.json` (diff against the template), `claude/placeholders.txt` (sorted unique placeholder names, one per line; empty file if none), `claude/CLAUDE.md`, `claude/keybindings.json`, `claude/hooks/`, `claude/agents/`, `claude/output-styles/` (mirror, only items not in the public tree; `__pycache__`, `*.pyc`, `.DS_Store` excluded; a source dir that is absent removes the overlay dir; every text file has `$HOME` rewritten to `__HOME__`), `claude/commands/`, `claude/skills/` (real files/dirs only, `skills/synced` excluded), `claude/commands.links.tsv`, `claude/skills.links.tsv` (`name<TAB>target`, sorted, HOME as `__HOME__`), `claude/hook-deps.tsv` (`__HOME__/path<TAB>claude|repo:<name>|other`, sorted) plus copies of referenced `~/.claude/**` scripts outside `hooks/`, `claude/plugins.json` (marketplaces and plugins, sorted, deterministic), `agents/skill-lock.json`, `agents/skills-lock.json`, `agents/skills/` (skills not in the lock, no `canvas-fonts`), `agents/skills.all.txt`, `launchd/<name>.plist` (HOME as `__HOME__`, prefix as `__LABEL_PREFIX__`; old plists removed first), `launchd/deps.tsv` (header `# label<TAB>required_path<TAB>repo<TAB>needs`), `launchd/links.tsv`, `repos.tsv` (rows `path<TAB>kind<TAB>origin<TAB>branch<TAB>main_repo`, kind `repo|worktree|local-only`, sorted in C locale, `machine-setup` and `machine-setup-private` excluded, detached HEAD branch `(detached)`).

`claude/plugins.json` and the agents skill locks are exported in full (no diff against the public tree).

Exit 0 only if all scans pass.


## 5. setup/lib/scrub_settings.py (settings scrubber)
`setup/lib/scrub_settings.py IN OUT HOME [SECRETS_LIST_OUT]`. Rules, applied recursively:
- Inside any object under a key named `env`, `headers` or `environment`, a string value whose KEY matches `(?i)key|token|secret|passw|bearer|credential|auth|cookie`, or whose VALUE matches a known secret shape (`sk-...`, `ghp_/gho_/github_pat_...`, `xox?-...`, `AKIA...`, `eyJ...`., `Bearer <8+ chars>`), is replaced with `__SECRET:<NAME>__`. A value already starting `__SECRET:` is left unchanged.
- Anywhere else, a string value matching a known secret shape is also replaced.
- `<NAME>` = the key path joined by `_` (path components are dict keys only, lists add none), non-`[A-Za-z0-9_]` chars replaced by `_`, uppercased. Example: `{"env":{"MY_API_TOKEN":"abc123"}}` gives `ENV_MY_API_TOKEN` and `"MY_API_TOKEN": "__SECRET:ENV_MY_API_TOKEN__"`. A non-secret-looking name with a plain value (`PLAIN: v`) is untouched.
- Every other string has `$HOME` replaced by `__HOME__`.
- Output is JSON with indent 2, `ensure_ascii=False`, trailing newline, key order preserved. The optional file lists the sorted unique names, one per line (empty file if none).
- Deterministic: same input gives byte-identical output.

## 6. setup/secret-scan.sh and setup/lib/regex_scan.py
`setup/secret-scan.sh` (no args, or one directory argument to scan that directory instead of the public repo; the overlay is scanned this way, 11.6) scans the files that would be committed: `git ls-files -co --exclude-standard` when the repo dir is a git work tree, else all files under the dir except `.git`. Prints `secret-scan: <N> files`, then either `secret-scan: gitleaks not installed (brew install gitleaks); using regex scan only` or runs gitleaks (and fails if it fails), then ALWAYS the regex scan, then `secret-scan: PASS` (exit 0) or `secret-scan: FAIL` (exit 1).
Regex scan prints one line per finding `<relpath>:<line>: [<rule>] <first 120 chars of the stripped line>`, then `regex-scan: <n> finding(s)`; exit 1 if any.
Rules: `private-key` (`-----BEGIN ... PRIVATE KEY-----`), `openai/anthropic-key` (`sk-` + 20+ chars), `github-token` (`ghp_|gho_|ghu_|ghs_|ghr_` + 20+ alphanumerics, or `github_pat_` + 20+), `slack-token`, `aws-key` (`AKIA|ASIA` + 16 caps/digits), `google-key` (`AIza` + 35), `jwt`, `bearer` (+20 chars), `secret-assignment` (`api_key|secret|token|password|credential`-ish name, `:` or `=`, a 20+ char value, line ending after it; values starting `__SECRET:`, `$`, `<`, `{`, `None`, `null`, `true`, `false`, `os.`, `process.`, `...` are exempt), `url-credentials` (`://user:pass@`).
Forbidden file names (reported as `FORBIDDEN-FILENAME <rel>`, any content): `.credentials*`, `.env`, `.env.*`, `*.env`, `settings.local.json`, `*.pem`, `id_rsa*`, `*.p12`, `*.keychain*` (`.gitignore` exempt). Exception (referee 2026-10-16): the overlay's root `config.env` is NOT a forbidden name when scanning an overlay (it is parsed config, never sourced); its content is still scanned by every content rule. A `config.env` anywhere else, or in the public repo, is still forbidden.
Binary files (NUL in first 4 KB), symlinks and non-files are skipped; lines are cut at 4000 chars.
Allowlist `.secret-scan-allow` in the repo dir: lines `path-glob<TAB>regex` (finding suppressed when the file path matches the glob via fnmatch and the regex matches the line) or a bare `regex` (all paths); blank lines and `#` comments ignored. The shipped file contains only the reviewed spec-placeholder entry (`://user:pass@` in this spec).

## 7. setup/githooks/pre-commit
`exec <repo>/setup/leak-scan.sh --staged` (which includes the secret rules, 11.8): a commit in the public repo is blocked iff the scan fails (needs `git config core.hooksPath setup/githooks`). The overlay repo ships its own pre-commit running `secret-scan.sh` only.

## 8. autosync.sh
This section describes the single-repo mechanics; with two repos (public + overlay) and the no-overlay no-op, 11.7 governs. Sequence per repo (cwd = repo dir): log `start`; `git pull --ff-only`; `setup/export.sh`; if `git status --porcelain` is empty log `no changes` and exit 0 (no commit); else `git add -A`, `git commit -q -m "autosync: <YYYY-MM-DD> (<N> files)" -m "Co-Authored-By: ..."` where N is the number of staged files, log `committed <N> files`, `git push`, log `pushed`.
Failure at stage `cd|pull|export|add|commit|push`: log `FAILED (<stage>)`, run `osascript -e 'display notification "machine-setup: autosync failed (<stage>)" with title "machine-setup"'` (errors ignored), exit 1. An export failure (including secret-scan FAIL) stops before `git add`, so nothing is committed or pushed; the working tree keeps the exported files. On a push failure the commit stays local.
Log file: `$HOME/.local/state/machine-setup/autosync.log` (dir auto-created); each line `YYYY-MM-DD HH:MM:SS <message>`; git/export output is appended to it. Stdout is empty. Exit 0 on success and on no changes.
Registered via the generic template `launchd/autosync.plist.tmpl` (daily 21:00; installed as `<prefix>.machine-setup-autosync.plist`, 11.5; installed only when an overlay exists).


## 9. Acceptance criteria

Bootstrap (temp HOME, public tree copy, `MACHINE_SETUP_PRIVATE` set explicitly, `claude`/`launchctl` shims on PATH)
1. `--dry-run` exit 0; stdout first line starts `machine-setup bootstrap  HOME=<tmp HOME>` and contains `(DRY RUN)`, the second line is `  overlay: ...` (11.2); the 8 section headings appear in the order of 3.1; the last line is `  DRY RUN complete: nothing was changed.`
2. After `--dry-run` the file tree under the temp HOME (names and contents) is identical to before, and `$HOME/.machine-setup-backup` does not exist, even though the merged `settings.json` (AC 46) differs from the HOME copy. No shim recorded a `launchctl bootstrap|bootout` call, `claude plugin install|marketplace add` call, `git clone` or `npx` call.
3. With an effective `CLAUDE.md` (overlay copy if present, else the template `claude/CLAUDE.md.template`) equal after rendering to `$HOME/.claude/CLAUDE.md` the dry run prints `unchanged  .claude/CLAUDE.md`; with a differing `settings.json` (compared against the merged result, AC 46), `overwrite (backup) .claude/settings.json`; with an absent file, `install    .claude/<file>`. A fixture file containing `__HOME__` is compared after substitution of the temp HOME.
4. Dry-run lists `mkdir -p .local/state/claude-handoffs` (and the other 7 public default dirs, plus overlay `dirs.txt` entries) when absent and omits a dir that exists.
5. Launchd decisions (run with `--launchd`; shim `launchctl print` exit 0/1; deps.tsv row with an existing required path; fixture labels are rendered labels, i.e. prefix applied; without `--launchd` step 7 prints `  skipped (pass --launchd to install launchd jobs)` and nothing is installed or queried): loaded + identical installed plist prints `<label>: loaded, unchanged` and nothing else for it; loaded + different prints `loaded, plist differs`; not loaded + no file prints `not loaded, not installed`; not loaded + identical file prints `not loaded, plist installed`; not loaded + different file prints `not loaded, plist differs`. Required path absent and repo not cloneable prints `SKIP     <label>` and the summary lists `launchd skipped: <label>`.
6. A real run with `--launchd`, `launchctl` shim, plist loaded and identical: shim sees no `bootout`/`bootstrap` for that label (idempotent re-run).
7. A real run (`--no-repos --no-plugins`, no `--launchd`) installs fixture files into `$HOME/.claude`, backs up a pre-existing differing file to `$HOME/.machine-setup-backup/<ts>/.claude/<name>` with its old content, and a second immediate run prints `unchanged` for all files and creates no new backup dir.
8. Plugin idempotency: with `claude plugin list` shim output containing `foo@mk` the run prints `plugin already installed: foo@mk` and never calls `claude plugin install foo@mk`; a plugin not listed prints `claude plugin install <id>   (state: enabled)` in dry-run.
9. Repo handling (rows come from the overlay `repos.tsv`; no overlay `repos.tsv` -> `  skipped (no overlay repos.tsv)`): a `kind=repo` row whose dest has `.git` prints `present  <name>`; a `worktree` row prints nothing for it; a row listed in the overlay `repos.optional` is not cloned without `--all-repos`; `--no-repos` prints `  skipped (--no-repos)`.
10. Unknown flag (including the withdrawn `--no-launchd`): exit 2 with `unknown flag:` on stderr and no stdout section output. `--help` exit 0.
11. Summary prints `__SECRET:<NAME>__` lines when the union of public and overlay `claude/placeholders.txt` has names, else the `none` line.

Export (all export ACs run WITH an overlay; file locations per 11.6; detailed ACs 56-65)
12. With a fake HOME fixture (settings.json, CLAUDE.md, hooks dir, empty plugins json files) and a temp overlay, `export.sh` exits 0 and creates in the OVERLAY `claude/settings.json`, `claude/CLAUDE.md`, `claude/placeholders.txt`, `claude/plugins.json`, `repos.tsv`; no file in either repo contains the literal temp HOME string; text files contain `__HOME__` instead.
13. Idempotency: run export twice with no machine change; a byte-for-byte snapshot of both repo dirs (all files) is equal after run 1 and run 2 (and `git status --porcelain` is empty in both after run 2 if run 1 was committed).
14. Removing an overlay-only hook file from HOME and re-running removes it from the overlay's `claude/hooks/`; `__pycache__`/`*.pyc` never appear.
15. A symlink in `$HOME/.claude/skills` is recorded in the overlay's `claude/skills.links.tsv` as `name<TAB>target` (HOME tokenised) and not copied; `skills/synced` is never copied.
16. (withdrawn 2026-10-16: capture is now keyed on the configurable `<LABEL_PREFIX>.*` and written to the overlay; the whole behaviour is specified by AC 61)
17a. Plugins step failure (normative, ruled a bug to fix): if `setup/lib/plugins.py` fails (e.g. `$HOME/.claude/plugins/installed_plugins.json` missing or invalid), `export.sh` exits non-zero and does not print `plugins.json` as success. Known to FAIL against current code (the failure is masked by an `&&` list under `set -e`).
17. `export.sh` exits non-zero when a planted file makes a scan fail (e.g. a `claude/hooks/x.py` in HOME containing a fake GitHub token), and the output ends with `secret-scan: FAIL`.

Scrubber
18. `{"env":{"MY_API_TOKEN":"abc123","PLAIN":"v"}}` gives `MY_API_TOKEN` = `__SECRET:ENV_MY_API_TOKEN__`, `PLAIN` = `v`, and the secrets file contains exactly `ENV_MY_API_TOKEN`.
19. A secret-shaped VALUE under a non-secret key inside `env` (e.g. `FOO: "ghp_" + 20 chars`) is replaced by `__SECRET:ENV_FOO__`; a secret-shaped value outside env/headers (top-level string) is also replaced; a value already `__SECRET:X__` is untouched; `Bearer <10 chars>` under `headers.Authorization` is replaced.
20. A string containing `$HOME` becomes `__HOME__...`; output ends with a newline, uses 2-space indent, and scrubbing twice (output as input) gives byte-identical output with an empty secrets list.
21. Secrets-list file is sorted and unique; empty when nothing found.

Secret scan
22. A planted file (tracked or untracked-not-ignored) containing a line `key = ghp_` + 26 alphanumerics: exit 1, output contains `<file>:1: [github-token]`, `regex-scan: 1 finding(s)` and `secret-scan: FAIL`.
23. Same line allowlisted with `.secret-scan-allow` line `<file glob>\t<regex that matches the line>`: exit 0, `regex-scan: 0 finding(s)`, `secret-scan: PASS`. A bare-regex allow line also works. An allow whose glob does not match the file does not suppress.
24. Placeholders `api_key = "__SECRET:X__"` and `token = $TOKEN` do not trigger `secret-assignment`; `password = "aaaaaaaaaaaaaaaaaaaaaaaa"` does.
25. A file named `foo.env` or `settings.local.json` (any content) yields `FORBIDDEN-FILENAME`; gitignored files (e.g. `*.pem` listed in `.gitignore`, in a git repo copy) are not scanned.
26. A file with a private key header, an `AKIA` + 16-char key, and `://user:pass1234@host` each produce a finding with their rule names.
27. Binary files (NUL byte) and symlinks are skipped. A clean repo copy returns exit 0 and `secret-scan: PASS`.
28. In a git copy of the public tree with `core.hooksPath setup/githooks` and a planted secret, `git commit` fails (the hook is `setup/leak-scan.sh --staged`, which includes the secret rules; see AC 81); without the secret it succeeds.

Autosync (fake HOME, overlay, local bare `origin` per repo, `osascript` shim recording its argv, repo copies committed and pushed; ACs 29-34 apply per repo, 11.7, 66-69)
29. No machine changes (both repos clean): exit 0, no new commit (`git rev-list --count HEAD` unchanged), `osascript` shim not invoked, log contains `no changes`.
30. A machine change (e.g. new overlay-visible file in `$HOME/.claude/CLAUDE.md`, landing in the overlay): exit 0, exactly one new commit whose subject matches `^autosync: \d{4}-\d{2}-\d{2} \(\d+ files\)$` and N equals the number of files changed, the commit is pushed to origin, log contains `committed` and `pushed`, no notification.
31. Scan failure (secret or leak, either repo; HOME hook file containing a fake token): exit 1, no new commit in either repo, nothing pushed, `osascript` shim called once with an argument containing `machine-setup: autosync failed (export)`, log contains `FAILED (export)`.
32. Pull failure (no upstream or non-ff): exit 1, `FAILED (pull)` logged and notification text contains `(pull)`.
33. Push failure (origin removed after setup): exit 1, notification contains `(push)`, the local commit exists.
34. `osascript` failing (shim exit 1) never changes the exit code semantics (still 1 on failure, 0 on success).


## 10. Rulings and notes
- Bootstrap dry-run calling read-only `claude plugin list`: accepted; see gap 2 and AC 2.
- export.sh must exit non-zero when the plugins step fails: ruled a bug; AC 17a requires it.
- Notes (harmless): the launchd step globbing zero plists may print a stderr error; `export.sh` aborts at the python step if `.agents/skills` exists without `.skill-lock.json`; `sed "s|$H|__HOME__|"` would break for a HOME containing `|`; the autosync commit trailer string is hard-coded and not behaviour-relevant; in dry-run a launchd job whose repo is listed but not yet cloned is treated as OK, while a real run SKIPs it if the clone failed (test both modes).

## 11. Public/private split (2026-10-16)

Status: approved (maintainer, 2026-10-16); the amendments below are already folded into sections 1-10 and their ACs. ACs 1-35 are the base behaviour, 36-83 the overlay behaviour. Behaviour only, for a code-blind tester.

### 11.1 Model
- `machine-setup` (PUBLIC, fresh history): generic tooling plus generic templates. Contains no personal value: no real home path, no personal email, no private project or repo names.
- `machine-setup-private` (PRIVATE, the "overlay"): only personal values, laid out as a mirror of the public tree (11.3).
- The public repo is the code that runs; the overlay is data. All three entry scripts (`bootstrap.sh`, `export.sh`, `autosync.sh`) take the overlay from the same discovery routine (11.2). All scripts live under `setup/` (`setup/bootstrap.sh`, `setup/export.sh`, `setup/autosync.sh`, `setup/secret-scan.sh`, `setup/leak-scan.sh`); ACs name them by script name and the tester resolves them under `setup/`.
- Sandboxing (extends section 2): a test builds a temp public copy and a temp overlay dir; it sets `HOME` to a temp dir and `MACHINE_SETUP_PRIVATE` explicitly (to the temp overlay, or to `none`). `launchctl`, `claude`, `osascript`, `git clone`, `npx` shims as in section 2. A temp public copy has no sibling `machine-setup-private` unless the test creates one next to it.

### 11.2 Overlay discovery
Order, first match wins:
1. `MACHINE_SETUP_PRIVATE` set and non-empty. Value `none` means "no overlay" (explicit opt-out, ignores the sibling). Any other value must be an existing directory (symlink allowed, resolved); otherwise stderr `overlay: MACHINE_SETUP_PRIVATE=<value> is not a directory`, exit 2, no writes, no fallback.
2. `<parent of the public checkout>/machine-setup-private`, if it is a directory. The public checkout is resolved from the script's own location (as `ROOT` today).
3. None.

This is the single, authoritative overlay selector for all three entry scripts and for scheduled jobs: the generic autosync job template passes the resolved overlay path to the script as `MACHINE_SETUP_PRIVATE` (via the `__OVERLAY__` placeholder, 11.5). No other variable or flag selects an overlay.

Reporting: bootstrap prints, immediately after its first line, `  overlay: <absolute path>` or `  overlay: none (generic install)`. Export prints `== overlay` with the same text as its first section. Autosync logs `overlay: <path|none>` after `start`.

An absent overlay is a supported mode: bootstrap must succeed (exit 0 absent other errors) as a generic install; export refuses (11.6); autosync is a no-op (11.7).

### 11.3 Overlay layout (all paths optional; absence = nothing contributed)
```
machine-setup-private/
  config.env                 KEY=VALUE lines (11.5)
  claude/settings.json       overrides, merged over public claude/settings.json (11.4)
  claude/CLAUDE.md           replaces public claude/CLAUDE.md
  claude/{hooks,commands,skills,agents,output-styles}/...   extra files, same install paths
  claude/keybindings.json
  claude/plugins.json        same schema as the public one
  claude/{skills,commands}.links.tsv, claude/hook-deps.tsv, claude/placeholders.txt
  agents/skill-lock.json, agents/skills-lock.json, agents/skills/, agents/skills.all.txt
  launchd/*.plist            personal jobs
  launchd/deps.tsv, launchd/links.tsv
  repos.tsv, repos.optional
  dirs.txt                   extra dirs to create, one per line, relative to HOME or __HOME__-prefixed
  manual-steps.txt           extra bullets for the bootstrap summary, one per line
  leak-denylist.txt          private terms (11.8); never copied anywhere
  leak-allow.txt             extra leak-scan allow entries (11.8)
```
Public tree equivalents: `claude/settings.template.json` (generic settings template; installs as `settings.json`), `claude/CLAUDE.md.template` (generic; installs as `CLAUDE.md`), `claude/settings.template.md` (documentation, never installed), `claude/hooks|commands|skills|...` (generic items), `claude/plugins.json` (optional; may be empty lists), `launchd/*.plist.tmpl` (generic job templates, 11.5) + a public `launchd/deps.tsv` listing them, `.leak-scan-allow`. A public file named `<stem>.template[.<ext>]` installs under the name without `.template`. The public tree has NO `repos.tsv` (a `repos.tsv.example` may exist and is never read) and no `leak-denylist.txt`.

### 11.4 Install-time merge rules (bootstrap step 4-7)
Effective file set for `~/.claude`: union of public `claude/**` and overlay `claude/**` by installed relative path (the `.template` name mapping of 11.3 applied first; same exclusions as 3.1). For a path in both, overlay wins (this makes CLAUDE.md "overlay replaces template"), except `settings.json`, `plugins.json` and the `*.tsv`/`placeholders.txt` list files, which merge as below. Line formats of 3.1 are unchanged; the source is the effective (merged, rendered) content.

`settings.json` (merge implemented by `setup/lib/merge_settings.py TEMPLATE OVERLAY OUT`, which a tester may also call directly; either input may be absent):
- Objects merge recursively, key by key. Result key order: template keys in template order, then overlay-only keys in overlay order.
- Scalars: overlay wins. Type mismatch (e.g. object vs string): overlay wins.
- Overlay value `null`: the key is removed from the result.
- Arrays at exactly `permissions.allow`, `permissions.deny`, `permissions.ask`: UNION, template items first then overlay items not already present (deep equality), duplicates removed. Rationale: these are additive rule sets; the public baseline denies must not be silently dropped by an overlay, and personal allows must not drop the baseline. Consequently an overlay can only add permission entries, never remove a template entry; there is no removal syntax.
- Every other array: overlay REPLACES the whole array. Rationale: order or structure carries meaning (hooks lists, command lines, matchers); a union would mix or duplicate semantics.
- Output: JSON indent 2, `ensure_ascii=False`, trailing newline, deterministic (same inputs, byte-identical output; merging an already merged file with the same overlay is a no-op).
- Neither input present: no `settings.json` installed. Only template: template as is. Only overlay: overlay as is.

`plugins.json`: `marketplaces` union by `name`, `plugins` union by `id`; on equal key the overlay entry wins; result sorted as `setup/lib/plugins.py` sorts. Both inputs are optional; neither present means step 6 prints `  skipped (no plugins.json)`.
`claude/placeholders.txt`: union, sorted, unique. `hook-deps.tsv`, `*.links.tsv`: concatenated, overlay row wins on equal first column, sorted (C locale).
`agents/`: `skill-lock.json`, `skills-lock.json`: overlay replaces public if present. `agents/skills/`: union, overlay wins per file. `agents/skills.all.txt`: not read by bootstrap.
`repos.tsv`, `repos.optional`: read ONLY from the overlay. With no overlay (or no overlay `repos.tsv`) step 3 prints `  skipped (no overlay repos.tsv)` and is not an error. Public `repos.tsv`/`repos.tsv.example` is never read.
`launchd` (only with `--launchd`; without it step 7 is skipped entirely): rows of public `launchd/deps.tsv` and overlay `launchd/deps.tsv` are both processed (keyed by RENDERED label; overlay row wins on equal label). Template plists come from public `launchd/*.plist.tmpl`, personal ones from overlay `launchd/<name>.plist`; both go through the same renderer (11.5) and then the unchanged per-job logic of 3.1 (lint, required path, loaded/unchanged decisions). A job whose deps `needs` column is the token `overlay` is skipped when there is no overlay: `  SKIP     <label>  (needs a private overlay; none configured)` plus `launchd skipped: <label>` in the summary.
`dirs.txt`: dirs created in step 2 in addition to the public defaults. Public default list (replaces the 10 of AC 4): `.local/state/claude-handoffs .claude/hooks .claude/skills .claude/commands .local/state/token-budget .local/state/machine-setup Library/LaunchAgents .agents/skills`. (`CodeBase` and any project-specific log dirs move to the overlay `dirs.txt`.)
`manual-steps.txt`: appended to "Manual steps still needed" in the summary. The public fixed bullets shrink to the single generic `    - claude login (credentials are never stored in this repo)`; the `.env` and `ollama pull bge-m3` bullets move to the overlay. The special-case for the `ollama-serve` label (creating `OLLAMA_MODELS`) is removed from bootstrap; the overlay lists such dirs in `dirs.txt`.

### 11.5 Placeholder rendering
- Applied to every installed text file and plist, from public and overlay alike: `__HOME__` -> `$HOME`, `__LABEL_PREFIX__` -> label prefix, `__REPO__` -> absolute path of the public checkout, `__OVERLAY__` -> absolute path of the overlay (a file using `__OVERLAY__` with no overlay is not installed and is reported as skipped, not as an unresolved placeholder). `__SECRET:NAME__` is never touched. After rendering, any remaining `__[A-Z][A-Z0-9_]*__` token (other than `__SECRET:...__`) makes that file/job fail: `  WARN: unresolved placeholder <token> in <rel path>`, file/job not installed, exit 1.
- Label prefix: default `com.machine-setup`. Overlay `config.env` may set `LABEL_PREFIX=<value>`. The file is parsed (lines `KEY=VALUE`, `#` comments and blanks ignored, optional surrounding quotes stripped), never sourced or evaluated. Unknown keys ignored. `LABEL_PREFIX` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` else stderr `config: invalid LABEL_PREFIX`, exit 2 before any write. Public template jobs are `launchd/<name>.plist.tmpl` whose Label is `__LABEL_PREFIX__.<job>`; the installed file is `~/Library/LaunchAgents/<rendered Label>.plist`. Shipped templates: `launchd/autosync.plist.tmpl` (daily 21:00, Label `__LABEL_PREFIX__.machine-setup-autosync`, deps `needs` = `overlay`, runs `__REPO__/setup/autosync.sh` with `MACHINE_SETUP_PRIVATE=__OVERLAY__`) and `launchd/token-budget.plist.tmpl` (Label `__LABEL_PREFIX__.token-budget`, as in docs/token-budget-spec.md). Rendered, the autosync file is `~/Library/LaunchAgents/<prefix>.machine-setup-autosync.plist`. An overlay owner who already runs jobs under another prefix sets `LABEL_PREFIX` to it, so existing labels continue.
- The renderer is idempotent: rendering a file with no placeholders yields it byte-identical.

### 11.6 export.sh / autosync.sh direction
Personal values go ONLY to the overlay; the public repo changes only for generic files.
- No overlay: `export.sh` writes nothing anywhere (neither repo), prints nothing on stdout, stderr `export: no overlay configured; refusing to write personal files (set MACHINE_SETUP_PRIVATE or create ../machine-setup-private)`, exit 3. There is no mode that exports only to the public repo (no `--public-only`): generic public files are refreshed only as a side effect of an overlay-backed export.
- Written to the overlay (always, scrubbed and `$HOME` tokenised as today): `claude/settings.json` as a DIFF against the public template (inverse of 11.4: omit equal leaves; keys absent from the live file but present in the template become `null`; for the three union arrays only items not in the template; any other array that differs is written in full; if live equals template the file is `{}`), `claude/CLAUDE.md` (full live copy), `claude/plugins.json` (full live, not diffed; a template/public plugin removed on the machine therefore stays in the overlay-less public list and is still installed by bootstrap), `claude/placeholders.txt`, `claude/*.links.tsv`, `claude/hook-deps.tsv`, `agents/*` (as today, in full; `skill-lock.json` is not diffed), `repos.tsv` (as today, excluding `machine-setup` and `machine-setup-private`), `launchd/` personal plists + `deps.tsv` + `links.tsv`, and any file under `claude/{hooks,commands,skills,agents,output-styles}/` or `claude/keybindings.json` that does NOT exist at the same path in the public tree. Deletions on the machine are mirrored inside the overlay (those directories only).
- Launchd capture: plists in `~/Library/LaunchAgents` named `<LABEL_PREFIX>.*.plist` (prefix from overlay config.env, else `com.machine-setup`). A plist whose label equals one rendered from a public template is NOT exported. Others are written to `overlay/launchd/<name>.plist` with `$HOME` -> `__HOME__` and the leading prefix -> `__LABEL_PREFIX__`. Plists with other prefixes are ignored (replaces a hard-coded personal prefix).
- Public repo writes: only files that already exist in the public tree under `claude/{hooks,commands,skills,agents,output-styles}/` and `claude/keybindings.json`, refreshed from the machine (tokenised) when their content differs. Export never creates, deletes or renames a public file. A public generic file missing on the machine prints `  public: <rel> not on this machine, left unchanged`. Public files never written by export: `claude/settings.json`, `claude/CLAUDE.md`, `claude/plugins.json`, `claude/placeholders.txt`, `*.links.tsv`, `hook-deps.tsv`, `launchd/*`, `agents/*`, `repos.tsv*`, `.leak-scan-allow`, everything under `setup/`, `lib/`, `docs/`.
- Stdout sections in order: `== overlay`, `== claude`, `== agents (~/.agents)`, `== launchd`, `== repos`, `== secret scan` (runs `setup/secret-scan.sh` for the public repo AND, given the overlay dir as its argument, for the overlay), `== leak scan` (runs `setup/leak-scan.sh` on the public repo, with the overlay denylist). Exit 0 only if all scans pass; plugin-step failure still exits non-zero (AC 17a carried).
- `export.sh --dry-run|-n`: computes everything in a temp dir, prints `  would write [overlay] <rel>` / `  would write [public] <rel>` for each file that differs from what is on disk, writes nothing in either repo, runs the scans on the would-be result, same exit codes. Unknown flag: exit 2.

### 11.7 autosync.sh with two repos
- No overlay: logs `no overlay configured; nothing to sync`, exit 0, no commit, no notification (a generic user must not get a daily failure alert). The template job is also not installed by bootstrap without an overlay (its deps `needs` is `overlay`).
- With overlay: `git pull --ff-only` in the public repo, then in the overlay if it is a git work tree (else log `overlay is not a git repo; skipping its git steps`); `./export.sh`; per repo, if `git status --porcelain` is empty log `no changes (public|overlay)`; else `git add -A`, commit `autosync: <YYYY-MM-DD> (<N> files)` (N per repo), log `committed <N> files (public|overlay)`; then push public, then overlay; log `pushed (public|overlay)`. Stages and notification text unchanged (`cd|pull|export|add|commit|push`). Any scan failure (secret or leak, either repo) is an `export` failure: nothing is committed or pushed in EITHER repo.
- Public author guard (kept; noreply only): before committing in the public repo, `git -C <public> config user.email` must end in `@users.noreply.github.com`; otherwise log `public repo author email is not a noreply address`, `FAILED (commit)`, notification, exit 1, no public commit (the overlay may still commit).
- Failure on one push leaves the other repo's push untouched and the local commit in place.

### 11.8 Leak guard: `setup/leak-scan.sh`
Purpose: prevent personal values entering the public repo. Used by `setup/githooks/pre-commit` (public repo), by `export.sh`, and by CI.

Usage: `setup/leak-scan.sh [--root DIR] [--denylist FILE|--no-denylist] [--require-denylist] [--staged]`.
- `--root` default: the public repo root (parent of `setup/`). Files = `git ls-files -co --exclude-standard` in a work tree, else all files except `.git`. `--staged`: only staged files, content read from the index. Binary files (NUL in first 4 KB), symlinks, non-files skipped; lines cut at 4000 chars.
- Denylist file, first found: `--denylist FILE`; else `<overlay>/leak-denylist.txt` (overlay per 11.2); else none. `--no-denylist` forces none. Output line `leak-scan: denylist: <M> entries` or `leak-scan: denylist: none`. CI runs without overlay, so denylist-based protection is local only (pre-commit, export, autosync).
- Denylist format: one term per line, `#` comments and blank lines ignored, case-insensitive fixed-string match; a line starting `re:` is a case-insensitive extended regex. Terms are matched against file CONTENT and file PATHS.
- Rules (the `<rule>` token in output; `home-path` and `uuid` have NO built-in exemptions, so any legitimate occurrence, e.g. a doc example, needs an allow entry below):
  - `secret:<name>`: every rule of `lib/regex_scan.py` (private-key, github-token, slack-token, aws-key, jwt, bearer, secret-assignment, url-credentials, ...), plus `forbidden-filename`. Honors the existing `.secret-scan-allow` unchanged. If `gitleaks` is installed it is also run with redaction; its failure fails the scan.
  - `home-path`: `/Users/<anything>/`, `/home/<anything>/`, `C:\Users\<anything>\` (`<anything>` = 1+ chars up to the next separator). `__HOME__`, `~`, `$HOME` are fine.
  - `email`: any `local@domain.tld` except domains `users.noreply.github.com` and `example.com` (and subdomains of `example.com`). Package refs like `plugin@marketplace` and `pkg@1.2.3` (no alphabetic TLD) do not match.
  - `uuid`: `8-4-4-4-12` hex, case-insensitive, not embedded in a longer hex/dash token.
  - `denylist#<n>`: line number `n` of the denylist entry (never the term itself), for content hits; `denylist-path#<n>` for path hits.
  - `denylist-file`: a tracked/staged file named `leak-denylist.txt` or `leak-allow.txt` anywhere in the public tree.
- Allowlist (rules other than `secret:*` and `denylist*`): file `.leak-scan-allow` in the scanned root, plus `<overlay>/leak-allow.txt` if an overlay is found. Lines `path-glob<TAB>rule<TAB>regex` (`rule` is a rule name or `*`; the regex must match the offending TEXT itself, not just the line; glob via fnmatch on the relative path); `#`/blank ignored. Inline: a line containing `leak-scan: allow=<rule>[,<rule>...]` suppresses those rules on that line (not for `secret:*` or `denylist*`). Denylist hits can be allowed only via the overlay `leak-allow.txt`. Because the public `.leak-scan-allow` is itself scanned, it must not contain private strings. Exemptions exist only through these allow entries and inline markers; there is no other exemption mechanism.
- Output, one finding per line, sorted by path then line then rule (C locale): `<relpath>:<line>: [<rule>]`. The matched text, the line, and denylist terms are NEVER printed (the CI log is public). Header `leak-scan: <N> files`, trailer `leak-scan: <n> finding(s)` then `leak-scan: PASS` or `leak-scan: FAIL`. Findings in a file named by the denylist-path rule use line `0`.
- Exit codes: 0 pass; 1 findings; 2 usage error (unknown flag, `--root` not a directory, `--denylist` unreadable); 4 `--require-denylist` given and no denylist found (nothing scanned).
- `setup/githooks/pre-commit` (public repo) = `exec setup/leak-scan.sh --staged`; blocks a commit iff it fails. The overlay repo ships its own pre-commit running `secret-scan.sh` only (it legitimately holds paths, emails, names).
- CI: `.github/workflows/leak-scan.yml`: triggers `push` and `pull_request`; `permissions: contents: read`; checkout step with `uses:` pinned to a version tag or SHA; a step whose `run` is `setup/leak-scan.sh`; no `secrets.*` reference and no network install other than optional gitleaks. Must be valid YAML.

### 11.9 Acceptance criteria (36 onward)

Discovery
36. Env var wins: with `MACHINE_SETUP_PRIVATE=<tmp A>` and a sibling `machine-setup-private` also present, `bootstrap.sh --dry-run` line 2 is `  overlay: <A resolved>` and content from A (not the sibling) is used.
37. With the env var unset or empty and a sibling dir present: `  overlay: <sibling>`.
38. With `MACHINE_SETUP_PRIVATE=none` and a sibling present: `  overlay: none (generic install)` and no sibling file contributes.
39. Env var set to a non-directory: exit 2, stderr `overlay: MACHINE_SETUP_PRIVATE=<value> is not a directory`, nothing written under `$HOME`; same for `export.sh` and `autosync.sh`.
40. No overlay (no env, no sibling): `bootstrap.sh --dry-run` exits 0, prints `  overlay: none (generic install)`, section 3 prints `  skipped (no overlay repos.tsv)`, the 8 headings of 3.1 still appear in order, the last line is `  DRY RUN complete: nothing was changed.`; real run with `--no-repos --no-plugins` (no `--launchd`) installs the public template files and exits 0; the installed tree contains no personal-name string from the overlay denylist.

Merge
41. Deep merge: template `{"a":{"x":1,"y":2},"b":1}`, overlay `{"a":{"y":3,"z":4},"c":5}` -> `{"a":{"x":1,"y":3,"z":4},"b":1,"c":5}` with that key order, indent 2, trailing newline.
42. Union arrays: template `permissions.allow=["A","B"]`, overlay `["B","C"]` -> `["A","B","C"]`; same for `deny` and `ask`; a template `deny` entry survives an overlay that lists none.
43. Non-permission arrays replaced: template `hooks.Stop=[{x}]`, overlay `hooks.Stop=[{y}]` -> `[{y}]`; an array at `permissions.additionalDirectories` is replaced, not unioned.
44. Overlay `null` removes the key; overlay object where template has a string -> overlay object; overlay scalar where template has an object -> overlay scalar.
45. Missing inputs: only template -> template content; only overlay -> overlay content; neither -> no `settings.json` installed and no error. Merge output is byte-identical on repeat and `merge(merge(T,O),O)` equals `merge(T,O)`.
46. Installed `~/.claude/settings.json` after a real run equals the merge result with `__HOME__`/`__LABEL_PREFIX__` rendered; a dry run reports `install|overwrite (backup)|unchanged .claude/settings.json` by comparing against that merged content.
47. CLAUDE.md: overlay present -> installed file equals overlay content (template ignored); overlay lacks it -> template content.
48. Other `claude/` files: a file only in the overlay is installed; a file in both takes the overlay content; hooks from both trees are installed; `plugins.json` entries union by id (overlay wins on same id) and marketplaces by name; `placeholders.txt` names union (summary lists the union, sorted, unique).
49. `repos.tsv`/`repos.optional` come only from the overlay: a public `repos.tsv` fixture is ignored (no clone, no `present`); with overlay rows, AC 9 behaviour holds.
50. `dirs.txt` entries are created (dry-run prints `mkdir -p <rel>`); the public default list is exactly the 8 dirs of 11.4 (no project-specific dirs, no `CodeBase` without overlay); `manual-steps.txt` lines appear under "Manual steps still needed", the `claude login` bullet always appears, no `ollama`/`.env` bullet without overlay.

Launchd and placeholders
51. Template job (run with `--launchd`): no overlay config, `launchctl print` shim exit 1, public template `launchd/autosync.plist.tmpl` with Label `__LABEL_PREFIX__.machine-setup-autosync`: not applicable without overlay (needs `overlay`) -> `SKIP     com.machine-setup.machine-setup-autosync  (needs a private overlay; none configured)`; with an empty overlay it prints `com.machine-setup.machine-setup-autosync: not loaded, not installed -> install, bootstrap`, and a real run installs `~/Library/LaunchAgents/com.machine-setup.machine-setup-autosync.plist` whose Label and any path contain no `__`. Without `--launchd` none of this happens: step 7 prints `  skipped (pass --launchd to install launchd jobs)`, `launchctl` is never invoked and nothing is written to `~/Library/LaunchAgents`.
52. Overlay `config.env` (with `--launchd` where an install is asserted) `LABEL_PREFIX=com.example.me` -> the template installs as `com.example.me.machine-setup-autosync.plist`; `LABEL_PREFIX` with a space, `$(...)`, or `/` -> exit 2, stderr `config: invalid LABEL_PREFIX`, nothing written; a `config.env` line `LABEL_PREFIX=com.ok` plus `X=$(touch SENTINEL)` does not create SENTINEL (not evaluated).
53. Overlay plists `launchd/<name>.plist` with `deps.tsv` rows are installed with `__HOME__` rendered and decided by the 3.1/AC 5 rules unchanged; same label in both trees -> overlay plist used; a plist with no placeholders installs byte-identical.
54. Unresolved placeholder: a fixture file or plist containing `__FOO__` -> `  WARN: unresolved placeholder __FOO__ in <rel>`, that file/job not installed, exit 1; `__SECRET:X__` in settings is not flagged.
55. Re-run idempotency (carries AC 6, 7): second real run prints `unchanged` for every file, creates no new backup dir, and the `launchctl` shim sees no bootout/bootstrap for loaded identical jobs, with an overlay present.

Export
56. No overlay: `export.sh` exits 3, stdout empty, stderr contains `refusing to write personal files`, and a byte snapshot of the public repo copy is unchanged.
57. With overlay: after export, none of the public files listed as "never written" in 11.6 changed (hash before = after); the overlay contains `claude/settings.json`, `claude/CLAUDE.md`, `claude/plugins.json`, `claude/placeholders.txt`, `repos.tsv`; no file in EITHER repo contains the literal temp HOME string, text files contain `__HOME__` (carries AC 12).
58. Settings diff round trip: for a live settings equal to template plus extra keys, a changed scalar, an added allow entry and a key removed relative to the template, `merge(public template, exported overlay settings.json)` equals the scrubbed live file semantically, and the overlay file holds only differing leaves (extra key, new scalar, `permissions.allow` containing only the added entry, removed key as `null`). Live equal to template -> overlay `settings.json` is `{}`. A template union item absent on the machine yields stdout `  warning: template permission entry not expressible in overlay` and exit 0.
59. Secret scrubbing (carries 18-21): a token in live `env` becomes `__SECRET:ENV_<NAME>__` in the overlay settings and its name in overlay `claude/placeholders.txt`.
60. Public generic refresh: a changed `claude/hooks/x.sh` that exists in the public tree is rewritten in the public repo (tokenised); a new hook `y.sh` on the machine appears only in the overlay; a public hook missing on the machine stays and prints `public: <rel> not on this machine, left unchanged`; a hook removed from the machine is removed from the overlay copy only.
61. Launchd capture: with prefix `com.machine-setup` default, `com.machine-setup.foo.plist` and `com.other.bar.plist` in HOME: only `foo` is written, to `overlay/launchd/com.machine-setup.foo.plist` with the prefix tokenised as `__LABEL_PREFIX__.foo` in Label (check the file) and HOME as `__HOME__`; the template-label plist is not written anywhere; with overlay `LABEL_PREFIX=com.other`, `bar` is captured instead.
62. Idempotency (carries 13): two exports with no machine change leave byte-identical snapshots of both repos; `git status --porcelain` empty in both after run 1 committed.
63. `--dry-run`: exit code same as a real run, prints `would write [overlay] ...` lines, both repos byte-identical before/after; unknown flag exit 2.
64. Failure propagation (carries 17, 17a, 31): a fake token in a live hook, or an invalid `installed_plugins.json`, gives non-zero exit; the output of a failing scan ends with the failing tool's `FAIL`; a secret in an overlay-only file (e.g. overlay CLAUDE.md source) also fails via the overlay `secret-scan.sh` run.
65. Leak step: a live hook containing `/Users/someone/x` that maps to an EXISTING public hook makes export exit non-zero with `leak-scan: FAIL` and a `[home-path]` line (the same text going to the overlay is fine).

Autosync
66. No overlay: exit 0, log contains `no overlay configured; nothing to sync`, no commit, `osascript` shim not called.
67. Changes in both: one new commit in each repo matching `^autosync: \d{4}-\d{2}-\d{2} \(\d+ files\)$`, N = files changed in that repo, both pushed to their bare origins, log has `committed .. (public)`, `committed .. (overlay)`, `pushed (public)`, `pushed (overlay)`; only-overlay changes -> only the overlay commits, log has `no changes (public)`.
68. Leak or secret failure in either repo: exit 1, no new commit and no push in EITHER repo, notification text contains `autosync failed (export)`, log `FAILED (export)`.
69. Author guard: public repo `user.email=a@corp.org` -> exit 1, `FAILED (commit)`, no public commit; `user.email=1+x@users.noreply.github.com` -> commits. Pull/push failures behave as ACs 32-34 per repo.

Leak scan (fixture tree in a temp git repo; outputs checked with grep; every finding line also checked to NOT contain the offending text)
70. Clean tree: exit 0, last line `leak-scan: PASS`, header `leak-scan: <N> files`, `leak-scan: denylist: none`, `leak-scan: 0 finding(s)`.
71. `/Users/zed/proj/x` -> exit 1, line `<file>:<n>: [home-path]`; also `/home/zed/x` and `C:\Users\zed\x`; `__HOME__/x`, `~/x`, `$HOME/x` pass.
72. Emails: `a@corp.org` -> `[email]`; `1+n@users.noreply.github.com`, `x@example.com`, `x@mail.example.com` pass; `plugin@market` and `pkg@1.2.3` pass.
73. A UUID in 8-4-4-4-12 hex form (generated at test time, e.g. with `uuidgen`; upper or lower case) -> `[uuid]`; a 32-hex string without dashes passes.
74. Secrets: planted `ghp_` + 26 chars -> `[secret:github-token]`; file `foo.env` -> `[secret:forbidden-filename]`; the printed line does NOT contain the 120-char snippet that `secret-scan.sh` prints; `.secret-scan-allow` entry still suppresses it.
75. Denylist from `--denylist FILE` with term `Zebra`: content `a zebra b` -> `[denylist#1]` (case-insensitive); a file whose path contains `zebra` -> `[denylist-path#1]` line `0`; `re:^proj-\d+$` entry works; comments/blanks skipped (entry numbers are file line numbers); output never contains `zebra`; header says `denylist: 1 entries`.
76. Overlay discovery for denylist: with `MACHINE_SETUP_PRIVATE=<dir containing leak-denylist.txt>` and no flag, the denylist is used; `--no-denylist` disables; no overlay -> `denylist: none` and exit 0 on an otherwise clean tree; `--require-denylist` with none -> exit 4 and no scan header findings; `--denylist /missing` -> exit 2; unknown flag -> exit 2.
77. `denylist-file`: a tracked file named `leak-denylist.txt` (or `leak-allow.txt`) in the scanned root -> `[denylist-file]`, exit 1.
78. Allowlist: `.leak-scan-allow` line `docs/*\temail\tfoo@bar\.io` suppresses `foo@bar.io` in `docs/a.md` but not in `src/a.md`, not another address in `docs/a.md`, and not a `home-path` on the same line; rule `*` matches any non-secret rule; inline `leak-scan: allow=email` suppresses only the email on that line; inline allow does NOT suppress `secret:*` or a denylist hit; overlay `leak-allow.txt` can allow a denylist hit (`<glob>\tdenylist#1\t<regex>` or rule `*`).
79. Determinism and ordering: findings sorted by path, line, rule; two runs byte-identical; binary file with a leak string and a symlink are skipped.
80. `--staged`: leak in an unstaged working-tree change but clean index -> PASS; leak staged -> FAIL even if the working tree was fixed afterwards.
81. Pre-commit: in a temp public repo with `core.hooksPath githooks`, `git commit` fails when staging any of 71-74 or 77, succeeds when clean.
82. CI workflow `.github/workflows/leak-scan.yml` parses as YAML; `on` includes `push` and `pull_request`; `permissions` is `contents: read`; some step `run` equals or contains `setup/leak-scan.sh`; every `uses:` has `@<ref>`; text contains no `secrets.`.
83. Public tree self-check (run by the tester on the delivered public repo, no overlay): `setup/leak-scan.sh` exits 0; the tree has no `repos.tsv`, no `leak-denylist.txt`, no personal-prefix launchd label string, and no commit in `git log` has an author/committer email other than `*@users.noreply.github.com`.

### 11.10 Decisions (2026-10-16; these closed the earlier open questions)
1. Overlay cannot remove template permission entries: `permissions.allow|deny|ask` merge is union only, with no removal syntax (11.4).
2. `claude/plugins.json` and the agents skill lock are exported in full to the overlay, not diffed (11.6).
3. No `--public-only` export mode; export without an overlay refuses (11.6, AC 56).
4. The public autosync author-email guard (noreply only) is kept (11.7, AC 69).
5. `home-path` and `uuid` leak findings are strict; exemptions only through `.leak-scan-allow` / overlay `leak-allow.txt` entries or inline `leak-scan: allow=` markers (11.8, AC 78).
6. Overlay discovery uses only `MACHINE_SETUP_PRIVATE` (else `../machine-setup-private`; `none` disables) in all three scripts and scheduled jobs (11.2). Bootstrap's launchd step is opt-in via `--launchd` (3).
