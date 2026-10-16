import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { renderBand } from './_shared/band'
import type { Segment } from './_shared/band'
import { createCtx } from './core'
import type { Ctx, CmdSpec, D, Mod, PaneSpec, StateMap } from './core'
import { createCoverage } from './mods/coverage'
import { createDiff } from './mods/diff'
import { createGit } from './mods/git'
import { createPr } from './mods/pr'
import { createPorts } from './mods/ports'
import { createPulse } from './mods/pulse'
import { createTypecheck } from './mods/typecheck'

const TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit'])

// ---- state atoms: refs must be literals in this file (claude plugin validate reads them here) ----
const gitA = atom({ plugin: 'dev', key: 'git' } as const, null as StateMap['git'])
const runsA = atom({ plugin: 'dev', key: 'runs' } as const, [] as StateMap['runs'])
const flakyA = atom({ plugin: 'dev', key: 'flaky' } as const, { count: 0, names: [] } as StateMap['flaky'])
const coverageA = atom({ plugin: 'dev', key: 'coverage' } as const, null as StateMap['coverage'])
const prsA = atom({ plugin: 'dev', key: 'prs' } as const, { rows: [], state: 'loading' } as StateMap['prs'])
const portsA = atom({ plugin: 'dev', key: 'ports' } as const, [] as StateMap['ports'])
const portsUiA = atom({ plugin: 'dev', key: 'portsUi' } as const, {} as StateMap['portsUi'])
const changesA = atom({ plugin: 'dev', key: 'changes' } as const, { rows: [], files: 0, add: 0, del: 0, since: 0, toolsOnly: false } as StateMap['changes'])
const typecheckA = atom({ plugin: 'dev', key: 'typecheck' } as const, { errors: 0, other: 0, running: false, available: {} } as StateMap['typecheck'])
const procA = atom({ plugin: 'dev', key: 'proc' } as const, { available: true } as StateMap['proc'])
const toastA = atom({ plugin: 'dev', key: 'toast' } as const, { shown: 0, held: 0 } as StateMap['toast'])
const clockA = atom({ plugin: 'dev', key: 'clock' } as const, 0)

async function readKey($: EngineInterface, k: keyof StateMap): Promise<any> {
  switch (k) {
    case 'git': return read($, gitA)
    case 'runs': return read($, runsA)
    case 'flaky': return read($, flakyA)
    case 'coverage': return read($, coverageA)
    case 'prs': return read($, prsA)
    case 'ports': return read($, portsA)
    case 'portsUi': return read($, portsUiA)
    case 'changes': return read($, changesA)
    case 'typecheck': return read($, typecheckA)
    case 'proc': return read($, procA)
    case 'toast': return read($, toastA)
    case 'clock': return read($, clockA)
  }
}
async function updateKey($: EngineInterface, k: keyof StateMap, fn: (v: any) => any): Promise<unknown> {
  switch (k) {
    case 'git': return update($, gitA, fn)
    case 'runs': return update($, runsA, fn)
    case 'flaky': return update($, flakyA, fn)
    case 'coverage': return update($, coverageA, fn)
    case 'prs': return update($, prsA, fn)
    case 'ports': return update($, portsA, fn)
    case 'portsUi': return update($, portsUiA, fn)
    case 'changes': return update($, changesA, fn)
    case 'typecheck': return update($, typecheckA, fn)
    case 'proc': return update($, procA, fn)
    case 'toast': return update($, toastA, fn)
    case 'clock': return update($, clockA, fn)
  }
}

// Peer atoms (read-only slices of the awareness plugin). Literal refs, one case each.
async function peerGet($: EngineInterface, ref: { plugin: string; key: string }): Promise<{ value?: any }> {
  if (ref.plugin === 'awareness' && ref.key === 'headsup') return $.state.get({ plugin: 'awareness', key: 'headsup' } as const)
  if (ref.plugin === 'awareness' && ref.key === 'focus') return $.state.get({ plugin: 'awareness', key: 'focus' } as const)
  return { value: undefined }
}

/** The facade of `$` that core.ts, the mods and shared/*.ts use (they never see `$` itself). */
function mkD($: EngineInterface): D {
  return {
    clock: {
      now: () => $.clock.now(),
      sleep: ms => $.clock.sleep(ms),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    process: { run: (argv, init) => $.process.run(argv, init) },
    fs: {
      exists: p => $.fs.exists(p),
      stat: p => $.fs.stat(p),
      read: async p => (await $.fs.read(p)) as string,
    },
    session: {
      cwd: () => $.session.cwd(),
      id: () => $.session.id(),
      repo: () => $.session.repo(),
      surfaces: () => $.session.surfaces(),
    },
    store: { get: k => $.store.get(k), set: (k, v) => $.store.set(k, v) },
    command: { list: () => $.command.list(), register: s => $.command.register(s) },
    ui: {
      toast: (t, o) => $.ui.toast(t, o),
      status: t => $.ui.status(t),
      open: a => $.ui.open(a),
      panes: () => $.ui.panes(),
      resolve: e => $.ui.resolve(e),
    },
    state: { get: ref => peerGet($, ref) },
    read: k => readKey($, k),
    update: (k, fn) => updateKey($, k, fn as (v: any) => any),
  }
}

// `d.ui.status` fallback: one line per plugin.
async function statusUpdate(d: D, ctx: Ctx, mods: Mod[]): Promise<void> {
  try {
    const has = (id: string): boolean => mods.some(m => m.id === id)
    let text: string | undefined
    if (ctx.rt.probed && !ctx.rt.hostOk) text = 'dev: needs host commands'
    else {
      const bits: string[] = []
      if (has('git')) {
        const g = await d.read('git')
        if (g && !g.error) bits.push(`${g.branch}${g.staged + g.unstaged + g.untracked + g.conflicts > 0 ? '*' : ''}`)
      }
      if (has('pulse')) {
        const rs = await d.read('runs')
        const r = rs[rs.length - 1]
        if (r) bits.push(r.hasSummary ? `${r.pass} pass${r.fail ? ` ${r.fail} fail` : ''}` : 'ran, no summary')
      }
      if (has('typecheck')) {
        const v = await d.read('typecheck')
        for (const [k, n] of Object.entries(v.byKind ?? {})) if (n > 0) bits.push(`${n} ${k} ${n === 1 ? 'error' : 'errors'}`)
        for (const [k, ok] of Object.entries(v.available)) if (ok === false) bits.push(`${k}: n/a`)
      }
      text = bits.length ? bits.join(' · ') : undefined
    }
    if (text !== ctx.rt.statusText) {
      ctx.rt.statusText = text
      d.ui.status(text)
    }
  } catch {
    /* status is best effort */
  }
}

async function startMods(d: D, e: any, ctx: Ctx, mods: Mod[]): Promise<void> {
  const now = await ctx.safeNow(d)
  ctx.rt.lastInput = now
  ctx.rt.startedAt = now
  await ctx.ready(d)
  for (const m of mods) {
    try { await m.start?.(d, e) } catch { /* one mod never stops the others */ }
  }
  await statusUpdate(d, ctx, mods)
}

async function registerCommands(d: D, mods: Mod[]): Promise<void> {
  let taken = new Set<string>()
  try { taken = new Set((await d.command.list()).map(c => c.name)) } catch { /* no list: assume free */ }
  for (const m of mods) {
    for (const c of m.commands ?? []) {
      const name = taken.has(c.name) ? `dev-${c.name}` : c.name
      try { await d.command.register({ name, description: c.description, argumentHint: c.argumentHint }) } catch { /* refused name */ }
    }
  }
}

async function tickAll(d: D, ctx: Ctx, mods: Mod[], clockState: { last: number }): Promise<void> {
  const now = await ctx.safeNow(d)
  for (const m of mods) {
    if (!m.tick) continue
    try { await m.tick(d, now) } catch { /* next tick */ }
  }
  if (now - clockState.last >= 30_000) {
    clockState.last = now
    try { await d.update('clock', () => now) } catch { /* redraw only */ }
  }
}

async function dispatchTool(d: D, e: any, ran: any, startedAt: number, ctx: Ctx, mods: Mod[]): Promise<any> {
  const t = { e, ran, startedAt, isMain: e.agentId === undefined, ok: ran.isError !== true }
  const outs = await Promise.all(mods.map(m => (m.tool ? m.tool(d, t).catch(() => undefined) : undefined)))
  const lines = outs.flatMap(o => (o && o.context ? o.context : []))
  await statusUpdate(d, ctx, mods)
  return lines.length ? { ...ran, context: [...(ran.context ?? []), ...lines] } : ran
}

async function drawBand(d: D, e: any, next: any, ctx: Ctx, mods: Mod[]): Promise<any> {
  const p = e.props
  if (p.hasSurvey || p.view?.agentId || p.maxRows < ctx.num('minBandRows', 4)) return next(e)
  const segs: (Segment | null)[] = []
  for (const m of mods) {
    if (!m.segment) continue
    try { segs.push(await m.segment(d, e)) } catch { /* skip chip */ }
  }
  return renderBand({ resolve: x => d.ui.resolve(x) }, e, next, { segments: segs, minBandRows: ctx.num('minBandRows', 4) })
}

export const register: Register = (on, options) => {
  const ctx = createCtx((options ?? {}) as Record<string, unknown>)
  const mods: Mod[] = []
  const add = (id: string, make: (c: Ctx) => Mod): void => {
    if (ctx.modOn(id)) mods.push(make(ctx))
  }
  // Disabled mods are never created: they register nothing and draw nothing.
  add('git', createGit)
  add('diff', createDiff)
  add('pulse', createPulse)
  add('coverage', createCoverage)
  add('typecheck', createTypecheck)
  add('pr', createPr)
  add('ports', createPorts)

  ctx.onChange = d => statusUpdate(d, ctx, mods)
  let driver: { cancel: () => void } | undefined
  const clockState = { last: 0 }

  on('session.start', async (s$, e, next) => {
    const r = await next(e)
    const d = mkD(s$)
    try {
      await registerCommands(d, mods)
      await startMods(d, e, ctx, mods)
      if (!driver && mods.some(m => m.tick)) {
        driver = d.clock.every(5000, () => { void tickAll(d, ctx, mods, clockState).catch(() => undefined) })
      }
    } catch {
      /* never block the session */
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async (s$, e, next) => {
    const d = mkD(s$)
    try {
      for (const m of mods) {
        try { await m.end?.(d, e) } catch { /* keep going */ }
      }
      if ((e as any).reason === 'clear') {
        ctx.resetRepo()
        ctx.rt.touched.clear()
        await startMods(d, e, ctx, mods)
      }
    } catch {
      /* observer */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.CwdChanged', async (s$, e, next) => {
    const d = mkD(s$)
    try {
      ctx.resetRepo()
      await ctx.ready(d)
      for (const m of mods) {
        try { await m.cwdChanged?.(d) } catch { /* keep going */ }
      }
    } catch {
      /* observer */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async (s$, e, next) => {
    const d = mkD(s$)
    try {
      ctx.rt.lastInput = await ctx.safeNow(d)
      for (const m of mods) {
        try { await m.prompt?.(d) } catch { /* keep going */ }
      }
    } catch {
      /* observer */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async (s$, e, next) => {
    const r = await next(e)
    const d = mkD(s$)
    try {
      if ((e as any).agentId === undefined) {
        await Promise.all(mods.map(m => (m.turn ? m.turn(d, e).catch(() => undefined) : undefined)))
        await statusUpdate(d, ctx, mods)
      }
    } catch {
      /* observer */
    }
    return r
  }).catch(($, e, next) => next(e))

  // One tool dispatcher, after `next`. It only ever adds Typecheck Feedback's `context`.
  on('tool.call', async (s$, e, next) => {
    if (!TOOLS.has(String((e as any).tool))) return next(e)
    const d = mkD(s$)
    const startedAt = await ctx.safeNow(d)
    const ran: any = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      return await dispatchTool(d, e, ran, startedAt, ctx, mods)
    } catch {
      return ran
    }
  }).catch(($, e, next) => next(e))

  const cmds: CmdSpec[] = mods.flatMap(m => m.commands ?? [])
  for (const c of cmds) {
    for (const name of [c.name, `dev-${c.name}`]) {
      on('command.run', { command: name }, async (s$, e) => {
        try {
          return await c.run(mkD(s$), String((e as any).args ?? ''))
        } catch {
          return { text: `${c.name}: failed. Try again.` }
        }
      }).catch(() => ({ text: `${c.name}: failed. Try again.` }))
    }
  }

  const panes: PaneSpec[] = mods.flatMap(m => m.panes ?? [])
  for (const p of panes) {
    on('ui.render', { component: 'Pane', requestId: p.id }, async (s$, e, next) => {
      try {
        return await p.render(mkD(s$), e)
      } catch {
        return next(e)
      }
    })
  }

  on('ui.render', { component: 'AbovePrompt' }, (s$, e, next) => drawBand(mkD(s$), e, next, ctx, mods)).catch(($, e, next) => next(e))
}
