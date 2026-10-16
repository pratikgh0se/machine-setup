# Code-blind TDD with a referee

How Bento (six Claude Code plugins, 977+ contract cases, ~30 acceptance findings) was built and fixed
without any agent writing tests against its own code. Written 2026-10-15 for the user and for agents
reusing the process on other projects.

## 1. Why

An agent that writes both code and tests tends to fit one to the other. The tests then prove the code
does what the code does, not what the spec says. Published evidence for the risk (as of 2026-10-15,
all via `research/14-code-blind-testing-practice.md`):

- OpenAI retired SWE-bench Verified in Feb 2026 partly because tests enforced implementation details and
  rejected correct fixes (https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/; primary
  page not fetchable, figures are from secondary reports).
- ImpossibleBench (https://arxiv.org/abs/2510.20270, 2025-10-23) and EvilGenie
  (https://arxiv.org/pdf/2511.21654, Nov 2025) show agents exploit tests when they can see them; an LLM
  judge caught clear cases.
- AgentCoder (https://arxiv.org/abs/2312.13010, 2023-12-20) separates programmer and test designer;
  results are on single-function benchmarks only.
- The spec is the oracle (Barr et al. 2015, https://discovery.ucl.ac.uk/1471263/). A vague spec makes
  the blind tester guess. This is the main risk of the split.

Gap: no published evaluation of a blind-tester / blind-builder / referee loop exists (research/14). Treat
this process as an engineering practice that worked here, not as a proven method.

## 2. Roles and who may read what

| Role | Model | Job |
|---|---|---|
| Orchestrator | Opus/Fable (main) | Decides, writes specs and briefs, runs checks, talks to the user. Never reads tests. |
| Builder | Sonnet | Implements from spec + brief. Blind to tests. |
| Tester | Sonnet | Writes contract tests from the spec only. Code-blind. |
| Referee | Sonnet (Opus for hard cross-cutting cases) | Sees both. Edits nothing. Diagnoses, writes separate blind briefs. |
| Gatherer | Haiku | Research, sweeps, link checks. |

| Reads | Spec | Plugin code | Test source | Run results |
|---|---|---|---|---|
| Orchestrator | yes | yes | no | yes (counts, failing names) |
| Builder | yes | yes | no | yes |
| Tester | yes (and READMEs, host docs) | no | yes | yes |
| Referee | yes | yes | yes | yes |

Model choice follows the delegation policy in `~/.claude/CLAUDE.md` ("Model delegation policy"):
expensive models think and review, Sonnet builds, Haiku gathers. Escalate to Opus only for diagnosis a
Sonnet could not crack (F25 cross-plugin render lag was one).

Enforcement is by convention plus tooling: separate repos (`bento-mods` vs `bento-mods-tests`),
`scripts/run-contract.sh <plugin>` copies plugin and tests into a temp dir, runs `claude plugin test`,
and prints only `pass=N fail=N` and failing test names. Test source is never printed.

## 3. The loop

1. **Spec.** Orchestrator writes or extends `specs/<plugin>.md` in observable behaviour terms (exact
   strings, states, thresholds). Ambiguity here becomes tester guesses later.
2. **Parallel build and test.** One builder brief and one tester brief per plugin, sent in one message.
   The tester may add fake-host rules (e.g. refuse a host call the real host refuses).
3. **Run.** `run-contract.sh <plugin>` for each plugin: counts and failing names only.
4. **Disagreement goes to a referee.** Red tests after the builder is done mean either side may be
   wrong. The referee reads code and tests, decides which side is wrong, edits nothing, and writes:
   Diagnosis (orchestrator only), Builder brief (no test names), Tester brief (no code identifiers),
   Spec clarification, Risk.
5. **Clarify and re-brief.** Orchestrator appends the spec clarification, then sends the two blind
   briefs. Repeat 3-5 (Bento had up to four rounds).
6. **Orchestrator verifies itself:** all six contracts, `tsc`, `sync-shared --check`.
7. **Ship.** Commit per plugin, bump versions (patch for fixes, minor for features), update the
   marketplace manifest, push. Tests repo is committed separately.

Live acceptance (a human or scripted run on the real host) feeds step 4 as new findings. Of 32 findings
in `docs/acceptance-results.md` (F1-F32), contracts at 908-985 green had missed most of them.

## 4. Lessons from this project

### (a) A test that never failed proves nothing
F28 (band cache chip clipped) and F29 (Cache Clock COLD right after a paid cold write): the referee's
Round 2 (`f27-30.md`) found the first-round tests passed on the OLD code. C30 compared a text's local x
against the whole row width, so it was always true. C33-C35 re-mounted the component per read, so a
fresh render showed WARM even on the buggy code.
Rule: every new or changed case needs a red check against the pre-change code. `git stash` is blocked
by a hook here, so make a copy of HEAD instead: `git archive HEAD plugins/<p> | tar -x -C <scratch>`,
point the contract run at that copy, and confirm the new cases fail for the stated reason. This is
red-first TDD (Kent Beck; course notes https://www.cs.colorado.edu/~kena/classes/5828/s10/lectures/22_tdd.pdf,
as of 2026-10-15). Ask the tester to show it; ask the referee to verify it.

### (b) The referee can overturn a test and the builder's fit-to-test code
C36 (usage, compaction while a main step is in flight): the test expected WARM after the step, and the
builder added a `mainInFlight` guard to satisfy it. The referee (f27-30 Round 2, R2-1) ruled both
wrong: compaction replaces the prefix, so the next request pays a cold write and the state must stay
COLD until the next main step starts. Spec sentence replaced, guard removed, test rewritten. Neither
side "winning" by default is the point of the role.

### (c) Builders may fit code to a wrong test without knowing
The builder never sees tests, but it sees red names and the brief. The `mainInFlight` guard above was an
addition the brief did not ask for. Orchestrator habit: when a diff contains behaviour not in the brief
or spec, ask why before accepting, and send it to the referee if the answer is "a test wanted it".

### (d) Harness capability gaps hide bugs
F29: the real host redraws a component only when an atom it read changes. The harness re-mounted and
re-rendered on every read, so the missing invalidation was invisible. The referee asked for a "retained
mount" (`r.retained(...)`): mount once, re-render only on atom or tick changes. When a live bug escapes
a green suite, first ask what the fake host does more generously than the real one.

### (e) Flaky tests from unhandled hung promises
awareness `lifecycle.test.ts`: `void w.bash('make dist', { hang: true })` never settles; at teardown
the engine rejects it ("no implementation for tool.call") and nobody catches it, so the runner reports
a synthetic failing "file ran to its end", about 50% of runs (4/8 failed unmodified; 10/10 clean with
`.catch(() => {})`). Referee verdict: test-side bug, plugin untouched (`aw-ranto-end.md`). Rule: after
any green, require N consecutive green runs (we used 8-10) before calling a suite stable, and never
leave a fire-and-forget promise without a catch.

### (f) The orchestrator verifies claims itself
Builders reported "tsc not installed" and similar. Reports are not evidence. Run all six contracts,
`tsc`, and `sync-shared --check` yourself before shipping. (Known leftover: two pre-existing tsc errors
in dev, `diff.tsx` and `pulse.tsx`, found this way.) Verification is cheap: counts only, no test source.

### (g) Transient infra failures
A `git push` returned "(failure)" with no cause. Retry once. If it fails again, stop and report; do not
improvise (force flags, remote changes). Same for any flaky tool: one retry, then escalate.

### Smaller rules that paid off
- Briefs must be self-contained: dcg blocks risky phrases anywhere in a command, so put long prompts in
  files (`ROLES.md` + `ACCEPT-BRIEF.md` pattern).
- One shared ROLES file states who may read what; each brief references it instead of repeating it.
- Parallel builders touch only their own plugin folder; shared code changes go through
  `scripts/sync-shared.ts` and a `--check`.
- Tests that rule on screens need pixel-level or width-level assertions against the drawn slot, not
  just terminal text (C30).
- When the tester's behaviour wording leaks implementation names, the blind property is gone; keep
  tester briefs to commands, tools, options, messages.

## 5. Costs and when not to use it

- Multi-agent runs use about 15x the tokens of a chat, and work poorly where agents must share context
  (https://www.anthropic.com/engineering/multi-agent-research-system, 2025-06-13). The blind split only
  pays when the spec is the shared context and is precise.
- IV&V history says the same: independence pays most where requirement errors are expensive and the
  spec is stable; the fixed overhead hurts small efforts (NASA/NRC sources in research/14 section 1,
  [search]-level evidence).
- Skip it for: throwaway scripts, exploratory UI work with no stable spec, one-line fixes, anything
  where writing the behaviour spec costs more than the code.
- Refereeing is the expensive part. Reserve it for real disagreements and live-escaped bugs.

Cheap checks to add next (research/14 section 3):
1. **Red-first as a gate**: the tester proves each new case fails on the pre-change copy (lesson a),
   automated as a script that runs the suite against `git archive HEAD`.
2. **Mutation testing**: Stryker (https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/,
   score = detected / valid) for TS, mutmut (https://mutmut.readthedocs.io) for Python. Survivors point
   to weak assertions; do not chase 100% (Microsoft guidance, https://learn.microsoft.com/dotnet/core/testing/mutation-testing).
   Equivalent mutants add noise. Fits the code-blind rule: the mutation run reports a score and survivor
   locations, and a referee turns survivors into tester briefs.
3. **Property-style specs** where possible (https://hypothesis.works/articles/what-is-property-based-testing/,
   https://fast-check.dev/docs/introduction/what-is-property-based-testing/): properties are less
   sensitive to implementation detail than example tests.

## 6. Templates

Keep each brief to one scoped unit. Put long ones in a file and point to it.

### Builder brief
```
Role: BUILDER. Read ROLES.md. Never read <tests repo>.
Goal: <behaviour to achieve, one paragraph, and why it matters>
Repo/files: <exact paths you may change>; do not touch <paths>.
Decisions already made: <list>
Spec text to append to <spec file>: <verbatim clarification, if any>
Checks to run: <validate / tsc / sync-shared --check>
Live check: <exact command and expected output>, or "skip if X".
Acceptance: <observable outcomes>. Do not commit or push.
Stop and report instead of improvising if: <counter used elsewhere, host refuses, etc.>
Reply (max 12 lines): files changed, checks, live output.
```

### Tester brief
```
Role: TESTER. Read ROLES.md. Never read plugin source (<paths>, any .ts/.tsx). You may read the spec,
READMEs and host docs.
Spec: <path + section>. Clarification: <verbatim text>.
Add/change cases (behaviour terms only): <numbered list: given / when / expect, public names only>
Fake host must enforce: <host rules the real host enforces>
Red check: show every new case fails against <pre-change copy> and say why; report any that pass.
Stability: run the file N times; no flakes; every hung promise has a catch.
Run: scripts/run-contract.sh <plugin>. Commit in the tests repo with the standard trailer; do not push.
Reply (max 12 lines): case names, counts, which fail and why (behaviour terms).
```

### Referee brief
```
Role: REFEREE. You alone see code and tests. Edit nothing in either repo; read-only probes and
suite runs are fine.
Context: <what passed, what live acceptance found, evidence paths>
For each failure: (1) root cause with file:line, checked against host docs; (2) why the tests missed
it (no case, lenient fake host, case passes on old code, spec silent/wrong); (3) which side is wrong
(code, test, spec); (4) what each role must do.
Rule on contract vs behaviour, not code quality. Spec changes are decisions: propose text, the
orchestrator decides.
Write <out path> with exactly: ## Diagnosis (orchestrator only) / ## Builder brief (no test names) /
## Tester brief (no code identifiers) / ## Spec clarification (or "none") / ## Risk.
Reply in 5 lines: root causes and the file path. Stop.
```

### Orchestrator checklist after each round
1. All contracts green via `run-contract.sh`, repeated for any previously flaky suite.
2. `tsc` and `sync-shared --check` clean, run by you.
3. Diff reviewed for behaviour not in the brief (lesson c).
4. New cases have a red check on pre-change code (lesson a).
5. Spec updated; versions bumped; marketplace updated; commit per plugin.
