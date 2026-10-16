// awareness: Heads-Up (+ Long Command Timer), Now Doing, Spec Tracker, Focus Timer.
// Constraints of `claude plugin validate`: one module per plugin, one matcher-less hook per event, and `$` is followed
// only inside the file that holds the hooks. So this file owns every hook and builds the `D` facade of `$` (mkD) that
// the mods use; the mods hold the logic and never see `$`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Segment } from './_shared/band'
import { focusCommand, focusSegments, focusStart, focusTick } from './mods/focus'
import {
  headsupOnFocusEnd, huClassicStart, huCommand, huCompact, huFork, huMeasure, huModelSwitch, huPrompt, huSpawn,
  huStart, huStepAfter, huStepBefore, huTick, huToolAfter, huToolBefore, huToolFinally, huTurnComplete, huTurnStart,
} from './mods/headsup'
import {
  ndCommand, ndPrompt, ndSegments, ndSessionEnd, ndStepAfter, ndStepChunk, ndStepEnd, ndStepObs, ndTick, ndToolAfter, ndToolBefore, ndToolEarly, ndToolFinally,
  ndTurnComplete, ndTurnStart,
} from './mods/nowdoing'
import { spCommand, spToolAfter, spTurnComplete } from './mods/spec'
import { EMPTY_FOCUS, EMPTY_HEADSUP, EMPTY_ND, EMPTY_NOW, EMPTY_SPEC } from './lib/atoms'
import type { D, StateMap } from './lib/d'
import { renderBand } from './_shared/band'
import { statusSink } from './lib/nowview'
import { sched } from './lib/sched'
import { modEnabled, optBool, optNum } from './lib/opts'
import type { ModId, Rt } from './lib/rt'

const META: readonly { id: ModId; desc: string; hint: string }[] = [
  { id: 'focus', desc: 'Pomodoro focus timer; Heads-Up stays quiet while it runs', hint: 'start [min] | pause | resume | stop | skip | status' },
  { id: 'headsup', desc: 'Heads-Up toasts: status, mute, unmute, test', hint: 'status | mute <dur> | unmute | test <id>' },
  { id: 'nowdoing', desc: 'Show what the agent is doing now', hint: 'status | reset' },
  { id: 'spec', desc: 'Track checkbox progress of a plan or spec file', hint: '<path> | clear' },
]
const COMMANDS = ['focus', 'headsup', 'spec', 'nowdoing'] as const

// ---- state atoms: refs must be literals in this file (claude plugin validate reads them here) ----
const nowA = atom({ plugin: 'awareness', key: 'now' } as const, EMPTY_NOW)
const focusA = atom({ plugin: 'awareness', key: 'focus' } as const, EMPTY_FOCUS)
const headsupA = atom({ plugin: 'awareness', key: 'headsup' } as const, EMPTY_HEADSUP)
const clockA = atom({ plugin: 'awareness', key: 'clock' } as const, 0)
const ndA = atom({ plugin: 'awareness', key: 'nd' } as const, EMPTY_ND)
const spA = atom({ plugin: 'awareness', key: 'sp' } as const, EMPTY_SPEC)

async function readKey($: EngineInterface, k: keyof StateMap): Promise<any> {
  switch (k) {
    case 'now': return read($, nowA)
    case 'focus': return read($, focusA)
    case 'headsup': return read($, headsupA)
    case 'clock': return read($, clockA)
    case 'nd': return read($, ndA)
    case 'sp': return read($, spA)
  }
}
async function updateKey($: EngineInterface, k: keyof StateMap, fn: (v: any) => any): Promise<unknown> {
  switch (k) {
    case 'now': return update($, nowA, fn)
    case 'focus': return update($, focusA, fn)
    case 'headsup': return update($, headsupA, fn)
    case 'clock': return update($, clockA, fn)
    case 'nd': return update($, ndA, fn)
    case 'sp': return update($, spA, fn)
  }
}

// Peer atoms read by shared/toast.ts (literal refs, one case each): own focus + headsup, dev's toast, compact's coach.
async function peerGet($: EngineInterface, ref: { plugin: string; key: string }): Promise<{ value?: any }> {
  if (ref.plugin === 'awareness' && ref.key === 'headsup') return $.state.get({ plugin: 'awareness', key: 'headsup' } as const)
  if (ref.plugin === 'awareness' && ref.key === 'focus') return $.state.get({ plugin: 'awareness', key: 'focus' } as const)
  if (ref.plugin === 'dev' && ref.key === 'toast') return $.state.get({ plugin: 'dev', key: 'toast' } as const)
  if (ref.plugin === 'compact' && ref.key === 'coach') return $.state.get({ plugin: 'compact', key: 'coach' } as const)
  return { value: undefined }
}

/** The facade of `$` that every other file uses (they never see `$` itself). */
function mkD($: EngineInterface): D {
  return {
    clock: {
      now: () => $.clock.now(),
      sleep: (ms, o) => $.clock.sleep(ms, o),
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
    },
    process: { run: (argv, init) => $.process.run(argv, init) },
    fs: { stat: p => $.fs.stat(p), read: async p => (await $.fs.read(p)) as string },
    session: { cwd: () => $.session.cwd(), id: () => $.session.id(), surfaces: () => $.session.surfaces() },
    store: { get: k => $.store.get(k), set: (k, v) => $.store.set(k, v) },
    command: { list: () => $.command.list() },
    agent: { list: () => $.agent.list() },
    settings: { read: () => $.settings.read() },
    http: { fetch: url => $.http.fetch(url) },
    vaultPath: () => $.env.get('OBSIDIAN_VAULT_PATH'),
    audio: { play: c => $.audio.play(c) },
    ui: {
      toast: (t, o) => $.ui.toast(t, o),
      status: t => $.ui.status(t),
      notify: (t, o) => $.ui.notify(t, o),
      resolve: e => $.ui.resolve(e),
      invalidate: () => $.ui.invalidate('ui.render'),
    },
    state: { get: ref => peerGet($, ref) },
    setClock: n => $.state.set({ plugin: 'awareness', key: 'clock' } as const, n),
    read: k => readKey($, k),
    update: (k, fn) => updateKey($, k, fn as (v: any) => any),
  }
}

// ---- module state (caches only) ---------------------------------------------------------------------------
const rt: Rt = {
  options: {},
  cwd: '',
  names: { focus: 'focus', headsup: 'headsup', spec: 'spec', nowdoing: 'nowdoing' },
  sid: 'session',
  hu: { onFocusEnd: async () => undefined },
}
let active: readonly ModId[] = []
let FOCUS = false
let HU = false
let ND = false
let SP = false

// ---- adaptive timer: an `after` chain, 1 s while something needs it (queued toast, command timer, last 2 min of a
// focus phase), up to 30 s otherwise. Each mod's tick returns the longest sleep it can accept. ----
let timer: { cancel: () => void } | undefined
let ticking = false
let lastNow = 0
let lastDelay = 1000
let sinceSync = 0
let forceReal = true
function arm($: EngineInterface, delay: number): void {
  timer?.cancel()
  lastDelay = delay
  timer = $.clock.after(delay, () => void tickAll($).catch(() => undefined))
}
async function tickAll($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  const d = mkD($)
  let delay = 30000
  const upd = (x: number | undefined): void => {
    if (x != null && x < delay) delay = Math.max(1, x)
  }
  try {
    let now: number
    if (forceReal || lastNow === 0 || sinceSync >= 30) {
      now = await d.clock.now()
      sinceSync = 0
      forceReal = false
    } else {
      now = lastNow + lastDelay
      sinceSync++
    }
    lastNow = now
    try {
      if (FOCUS) upd(await focusTick(d, rt, now))
    } catch {
      // One mod failing must not stop the others.
    }
    try {
      if (HU) upd(await huTick(d, rt, now))
    } catch {
      // Same.
    }
    try {
      if (ND) upd(await ndTick(d, rt, now))
    } catch {
      // Same.
    }
  } catch {
    // A stale frame or a refused call: the next tick tries again.
  } finally {
    ticking = false
    arm($, delay)
  }
}

// ---- idempotent bootstrap (also reached lazily from the first event of any kind) -----------------------
let booted: Promise<void> | undefined
async function runBootstrap($: EngineInterface): Promise<void> {
  const d = mkD($)
  try {
    if (!rt.cwd) rt.cwd = await d.session.cwd()
  } catch {
    // Relative paths stay relative.
  }
  try {
    rt.sid = await d.session.id()
  } catch {
    // Per-session store keys use the default id.
  }
  try {
    statusSink.on = (await d.session.surfaces()).length === 0
  } catch {
    statusSink.on = false
  }
  try {
    if (FOCUS) await focusStart(d, rt)
  } catch {
    // A mod that cannot start stays inert.
  }
  try {
    if (HU) await huStart(d, rt)
  } catch {
    // Same.
  }
  sched.wakeFn = () => {
    forceReal = true
    if (!ticking) arm($, 100)
  }
  if (!timer) arm($, 1000)
}
function bootstrap($: EngineInterface): Promise<void> {
  if (!booted) booted = runBootstrap($)
  return booted
}

// Slash commands (a built-in name is refused, so a collision becomes awareness-<name>) and the phase tool.
async function registerSurface($: EngineInterface): Promise<boolean> {
  let ok = true
  if (ND && optBool(rt.options, 'nowdoing.tool', true)) {
    try {
      await $.tool.register({
        name: 'phase',
        description: 'Optional: set the work phase shown to the user (research, plan, build, verify, report) and a short note of what you are doing now.',
        inputSchema: {
          type: 'object',
          properties: {
            phase: { type: 'string', enum: ['research', 'plan', 'build', 'verify', 'report'] },
            note: { type: 'string' },
            done: { type: 'number' },
            total: { type: 'number' },
          },
          required: ['phase'],
        },
        isDeferred: true,
      })
    } catch {
      ok = false
    }
  }
  let taken = new Set<string>()
  try {
    taken = new Set((await $.command.list()).map(c => c.name.replace(/^\//, '')))
  } catch {
    // No list: use the plain names.
  }
  for (const m of META) {
    if (!active.includes(m.id)) continue
    const name = taken.has(m.id) ? `awareness-${m.id}` : m.id
    rt.names[m.id] = name
    try {
      await $.command.register({ name, description: m.desc, argumentHint: m.hint })
    } catch {
      // The command is a convenience.
    }
  }
  return ok
}

export const register: Register = (on, options) => {
  rt.options = options
  active = META.filter(m => modEnabled(options, m.id)).map(m => m.id)
  FOCUS = active.includes('focus')
  HU = active.includes('headsup')
  ND = active.includes('nowdoing')
  SP = active.includes('spec')
  if (HU) rt.hu.onFocusEnd = headsupOnFocusEnd

  on('session.start', async ($, e, next) => {
    rt.cwd = e.cwd
    let ok = await registerSurface($)
    let started: any
    try {
      started = await next(e)
    } finally {
      if (!ok) ok = await registerSurface($)
      await bootstrap($)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined
    sched.wakeFn = () => undefined
    ndSessionEnd()
    try {
      $.ui.status(undefined)
    } catch {
      // Exiting.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- prompt and turn lifecycle -------------------------------------------------------------------------------
  on('session.measure', async ($, e, next) => {
    void bootstrap($)
    const r = await next(e)
    if (HU) await huMeasure(mkD($), rt, e)
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    void bootstrap($)
    const d = mkD($)
    if (HU) await huPrompt(d)
    const raw = (e as any)?.text
    const isCommand = typeof raw === 'string' && raw.trimStart().startsWith('/')
    if (ND && !isCommand) await ndPrompt(d)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    void bootstrap($)
    const d = mkD($)
    if (HU) huTurnStart()
    if (ND) await ndTurnStart(d)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const d = mkD($)
    if (HU) huTurnComplete(e)
    if (ND) await ndTurnComplete(d, e)
    if (SP) await spTurnComplete(d, rt, e)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Main request stamp (cache clock), TTL learning and REPORT detection.
  on('turn.step', async function* ($, e, next) {
    const d = mkD($)
    const startAt = HU ? await huStepBefore(d, e) : 0
    const obs = ND ? ndStepObs(e) : undefined
    const it = (next(e) as any)[Symbol.asyncIterator]()
    let res = await it.next()
    try {
      while (!res.done) {
        if (obs) ndStepChunk(d, obs, res.value)
        let sent: any
        try {
          sent = yield res.value
        } catch (err) {
          res = await it.throw(err)
          continue
        }
        res = await it.next(sent)
      }
    } finally {
      if (!res.done) await it.return?.(undefined)
    }
    const r = res.value
    await ndStepEnd(obs)
    if (HU) await huStepAfter(d, e, r, startAt)
    if (ND) await ndStepAfter(d, e, r, obs)
    return r
  })

  on('model.fork', async ($, e, next) => {
    const r: any = await next(e)
    if (HU) await huFork(mkD($), r)
    return r
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (HU) huCompact()
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PreModelSwitch', ($, e, next) => {
    if (HU) huModelSwitch(e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', ($, e, next) => {
    if (HU) huModelSwitch(e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (HU) await huClassicStart(mkD($), e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    void bootstrap($)
    const r = await next(e)
    if (HU) await huSpawn(mkD($), rt, e, r)
    return r
  }).catch(($, e, next) => next(e))

  // ---- every tool call: phase + checklist, spec tracking, long command timer, big output -------------------
  on('tool.call', async ($, e, next) => {
    void bootstrap($)
    const d = mkD($)
    if (ND) {
      const early = await ndToolEarly(d, rt, e)
      if (early) return early
    }
    const w = HU ? await huToolBefore(d, rt, e) : undefined
    const nd = ND ? await ndToolBefore(d, rt, e) : undefined
    let ran: any
    try {
      ran = await next(e)
    } finally {
      huToolFinally(w)
      if (nd) await ndToolFinally(d, nd)
    }
    if (HU) await huToolAfter(d, rt, e, ran, w)
    if (ND && nd) await ndToolAfter(d, e, ran, nd)
    if (SP) await spToolAfter(d, rt, e, ran)
    return ran
  }).catch(($, e, next) => next(e))

  // ---- slash commands ---------------------------------------------------------------------------------------
  on('command.run', async ($, e, next) => {
    const id = String(e.command).replace(/^\//, '').replace(/^awareness-/, '')
    if (!(COMMANDS as readonly string[]).includes(id) || !(active as readonly string[]).includes(id)) return next(e)
    await bootstrap($)
    const d = mkD($)
    const args = String(e.args ?? '')
    try {
      const text =
        id === 'focus' ? await focusCommand(d, rt, args)
        : id === 'headsup' ? await huCommand(d, rt, args)
        : id === 'spec' ? await spCommand(d, rt, args)
        : await ndCommand(d, rt, args)
      return { text }
    } catch (err) {
      return { text: `/${id} failed: ${String((err as { message?: string } | undefined)?.message ?? err).slice(0, 120)}` }
    }
  }).catch(($, e, next) => next(e))

  // ---- the band above the prompt (exactly one hook, conventions s4) ---------------------------------------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const d = mkD($)
    // Computed lazily by renderBand, i.e. after `await next(e)`, so a slow hook elsewhere cannot hold a stale snapshot (conventions s3.1a).
    const segments = async (): Promise<Segment[]> => {
      const out: Segment[] = []
      if (FOCUS) {
        try {
          const f = await focusSegments(d, rt, e)
          if (f) out.push(f)
        } catch {
          // A mod that cannot draw is skipped.
        }
      }
      if (ND) {
        try {
          const n = await ndSegments(d, rt, e)
          if (n) out.push(n)
        } catch {
          // Same.
        }
      }
      return out
    }
    return renderBand({ resolve: x => $.ui.resolve(x) }, e, next, { segments, flat: true, minBandRows: optNum(rt.options, 'minBandRows', 4) })
  })
}
