// Heads-Up: toasts only, at most one a minute, silent during Focus Timer. Incl. Long Command Timer.
import type { D } from '../lib/d'
import { sched } from '../lib/sched'
import { learnTtl, resolveTtl, cacheClock } from '../_shared/cache'
import type { SettingsSlice, Ttl } from '../_shared/cache'
import { basename, clip, fmtClock, fmtWhen, modelFamily, parseDuration } from '../_shared/fmt'
import { toastGlyph } from '../_shared/glyphs'
import type { GlyphName } from '../_shared/glyphs'
import { matchAny, splitGlobs } from '../_shared/glob'
import { windowPace } from '../_shared/pace'
import type { WindowKind } from '../_shared/pace'
import { recacheUsd } from '../_shared/prices'
import { isOk, run } from '../_shared/proc'
import { PEER_REFS, createLimiter, toastText } from '../_shared/toast'
import type { Limiter, PeerName } from '../_shared/toast'
import { optBool, optNum, optStr } from '../lib/opts'
import type { Opts } from '../lib/opts'
import type { Rt } from '../lib/rt'
import { exeOf } from '../lib/util'

type Pending = { text: string; priority: number; at: number; valid?: () => boolean }

const TRIGGERS = ['cache', 'longCommand', 'context', 'pace', 'bigOutput', 'ollama', 'noModel'] as const
type TriggerId = (typeof TRIGGERS)[number]
const PRIORITY: Record<TriggerId, number> = { cache: 1, longCommand: 2, context: 3, pace: 4, bigOutput: 5, ollama: 6, noModel: 7 }
const TOAST_MS = 6000
const OLLAMA_URL = 'http://127.0.0.1:11434/api/version'

// Emoji-presentation forms so a terminal toast always starts with a real emoji.
const VS16: Record<string, string> = { '⚠ ': '⚠️ ', '⏱ ': '⏱️ ' }

const cfg = (o: Opts) => ({
  minGapMs: optNum(o, 'headsup.minGapMs', 60_000),
  idleMs: optNum(o, 'headsup.idleSec', 120) * 1000,
  ttlMs: optNum(o, 'headsup.queueTtlMin', 5) * 60_000,
  digest: optBool(o, 'headsup.digestAfterFocus', true),
  warnSec: optNum(o, ['headsup.cache.warnSec', 'cache.warnSec'], 60),
  minCtx: optNum(o, ['headsup.cache.minCtxTokens', 'cache.minCtxTokens'], 50_000),
  longSec: optNum(o, ['headsup.longSec', 'longSec'], 120),
  warnAt: optNum(o, ['headsup.context.warnAt', 'context.warnAt'], 80),
  five: optBool(o, ['headsup.pace.five', 'pace.five'], false),
  kb: optNum(o, ['headsup.bigOutput.kb', 'bigOutput.kb'], 100),
  ollamaMs: Math.max(1, optNum(o, ['headsup.ollama.intervalMin', 'ollama.intervalMin'], 5)) * 60_000,
  allowTypes: splitGlobs(optStr(o, ['headsup.noModel.allowTypes', 'noModel.allowTypes'], 'savvy-*,*:savvy-*')),
  cacheTtl: optStr(o, ['cache.ttl', 'headsup.cache.ttl'], 'auto'),
  followTax: optBool(o, ['cache.followCacheTax', 'headsup.cache.followCacheTax'], true),
})
const enabled = (o: Opts, id: string): boolean => optBool(o, `headsup.trigger.${id}`, id !== 'noModel')

// ---- module caches (the public truth is the headsup atom) -------------------------------------
let cur$: D | undefined
let rtRef: Rt | undefined
let limiter: Limiter | undefined
const pend = new Map<string, Pending>()
const held = new Set<string>()
let digestIds: string[] = []
let pumping = false

// Idle tracking.
let turnRunning = false
let lastPromptAt: number | undefined

// Context.
let ctxPercent: number | undefined
let ctxTokens: number | undefined
let ctxArmed = true

// Pace.
let limits: { kind: WindowKind; percent: number; resetsAt?: number }[] = []
let hasRateLimits = false
const paceSt = new Map<WindowKind, { hot: boolean; armed: boolean; outSince?: number; resetsAt?: number }>()
let nextPaceAt = 0

// Cache.
let lastReqAt: number | undefined
let firedFor: number | undefined
let forcedCold = false
let ttlEvent: Ttl | undefined
let learned: { ttl: Ttl; at: number } | undefined
let settings: SettingsSlice | undefined
let lastModel: string | undefined
let prevReq: { startAt: number; inputTotal: number } | undefined

// Ollama.
let nextProbeAt = 0
let ollamaFails = 0
let ollamaDown = false
let probing = false


const ids = (): string[] => [...pend.keys()]

async function surfacesOf($: D): Promise<readonly string[]> {
  try {
    return await $.session.surfaces()
  } catch {
    return []
  }
}

async function prefix($: D, name: GlyphName): Promise<string> {
  const p = toastGlyph(await surfacesOf($), name)
  return VS16[p] ?? p
}

let cmdNames: Set<string> | undefined
async function hasCmd($: D, name: string): Promise<boolean> {
  try {
    const list = await $.command.list()
    cmdNames = new Set(list.map(c => c.name.replace(/^\//, '')))
  } catch {
    // Keep the last answer.
  }
  return cmdNames?.has(name) ?? false
}

async function publish($: D, patch: { lastShownAt?: number; bumpShown?: boolean } = {}): Promise<void> {
  try {
    await $.update('headsup', v => ({
      ...v,
      queued: ids(),
      lastShownAt: patch.lastShownAt ?? v.lastShownAt,
      shown: v.shown + (patch.bumpShown ? 1 : 0),
    }))
  } catch {
    // The atom is for peers and /headsup status.
  }
}

function ensureLimiter(rt: Rt): Limiter {
  if (limiter) return limiter
  const c = cfg(rt.options)
  limiter = createLimiter({
    minGapMs: c.minGapMs,
    peers: ['dev.toast'],
    respectQuiet: false,
    maxQueue: 16,
    quiet: async () => (cur$ ? await isQuiet(cur$) : false),
    onShown: async info => {
      if (info.id === 'digest') {
        digestIds = []
        held.clear()
      }
      if (cur$) await publish(cur$, { lastShownAt: info.at, bumpShown: true })
    },
  })
  return limiter
}

async function isQuiet($: D): Promise<boolean> {
  const now = await $.clock.now()
  const hv = await $.read('headsup')
  if (hv.mutedUntil != null && hv.mutedUntil > now) return true
  return (await $.read('focus')).phase === 'focus'
}

/** Shows the best pending toast when the limiter allows; drops expired and cleared ones. */
async function pump($: D, rt: Rt): Promise<void> {
  if (pumping) return
  pumping = true
  cur$ = $
  try {
    const c = cfg(rt.options)
    const lim = ensureLimiter(rt)
    const now = await $.clock.now()
    let changed = false
    for (const [id, p] of pend) {
      if (now - p.at > c.ttlMs || (p.valid && !p.valid())) {
        pend.delete(id)
        changed = true
      }
    }
    if (pend.size > 0) {
      const best = [...pend.entries()].sort((a, b) => a[1].priority - b[1].priority || a[1].at - b[1].at)[0]
      if (best) {
        const ports = {
          now: () => $.clock.now(),
          toast: (text: string, o?: { timeoutMs?: number }) => $.ui.toast(text, o),
          readPeer: async (n: PeerName) => (await $.state.get(PEER_REFS[n])).value,
        }
        const r = await lim.offer(ports, best[0], best[1].text, { priority: best[1].priority, timeoutMs: TOAST_MS })
        lim.clearQueue()
        if (r === 'shown') {
          pend.delete(best[0])
          changed = true
        }
      }
    }
    if (changed) await publish($)
  } catch {
    // A failed pump retries on the next tick.
  } finally {
    pumping = false
  }
}

/** Offers a trigger. Muted: dropped. Focus: counted for the digest, never queued. */
async function trigger($: D, rt: Rt, id: string, priority: number, text: string, valid?: () => boolean): Promise<void> {
  cur$ = $
  const now = await $.clock.now()
  const hv = await $.read('headsup')
  if (hv.mutedUntil != null && hv.mutedUntil > now) return
  if ((await $.read('focus')).phase === 'focus') {
    if (!held.has(id)) {
      held.add(id)
      try {
        await $.store.set(`headsup:digest:${rt.sid}`, { v: 1, ids: [...held] })
      } catch {
        // Counted in memory.
      }
    }
    return
  }
  pend.set(id, { text, priority, at: now, valid })
  await pump($, rt)
  if (pend.size > 0) sched.wake()
}

// ---- triggers ----------------------------------------------------------------------------------------

async function onContext($: D, rt: Rt, percent: number): Promise<void> {
  const c = cfg(rt.options)
  ctxPercent = percent
  if (percent < c.warnAt - 10) ctxArmed = true
  if (!enabled(rt.options, 'context') || percent < c.warnAt || !ctxArmed) return
  ctxArmed = false
  const hint = (await hasCmd($, 'compact')) ? ' Run /compact or start fresh.' : ''
  const text = toastText('CONTEXT', `${Math.round(percent)}%: compaction is near.`, hint.trim() || undefined, await prefix($, 'warn'))
  await trigger($, rt, 'context', PRIORITY.context, text, () => (ctxPercent ?? 0) >= c.warnAt)
}

async function evalPace($: D, rt: Rt, now: number): Promise<void> {
  const c = cfg(rt.options)
  if (!enabled(rt.options, 'pace')) return
  for (const l of limits) {
    if (l.kind !== 'seven_day' && !(l.kind === 'five_hour' && c.five)) continue
    const w = windowPace({ kind: l.kind, percent: l.percent, resetsAt: l.resetsAt, now })
    const s = paceSt.get(l.kind) ?? { hot: false, armed: true }
    if (s.resetsAt != null && l.resetsAt != null && s.resetsAt !== l.resetsAt) s.armed = true
    s.resetsAt = l.resetsAt
    const hot = w.state === 'hot'
    if (hot) {
      s.outSince = undefined
      if (!s.hot && s.armed) {
        s.armed = false
        const burn = (await hasCmd($, 'burn')) ? 'Run /burn.' : undefined
        const when = w.hitAt != null ? `lands ${fmtWhen(w.hitAt, now)}` : `lands before ${l.resetsAt != null ? fmtWhen(l.resetsAt, now) : 'reset'}`
        const title = l.kind === 'seven_day' ? 'WEEKLY PACE' : '5-HOUR PACE'
        const kind = l.kind
        const text = toastText(title, `HOT: limit ${when} at this rate.`, burn, await prefix($, 'hot'))
        s.hot = true
        paceSt.set(l.kind, s)
        await trigger($, rt, 'pace', PRIORITY.pace, text, () => paceSt.get(kind)?.hot === true)
        continue
      }
      s.hot = true
    } else {
      if (s.hot) {
        s.hot = false
        s.outSince = now
      }
      if (!s.armed && s.outSince != null && now - s.outSince >= 30 * 60_000) s.armed = true
    }
    paceSt.set(l.kind, s)
  }
}

async function onMeasure($: D, rt: Rt, e: any): Promise<void> {
  const now = await $.clock.now()
  const ctx = e?.context
  if (ctx && typeof ctx === 'object') {
    if (typeof ctx.tokens === 'number') ctxTokens = ctx.tokens
    else if (typeof ctx.percent === 'number' && typeof ctx.window === 'number') ctxTokens = Math.round((ctx.percent / 100) * ctx.window)
    if (typeof ctx.percent === 'number') await onContext($, rt, ctx.percent)
  }
  if (Array.isArray(e?.rateLimits)) {
    hasRateLimits = e.rateLimits.length > 0
    limits = e.rateLimits
      .filter((r: any) => r && (r.kind === 'seven_day' || r.kind === 'five_hour') && typeof r.percentUsed === 'number')
      .map((r: any) => {
        const t = r.resetsAt ? Date.parse(r.resetsAt) : NaN
        return { kind: r.kind as WindowKind, percent: r.percentUsed as number, resetsAt: Number.isFinite(t) ? t : undefined }
      })
    nextPaceAt = now + 60_000
    await evalPace($, rt, now)
  }
}

function cacheState(c: ReturnType<typeof cfg>, now: number): { remainingMs: number; ttl: Ttl } | undefined {
  if (lastReqAt == null || forcedCold) return undefined
  const ttl = resolveTtl({
    option: c.cacheTtl === '5m' || c.cacheTtl === '1h' ? c.cacheTtl : 'auto',
    event: ttlEvent,
    learned,
    followCacheTax: c.followTax,
    settings,
    hasRateLimits,
    now,
  }).ttl
  const k = cacheClock({ lastReqAt, ttl, now })
  return k.remainingMs != null ? { remainingMs: k.remainingMs, ttl } : undefined
}

const isIdle = (c: ReturnType<typeof cfg>, now: number): boolean => !turnRunning && (lastPromptAt == null || now - lastPromptAt >= c.idleMs)

async function checkCache($: D, rt: Rt, now: number): Promise<void> {
  const c = cfg(rt.options)
  if (!enabled(rt.options, 'cache') || lastReqAt == null || firedFor === lastReqAt) return
  const st = cacheState(c, now)
  if (!st || st.remainingMs <= 0 || st.remainingMs > c.warnSec * 1000) return
  if (!isIdle(c, now) || (ctxTokens ?? 0) < c.minCtx) return
  firedFor = lastReqAt
  const entry = lastReqAt
  let detail = 'Prompt cache expires soon.'
  if (lastModel && ctxTokens) {
    const usd = recacheUsd(ctxTokens, lastModel, st.ttl)
    if (Number.isFinite(usd) && usd > 0) detail = `Prompt cache expires soon; the next message re-caches ~$${usd.toFixed(2)}.`
  }
  const text = toastText('CACHE', `${c.warnSec} S: ${detail}`, undefined, await prefix($, 'pom'))
  await trigger($, rt, 'cache', PRIORITY.cache, text, () => !turnRunning && lastReqAt === entry && !forcedCold)
}

// ---- Ollama ------------------------------------------------------------------------------------------

const looksBlocked = (err: unknown): boolean => {
  const m = String((err as { message?: string } | undefined)?.message ?? err)
  return /polic|blocked|not allowed|denied|permission|forbidden/i.test(m) && !/ECONNREFUSED|connect|fetch failed|timeout/i.test(m)
}

async function ollamaUp($: D): Promise<boolean> {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : undefined
  try {
    const timeout = $.clock.sleep(3000, ac ? { signal: ac.signal } : undefined).then(() => {
      throw new Error('timeout')
    })
    timeout.catch(() => undefined)
    const r: any = await Promise.race([$.http.fetch(OLLAMA_URL), timeout])
    ac?.abort()
    return r?.ok !== false
  } catch (err) {
    ac?.abort()
    if (looksBlocked(err)) {
      try {
        const r = await run({ run: (argv, init) => $.process.run(argv, init), now: () => $.clock.now() }, ['curl', '-s', '-m', '2', '-o', '/dev/null', '-w', '%{http_code}', OLLAMA_URL], { timeoutMs: 4000 })
        return isOk(r) && /^2\d\d$/.test(r.stdout.trim())
      } catch {
        return false
      }
    }
    return false
  }
}

async function ollamaSlot($: D, rt: Rt): Promise<void> {
  if (probing || !enabled(rt.options, 'ollama')) return
  probing = true
  try {
    const dir = await $.vaultPath()
    if (!dir) return
    try {
      if ((await $.fs.stat(dir)).kind !== 'dir') return
    } catch {
      return
    }
    if (await ollamaUp($)) {
      ollamaFails = 0
      ollamaDown = false
      return
    }
    ollamaFails++
    if (ollamaFails >= 2 && !ollamaDown) {
      ollamaDown = true
      const text = toastText('VAULT', 'KEYWORD ONLY: Ollama is down; search quality is reduced.', undefined, await prefix($, 'warn'))
      await trigger($, rt, 'ollama', PRIORITY.ollama, text, () => ollamaDown)
    }
  } catch {
    // A failed probe counts as nothing.
  } finally {
    probing = false
  }
}

// ---- digest, status, commands -----------------------------------------------------------------------

async function onFocusEnd($: D, rt: Rt): Promise<void> {
  cur$ = $
  const c = cfg(rt.options)
  if (held.size === 0) return
  if (!c.digest) {
    held.clear()
    return
  }
  digestIds = [...held]
  const n = digestIds.length
  const msg = `${await prefix($, 'pom')}While you focused: ${n} notice${n === 1 ? '' : 's'} (${digestIds.join(', ')}). Run /headsup.`
  const now = await $.clock.now()
  pend.set('digest', { text: msg.length > 140 ? msg.slice(0, 139) + '…' : msg, priority: 0, at: now })
  await pump($, rt)
}

function sample(id: string, hint?: string): string {
  switch (id) {
    case 'cache': return 'CACHE · 60 S: Prompt cache expires soon; the next message re-caches ~$0.42.'
    case 'longCommand': return 'COMMAND · 2 MIN: sample is still running.'
    case 'context': return 'CONTEXT · 82%: compaction is near.'
    case 'pace': return `WEEKLY PACE · HOT: limit lands Thu 14:20 at this rate.${hint ? ' ' + hint : ''}`
    case 'bigOutput': return 'OUTPUT · 120 KB from Bash. Narrow the command next time.'
    case 'ollama': return 'VAULT · KEYWORD ONLY: Ollama is down; search quality is reduced.'
    default: return 'AGENT · NO MODEL SET: "sample" started without a model. Add model: haiku or sonnet.'
  }
}

async function command($: D, rt: Rt, args: string): Promise<string> {
  const [sub = 'status', arg] = args.trim().split(/\s+/)
  const now = await $.clock.now()
  const hv = await $.read('headsup')
  switch (sub.toLowerCase()) {
    case 'mute': {
      const ms = arg ? parseDuration(arg) : 30 * 60_000
      if (ms == null || ms <= 0) return 'Usage: /headsup mute <duration>, e.g. 30m'
      const until = now + ms
      await $.update('headsup', v => ({ ...v, mutedUntil: until }))
      pend.clear()
      limiter?.clearQueue()
      await publish($)
      return `Heads-Up muted until ${fmtWhen(until, now)}.`
    }
    case 'unmute':
      await $.update('headsup', v => ({ ...v, mutedUntil: undefined }))
      return 'Heads-Up unmuted.'
    case 'test': {
      const id = (arg ?? '') as TriggerId
      if (!TRIGGERS.includes(id)) return `Usage: /headsup test <${TRIGGERS.join('|')}>`
      const burn = (await hasCmd($, 'burn')) ? 'Run /burn.' : undefined
      const text = `${await prefix($, id === 'cache' ? 'pom' : 'warn')}${sample(id, burn)}`
      await trigger($, rt, `test:${id}`, PRIORITY[id], text)
      return `Test toast for ${id} offered.`
    }
    case 'status':
    case '': {
      const focus = (await $.read('focus')).phase
      const state = hv.mutedUntil != null && hv.mutedUntil > now ? `muted until ${fmtWhen(hv.mutedUntil, now)}` : focus === 'focus' ? 'QUIET (focus)' : 'ACTIVE'
      const heldIds = digestIds.length > 0 ? digestIds : [...held]
      return [
        `Heads-Up: ${state}`,
        `shown ${hv.shown}`,
        `queued: ${pend.size ? ids().join(', ') : 'none'}`,
        `held for digest: ${heldIds.length ? heldIds.join(', ') : 'none'}`,
        hv.lastShownAt != null ? `last toast ${fmtWhen(hv.lastShownAt, now)}` : 'no toast yet',
      ].join(' · ')
    }
    default:
      return 'Usage: /headsup status | mute <dur> | unmute | test <id>'
  }
}

// ---- hooks -----------------------------------------------------------------------------------------------

// ---- event handlers (register.tsx owns the single hook per event and calls these) -------------------------

export async function huMeasure($: D, rt: Rt, e: any): Promise<void> {
  try {
    rtRef = rt
    cur$ = $
    await onMeasure($, rt, e)
  } catch {
    // Never disturb the measure.
  }
}

export async function huPrompt($: D): Promise<void> {
  try {
    lastPromptAt = await $.clock.now()
  } catch {
    // Idle stays as it was.
  }
}

export function huTurnStart(): void {
  turnRunning = true
}

export function huTurnComplete(e: any): void {
  if (!e?.agentId) turnRunning = false
}

/** Main request stamp (cache expiry clock). Returns the step's start time (0 for a subagent step). */
export async function huStepBefore($: D, e: any): Promise<number> {
  if (e?.agentId) return 0
  try {
    const startAt = await $.clock.now()
    lastReqAt = startAt
    forcedCold = false
    if (e?.model) lastModel = e.model
    return startAt
  } catch {
    return 0
  }
}

/** TTL learning from the step's usage. */
export async function huStepAfter($: D, e: any, r: any, startAt: number): Promise<void> {
  if (e?.agentId || !r || !startAt) return
  try {
    const u = r.usage
    if (!u) return
    const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    if (prevReq) {
      const l = learnTtl({ gapMs: startAt - prevReq.startAt, prevInputTotal: prevReq.inputTotal, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0 })
      if (l) {
        learned = { ttl: l, at: startAt }
        await $.store.set('cache:learned', { v: 1, ttl: l, at: startAt, family: modelFamily(lastModel) })
      }
    }
    prevReq = { startAt, inputTotal: input }
  } catch {
    // Learning is best effort.
  }
}

export async function huFork($: D, r: any): Promise<void> {
  try {
    if ((r?.usage?.cache_read_input_tokens ?? 0) > 0) lastReqAt = await $.clock.now()
  } catch {
    // Best effort.
  }
}

export function huCompact(): void {
  forcedCold = true
  ctxArmed = true
}

export function huModelSwitch(e: any): void {
  if (e?.cache_ttl === '5m' || e?.cache_ttl === '1h') ttlEvent = e.cache_ttl
  forcedCold = true
}

export async function huClassicStart($: D, x: any): Promise<void> {
  try {
    if (x?.source === 'resume' || x?.source === 'fork') {
      if (x.prompt_cache_likely_expired) forcedCold = true
      else if (typeof x.seconds_since_last_response === 'number') {
        lastReqAt = (await $.clock.now()) - x.seconds_since_last_response * 1000
        forcedCold = false
      }
    }
  } catch {
    // Best effort.
  }
}

export async function huSpawn($: D, rt: Rt, e: any, r: any): Promise<void> {
  try {
    const c = cfg(rt.options)
    if (r.deny === undefined && enabled(rt.options, 'noModel') && e.model === undefined && e.subagentType !== 'fork' && !matchAny(e.subagentType, c.allowTypes)) {
      const lead = await prefix($, 'warn')
      const tail = '" started without a model. Add model: haiku or sonnet.'
      const base = `${lead}AGENT · NO MODEL SET: "`
      const room = Math.max(8, 140 - base.length - tail.length)
      const text = `${base}${clip((e.description ?? '').replace(/\s+/g, ' ').trim(), room)}${tail}`
      await trigger($, rt, 'noModel', PRIORITY.noModel, text)
    }
  } catch {
    // Never disturb the spawn.
  }
}

/** Long Command Timer, part 1: starts the alert timer before the command runs. */
export type CmdWatch = { exe: string; t0: number; running: boolean; timer: { cancel: () => void } }
export async function huToolBefore($: D, rt: Rt, e: any): Promise<CmdWatch | undefined> {
  if (e?.agentId !== undefined || e.tool !== 'Bash' || e.run_in_background || !enabled(rt.options, 'longCommand')) return undefined
  try {
    const c = cfg(rt.options)
    const w = { exe: exeOf(String(e.command ?? '')), t0: await $.clock.now(), running: true } as CmdWatch
    w.timer = $.clock.after(c.longSec * 1000, () => {
      void (async () => {
        try {
          if (!w.running) return
          const min = Math.max(1, Math.round(c.longSec / 60))
          const text = toastText('COMMAND', `${min} MIN: ${w.exe} is still running.`, undefined, await prefix($, 'timer'))
          await trigger($, rt, 'longCommand', PRIORITY.longCommand, text, () => w.running)
        } catch {
          // The alert is best effort.
        }
      })()
    })
    return w
  } catch {
    return undefined
  }
}

export function huToolFinally(w: CmdWatch | undefined): void {
  if (!w) return
  w.running = false
  w.timer.cancel()
}

/** Part 2: DONE toast and big-output toast, after the result. */
export async function huToolAfter($: D, rt: Rt, e: any, ran: any, w: CmdWatch | undefined): Promise<void> {
  if (e?.agentId !== undefined) return
  try {
    if (!ran || ran.deny !== undefined) return
    const c = cfg(rt.options)
    const tool = String(e.tool)
    if (w) {
      const dur = (await $.clock.now()) - w.t0
      const bg = typeof ran.result?.backgroundTaskId === 'string'
      if (!bg && dur >= c.longSec * 1000) {
        const text = toastText('COMMAND', `DONE: ${w.exe} took ${fmtClock(dur)}.`, undefined, await prefix($, 'timer'))
        await trigger($, rt, 'longCommand', PRIORITY.longCommand, text)
      }
    }
    if (enabled(rt.options, 'bigOutput') && tool !== 'mcp__awareness__phase') {
      const persisted = ran.result && typeof ran.result === 'object' ? ran.result.persistedOutputSize : undefined
      const size = typeof persisted === 'number' ? persisted : typeof ran.text === 'string' ? ran.text.length : 0
      if (size >= c.kb * 1000) {
        const text = toastText('OUTPUT', `${Math.round(size / 1000)} KB from ${clip(tool, 24)}.`, 'Narrow the command next time.', await prefix($, 'warn'))
        await trigger($, rt, 'bigOutput', PRIORITY.bigOutput, text)
      }
    }
  } catch {
    // Never disturb the result.
  }
}

export async function huStart($: D, rt: Rt): Promise<void> {
  cur$ = $
  rtRef = rt
  ensureLimiter(rt)
  try {
    const l = (await $.store.get('cache:learned')) as { ttl?: Ttl; at?: number } | undefined
    if (l && (l.ttl === '5m' || l.ttl === '1h') && typeof l.at === 'number') learned = { ttl: l.ttl, at: l.at }
  } catch {
    // No learned TTL.
  }
  try {
    const s: any = await $.settings.read()
    settings = { enabledPlugins: s?.enabledPlugins, pluginConfigs: s?.pluginConfigs, promptCacheTtl: s?.promptCacheTtl }
  } catch {
    settings = undefined
  }
  const now = await $.clock.now()
  nextProbeAt = now + cfg(rt.options).ollamaMs
  void ollamaSlot($, rt)
}

export async function huTick($: D, rt: Rt, now: number): Promise<number | undefined> {
  cur$ = $
  let next: number | undefined
  const upd = (x: number): void => {
    if (next === undefined || x < next) next = Math.max(1, x)
  }
  if (pend.size > 0) await pump($, rt)
  if (pend.size > 0) upd(1000)
  await checkCache($, rt, now)
  if (enabled(rt.options, 'cache') && lastReqAt != null && firedFor !== lastReqAt) {
    const c = cfg(rt.options)
    const st = cacheState(c, now)
    if (st && st.remainingMs > 0) {
      const toWarn = st.remainingMs - c.warnSec * 1000
      upd(toWarn > 0 ? Math.min(toWarn, 30_000) : 5000)
    }
  }
  if (limits.length > 0) {
    if (now >= nextPaceAt) {
      nextPaceAt = now + 60_000
      await evalPace($, rt, now)
    }
    upd(nextPaceAt - now)
  }
  if (now >= nextProbeAt) {
    nextProbeAt = now + cfg(rt.options).ollamaMs
    await ollamaSlot($, rt)
  }
  upd(nextProbeAt - now)
  return next
}

export const huCommand = command

/** Called by the focus mod when a FOCUS phase ends. */
export async function headsupOnFocusEnd($: D): Promise<void> {
  if (rtRef) await onFocusEnd($, rtRef)
}
