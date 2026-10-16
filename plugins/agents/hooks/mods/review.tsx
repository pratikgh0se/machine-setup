// Review Queue (pure view): the band segment, the REVIEW QUEUE section and the /review list text.
// Marking is MANUAL ONLY: the REVIEWED Button and `/review done` (handled in register.tsx) are the only ways out.
import type { PetRun } from '../../types'
import type { Segment } from '../_shared/band'
import { fmtAgo } from '../_shared/fmt'
import { chipSegment, headerSvg, reviewRowSvg } from '../art'
import { RLABEL, queueOf, reviewDetail, reviewLine, reviewState } from '../model'
import type { Snap } from '../snap'

/** Names the commands actually registered (`agents-` prefixed when the bare name was refused); set by register.tsx. */
export const cmdNames: { review: string; mission: string } = { review: 'review', mission: 'mission' }
export const REVIEW_DESC = 'Review queue: list finished agents; done <id|all>'

/** Band segment `REVIEW n` (terminal `📥 n to review`), warn edge and age after remindMin. */
export function reviewSegment(s: Snap): Segment | null {
  if (!s.opts.reviewOn) return null
  const q = queueOf(s.runs, s.opts.includeBackfilled)
  if (q.length === 0) return null
  const oldest = Math.min(...q.map(r => r.endedAt ?? s.at))
  const age = s.at - oldest
  const old = age >= s.opts.remindMin * 60_000
  const ago = fmtAgo(age)
  const term = `📥 ${q.length} to review`
  const termOld = `${term} · oldest ${ago}`
  return chipSegment(
    'review',
    1,
    1,
    old ? [[`REVIEW ${q.length} · OLDEST ${ago.toUpperCase()}`, termOld], [`REVIEW ${q.length}`, term], [`${q.length}`, `📥 ${q.length}`]] : [[`REVIEW ${q.length}`, term], [`${q.length}`, `📥 ${q.length}`]],
    old ? 'warn' : undefined,
  )
}

/** The REVIEW QUEUE section of the pets pane. */
export function reviewSection(e: any, t: any, s: Snap, queue: PetRun[], onReviewed: (id: string) => void): unknown {
  const { Box, Text, Button } = t
  const desktop = e.surface !== 'terminal' && 'Svg' in t
  const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
  const title = `REVIEW QUEUE (${queue.length})`
  const rows = queue.map((r, i) => {
    const line = reviewLine(i + 1, r, s.at)
    const press = () => onReviewed(r.id)
    if (desktop) {
      const { Svg } = t
      const st = reviewState(r)
      const BW = 110
      return (
        <Box key={r.id} flexDirection="row" alignItems="center" gap={1}>
          <Svg source={reviewRowSvg(W - BW, RLABEL[st], r, reviewDetail(r), st === 'failed' || st === 'tests-failed' ? 'danger' : st === 'untested' ? 'warn' : 'ok')} alt={line} width={W - BW} height={48} />
          <Button key={`reviewed:${r.id}`} label="REVIEWED" onPress={press} />
        </Box>
      )
    }
    return (
      <Box key={r.id} flexDirection="row" gap={1}>
        <Text wrap="truncate-end" color={reviewState(r) === 'failed' ? 'red' : undefined}>
          {line}
        </Text>
        <Button key={`reviewed:${r.id}`} label="reviewed" onPress={press} />
      </Box>
    )
  })
  let head: unknown
  if (desktop) {
    const { Svg } = t
    const hd = headerSvg(W, title, '', 'carrot', s.opts.mascots)
    head = <Svg source={hd.svg} alt={title} width={W} height={hd.h} />
  } else {
    head = <Text bold>{title}</Text>
  }
  return (
    <Box flexDirection="column">
      {head}
      {rows}
    </Box>
  )
}

/** `/review` list text. */
export function reviewListText(s: Snap): string {
  const queue = queueOf(s.runs, s.opts.includeBackfilled)
  if (queue.length === 0) return 'Review queue is empty.'
  return [`REVIEW QUEUE (${queue.length})`, ...queue.map((r, i) => reviewLine(i + 1, r, s.at))].join('\n')
}
