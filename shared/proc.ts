// Process execution wrapper (conventions s8). Never throws. $-free: takes ports (see shared/NOTES.md, "Ports pattern").
// register.tsx builds `ProcPorts` from `$`: { run: (argv, init) => $.process.run(argv, init), now: () => $.clock.now() }.

export type ProcPorts = {
  run: (argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  now: () => Promise<number>
}

export type ProcOpts = { cwd?: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string }
export type ProcResult =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; reason: string }

export const DEFAULT_TIMEOUT_MS = 10_000

/** `ports.run` with rejects turned into `{ok:false, reason}`; default timeout 10 s. `ok` means it ran, not exit 0. */
export async function run(ports: ProcPorts, argv: readonly string[], opts: ProcOpts = {}): Promise<ProcResult> {
  try {
    const r = await ports.run(argv, { cwd: opts.cwd, env: opts.env, stdin: opts.stdin, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS })
    return { ok: true, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch (err) {
    return { ok: false, reason: String((err as { message?: string } | undefined)?.message ?? err).slice(0, 200) }
  }
}

/** True when the command ran and exited 0. */
export const isOk = (r: ProcResult): r is Extract<ProcResult, { ok: true }> => r.ok && r.exitCode === 0

/** Runner bound to ports and defaults: what snapshot.ts takes. */
export type Runner = (argv: readonly string[], opts?: ProcOpts) => Promise<ProcResult>
export const bindRunner = (ports: ProcPorts, defaults: ProcOpts = {}): Runner => (argv, opts) => run(ports, argv, { ...defaults, ...opts })

/** Defensive capability probe (`git --version`), run once per session. */
export async function probeHost(ports: ProcPorts): Promise<boolean> {
  const r = await run(ports, ['git', '--version'], { timeoutMs: 5000 })
  return r.ok
}

type Family = { fails: number; pausedUntil: number; pauses: number; running: boolean }
const PAUSE_STEPS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000]

/**
 * Circuit breaker per command family (conventions s8.2): 3 consecutive failures pause 5 min, then 15,
 * cap 60; reset on success; a running family drops new requests. Failure = `ok:false` or non-zero exit
 * unless `isFailure` says otherwise. Optional global cap on concurrent runs (dev: 2).
 */
export function createProcManager(ports: ProcPorts, opts: { maxConcurrent?: number } = {}) {
  const fams = new Map<string, Family>()
  let active = 0
  const fam = (name: string): Family => {
    let f = fams.get(name)
    if (!f) fams.set(name, (f = { fails: 0, pausedUntil: 0, pauses: 0, running: false }))
    return f
  }
  return {
    /** Result `{ok:false, reason:'paused'|'busy'}` when the breaker or single-instance rule drops the call. */
    async run(family: string, argv: readonly string[], o: ProcOpts & { isFailure?: (r: ProcResult) => boolean } = {}): Promise<ProcResult> {
      const f = fam(family)
      const now = await ports.now()
      if (now < f.pausedUntil) return { ok: false, reason: 'paused' }
      if (f.running || (opts.maxConcurrent != null && active >= opts.maxConcurrent)) return { ok: false, reason: 'busy' }
      f.running = true
      active++
      try {
        const r = await run(ports, argv, o)
        const failed = o.isFailure ? o.isFailure(r) : !r.ok
        if (failed) {
          f.fails++
          if (f.fails >= 3) {
            f.pausedUntil = (await ports.now()) + (PAUSE_STEPS_MS[Math.min(f.pauses, PAUSE_STEPS_MS.length - 1)] as number)
            f.pauses++
            f.fails = 0
          }
        } else {
          f.fails = 0
          f.pauses = 0
        }
        return r
      } finally {
        f.running = false
        active--
      }
    },
    status(family: string): { paused: boolean; pausedUntil: number; running: boolean } {
      const f = fam(family)
      return { paused: f.pausedUntil > 0, pausedUntil: f.pausedUntil, running: f.running }
    },
    reset(family?: string): void {
      if (family) fams.delete(family)
      else fams.clear()
    },
  }
}
export type ProcManager = ReturnType<typeof createProcManager>
