// Compact Coach: the band chip, the moment score, the toast and /coach. Spec s1, s5.
import { termMeter } from '../_shared/glyphs'
import { fmtTokens } from '../_shared/fmt'
import { priceLabel, PRICES_SOURCE } from '../_shared/prices'
import { chip, mascotSvg, meterWidth, segMeter, text, textWidth } from '../_shared/svgkit'
import type { Segment, Variant } from '../_shared/band'
import { V } from '../_shared/tokens'
import type { Signal } from '../_shared/tokens'
import { cellWidth, effState, usd2 } from '../core'
import type { Calc, Ctx } from '../core'

const MOMENT_WORD = { good: 'GOOD MOMENT', ok: 'OK', notnow: 'NOT NOW' } as const
const SHORT_WORD = { good: 'GOOD', ok: 'OK', notnow: 'NOT NOW' } as const
const SIGNAL: Record<'good' | 'ok' | 'notnow', Signal> = { good: 'ok', ok: 'warn', notnow: 'neutral' }

const why = (c: Calc): string => c.gate ?? (c.agentsRunning > 0 ? 'agents running' : 'task in progress')

/** Verdict as the long label: `✅ GOOD MOMENT`, `▪ OK`, `⚠ NOT NOW · task in progress`. */
function verdictLong(c: Calc): string {
  if (c.verdict === 'good') return `✅ ${MOMENT_WORD.good}`
  if (c.verdict === 'ok') return `▪ ${MOMENT_WORD.ok}`
  return c.gate ? `⚠ ${MOMENT_WORD.notnow} · ${c.gate}` : `⚠ ${MOMENT_WORD.notnow}`
}
const verdictMid = (c: Calc): string => (c.verdict === 'good' ? `✅ ${MOMENT_WORD.good}` : c.verdict === 'ok' ? `▪ OK` : c.gate ? `⚠ NOT NOW · ${c.gate}` : `⚠ NOT NOW`)
const verdictIcon = (c: Calc): string => (c.verdict === 'good' ? '✅' : c.verdict === 'ok' ? '▪' : '⚠')

const k = (n: number | undefined): string => (n == null ? '?' : fmtTokens(n))

function paybackText(c: Calc): string {
  if (!c.cost) return ''
  if (c.payback == null) return 'no payback'
  if (c.cold && c.payback === 1) return 'at once'
  return `~${c.payback} turns`
}

/** Payback line of the spec (s1): warm and cold forms. */
export function paybackLine(c: Calc): string {
  if (!c.cost || c.passUsd == null) return ''
  if (c.cold) {
    return c.payback === 1
      ? `cold now: pass ~${usd2(c.passUsd)} < next turn ~${usd2(c.cost.Tc)} · pays back at once`
      : `cold now: pass ~${usd2(c.passUsd)} · pays back in ~${c.payback ?? '?'} turns`
  }
  return `compaction pass ~${usd2(c.passUsd)} · pays back in ~${c.payback ?? '?'} warm turns`
}

function stateText(rt: Ctx['rt'], c: Calc, s: ReturnType<typeof effState>): string | undefined {
  const h = rt.handoff
  const rel = h.rel ?? h.path ?? ''
  switch (s) {
    case 'writing':
      return `📋 HANDOFF writing → ${rel}`
    case 'ready':
      return `📋 HANDOFF ready · compaction is irreversible · /handoff go${c.passHandoffUsd != null && c.cost ? ` (~${usd2(c.cost.passWarm)})` : ''} or /handoff cancel${h.note ? ` · ${h.note}` : ''}`
    case 'saved':
      return '📋 HANDOFF saved (no compact)'
    case 'compacting':
      return '📋 HANDOFF compacting…'
    case 'done':
      return `COMPACTED ${k(h.before)} → ${k(h.after)}`
    case 'failed':
      return h.missing && h.missing.length > 0 ? `⚠ HANDOFF incomplete: missing ${h.missing.join(', ')}` : `⚠ HANDOFF failed: ${h.reason ?? 'unknown'} · /handoff retry`
    default:
      return undefined
  }
}

type Parts = { label?: string; mono?: string; chip?: { t: string; sig: Signal; dim?: boolean }; meter?: { filled: number; sig: Signal }; tail?: string; plain?: string }

function frag(p: Parts): string {
  let x = 0
  let out = mascotSvg('carrot', 0, 0, 30)
  x = 34
  if (p.label) {
    out += text(x, 19, p.label, { size: 10 })
    x += textWidth(p.label, 10) + 8
  }
  if (p.mono) {
    out += text(x, 19, p.mono, { size: 10, face: 'mono' })
    x += textWidth(p.mono, 10, 'mono') + 10
  }
  if (p.chip) {
    const c = chip(x, 4, p.chip.t, { signal: p.chip.sig, size: 10, dim: p.chip.dim })
    out += c.svg
    x += c.w + 8
  }
  if (p.meter) {
    const fill = p.meter.sig === 'ok' ? V.ok : p.meter.sig === 'warn' ? V.warn : V.muted
    out += segMeter(x, 10, { filled: p.meter.filled, color: fill })
    x += meterWidth() + 8
  }
  if (p.tail) out += text(x, 19, p.tail, { size: 10, face: 'mono' })
  if (p.plain) out += text(x, 19, p.plain, { size: 10, face: 'mono' })
  return out
}

function variant(textStr: string, parts: Parts, color?: string, dim?: boolean): Variant {
  const cells = cellWidth(textStr)
  // px mirrors cells so the desktop and terminal fits pick the same variant (statement 24).
  return { px: cells * 8 - 16, cells, svg: frag(parts), text: textStr, alt: textStr, color, dim }
}

export function coachSegment(c: Calc, ctx: Ctx, now: number): Segment | null {
  const { rt, opts } = ctx
  const s = effState(rt, opts, now)
  const st = stateText(rt, c, s)
  const ctxTok = k(c.ctx)
  if (st) {
    const sig: Signal = s === 'failed' ? 'warn' : s === 'done' ? 'ok' : 'accent'
    const vs: Variant[] = []
    if (c.hasCtx && c.cost) {
      const x = c.cost
      const lead = `🥕 CTX ${ctxTok} · now ${usd2(x.Tw)}/turn (cold ${usd2(x.Tc)}) · →${k(c.target)} ${usd2(x.Twp)} · save ${usd2(x.save)} · ${st}`
      vs.push(variant(lead, { label: `CTX ${ctxTok.toUpperCase()}`, mono: `${usd2(x.Tw)} → ${usd2(x.Twp)} /turn · save ${usd2(x.save)}`, chip: { t: shortCap(st), sig }, plain: tailOf(st) }))
    }
    if (c.hasCtx) vs.push(variant(`🥕 CTX ${ctxTok} · ${st}`, { label: `CTX ${ctxTok.toUpperCase()}`, chip: { t: shortCap(st), sig }, plain: tailOf(st) }))
    vs.push(variant(st, { chip: { t: shortCap(st), sig } }))
    if (s === 'ready') vs.push(variant('📋 HANDOFF ready · /handoff go', { chip: { t: 'HANDOFF READY', sig: 'accent' } }))
    return { id: 'coach', order: 1, priority: 1, pinned: true, variants: vs }
  }
  if (!c.hasCtx || !c.cost || (c.ctx as number) < opts.showFrom) return null
  const cost = c.cost
  const meter = Math.round((c.score / 8) * 12)
  const sig = SIGNAL[c.verdict]
  const cacheShort = c.reasonText
  const full = `🥕 CTX ${ctxTok} · now ${usd2(cost.Tw)}/turn (cold ${usd2(cost.Tc)}) · →${k(c.target)} ${usd2(cost.Twp)} · save ${usd2(cost.save)} · pays back ${paybackText(c)} · ${verdictLong(c)} ${termMeter(meter)} ${cacheShort}`
  const mid = `🥕 CTX ${ctxTok} · now ${usd2(cost.Tw)} (cold ${usd2(cost.Tc)}) · →${k(c.target)} ${usd2(cost.Twp)} · save ${usd2(cost.save)} · ${paybackText(c)} · ${verdictMid(c)}${c.verdict === 'notnow' ? '' : ' · /handoff'}`
  const small = `🥕 ${ctxTok} · save ${usd2(cost.save)}/turn · ${verdictIcon(c)} ${SHORT_WORD[c.verdict]}`
  const tiny = `🥕 ${ctxTok} ${verdictIcon(c)}`
  const dim = c.verdict === 'notnow'
  const chipLabel = c.verdict === 'notnow' ? `${MOMENT_WORD.notnow} · ${why(c).toUpperCase()}` : MOMENT_WORD[c.verdict]
  const vs: Variant[] = [
    variant(full, { label: `CTX ${ctxTok.toUpperCase()}`, mono: `${usd2(cost.Tw)} → ${usd2(cost.Twp)} /turn · save ${usd2(cost.save)}`, chip: { t: chipLabel, sig, dim }, meter: { filled: meter, sig }, tail: stripEmoji(cacheShort) }, undefined, dim),
    variant(mid, { label: `CTX ${ctxTok.toUpperCase()}`, mono: `${usd2(cost.Tw)} → ${usd2(cost.Twp)} /turn · save ${usd2(cost.save)}`, chip: { t: MOMENT_WORD[c.verdict], sig, dim } }, undefined, dim),
    variant(small, { label: `${ctxTok.toUpperCase()}`, mono: `save ${usd2(cost.save)}/turn`, chip: { t: SHORT_WORD[c.verdict], sig, dim } }, undefined, dim),
    variant(tiny, { label: `${ctxTok.toUpperCase()}`, chip: { t: verdictIcon(c) === '✅' ? 'OK' : SHORT_WORD[c.verdict], sig, dim } }, undefined, dim),
  ]
  return { id: 'coach', order: 1, priority: 1, variants: vs }
}

const stripEmoji = (s: string): string => s.replace(/[\u{1F000}-\u{1FFFF}]/gu, '').replace(/\s+/g, ' ').trim()
const shortCap = (s: string): string => stripEmoji(s).replace(/^[^A-Za-z]+/, '').slice(0, 28).toUpperCase()
const tailOf = (s: string): string => stripEmoji(s).slice(0, 80)

/** `$.ui.status` fallback (no band): `CTX 350k · save $0.06/turn · GOOD`. */
export function statusText(c: Calc, rt: Ctx['rt'], opts: Ctx['opts'], now: number): string | undefined {
  const s = effState(rt, opts, now)
  const st = stateText(rt, c, s)
  if (st) return st
  if (!c.cost || (c.ctx as number) < opts.showFrom) return undefined
  return `CTX ${k(c.ctx)} · save ${usd2(c.cost.save)}/turn · ${SHORT_WORD[c.verdict]}`
}

/** Full card printed by /coach. */
export function cardText(c: Calc, ctx: Ctx): string {
  const { rt, opts } = ctx
  const label = priceLabel(rt.overrides, !!rt.overrides && Object.keys(rt.overrides.byFamily).length > 0)
  const L: string[] = [`COMPACT COACH · ${label}`]
  if (rt.pricesBad) L.push('pricesJson is not valid JSON: using the built-in prices.')
  if (!c.cost || c.ctx == null) {
    L.push('No context reading yet. The Coach needs one response first.')
    L.push(`prices: ${PRICES_SOURCE}`)
    return L.join('\n')
  }
  const x = c.cost
  L.push(`context: ${k(c.ctx)} tokens · model ${c.model ?? 'unknown'}${x.isDefault ? ' (default price)' : ''}`)
  L.push(
    `target: ${k(c.target)}${c.floorWon ? ` (floor wins: ${k(c.floor)} = ${k(rt.overhead)} overhead + ${k(opts.summaryOut)} summary; setting ${k(opts.target)})` : ` (setting ${k(opts.target)}${c.floor != null ? `, floor ${k(c.floor)}` : ''})`}`,
  )
  L.push(`prices per MTok: cache read $${x.row.cacheRead} · 1h write $${x.row.write1h} · 5m write $${x.row.write5m} · output $${x.row.output}`)
  L.push(`now: ${usd2(x.Tw)}/turn warm = ${k(c.ctx)} x read · ${usd2(x.Tc)} cold = ${k(c.ctx)} x 1h write`)
  L.push(`at ${k(c.target)}: ${usd2(x.Twp)} warm · ${usd2(x.Tcp)} cold · saving ${usd2(x.save)} per warm turn (${usd2(x.saveCold)} per cold turn)`)
  L.push(
    `pass = ${opts.passHit ? 'read(ctx)' : 'write5m(ctx)'} + summary ${k(opts.summaryOut)} x output + write1h(target): warm ${usd2(x.passWarm)} · cold ${usd2(x.passCold)}${opts.passHit ? '' : ' (passAssumesCacheHit off)'}`,
  )
  L.push(paybackLine(c))
  L.push(`/handoff + compact: ${c.passHandoffUsd != null ? usd2(c.passHandoffUsd) : '?'} (handoff turn ${usd2(c.cold ? x.handoffCold : x.handoffWarm)} + pass ${usd2(x.passWarm)}) · pays back in ${c.paybackHandoff != null ? `~${c.paybackHandoff} turns` : 'never'}`)
  const pts = c.points.map(p => `${p.label}${p.pts > 0 ? ` +${p.pts}` : ''}`).join(' · ')
  L.push(`moment: ${MOMENT_WORD[c.verdict]}${c.gate ? ` · ${c.gate}` : ''} · score ${c.score}/8 · ${pts} · cache ${c.cacheState === 'unknown' ? '?' : c.cacheState}`)
  L.push(`${label}. Dollars are a yardstick: subscription quota weights are unpublished. Source: ${PRICES_SOURCE}.`)
  return L.filter(Boolean).join('\n')
}
