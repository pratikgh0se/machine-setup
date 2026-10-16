// Still Room SVG builders for the agents plugin. Pure string builders, no engine calls.
import type { PetRun } from '../types'
import type { Variant, Segment } from './_shared/band'
import { bevel, blockMark, chip, fit, mascotSvg, svgDoc, text, textWidth } from './_shared/svgkit'
import type { MascotMode } from './_shared/svgkit'
import { TIER_COLOR, V } from './_shared/tokens'
import type { Signal } from './_shared/tokens'
import { cellsOf, clip, COSTUME_TAG, elapsed, fmtClock, tierOf, TIER_LABEL } from './model'
import { petLine } from './model'

export const ROW_H = 56

/** Mascot still, or (mode off) the block mark. The fallback carries no data-mascot attribute. */
export function mascot(kind: 'pom' | 'carrot', x: number, y: number, size: number, mode: MascotMode, opacity?: number): string {
  if (mode === 'off') {
    const s = Math.round(size * 0.35)
    return blockMark(x + Math.round((size - s) / 2), y + Math.round((size - s) / 2), { size: s, rival: kind === 'carrot' })
  }
  return mascotSvg(kind, x, y, size, { mode: 'on', opacity })
}

/** Carrot with a clipboard drawn over it (rects in the 40x40 box). */
export function carrotClip(x: number, y: number, mode: MascotMode): string {
  const base = mascot('carrot', x, y, 40, mode)
  if (mode === 'off') return base
  const r = (rx: number, ry: number, w: number, h: number, fill: string): string => `<rect x="${x + rx}" y="${y + ry}" width="${w}" height="${h}" fill="${fill}"/>`
  return base + r(2, 22, 7, 10, '#1a1d2b') + r(3, 23, 5, 8, '#f4efe6') + r(4, 22, 3, 2, '#ffb545') + r(4, 26, 3, 1, '#1a1d2b') + r(4, 28, 3, 1, '#1a1d2b')
}

/** Header tile: mascot at left, caps title, small detail. */
export function headerSvg(W: number, title: string, detail: string, kind: 'pom' | 'carrot', mode: MascotMode): { svg: string; h: number } {
  const h = 52
  const art = kind === 'carrot' ? carrotClip(6, 6, mode) : mascot('pom', 6, 6, 40, mode)
  const body = art + text(58, 24, fit(title, W - 70, 12), { size: 12 }) + (detail ? text(58, 42, fit(detail, W - 70, 11, 'mono'), { size: 11, face: 'mono', fill: V.text2 }) : '')
  return { svg: svgDoc(W, h, body), h }
}

/** 56 px pet row. The caller passes alt = petLine(...) so the desktop and terminal texts agree. */
export function petRowSvg(W: number, r: PetRun, at: number, mode: MascotMode): string {
  const tier = tierOf(r.model)
  const done = r.status === 'done'
  const failed = r.status === 'failed'
  let body = bevel(0, 0, W - 4, ROW_H - 4, { tone: 'tile', edge: failed ? V.danger : V.edge })
  if (failed) body += blockMark(14, 12, { size: 28, signal: 'danger' })
  else body += mascot('pom', 6, 6, 40, mode, done ? 0.55 : undefined) + (done ? text(40, 16, 'Z z', { size: 9, fill: V.text2 }) : '')
  body += text(58, 22, fit(clip(r.description, 60), W - 58 - 96, 13, 'body'), { size: 13, face: 'body' })
  // tier chip with a 2 px edge in the tier colour
  const label = TIER_LABEL[tier]
  const cw = textWidth(label, 9) + 12
  body += bevel(58, 30, cw, 16, { tone: 'tile', edge: TIER_COLOR[tier], drop: 0 }) + text(58 + cw / 2, 42, label, { size: 9, anchor: 'middle' })
  let x = 58 + cw + 8
  const tag = COSTUME_TAG[r.costume]
  if (tag) {
    body += text(x, 42, tag, { size: 9, fill: V.text2 })
    x += textWidth(tag, 9) + 8
  }
  body += text(x, 42, fit(r.type, Math.max(30, W - x - 120), 10, 'mono'), { size: 10, face: 'mono', fill: V.text2 })
  const word = r.status === 'running' ? 'WORKING' : r.status === 'done' ? 'DONE' : 'FAILED'
  body += text(W - 14, 22, word, { size: 10, anchor: 'end', fill: failed ? V.lDanger : done ? V.lOk : V.lAccent })
  body += text(W - 14, 42, fmtClock(elapsed(r, at)), { size: 11, face: 'mono', anchor: 'end' })
  if (r.status === 'running' && r.runaway) {
    const c = chip(W - 14 - 62 - 76, 8, 'RUNAWAY', { size: 9, signal: 'warn', h: 18 })
    body += `<g data-runaway="1">${c.svg}</g>`
  }
  return svgDoc(W, ROW_H, body)
}

/** Queue row: description, state label, detail; the REVIEWED button sits beside it. */
export function reviewRowSvg(W: number, label: string, r: PetRun, detail: string, signal: Signal): string {
  const h = 48
  let body = bevel(0, 0, W - 4, h - 4, { tone: 'tile', edge: signal === 'danger' ? V.danger : signal === 'warn' ? V.warn : V.edge })
  body += text(12, 20, fit(clip(r.description, 60), W - 24, 13, 'body'), { size: 13, face: 'body' })
  body += text(12, 37, fit(`${label} · ${detail}`, W - 24, 10, 'mono'), { size: 10, face: 'mono', fill: V.text2 })
  return svgDoc(W, h, body)
}

/** A plain text row for panes (alt carries the same string). A multi-line `s` draws one text row per line. */
export const noteHeight = (s: string): number => (s.includes('\n') ? 44 : 30)
export function noteSvg(W: number, s: string, signal?: Signal, dim = false): string {
  const rows = s.split('\n')
  const h = noteHeight(s)
  const body =
    bevel(0, 0, W - 4, h - 4, { tone: 'tile', edge: signal === 'warn' ? V.warn : signal === 'danger' ? V.danger : V.edge }) +
    rows.map((row, i) => text(10, 17 + i * 14, fit(row, W - 24, 10, 'mono'), { size: 10, face: 'mono', fill: dim ? V.text2 : undefined })).join('')
  return svgDoc(W, h, body)
}

// ---------------------------------------------------------------------------
// Band segments

/** One band variant: bevelled chip with a caps label on desktop, `term` on the terminal; alt = term. */
export function chipVariant(label: string, term: string, signal?: Signal): Variant {
  const c = chip(0, 4, label, { signal, h: 22 })
  return { px: c.w + 2, cells: cellsOf(term), svg: c.svg, text: term, alt: term }
}

export function chipSegment(id: string, order: number, priority: number, variants: [string, string][], signal?: Signal, pinned = false): Segment {
  return { id, order, priority, pinned, variants: variants.map(([label, term]) => chipVariant(label, term, signal)) }
}

export { petLine }
