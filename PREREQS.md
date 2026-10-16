# Prerequisites

Install these before `setup/bootstrap.sh` (bootstrap only checks and warns; it does not install tools).

| Tool | Used by | Install |
|---|---|---|
| Xcode CLT (git, python3, plutil, launchctl) | everything | `xcode-select --install` |
| Homebrew | installs below | https://brew.sh |
| git, rsync, jq | bootstrap, hooks | `brew install git rsync jq` |
| gh | cloning private repos (`gh auth login`) | `brew install gh` |
| claude (Claude Code) | plugins, token-budget jobs | `brew install --cask claude-code@latest` |
| node / npx | skills CLI, tsc for plugin development | `brew install node` |
| python3 (3.10+) | hooks (`precompact-handoff.py`), token-budget tooling | `brew install python` (or CLT python3) |
| ccusage (optional) | the example statusLine | `npm install -g ccusage` |
| gitleaks (optional) | `setup/secret-scan.sh` (a regex scan runs regardless) | `brew install gitleaks` |

macOS only for the launchd and `setup/` tooling. The plugins themselves need only Claude Code.
