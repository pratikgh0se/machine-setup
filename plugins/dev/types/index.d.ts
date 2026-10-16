export type GitView = {
  branch: string
  detached?: boolean
  upstream?: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
  worktree?: string
  /** True when the last `git status` failed (chip shows `git: error`). */
  error?: boolean
}

export type TestRun = {
  at: number
  runner: string
  pass: number
  fail: number
  skip: number
  durationMs?: number
  failed: string[]
  hasSummary: boolean
  /** Successful edits since this run. */
  editsSince: number
  /** 'pkgs' when a go run counted packages. */
  unit?: 'tests' | 'pkgs'
  /** No summary parsed; the exit status says the run failed (fail=1). */
  exitOnly?: boolean
  exitCode?: number
  /** No summary parsed; the run exited cleanly. */
  exitOk?: boolean
}

export type CoverageView = {
  pct: number
  metric: 'lines' | 'statements'
  base?: number
  delta?: number
  at: number
  file: string
  baseKind: 'session-first' | 'last-clean'
  baseAt?: number
}

export type PrRow = {
  worktree: string
  branch: string
  mine?: boolean
  number?: number
  title?: string
  url?: string
  checks: 'pass' | 'pending' | 'fail' | 'none'
  review: 'approved' | 'changes' | 'pending' | 'none'
  mergeable?: 'ok' | 'conflict' | 'unknown'
  state?: 'open' | 'merged' | 'closed'
  /** True for the worktree the session runs in. */
  current?: boolean
}

export type PortRow = { pid: number; port: number; cmd: string; cwd?: string; firstSeen: number; ours: boolean }

export type ChangeRow = { path: string; status: 'A' | 'M' | 'D' | 'R'; add: number; del: number; bin?: boolean; touched?: boolean }

export type TypecheckView = {
  errors: number
  other: number
  lastRunAt?: number
  kind?: 'tsc' | 'ruff' | 'eslint'
  running: boolean
  available: Record<string, boolean>
  /** Errors per checker, for the chip. */
  byKind?: Record<string, number>
  fedBack?: boolean
}

export type PrsView = { rows: PrRow[]; state: string; at?: number; until?: number; intervalMs?: number }
export type PortsUi = { armed?: { pid: number; port: number; until: number }; note?: string }
export type FlakyView = { count: number; names: { name: string; flips: number }[] }

declare module 'claude-code' {
  interface PluginState {
    dev: {
      git: GitView | null
      runs: TestRun[]
      flaky: FlakyView
      coverage: CoverageView | null
      prs: PrsView
      ports: PortRow[]
      portsUi: PortsUi
      changes: { rows: ChangeRow[]; files: number; add: number; del: number; since: number; toolsOnly: boolean }
      typecheck: TypecheckView
      proc: { available: boolean }
      toast: { lastShownAt?: number; shown: number; held: number }
      clock: number
    }
    /** Read-only slice of the awareness plugin's atoms (quiet mode, Heads-Up spacing). */
    awareness: {
      headsup: { mutedUntil?: number; queued: string[]; lastShownAt?: number; shown: number }
      focus: { phase: 'idle' | 'focus' | 'break' | 'paused'; endsAt?: number; remainingMs?: number; count: number; ofTotal: number }
    }
  }
}
