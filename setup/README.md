# setup

Bootstrap, export and secret-scan scripts that capture and restore a Claude Code setup on macOS (hooks, settings template, launchd jobs) without storing secrets or personal data.

Scripts: `bootstrap.sh`, `export.sh`, `autosync.sh`, `publish.sh`, `secret-scan.sh`, `leak-scan.sh` (enable the pre-commit hook with `git config core.hooksPath setup/githooks`). Read their header comments for usage, and see [`../PREREQS.md`](../PREREQS.md) for the tools they expect, [`../claude/settings.template.md`](../claude/settings.template.md) for the settings template, and [`../OVERLAY.md`](../OVERLAY.md) for what intentionally stays out of this public repo.

Autosync commits the public repo locally and never pushes it; after review you publish with `setup/publish.sh --push` (run it without arguments to see what is pending).
