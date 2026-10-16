// Now Doing: phase chips, "now:" sentence, checklist meter, long-command timer. Absorbs the agent-pets checklist.
import type { D } from '../lib/d'
import { sched } from '../lib/sched'
import { EMPTY_ND, EMPTY_SPEC } from '../lib/atoms'
import type { Segment, Variant } from '../_shared/band'
import { applyChecklist, createdId, isAllDone } from '../_shared/checklist'
import { basename, clip, fmtClock, fmtWhen } from '../_shared/fmt'
import { matchAny, splitGlobs } from '../_shared/glob'
import { termMeterRatio } from '../_shared/glyphs'
import type { MascotMode } from '../_shared/svgkit'
import { isVerifyCommand } from '../_shared/testparse'
import { V } from '../_shared/tokens'
import type { NdState, NowView, Phase } from '../../types'
import { percentOf, project, publishNow, touchClock } from '../lib/nowview'
import { optBool, optNum, optStr } from '../lib/opts'
import { cellWidth } from '../lib/rt'
import type { Rt } from '../lib/rt'
import { layout } from '../lib/seg'
import type { Piece } from '../lib/seg'
import { exeOf, isOkResult } from '../lib/util'
import { SPEC_GLOBS } from './spec'

export const PHASE_TOOL = 'mcp__awareness__phase'
const PHASES: readonly Phase[] = ['research', 'plan', 'build', 'verify', 'report']
const NAME: Record<Phase, string> = { research: 'RESEARCH', plan: 'PLAN', build: 'BUILD', verify: 'VERIFY', report: 'REPORT' }
const isPhase = (x: unknown): x is Phase => typeof x === 'string' && (PHASES as readonly string[]).includes(x)

const RESEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LSP', 'ToolSearch'])
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'ExitPlanMode'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch', 'LSP', 'ToolSearch'])
const READONLY_BASH = /^\s*(?:ls|cat|head|tail|wc|grep|rg|find|pwd|echo|which|stat|file|tree|du|df|git\s+(?:status|log|show|branch|remote)|node\s+-v|npm\s+(?:ls|view))\b/

function phaseMap(o: Rt['options']): Record<string, Phase> {
  const raw = optStr(o, 'nowdoing.phaseMap', '').trim()
  if (!raw) return {}
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, Phase> = {}
    for (const [k, v] of Object.entries(obj)) if (isPhase(v)) out[k] = v
    return out
  } catch {
    return {}
  }
}

const filePathOf = (e: any): string => String(e.file_path ?? e.notebook_path ?? e.path ?? '')

/** Applies a phase as the "latest call"; remembers the previous values so a read-only Bash can undo a BUILD. */
function withPhase(nd: NdState, p: Phase, derived: string, note?: string): NdState {
  return {
    ...nd,
    prev: { phase: nd.phase, visited: nd.visited },
    phase: p,
    visited: nd.visited.includes(p) ? nd.visited : [...nd.visited, p],
    derived,
    note,
  }
}

async function mutate($: D, fn: (nd: NdState) => NdState): Promise<void> {
  await $.update('nd', fn)
  await publishNow($)
}

// The Long Command Timer belongs to one tool call: `cmdId` is that call, `cmdShown` says its ticker runs.
let cmdShown = false
let cmdId: string | undefined
let cmdSeq = 0
let turnEpoch = 0 // bumped at turn.complete: a step that began earlier must not raise REPORT afterwards
// REPORT is a render-time overlay: state written from inside the turn.step stream is not reliably repainted, so the
// stream only flips this flag and asks for a redraw; ndSegments/ndCommand read it.
let reportLive = false
let turnLive = false // a main turn runs: the 1 s ticker keeps the band repainting (a state write alone is not always redrawn)
const REPORT_NOW = 'Writing the report'

function setReport(on: boolean, $?: D): void {
  const was = reportLive
  reportLive = on
  if (on && !was) {
    sched.wake()
    try {
      $?.ui.invalidate()
    } catch {
      // The 1 s ticker repaints anyway.
    }
  }
}

/** The view as drawn: REPORT overlaid while the summary streams, previous chips staying visited. */
function overlay(view: NowView): NowView {
  if (!reportLive) return view
  return { ...view, phase: 'report', visited: view.visited.includes('report') ? view.visited : [...view.visited, 'report'], now: REPORT_NOW }
}
const cmdActive = (): boolean => cmdShown

/** Forgets the timed call (its late timer callback becomes a no-op) and stops the ticker. */
function dropCmd(): void {
  cmdId = undefined
  cmdShown = false
}

async function runningAgents($: D): Promise<number> {
  try {
    return (await $.agent.list()).filter(a => a.status === 'running').length
  } catch {
    return 0
  }
}

async function classify($: D, rt: Rt, e: any): Promise<{ phase: Phase; derived: string } | undefined> {
  const tool = String(e.tool)
  const extra = phaseMap(rt.options)[tool]
  const fp = filePathOf(e)
  const base = fp ? basename(fp) : ''
  const globs = splitGlobs(optStr(rt.options, ['nowdoing.specGlobs', 'spec.globs'], SPEC_GLOBS))
  const isSpecPath = !!fp && matchAny(fp, globs, { cwd: rt.cwd })
  const derivedFor = async (): Promise<string> => {
    if (tool === 'Read') return base ? `Reading ${base}` : 'Reading'
    if (EDIT_TOOLS.has(tool)) return base ? `Editing ${base}` : 'Editing'
    if (SEARCH_TOOLS.has(tool)) return 'Searching'
    if (tool === 'Bash') return `Running ${exeOf(String(e.command ?? ''))}`
    if (AGENT_TOOLS.has(tool)) {
      const n = Math.max(1, (await runningAgents($)) + 1)
      return `Waiting on ${n} agent${n === 1 ? '' : 's'}`
    }
    if (PLAN_TOOLS.has(tool)) return 'Planning'
    return 'Working'
  }
  if (extra) return { phase: extra, derived: await derivedFor() }
  if (EDIT_TOOLS.has(tool) && isSpecPath) return { phase: 'plan', derived: await derivedFor() }
  if (PLAN_TOOLS.has(tool)) return { phase: 'plan', derived: await derivedFor() }
  if (RESEARCH_TOOLS.has(tool)) return { phase: 'research', derived: await derivedFor() }
  if (EDIT_TOOLS.has(tool)) return { phase: 'build', derived: await derivedFor() }
  if (AGENT_TOOLS.has(tool)) return { phase: String(e.subagent_type ?? e.subagentType) === 'Explore' ? 'research' : 'build', derived: await derivedFor() }
  if (tool === 'Bash') {
    const cmd = String(e.command ?? '')
    const phase: Phase = isVerifyCommand(cmd) ? 'verify' : READONLY_BASH.test(cmd) ? 'research' : 'build'
    return { phase, derived: await derivedFor() }
  }
  return undefined
}

// ---- segment ---------------------------------------------------------------------------------------

type Ctx = { draw: boolean; view: NowView; nd: NdState; clock: number; mascot: boolean; mode: MascotMode }

function build(c: Ctx, level: 0 | 1 | 2 | 3): Variant {
  const { view, nd } = c
  const showPhase = nd.turn || !!view.phase
  const pct = percentOf(view)
  const hasMeter = pct != null
  const sentence = view.isComplete && view.total > 0 ? `✓ all ${view.total} done` : view.now
  const sentLim = [80, 32, 24, 0][level] as number
  const cur = view.phase
  const tChips = PHASES.map(p => `${p === cur ? '▶' : view.visited.includes(p) ? '▪' : '▫'}${NAME[p]}`).join(' ')
  const tCur = cur ? `▶ ${NAME[cur]}` : '▶ WORKING'
  const specChip = view.specTotal ? `📋 SPEC ${view.specDone ?? 0}/${view.specTotal}` : ''
  const specNext = level === 0 && view.specNext ? ` · next: ${clip(view.specNext, 60)}` : ''
  const elapsed = view.cmd ? fmtClock(Math.max(0, c.clock - view.cmd.startedAt)) : ''
  const cmdTxt = view.cmd ? `⏱ ${view.cmd.exe} ${elapsed}` : ''
  const nowTxt = sentence && sentLim > 0 ? (view.isComplete && view.total > 0 ? sentence : `now: ${clip(sentence, sentLim)}`) : ''
  const meterTxt = hasMeter ? `${termMeterRatio((pct as number) / 100)} ${pct}%` : ''

  const parts: string[] = []
  const pieces: Piece[] = []
  if (c.mascot) pieces.push({ k: 'mascot', size: 20, mode: c.mode })

  if (level <= 1) {
    if (showPhase) {
      parts.push(tChips)
      PHASES.forEach(p =>
        pieces.push({ k: 'chip', label: NAME[p], w: 78, signal: p === cur ? 'accent' : undefined, dim: p !== cur && !view.visited.includes(p), textFill: V.text }),
      )
    }
    if (nowTxt) {
      parts.push(nowTxt)
      pieces.push({ k: 'text', s: nowTxt, face: 'mono', size: 11 })
    }
    if (hasMeter) {
      parts.push(meterTxt)
      pieces.push({ k: 'meter', ratio: (pct as number) / 100, color: view.isComplete ? V.ok : V.accent, cellW: 6, gap: 2 }, { k: 'text', s: `${pct}%`, face: 'pixel', size: 11 })
    }
    if (specChip) {
      parts.push(specChip + specNext)
      pieces.push({ k: 'chip', label: `SPEC ${view.specDone ?? 0}/${view.specTotal}`, signal: 'info' })
      if (specNext) pieces.push({ k: 'text', s: `next: ${clip(view.specNext ?? '', 60)}`, face: 'mono', size: 10, fill: V.text2 })
    }
    if (cmdTxt) {
      parts.push(cmdTxt)
      pieces.push({ k: 'chip', label: `RUN ${view.cmd?.exe} ${elapsed}`, signal: 'warn' })
    }
    const text = parts.join('  ')
    const l = c.draw ? layout(pieces, 8) : { px: 0, svg: '' }
    return { px: c.draw ? l.px : cellWidth(text) * 7, cells: cellWidth(text), svg: l.svg, text, alt: text }
  }

  if (level === 2) {
    const head: string[] = []
    if (showPhase) {
      head.push(tCur)
      pieces.push({ k: 'chip', label: cur ? NAME[cur] : 'WORKING', signal: 'accent', w: 78 })
    }
    let line = head.join('')
    if (nowTxt) {
      line += line ? ` · ${nowTxt}` : nowTxt
      pieces.push({ k: 'text', s: nowTxt, face: 'mono', size: 11 })
    }
    if (hasMeter) {
      line += `${line ? ' ' : ''}${pct}%`
      pieces.push({ k: 'text', s: `${pct}%`, face: 'pixel', size: 11 })
    }
    if (specChip) {
      line += `${line ? '  ' : ''}${specChip}`
      pieces.push({ k: 'chip', label: `SPEC ${view.specDone ?? 0}/${view.specTotal}`, signal: 'info' })
    }
    if (cmdTxt) {
      line += `${line ? '  ' : ''}${cmdTxt}`
      pieces.push({ k: 'chip', label: `RUN ${view.cmd?.exe} ${elapsed}`, signal: 'warn' })
    }
    const l = c.draw ? layout(pieces, 8) : { px: 0, svg: '' }
    return { px: c.draw ? l.px : cellWidth(line) * 7, cells: cellWidth(line), svg: l.svg, text: line, alt: line }
  }

  // Level 3: minimal `VERIFY 60%`.
  const word = cur ? NAME[cur] : showPhase ? 'WORKING' : specChip ? 'SPEC' : 'NOW'
  let line = specChip && !showPhase && !hasMeter ? `SPEC ${view.specDone ?? 0}/${view.specTotal}` : `${word}${hasMeter ? ` ${pct}%` : ''}`
  pieces.push({ k: 'chip', label: line, signal: 'accent' })
  if (cmdTxt) {
    line += `  ${cmdTxt}`
    pieces.push({ k: 'chip', label: `RUN ${view.cmd?.exe} ${elapsed}`, signal: 'warn' })
  }
  const l = c.draw ? layout(pieces, 8) : { px: 0, svg: '' }
  return { px: c.draw ? l.px : cellWidth(line) * 7, cells: cellWidth(line), svg: l.svg, text: line, alt: line }
}

// ---- event handlers (register.tsx owns the single hook per event and calls these) -------------------------

export async function ndPrompt($: D): Promise<void> {
  dropCmd()
  reportLive = false
  try {
    await mutate($, nd => ({
      ...nd,
      cmd: undefined,
      phase: undefined,
      visited: [],
      prev: undefined,
      derived: '',
      note: undefined,
      toolDone: undefined,
      toolTotal: undefined,
      checklist: isAllDone(nd.checklist.items) ? { items: [], seq: 0 } : nd.checklist,
    }))
  } catch {
    // Keep the row as it was.
  }
}

export async function ndTurnStart($: D): Promise<void> {
  dropCmd()
  setReport(false)
  turnLive = true
  sched.wake()
  try {
    await mutate($, nd => ({ ...nd, turn: true, cmd: undefined }))
  } catch {
    // Best effort.
  }
}

export async function ndTurnComplete($: D, e: any): Promise<void> {
  if (e?.agentId) return
  turnEpoch++
  dropCmd()
  const wasReport = reportLive
  turnLive = false
  let endedAt = 0
  try {
    endedAt = await $.clock.now()
  } catch {
    // The record gets no time.
  }
  try {
    await mutate($, nd => {
      const v = project(nd, EMPTY_SPEC)
      const phase = wasReport ? 'report' : nd.phase
      const now = wasReport ? REPORT_NOW : v.now
      const last: NdState['last'] = phase || now ? { phase, now, endedAt, ...(v.total > 0 ? { done: v.done, total: v.total } : {}) } : nd.last
      return { ...nd, cmd: undefined, turn: false, phase: undefined, visited: [], prev: undefined, derived: '', note: undefined, last }
    })
  } catch {
    // Best effort.
  }
  setReport(false) // only now: the row must not fall back to the old phase between the two
}

export type StepObs = { report: boolean; epoch: number }

/** Per-step observer of the streamed chunks (main thread only; undefined for a subagent step). */
export function ndStepObs(e: any): StepObs | undefined {
  if (e?.agentId) return undefined
  reportLive = false // a new main step: whatever the last one left behind is over
  return { report: false, epoch: turnEpoch }
}

/**
 * REPORT as soon as the step streams its first non-empty text; a tool chunk later in the same step means the text was
 * narration, so the previous phase returns. Only the render-time flag changes here, never state.
 */
export function ndStepChunk($: D, o: StepObs, c: any): void {
  try {
    if (o.epoch !== turnEpoch) return
    if (c?.kind === 'text' && !o.report && typeof c.text === 'string' && c.text.trim()) {
      o.report = true
      setReport(true, $)
    } else if (c?.kind === 'tool' && o.report) {
      o.report = false
      setReport(false)
    }
  } catch {
    // Never disturb the stream.
  }
}

/** Kept for the hook's call order; nothing is chained any more. */
export async function ndStepEnd(_o: StepObs | undefined): Promise<void> {}

/** REPORT backstop: a main step that ends the turn with an answer and no tool use. */
export async function ndStepAfter($: D, e: any, r: any, o?: StepObs): Promise<void> {
  try {
    if (o && o.epoch !== turnEpoch) return
    if (!e?.agentId && r && Array.isArray(r.toolUses) && r.toolUses.length === 0 && String(r.answer ?? '').trim()) setReport(true, $)
  } catch {
    // Never disturb the step.
  }
}

/** The phase tool: the model's override of phase and sentence. Returns the tool result, or undefined for any other call. */
export async function ndToolEarly($: D, rt: Rt, e: any): Promise<{ result: string } | undefined> {
  if (String(e.tool) !== PHASE_TOOL || !optBool(rt.options, 'nowdoing.tool', true)) return undefined
  if (e.agentId !== undefined) return { result: 'ignored: only the main thread sets the phase' }
  setReport(false)
  {
    try {
      const p = isPhase(e.phase) ? e.phase : undefined
      const note = typeof e.note === 'string' && e.note.trim() ? clip(e.note.trim().replace(/\s+/g, ' '), 80) : undefined
      const done = typeof e.done === 'number' ? e.done : undefined
      const total = typeof e.total === 'number' ? e.total : undefined
      await mutate($, nd => {
        const base = p ? withPhase(nd, p, nd.derived, note) : { ...nd, note: note ?? nd.note }
        return { ...base, toolDone: done ?? base.toolDone, toolTotal: total ?? base.toolTotal }
      })
    } catch {
      // The call still succeeds.
    }
  }
  return { result: 'ok' }
}

/** Session end: the ticker stops and no late timer can set the chip again. */
export function ndSessionEnd(): void {
  turnLive = false
  reportLive = false
  dropCmd()
}

export type NdCall = { timer?: { cancel: () => void }; provisionalBuild: boolean; id: string; fired: boolean }

export async function ndToolBefore($: D, rt: Rt, e: any): Promise<NdCall> {
  const st: NdCall = { provisionalBuild: false, id: String(e.tool_use_id ?? `nd${++cmdSeq}`), fired: false }
  if (e.agentId !== undefined) return st
  setReport(false)
  const tool = String(e.tool)
  try {
    const cls = await classify($, rt, e)
    if (cls) {
      st.provisionalBuild = tool === 'Bash' && cls.phase === 'build'
      await mutate($, nd => withPhase(nd, cls.phase, cls.derived))
    }
    if (tool === 'Bash' && !e.run_in_background) {
      const exe = exeOf(String(e.command ?? ''))
      const t0 = await $.clock.now()
      if (cmdId !== undefined) {
        // A newer timed call voids the older one: its late callback is a no-op and its chip goes now.
        dropCmd()
        await mutate($, nd => ({ ...nd, cmd: undefined }))
      }
      cmdId = st.id
      st.timer = $.clock.after(Math.max(1, optNum(rt.options, 'nowdoing.showAfterSec', 10)) * 1000, () => {
        void (async () => {
          try {
            if (cmdId !== st.id) return
            st.fired = true
            cmdShown = true
            sched.wake()
            await mutate($, nd => (cmdId === st.id ? { ...nd, cmd: { exe, startedAt: t0, id: st.id } } : nd))
            await touchClock($)
          } catch {
            // Best effort; the renderer hides the chip whenever the ticker is not running.
          }
        })()
      })
    }
  } catch {
    // Tracking is best effort.
  }
  return st
}

export async function ndToolFinally($: D, st: NdCall): Promise<void> {
  if (!st.timer) return
  st.timer.cancel()
  const mine = cmdId === st.id
  if (mine) dropCmd()
  if (!st.fired) return
  try {
    // Clears only this call's chip; a newer call's chip stays.
    await mutate($, nd => (nd.cmd && nd.cmd.id !== undefined && nd.cmd.id !== st.id ? nd : { ...nd, cmd: undefined }))
    await touchClock($) // one more repaint, whatever the ticker is doing
  } catch {
    // Best effort; the renderer hides the chip whenever the ticker is not running.
  }
}

export async function ndToolAfter($: D, e: any, ran: any, st: NdCall): Promise<void> {
  if (e.agentId !== undefined) return
  const tool = String(e.tool)
  try {
    if (!isOkResult(ran)) return
    if (tool === 'TodoWrite') await mutate($, nd => ({ ...nd, checklist: applyChecklist(nd.checklist, { tool: 'TodoWrite', todos: e.todos }) }))
    else if (tool === 'TaskCreate')
      await mutate($, nd => ({ ...nd, checklist: applyChecklist(nd.checklist, { tool: 'TaskCreate', subject: e.subject, activeForm: e.activeForm, resultId: createdId(ran) }) }))
    else if (tool === 'TaskUpdate')
      await mutate($, nd => ({ ...nd, checklist: applyChecklist(nd.checklist, { tool: 'TaskUpdate', taskId: e.taskId, subject: e.subject, activeForm: e.activeForm, status: e.status }) }))
    else if (st.provisionalBuild && ran.isReadOnly === true) {
      // The engine says the command only reads: it was research, not building.
      await mutate($, nd => {
        if (nd.phase !== 'build') return nd
        const base = { ...nd, phase: nd.prev?.phase, visited: nd.prev?.visited ?? nd.visited }
        return withPhase(base, 'research', nd.derived)
      })
    }
  } catch {
    // Never let tracking disturb the tool call.
  }
}

export async function ndTick($: D, _rt: Rt, now: number): Promise<number | undefined> {
  if (!cmdActive() && !reportLive && !turnLive) return undefined
  if (reportLive || turnLive) {
    // No state write here: one made while a step streams is deferred and then refused. A redraw request is enough.
    try {
      $.ui.invalidate()
    } catch {
      // The next event repaints.
    }
    if (!cmdActive()) return 1000
  }
  await touchClock($, now)
  return 1000
}

export async function ndCommand($: D, _rt: Rt, args: string): Promise<string> {
  const sub = args.trim().split(/\s+/)[0] || 'status'
  if (sub === 'reset') {
    reportLive = false
    await $.update('nd', () => EMPTY_ND)
    await publishNow($)
    return 'Now Doing reset.'
  }
  const nd = await $.read('nd')
  const view = overlay(project(nd, await $.read('sp')))
  const pct = percentOf(view)
  const idleLast = !nd.turn && !view.phase && nd.last ? nd.last : undefined
  const lead = idleLast
    ? [
        `last turn: ${idleLast.phase ? NAME[idleLast.phase] : 'no phase'}`,
        idleLast.now ? `now: ${idleLast.now}` : '',
        idleLast.endedAt ? `ended ${fmtWhen(idleLast.endedAt, await $.clock.now())}` : '',
        idleLast.total ? `${idleLast.done ?? 0}/${idleLast.total} done` : '',
      ]
    : [
        view.phase ? `phase ${NAME[view.phase]}` : nd.turn ? 'no phase' : 'no phase yet',
        view.now ? `now: ${view.now}` : '',
        view.total > 0 ? `${view.done}/${view.total} done` : '',
      ]
  const bits = [...lead, view.specTotal ? `SPEC ${view.specDone ?? 0}/${view.specTotal}` : '', !idleLast && pct != null ? `${pct}%` : ''].filter(Boolean)
  return bits.join(' · ')
}

export async function ndSegments($: D, rt: Rt, e: any): Promise<Segment | null> {
  const nd = await $.read('nd')
  const sp = await $.read('sp')
  const view = overlay(project(nd, sp))
  if (!cmdShown) view.cmd = undefined // the chip lives only while its ticker runs
  const hasList = nd.checklist.items.length > 0 || (view.total > 0 && view.isComplete)
  const hasSpec = !!view.specTotal
  if (!(nd.turn || view.phase || hasList || view.cmd || hasSpec)) return null
  await $.read('clock')
  const clock = await $.clock.now()
  const mode = (optStr(rt.options, 'mascots', 'auto') as MascotMode) || 'auto'
  const c: Ctx = { draw: e?.surface !== 'terminal', view, nd, clock, mascot: optBool(rt.options, 'nowdoing.mascot', false), mode }
  return { id: 'nowdoing', order: 2, priority: 2, variants: ([0, 1, 2, 3] as const).map(l => build(c, l)) }
}
