# scripts

Runtime: **node** (v26, runs `.ts` natively by type stripping; no install). `bun` is not installed. Typecheck uses `npx --yes -p typescript@5.6 tsc` (downloads once).

- `node scripts/sync-shared.ts` copies `shared/*.ts(x)` into `plugins/<p>/hooks/_shared/` for the plugins in its `PLUGINS` array (safety, usage, awareness, agents, dev, compact; missing folders skipped; agent-pets never). `--check` writes nothing and exits 1 on drift.
- `node scripts/gen-mascots.ts` regenerates `shared/mascots.ts` from `research/brainstorm/assets/{pom,carrot}-idle.png`.
- `scripts/run-contract.sh <plugin>` copies `plugins/<plugin>` to a temp dir, copies the whole `${BENTO_TESTS_DIR:-$HOME/CodeBase/bento-mods-tests}/<plugin>/` folder into `<tmp>/contract/` (CONTRACT-MAP.md excluded), runs `claude plugin test <tmp>`, prints only pass/fail counts and failing test names, and exits with the test exit code.
- Shared typecheck: `npx --yes -p typescript@5.6 tsc -p shared/tsconfig.json`.
