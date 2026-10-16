import type { Register } from 'claude-code'
import type { ChangeRow, CoverageView, FlakyView, GitView, PortRow, PortsUi, PrsView, TestRun, TypecheckView } from '../types'
import { createProcManager, probeHost, run as rawRun } from './_shared/proc'
import type { ProcManager, ProcOpts, ProcPorts, ProcResult, Runner } from './_shared/proc'
import { basename } from './_shared/fmt'
import type { Segment } from './_shared/band'

export type On = Parameters<Register>[0]
export type Options = Record<string, unknown>

/** What a render reads and a handler writes: every `$.state` atom of this plugin (declared in register.tsx). */
export type StateMap = {
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
export type Timer = { cancel: () => void }

/**
 * The facade of `$` that the mods use. `claude plugin validate` follows `$` only inside register.tsx, so register.tsx
 * builds this object (each member spells `$.noun.event(...)` itself) and the mods receive it instead of `$`.
 */
export type D = {
  clock: { now: () => Promise<number>; sleep: (ms: number) => Promise<void>; after: (ms: number, fn: () => void) => Timer; every: (ms: number, fn: () => void) => Timer }
  process: { run: (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }> }
  fs: { exists: (p: string) => Promise<boolean>; stat: (p: string) => Promise<{ kind?: string; size: number; mtimeMs: number }>; read: (p: string) => Promise<string> }
  session: { cwd: () => Promise<string>; id: () => Promise<string>; repo: () => Promise<any>; surfaces: () => Promise<readonly string[]> }
  store: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> }
  command: { list: () => Promise<{ name: string }[]>; register: (spec: { name: string; description: string; argumentHint?: string }) => Promise<unknown> }
  ui: {
    toast: (text: string, o?: { timeoutMs?: number }) => void
    status: (text: string | undefined) => void
    open: (a: { id: string; title?: string }) => Promise<unknown>
    panes: () => Promise<readonly { id: string }[]>
    resolve: (e: any) => any
  }
  /** Peer atoms (awareness) by literal ref; shaped like `$.state` for shared/toast.ts. */
  state: { get: (ref: { plugin: string; key: string }) => Promise<{ value?: any }> }
  read: <K extends keyof StateMap>(k: K) => Promise<StateMap[K]>
  update: <K extends keyof StateMap>(k: K, fn: (v: StateMap[K]) => StateMap[K]) => Promise<unknown>
}

export type ToolAfter = {
  e: any
  ran: any
  startedAt: number
  isMain: boolean
  ok: boolean
}
export type CmdSpec = { name: string; description: string; argumentHint?: string; run: ($: D, args: string) => Promise<{ text: string }> }
export type PaneSpec = { id: string; title: string; render: ($: D, e: any) => Promise<any> }

/** A mod. `register` adds the mod's own hooks (rarely needed: the lifecycle fields below are dispatched by register.tsx). */
export type Mod = {
  id: string
  start?: ($: D, e: any) => Promise<void>
  end?: ($: D, e: any) => Promise<void>
  cwdChanged?: ($: D) => Promise<void>
  /** After a tool call. May return `context` lines to append to that call's result. */
  tool?: ($: D, t: ToolAfter) => Promise<{ context?: string[] } | void>
  turn?: ($: D, e: any) => Promise<void>
  prompt?: ($: D) => Promise<void>
  tick?: ($: D, now: number) => Promise<void>
  segment?: ($: D, e: any) => Promise<Segment | null>
  commands?: CmdSpec[]
  panes?: PaneSpec[]
}

export const MODS = ['git', 'diff', 'pulse', 'coverage', 'typecheck', 'pr', 'ports'] as const
export type ModId = (typeof MODS)[number]

class Semaphore {
  private n = 0
  private q: (() => void)[] = []
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.n < this.max) { this.n++; return }
    await new Promise<void>(r => this.q.push(r))
  }
  release(): void {
    const next = this.q.shift()
    if (next) next()
    else this.n--
  }
}

/** Ports of the shared proc kit, from the `$` facade. */
const procPorts = ($: D): ProcPorts => ({ run: (argv, init) => $.process.run(argv, init), now: () => $.clock.now() })

export function createCtx(options: Options) {
  const o = options ?? {}
  // The spec names options with dots (`mod.git.enabled`); userConfig keys cannot hold dots, so the manifest
  // declares `mod_git_enabled`. Read either spelling (and camelCase) so settings and tests both work.
  const raw = (k: string): unknown => {
    for (const c of [k, k.replace(/\./g, '_'), k.replace(/\.(\w)/g, (_m, ch: string) => ch.toUpperCase())]) {
      if (o[c] !== undefined && o[c] !== null && o[c] !== '') return o[c]
    }
    return undefined
  }
  const num = (k: string, d: number): number => {
    const r = raw(k)
    const v = Number(r)
    return r === undefined || Number.isNaN(v) ? d : v
  }
  const bool = (k: string, d: boolean): boolean => {
    const r = raw(k)
    return typeof r === 'boolean' ? r : r === 'false' ? false : r === 'true' ? true : d
  }
  const str = (k: string, d: string): string => (typeof raw(k) === 'string' ? (raw(k) as string) : d)
  const modOn = (id: string): boolean => {
    if (!bool(`mod.${id}.enabled`, true)) return false
    if ((id === 'pr' || id === 'ports') && !bool(`${id}.enabled`, true)) return false
    return true
  }

  const sem = new Semaphore(2)
  let pm: ProcManager | undefined
  const rt = {
    init: undefined as Promise<void> | undefined,
    hostOk: true,
    probed: false,
    top: undefined as string | undefined,
    cwd: undefined as string | undefined,
    worktreeName: undefined as string | undefined,
    gitDir: undefined as string | undefined,
    isLinked: false,
    sid: 'session',
    startedAt: 0,
    lastInput: 0,
    worktrees: [] as string[],
    editCount: 0,
    touched: new Set<string>(),
    statusText: undefined as string | undefined,
    cmdNames: {} as Record<string, string>,
  }

  const getPm = ($: D): ProcManager => (pm ??= createProcManager(procPorts($)))

  const ctx = {
    /** Set by register.tsx: recompute the `$.ui.status` fallback after state changed. */
    onChange: (async () => undefined) as ($: D) => Promise<void>,
    o, num, bool, str, modOn, rt,
    /** Run a command in a breaker family; a family already running drops the call (`busy`). Global cap 2. */
    async proc($: D, family: string, argv: readonly string[], opts: ProcOpts & { isFailure?: (r: ProcResult) => boolean } = {}): Promise<ProcResult> {
      if (!rt.hostOk) return { ok: false, reason: 'no host' }
      await sem.acquire()
      try {
        return await getPm($).run(family, argv, opts)
      } finally {
        sem.release()
      }
    },
    /** Runner without a family lock (multi-step snapshot work), still under the global cap. */
    runner($: D, defaults: ProcOpts = {}): Runner {
      return async (argv, opts) => {
        if (!rt.hostOk) return { ok: false, reason: 'no host' }
        await sem.acquire()
        try {
          return await rawRun(procPorts($), argv, { ...defaults, ...opts })
        } finally {
          sem.release()
        }
      }
    },
    /** One-time repo context: probe, cwd, TOP, worktree. Idempotent until `resetRepo`. */
    ready($: D): Promise<void> {
      rt.init ??= (async () => {
        try { rt.startedAt ||= await $.clock.now() } catch { /* no clock */ }
        rt.hostOk = await probeHost(procPorts($))
        rt.probed = true
        await $.update('proc', () => ({ available: rt.hostOk })).catch(() => undefined)
        try { rt.cwd = await $.session.cwd() } catch { rt.cwd = undefined }
        try { rt.sid = (await $.session.id()) || 'session' } catch { /* keep */ }
        if (!rt.hostOk) return
        const top = await ctx.proc($, 'repo', ['git', 'rev-parse', '--show-toplevel'], { cwd: rt.cwd, timeoutMs: 5000 })
        rt.top = top.ok && top.exitCode === 0 && top.stdout.trim() ? top.stdout.trim().split('\n')[0] : undefined
        const gd = await ctx.proc($, 'repo', ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: rt.top ?? rt.cwd, timeoutMs: 5000 })
        if (gd.ok && gd.exitCode === 0) {
          const [dir, common] = gd.stdout.split('\n').map(s => s.trim())
          rt.gitDir = dir || undefined
          if (dir && common && dir !== common) {
            rt.isLinked = true
            rt.worktreeName = rt.top ? basename(rt.top) : basename(dir)
          }
        }
      })()
      return rt.init
    },
    resetRepo(): void {
      rt.init = undefined
      rt.top = undefined
      rt.cwd = undefined
      rt.worktreeName = undefined
      rt.isLinked = false
    },
    /** Directory for file lookups and git commands. */
    root: (): string | undefined => rt.top ?? rt.cwd,
    isIdle: (now: number): boolean => rt.lastInput > 0 && now - rt.lastInput > num('idleMinutes', 30) * 60_000,
    async safeNow($: D): Promise<number> {
      try { return await $.clock.now() } catch { return Date.now() }
    },
    async surfaces($: D): Promise<readonly string[]> {
      try { return (await $.session.surfaces()) as readonly string[] } catch { return ['terminal'] }
    },
  }
  return ctx
}
export type Ctx = ReturnType<typeof createCtx>

/**
 * Coalescing throttle for refresh work: triggers inside the window are absorbed into one trailing run, and runs are at
 * least `getMin()` ms apart. `inline` runs at once when allowed.
 */
export function createThrottle(getMin: () => number, work: ($: D) => Promise<void>) {
  let last = Number.NEGATIVE_INFINITY
  let timer: { cancel: () => void } | undefined
  let busy = false
  let again = false
  const exec = async ($: D): Promise<void> => {
    timer = undefined
    if (busy) return
    busy = true
    try {
      await work($)
    } catch {
      /* best effort */
    } finally {
      busy = false
      try { last = await $.clock.now() } catch { /* keep */ }
      if (again) {
        again = false
        void self.request($, 0, false)
      }
    }
  }
  const self = {
    now: exec,
    async request($: D, delayMs = 0, inline = false): Promise<void> {
      if (busy) { again = true; return }
      if (timer) return
      const now = await $.clock.now()
      const due = Math.max(now + delayMs, last + getMin())
      if (inline && due <= now) return exec($)
      timer = $.clock.after(Math.max(0, due - now), () => { void exec($) })
    },
    reset(): void {
      timer?.cancel()
      timer = undefined
      last = Number.NEGATIVE_INFINITY
      again = false
    },
  }
  return self
}
