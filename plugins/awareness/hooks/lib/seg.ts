// Tiny horizontal layout for band segments (desktop SVG fragment, 30 px high).
import { chip, mascotSvg, segMeter, text, textWidth } from '../_shared/svgkit'
import type { Face, MascotMode } from '../_shared/svgkit'
import type { Signal } from '../_shared/tokens'
import { V } from '../_shared/tokens'

export type Piece =
  | { k: 'text'; s: string; face?: Face; size?: number; fill?: string; opacity?: number }
  | { k: 'meter'; ratio: number; color?: string; cellW?: number; gap?: number }
  | { k: 'mascot'; size: number; mode?: MascotMode }
  | { k: 'chip'; label: string; signal?: Signal; dim?: boolean; w?: number; textFill?: string }

const MW = (cellW: number, gap: number): number => 12 * cellW + 11 * gap

/** Lays the pieces out left to right with `gap` px between. Returns the fragment and its width. */
export function layout(pieces: readonly Piece[], gap = 8): { svg: string; px: number } {
  let x = 0
  let svg = ''
  pieces.forEach((p, i) => {
    if (i > 0) x += gap
    if (p.k === 'text') {
      const size = Math.max(9, p.size ?? 11)
      const face = p.face ?? 'mono'
      svg += text(x, 19, p.s, { size, face, fill: p.fill ?? V.text, opacity: p.opacity })
      x += textWidth(p.s, size, face)
    } else if (p.k === 'meter') {
      const cw = p.cellW ?? 6
      const g = p.gap ?? 2
      svg += segMeter(x, 10, { cells: 12, cellW: cw, cellH: 10, gap: g, ratio: p.ratio, color: p.color })
      x += MW(cw, g)
    } else if (p.k === 'mascot') {
      svg += mascotSvg('pom', x, Math.round((30 - p.size) / 2), p.size, { mode: p.mode })
      x += p.size
    } else {
      const c = chip(x, 4, p.label, { signal: p.signal, dim: p.dim, size: 9, h: 22, padX: 5, textFill: p.textFill })
      if (p.w && p.w > c.w) {
        // Fixed-width chip: redraw centred in the wider box.
        const c2 = chip(x, 4, p.label, { signal: p.signal, dim: p.dim, size: 9, h: 22, padX: Math.round((p.w - (c.w - 10)) / 2), textFill: p.textFill })
        svg += c2.svg
        x += c2.w
      } else {
        svg += c.svg
        x += c.w
      }
    }
  })
  return { svg, px: x }
}
