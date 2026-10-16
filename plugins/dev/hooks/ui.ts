import { BAND_H, MIN_FONT_PX } from './_shared/tokens'
import type { Signal } from './_shared/tokens'
import { chip } from './_shared/svgkit'
import type { Segment, Variant } from './_shared/band'

const EMOJI_RE = /[\u{1F000}-\u{1FFFF}☀-➿⏳⭐]️?\s*/gu
/** Terminal cell width: emoji and a few wide symbols count 2. */
export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    n += cp >= 0x1f000 || cp === 0x26a0 || cp === 0x26d4 || cp === 0x2705 || cp === 0x23f3 ? 2 : 1
  }
  return n
}
/** SVG label: the terminal text without emoji (the desktop never draws them). */
export const svgLabel = (s: string): string => s.replace(EMOJI_RE, '').trim()

export type ChipSpec = { text: string; signal?: Signal; dim?: boolean }

/** Segment from width variants (widest first). `alt` equals the terminal text. */
export function chipSegment(id: string, order: number, priority: number, specs: ChipSpec[]): Segment | null {
  const seen = new Set<string>()
  const variants: Variant[] = []
  for (const sp of specs) {
    if (!sp.text || seen.has(sp.text)) continue
    seen.add(sp.text)
    const c = chip(0, Math.round((BAND_H - 22) / 2) - 1, svgLabel(sp.text), { signal: sp.signal, face: 'mono', size: Math.max(MIN_FONT_PX, 11), dim: sp.dim })
    variants.push({ px: c.w + 2, cells: cellWidth(sp.text), svg: c.svg, text: sp.text, alt: sp.text, dim: sp.dim })
  }
  return variants.length ? { id, order, priority, variants } : null
}

export const SIGNAL_LABEL: Record<string, string> = {}

/** `+3 ~5` style join of non-zero parts. */
export const parts = (xs: (string | false | undefined | null)[]): string => xs.filter(Boolean).join(' ')

export function fmtDuration(ms: number | undefined): string | undefined {
  if (ms == null) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`
