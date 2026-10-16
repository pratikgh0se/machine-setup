// Test-runner output parsers (dev.md s5). Pure. Used by dev (Test Pulse) and agents (Review Queue).
import { stripAnsi } from './fmt'

export type Runner = 'pytest' | 'vitest' | 'jest' | 'bun' | 'go' | 'cargo' | 'unknown'
export type TestResult = { runner: Runner; pass: number; fail: number; skip: number; durationMs?: number; failed: string[]; hasSummary: boolean; unit?: 'tests' | 'pkgs' }
/** Exit-status fallback for a recognised runner with no parsed summary. */
export type ExitStatus = { failed: boolean; code?: number }

const RE: [Runner, RegExp][] = [
  ['pytest', /(?:^|[\s;&|])(?:py\.test|pytest|python3?\s+-m\s+pytest|uv\s+run\s+pytest)\b/],
  ['vitest', /\bvitest\b/],
  ['jest', /\bjest\b/],
  ['bun', /\bbun\s+test\b/],
  ['go', /\bgo\s+test\b/],
  ['cargo', /\bcargo\s+(?:test|nextest\s+run)\b/],
  ['unknown', /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/],
]
/** Runner named by the command, or undefined when the command is not a test run. `unknown` = npm/pnpm/yarn test (try all). */
export function detectRunner(command: string): Runner | undefined {
  for (const [r, re] of RE) if (re.test(command)) return r
  return undefined
}

/** Commands that count as VERIFY for the phase chip: test runners, typecheck, lint, build, `git diff`. */
export function isVerifyCommand(command: string): boolean {
  if (detectRunner(command)) return true
  return /\b(?:tsc|mypy|pyright|ruff|eslint|biome|flake8|clippy|golangci-lint)\b|\bgit\s+diff\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|lint|build|check)\b|\bcargo\s+(?:check|build|clippy)\b|\bgo\s+(?:build|vet)\b|\bmake\s+(?:test|check|build|lint)\b/.test(command)
}

const num = (s: string | undefined): number => (s ? parseInt(s, 10) : 0)
const secs = (s: string | undefined, unit = 's'): number | undefined => {
  if (!s) return undefined
  const v = parseFloat(s)
  return isNaN(v) ? undefined : Math.round(unit === 'ms' ? v : v * 1000)
}
const empty = (runner: Runner): TestResult => ({ runner, pass: 0, fail: 0, skip: 0, failed: [], hasSummary: false })

/** Token counts of an RTK one-line summary (`N passed, M failed ...`), any order. */
function rtkTokens(line: string, r: TestResult): void {
  for (const m of line.matchAll(/(\d+)\s+(passed|failed|skipped|errors?)\b/g)) {
    const n = num(m[1])
    if (m[2] === 'passed') r.pass += n
    else if (m[2] === 'skipped') r.skip += n
    else r.fail += n
  }
}

function pytest(t: string): TestResult | undefined {
  const r = empty('pytest')
  const lines = t.split('\n')
  const rtk = lines.find(l => /^\s*Pytest:/i.test(l))
  if (rtk) {
    if (/no tests collected|no tests ran/i.test(rtk) || /\d+\s+(?:passed|failed|skipped|errors?)\b/.test(rtk)) {
      rtkTokens(rtk, r)
      for (const l of lines) { const m = /^\s*(?:FAILED|\[FAIL\])\s+(\S+)/.exec(l); if (m) r.failed.push(m[1] as string) }
      r.hasSummary = true
      return r
    }
  }
  const sum = [...lines].reverse().find(l => /\b\d+ (passed|failed|skipped|errors?)\b/.test(l) && /\bin \d/.test(l))
  if (!sum) return undefined
  for (const m of sum.matchAll(/(\d+) (passed|failed|skipped|errors?)/g)) {
    const n = num(m[1])
    if (m[2] === 'passed') r.pass += n
    else if (m[2] === 'skipped') r.skip += n
    else r.fail += n
  }
  r.durationMs = secs(/\bin ([\d.]+)s/.exec(sum)?.[1])
  for (const l of lines) { const m = /^FAILED (\S+)/.exec(l); if (m) r.failed.push(m[1] as string) }
  r.hasSummary = true
  return r
}
function vitest(t: string): TestResult | undefined {
  const m = /^\s*Tests\s+(.*)$/m.exec(t)
  if (!m) return undefined
  const r = empty('vitest')
  for (const x of (m[1] as string).matchAll(/(\d+) (passed|failed|skipped|todo)/g)) {
    const n = num(x[1])
    if (x[2] === 'passed') r.pass += n
    else if (x[2] === 'failed') r.fail += n
    else r.skip += n
  }
  const d = /^\s*Duration\s+([\d.]+)(ms|s)/m.exec(t)
  r.durationMs = secs(d?.[1], d?.[2])
  for (const l of t.split('\n')) {
    const a = /^\s*FAIL\s+(.+?)\s*$/.exec(l) ?? /^\s*[×✗]\s+(.+?)(?:\s+\d+ms)?\s*$/.exec(l)
    if (a) r.failed.push(a[1] as string)
  }
  r.hasSummary = true
  return r
}
function jest(t: string): TestResult | undefined {
  const m = /^Tests:\s+(.*)$/m.exec(t)
  if (!m) return undefined
  const r = empty('jest')
  for (const x of (m[1] as string).matchAll(/(\d+) (passed|failed|skipped|todo)/g)) {
    const n = num(x[1])
    if (x[2] === 'passed') r.pass += n
    else if (x[2] === 'failed') r.fail += n
    else r.skip += n
  }
  r.durationMs = secs(/^Time:\s+([\d.]+)\s*s/m.exec(t)?.[1])
  for (const l of t.split('\n')) { const a = /^\s*●\s+(.+?)\s*$/.exec(l); if (a && !/Console|obsolete/.test(a[1] as string)) r.failed.push(a[1] as string) }
  r.hasSummary = true
  return r
}
function bun(t: string): TestResult | undefined {
  const pass = /^\s*(\d+) pass\b/m.exec(t)
  const fail = /^\s*(\d+) fail\b/m.exec(t)
  if (!pass && !fail) return undefined
  const r = empty('bun')
  r.pass = num(pass?.[1]); r.fail = num(fail?.[1]); r.skip = num(/^\s*(\d+) skip\b/m.exec(t)?.[1])
  const d = /Ran \d+ tests? across \d+ files?\.\s*\[([\d.]+)(ms|s)\]/.exec(t)
  r.durationMs = secs(d?.[1], d?.[2])
  for (const l of t.split('\n')) { const a = /^\(fail\)\s+(.+?)(?:\s+\[[\d.]+ms\])?\s*$/.exec(l); if (a) r.failed.push(a[1] as string) }
  r.hasSummary = true
  return r
}
/**
 * go test is verbose when the command has `-v` / `-test.v`, or the output has `--- PASS:` or `=== RUN`. A lone
 * `--- FAIL:` does not mean verbose (a package-mode failure prints one). Pure; `command` may be empty.
 */
export function isGoVerbose(command: string, output: string): boolean {
  return /(?:^|\s)-(?:test\.)?v(?:\s|=|$)/.test(command) || /^\s*--- PASS:/m.test(output) || /^\s*=== RUN/m.test(output)
}

/** Package-count form (`ok`/`FAIL` lines, failing test names from `--- FAIL:`); undefined when verbose or no package line. */
export function parseGo(command: string, output: string): TestResult | undefined {
  const t = stripAnsi(output)
  if (isGoVerbose(command, t)) return undefined
  const r = empty('go')
  r.unit = 'pkgs'
  for (const l of t.split('\n')) {
    const m = /^(ok|FAIL)\s+\S+\s+([\d.]+)s/.exec(l)
    if (m) { r.hasSummary = true; if (m[1] === 'ok') r.pass++; else r.fail++; r.durationMs = (r.durationMs ?? 0) + Math.round(parseFloat(m[2] as string) * 1000) }
    const f = /^\s*--- FAIL: (\S+)/.exec(l)
    if (f) r.failed.push(f[1] as string)
  }
  return r.hasSummary ? r : undefined
}

/** RTK-rewritten go output: `Go test: P passed, F failed in K packages`, `[FAIL] Name`, `Go test: No tests found`. */
function goRtk(t: string): TestResult | undefined {
  const lines = t.split('\n')
  const sum = lines.find(l => /^\s*Go test:/i.test(l))
  if (!sum) return undefined
  const r = empty('go')
  r.unit = 'tests'
  if (/no tests found/i.test(sum)) { r.hasSummary = true; return r }
  if (!/\d+\s+(?:passed|failed|skipped)\b/.test(sum)) return undefined
  rtkTokens(sum, r)
  for (const l of lines) { const m = /^\s*\[FAIL\]\s+(\S+)/.exec(l); if (m) r.failed.push(m[1] as string) }
  r.hasSummary = true
  return r
}

function go(t: string, command = ''): TestResult | undefined {
  const rtk = goRtk(t)
  if (rtk) return rtk
  const pkgs = parseGo(command, t)
  if (pkgs) return pkgs
  const lines = t.split('\n')
  const r = empty('go')
  let any = false
  for (const l of lines) {
    const m = /^\s*--- (PASS|FAIL|SKIP): (\S+)/.exec(l)
    if (!m) continue
    any = true
    if (m[1] === 'PASS') r.pass++
    else if (m[1] === 'SKIP') r.skip++
    else { r.fail++; r.failed.push(m[2] as string) }
  }
  if (!any) return undefined
  r.unit = 'tests'
  r.hasSummary = true
  return r
}
function cargo(t: string): TestResult | undefined {
  const r = empty('cargo')
  let any = false
  for (const m of t.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;.*?finished in ([\d.]+)s/g)) {
    any = true
    r.pass += num(m[1]); r.fail += num(m[2]); r.skip += num(m[3]); r.durationMs = (r.durationMs ?? 0) + Math.round(parseFloat(m[4] as string) * 1000)
  }
  if (!any) return undefined
  for (const l of t.split('\n')) { const m = /^test (\S+) \.\.\. FAILED/.exec(l); if (m) r.failed.push(m[1] as string) }
  r.hasSummary = true
  return r
}
const PARSERS: Record<Exclude<Runner, 'unknown'>, (t: string, command?: string) => TestResult | undefined> = { pytest, vitest, jest, bun, go, cargo }

/**
 * Parse output for `runner` (`unknown` tries all). No summary found -> `{hasSummary:false}` ("ran, no summary").
 * ANSI is stripped. Pass stdout + stderr joined. `command` (optional) decides go verbosity together with the output.
 */
export function parseTestOutput(runner: Runner, output: string, command = ''): TestResult {
  const t = stripAnsi(output)
  const order = runner === 'unknown' ? (Object.keys(PARSERS) as (keyof typeof PARSERS)[]) : [runner]
  for (const k of order) {
    const r = PARSERS[k](t, command)
    if (r) return r
  }
  return empty(runner)
}

/** Convenience: detect + parse a Bash result. undefined when the command is not a test run. */
export function parseBashTest(command: string, stdout: string, stderr = ''): TestResult | undefined {
  const runner = detectRunner(command)
  return runner ? parseTestOutput(runner, stdout + '\n' + stderr, command) : undefined
}

/**
 * Exit status from a tool result: Claude prepends `Exit code <n>` on failure. Non-zero code or `isError` -> failed.
 * Returns undefined when the status is unknown (no marker and no flag information).
 */
export function exitStatus(text: string, isError?: boolean): ExitStatus | undefined {
  const m = /^\s*Exit code (\d+)/.exec(stripAnsi(text))
  if (m) { const code = parseInt(m[1] as string, 10); return code !== 0 ? { failed: true, code } : { failed: false, code: 0 } }
  if (isError === true) return undefined
  if (isError === false) return { failed: false }
  return undefined
}
