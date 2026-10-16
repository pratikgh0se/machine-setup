// Compaction Alert (usage.md s3): how close the context is to auto-compact, and what a compaction did.
// PURE: every `$` call lives in register.tsx.
import type { Segment, Variant } from '../_shared/band'
import { GLYPH, termMeterRatio } from '../_shared/glyphs'
import { bevel, fit, segMeter, text, textWidth } from '../_shared/svgkit'
import type { Signal } from '../_shared/tokens'
import { SIGNAL_FILL, V } from '../_shared/tokens'
import { cellWidth } from '../core'
import type { CtxCalc, Opts } from '../core'
import type { UsageCore } from '../../types'

const px = (cells: number): number => Math.max(40, cells * 8 - 16)
const LEVEL_SIGNAL: Record<'info' | 'warn' | 'danger', Signal> = { info: 'neutral', warn: 'warn', danger: 'danger' }

function drawCtx(d: { text: string; bar?: number; pct?: string; detail?: string; signal: Signal; title?: string }, W: number): string {
  let s = bevel(0, 2, W - 2, 24, { tone: 'tile', edge: SIGNAL_FILL[d.signal] })
  let x = 10
  const label = d.title ?? 'CTX'
  s += text(x, 19, label, { size: 10 })
  x += textWidth(label, 10) + 6
  if (d.bar != null) {
    s += segMeter(x, 10, { cells: 12, cellW: 6, gap: 1, cellH: 10, ratio: d.bar, warnAt: 0.8, dangerAt: 0.95 })
    x += 83 + 6
  }
  if (d.pct) {
    s += text(x, 19, d.pct, { size: 10 })
    x += textWidth(d.pct, 10) + 8
  }
  if (d.detail) s += text(x, 19, fit(d.detail, W - x - 8, 10, 'mono'), { size: 10, face: 'mono', fill: V.text2 })
  return s
}

const mk = (t: string, minCells: number, d: Parameters<typeof drawCtx>[0]): Variant => {
  const cells = Math.max(minCells, cellWidth(t))
  const w = px(cells)
  return { px: w, cells, svg: drawCtx(d, w), text: t, alt: t }
}

export function ctxSegment(c: CtxCalc, o: Opts): Segment | null {
  if (c.compacted) {
    const b = c.compacted.before != null ? `${c.compacted.before}%` : '?'
    const a = c.compacted.after != null ? `${c.compacted.after}%` : '…'
    // F32: every tier is sized from its drawn text (label + pct), so it never exceeds its slot.
    const mkC = (title: string, pct: string | undefined, t: string): Variant => {
      const need = 10 + textWidth(title, 10) + (pct ? 6 + textWidth(pct, 10) : 0) + 10
      const cells = Math.max(4, Math.ceil((need + 16) / 8))
      const w = px(cells)
      return { px: w, cells, svg: drawCtx({ text: t, title, pct, signal: 'ok' }, w), text: t, alt: t }
    }
    return {
      id: 'compaction',
      order: 2,
      priority: 2,
      variants: [
        mkC('COMPACTED', `${b} → ${a}`, `COMPACTED ${b} → ${a}`),
        mkC('CMPCT', `${b}→${a}`, `CMPCT ${b}→${a}`),
        mkC('→', a, `→${a}`),
        mkC('↯', undefined, '↯'),
      ],
    }
  }
  if (!c.visible || c.percent == null) return null
  const p = c.percent
  const pre = c.level === 'danger' ? `${GLYPH.denied} ` : c.level === 'warn' ? `${GLYPH.warn} ` : ''
  const count = o.compaction.showCount && c.count > 0 ? ` ×${c.count}` : ''
  const toC = c.toCompact != null ? `${Math.round(c.toCompact)}% to compact` : undefined
  let body: string
  let detail: string | undefined
  let bar: number | undefined
  if (!c.autoCompact) {
    body = `CTX ${p}% · auto-compact off`
    detail = 'auto-compact off'
  } else {
    body = `CTX ${termMeterRatio(p / 100)} ${p}%${toC ? ` · ${toC}` : ''}`
    detail = toC
    bar = p / 100
  }
  const t = `${pre}${body}${count}`
  const short = `CTX ${p}%`
  return {
    id: 'compaction',
    order: 2,
    priority: 2,
    variants: [mk(t, 40, { text: t, bar, pct: `${p}%`, detail: (detail ?? '') + count, signal: LEVEL_SIGNAL[c.level] }), mk(short, 8, { text: short, pct: `${p}%`, signal: LEVEL_SIGNAL[c.level] })],
  }
}

/** Core after a main compaction: count, before/after percents (tokens, else the context readings around it). */
export function compactedCore(c: UsageCore, pre: UsageCore | undefined, r: { tokensBefore?: number; tokensAfter?: number }, now: number): UsageCore {
  const p0 = pre?.ctx.percent
  let window = pre?.ctx.window ?? c.ctx.window
  if (!window && r.tokensBefore && p0) window = (r.tokensBefore * 100) / p0
  const before = r.tokensBefore != null && window ? Math.round((r.tokensBefore / window) * 100) : p0
  let after: number | undefined
  if (r.tokensAfter != null && window) after = Math.round((r.tokensAfter / window) * 100)
  else if (c.ctx.percent != null && c.ctx.percent !== p0) after = c.ctx.percent
  return {
    ...c,
    compactions: c.compactions + 1,
    lastCompact: { before, after, at: now },
    compactPending: after == null,
    ctx: after != null ? { ...c.ctx, percent: after, tokens: r.tokensAfter ?? c.ctx.tokens } : c.ctx,
  }
}

/** Core after a context reading: finishes a pending compaction's `after`. */
export function measuredCore(c: UsageCore, ctx: { percent?: number; tokens?: number; window: number }): UsageCore {
  let lastCompact = c.lastCompact
  let pending = c.compactPending
  if (pending && ctx.percent != null) {
    lastCompact = lastCompact ? { ...lastCompact, after: Math.round(ctx.percent) } : lastCompact
    pending = false
  }
  return { ...c, lastCompact, compactPending: pending, ctx: { ...c.ctx, percent: ctx.percent, tokens: ctx.tokens, window: ctx.window } }
}
