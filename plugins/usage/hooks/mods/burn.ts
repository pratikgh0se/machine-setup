// Burn Meter (usage.md s1): the 5-hour and weekly limits, pace and a forecast. PURE: every `$` call lives in
// register.tsx (the validator never follows `$` across an import).
import type { Segment, Variant } from '../_shared/band'
import { fmtAgo, fmtWhen } from '../_shared/fmt'
import { GLYPH, termMeterRatio } from '../_shared/glyphs'
import { bites, paceSentence, paceWord, thinSamples, windowWord } from '../_shared/pace'
import type { PaceState, WindowPace } from '../_shared/pace'
import { chip, fit, mascotSvg, segMeter, text, textWidth } from '../_shared/svgkit'
import type { Signal } from '../_shared/tokens'
import { SIGNAL_FILL, V } from '../_shared/tokens'
import { calcContext, calcPace, cellWidth, paceView, pctText, usd2 } from '../core'
import type { Opts, PaceCalc } from '../core'
import type { PaceView, UsageCore, UsageSample, UsageWindow } from '../../types'

const KINDS = ['five_hour', 'seven_day', 'spend_limit'] as const
const px = (cells: number): number => Math.max(40, cells * 8 - 16)

export type RawLimit = { kind: string; percentUsed: number; resetsAt?: string }
export function parseLimits(rls: readonly RawLimit[]): UsageWindow[] {
  const next: UsageWindow[] = []
  for (const r of rls) {
    if (!(KINDS as readonly string[]).includes(r.kind) || !isFinite(r.percentUsed)) continue
    const t = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    next.push({ kind: r.kind as UsageWindow['kind'], percent: r.percentUsed, resetsAt: isFinite(t) ? t : undefined })
  }
  return next
}

/** Applies a reading to the core: samples, reset-jump learning, reading time. `added` says a sample was appended. */
export function applyReadingPure(c: UsageCore, prev: readonly UsageWindow[], next: readonly UsageWindow[], now: number, fromMeasure: boolean, changedRate: boolean, cost: number | undefined): { core: UsageCore; added: boolean } {
  const cur5 = next.find(l => l.kind === 'five_hour')
  const cur7 = next.find(l => l.kind === 'seven_day')
  const learning = { ...c.learning }
  let samples: UsageSample[] = c.samples.filter(s => s.t <= now)
  for (const kind of ['five_hour', 'seven_day'] as const) {
    const cur = kind === 'five_hour' ? cur5 : cur7
    const was = prev.find(l => l.kind === kind)
    if (cur && was && was.resetsAt === cur.resetsAt && was.percent - cur.percent > 20) {
      learning[kind] = cur.resetsAt ?? 0
      samples = samples
        .map(s => (kind === 'five_hour' ? { ...s, five: undefined, r5: undefined } : { ...s, seven: undefined, r7: undefined }))
        .filter(s => s.five != null || s.seven != null)
    } else if (learning[kind] != null && (!cur || learning[kind] !== (cur.resetsAt ?? 0))) {
      delete learning[kind]
    }
  }
  // A sample of an earlier window no longer informs the slope.
  samples = samples
    .map(s => ({ ...s, five: !cur5 || s.r5 === cur5.resetsAt ? s.five : undefined, seven: !cur7 || s.r7 === cur7.resetsAt ? s.seven : undefined }))
    .filter(s => s.five != null || s.seven != null)
  const fresh: UsageSample = { t: now, five: cur5?.percent, seven: cur7?.percent, r5: cur5?.resetsAt, r7: cur7?.resetsAt }
  const last = samples[samples.length - 1]
  const same = !!last && last.five === fresh.five && last.seven === fresh.seven && last.r5 === fresh.r5 && last.r7 === fresh.r7
  const added = !same && (cur5 != null || cur7 != null)
  if (added) samples = thinSamples([...samples, fresh], now, 200)
  const reading = added || !c.seenMeasure || changedRate
  return {
    added,
    core: {
      ...c,
      seenMeasure: c.seenMeasure || fromMeasure,
      hasRateLimits: next.length > 0 ? true : fromMeasure ? false : c.hasRateLimits,
      readingAt: next.length > 0 && reading ? now : c.readingAt,
      cost: cost ?? c.cost,
      learning,
      samples,
    },
  }
}

export function pacePublished(core: UsageCore, limits: readonly UsageWindow[], now: number, o: Opts): PaceView | null {
  const calc = calcPace(core, limits, now, o)
  return paceView(calc, calc.worst ? paceSentence(calc.worst, now) : '')
}

// --- text and svg ----------------------------------------------------------------------------
const STATE_EMOJI: Partial<Record<PaceState, string>> = { hot: GLYPH.hot, plenty: GLYPH.plenty, limit: GLYPH.denied }
const SIGNAL: Record<PaceState, Signal> = { limit: 'danger', hot: 'warn', onpace: 'ok', plenty: 'info', learning: 'neutral' }

type Win = { label: string; p: number }
type Data = { wins: Win[]; spend?: Win; nBites: number; state: PaceState; sentence: string; stale?: number; mascot: 'auto' | 'on' | 'off'; worstP: number }

function drawBurn(kind: 'full' | 'nf' | 'mo' | 'co', d: Data, W: number): string {
  const full = kind === 'full' || kind === 'nf'
  const cw = full ? 6 : 4
  const mw = 12 * cw + 11
  let s = mascotSvg('carrot', 0, -1, 32, { mode: d.mascot })
  for (let i = 0; i < d.nBites; i++) s += `<rect x="29" y="${4 + i * 6}" width="3" height="3" fill="${V.panel}"/>`
  let x = 40
  const tail = textWidth('100%', 10)
  if (kind === 'co') {
    s += text(x, 19, pctText(d.worstP), { size: 10 })
    x += tail + 3
    s += `<rect x="${x}" y="11" width="8" height="8" fill="${SIGNAL_FILL[SIGNAL[d.state]]}"/>`
  } else {
    for (const w of [...d.wins, ...(full && d.spend && x + 2 * (mw + 60) + 160 < W ? [d.spend] : [])]) {
      s += text(x, 19, w.label, { size: 10 })
      x += textWidth(w.label, 10) + 4
      s += segMeter(x, 10, { cells: 12, cellW: cw, gap: 1, cellH: 10, ratio: Math.min(1, w.p / 100), warnAt: 0.8, dangerAt: 0.95 })
      x += mw + 4
      s += text(x, 19, pctText(w.p), { size: 10 })
      x += textWidth(pctText(w.p), 10) + 10
    }
    const word = paceWord(d.state, false)
    if (full) {
      const c = chip(x, 4, word, { signal: SIGNAL[d.state], size: 10, h: 22 })
      s += c.svg
      x += c.w + 8
      if (kind === 'full') {
        const sentence = d.sentence + (d.stale != null ? ` · ${d.stale} min old` : '')
        s += text(x, 19, fit(sentence, W - x - 4, 10, 'mono'), { size: 10, face: 'mono', fill: V.text2 })
      }
    } else {
      s += `<rect x="${x}" y="11" width="8" height="8" fill="${SIGNAL_FILL[SIGNAL[d.state]]}"/>`
    }
  }
  return d.stale != null ? `<g opacity="0.55">${s}</g>` : s
}

function variants(d: Data, termText: Record<'full' | 'nf' | 'mo' | 'co', string>, minCells: Record<'full' | 'nf' | 'mo' | 'co', number>): Variant[] {
  const out: Variant[] = []
  for (const k of ['full', 'nf', 'mo', 'co'] as const) {
    const t = termText[k]
    const cells = Math.max(minCells[k], cellWidth(t))
    const w = px(cells)
    out.push({ px: w, cells, svg: drawBurn(k, d, w), text: t, alt: t, dim: d.stale != null })
  }
  return out
}

export function burnSegmentFrom(core: UsageCore, limits: readonly UsageWindow[], now: number, o: Opts): Segment | null {
  if (!core.seenMeasure && limits.length === 0) return null
  if (limits.length === 0) {
    const t = `${GLYPH.carrot} No plan limits reported${core.cost != null ? ` · cost ${usd2(core.cost)}` : ''}`
    const short = `${GLYPH.carrot} no limits`
    const mk = (txt: string, cells: number): Variant => {
      const w = px(Math.max(cells, cellWidth(txt)))
      return { px: w, cells: Math.max(cells, cellWidth(txt)), svg: mascotSvg('carrot', 0, -1, 32, { mode: o.mascots }) + text(40, 19, fit(txt.replace(GLYPH.carrot + ' ', ''), w - 44, 10, 'mono'), { size: 10, face: 'mono', fill: V.text2 }), text: txt, alt: txt }
    }
    return { id: 'burn', order: 1, priority: 1, variants: [mk(t, 20), mk(short, 12)] }
  }
  const calc: PaceCalc = calcPace(core, limits, now, o)
  const wins: Win[] = []
  if (calc.five) wins.push({ label: '5H', p: calc.five.percent })
  if (calc.seven) wins.push({ label: '7D', p: calc.seven.percent })
  const spend = calc.spend && o.burn.showSpend ? { label: '$', p: calc.spend.percent } : undefined
  const worst: WindowPace | undefined = calc.worst
  const state: PaceState = worst?.state ?? 'learning'
  const sentence = worst ? paceSentence(worst, now) : ''
  const seven = calc.seven?.percent ?? 0
  const d: Data = {
    wins,
    spend,
    nBites: o.burn.bites ? bites(seven) : 0,
    state,
    sentence,
    stale: calc.stale,
    mascot: o.mascots,
    worstP: worst?.percent ?? wins[0]?.p ?? spend?.p ?? 0,
  }
  const stale = calc.stale != null ? ` · ${calc.stale} min old` : ''
  const winTxt = (w: Win): string => `${w.label} ${termMeterRatio(Math.min(100, w.p) / 100)} ${pctText(w.p)}`
  const groups = [...wins, ...(spend ? [spend] : [])].map(winTxt).join('  ')
  const chipWord = paceWord(state, true)
  const emoji = STATE_EMOJI[state]
  const short = wins.map(w => `${w.label} ${pctText(w.p)}`).join(' ')
  const t = {
    full: `${GLYPH.carrot} ${groups}  ${chipWord}${sentence ? ` · ${sentence}` : ''}${stale}`,
    nf: `${GLYPH.carrot} ${groups}  ${chipWord}${stale}`,
    mo: `${GLYPH.carrot} ${short || (spend ? `$ ${pctText(spend.p)}` : '')}${emoji ? ` ${emoji}` : ''}${stale}`,
    co: `${GLYPH.carrot} ${pctText(d.worstP)}${emoji ? ` ${emoji}` : ''}${stale}`,
  }
  const minCells = { full: 110, nf: 62, mo: 40, co: 12 }
  return { id: 'burn', order: 1, priority: 1, variants: variants(d, t, minCells) }
}


export function burnStatusFrom(core: UsageCore, limits: readonly UsageWindow[], now: number, o: Opts): string | undefined {
  const calc = calcPace(core, limits, now, o)
  if (!calc.worst) return undefined
  const word = calc.worst.state === 'hot' ? 'HOT' : paceWord(calc.worst.state, false)
  return [calc.five ? `5H ${pctText(calc.five.percent)}` : '', calc.seven ? `7D ${pctText(calc.seven.percent)}` : '', word].filter(Boolean).join(' ')
}

/** The /burn text card. */
export function burnCardFrom(core: UsageCore, limits: readonly UsageWindow[], now: number, o: Opts): string {
  const calc = calcPace(core, limits, now, o)
  const lines: string[] = ['BURN · plan limits']
  if (limits.length === 0) lines.push('No plan limits reported')
  for (const w of [calc.five, calc.seven]) {
    if (!w) continue
    const proj = w.projected != null ? ` · projected ~${Math.min(999, Math.round(w.projected))}% at reset` : ''
    lines.push(`${w.kind === 'five_hour' ? '5H' : '7D'}  ${pctText(w.percent)}  ${windowWord(w.kind)}  resets ${w.resetsAt != null ? fmtWhen(w.resetsAt, now) : 'unknown'}  pace ${paceWord(w.state, true)}${proj}`)
  }
  if (calc.spend) lines.push(`$   ${pctText(calc.spend.percent)}  spend limit${calc.spend.resetsAt != null ? `  resets ${fmtWhen(calc.spend.resetsAt, now)}` : ''}`)
  const age = core.readingAt != null ? `last reading ${fmtAgo(now - core.readingAt)} ago` : 'no reading yet'
  lines.push(`${core.cost != null ? `cost ${usd2(core.cost)} · ` : ''}${core.samples.length} samples · ${age}`)
  const cc = calcContext(core, now, o)
  if (cc.percent != null) lines.push(`context ${cc.percent}%${cc.toCompact != null ? ` · ${Math.round(cc.toCompact)}% to compact` : cc.autoCompact ? '' : ' · auto-compact off'}`)
  return lines.join('\n')
}

