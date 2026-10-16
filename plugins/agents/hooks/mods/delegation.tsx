// Delegation Guard (pure view): the band segment, the pane tree and the pure model check.
import type { Spend } from '../../types'
import type { Segment } from '../_shared/band'
import { clip, fmtUsd } from '../_shared/fmt'
import { matchAny, splitGlobs } from '../_shared/glob'
import { svgDoc } from '../_shared/svgkit'
import { TIER_COLOR, V } from '../_shared/tokens'
import { chipSegment, headerSvg, noteSvg } from '../art'
import { barCells, barText, captions, totalSpend } from '../model'
import type { Opts } from '../model'
import type { Snap } from '../snap'
import { paneWidth } from './pets'

export const GUARD_PANE = 'delegation'
export const GUARD_DESC = 'Delegation Guard: warn, deny or off for Agent calls without a model'
export const DENY =
  'Agent call needs an explicit model. Set model to haiku (search, read, bulk), sonnet (build, tests, docs), opus or fable (hard design only). Policy: ~/.claude/CLAUDE.md. Retry the same call with model set.'

/** True when the guard judges this spawn (not a fork, workflow agent or allow-listed type). Pure. */
export function judges(e: { fork?: boolean; subagentType?: string; workflow?: unknown }, opts: Opts): boolean {
  if (e.fork || e.subagentType === 'fork' || e.workflow) return false
  return !matchAny(String(e.subagentType ?? ''), splitGlobs(opts.allowTypes))
}

export const NEST_DENY =
  'Agent call refused: you are a subagent, and subagents must not start subagents. Stop now and do not retry this call. Return to the orchestrator with your result so far and say exactly what you still need (the task, the files or the information); the orchestrator will delegate it. Policy: ~/.claude/CLAUDE.md.'

/** True when the nesting guard judges this spawn (a subagent started it; not a workflow script; not allow-listed). Pure. */
export function nests(e: { parentAgentId?: string; subagentType?: string; workflow?: unknown }, opts: Opts): boolean {
  if (e.parentAgentId === undefined || e.workflow) return false
  return !matchAny(String(e.subagentType ?? ''), splitGlobs(opts.nestAllow))
}

/** Band segment: running agents with a fired runaway threshold. */
export function runawaySegment(s: Snap): Segment | null {
  if (!s.opts.delegationOn) return null
  const n = s.runs.filter(r => r.status === 'running' && r.runaway).length
  if (n === 0) return null
  return chipSegment('runaway', 3, 2, [[`⚠ RUNAWAY ×${n}`, `⚠ RUNAWAY ×${n}`]], 'warn')
}

export function guardSegment(s: Snap): Segment | null {
  if (!s.opts.delegationOn) return null
  const n = s.spend.violations.length
  if (n === 0) return null
  return chipSegment('delegation', 2, 2, [[`NO MODEL ×${n}`, `⚠ NO MODEL ×${n}`], [`×${n}`, `⚠ ×${n}`]], 'warn')
}

const nestedLine = (v: { description: string; parent: string }): string => `⚠ AGENT · NESTED SPAWN · ${clip(v.description, 40)} · by ${clip(v.parent, 40)}`

const violationLine = (v: { description: string }): string => `⚠ AGENT · NO MODEL SET · ${clip(v.description, 40)} · add model: haiku`

function barSvg(W: number, spend: Spend): string {
  const cells = barCells(spend, 20)
  const cw = W / 20
  const body =
    `<rect x="0" y="0" width="${W}" height="14" fill="${V.well}" stroke="${V.edge}" stroke-width="1"/>` +
    cells.map((t, i) => `<rect x="${(i * cw).toFixed(1)}" y="0" width="${cw.toFixed(1)}" height="14" fill="${TIER_COLOR[t]}" stroke="${V.edge}" stroke-width="1"/>`).join('')
  return svgDoc(W, 16, body)
}

/** Footnote: `estimate (prices as of D[, custom]) · session total $X (differs N%)`. */
export function footnote(sp: Spend, label: string): string {
  let foot = label
  if (sp.sessionUsd !== undefined) {
    foot += ` · session total ${fmtUsd(sp.sessionUsd)}`
    const est = totalSpend(sp)
    const pct = est > 0 ? (Math.abs(sp.sessionUsd - est) / est) * 100 : 0
    if (pct > 15) foot += ` (differs ${Math.round(pct)}%)`
  }
  return foot
}

export function delegationPane(t: any, e: any, s: Snap, label: string): unknown {
  const { Box, Text } = t
  const sp = s.spend
  const title = `DELEGATION GUARD · ${s.guardMode}`
  const empty = sp.steps === 0 || totalSpend(sp) <= 0
  const desktop = e.surface !== 'terminal' && 'Svg' in t
  const W = Math.min(paneWidth(e), 340)
  const latest = sp.violations.slice(-3).reverse()
  const bar = barText(sp)
  const nestTitle = `NESTING GUARD · ${s.nestMode}`
  const nlatest = sp.nested.slice(-5).reverse()
  let head: unknown
  let barNode: unknown = null
  let notes: unknown[]
  let nestNodes: unknown[]
  if (desktop) {
    const { Svg } = t
    const hd = headerSvg(W, title, '', 'carrot', s.opts.mascots)
    head = <Svg source={hd.svg} alt={title} width={W} height={hd.h} />
    if (!empty) barNode = <Svg source={barSvg(292, sp)} alt={bar} width={292} height={16} />
    notes = latest.map((v, i) => <Svg key={`v${i}`} source={noteSvg(W, violationLine(v), 'warn')} alt={violationLine(v)} width={W} height={30} />)
    nestNodes = [
      <Svg key="nh" source={noteSvg(W, nestTitle)} alt={nestTitle} width={W} height={30} />,
      ...(nlatest.length === 0
        ? [<Svg key="n0" source={noteSvg(W, 'no nested spawns', undefined, true)} alt="no nested spawns" width={W} height={30} />]
        : nlatest.map((v, i) => <Svg key={`n${i}`} source={noteSvg(W, nestedLine(v), 'warn')} alt={nestedLine(v)} width={W} height={30} />)),
    ]
  } else {
    head = <Text bold>{title}</Text>
    if (!empty) barNode = <Text>{bar}</Text>
    notes = latest.map((v, i) => (
      <Text key={`v${i}`} color="yellow" wrap="truncate-end">
        {violationLine(v)}
      </Text>
    ))
    nestNodes = [
      <Text key="nh" bold>{nestTitle}</Text>,
      ...(nlatest.length === 0
        ? [<Text key="n0" dimColor>no nested spawns</Text>]
        : nlatest.map((v, i) => (
            <Text key={`n${i}`} color="yellow" wrap="truncate-end">
              {nestedLine(v)}
            </Text>
          ))),
    ]
  }
  return (
    <Box flexDirection="column">
      {head}
      <Text dimColor>SPEND BY TIER</Text>
      {empty ? <Text dimColor>No spend yet</Text> : barNode}
      {!empty && <Text>{captions(sp)}</Text>}
      <Text>{`Explicit model: ${sp.explicit} of ${sp.spawns} spawns`}</Text>
      {notes}
      {nestNodes}
      <Text dimColor>{footnote(sp, label)}</Text>
    </Box>
  )
}
