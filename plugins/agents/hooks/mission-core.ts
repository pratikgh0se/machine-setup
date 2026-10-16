// Mission Board: pure plan model. Merge of plan sources, per-item state, progress, mapping of agents to items,
// and the text forms (terminal pane, detail card). No engine calls.
import type { MissionItem, MissionSrc, MissionState, MissionView, PetRun, StepReport } from '../types'
import { clip, fmtTokens } from './_shared/fmt'
import { rowFor } from './_shared/prices'
import { jaccard, norm, tokenSet } from './_shared/plan'
import { GLYPH, termMeter } from './_shared/glyphs'
import { COSTUME_TAG, EMPTY_VIEW, RLABEL, costumeEmoji, elapsed, fmtClock, reviewState, tierOf } from './model'

export type Built = Pick<MissionItem, 'id' | 'title' | 'srcs' | 'src' | 'srcState'>
export type RichItem = MissionView['items'][number]

// ---------------------------------------------------------------------------
// Merge (mission-board.md s2)

const STATE_OF_STATUS = { pending: 'todo', in_progress: 'doing', completed: 'done' } as const

export function buildItems(src: MissionSrc): Built[] {
  const out: Built[] = []
  const toks: Set<string>[] = []
  for (const c of src.checklist.items) {
    out.push({ id: `T${c.id}`, title: clip(c.content, 60), srcs: ['checklist'], src: { kind: 'checklist', ref: `#${c.id}` }, srcState: STATE_OF_STATUS[c.status] ?? 'todo' })
    toks.push(tokenSet(c.content))
  }
  const deleted = src.deleted.map(d => new Set(d.split(' ').filter(Boolean)))
  const isDeleted = (t: Set<string>, n: string): boolean => src.deleted.some((d, i) => d === n || jaccard(t, deleted[i] as Set<string>) >= 0.8)
  const add = (kind: 'spec' | 'plan', name: string, boxes: MissionSrc['spec']): void => {
    const used = new Set<number>()
    for (const b of boxes) {
      if (out.length >= 500) break
      const t = tokenSet(b.text)
      const n = norm(b.text)
      if (isDeleted(t, n)) continue
      let hit = -1
      for (let i = 0; i < out.length; i++) {
        if (used.has(i) || (out[i] as Built).srcs.includes(kind)) continue
        if (norm((out[i] as Built).title) === n || jaccard(toks[i] as Set<string>, t) >= 0.8) {
          hit = i
          break
        }
      }
      if (hit >= 0) {
        used.add(hit)
        ;(out[hit] as Built).srcs.push(kind)
        continue
      }
      out.push({ id: `${kind === 'spec' ? 'S' : 'P'}${b.line}`, title: clip(b.text, 60), srcs: [kind], src: { kind, ref: name, line: b.line }, srcState: b.checked ? 'done' : 'todo' })
      toks.push(t)
    }
  }
  if (src.spec.length) add('spec', src.specName ?? 'spec', src.spec)
  if (src.plan.length) add('plan', src.planName ?? 'plan', src.plan)
  return out.slice(0, 500)
}

export function planNameOf(src: MissionSrc): string {
  const parts: string[] = []
  if (src.checklist.items.length) parts.push('checklist')
  if (src.spec.length) parts.push(`spec ${src.specName ?? ''}`.trim())
  if (src.planName && src.plan.length) parts.push(`plan ${src.planName}`)
  return parts.join(' + ') || 'checklist'
}

export function sourceText(i: { src: MissionItem['src'] }): string {
  const s = i.src
  return s.kind === 'checklist' ? `checklist ${s.ref}` : `${s.kind} ${s.ref} line ${s.line ?? 0}`
}

// ---------------------------------------------------------------------------
// Typical turns / progress

export type Typical = (type: string) => number
const DEFAULT_TYPICAL: Record<string, number> = { Explore: 8, 'general-purpose': 20, other: 15 }

export function typicalFn(runs: readonly PetRun[], json: string): Typical {
  let table = DEFAULT_TYPICAL
  try {
    const j = JSON.parse(json) as Record<string, unknown>
    if (j && typeof j === 'object') {
      table = { ...DEFAULT_TYPICAL }
      for (const [k, v] of Object.entries(j)) if (typeof v === 'number' && v > 0) table[k] = v
    }
  } catch {
    // keep the default table
  }
  return (type: string): number => {
    const done = runs.filter(r => r.status !== 'running' && !r.isBackfilled && r.type === type && (r.turns ?? 0) > 0).slice(-20)
    if (done.length >= 3) {
      const t = done.map(r => r.turns as number).sort((a, b) => a - b)
      const mid = t.length >> 1
      return t.length % 2 ? (t[mid] as number) : ((t[mid - 1] as number) + (t[mid] as number)) / 2
    }
    return table[type] ?? table.other ?? 15
  }
}

export type Prog = { frac: number; isEst: boolean; label: string; report?: StepReport }
export function progressOf(r: PetRun, steps: Record<string, StepReport>, typical: Typical, noteMax = 40): Prog {
  if (r.status !== 'running') return { frac: 1, isEst: false, label: 'done' }
  const rep = r.agentId ? steps[r.agentId] : undefined
  if (rep && rep.total >= 1) {
    const note = rep.note && rep.note.trim() && noteMax > 0 ? ` · ${clip(rep.note.trim(), noteMax)}` : ''
    return { frac: Math.min(1, rep.done / rep.total), isEst: false, label: `step ${rep.done}/${rep.total}${note}`, report: rep }
  }
  return { frac: Math.min(0.9, (r.turns ?? 0) / Math.max(1, typical(r.type))), isEst: true, label: 'est.' }
}

// ---------------------------------------------------------------------------
// State per item and the view

export function computeView(
  built: readonly Built[],
  runs: readonly PetRun[],
  links: Record<string, string>,
  steps: Record<string, StepReport>,
  typical: Typical,
  planName: string,
  prev: Pick<MissionView, 'selected' | 'filter'> & { listView?: boolean },
): MissionView & { listView?: boolean } {
  const byItem = new Map<string, PetRun[]>()
  let unplanned = 0
  for (const r of runs) {
    if (r.isBackfilled) continue
    const id = links[r.id]
    if (id && built.some(b => b.id === id)) {
      const l = byItem.get(id) ?? []
      l.push(r)
      byItem.set(id, l)
    } else if (!r.reviewed) unplanned++
  }
  const counts: Record<MissionState, number> = { queued: 0, running: 0, review: 0, done: 0, blocked: 0 }
  let stripe = 0
  const items: RichItem[] = built.map((b, i) => {
    const rs = byItem.get(b.id) ?? []
    let state: MissionState
    if (rs.length === 0) state = b.srcState === 'done' ? 'done' : b.srcState === 'doing' ? 'running' : 'queued'
    else if (rs.some(r => r.status === 'running')) state = 'running'
    else if (rs.some(r => r.status === 'failed')) state = b.srcState === 'done' ? 'done' : 'blocked'
    else state = rs.every(r => r.reviewed) ? 'done' : 'review'
    counts[state]++
    let pct: number | undefined
    let isEst: boolean | undefined
    let label: string | undefined
    if (rs.length) {
      const ps = rs.map(r => progressOf(r, steps, typical))
      const mean = ps.reduce((n, p) => n + p.frac, 0) / ps.length
      pct = Math.round(mean * 100)
      const live = rs.map((r, k) => ({ r, p: ps[k] as Prog })).filter(x => x.r.status === 'running')
      isEst = live.length > 0 && live.some(x => x.p.isEst)
      label = live.length > 1 ? `${live.length} agents` : live.length === 1 ? (live[0] as { p: Prog }).p.label : 'done'
      if (state === 'running') stripe += mean
    }
    return { ...b, n: i + 1, runIds: rs.map(r => r.id), state, pct, isEst, label }
  })
  const total = items.length
  const view: MissionView & { listView?: boolean } = {
    items,
    counts,
    total,
    pct: total ? Math.round((100 * counts.done) / total) : 0,
    stripePct: total ? (100 * stripe) / total : 0,
    unplanned,
    planName,
    selected: prev.selected && items.some(i => i.id === prev.selected) ? prev.selected : undefined,
    filter: prev.filter,
    listView: prev.listView,
  }
  return view
}

export const isAllDone = (v: Pick<MissionView, 'total' | 'counts'>): boolean =>
  v.total >= 1 && v.counts.done === v.total && v.counts.running === 0 && v.counts.review === 0 && v.counts.blocked === 0

/** Meter cells: round(pct*12/100), at least 1 when pct > 0, full only at 100. */
export function meterCells(pct: number, cells = 12): number {
  if (pct >= 100) return cells
  const n = Math.round((pct * cells) / 100)
  return Math.min(cells - 1, pct > 0 ? Math.max(1, n) : n)
}

// ---------------------------------------------------------------------------
// Mapping of an agent spawn to a plan item (first hit wins)

export function mapSpawn(built: readonly Built[], description: string, prompt: string, states: Record<string, MissionState>): string | undefined {
  const ids = new Set(built.map(b => b.id))
  const m1 = /\[task:([A-Za-z0-9]+)\]/.exec(prompt) ?? /\(task ([A-Za-z0-9]+)\)/.exec(prompt)
  if (m1 && ids.has(m1[1] as string)) return m1[1]
  const m2 = /Task #(\d+)/.exec(prompt)
  if (m2 && ids.has(`T${m2[1]}`)) return `T${m2[1]}`
  const nd = norm(description)
  if (!nd) return undefined
  const exact = built.find(b => norm(b.title) === nd)
  if (exact) return exact.id
  const td = tokenSet(description)
  let best = 0
  let second = 0
  let bestId: string | undefined
  for (const b of built) {
    if (states[b.id] === 'done') continue
    const j = jaccard(td, tokenSet(b.title))
    if (j > best) {
      second = best
      best = j
      bestId = b.id
    } else if (j > second) second = j
  }
  return best >= 0.6 && best > second ? bestId : undefined
}

// ---------------------------------------------------------------------------
// Text forms

const GL: Record<MissionState, string> = { done: GLYPH.ok, running: GLYPH.play, review: GLYPH.queue, blocked: GLYPH.denied, queued: GLYPH.bulletEmpty }
export const MARK: Record<MissionState, string> = { done: '✓', running: '▶', review: '?', blocked: '✕', queued: ' ' }
export const stateGlyph = (s: MissionState): string => GL[s]

export function countsLine(v: Pick<MissionView, 'counts'>): string {
  const c = v.counts
  return `${c.done} done · ${c.running} running · ${c.review} review · ${c.queued} queued · ${c.blocked} blocked`
}

/** Width hints: terminal `cols` (bodyColumns) or desktop row `px`; both undefined = unrestricted. */
export type Fit = { cols?: number; px?: number }

/** Context % of a window (rounded); undefined when the window is unknown. */
export const ctxPercent = (ctxTokens: number, window: number | undefined): number | undefined =>
  window && window > 0 ? Math.round((100 * ctxTokens) / window) : undefined

/** `~$0.42`, `~<$0.01` under a cent, `~$--` when unknown. Money is always an estimate. */
export function fmtEstUsd(usd: number | undefined): string {
  if (usd === undefined) return '~$--'
  if (usd > 0 && usd < 0.01) return '~<$0.01'
  return `~$${usd.toFixed(2)}`
}

const ctxText = (r: PetRun | undefined): string =>
  r?.ctxPct !== undefined ? `ctx ${r.ctxPct}%${r.ctxPct >= 80 ? ' ⚠' : ''}` : r?.ctx !== undefined ? `ctx ${fmtTokens(r.ctx)}` : 'ctx --'
const tokText = (r: PetRun | undefined): string => (r?.tokens !== undefined ? `${fmtTokens(r.tokens)} tok` : '-- tok')

/** `ctx 41% · 38k tok · ~$0.42` (full form). */
export function figures(r: PetRun | undefined): string {
  return `${ctxText(r)} · ${tokText(r)} · ${fmtEstUsd(r?.usd)}`
}

/** Second line of a RUNNING NOW row by width; '' when the width leaves no room (terminal < 80 cols). */
export function figuresFit(r: PetRun | undefined, f: Fit = {}): string {
  if (f.cols !== undefined) {
    if (f.cols < 80) return ''
    if (f.cols < 100) return `${ctxText(r)} · ${fmtEstUsd(r?.usd)}`
    return figures(r)
  }
  if (f.px !== undefined) {
    if (f.px < 260) return `${r?.ctxPct !== undefined ? `${r.ctxPct}%` : r?.ctx !== undefined ? fmtTokens(r.ctx) : '--'} ${fmtEstUsd(r?.usd)}`
    if (f.px < 340) return `${ctxText(r)} · ${fmtEstUsd(r?.usd)}`
  }
  return figures(r)
}

/** Effort chip word: `high`, `med`, `b8k` for an integer budget; '' when unknown. */
export function effortWord(r: PetRun | undefined, forCard = false): string {
  const e = r?.effort
  if (e === undefined || e === '') return ''
  if (typeof e === 'number') return `b${fmtTokens(e)}`
  return !forCard && e === 'medium' ? 'med' : e
}

const showEffort = (f: Fit): boolean => (f.cols === undefined || f.cols >= 90) && (f.px === undefined || f.px > 300)
const noteMaxOf = (f: Fit): number => (f.cols === undefined ? 40 : f.cols >= 100 ? 40 : f.cols >= 80 ? 24 : 0)

export type RunRow = { key: string; line: string; itemId?: string; run?: PetRun }

/** RUNNING NOW lines: line 1 (title, model chip, clock, meter, label) and, when width allows, line 2 (figures). The desktop alt is lines joined by a newline. */
export function runningLines(item: RichItem | undefined, r: PetRun | undefined, steps: Record<string, StepReport>, typical: Typical, at: number, f: Fit = {}): string[] {
  if (!item && !r) return []
  const title = clip(item?.title ?? r?.description ?? '', 60)
  if (!r) return [` ${GLYPH.play} MAIN   ${title}  ${figures(undefined)}  --`]
  const many = item && item.runIds.length > 1
  const p = progressOf(r, steps, typical, noteMaxOf(f))
  const pct = item?.pct ?? Math.round(p.frac * 100)
  const est = many ? Boolean(item?.isEst) : p.isEst
  const label = many ? (item?.label ?? p.label) : p.label
  const tag = (COSTUME_TAG[r.costume] || 'AGENT').padEnd(5)
  const eff = showEffort(f) ? effortWord(r) : ''
  const lines = [
    ` ${costumeEmoji(r.costume)} ${tag} ${title}  ${tierOf(r.model).toUpperCase()}${eff ? ` ${eff}` : ''} ${fmtClock(elapsed(r, at))}  ${termMeter(Math.round(pct / 10), 10)} ${est ? '~' : ''}${pct}% ${label}`,
  ]
  const fig = figuresFit(r, f)
  if (fig) lines.push(`     ${fig}`)
  else if (r.ctxPct !== undefined) lines[0] += ` ${r.ctxPct}%`
  else if (r.ctx !== undefined) lines[0] += ` ${fmtTokens(r.ctx)}`
  return lines
}

/** One-string form of a RUNNING NOW row (lines joined by a newline). */
export const runningLine = (item: RichItem | undefined, r: PetRun | undefined, steps: Record<string, StepReport>, typical: Typical, at: number, f: Fit = {}): string =>
  runningLines(item, r, steps, typical, at, f).join('\n')

const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const p2 = (n: number): string => String(Math.floor(n)).padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p2((s % 3600) / 60)}:${p2(s % 60)}` : `${p2(s / 60)}:${p2(s % 60)}`
}

export const BURST_GAP_MS = 30 * 60 * 1000

/** Start and end of the latest burst of runs (no plan): chain where each run starts < BURST_GAP_MS after all earlier ones ended. Pure in runs and `at`. */
function burstSpan(rs: readonly PetRun[], at: number): { start: number; end: number } {
  const sorted = [...rs].sort((a, b) => a.startedAt - b.startedAt)
  let start = 0
  let maxEnd = 0
  let running = false
  let first = true
  for (const r of sorted) {
    if (first || r.startedAt - maxEnd >= BURST_GAP_MS) {
      start = r.startedAt
      maxEnd = 0
      running = false
      first = false
    }
    if (r.endedAt === undefined) running = true
    maxEnd = Math.max(maxEnd, r.endedAt ?? Math.max(at, r.startedAt))
  }
  return { start, end: running ? Math.max(at, start) : maxEnd }
}

/** `RUN · ~$3.18 est. · 412k tok · 14:02 · 5 agents` over subagent runs (backfilled excluded); '' with no runs. */
export function runLine(runs: readonly PetRun[], clock: { epoch?: number; frozen?: number } | undefined, at: number, f: Fit = {}, total = 1): string {
  const rs = runs.filter(r => !r.isBackfilled)
  if (rs.length === 0) return ''
  const known = rs.filter(r => r.usd !== undefined)
  const usd = known.reduce((n, r) => n + (r.usd as number), 0)
  const floor = known.length < rs.length
  const tokens = rs.reduce((n, r) => n + (r.tokens ?? 0), 0)
  let start = Math.max(clock?.epoch ?? 0, Math.min(...rs.map(r => r.startedAt)))
  let end = clock?.frozen ?? at
  if (total === 0) ({ start, end } = burstSpan(rs, at))
  const cost = known.length === 0 ? '~$--' : `${fmtEstUsd(usd)}${floor ? '+' : ''}`
  const parts = ['RUN', `${cost} est.`, `${fmtTokens(tokens)} tok`, fmtElapsed(end - start), `${rs.length} agents`]
  if (f.cols !== undefined && f.cols < 80) parts.splice(2, 3, parts[3] as string)
  return parts.join(' · ')
}

/** `ACCEPTED 9 of 50 planned · 3 checked off by hand · 2 awaiting review`; '' with no plan. */
export function acceptedLine(view: Pick<MissionView, 'items' | 'counts' | 'total'>, runs: readonly PetRun[], f: Fit = {}): string {
  if (view.total === 0) return ''
  let accepted = 0
  let byHand = 0
  for (const it of view.items) {
    if (it.state !== 'done') continue
    const rs = it.runIds.map(id => runs.find(r => r.id === id)).filter((r): r is PetRun => !!r)
    if (rs.length > 0 && rs.every(r => r.reviewed)) accepted++
    else byHand++
  }
  const parts = [`ACCEPTED ${accepted} of ${view.total} planned`]
  if (!(f.cols !== undefined && f.cols < 80)) {
    if (byHand > 0) parts.push(`${byHand} checked off by hand`)
    if (view.counts.review > 0) parts.push(`${view.counts.review} awaiting review`)
  }
  return parts.join(' · ')
}

export function detailLines(item: RichItem, runs: readonly PetRun[], steps: Record<string, StepReport>, typical: Typical, at: number): string[] {
  const rs = item.runIds.map(id => runs.find(r => r.id === id)).filter((r): r is PetRun => !!r)
  const live = rs.find(r => r.status === 'running') ?? rs[rs.length - 1]
  const parts = [`#${item.n}`, item.state, item.title]
  if (live) parts.push(`${tierOf(live.model)} ${fmtClock(elapsed(live, at))}`)
  if (item.pct !== undefined) {
    const p = live ? progressOf(live, steps, typical) : undefined
    parts.push(item.state === 'running' && item.isEst ? `~${item.pct}% est.` : p && !p.isEst && live?.status === 'running' ? p.label : `${item.pct}%`)
  }
  parts.push(sourceText(item))
  const lines = [parts.join(' · ')]
  for (const r of rs) {
    const eff = effortWord(r)
    const dflt = rowFor(r.model).isDefault ? ' (default price)' : ''
    const peak = r.peak !== undefined ? ` · peak ctx ${fmtTokens(r.peak)}` : ''
    lines.push(`agent ${r.type} · ${tierOf(r.model)}${eff ? ` ${eff}` : ''} ${fmtClock(elapsed(r, at))} · ${r.status} · ${figures(r)}${dflt}${peak} · steps ${r.turns ? r.turns : '--'}`)
    lines.push(`effort ${r.effort !== undefined && r.effort !== '' ? `${effortWord(r, true)} (${r.effortSrc ?? 'spawn'})` : '--'}`)
    const rep = r.agentId ? steps[r.agentId] : undefined
    if (rep && rep.total >= 1) {
      const note = rep.note && rep.note.trim() ? ` · note: ${clip(rep.note.trim(), 60)}` : ''
      lines.push(`step ${rep.done}/${rep.total}${note} · ${Math.max(0, Math.round((at - rep.at) / 1000))} s ago`)
    }
  }
  if (item.state === 'review') for (const r of rs) lines.push(`review: ${RLABEL[reviewState(r)]} · [${reviewState(r)}]`)
  return lines
}

/** The terminal pane (also the source of the desktop alts). */
export function terminalPane(
  view: MissionView & { listView?: boolean },
  runs: readonly PetRun[],
  steps: Record<string, StepReport>,
  typical: Typical,
  at: number,
  opts: { maxTiles: number; cmd?: string; cols?: number; clock?: { epoch?: number; frozen?: number } },
): string[] {
  const fit: Fit = { cols: opts.cols }
  const out: string[] = []
  const unpl = view.unplanned ? ` · +${view.unplanned} unplanned` : ''
  out.push(`📋 MISSION · ${view.planName}${unpl}  ${view.pct}% ${termMeter(meterCells(view.pct))}`)
  out.push(countsLine(view))
  const runTot = runLine(runs, opts.clock, at, fit, view.total)
  if (runTot) out.push(runTot)
  const acc = acceptedLine(view, runs, fit)
  if (acc) out.push(acc)
  const run = view.items.filter(i => i.state === 'running')
  const rows: string[] = []
  for (const it of run) {
    const rs = it.runIds.map(id => runs.find(r => r.id === id)).filter((r): r is PetRun => !!r && r.status === 'running')
    rows.push(...runningLines(it, rs[0], steps, typical, at, fit))
  }
  const linked = new Set(view.items.flatMap(i => i.runIds))
  const unplannedRuns = runs.filter(r => !r.isBackfilled && !linked.has(r.id) && !r.reviewed)
  for (const r of unplannedRuns.filter(r => r.status === 'running')) rows.push(...runningLines(undefined, r, steps, typical, at, fit))
  const nRun = run.length + unplannedRuns.filter(r => r.status === 'running').length
  out.push(`RUNNING NOW (${nRun})`, ...rows)
  out.push(`EVERYTHING LEFT (${view.total - view.counts.done})   ${GLYPH.play} running  ${GLYPH.queue} review  ${GLYPH.denied} blocked  ${GLYPH.bulletEmpty} queued`)
  const shown = view.items.filter(i => !view.filter || i.state === view.filter)
  const cmd = opts.cmd ?? 'mission'
  const ordered = [...shown.filter(i => i.state !== 'done'), ...shown.filter(i => i.state === 'done')]
  if (view.listView) {
    for (const i of ordered) out.push(` ${stateGlyph(i.state)} #${i.n} ${i.state} ${clip(i.title, 60)}`)
  } else {
    const glyphs = ordered.slice(0, opts.maxTiles).map(i => stateGlyph(i.state))
    for (let k = 0; k < glyphs.length; k += 25) out.push(' ' + glyphs.slice(k, k + 25).join(''))
    const more = ordered.length - glyphs.length
    if (more > 0) out.push(` +${more} more · /${cmd} list shows all`)
  }
  if (unplannedRuns.length) {
    out.push(`UNPLANNED (${unplannedRuns.length})`)
    for (const r of unplannedRuns) out.push(` ${costumeEmoji(r.costume)} ${clip(r.description, 60)} · ${tierOf(r.model)} ${fmtClock(elapsed(r, at))} · ${r.status}`)
  }
  out.push(' 25 per line, numbered by plan order. /mission 17 shows item 17.')
  return out
}

export const EMPTY = EMPTY_VIEW
