// Shared model of the usage plugin: atoms, options, persistence and the pure views (usage.md s1 to s5).
// Everything a render reads is derived from the `core` atom plus the clock at draw time, so a countdown is
// right even when no tick ran. Module variables are never state.
import type { PluginOptions } from 'claude-code'

import type { CacheView, ContextView, PaceView, UsageCore, UsageSample, UsageWindow } from '../types'
import { cacheClock, cacheTaxDisagrees, cacheTaxKey, hitRatio, resolveTtl } from './_shared/cache'
import type { CacheClock, SettingsSlice, TtlResolved } from './_shared/cache'
import { modelFamily } from './_shared/fmt'
import { thinSamples, windowPace, worse } from './_shared/pace'
import type { PaceOpts, WindowKind, WindowPace } from './_shared/pace'
import { parsePricesJson, recacheUsd, rowFor } from './_shared/prices'
import type { PriceOverrides } from './_shared/prices'

// --- initial values (the atoms themselves are declared in register.tsx: the validator reads them there) --------
export const EMPTY_CACHE: CacheView = { state: 'unknown', ttl: '1h', ttlSource: 'assumed', savedTodayUsd: 0, coldWrites: 0, coldUsd: 0 }
export const INIT_CORE: UsageCore = {
  seenMeasure: false,
  hasRateLimits: false,
  samples: [],
  learning: {},
  forcedCold: false,
  reqs: [],
  day: { date: '', saved: 0, reads: 0, writes: 0, reqs: 0 },
  coldWrites: 0,
  coldUsd: 0,
  ctx: { autoCompact: true },
  compactions: 0,
  wrote: {},
  dirty: {},
}

// --- options -------------------------------------------------------------------------
export type Opts = {
  minBandRows: number
  mascots: 'auto' | 'on' | 'off'
  pricesJson: string
  enabled: { burn: boolean; cache: boolean; compaction: boolean }
  burn: { hotAt: number; plentyBelow: number; recentWindowMin: number; minElapsedFiveMin: number; minElapsedSevenHr: number; showSpend: boolean; bites: boolean; staleMin: number }
  cache: { ttl: 'auto' | '5m' | '1h'; followCacheTax: boolean; keepwarmLine: boolean; expiringSec: number; assumeSub: '5m' | '1h'; assumeApi: '5m' | '1h'; showSavings: boolean; autoOpen: boolean }
  compaction: { showFrom: number; warnAt: number; dangerAt: number; showCount: boolean }
}
// The spec names options `cache.ttl`; manifest keys must be identifiers (conventions s12): `cache_ttl` is the
// canonical key. The dotted and camel spellings are accepted too.
function pick(o: PluginOptions, dotted: string): unknown {
  const camel = dotted.replace(/\.(\w)/g, (_m, c: string) => c.toUpperCase())
  for (const k of [dotted.replace(/\./g, '_'), dotted, camel]) if (o[k] !== undefined) return o[k]
  return undefined
}
const num = (o: PluginOptions, k: string, d: number): number => {
  const v = pick(o, k)
  return typeof v === 'number' && isFinite(v) ? v : d
}
const bool = (o: PluginOptions, k: string, d: boolean): boolean => {
  const v = pick(o, k)
  return typeof v === 'boolean' ? v : d
}
const str = (o: PluginOptions, k: string, d: string): string => {
  const v = pick(o, k)
  return typeof v === 'string' ? v : d
}
const ttlOpt = (o: PluginOptions, k: string, d: '5m' | '1h'): '5m' | '1h' => {
  const v = pick(o, k)
  return v === '5m' || v === '1h' ? v : d
}

export function parseOpts(o: PluginOptions): Opts {
  const m = str(o, 'mascots', 'auto')
  const t = str(o, 'cache.ttl', 'auto')
  return {
    minBandRows: num(o, 'minBandRows', 4),
    mascots: m === 'on' || m === 'off' ? m : 'auto',
    pricesJson: str(o, 'pricesJson', ''),
    enabled: { burn: bool(o, 'mod.burn.enabled', true), cache: bool(o, 'mod.cache.enabled', true), compaction: bool(o, 'mod.compaction.enabled', true) },
    burn: {
      hotAt: num(o, 'burn.hotAt', 100),
      plentyBelow: num(o, 'burn.plentyBelow', 60),
      recentWindowMin: num(o, 'burn.recentWindowMin', 60),
      minElapsedFiveMin: num(o, 'burn.minElapsedFiveMin', 10),
      minElapsedSevenHr: num(o, 'burn.minElapsedSevenHr', 3),
      showSpend: bool(o, 'burn.showSpend', true),
      bites: bool(o, 'burn.bites', true),
      staleMin: num(o, 'burn.staleMin', 30),
    },
    cache: {
      ttl: t === '5m' || t === '1h' ? t : 'auto',
      followCacheTax: bool(o, 'cache.followCacheTax', true),
      keepwarmLine: bool(o, 'cache.keepwarmLine', true),
      expiringSec: num(o, 'cache.expiringSec', 300),
      assumeSub: ttlOpt(o, 'cache.assumeSubscriptionTtl', '1h'),
      assumeApi: ttlOpt(o, 'cache.assumeApiTtl', '5m'),
      showSavings: bool(o, 'cache.showSavings', true),
      autoOpen: bool(o, 'cache.pane.autoOpen', false),
    },
    compaction: { showFrom: num(o, 'compaction.showFrom', 60), warnAt: num(o, 'compaction.warnAt', 80), dangerAt: num(o, 'compaction.dangerAt', 90), showCount: bool(o, 'compaction.showCount', true) },
  }
}

export const paceOpts = (o: Opts): PaceOpts => ({
  hotAt: o.burn.hotAt,
  plentyBelow: o.burn.plentyBelow,
  recentWindowMin: o.burn.recentWindowMin,
  minElapsedFiveMin: o.burn.minElapsedFiveMin,
  minElapsedSevenHr: o.burn.minElapsedSevenHr,
})

export function priceOverrides(o: Opts): { ov: PriceOverrides | undefined; custom: boolean; bad: boolean } {
  const p = parsePricesJson(o.pricesJson)
  if (!p.ok) return { ov: undefined, custom: false, bad: true }
  const custom = Object.keys(p.overrides.byFamily).length > 0
  return { ov: custom ? p.overrides : undefined, custom, bad: false }
}

// --- small helpers -----------------------------------------------------------------------
export const hm = (ts: number): string => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** Two decimals always, minus sign in front of the dollar sign. */
export const usd2 = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
/** Terminal cell width: emoji and wide symbols count 2. */
export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    n += cp >= 0x1f000 || cp === 0x26d4 ? 2 : 1
  }
  return n
}
export const pctText = (p: number): string => `${p < 100 && Math.round(p) >= 100 ? 99 : Math.round(p)}%`

// --- settings (cache-tax detection) ---------------------------------------------------------
export function trimSettings(s: unknown): UsageCore['settings'] {
  const src = (s ?? {}) as Record<string, any>
  const out: NonNullable<UsageCore['settings']> = {}
  const ep = src.enabledPlugins
  if (ep && typeof ep === 'object') {
    for (const k of Object.keys(ep)) if (k.startsWith('cache-tax@')) (out.enabledPlugins ??= {})[k] = ep[k] === true
  }
  const pc = src.pluginConfigs
  if (pc && typeof pc === 'object') {
    for (const k of Object.keys(pc)) {
      if (!k.startsWith('cache-tax@')) continue
      const opt = pc[k]?.options
      if (!opt || typeof opt !== 'object') continue
      const keep: Record<string, string> = {}
      for (const f of ['ttl', 'promptCacheTtl']) if (typeof opt[f] === 'string') keep[f] = opt[f]
      ;(out.pluginConfigs ??= {})[k] = { options: keep }
    }
  }
  if (typeof src.promptCacheTtl === 'string') out.promptCacheTtl = src.promptCacheTtl
  return out
}

// --- persistence kernels (usage.md s5 store keys, s7: at most one write a minute per key family) ------------------
export type StoreKind = 'samples' | 'day' | 'event' | 'kw' | 'learned'
export const STORE_KINDS: readonly StoreKind[] = ['samples', 'day', 'event', 'kw', 'learned']
export function buildStore(kind: StoreKind, c: UsageCore, sid: string): { key: string; value: unknown } | undefined {
  switch (kind) {
    case 'samples':
      return { key: `burn:samples:${sid}`, value: { v: 1, samples: c.samples } }
    case 'day':
      return c.day.date ? { key: `cache:day:${c.day.date}:${sid}`, value: { v: 1, saved: c.day.saved, reads: c.day.reads, writes: c.day.writes, reqs: c.day.reqs } } : undefined
    case 'event':
      return c.ttlEvent ? { key: `cache:ttlEvent:${sid}`, value: { v: 1, ttl: c.ttlEvent } } : undefined
    case 'kw':
      return { key: `cache:keepwarm:${sid}`, value: { v: 1, untilAt: c.kw?.untilAt, lastPingAt: c.lastPingAt, state: c.kw?.state } }
    case 'learned':
      return c.learned ? { key: 'cache:learned', value: { v: 1, ttl: c.learned.ttl, at: c.learned.at, family: c.learned.family } } : undefined
  }
}

/** Samples of other sessions that belong to the current windows (same resetsAt), merged and thinned. */
export function mergeSamples(own: readonly UsageSample[], others: readonly UsageSample[], limits: readonly UsageWindow[], now: number): UsageSample[] {
  const r5 = limits.find(l => l.kind === 'five_hour')?.resetsAt
  const r7 = limits.find(l => l.kind === 'seven_day')?.resetsAt
  const got: UsageSample[] = []
  for (const s of others) {
    const keep5 = s.five != null && r5 != null && s.r5 === r5
    const keep7 = s.seven != null && r7 != null && s.r7 === r7
    if (keep5 || keep7) got.push({ t: s.t, five: keep5 ? s.five : undefined, seven: keep7 ? s.seven : undefined, r5: keep5 ? s.r5 : undefined, r7: keep7 ? s.r7 : undefined })
  }
  const seen = new Set(own.map(s => s.t))
  const all = [...own, ...got.filter(s => !seen.has(s.t))].sort((a, b) => a.t - b.t)
  return thinSamples(all, now, 200)
}

// --- pure views: burn ------------------------------------------------------------------------
export type PaceCalc = {
  five?: WindowPace
  seven?: WindowPace
  spend?: UsageWindow
  worst?: WindowPace
  stale?: number // minutes since the last reading when stale
}
export function calcPace(core: UsageCore, limits: readonly UsageWindow[], now: number, o: Opts): PaceCalc {
  const one = (kind: WindowKind): WindowPace | undefined => {
    const l = limits.find(x => x.kind === kind)
    if (!l) return undefined
    const reset = l.resetsAt
    // Only samples of the current window feed the slope.
    const own = core.samples.filter(s => (kind === 'five_hour' ? s.r5 : s.r7) === reset)
    const samples = own.map(s => ({ t: s.t, p: (kind === 'five_hour' ? s.five : s.seven) as number })).filter(s => s.p != null)
    const w = windowPace({ kind, percent: l.percent, resetsAt: l.resetsAt, now, samples }, paceOpts(o))
    const flagged = core.learning[kind]
    if (flagged != null && flagged === (l.resetsAt ?? 0) && w.state !== 'limit') return { ...w, state: 'learning', projected: undefined, hitAt: undefined }
    return w
  }
  const five = one('five_hour')
  const seven = one('seven_day')
  const spend = limits.find(l => l.kind === 'spend_limit')
  const calc: PaceCalc = { five, seven, spend, worst: worse(five, seven) }
  if (core.readingAt != null && now - core.readingAt >= o.burn.staleMin * 60_000) calc.stale = Math.floor((now - core.readingAt) / 60_000)
  return calc
}
export function paceView(c: PaceCalc, text: string): PaceView | null {
  if (!c.worst) return null
  const w = (x?: WindowPace) => (x ? { state: x.state, projected: x.projected, hitAt: x.hitAt } : undefined)
  return { five: w(c.five), seven: w(c.seven), worst: c.worst.state, text }
}

// --- pure views: cache ------------------------------------------------------------------------
export type CacheCalc = {
  view: CacheView
  ttl: TtlResolved
  clock: CacheClock
  taxInstalled: boolean
  disagree?: string
  recacheEst: boolean
  isDefaultPrice: boolean
}
export function ttlOf(core: UsageCore, now: number, o: Opts, settings: UsageCore['settings']): TtlResolved {
  const fam = core.model ? modelFamily(core.model) : undefined
  const learned = core.learned && (!core.learned.family || !fam || core.learned.family === fam) ? { ttl: core.learned.ttl, at: core.learned.at } : undefined
  return resolveTtl({
    option: o.cache.ttl,
    event: core.ttlEvent,
    learned,
    followCacheTax: o.cache.followCacheTax,
    settings: settings as SettingsSlice | undefined,
    hasRateLimits: core.hasRateLimits,
    assumeSubscription: o.cache.assumeSub,
    assumeApi: o.cache.assumeApi,
    now,
  })
}
export function calcCache(core: UsageCore, now: number, o: Opts, settings: UsageCore['settings'], savedToday: number): CacheCalc {
  const ttl = ttlOf(core, now, o, settings)
  const clock = cacheClock({ lastReqAt: core.lastReq, ttl: ttl.ttl, now, expiringSec: o.cache.expiringSec, forcedCold: core.forcedCold })
  const taxInstalled = cacheTaxKey(settings as SettingsSlice | undefined) !== undefined
  const { ov } = priceOverrides(o)
  const ctx = core.ctxTokens ?? core.lastInputTotal
  let recache: number | undefined
  let isDefaultPrice = false
  let recacheEst = false
  if (ctx != null && ctx > 0) {
    const r = rowFor(core.model, { overrides: ov, promptTokens: ctx })
    isDefaultPrice = r.isDefault
    recache = recacheUsd(ctx, core.model, ttl.ttl, { overrides: ov })
  }
  if (clock.state === 'cold' && core.resumeUsd != null) {
    recache = core.resumeUsd
    recacheEst = true
  }
  // keepwarm: only meaningful with cache-tax installed (usage.md s2)
  let keepwarm: CacheView['keepwarm']
  if (taxInstalled) {
    const kw = core.kw
    const pingFresh = core.lastPingAt != null && now - core.lastPingAt < 2 * 3600_000
    if (kw?.state === 'off') keepwarm = { state: 'off' }
    else if (kw?.state === 'on' && (kw.untilAt == null || kw.untilAt > now)) keepwarm = { state: 'on', untilAt: kw.untilAt, lastPingAt: core.lastPingAt }
    else if (kw?.state === 'on') keepwarm = { state: 'off' }
    else if (pingFresh) keepwarm = { state: 'on', lastPingAt: core.lastPingAt }
    else keepwarm = { state: 'unknown' }
  }
  const view: CacheView = {
    state: clock.state,
    expiresAt: clock.expiresAt,
    ttl: ttl.ttl,
    ttlSource: ttl.source,
    keepwarm,
    ctxTokens: ctx,
    recacheUsd: recache,
    savedTodayUsd: savedToday,
    hitRatio: hitRatio(core.reqs, 20),
    coldWrites: core.coldWrites,
    coldUsd: core.coldUsd,
  }
  return { view, ttl, clock, taxInstalled, disagree: cacheTaxDisagrees(ttl), recacheEst, isDefaultPrice }
}

// --- pure views: context -----------------------------------------------------------------------
export type CtxLevel = 'info' | 'warn' | 'danger'
export type CtxCalc = {
  percent?: number
  toCompact?: number
  autoCompact: boolean
  level: CtxLevel
  visible: boolean
  compacted?: { before?: number; after?: number }
  count: number
}
export function calcContext(core: UsageCore, now: number, o: Opts): CtxCalc {
  const c = core.ctx
  const p = c.percent
  let toCompact: number | undefined
  if (c.autoCompact && c.threshold != null && c.window && c.window > 0) {
    const tokens = c.tokens ?? (p != null ? (p / 100) * c.window : undefined)
    if (tokens != null) toCompact = Math.max(0, ((c.threshold - tokens) / c.window) * 100)
  }
  let level: CtxLevel = 'info'
  if (p != null) {
    if (p >= o.compaction.dangerAt || (toCompact != null && toCompact <= 5)) level = 'danger'
    else if (p >= o.compaction.warnAt || (toCompact != null && toCompact <= 15)) level = 'warn'
  }
  const lc = core.lastCompact
  const compacted = lc && now - lc.at < 60_000 ? { before: lc.before, after: lc.after } : undefined
  return { percent: p, toCompact, autoCompact: c.autoCompact, level, visible: p != null && p >= o.compaction.showFrom, compacted, count: core.compactions }
}
export function contextView(c: CtxCalc, core: UsageCore): ContextView | null {
  if (c.percent == null && core.compactions === 0) return null
  const lc = core.lastCompact
  return {
    percent: c.percent,
    toCompact: c.toCompact != null ? Math.round(c.toCompact) : undefined,
    autoCompact: c.autoCompact,
    compactions: core.compactions,
    lastCompact: lc && lc.before != null && lc.after != null ? { before: lc.before, after: lc.after, at: lc.at } : undefined,
  }
}
