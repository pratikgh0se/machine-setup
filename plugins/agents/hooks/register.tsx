// agents: Pets in Still Room, Review Queue, Delegation Guard, Mission Board.
//
// Why one big file: `claude plugin validate` follows `$` only into functions declared in the SAME file (never across an
// import), reads `atom(...)` consts of the same file only, and refuses two un-matched hooks on one event. So every
// function that takes `$` lives here; the files beside it are pure (model, mission-core, art, mods/* views).
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { MissionState, MissionSrc, PetChecklist, PetRun, Spend, StepReport } from '../types'
import { composeRow, bandWidth, bandLine, bandStack } from './_shared/band'
import type { Segment } from './_shared/band'
import { applyChecklist, createdId, isAllDone as listAllDone, EMPTY_CHECKLIST } from './_shared/checklist'
import { basename, clip } from './_shared/fmt'
import { makeMatcher, splitGlobs } from './_shared/glob'
import { toastGlyph } from './_shared/glyphs'
import { norm } from './_shared/plan'
import { parsePricesJson, priceLabel, stepCostUsd } from './_shared/prices'
import type { PriceOverrides } from './_shared/prices'
import { parseWindowsJson, windowFor } from './_shared/windows'
import type { WindowOverrides } from './_shared/windows'
import { parseTestOutput } from './_shared/testparse'
import { EMPTY_SPEND, EMPTY_VIEW, costumeOf, parseOptions, queueOf, tierOf } from './model'
import type { Opts } from './model'
import { testRunnerOf } from './runner'
import { buildItems, computeView, ctxPercent, detailLines, isAllDone, mapSpawn, planNameOf, runLine, typicalFn } from './mission-core'
import type { Snap } from './snap'
import { DENY, GUARD_DESC, GUARD_PANE, NEST_DENY, delegationPane, guardSegment, judges, nests, runawaySegment } from './mods/delegation'
import { MISSION_DESC, MISSION_HINT, MISSION_PANE, MISSION_TITLE, LINE_BASH, LINE_TOOL, STEP_DESC, STEP_TOOL, boxesOf, missionPane, missionSegment, shouldAutoOpen } from './mods/mission'
import { PETS_PANE, PETS_TITLE, checklistSegment, petsButtonLabel, petsPane } from './mods/pets'
import { REVIEW_DESC, cmdNames, reviewListText, reviewSegment } from './mods/review'

// ---------------------------------------------------------------------------
// State (declared here: validate reads the atom consts of this file)

const runsA = atom({ plugin: 'agents', key: 'runs' } as const, [])
const spendA = atom({ plugin: 'agents', key: 'spend' } as const, EMPTY_SPEND)
const uiA = atom({ plugin: 'agents', key: 'ui' } as const, { autoOpened: false })
const checklistA = atom({ plugin: 'agents', key: 'checklist' } as const, { items: [], seq: 0 } as PetChecklist)
const guardA = atom({ plugin: 'agents', key: 'guard' } as const, { mode: 'warn' as 'off' | 'warn' | 'deny', nestMode: 'warn' as 'off' | 'warn' | 'deny' })
const runawayA = atom({ plugin: 'agents', key: 'runaway' } as const, {} as Record<string, { steps: number; ctx: number; hitSteps?: number; hitCtx?: number }>)
const clockA = atom({ plugin: 'agents', key: 'clock' } as const, 0)
const missionA = atom({ plugin: 'agents', key: 'mission' } as const, { view: EMPTY_VIEW, steps: {}, links: {}, allDone: false })
const missionSrcA = atom({ plugin: 'agents', key: 'missionSrc' } as const, {
  checklist: { items: [], seq: 0 } as PetChecklist,
  deleted: [] as string[],
  spec: [],
  plan: [],
})

// ---------------------------------------------------------------------------
// Module caches (hot reload loses them; register() resets them)

let O: Opts = parseOptions(undefined)
let lastSync = Number.NEGATIVE_INFINITY
let syncing = false
let priceKey: string | undefined
let priceCache: { overrides?: PriceOverrides; label: string } = { label: priceLabel() }
let winKey: string | undefined
let winCache: WindowOverrides | undefined
let modeCache: 'off' | 'warn' | 'deny' = 'warn'
let modeLoaded = false
let nestCache: 'off' | 'warn' | 'deny' = 'warn'
let nestLoaded = false
let lastNestToastAt: number | undefined
let lastToastAt: number | undefined
let specPath: string | undefined
let specMatcher: ((p: string) => boolean) | undefined
let autoOpened = false
let fullscreen: boolean | undefined
let petsUserRan = false
let lastStatus: string | undefined
const touched = new Map<string, Set<string>>()

const SYNC_EVERY_MS = 3000
const MISSED_TO_DONE = 2
const WRITERS = new Set(['Edit', 'Write', 'NotebookEdit'])
const mapStatus = (s: AgentInfo['status']): PetRun['status'] => (s === 'completed' ? 'done' : s === 'failed' || s === 'killed' ? 'failed' : 'running')
const isOk = (r: { deny?: unknown; isError?: unknown } | undefined): boolean => !!r && r.deny === undefined && r.isError !== true
const outputOf = (ran: any): string => {
  const r = ran?.result
  const parts = [r?.stdout, r?.stderr].filter((s): s is string => typeof s === 'string')
  if (parts.length) return parts.join('\n')
  return typeof ran?.text === 'string' ? ran.text : ''
}

// ---------------------------------------------------------------------------
// Reads

/** Fire-and-forget pane open: a rejection is swallowed, never unhandled. */
function fireOpen($: EngineInterface, id: string, title: string): void {
  try {
    void Promise.resolve($.ui.open({ id, title })).catch(() => {})
  } catch {
    // opening a pane is a courtesy
  }
}

const seeViewport = (e: any): void => {
  if (typeof e?.viewport?.isFullscreen === 'boolean') fullscreen = e.viewport.isFullscreen
}

/** Absolute paths as given; relative ones resolve against the session cwd. */
async function resolvePath($: EngineInterface, p: string): Promise<string> {
  if (p.startsWith('/') || p.startsWith('~')) return p
  let cwd = ''
  try {
    cwd = String(await $.session.cwd())
  } catch {
    return p
  }
  return `${cwd.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
}

async function snapshot($: EngineInterface): Promise<Snap> {
  const [rawRuns, spend, checklist, mission, guard, clock, runaway] = await Promise.all([
    read($, runsA),
    read($, spendA),
    read($, checklistA),
    read($, missionA),
    read($, guardA),
    read($, clockA),
    read($, runawayA),
  ])
  const runs = rawRuns.map(r => {
    const h = r.agentId === undefined ? undefined : runaway[r.agentId]
    return h && (h.hitSteps !== undefined || h.hitCtx !== undefined) ? { ...r, runaway: true } : r
  })
  const now = await $.clock.now()
  return { runs, spend, checklist, mission, guardMode: guard.mode, nestMode: guard.nestMode ?? 'warn', at: Math.max(clock, now), opts: O }
}

// ---------------------------------------------------------------------------
// Mission view (recomputed in hooks, never in a render hook)

async function recompute($: EngineInterface): Promise<void> {
  if (!O.missionOn) return
  const [src, runs] = await Promise.all([read($, missionSrcA), read($, runsA)])
  const built = buildItems(src)
  const typical = typicalFn(runs, O.typicalTurns)
  const name = planNameOf(src)
  let total = 0
  const at = await $.clock.now()
  await update($, missionA, m => {
    const view = computeView(built, runs, m.links, m.steps, typical, name, m.view)
    total = view.total
    const allDone = isAllDone(view)
    // The run-total clock stops at allDone and keeps its value until a new plan restarts it.
    const clock = allDone ? (m.clock?.frozen === undefined ? { ...m.clock, frozen: at } : m.clock) : m.clock?.frozen !== undefined ? { ...m.clock, frozen: undefined } : m.clock
    return { ...m, view, allDone, clock }
  })
  // Plan start (>= 5 items, >= 2 agents running) opens the pane once, only where panes dock (fullscreen).
  if (!autoOpened && fullscreen === true && total >= 5 && runs.filter(r => r.status === 'running' && !r.isBackfilled).length >= 2) {
    autoOpened = true
    fireOpen($, MISSION_PANE, MISSION_TITLE)
  }
}

/** `$.ui.status` fallback for sessions without a band (-p runs). Written only while `$.session.surfaces()` is empty (re-checked at every write); cleared once when a surface appears. Never called from render (F30). */
async function refreshStatus($: EngineInterface): Promise<void> {
  try {
    let text: string | undefined
    if ((await $.session.surfaces()).length === 0) {
      const parts: string[] = []
      if (O.missionOn) {
        const v = (await read($, missionA)).view
        if (v.total > 0) parts.push(`plan ${v.counts.done}/${v.total} · ${v.counts.running} running`)
      }
      const runs = await read($, runsA)
      const working = runs.filter(r => r.status === 'running').length
      const queued = O.reviewOn ? queueOf(runs, O.includeBackfilled).length : 0
      if (working > 0 || queued > 0) parts.push(`agents ${[working > 0 ? `${working} working` : '', queued > 0 ? `${queued} to review` : ''].filter(Boolean).join(' · ')}`)
      text = parts.length ? parts.join(' | ') : undefined
    }
    if (text === lastStatus) return
    lastStatus = text
    $.ui.status(text)
  } catch {
    // The status line is a courtesy.
  }
}

/** A usable usage block (four finite counts >= 0, missing = 0) or null; malformed input is treated as no usage. */
function cleanUsage(u: any): any {
  if (!u || typeof u !== 'object') return null
  const out: Record<string, unknown> = { ...u }
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const v = u[k]
    if (v === undefined || v === null) out[k] = 0
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  }
  if (out.model !== undefined && typeof out.model !== 'string') out.model = undefined
  return out
}

/** Writes the run table, then refreshes everything derived from it. */
async function updateRuns($: EngineInterface, fn: (list: PetRun[]) => PetRun[]): Promise<void> {
  await update($, runsA, fn)
  await recompute($)
  await refreshStatus($)
}

// ---------------------------------------------------------------------------
// Prices

function pricing($: EngineInterface): { overrides?: PriceOverrides; label: string } {
  if (priceKey === O.pricesJson) return priceCache
  priceKey = O.pricesJson
  const p = parsePricesJson(O.pricesJson)
  if (p.ok) {
    const custom = Object.keys(p.overrides.byFamily).length > 0
    priceCache = { overrides: custom ? p.overrides : undefined, label: priceLabel(p.overrides, custom) }
  } else {
    try {
      $.ui.log('agents: pricesJson is not valid JSON; using the built-in price table', { to: 'debug' })
    } catch {
      // logging is best effort
    }
    priceCache = { label: priceLabel() }
  }
  return priceCache
}

/** Context-window overrides from `windowsJson` (cached by option text; invalid JSON logs once and keeps the built-in table). */
function windowing($: EngineInterface): WindowOverrides | undefined {
  if (winKey === O.windowsJson) return winCache
  winKey = O.windowsJson
  const p = parseWindowsJson(O.windowsJson)
  if (p.ok) winCache = Object.keys(p.overrides.byFamily).length + Object.keys(p.overrides.byId).length > 0 ? p.overrides : undefined
  else {
    winCache = undefined
    try {
      $.ui.log('agents: windowsJson is not valid JSON; using the built-in window table', { to: 'debug' })
    } catch {
      // logging is best effort
    }
  }
  return winCache
}

// ---------------------------------------------------------------------------
// Run table sync from the live agent list (backfill)

async function sync($: EngineInterface): Promise<void> {
  if (syncing) return
  syncing = true
  try {
    const infos = await $.agent.list()
    const at = await $.clock.now()
    lastSync = at
    const byId = new Map(infos.map(a => [a.id, a]))
    await updateRuns($, list => {
      const seen = new Set<string>()
      const next: PetRun[] = list.map(r => {
        const key = r.agentId
        const info = key === undefined ? undefined : byId.get(key)
        if (!info) {
          if (r.status !== 'running' || key === undefined) return r
          const missed = (r.missed ?? 0) + 1
          return missed >= MISSED_TO_DONE ? { ...r, status: 'done', endedAt: at, missed: 0 } : { ...r, missed }
        }
        seen.add(info.id)
        const mapped = mapStatus(info.status)
        if (r.status === 'running') {
          if (mapped === 'running') return r.missed ? { ...r, missed: 0 } : r
          return { ...r, status: mapped, endedAt: at, missed: 0 }
        }
        // Ended on our side (turn.complete): only a teammate that woke again revives.
        if (mapped === 'running' && info.teammateId !== undefined) return { ...r, status: 'running', endedAt: undefined, missed: 0, reviewed: undefined }
        return r
      })
      for (let i = 0; i < next.length; i++) {
        const r = next[i] as PetRun
        const eff = r.agentId === undefined ? undefined : (byId.get(r.agentId) as any)?.effort
        if ((typeof eff === 'string' || typeof eff === 'number') && r.effortSrc !== 'step' && r.effort !== eff) next[i] = { ...r, effort: eff, effortSrc: 'spawn' }
      }
      for (const info of infos) {
        if (seen.has(info.id)) continue
        const status = mapStatus(info.status)
        next.push({
          id: info.id,
          agentId: info.id,
          type: info.type,
          description: info.description,
          model: 'other',
          costume: costumeOf(info.type, info.description),
          status,
          startedAt: at,
          endedAt: status === 'running' ? undefined : at,
          isBackfilled: true,
          files: 0,
          ...(typeof (info as any).effort === 'string' || typeof (info as any).effort === 'number' ? { effort: (info as any).effort, effortSrc: 'spawn' as const } : {}),
        })
      }
      return next.slice(-O.maxRuns)
    })
    await update($, clockA, () => at)
  } catch {
    // Sync is best effort; the next one retries.
  } finally {
    syncing = false
  }
}

// ---------------------------------------------------------------------------
// Panes and commands

async function openPane($: EngineInterface, id: string, title: string): Promise<void> {
  await sync($)
  const at = await $.clock.now()
  await update($, clockA, () => at)
  await $.ui.open({ id, title })
}

/** Opens the pane, or closes it when it is up; true when it ends up open. */
async function togglePane($: EngineInterface, id: string, title: string): Promise<boolean> {
  const isUp = (await $.ui.panes()).some(p => p.id === id)
  if (isUp) {
    await $.ui.close({ id })
    return false
  }
  await openPane($, id, title)
  return true
}

/** Registers `name`, or `agents-<name>` when the host refuses the bare name or the list shows a collision. Quiet if both fail. */
async function registerCmd($: EngineInterface, def: { name: string; description: string; argumentHint?: string }): Promise<string | undefined> {
  let collides = false
  try {
    const list = await $.command.list()
    collides = list.some(c => c.name === def.name && !(c.source === 'plugin' && c.plugin === 'agents'))
  } catch {
    // list is not an oracle; the register attempt decides
  }
  if (!collides) {
    try {
      await $.command.register(def)
      return def.name
    } catch {
      // refused (for example a built-in alias absent from the list): fall back to the prefixed name
    }
  }
  try {
    await $.command.register({ ...def, name: `agents-${def.name}` })
    return `agents-${def.name}`
  } catch {
    return undefined // command unavailable under either name
  }
}

async function markReviewed($: EngineInterface, ids: string[]): Promise<void> {
  const set = new Set(ids)
  await updateRuns($, list => list.map(r => (set.has(r.id) ? { ...r, reviewed: true } : r)))
}

async function runPets($: EngineInterface): Promise<{ text: string }> {
  petsUserRan = true
  const isOpen = await togglePane($, PETS_PANE, PETS_TITLE)
  return { text: isOpen ? 'Agent pets opened.' : 'Agent pets closed.' }
}

async function runReview($: EngineInterface, args: string): Promise<{ text: string }> {
  const s = await snapshot($)
  const queue = queueOf(s.runs, O.includeBackfilled)
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts[0] === 'done') {
    const arg = parts[1]
    if (arg === undefined) return { text: `Usage: /${cmdNames.review} done <id|all>` }
    if (arg === 'all') {
      await markReviewed($, queue.map(r => r.id))
      return { text: `Marked ${queue.length} reviewed.` }
    }
    const r = /^\d+$/.test(arg) ? queue[Number(arg) - 1] : undefined
    if (!r) return { text: `No queue item ${arg}` }
    await markReviewed($, [r.id])
    return { text: `Marked ${arg} reviewed.` }
  }
  return { text: reviewListText(s) }
}

// ---------------------------------------------------------------------------
// Delegation Guard

async function loadMode($: EngineInterface): Promise<'off' | 'warn' | 'deny'> {
  if (modeLoaded) return modeCache
  try {
    const v = (await $.store.get('guard:mode')) as unknown
    const m = typeof v === 'string' ? v : (v as { mode?: string } | undefined)?.mode
    modeCache = m === 'off' || m === 'warn' || m === 'deny' ? m : O.delegationMode
  } catch {
    modeCache = O.delegationMode
  }
  modeLoaded = true
  try {
    await update($, guardA, g => ({ ...g, mode: modeCache }))
  } catch {
    // state is a mirror for the pane
  }
  return modeCache
}

async function setMode($: EngineInterface, m: 'off' | 'warn' | 'deny'): Promise<void> {
  modeCache = m
  modeLoaded = true
  await $.store.set('guard:mode', { v: 1, mode: m })
  await update($, guardA, g => ({ ...g, mode: m }))
}

async function loadNest($: EngineInterface): Promise<'off' | 'warn' | 'deny'> {
  if (nestLoaded) return nestCache
  try {
    const v = (await $.store.get('nesting:mode')) as unknown
    const m = typeof v === 'string' ? v : (v as { mode?: string } | undefined)?.mode
    nestCache = m === 'off' || m === 'warn' || m === 'deny' ? m : O.nestMode
  } catch {
    nestCache = O.nestMode
  }
  nestLoaded = true
  try {
    await update($, guardA, g => ({ ...g, nestMode: nestCache }))
  } catch {
    // state is a mirror for the pane
  }
  return nestCache
}

async function setNest($: EngineInterface, m: 'off' | 'warn' | 'deny'): Promise<void> {
  nestCache = m
  nestLoaded = true
  await $.store.set('nesting:mode', { v: 1, mode: m })
  await update($, guardA, g => ({ ...g, nestMode: m }))
}

type NestCall = { mode: 'warn' | 'deny'; parent: string }

/** Nesting check BEFORE next (F34.2). Returns the deny text, or undefined to let the spawn go on (warn is finished in nestPost). */
async function nestPre($: EngineInterface, e: any, call: Record<string, unknown>): Promise<string | undefined> {
  const mode = await loadNest($)
  if (mode === 'off' || !nests(e, O)) return undefined
  const pid = String(e.parentAgentId)
  const runs = await read($, runsA)
  const pr = runs.find(r => r.agentId === pid)
  const parent = pr ? pr.description : `agent ${pid.slice(0, 8)}`
  const n: NestCall = { mode, parent }
  call.nest = n
  if (mode === 'deny') {
    await recordNested($, e, parent)
    return NEST_DENY
  }
  return undefined
}

async function recordNested($: EngineInterface, e: any, parent: string): Promise<void> {
  const at = await $.clock.now()
  await update($, spendA, (s: Spend) => ({
    ...s,
    nested: [...(s.nested ?? []), { at, description: String(e.description ?? ''), parent }].slice(-50),
    nestedCount: (s.nestedCount ?? 0) + 1,
  }))
}

async function nestPost($: EngineInterface, e: any, started: any, call: Record<string, unknown>): Promise<void> {
  const n = call.nest as NestCall | undefined
  if (!n || n.mode !== 'warn' || started.deny !== undefined) return
  await recordNested($, e, n.parent)
  const at = await $.clock.now()
  if (O.nestToast && (lastNestToastAt === undefined || at - lastNestToastAt >= O.nestGapMs)) {
    lastNestToastAt = at
    const prefix = toastGlyph(await $.session.surfaces())
    $.ui.toast(`${prefix}AGENT · NESTED SPAWN: "${clip(e.description, 50)}" was started by subagent "${clip(n.parent, 50)}". Subagents should return to the orchestrator instead.`)
  }
}

async function runDelegation($: EngineInterface, args: string): Promise<{ text: string }> {
  const arg = args.trim().toLowerCase()
  if (arg === 'nesting' || arg.startsWith('nesting ')) {
    const sub = arg.slice(7).trim()
    if (sub === '') {
      const s = await read($, spendA)
      return { text: `Nesting guard: mode ${await loadNest($)} · nested spawns ${s.nestedCount ?? 0}` }
    }
    if (sub === 'warn' || sub === 'deny' || sub === 'off') {
      await setNest($, sub)
      return { text: `Nesting guard: mode ${sub}.` }
    }
    return { text: 'Usage: /delegation nesting warn|deny|off' }
  }
  if (arg === 'warn' || arg === 'deny' || arg === 'off') {
    await setMode($, arg)
    return { text: `Delegation Guard: mode ${arg}.` }
  }
  if (arg === 'status') {
    const s = await read($, spendA)
    return { text: `Delegation Guard: mode ${await loadMode($)} · violations ${s.violations.length} · explicit model ${s.explicit} of ${s.spawns} · nesting ${await loadNest($)} · nested ${s.nestedCount ?? 0}` }
  }
  const isOpen = await togglePane($, GUARD_PANE, 'Delegation Guard')
  return { text: isOpen ? 'Delegation Guard opened.' : 'Delegation Guard closed.' }
}

type GuardCall = { mode: 'off' | 'warn' | 'deny'; applies: boolean; missing: boolean }

/** Judges BEFORE next (conventions 3.4). Returns the deny text, or undefined to let the spawn go on. */
async function guardPre($: EngineInterface, e: any, call: Record<string, unknown>): Promise<string | undefined> {
  const mode = await loadMode($)
  const applies = judges(e, O)
  const missing = applies && e.model === undefined
  const g: GuardCall = { mode, applies, missing }
  call.guard = g
  if (missing && mode === 'deny') {
    const at = await $.clock.now()
    await update($, spendA, (s: Spend) => ({ ...s, violations: [...s.violations, { at, description: e.description }].slice(-50) }))
    return DENY
  }
  return undefined
}

async function guardPost($: EngineInterface, e: any, started: any, call: Record<string, unknown>): Promise<void> {
  const g = call.guard as GuardCall | undefined
  if (!g || started.deny !== undefined) return
  if (g.applies) await update($, spendA, (s: Spend) => ({ ...s, spawns: s.spawns + 1, explicit: s.explicit + (g.missing ? 0 : 1) }))
  if (g.missing && g.mode === 'warn') {
    const at = await $.clock.now()
    await update($, spendA, (s: Spend) => ({ ...s, violations: [...s.violations, { at, description: e.description }].slice(-50) }))
    // One toast per gap (30 s default): later violations only count.
    if (O.guardToast && (lastToastAt === undefined || at - lastToastAt >= O.guardGapMs)) {
      lastToastAt = at
      const prefix = toastGlyph(await $.session.surfaces())
      $.ui.toast(`${prefix}AGENT · NO MODEL SET: "${clip(e.description, 50)}" started without a model. Add model: haiku or sonnet.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Runaway tracking (F34.3): never stops anything; toast, pet-row mark and band segment only.

async function trackRunaway($: EngineInterface, id: string, usage: any): Promise<void> {
  const ctxTok: number | undefined = usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : undefined
  const at = await $.clock.now()
  let steps = 0
  let ctx = 0
  let fireSteps = false
  let fireCtx = false
  await update($, runawayA, m => {
    const prev = m[id] ?? { steps: 0, ctx: 0 }
    steps = prev.steps + 1
    ctx = ctxTok ?? prev.ctx
    fireSteps = O.runawaySteps > 0 && prev.hitSteps === undefined && steps >= O.runawaySteps
    fireCtx = O.runawayCtx > 0 && prev.hitCtx === undefined && ctx >= O.runawayCtx
    const next = { ...prev, steps, ctx, ...(fireSteps ? { hitSteps: at } : {}), ...(fireCtx ? { hitCtx: at } : {}) }
    const out = { ...m, [id]: next }
    const keys = Object.keys(out)
    if (keys.length > 200) delete out[keys.find(k => k !== id) as string]
    return out
  })
  if (!(fireSteps || fireCtx) || !O.runawayToast) return
  const run = (await read($, runsA)).find(r => r.agentId === id)
  const desc = run ? run.description : `agent ${id.slice(0, 8)}`
  const prefix = toastGlyph(await $.session.surfaces())
  const msg = `${prefix}AGENT RUNAWAY · "${clip(desc, 50)}" · ${steps} steps · ${Math.round(ctx / 1000)}k ctx · consider stopping it`
  if (fireSteps) $.ui.toast(msg)
  if (fireCtx) $.ui.toast(msg)
}

// ---------------------------------------------------------------------------
// Mission Board

async function readBoxes($: EngineInterface, path: string) {
  return boxesOf(await $.fs.read(await resolvePath($, path)))
}

async function mtimeOf($: EngineInterface, path: string): Promise<number | undefined> {
  try {
    const st = (await $.fs.stat(await resolvePath($, path))) as { mtimeMs?: number }
    return st.mtimeMs
  } catch {
    return undefined
  }
}

/** Project root of this session ('' when the host gives neither root nor cwd). */
async function projectRoot($: EngineInterface): Promise<string> {
  try {
    const v = await $.session.root()
    if (typeof v === 'string' && v) return v
  } catch {
    // fall back to cwd
  }
  try {
    const v = await $.session.cwd()
    if (typeof v === 'string' && v) return v
  } catch {
    // no root known
  }
  return ''
}

/** Per-root store key: `mission:plan:<short stable hash of root>`. */
function planKey(root: string): string {
  let h = 5381
  for (let i = 0; i < root.length; i++) h = ((h * 33) ^ root.charCodeAt(i)) >>> 0
  return `mission:plan:${h.toString(36)}`
}

async function loadPlan($: EngineInterface, path: string): Promise<number> {
  const boxes = await readBoxes($, path)
  if (boxes.length === 0) return 0
  await update($, missionSrcA, s => ({ ...s, planName: basename(path), plan: boxes }))
  const at = await $.clock.now()
  await update($, missionA, m => ({ ...m, plan: { path: basename(path), count: boxes.length }, clock: { epoch: at } }))
  return boxes.length
}

async function runMission($: EngineInterface, args: string): Promise<{ text: string }> {
  const s = await snapshot($)
  const v = s.mission.view
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const typical = typicalFn(s.runs, O.typicalTurns)
  const head = parts[0]
  if (head === undefined) {
    const isOpen = await togglePane($, MISSION_PANE, MISSION_TITLE)
    return { text: isOpen ? 'Mission Board opened.' : 'Mission Board closed.' }
  }
  if (head === 'list') {
    await update($, missionA, m => ({ ...m, view: { ...m.view, listView: !m.view.listView } }))
    await recompute($)
    return { text: v.listView ? 'Text list off.' : 'Text list on.' }
  }
  if (head === 'status') {
    const base = v.total ? `plan ${v.counts.done}/${v.total} · ${v.counts.running} running · ${v.pct}%` : 'No plan'
    const run = runLine(s.runs, s.mission.clock, s.at, {}, v.total)
    return { text: run ? `${base}\n${run}` : base }
  }
  if (head === 'plan') {
    const arg = args.trim().slice(4).trim()
    if (arg === 'clear') {
      await update($, missionSrcA, x => ({ ...x, plan: [], planName: undefined }))
      const at = await $.clock.now()
      await update($, missionA, m => ({ ...m, plan: undefined, clock: { epoch: at } }))
      try {
        await $.store.delete(planKey(await projectRoot($)))
      } catch {
        // nothing stored
      }
      await recompute($)
      return { text: 'Plan cleared.' }
    }
    if (!arg) return { text: `Usage: /${cmdNames.mission} plan <path>|clear` }
    let n = 0
    try {
      n = await loadPlan($, arg)
    } catch {
      return { text: 'Plan file missing' }
    }
    if (n === 0) return { text: 'Plan file has no checkboxes' }
    const root = await projectRoot($)
    await $.store.set(planKey(root), { v: 1, path: await resolvePath($, arg), root })
    await recompute($)
    return { text: `Plan ${basename(arg)}: ${n} items.` }
  }
  if (head === 'link') {
    const item = v.items[Number(parts[1]) - 1]
    if (!item) return { text: `No item ${parts[1]}` }
    const r = s.runs[Number(parts[2]) - 1]
    if (!r) return { text: `No run ${parts[2]}` }
    await update($, missionA, m => ({ ...m, links: { ...m.links, [r.id]: item.id } }))
    await recompute($)
    return { text: `Linked item ${parts[1]} to run ${parts[2]}.` }
  }
  if (head === 'unlink') {
    const r = s.runs[Number(parts[1]) - 1]
    if (!r) return { text: `No run ${parts[1]}` }
    if (!(r.id in (s.mission.links ?? {}))) return { text: `Run ${parts[1]} is not linked.` }
    await update($, missionA, m => {
      const links = { ...m.links }
      delete links[r.id]
      return { ...m, links }
    })
    await recompute($)
    return { text: `Unlinked run ${parts[1]}.` }
  }
  if (/^\d+$/.test(head)) {
    const item = v.items[Number(head) - 1]
    if (!item) return { text: `No item ${head}` }
    return { text: detailLines(item, s.runs, s.mission.steps, typical, s.at).join('\n') }
  }
  return { text: `Usage: /${cmdNames.mission} [n|list|plan <path>|plan clear|link <item> <run>|unlink <run>|status]` }
}

/** Observer of OK results: the main thread's checklist, spec discovery, the Bash step fallback. */
async function missionToolPost($: EngineInterface, e: any, ran: any): Promise<void> {
  const tool = String(e.tool)
  const agentId = e.agentId as string | undefined
  if (agentId !== undefined) {
    if (tool !== 'Bash' || O.stepVia !== 'bash' || typeof e.command !== 'string' || !e.command.includes('MISSION_STEP')) return
    const m = /^\s*echo\s+MISSION_STEP\s+(\d+)\/(\d+)\s*(.*)$/.exec(e.command)
    if (!m) return
    const at = await $.clock.now()
    const total = Math.max(1, Number(m[2]))
    const rep: StepReport = { done: Math.min(Number(m[1]), total), total, note: m[3] ? clip(String(m[3]).trim(), 60) : undefined, at, via: 'bash' }
    await update($, missionA, mm => ({ ...mm, steps: { ...mm.steps, [agentId]: rep } }))
    await recompute($)
    return
  }
  if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') {
    await update($, missionSrcA, (s: MissionSrc) => {
      if (tool === 'TodoWrite') {
        const todos = (e.todos ?? []).map((t: any) => ({ ...t, content: clip(String(t.content ?? ''), 60) }))
        return { ...s, checklist: applyChecklist(s.checklist, { tool: 'TodoWrite', todos }) }
      }
      if (tool === 'TaskCreate') return { ...s, checklist: applyChecklist(s.checklist, { tool: 'TaskCreate', subject: clip(String(e.subject ?? ''), 60), activeForm: e.activeForm, resultId: createdId(ran) }) }
      const id = String(e.taskId)
      if (e.status === 'deleted') {
        const gone = s.checklist.items.find(i => i.id === id)
        return { ...s, deleted: gone ? [...s.deleted, norm(gone.content)].slice(-200) : s.deleted, checklist: applyChecklist(s.checklist, { tool: 'TaskUpdate', taskId: id, status: 'deleted' }) }
      }
      return { ...s, checklist: applyChecklist(s.checklist, { tool: 'TaskUpdate', taskId: id, subject: e.subject ? clip(String(e.subject), 60) : undefined, activeForm: e.activeForm, status: e.status }) }
    })
    await recompute($)
  } else if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const path = String(e.file_path ?? e.notebook_path ?? '')
    if (!path || !specMatcher?.(path)) return
    const boxes = await readBoxes($, path)
    if (boxes.length === 0) return
    specPath = path
    const mtime = await mtimeOf($, path)
    await update($, missionSrcA, s => ({ ...s, specName: basename(path), specMtime: mtime, spec: boxes }))
    await recompute($)
  }
}

/** Spec refresh when the file changed (never on a timer). */
async function missionTurnDone($: EngineInterface, e: any): Promise<void> {
  if (e.agentId !== undefined || !specPath) return
  const path = specPath
  const mtime = await mtimeOf($, path)
  const src = await read($, missionSrcA)
  if (mtime !== undefined && mtime !== src.specMtime) {
    const boxes = await readBoxes($, path)
    await update($, missionSrcA, s => ({ ...s, specMtime: mtime, spec: boxes }))
    await recompute($)
  }
}

/** Maps the spawn to a plan item and appends the progress line. Returns the event to pass on (or undefined). */
async function missionPre($: EngineInterface, e: any, call: Record<string, unknown>): Promise<any> {
  const [src, m] = await Promise.all([read($, missionSrcA), read($, missionA)])
  const built = buildItems(src)
  const states: Record<string, MissionState> = {}
  for (const i of m.view.items) states[i.id] = i.state
  const task = built.length ? mapSpawn(built, e.description, e.prompt, states) : undefined
  call.task = task
  const skip = e.fork || e.isTeammate || e.workflow || !O.stepLine || e.prompt.includes(STEP_TOOL) || e.prompt.includes('MISSION_STEP')
  if (skip) return undefined
  const line = (O.stepVia === 'bash' ? LINE_BASH : LINE_TOOL) + (task ? ` [task:${task}]` : '')
  return { ...e, prompt: `${e.prompt}\n${line}` }
}

async function missionPost($: EngineInterface, started: any, call: Record<string, unknown>): Promise<void> {
  const task = call.task as string | undefined
  if (started.deny !== undefined || !started.agentId || !task) return
  const aid = started.agentId as string
  await update($, missionA, m => ({ ...m, links: { ...m.links, [aid]: task } }))
  await recompute($)
}

// ---------------------------------------------------------------------------
// Run table hooks

/** Records the run after the engine started it (the guard and the mission board act before it). */
async function coreSpawnPost($: EngineInterface, e: any, started: any): Promise<void> {
  if (started.deny !== undefined) return
  const at = await $.clock.now()
  const run: PetRun = {
    id: started.agentId ?? `${e.tool_use_id}:${at}`,
    agentId: started.agentId,
    type: e.subagentType,
    description: e.description,
    model: started.model ?? e.model ?? 'other',
    costume: costumeOf(e.subagentType, e.description),
    status: 'running',
    startedAt: at,
    files: 0,
  }
  await updateRuns($, list => [...list.filter(r => r.id !== run.id), run].slice(-O.maxRuns))
  await update($, clockA, () => at)
  // Once per session: the person may close the pane and it stays closed.
  if (O.petsOn && O.autoOpen && (fullscreen === true || petsUserRan) && !(await read($, uiA)).autoOpened) {
    await update($, uiA, p => ({ ...p, autoOpened: true }))
    fireOpen($, PETS_PANE, PETS_TITLE)
  }
}

async function coreTurnDone($: EngineInterface, e: any): Promise<void> {
  const agentId = e.agentId
  if (!agentId) return
  const at = await $.clock.now()
  await updateRuns($, list => list.map(r => (r.agentId === agentId ? { ...r, status: e.reason === 'answer' ? 'done' : 'failed', endedAt: at, missed: 0, reviewed: undefined } : r)))
  await update($, clockA, () => at)
}

/** Subagent files touched and test outcomes (observer of OK results; the result is never changed). */
async function coreToolPost($: EngineInterface, e: any, ran: any): Promise<void> {
  const agentId = e.agentId
  const tool = String(e.tool)
  if (agentId === undefined || !(WRITERS.has(tool) || tool === 'Bash')) return
  if (tool === 'Bash') {
    const cmd = String(e.command ?? '')
    const runner = testRunnerOf(cmd)
    if (runner === undefined) return
    const t = parseTestOutput(runner, outputOf(ran), cmd)
    if (!t.hasSummary) return
    await updateRuns($, list =>
      list.map(r =>
        r.agentId !== agentId
          ? r
          : { ...r, tests: { pass: (r.tests?.pass ?? 0) + t.pass, fail: (r.tests?.fail ?? 0) + t.fail, skip: (r.tests?.skip ?? 0) + t.skip }, lastFail: t.fail > 0 },
      ),
    )
    return
  }
  const path = String(e.file_path ?? e.notebook_path ?? '')
  if (!path) return
  let set = touched.get(agentId)
  if (!set) touched.set(agentId, (set = new Set()))
  if (set.has(path)) return
  set.add(path)
  const n = set.size
  await updateRuns($, list => list.map(r => (r.agentId === agentId ? { ...r, files: n } : r)))
}

/** The optional checklist band (showChecklist): main thread only. */
async function checklistToolPost($: EngineInterface, e: any, ran: any): Promise<void> {
  const tool = String(e.tool)
  if (e.agentId !== undefined || !(tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate')) return
  if (tool === 'TodoWrite') await update($, checklistA, p => applyChecklist(p, { tool: 'TodoWrite', todos: e.todos }))
  else if (tool === 'TaskCreate') await update($, checklistA, p => applyChecklist(p, { tool: 'TaskCreate', subject: clip(String(e.subject ?? ''), 60), activeForm: e.activeForm, resultId: createdId(ran) }))
  else await update($, checklistA, p => applyChecklist(p, { tool: 'TaskUpdate', taskId: String(e.taskId), subject: e.subject, activeForm: e.activeForm, status: e.status }))
}

async function coreStart($: EngineInterface): Promise<void> {
  void sync($)
  // Ticks the running pets' clocks and re-syncs every 3 s; quiet when nothing runs.
  $.clock.every(1000, () => {
    void (async () => {
      try {
        const at = await $.clock.now()
        if (at - lastSync >= SYNC_EVERY_MS) await sync($)
        const list = await read($, runsA)
        if (!list.some(r => r.status === 'running')) return
        await update($, clockA, () => at)
      } catch {
        // A missed tick only delays a clock.
      }
    })()
  })
}

async function startAll($: EngineInterface): Promise<void> {
  const safe = async (f: () => Promise<unknown>): Promise<void> => {
    try {
      await f()
    } catch {
      // A failing start step leaves that mod idle.
    }
  }
  await safe(() => coreStart($))
  if (O.delegationOn) {
    await safe(() => loadMode($))
    await safe(() => loadNest($))
    await safe(() => $.command.register({ name: 'delegation', description: GUARD_DESC, argumentHint: 'warn|deny|off|status|nesting warn|deny|off' }))
  }
  if (O.petsOn) {
    await safe(() => registerCmd($, { name: 'pets', description: 'Show or hide the panel of running agents as costumed pets' }))
  }
  if (O.reviewOn) {
    await safe(async () => {
      const n = await registerCmd($, { name: 'review', description: REVIEW_DESC, argumentHint: 'done <id|all>' })
      if (n) cmdNames.review = n
    })
  }
  if (O.missionOn) {
    await safe(() =>
      $.tool.register({
        name: 'step',
        description: STEP_DESC,
        inputSchema: {
          type: 'object',
          properties: {
            done: { type: 'integer', minimum: 0, description: 'Steps finished' },
            total: { type: 'integer', minimum: 1, description: 'Steps planned' },
            note: { type: 'string', description: 'What you are doing' },
          },
          required: ['done'],
        },
      }),
    )
    await safe(async () => {
      const n = await registerCmd($, { name: 'mission', description: MISSION_DESC, argumentHint: MISSION_HINT })
      if (n) cmdNames.mission = n
    })
    await safe(async () => {
      try {
        await $.store.delete('mission:plan') // legacy global key: never inherited
      } catch {
        // nothing stored
      }
      await update($, missionSrcA, x => ({ ...x, plan: [], planName: undefined }))
      await update($, missionA, m => ({ ...m, plan: undefined }))
      const root = await projectRoot($)
      const key = planKey(root)
      const v = (await $.store.get(key)) as { path?: string; root?: string } | undefined
      if (!v) return
      let ok = false
      if (typeof v.path === 'string' && v.root === root) {
        try {
          ok = (await loadPlan($, v.path)) > 0
        } catch {
          ok = false
        }
      }
      if (!ok) {
        try {
          await $.store.delete(key)
        } catch {
          // already gone
        }
      }
    })
    await safe(() => recompute($))
  }
}

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  O = parseOptions(options as Record<string, unknown> | undefined)
  const opts = O
  lastSync = Number.NEGATIVE_INFINITY
  syncing = false
  priceKey = undefined
  modeCache = opts.delegationMode
  modeLoaded = false
  nestCache = opts.nestMode
  nestLoaded = false
  lastNestToastAt = undefined
  lastToastAt = undefined
  specPath = undefined
  specMatcher = makeMatcher(splitGlobs(opts.specGlobs))
  autoOpened = false
  fullscreen = undefined
  petsUserRan = false
  lastStatus = undefined
  touched.clear()
  const anyOn = opts.petsOn || opts.reviewOn || opts.delegationOn || opts.missionOn
  if (!anyOn) return

  const safe = async (f: () => Promise<unknown>): Promise<void> => {
    try {
      await f()
    } catch {
      // A tracking failure never disturbs the engine.
    }
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startAll($)
    return started
  }).catch(($, e, next) => next(e))

  // A surface attaching clears the no-band status text (F30).
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await refreshStatus($)
    return r
  }).catch(($, e, next) => next(e))

  // Gating (the guard may deny): judged BEFORE next. The .catch re-runs the pure check only. Stage order: guard
  // (outermost), mission rewrite, the engine, then run table, guard counts, mission link.
  on('agent.spawn', async ($, e, next) => {
    let ev: typeof e = e
    const call: Record<string, unknown> = {}
    if (opts.delegationOn) {
      let nestDeny: string | undefined
      try {
        nestDeny = await nestPre($, ev, call)
      } catch {
        // A failing check passes the spawn through.
      }
      if (nestDeny !== undefined) return { deny: nestDeny }
      let deny: string | undefined
      try {
        deny = await guardPre($, ev, call)
      } catch {
        // A failing check passes the spawn through.
      }
      if (deny !== undefined) return { deny }
    }
    if (opts.missionOn) {
      try {
        const rewritten = await missionPre($, ev, call)
        if (rewritten) ev = rewritten
      } catch {
        // The original prompt stands.
      }
    }
    let started: Awaited<ReturnType<typeof next>>
    try {
      started = await next(ev)
    } catch (err) {
      if (ev === e) throw err
      ev = e
      started = await next(ev)
    }
    await safe(() => coreSpawnPost($, ev, started))
    if (opts.delegationOn) await safe(() => nestPost($, ev, started, call))
    if (opts.delegationOn) await safe(() => guardPost($, ev, started, call))
    if (opts.missionOn) await safe(() => missionPost($, started, call))
    return started
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    if (opts.delegationOn && nestCache === 'deny' && nests(e, opts)) return { deny: NEST_DENY }
    const deny = opts.delegationOn && modeCache === 'deny' && judges(e, opts) && e.model === undefined ? DENY : undefined
    return deny !== undefined ? { deny } : next(e)
  })

  // Spend by tier, per-agent figures, model learning, step counts.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      const usage = cleanUsage(r?.usage)
      const id = e.agentId
      let usd = 0
      if (usage) {
        const pc = pricing($)
        usd = stepCostUsd(usage, usage.model ?? e.model, { overrides: pc.overrides })
        const tier = tierOf(usage.model ?? e.model)
        await update($, spendA, (s: Spend) => ({
          ...s,
          byTier: { ...s.byTier, [tier]: s.byTier[tier] + usd },
          main: id ? s.main : s.main + usd,
          subagents: id ? s.subagents + usd : s.subagents,
          steps: s.steps + 1,
        }))
      }
      if (id && opts.delegationOn) await trackRunaway($, id, usage)
      if (id) {
        const ctxTok = usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : undefined
        const allTok = usage ? (ctxTok ?? 0) + usage.output_tokens : 0
        const eff = (e as any).effort
        const effort = typeof eff === 'string' || typeof eff === 'number' ? eff : undefined
        const ov = windowing($)
        await updateRuns($, list =>
          list.map(p =>
            p.agentId !== id
              ? p
              : {
                  ...p,
                  model: e.model && tierOf(p.model) === 'other' ? e.model : p.model,
                  turns: (p.turns ?? 0) + 1,
                  ctx: ctxTok ?? p.ctx,
                  ctxPct: ctxTok !== undefined ? ctxPercent(ctxTok, windowFor(usage?.model ?? e.model ?? p.model, ov)) : p.ctxPct,
                  peak: ctxTok !== undefined ? Math.max(p.peak ?? 0, ctxTok) : p.peak,
                  ...(effort !== undefined ? { effort, effortSrc: 'step' as const } : {}),
                  tokens: usage ? (p.tokens ?? 0) + allTok : p.tokens,
                  usd: usage ? (p.usd ?? 0) + usd : p.usd,
                },
          ),
        )
      }
    } catch {
      // Never disturb the step.
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    await safe(() => coreTurnDone($, e))
    if (opts.missionOn) await safe(() => missionTurnDone($, e))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    try {
      const usd = e.cost?.usd
      if (typeof usd === 'number') await update($, spendA, (s: Spend) => ({ ...s, sessionUsd: usd }))
    } catch {
      // The footnote just lacks the total.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  if (opts.petsOn && opts.showChecklist) {
    // A new prompt after a fully completed list starts a clean slate.
    on('prompt.submit', async ($, e, next) => {
      try {
        const cl = await read($, checklistA)
        if (listAllDone(cl.items)) await update($, checklistA, () => EMPTY_CHECKLIST)
      } catch {
        // Keep the list.
      }
      return next(e)
    }).catch(($, e, next) => next(e))
  }

  // The only call this plugin answers: the mission step tool.
  if (opts.missionOn) {
    on('tool.call', { tool: 'mcp__agents__step' }, async ($, e) => {
      const x = e as any
      const agentId = x.agentId as string | undefined
      if (!agentId) return { result: 'ignored: only subagents report steps' }
      const at = await $.clock.now()
      const done = Math.max(0, Math.floor(Number(x.done) || 0))
      const note = typeof x.note === 'string' ? clip(x.note, 60) : undefined
      await update($, missionA, m => {
        const prev = m.steps[agentId]
        const t = Number(x.total)
        const total = Number.isFinite(t) && t >= 1 ? Math.floor(t) : (prev?.total ?? Math.max(1, done))
        const rep: StepReport = { done: Math.min(done, total), total, note: note ?? prev?.note, at, via: 'own' }
        return { ...m, steps: { ...m.steps, [agentId]: rep } }
      })
      await recompute($)
      return { result: 'ok' }
    }).catch(($, e, next) => next(e))
  }

  // Observer of OK tool results; never changes one.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (isOk(ran)) {
      await safe(() => coreToolPost($, e, ran))
      if (opts.petsOn && opts.showChecklist) await safe(() => checklistToolPost($, e, ran))
      if (opts.missionOn) await safe(() => missionToolPost($, e, ran))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---- commands --------------------------------------------------------------
  if (opts.petsOn) {
    on('command.run', { command: 'pets' }, $ => runPets($))
    on('command.run', { command: 'agents-pets' }, $ => runPets($))
  }
  if (opts.reviewOn) {
    on('command.run', { command: 'review' }, ($, e) => runReview($, e.args))
    on('command.run', { command: 'agents-review' }, ($, e) => runReview($, e.args))
  }
  if (opts.delegationOn) on('command.run', { command: 'delegation' }, ($, e) => runDelegation($, e.args))
  if (opts.missionOn) {
    on('command.run', { command: 'mission' }, ($, e) => runMission($, e.args))
    on('command.run', { command: 'agents-mission' }, ($, e) => runMission($, e.args))
  }

  // ---- panes -------------------------------------------------------------------
  if (opts.petsOn) {
    on('ui.render', { component: 'Pane', requestId: 'pets' }, async ($, e) => {
      seeViewport(e)
      const t = $.ui.resolve(e)
      const s = await snapshot($)
      return petsPane(t, e, s, { onReviewed: id => void markReviewed($, [id]) }) as any
    })
  }
  if (opts.delegationOn) {
    on('ui.render', { component: 'Pane', requestId: 'delegation' }, async ($, e) => {
      seeViewport(e)
      const t = $.ui.resolve(e)
      const s = await snapshot($)
      return delegationPane(t, e, s, pricing($).label) as any
    })
  }
  if (opts.missionOn) {
    on('ui.render', { component: 'Pane', requestId: 'mission' }, async ($, e) => {
      seeViewport(e)
      const t = $.ui.resolve(e)
      const s = await snapshot($)
      return missionPane(t, e, s, {
        select: id => void update($, missionA, m => ({ ...m, view: { ...m.view, selected: id } })),
        setFilter: f => void update($, missionA, m => ({ ...m, view: { ...m.view, filter: m.view.filter === f ? undefined : f } })),
        showList: () => void update($, missionA, m => ({ ...m, view: { ...m.view, listView: true } })),
        reviewed: ids => void markReviewed($, ids),
      }) as any
    })
  }

  // ---- the band above the prompt: one row for the whole plugin ------------------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const inner = await next(e)
    seeViewport(e)
    if (e.props.hasSurvey) return inner
    if (e.props.view?.agentId) return inner
    const s = await snapshot($)
    // Plan start opens the mission pane once (only where panes dock: fullscreen).
    if (!autoOpened && shouldAutoOpen(e, s)) {
      autoOpened = true
      fireOpen($, MISSION_PANE, MISSION_TITLE)
    }
    if (e.props.maxRows < opts.minBandRows) return inner

    const t: any = $.ui.resolve(e)
    const { Button } = t
    const segs: (Segment | null)[] = [
      opts.missionOn ? missionSegment(s) : null,
      opts.petsOn ? checklistSegment(s) : null,
      opts.reviewOn ? reviewSegment(s) : null,
      opts.delegationOn ? guardSegment(s) : null,
      opts.delegationOn ? runawaySegment(s) : null,
    ]
    const buttons: unknown[] = []
    const petsLabel = opts.petsOn ? petsButtonLabel(e.surface, s) : undefined
    if (petsLabel) buttons.push(<Button key="pets" label={petsLabel} plain onPress={() => void openPane($, PETS_PANE, PETS_TITLE)} />)
    const runawayOpen = segs[4] && e.surface !== 'terminal' && opts.petsOn
    if (runawayOpen) buttons.push(<Button key="runaway" label="runaway" plain onPress={() => void openPane($, PETS_PANE, PETS_TITLE)} />)
    if (segs[0] && e.surface !== 'terminal') buttons.push(<Button key="mission" label="plan" plain onPress={() => void openPane($, MISSION_PANE, MISSION_TITLE)} />)
    const cols = Math.max(20, e.props.bodyColumns || 60)
    const row = composeRow(segs, bandWidth(e.props.bodyColumns, buttons.length ? 130 : 16), cols)
    if (!row && buttons.length === 0) return inner

    const line = bandLine(t, e.surface, row, { buttons })
    return bandStack(t, inner, line)
  }).catch(($, e, next) => next(e))
}
