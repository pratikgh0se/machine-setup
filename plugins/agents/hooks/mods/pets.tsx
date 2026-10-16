// Pets in Still Room (pure view): the pets pane tree, the pets button and the optional checklist segment.
import type { Segment } from '../_shared/band'
import { countDone, isAllDone, nowOf } from '../_shared/checklist'
import { termMeter } from '../_shared/glyphs'
import { chipSegment, petLine, petRowSvg, ROW_H } from '../art'
import { isFinished, miniSpend, queueOf } from '../model'
import type { Snap } from '../snap'
import { reviewSection } from './review'

export const PETS_PANE = 'pets'
export const PETS_TITLE = 'Agent pets'

export function paneWidth(e: { props: { bodyColumns?: number } }): number {
  return Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
}

/** The pets button label of the band row; undefined while no pet runs. */
export function petsButtonLabel(surface: string, s: Snap): string | undefined {
  const working = s.runs.filter(r => r.status === 'running').length
  if (working === 0) return undefined
  return surface === 'terminal' ? `🐾 ${working} working` : `${working} working`
}

/** Checklist segment (showChecklist only; awareness Now Doing owns the checklist by default). */
export function checklistSegment(s: Snap): Segment | null {
  if (!s.opts.showChecklist) return null
  const items = s.checklist.items
  if (items.length === 0) return null
  const total = items.length
  const done = countDone(items)
  const complete = isAllDone(items)
  const now = nowOf(items)
  const pct = Math.round((100 * done) / total)
  const bar = termMeter(Math.round((8 * done) / total), 8)
  const full = complete ? `[${bar}] ✓ all ${total} done` : `[${bar}] ${done}/${total} ${pct}%${now ? ` · now: ${now}` : ''}`
  const short = complete ? `all ${total} done` : `${done}/${total} ${pct}%`
  const dFull = complete ? `ALL ${total} DONE` : `${done}/${total} ${pct}%${now ? ` · NOW: ${now}` : ''}`
  return chipSegment('checklist', 4, 5, [[dFull.slice(0, 80), full], [short.toUpperCase(), short]], complete ? 'ok' : undefined)
}

export type PetsPaneCb = { onReviewed: (id: string) => void }

/** The pets pane tree (`t` is the resolved element table of the surface). */
export function petsPane(t: any, e: any, s: Snap, cb: PetsPaneCb): unknown {
  const { Box, Text } = t
  const opts = s.opts
  const working = s.runs.filter(r => r.status === 'running').reverse()
  const finished = s.runs.filter(isFinished).reverse()
  const shown = finished.slice(0, opts.maxDone)
  const hidden = finished.length - shown.length
  const header = `${working.length} working · ${finished.length} done`
  const desktop = e.surface !== 'terminal' && 'Svg' in t
  const W = paneWidth(e)
  const row = (r: (typeof s.runs)[number]) => {
    const alt = petLine(r, s.at)
    if (desktop) {
      const { Svg } = t
      return <Svg key={r.id} source={petRowSvg(W, r, s.at, opts.mascots)} alt={alt} width={W} height={ROW_H} />
    }
    const color = r.status === 'failed' ? 'red' : r.status === 'done' ? 'green' : undefined
    return (
      <Text key={r.id} wrap="truncate-end" color={color}>
        {alt}
      </Text>
    )
  }
  const queue = opts.reviewOn ? queueOf(s.runs, opts.includeBackfilled) : []
  return (
    <Box flexDirection="column">
      <Text bold>{header}</Text>
      {s.runs.length === 0 && <Text dimColor>No agents yet. Pets appear when a subagent starts.</Text>}
      {working.length > 0 && <Text dimColor>Working</Text>}
      {working.map(row)}
      {queue.length > 0 && reviewSection(e, t, s, queue, cb.onReviewed)}
      {finished.length > 0 && <Text dimColor>Done</Text>}
      {shown.map(row)}
      {hidden > 0 && <Text dimColor>+{hidden} older</Text>}
      {s.spend.steps > 0 && <Text dimColor>{miniSpend(s.spend)}</Text>}
    </Box>
  )
}
