// usage: Burn Meter, Cache Clock, Compaction Alert (specs/usage.md). Zero tokens spent, nothing model-visible.
//
// Layout note: the validator never follows `$` across an import, so every function that touches `$` lives in this
// file; pure logic (maths, text, svg) lives in core.ts and mods/*.ts. An event may be hooked once per module, so
// each shared event has one hook here that serves all three mods.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { renderBand } from './_shared/band'
import type { Segment } from './_shared/band'
import { cacheClock } from './_shared/cache'
import { fmtCountdown, localDate } from './_shared/fmt'
import {
  EMPTY_CACHE, INIT_CORE, STORE_KINDS, buildStore, calcCache, calcContext, contextView, mergeSamples, parseOpts, priceOverrides, trimSettings, ttlOf,
} from './core'
import type { Opts, StoreKind } from './core'
import { applyReadingPure, burnCardFrom, burnSegmentFrom, burnStatusFrom, pacePublished, parseLimits } from './mods/burn'
import type { RawLimit } from './mods/burn'
import { cacheSegmentFrom, dayCore, observeKeepwarm, paneModel, ringSvg, savedFor, stepEndCore, stepStartCore } from './mods/cache'
import type { PaneModel, UsageLike } from './mods/cache'
import { compactedCore, ctxSegment, measuredCore } from './mods/compaction'
import type { UsageCore, UsageSample } from '../types'

// Public atoms (types/index.d.ts): peers read limits, pace, cache, context and clock; `core` is internal.
const limitsA = atom({ plugin: 'usage', key: 'limits' } as const, [])
const paceA = atom({ plugin: 'usage', key: 'pace' } as const, null)
const cacheA = atom({ plugin: 'usage', key: 'cache' } as const, EMPTY_CACHE)
const contextA = atom({ plugin: 'usage', key: 'context' } as const, null)
const clockA = atom({ plugin: 'usage', key: 'clock' } as const, 0)
const coreA = atom({ plugin: 'usage', key: 'core' } as const, INIT_CORE)

const IDLE_MS = 60_000
const PANE = 'cache-clock'
const PANE_TITLE = 'Cache clock'

// --- small `$` helpers ------------------------------------------------------------------------------
function mut($: EngineInterface, f: (c: UsageCore) => UsageCore): Promise<unknown> {
  return update($, coreA, f)
}
async function sidOf($: EngineInterface): Promise<string> {
  try {
    return String(await $.session.id())
  } catch {
    return 'local'
  }
}
async function readSettings($: EngineInterface): Promise<UsageCore['settings']> {
  try {
    return trimSettings(await $.settings.read())
  } catch {
    return undefined
  }
}
/** Settings for a draw: the cached slice only (a render never calls `$.settings`, conventions s3.1a). */
function settingsFor(core: UsageCore): UsageCore['settings'] {
  return core.settings
}
/** Event-hook variant: the cached slice, else a fresh read. */
async function settingsForEvent($: EngineInterface, core: UsageCore): Promise<UsageCore['settings']> {
  return core.settings ?? (await readSettings($))
}
async function refreshSettings($: EngineInterface): Promise<void> {
  const s = await readSettings($)
  await mut($, c => ({ ...c, settings: s }))
}
/** Registers `/name`, or `/usage-name` when a command of that name already exists (conventions s1.6). */
async function registerCommand($: EngineInterface, name: string, description: string): Promise<void> {
  let use = name
  try {
    const names = new Set((await $.command.list()).map(c => c.name))
    if (names.has(name)) use = `usage-${name}`
  } catch {
    // Keep the plain name.
  }
  try {
    await $.command.register({ name: use, description })
  } catch {
    // A refused name leaves the command out; the band still works.
  }
}

// --- store (usage.md s7: at most one write a minute per key family) ------------------------------------
async function persist($: EngineInterface, kind: StoreKind, force = false): Promise<void> {
  try {
    const now = await $.clock.now()
    const core = await read($, coreA)
    const last = core.wrote[kind]
    if (!force && kind !== 'learned' && last != null && now - last < 60_000) {
      if (!core.dirty[kind]) await mut($, c => ({ ...c, dirty: { ...c.dirty, [kind]: true } }))
      return
    }
    const sid = core.sid ?? (await sidOf($))
    const b = buildStore(kind, core, sid)
    if (!b) return
    await $.store.set(b.key, b.value)
    await mut($, c => ({ ...c, sid, wrote: { ...c.wrote, [kind]: now }, dirty: { ...c.dirty, [kind]: false } }))
  } catch {
    // The store is best effort.
  }
}
/** Writes every dirty key whose minute has passed (or all of them when forced). */
async function flushDirty($: EngineInterface, force = false): Promise<void> {
  try {
    const now = await $.clock.now()
    const core = await read($, coreA)
    for (const k of STORE_KINDS) {
      if (core.dirty[k] && (force || now - (core.wrote[k] ?? 0) >= 60_000)) await persist($, k, true)
    }
  } catch {
    // Best effort.
  }
}
async function mergeOthers($: EngineInterface): Promise<void> {
  try {
    const [core, limits, now] = [await read($, coreA), await read($, limitsA), await $.clock.now()]
    if (core.merged || limits.length === 0) return
    const sid = core.sid ?? (await sidOf($))
    const others: UsageSample[] = []
    for (const key of await $.store.keys()) {
      if (!key.startsWith('burn:samples:') || key === `burn:samples:${sid}`) continue
      const v = (await $.store.get(key)) as { samples?: UsageSample[] } | undefined
      others.push(...(v?.samples ?? []))
    }
    await mut($, c => ({ ...c, sid, merged: true, samples: mergeSamples(c.samples, others, limits, now) }))
  } catch {
    // Merging is a nicety.
  }
}
/**
 * Today's savings summed over sessions: this one from memory, the others from the store. The store scan runs at
 * most once a minute (cached in core); every call adds the own-session delta. Non-render paths only.
 */
async function savedToday($: EngineInterface, core: UsageCore, now: number): Promise<number> {
  const today = localDate(now)
  const own = core.day.date === today ? core.day.saved : 0
  const c = core.othersSaved
  if (c && c.date === today && now - c.at < 60_000) return own + c.sum
  const sid = core.sid ?? (await sidOf($))
  let others = 0
  try {
    const prefix = `cache:day:${today}:`
    for (const key of await $.store.keys()) {
      if (!key.startsWith(prefix) || key === `${prefix}${sid}`) continue
      const v = (await $.store.get(key)) as { saved?: number } | undefined
      if (v && typeof v.saved === 'number') others += v.saved
    }
  } catch {
    // Own session only.
  }
  await mut($, k => ({ ...k, othersSaved: { date: today, at: now, sum: others } }))
  return own + others
}
/** On session start: drop `cache:day` keys of earlier dates (usage.md s7). */
async function pruneStore($: EngineInterface, now: number): Promise<void> {
  try {
    const today = localDate(now)
    for (const key of await $.store.keys()) {
      const m = /^cache:day:(\d{4}-\d{2}-\d{2}):/.exec(key)
      if (m?.[1] && m[1] < today) await $.store.delete(key)
    }
  } catch {
    // Pruning is housekeeping.
  }
}

// --- publishing the public atoms ---------------------------------------------------------------------
async function publishBurn($: EngineInterface, o: Opts): Promise<void> {
  try {
    const [core, limits, now] = [await read($, coreA), await read($, limitsA), await $.clock.now()]
    const view = pacePublished(core, limits, now, o)
    if (JSON.stringify(await read($, paceA)) !== JSON.stringify(view)) await update($, paceA, () => view)
  } catch {
    // The views catch up on the next reading.
  }
  await syncStatus($, o)
}
async function publishCtx($: EngineInterface, o: Opts): Promise<void> {
  try {
    const [core, now] = [await read($, coreA), await $.clock.now()]
    const view = contextView(calcContext(core, now, o), core)
    if (JSON.stringify(await read($, contextA)) !== JSON.stringify(view)) await update($, contextA, () => view)
  } catch {
    // The next event redraws.
  }
}
async function publishCache($: EngineInterface, o: Opts, refreshSaved = true): Promise<void> {
  try {
    const [core, now] = [await read($, coreA), await $.clock.now()]
    const settings = await settingsForEvent($, core)
    const prev = await read($, cacheA)
    const saved = refreshSaved ? await savedToday($, core, now) : prev.savedTodayUsd
    const calc = calcCache(core, now, o, settings, saved)
    if (JSON.stringify(prev) !== JSON.stringify(calc.view)) await update($, cacheA, () => calc.view)
  } catch {
    // The next event or tick publishes again.
  }
  await syncStatus($, o)
}

// --- Burn Meter ------------------------------------------------------------------------------------------
async function applyReading($: EngineInterface, rls: readonly RawLimit[], cost: number | undefined, fromMeasure: boolean, changedRate: boolean): Promise<void> {
  const now = await $.clock.now()
  const prev = await read($, limitsA)
  const next = parseLimits(rls)
  if (!fromMeasure && next.length === 0) return
  await update($, limitsA, () => next)
  let added = false
  await mut($, c => {
    const r = applyReadingPure(c, prev, next, now, fromMeasure, changedRate, cost)
    added = r.added
    return r.core
  })
  if (added) await persist($, 'samples')
  await mergeOthers($)
}
async function burnStart($: EngineInterface, o: Opts): Promise<void> {
  await registerCommand($, 'burn', 'Show the 5-hour and weekly limits, pace and forecast')
  const sid = await sidOf($)
  await mut($, c => ({ ...c, sid }))
  const u = await $.session.usage()
  await applyReading($, u.rateLimits, u.cost?.usd, false, true)
  await publishBurn($, o)
}
async function burnMeasure($: EngineInterface, o: Opts, e: { rateLimits: readonly RawLimit[]; cost?: { usd: number }; changed: readonly string[] }): Promise<void> {
  await applyReading($, e.rateLimits ?? [], e.cost?.usd, true, (e.changed ?? ['rateLimits']).includes('rateLimits'))
  await publishBurn($, o)
}
async function burnCard($: EngineInterface, o: Opts): Promise<string> {
  const [core, limits, now] = [await read($, coreA), await read($, limitsA), await $.clock.now()]
  return burnCardFrom(core, limits, now, o)
}

// --- Compaction Alert ----------------------------------------------------------------------------------------
/** Refreshes the auto-compact threshold (usage.md s3: model change, session start, at most every 10 min). */
async function refreshThreshold($: EngineInterface, force = false): Promise<void> {
  try {
    const now = await $.clock.now()
    const core = await read($, coreA)
    if (!force && core.ctx.thresholdAt != null && now - core.ctx.thresholdAt < 600_000) return
    // Stamp first so a failing read is not retried on every measure.
    await mut($, c => ({ ...c, ctx: { ...c.ctx, thresholdAt: now } }))
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    if (!b) return
    await mut($, c => ({ ...c, ctx: { ...c.ctx, threshold: b.autoCompactThreshold, autoCompact: b.isAutoCompactEnabled !== false, thresholdAt: now } }))
  } catch {
    // No threshold: the chip shows the percent alone.
  }
}
async function ctxStart($: EngineInterface, o: Opts): Promise<void> {
  const u = await $.session.usage()
  await mut($, c => ({ ...c, ctx: { ...c.ctx, percent: u.context.percent, tokens: u.context.tokens, window: u.context.window } }))
  await refreshThreshold($, true)
  await publishCtx($, o)
}
async function ctxMeasure($: EngineInterface, o: Opts, e: { context: { percent?: number; tokens?: number; window: number } }): Promise<void> {
  if (!e.context) return
  await mut($, c => measuredCore(c, e.context))
  await refreshThreshold($)
  await publishCtx($, o)
}

// --- Cache Clock -------------------------------------------------------------------------------------------------
async function cacheStart($: EngineInterface, o: Opts): Promise<void> {
  await registerCommand($, 'cacheclock', 'Show the prompt-cache clock pane')
  const sid = await sidOf($)
  const settings = await readSettings($)
  const learned = (await $.store.get('cache:learned')) as { ttl?: string; at?: number; family?: string } | undefined
  const ev = (await $.store.get(`cache:ttlEvent:${sid}`)) as { ttl?: string } | undefined
  await mut($, c => ({
    ...c,
    sid,
    settings,
    learned: learned && (learned.ttl === '5m' || learned.ttl === '1h') && typeof learned.at === 'number' ? { ttl: learned.ttl, at: learned.at, family: learned.family } : c.learned,
    ttlEvent: ev && (ev.ttl === '5m' || ev.ttl === '1h') ? ev.ttl : c.ttlEvent,
  }))
  if (priceOverrides(o).bad) $.ui.log('usage: pricesJson is not valid JSON; using the built-in price table', { to: 'debug' })
  await publishCache($, o)
}
async function cacheMeasure($: EngineInterface, o: Opts, e: { rateLimits: readonly unknown[]; context: { tokens?: number } }): Promise<void> {
  await mut($, c => ({ ...c, hasRateLimits: (e.rateLimits ?? []).length > 0, ctxTokens: e.context?.tokens ?? undefined }))
  await publishCache($, o, false)
}
async function cacheClassicStart($: EngineInterface, o: Opts, e: { source: string; prompt_cache_likely_expired?: boolean; estimated_cache_write_usd?: number; seconds_since_last_response?: number; context_tokens?: number; model?: string }): Promise<void> {
  if (e.source !== 'resume' && e.source !== 'fork') return
  const now = await $.clock.now()
  if (e.prompt_cache_likely_expired) {
    await mut($, c => ({ ...c, forcedCold: true, resumeUsd: e.estimated_cache_write_usd, ctxTokens: e.context_tokens ?? c.ctxTokens, model: e.model ?? c.model }))
  } else if (typeof e.seconds_since_last_response === 'number') {
    const secs = e.seconds_since_last_response
    await mut($, c => ({ ...c, forcedCold: false, resumeUsd: undefined, lastReq: now - secs * 1000, ctxTokens: e.context_tokens ?? c.ctxTokens, model: e.model ?? c.model }))
  }
  await publishCache($, o)
}
async function cacheSwitch($: EngineInterface, o: Opts, e: { cache_ttl: '5m' | '1h'; to_model: string; source: string }, post: boolean): Promise<void> {
  const ttl = e.cache_ttl
  if (ttl !== '5m' && ttl !== '1h') return
  await mut($, c => ({
    ...c,
    ttlEvent: ttl,
    ...(post ? { model: e.to_model || c.model, forcedCold: c.lastReq != null && e.source !== 'resume' ? true : c.forcedCold } : {}),
  }))
  await persist($, 'event')
  await publishCache($, o)
}
async function cacheEnd($: EngineInterface, o: Opts): Promise<void> {
  await mut($, c => ({
    ...c,
    lastReq: undefined,
    forcedCold: false,
    resumeUsd: undefined,
    prev: undefined,
    reqs: [],
    coldWrites: 0,
    coldUsd: 0,
    ctxTokens: undefined,
    lastInputTotal: undefined,
    lastPingAt: undefined,
  }))
  await publishCache($, o)
}
async function togglePane($: EngineInterface, only: 'open' | 'toggle'): Promise<string> {
  const isUp = (await $.ui.panes()).some(p => p.id === PANE)
  if (isUp && only === 'toggle') {
    await $.ui.close({ id: PANE })
    return 'Cache clock closed.'
  }
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  return 'Cache clock opened.'
}

// --- band, status line and the one timer ------------------------------------------------------------------------------
async function bandSegments($: EngineInterface, o: Opts, now: number): Promise<(Segment | null)[]> {
  const [core, limits] = [await read($, coreA), await read($, limitsA)]
  const segs: (Segment | null)[] = []
  try {
    if (o.enabled.burn) segs.push(burnSegmentFrom(core, limits, now, o))
    if (o.enabled.compaction) segs.push(ctxSegment(calcContext(core, now, o), o))
    if (o.enabled.cache) {
      const saved = (await read($, cacheA)).savedTodayUsd
      segs.push(cacheSegmentFrom(calcCache(core, now, o, settingsFor(core), saved), saved, o))
    }
  } catch {
    // A failing mod draws nothing.
  }
  return segs
}
async function statusText($: EngineInterface, o: Opts, now: number): Promise<string | undefined> {
  const [core, limits] = [await read($, coreA), await read($, limitsA)]
  const parts: string[] = []
  if (o.enabled.burn) {
    const b = burnStatusFrom(core, limits, now, o)
    if (b) parts.push(b)
  }
  if (o.enabled.cache) {
    const calc = calcCache(core, now, o, settingsFor(core), 0)
    const st = calc.clock.state
    if (st !== 'unknown') parts.push(st === 'cold' ? 'cache cold' : `cache ${fmtCountdown(calc.clock.remainingMs ?? 0)}`)
  }
  return parts.length ? parts.join(' · ') : undefined
}

let statusOn = false
/** No-band status fallback (F30): decided per write from the live surfaces; cleared once when a surface appears. */
async function syncStatus($: EngineInterface, o: Opts): Promise<void> {
  try {
    const empty = (await $.session.surfaces()).length === 0
    if (empty) {
      $.ui.status(await statusText($, o, await $.clock.now()))
      statusOn = true
    } else if (statusOn) {
      statusOn = false
      $.ui.status(undefined)
    }
  } catch {
    // Best effort.
  }
}

let timer: { cancel(): void } | undefined
/** One tick: refresh the views, return the wait to the next one (conventions s8.4). */
async function tick($: EngineInterface, o: Opts): Promise<number> {
  let delay: number | undefined
  const want = (d: number): void => {
    delay = delay == null ? d : Math.min(delay, d)
  }
  try {
    const now = await $.clock.now()
    const [core, limits] = [await read($, coreA), await read($, limitsA)]
    if (o.enabled.burn) {
      await publishBurn($, o)
      if (limits.length > 0) want(60_000)
    }
    if (o.enabled.compaction) {
      await publishCtx($, o)
      const lc = core.lastCompact
      if (lc && now - lc.at < 60_000) want(Math.max(1000, Math.min(60_000, lc.at + 60_000 - now + 50)))
    }
    if (o.enabled.cache) {
      await publishCache($, o, false)
      await flushDirty($)
      const calc = calcCache(core, now, o, settingsFor(core), 0)
      let paneUp = false
      try {
        paneUp = (await $.ui.panes()).some(p => p.id === PANE)
      } catch {
        paneUp = false
      }
      const st = calc.clock.state
      if (st === 'warm' || st === 'expiring') {
        const rem = calc.clock.remainingMs ?? 0
        want(paneUp || rem <= 120_000 ? 1000 : rem < 600_000 ? 5000 : 30_000)
      } else if (paneUp && st !== 'unknown') want(30_000)
    }
    if (delay != null) await update($, clockA, () => now)
  } catch {
    // The next tick retries.
  }
  await syncStatus($, o)
  return delay ?? IDLE_MS
}
/** Re-evaluates the views now and re-arms the timer from the new state (F29). */
async function wake($: EngineInterface, o: Opts): Promise<void> {
  try {
    loop($, o, await tick($, o))
  } catch {
    // The next event wakes it again.
  }
}
function loop($: EngineInterface, o: Opts, ms: number): void {
  timer?.cancel()
  timer = $.clock.after(ms, () => {
    void tick($, o).then(next => loop($, o, next))
  })
}

// --- the module -----------------------------------------------------------------------------------------------------------
export const register: Register = (on, options) => {
  const o = parseOpts(options)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    statusOn = false
    if (o.enabled.cache) await pruneStore($, await $.clock.now())
    if (o.enabled.burn) await burnStart($, o).catch(() => undefined)
    if (o.enabled.compaction) await ctxStart($, o).catch(() => undefined)
    if (o.enabled.cache) await cacheStart($, o).catch(() => undefined)
    try {
      loop($, o, await tick($, o))
    } catch {
      // Without the timer the views still refresh on events and draws.
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (o.enabled.burn) await burnMeasure($, o, e).catch(() => undefined)
    if (o.enabled.compaction) await ctxMeasure($, o, e).catch(() => undefined)
    if (o.enabled.cache) await cacheMeasure($, o, e).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await syncStatus($, o)
    return r
  }).catch(($, e, next) => next(e))

  on('config.set', async ($, e, next) => {
    const r = await next(e)
    if (o.enabled.cache) {
      try {
        await refreshSettings($)
        await publishCache($, o)
      } catch {
        // Best effort.
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      if (e.reason === 'clear') {
        if (o.enabled.compaction) {
          await mut($, c => ({ ...c, compactions: 0, lastCompact: undefined, compactPending: false, ctx: { autoCompact: c.ctx.autoCompact, threshold: c.ctx.threshold, thresholdAt: c.ctx.thresholdAt } }))
          await publishCtx($, o)
        }
        if (o.enabled.cache) await cacheEnd($, o)
      }
      await flushDirty($, true)
    } catch {
      // Best effort.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId) return next(e)
    let pre: UsageCore | undefined
    try {
      pre = await read($, coreA)
    } catch {
      pre = undefined
    }
    const r = await next(e)
    try {
      if (typeof (r as { skip?: unknown }).skip !== 'string') {
        const now = await $.clock.now()
        const res = r as { tokensBefore?: number; tokensAfter?: number }
        if (o.enabled.compaction) {
          await mut($, c => compactedCore(c, pre, res, now))
          await publishCtx($, o)
        }
        if (o.enabled.cache) {
          await mut($, c => ({ ...c, forcedCold: true, resumeUsd: undefined, lastInputTotal: undefined, ctxTokens: typeof res.tokensAfter === 'number' ? res.tokensAfter : undefined }))
          await publishCache($, o)
        }
      }
    } catch {
      // The result is the engine's; the alert may miss one.
    }
    return r
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (o.enabled.cache) await cacheClassicStart($, o, e).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PreModelSwitch', async ($, e, next) => {
    const r = await next(e)
    if (o.enabled.cache) await cacheSwitch($, o, e, false).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PostModelSwitch', async ($, e, next) => {
    const r = await next(e)
    if (o.enabled.compaction) {
      await refreshThreshold($, true)
      await publishCtx($, o)
    }
    if (o.enabled.cache) await cacheSwitch($, o, e, true).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  if (o.enabled.burn) {
    on('command.run', { command: 'burn' }, async $ => ({ text: await burnCard($, o) }))
    on('command.run', { command: 'usage-burn' }, async $ => ({ text: await burnCard($, o) }))
  }

  if (o.enabled.cache) {
    // A main step stamps the request; its usage feeds learning, savings, hit ratio and cold-write counts.
    on('turn.step', async function* ($, e, next) {
      const main = e.agentId === undefined
      let start = 0
      let wasCold = false
      try {
        start = await $.clock.now()
        if (main) {
          const core = await read($, coreA)
          const settings = await settingsForEvent($, core)
          const t = ttlOf(core, start, o, settings)
          wasCold = cacheClock({ lastReqAt: core.lastReq, ttl: t.ttl, now: start, forcedCold: core.forcedCold }).state === 'cold'
          await mut($, c => stepStartCore(c, start, settings))
          // WARM at once, even while a cold write is still being paid (F29).
          await wake($, o)
          if (o.cache.autoOpen && !core.wrote['pane']) {
            await mut($, c => ({ ...c, wrote: { ...c.wrote, pane: start } }))
            void $.ui.open({ id: PANE, title: PANE_TITLE })
          }
        }
      } catch {
        // Never disturb the step.
      }
      const result = yield* next(e)
      try {
        const u = result?.usage as UsageLike | null | undefined
        if (u) {
          const model = u.model || e.model
          const core = await read($, coreA)
          const settings = await settingsForEvent($, core)
          const saved = savedFor(u, model, ttlOf(core, start, o, settings).ttl, o)
          await mut($, c => dayCore(c, saved, u, localDate(start)))
          await persist($, 'day')
          if (main) {
            const step = stepEndCore(core, u, model, start, wasCold, o, settings)
            await mut($, step.patch)
            if (step.learnedChanged) await persist($, 'learned', true)
          }
        }
        await publishCache($, o)
      } catch {
        // Bookkeeping never disturbs the stream.
      }
      return result
    })

    on('turn.complete', async ($, e, next) => {
      const r = await next(e)
      if (e.agentId === undefined) await wake($, o).catch(() => undefined)
      return r
    }).catch(($, e, next) => next(e))

    // cache-tax pings are model.fork requests that read the cache: they keep it warm.
    on('model.fork', async ($, e, next) => {
      const r = await next(e)
      try {
        const u = (r as { value?: { usage?: UsageLike } }).value?.usage
        if (u && (u.cache_read_input_tokens ?? 0) > 0) {
          const now = await $.clock.now()
          const core = await read($, coreA)
          const settings = await settingsForEvent($, core)
          const saved = savedFor(u, core.model, ttlOf(core, now, o, settings).ttl, o)
          await mut($, c => ({ ...dayCore(c, saved, u, localDate(now)), lastReq: now, lastPingAt: now, forcedCold: false, resumeUsd: undefined }))
          await persist($, 'day')
          await persist($, 'kw')
          await publishCache($, o)
        }
      } catch {
        // Observer only.
      }
      return r
    }).catch(($, e, next) => next(e))

    // /keepwarm belongs to cache-tax: observe it, never answer (usage.md s2, UNVERIFIED whether it reaches us).
    on('command.run', { command: 'keepwarm' }, async ($, e, next) => {
      const r = await next(e)
      try {
        const now = await $.clock.now()
        const kw = observeKeepwarm(e.args ?? '', now)
        if (kw) {
          await mut($, c => ({ ...c, kw }))
          await persist($, 'kw')
          await publishCache($, o)
        }
      } catch {
        // Observer only.
      }
      return r
    }).catch(($, e, next) => next(e))

    on('command.run', { command: 'cacheclock' }, async $ => ({ text: await togglePane($, 'toggle') }))
    on('command.run', { command: 'usage-cacheclock' }, async $ => ({ text: await togglePane($, 'open') }))

    on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
      await read($, clockA)
      const t = $.ui.resolve(e)
      const { Box, Text } = t
      const now = await $.clock.now()
      const core = await read($, coreA)
      const saved = (await read($, cacheA)).savedTodayUsd
      const calc = calcCache(core, now, o, settingsFor(core), saved)
      const cols = e.props?.bodyColumns || e.viewport?.columns || 58
      const m: PaneModel = paneModel(core, calc, saved, now, o, cols)
      const ringNode = (line: string, ring: NonNullable<PaneModel['ring']>) => {
        if (e.surface === 'terminal' || !('Svg' in t)) return null
        const { Svg } = t
        const r = ringSvg(ring, cols * 8 - 16)
        return <Svg key="ring" source={r.source} alt={line} width={r.w} height={r.h} />
      }
      // Never truncate (F27): a left+right row wraps, the right part drops under the left one when they do not fit.
      return (
        <Box flexDirection="column">
          {m.rows.map((row, i) => {
            const ringed = i === m.ringIndex && m.ring && ringNode(m.lines[i] as string, m.ring)
            if (ringed) return ringed
            const dim = i > 0 && /^(Cold writes|If it lapses)/.test(row.left)
            if (row.right == null) {
              return (
                <Text key={`l${i}`} bold={i === 0} dimColor={dim}>
                  {row.left}
                </Text>
              )
            }
            return (
              <Box key={`l${i}`} flexDirection="row" flexWrap="wrap" columnGap={2}>
                <Text bold={i === 0}>{row.left}</Text>
                <Text dimColor={dim || i === 0}>{row.right}</Text>
              </Box>
            )
          })}
        </Box>
      )
    })
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Subscribing to the tick redraws the countdowns.
    await read($, clockA)
    // bodyColumns is the box the band draws into; the viewport is the fallback where a surface did not measure it.
    return renderBand({ resolve: x => $.ui.resolve(x) }, e, next, {
      minBandRows: o.minBandRows,
      tolerantNext: true,
      viewportFallback: true,
      flat: true,
      segments: async () => bandSegments($, o, await $.clock.now()),
    })
  }).catch(($, e, next) => next(e))
}
