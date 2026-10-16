// Mission Board (pure view): band segment, auto-open test, pane tree. All `$` work lives in register.tsx.
import type { MissionState, MissionView, PetRun } from '../../types'
import type { Segment, Variant } from '../_shared/band'
import { clip } from '../_shared/fmt'
import { termMeter } from '../_shared/glyphs'
import { parseCheckboxes } from '../_shared/plan'
import { text as svgText, textWidth } from '../_shared/svgkit'
import { V } from '../_shared/tokens'
import { chipVariant, headerSvg, noteHeight, noteSvg } from '../art'
import { cellsOf, costumeEmoji, tierOf } from '../model'
import { MARK, acceptedLine, detailLines, meterCells, runLine, runningLine, stateGlyph, terminalPane, typicalFn } from '../mission-core'
import type { Snap } from '../snap'
import { paneWidth } from './pets'
import { cmdNames } from './review'

export const STEP_TOOL = 'mcp__agents__step'
export const MISSION_PANE = 'mission'
export const MISSION_TITLE = 'Mission Board'
export const MISSION_DESC = 'Mission Board: plan progress across all agents'
export const MISSION_HINT = '[n|list|plan <path>|link|unlink|status]'
export const STEP_DESC = 'Report your own progress to the mission board. Call with done/total after reading the brief, then after each step. Silent.'
export const LINE_TOOL = 'Progress (required): first ToolSearch "select:mcp__agents__step", then call it {done,total,note} now and after each step.'
export const LINE_BASH = "Progress: run Bash 'echo MISSION_STEP done/total note' after reading this and after each step."
export const SPEC_MAX = 262_144

const TILE_BG: Record<MissionState, string | undefined> = { done: '#3ddc84', running: '#3ab4ff', review: '#ffe05a', blocked: '#ff4d4d', queued: undefined }

/** Checkboxes of a spec or plan file text, labels clipped to 60 (state holds labels, never contents). */
export function boxesOf(text: string): { line: number; checked: boolean; text: string }[] {
  const t = text.length > SPEC_MAX ? text.slice(0, SPEC_MAX) : text
  return parseCheckboxes(t).map(b => ({ line: b.line, checked: b.checked, text: clip(b.text, 60) }))
}

export function missionSegment(s: Snap): Segment | null {
  if (!s.opts.missionOn) return null
  const v = s.mission.view
  if (v.total < 1) return null
  const c = v.counts
  const cells = meterCells(v.pct)
  const termFull =
    `📋 Plan ${c.done}/${v.total} done · ${c.running} running` +
    (c.review ? ` · ${c.review} review` : '') +
    (c.blocked ? ` · ${c.blocked} blocked` : '') +
    ` · ${c.queued} queued  ${termMeter(cells)} ${v.pct}%`
  const termMed = `📋 ${c.done}/${v.total} · ${c.running} run${c.review ? ` · ${c.review} rev` : ''}`
  const termMin = `📋 ${v.pct}%`
  const label = `PLAN ${c.done}/${v.total} DONE · ${c.running} RUNNING${c.review ? ` · ${c.review} REVIEW` : ''}${c.blocked ? ` · ${c.blocked} BLOCKED` : ''} · ${c.queued} QUEUED`
  const tw = textWidth(label, 10, 'mono')
  const BW = 120
  const done = Math.round((BW - 4) * Math.min(100, v.pct) / 100)
  const stripe = Math.min(BW - 4 - done, Math.round(((BW - 4) * v.stripePct) / 100))
  const bar =
    `<rect x="${tw + 10}" y="12" width="${BW}" height="8" fill="${V.well}" stroke="${V.edge}" stroke-width="2"/>` +
    (done > 0 ? `<rect x="${tw + 12}" y="14" width="${done}" height="4" fill="${V.ok}"/>` : '') +
    (stripe > 0 ? `<rect x="${tw + 12 + done}" y="14" width="${stripe}" height="4" fill="${V.rival}" opacity="0.5"/>` : '')
  const full: Variant = {
    px: tw + 14 + BW,
    cells: cellsOf(termFull),
    svg: svgText(0, 19, label, { size: 10, face: 'mono', fill: V.text }) + bar,
    text: termFull,
    alt: termFull,
  }
  const med = chipVariant(`${c.done}/${v.total} · ${c.running} RUN${c.review ? ` · ${c.review} REV` : ''}`, termMed)
  const min = chipVariant(`${v.pct}%`, termMin)
  return { id: 'mission', order: 0, priority: 1, variants: [full, { ...med, text: termMed, alt: termMed }, { ...min, text: termMin, alt: termMin }] }
}

/** Plan start: >= 5 items and >= 2 agents running, on a surface that docks panes (fullscreen). */
export function shouldAutoOpen(e: any, s: Snap): boolean {
  if (!s.opts.missionOn || e.viewport?.isFullscreen !== true) return false
  const running = s.runs.filter(r => r.status === 'running' && !r.isBackfilled).length
  return s.mission.view.total >= 5 && running >= 2
}

/** A running agent whose last step report is older than 120 s: its row text is dimmed (colour only). */
const staleNote = (r: PetRun | undefined, s: Snap): boolean => {
  const rep = r?.agentId ? s.mission.steps[r.agentId] : undefined
  return !!r && r.status === 'running' && !!rep && s.at - rep.at > 120_000
}

export type MissionPaneCb = {
  select: (id: string | undefined) => void
  setFilter: (f: MissionState | undefined) => void
  showList: () => void
  reviewed: (ids: string[]) => void
}

/** The pane tree. Terminal: text lines; desktop: Svg header and rows, chip and tile Buttons, detail card. */
export function missionPane(t: any, e: any, s: Snap, cb: MissionPaneCb): unknown {
  const { Box, Text, Button } = t
  const v: MissionView = s.mission.view
  const opts = s.opts
  const typical = typicalFn(s.runs, opts.typicalTurns)
  const lines = terminalPane(v, s.runs, s.mission.steps, typical, s.at, { maxTiles: opts.maxTiles, cmd: cmdNames.mission, cols: e.surface === 'terminal' ? e.props?.bodyColumns : undefined, clock: s.mission.clock })
  const desktop = e.surface !== 'terminal' && 'Svg' in t
  if (v.total === 0 && s.runs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>MISSION BOARD</Text>
        <Text dimColor>No plan yet. Run /{cmdNames.mission} plan {'<path>'}, or enable the host's task tools.</Text>
      </Box>
    )
  }
  if (!desktop) {
    return (
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <Text key={`l${i}`} wrap="truncate-end">
            {l}
          </Text>
        ))}
      </Box>
    )
  }
  const { Svg } = t
  const W = paneWidth(e)
  const select = (id: string | undefined) => () => cb.select(id)
  const setFilter = (f: MissionState | undefined) => () => cb.setFilter(f)
  const unpl = v.unplanned ? ` · +${v.unplanned} unplanned` : ''
  const hd = headerSvg(W, 'MISSION BOARD', `${v.planName}${unpl}`, 'pom', opts.mascots)
  const chips: [MissionState, string][] = [['done', 'DONE'], ['running', 'RUNNING'], ['review', 'REVIEW'], ['queued', 'QUEUED'], ['blocked', 'BLOCKED']]
  // running rows
  const runRows: unknown[] = []
  for (const it of v.items.filter(i => i.state === 'running')) {
    const rs = it.runIds.map(id => s.runs.find(r => r.id === id)).filter((r): r is PetRun => !!r && r.status === 'running')
    const line = runningLine(it, rs[0], s.mission.steps, typical, s.at, { px: W - 40 })
    const hot = (rs[0]?.ctxPct ?? 0) >= 80 ? 'warn' : undefined
    runRows.push(
      <Box key={`run:${it.id}`} flexDirection="row" alignItems="center" gap={1}>
        <Svg source={noteSvg(W - 40, line.trim(), hot, staleNote(rs[0], s))} alt={line} width={W - 40} height={noteHeight(line)} />
        <Button key={`open:${it.id}`} label="›" onPress={select(it.id)} />
      </Box>,
    )
  }
  const linked = new Set(v.items.flatMap(i => i.runIds))
  const unplannedRuns = s.runs.filter(r => !r.isBackfilled && !linked.has(r.id) && !r.reviewed)
  for (const r of unplannedRuns.filter(r => r.status === 'running')) {
    const line = runningLine(undefined, r, s.mission.steps, typical, s.at, { px: W })
    runRows.push(<Svg key={`urun:${r.id}`} source={noteSvg(W, line.trim(), (r.ctxPct ?? 0) >= 80 ? 'warn' : undefined, staleNote(r, s))} alt={line} width={W} height={noteHeight(line)} />)
  }
  // tiles: not-done first in plan order, then done (dimmed)
  const shown = v.items.filter(i => !v.filter || i.state === v.filter)
  const ordered = [...shown.filter(i => i.state !== 'done'), ...shown.filter(i => i.state === 'done')]
  const cap = opts.maxTiles
  const tiles = v.listView ? [] : ordered.slice(0, cap)
  const more = v.listView ? 0 : Math.max(0, ordered.length - cap)
  const sel = v.items.find(i => i.id === v.selected)
  const detail = sel ? detailLines(sel, s.runs, s.mission.steps, typical, s.at) : []
  const runTot = runLine(s.runs, s.mission.clock, s.at, {}, v.total)
  const accLine = acceptedLine(v, s.runs)
  const reviewIds = sel ? sel.runIds.filter(id => s.runs.find(r => r.id === id)?.reviewed !== true) : []
  return (
    <Box flexDirection="column">
      <Svg source={hd.svg} alt={lines[0] as string} width={W} height={hd.h} />
      <Text>{lines[1]}</Text>
      {runTot && <Svg key="run-total" source={noteSvg(W, runTot, undefined)} alt={runTot} width={W} height={30} />}
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {chips.map(([st, name]) => (
          <Button key={`chip:${st}`} label={`${v.counts[st]} ${name}`} onPress={setFilter(st)} />
        ))}
      </Box>
      {accLine && <Svg key="accepted" source={noteSvg(W, accLine, undefined)} alt={accLine} width={W} height={30} />}
      <Text dimColor>{`RUNNING NOW (${runRows.length})`}</Text>
      {runRows}
      <Text dimColor>{`EVERYTHING LEFT (${v.total - v.counts.done})`}</Text>
      <Box flexDirection="row" flexWrap="wrap">
        {tiles.map(it => (
          <Button key={it.id} plain onPress={select(it.id)}>
            <Text backgroundColor={TILE_BG[it.state]} color="#1a1d2b" dimColor={it.state === 'done'}>
              {MARK[it.state]}
            </Text>
          </Button>
        ))}
        {more > 0 && <Button key="more" label={`+${more} more`} onPress={() => cb.showList()} />}
      </Box>
      {v.listView &&
        ordered.map(it => (
          <Text key={`row:${it.id}`} wrap="truncate-end">{`${stateGlyph(it.state)} #${it.n} ${it.state} ${it.title}`}</Text>
        ))}
      {unplannedRuns.length > 0 && <Text dimColor>{`UNPLANNED (${unplannedRuns.length})`}</Text>}
      {unplannedRuns.map(r => (
        <Text key={`u:${r.id}`} wrap="truncate-end">{`${costumeEmoji(r.costume)} ${clip(r.description, 60)} · ${tierOf(r.model)} · ${r.status}`}</Text>
      ))}
      {sel && (
        <Box flexDirection="column">
          {detail.map((l, i) => (
            <Text key={`d${i}`}>{l}</Text>
          ))}
          <Box flexDirection="row" gap={1}>
            {sel.state === 'review' && reviewIds.length > 0 && <Button key="detail-reviewed" label="REVIEWED" onPress={() => cb.reviewed(reviewIds)} />}
            <Button key="detail-close" label="CLOSE" onPress={select(undefined)} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
