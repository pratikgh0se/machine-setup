// Cache Clock (usage.md s2): how long the prompt cache stays warm, what a cold return costs, what the cache saved.
// PURE: every `$` call lives in register.tsx.
import type { Segment, Variant } from '../_shared/band'
import { keepwarmLine, learnTtl, ttlLine } from '../_shared/cache'
import { fmtCountdown, modelFamily, parseDuration } from '../_shared/fmt'
import { GLYPH, termMeterRatio } from '../_shared/glyphs'
import { priceLabel, savedUsd, writePrice } from '../_shared/prices'
import { bevel, fit, mascotSvg, segMeter, svgDoc, text, textWidth } from '../_shared/svgkit'
import { V } from '../_shared/tokens'
import { cellWidth, hm, priceOverrides, ttlOf, usd2 } from '../core'
import type { CacheCalc, Opts } from '../core'
import type { UsageCore } from '../../types'

const px = (cells: number): number => Math.max(40, cells * 8 - 16)

// --- text ---------------------------------------------------------------------------------------
const costText = (calc: CacheCalc): string | undefined => (calc.view.recacheUsd != null ? `~${usd2(calc.view.recacheUsd)}` : undefined)

function drawCache(kind: 'full' | 'short' | 'tiny', d: { cold: boolean; expiring: boolean; ratio: number; time: string; word: string; saves?: string; costTxt?: string }, W: number): string {
  let s = mascotSvg('pom', 0, -1, 32, { mode: 'auto', opacity: d.cold ? 0.55 : undefined })
  if (d.cold) s += text(30, 8, 'Z z', { size: 9, fill: V.text2 })
  let x = 38
  if (kind === 'tiny') return s + (d.cold ? text(x, 19, 'cold', { size: 10, fill: V.text2 }) : text(x, 19, d.time, { size: 10 }))
  s += text(x, 19, 'CACHE', { size: 10 })
  x += textWidth('CACHE', 10) + 6
  if (d.cold) {
    const msg = d.costTxt && kind === 'full' ? `cold · return costs ${d.costTxt}` : d.costTxt ? `cold ${d.costTxt}` : 'cold'
    return s + text(x, 19, fit(msg, W - x - 4, 10, 'mono'), { size: 10, face: 'mono', fill: V.text2 })
  }
  if (kind === 'full') {
    s += segMeter(x, 10, { cells: 12, cellW: 6, gap: 1, cellH: 10, ratio: d.ratio, color: d.expiring ? V.warn : V.accent })
    x += 83 + 6
  }
  s += text(x, 19, d.time, { size: 10 })
  x += textWidth(d.time, 10) + 8
  if (kind === 'full') {
    const msg = `${d.word}${d.saves ? ` · ${d.saves}` : ''}`
    s += text(x, 19, fit(msg, W - x - 4, 10, 'mono'), { size: 10, face: 'mono', fill: V.text2 })
  }
  return s
}

export function cacheSegmentFrom(calc: CacheCalc, saved: number, o: Opts): Segment | null {
  const st = calc.clock.state
  if (st === 'unknown') return null
  const cold = st === 'cold'
  const rem = calc.clock.remainingMs ?? 0
  const time = fmtCountdown(rem)
  const ratio = Math.max(0, Math.min(1, rem / (calc.view.ttl === '1h' ? 3600_000 : 300_000)))
  const saves = o.cache.showSavings && saved > 0 ? `saves ${usd2(saved)} today` : undefined
  const costTxt = costText(calc)
  const word = st === 'expiring' ? 'expiring' : 'warm'
  const texts = cold
    ? {
        full: `${GLYPH.pom}${GLYPH.cold} CACHE cold${costTxt ? ` · return costs ${costTxt}` : ''}`,
        short: `${GLYPH.pom}${GLYPH.cold} cold${costTxt ? ` ${costTxt}` : ''}`,
        tiny: `${GLYPH.pom}${GLYPH.cold} cold`,
      }
    : {
        full: `${GLYPH.pom} CACHE ${termMeterRatio(ratio)} ${time} ${word}${saves ? ` · ${saves}` : ''}`,
        short: `${GLYPH.pom} CACHE ${time}`,
        tiny: `${GLYPH.pom} ${time}`,
      }
  const d = { cold, expiring: st === 'expiring', ratio, time, word, saves, costTxt }
  const mk = (k: 'full' | 'short' | 'tiny', minCells: number): Variant => {
    const cells = Math.max(minCells, cellWidth(texts[k]))
    // A variant is never narrower than what its Svg draws (F28): tiny = mascot (38) + the whole time / `cold`.
    const w = k === 'tiny' ? Math.max(px(cells), 38 + Math.max(cold ? 4 : time.length, 1) * 6, 38 + textWidth(cold ? 'cold' : time, 10) + 2) : px(cells)
    return { px: w, cells, svg: drawCache(k, d, w), text: texts[k], alt: texts[k] }
  }
  return { id: 'cache', order: 3, priority: 3, variants: [mk('full', 56), mk('short', 26), mk('tiny', 9)] }
}

// --- pane --------------------------------------------------------------------------------------
const pad = (left: string, right: string, width = 56): string => left + ' '.repeat(Math.max(2, width - left.length - right.length)) + right

/** One pane line. `right` (when present) is laid out as a wrapping row: it drops under `left` when both do not fit (F27). */
export type PaneRow = { left: string; right?: string }
export type PaneModel = { lines: string[]; rows: PaneRow[]; ringIndex: number; ring?: { ratio: number; cold: boolean; time: string; word: string } }

export function paneModel(core: UsageCore, calc: CacheCalc, saved: number, now: number, o: Opts, cols?: number): PaneModel {
  const lines: string[] = []
  const rows: PaneRow[] = []
  const add = (left: string, right?: string, gap = 2): void => {
    rows.push(right == null ? { left } : { left, right })
    lines.push(right == null ? left : left + ' '.repeat(gap) + right)
  }
  lines.push(pad('CACHE CLOCK', ttlLine(calc.ttl)))
  rows.push({ left: 'CACHE CLOCK', right: ttlLine(calc.ttl) })
  if (calc.disagree) add(calc.disagree)
  const st = calc.clock.state
  const meterN = cols ? Math.max(6, Math.min(24, cols - 30)) : 24
  let ringIndex = -1
  let ring: PaneModel['ring']
  const ttlMs = calc.view.ttl === '1h' ? 3600_000 : 300_000
  if (st === 'unknown') {
    add(`${GLYPH.pom} No request yet`)
  } else if (st === 'cold') {
    ringIndex = lines.length
    ring = { ratio: 0, cold: true, time: '', word: 'COLD' }
    add(`${GLYPH.pom}${GLYPH.cold} COLD  cache lapsed   ring ${termMeterRatio(0, meterN)}`)
  } else {
    const rem = calc.clock.remainingMs ?? 0
    const word = st === 'expiring' ? 'WARM · EXPIRING' : 'WARM'
    ringIndex = lines.length
    ring = { ratio: rem / ttlMs, cold: false, time: fmtCountdown(rem), word }
    add(`${GLYPH.pom} ${word}  ${fmtCountdown(rem)} left   ring ${termMeterRatio(Math.max(0, Math.min(1, rem / ttlMs)), meterN)}`)
  }
  if (calc.taxInstalled && o.cache.keepwarmLine) add(keepwarmLine(calc.view.keepwarm, now, hm))
  const savedTxt = o.cache.showSavings ? `Saved by cache today   ${usd2(saved)}` : 'Saved by cache today   hidden'
  add(savedTxt, calc.view.hitRatio != null ? `hit ratio ${Math.round(calc.view.hitRatio * 100)}% (last 20)` : undefined, 5)
  const { ov, custom } = priceOverrides(o)
  const label = priceLabel(ov, custom)
  add(`Cold writes this session  ${core.coldWrites}  ~${usd2(core.coldUsd)}`, label, 5)
  const c = costText(calc)
  const dflt = calc.isDefaultPrice ? ' (default price)' : ''
  if (st === 'cold') add(`Return costs ${c ?? 'n/a'}${calc.recacheEst ? ' est.' : ''}${c ? dflt : ''}`)
  else if (st !== 'unknown') add(`If it lapses, return costs ${c ?? 'n/a'}${c ? dflt : ''}`)
  return { lines, rows, ringIndex, ring }
}

/** The pane ring. `maxW` is the pane width in px (the Svg is never wider than the pane); at most 330. */
export function ringSvg(r: NonNullable<PaneModel['ring']>, maxW = 330): { source: string; w: number; h: number } {
  const w = Math.max(120, Math.min(330, Math.floor(maxW)))
  const h = 50
  let body = bevel(0, 2, w - 2, h - 4, { tone: 'panel' })
  body += mascotSvg('pom', 6, 5, 40, { mode: 'auto', opacity: r.cold ? 0.55 : undefined })
  if (r.cold) body += text(40, 12, 'Z z', { size: 9, fill: V.text2 })
  const room = w - 56 - 6
  let size = 12
  let tail = `${r.time} left`
  const need = (sz: number, t: string): number => textWidth(r.word, sz) + (r.time ? 12 + textWidth(t, sz) : 0)
  if (r.time && need(size, tail) > room) size = 10
  if (r.time && need(size, tail) > room) tail = r.time
  body += text(56, 20, r.word, { size })
  if (r.time) body += text(56 + textWidth(r.word, size) + 12, 20, tail, { size })
  const cells = Math.max(4, Math.min(24, Math.floor((room + 1) / 9)))
  body += segMeter(56, 28, { cells, cellW: 8, gap: 1, cellH: 10, ratio: r.ratio, color: V.accent })
  return { source: svgDoc(w, h, body), w, h }
}

// --- keepwarm observer ---------------------------------------------------------------------------
export function observeKeepwarm(args: string, now: number): UsageCore['kw'] | undefined {
  const a = args.trim().toLowerCase()
  if (a === 'off') return { state: 'off', at: now }
  if (a === 'always') return { state: 'on', at: now }
  const ms = parseDuration(a)
  if (ms != null && ms > 0) return { state: 'on', untilAt: now + ms, at: now }
  return undefined
}


// --- step bookkeeping -----------------------------------------------------------------------------
export type UsageLike = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string }

/** Dollars one request saved (usage.md "Savings today"), priced at the current TTL. */
export function savedFor(u: UsageLike, model: string | undefined, ttl: '5m' | '1h', o: Opts): number {
  return savedUsd(u, model, { overrides: priceOverrides(o).ov, ttl })
}
export function dayCore(c: UsageCore, saved: number, u: UsageLike, today: string): UsageCore {
  const day = c.day.date === today ? c.day : { date: today, saved: 0, reads: 0, writes: 0, reqs: 0 }
  return { ...c, day: { date: today, saved: day.saved + saved, reads: day.reads + (u.cache_read_input_tokens ?? 0), writes: day.writes + (u.cache_creation_input_tokens ?? 0), reqs: day.reqs + 1 } }
}
/** A main request entered: stamp it and the cache is no longer forced cold. */
export const stepStartCore = (c: UsageCore, start: number, settings: UsageCore['settings']): UsageCore => ({ ...c, lastReq: start, forcedCold: false, resumeUsd: undefined, settings: c.settings ?? settings })

/** A main request returned usage: learning, hit ratio, cold-write count. `learnedChanged` says to persist the TTL. */
export function stepEndCore(core: UsageCore, u: UsageLike, model: string | undefined, start: number, wasCold: boolean, o: Opts, settings: UsageCore['settings']): { patch: (c: UsageCore) => UsageCore; learnedChanged: boolean } {
  const rd = u.cache_read_input_tokens ?? 0
  const wr = u.cache_creation_input_tokens ?? 0
  const inT = u.input_tokens ?? 0
  const ttl = ttlOf(core, start, o, settings).ttl
  const learn = core.prev ? learnTtl({ gapMs: start - core.prev.at, prevInputTotal: core.prev.total, cacheRead: rd, cacheCreation: wr }) : undefined
  const coldCost = wasCold && wr > 0 ? (wr * writePrice(model, ttl, { overrides: priceOverrides(o).ov, promptTokens: inT + rd + wr })) / 1e6 : 0
  return {
    learnedChanged: learn != null && core.learned?.ttl !== learn,
    patch: c => ({
      ...c,
      model,
      prev: { at: start, total: inT + rd + wr },
      lastInputTotal: inT + rd + wr,
      reqs: [...c.reqs, { read: rd, creation: wr, input: inT }].slice(-20),
      coldWrites: c.coldWrites + (coldCost > 0 ? 1 : 0),
      coldUsd: c.coldUsd + coldCost,
      learned: learn ? { ttl: learn, at: start, family: modelFamily(model) } : c.learned,
    }),
  }
}

