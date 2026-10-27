// Shared runtime for the compact plugin: options, runtime state, cost maths, Coach calculation.
// Spec: specs/compact.md. Pure maths first, then the I/O that reads peers.
import type { PluginOptions, Timer } from 'claude-code'
import type { CoachView, HandoffState, Moment } from '../types'
import { fmtTokens } from './_shared/fmt'
import { parsePricesJson, rowFor } from './_shared/prices'
import { parseWindowsJson } from './_shared/windows'
import type { WindowOverrides } from './_shared/windows'
import { clampEvery, clampFinal, clampPercent, makeNudgeRt } from './mods/nudge'
import type { NudgeRt } from './mods/nudge'
import { makeAlertRt } from './mods/handoffalert'
import type { AlertRt } from './mods/handoffalert'
import type { PriceOverrides, PriceRow } from './_shared/prices'

// ---------------------------------------------------------------------------
// Options

export type Opts = {
  showFrom: number
  target: number
  summaryOut: number
  handoffOut: number
  minSaving: number
  strongAt: number
  idleReturnMin: number
  toast: boolean
  toastGapMin: number
  passHit: boolean
  pricesJson: string
  expiringSec: number
  minBytes: number
  confirmTtlMin: number
  resumeMaxAgeMin: number
  orchDefault: boolean
  minBandRows: number
  nudgeAtPercent: number
  nudgeEvery: number
  nudgeFinalPercent: number
  nudgeDebugLog: boolean
  windowsJson: string
  mods: Record<'coach' | 'handoff' | 'resume' | 'orch' | 'nudge' | 'handoffalert', boolean>
}

// userConfig keys cannot contain dots (validate: "Invalid key in record"), so the manifest spells the spec's
// `coach.showFromTokens` as `coach_showFromTokens`. All three spellings are read: dotted first (an explicit dotted value beats the manifest's underscore default), underscore, camelCase.
const raw = (o: PluginOptions, k: string): unknown => {
  const camel = k.replace(/\.(\w)/g, (_m, c: string) => c.toUpperCase())
  for (const key of [k, k.replace(/\./g, '_'), camel]) if (o[key] !== undefined) return o[key]
  return undefined
}
const num = (o: PluginOptions, k: string, d: number): number => {
  const v = raw(o, k)
  return typeof v === 'number' && isFinite(v) ? v : d
}
const bool = (o: PluginOptions, k: string, d: boolean): boolean => {
  const v = raw(o, k)
  return typeof v === 'boolean' ? v : d
}

export function readOpts(o: PluginOptions | undefined): Opts {
  const x: PluginOptions = o ?? {}
  return {
    showFrom: num(x, 'coach.showFromTokens', 100_000),
    target: num(x, 'coach.targetTokens', 40_000),
    summaryOut: num(x, 'coach.summaryOutTokens', 4000),
    handoffOut: num(x, 'coach.handoffOutTokens', 3000),
    minSaving: num(x, 'coach.minSavingUsd', 0.02),
    strongAt: num(x, 'coach.strongAt', 5),
    idleReturnMin: num(x, 'coach.idleReturnMin', 10),
    toast: bool(x, 'coach.toast', true),
    toastGapMin: num(x, 'coach.toastMinGapMin', 20),
    passHit: bool(x, 'coach.passAssumesCacheHit', true),
    pricesJson: typeof x.pricesJson === 'string' ? x.pricesJson : '',
    expiringSec: num(x, 'cache.expiringSec', 300),
    minBytes: num(x, 'handoff.minBytes', 800),
    confirmTtlMin: num(x, 'handoff.confirmTtlMin', 30),
    resumeMaxAgeMin: num(x, 'handoff.resumeMaxAgeMin', 240),
    orchDefault: bool(x, 'orch.enabled', true),
    minBandRows: num(x, 'minBandRows', 4),
    nudgeAtPercent: clampPercent(num(x, 'nudge.atPercent', 75)),
    nudgeEvery: clampEvery(num(x, 'nudge.everyTokens', 25_000)),
    nudgeFinalPercent: clampFinal(num(x, 'nudge.finalPercent', 90)),
    nudgeDebugLog: bool(x, 'nudge.debugLog', true),
    windowsJson: typeof x.windowsJson === 'string' ? x.windowsJson : '',
    mods: {
      coach: bool(x, 'mod.coach.enabled', true),
      handoff: bool(x, 'mod.handoff.enabled', true),
      resume: bool(x, 'mod.resume.enabled', true),
      orch: bool(x, 'mod.orch.enabled', true),
      nudge: bool(x, 'mod.nudge.enabled', true),
      handoffalert: bool(x, 'mod.handoffalert.enabled', true),
    },
  }
}

// ---------------------------------------------------------------------------
// Runtime state (closure per register(); hot reload loses it, atoms and store survive)

export type AgentLite = { id: string; description: string; status: string }

export type HandoffRt = {
  state: HandoffState
  path?: string
  /** Path shown in the chip: relative to the repo when inside it. */
  rel?: string
  readyAt?: number
  failures: number
  missing?: string[]
  before?: number
  after?: number
  doneAt?: number
  reason?: string
  /** Extra line on a `ready` handoff: why the last `go` did not compact. */
  note?: string
  noCompact: boolean
  /** Bumped on cancel/clear so a late turn.complete cannot revive an abandoned handoff. */
  epoch: number
  usedPaths: Set<string>
  awaitAfter: boolean
}

export type Rt = {
  sid?: string
  ctx?: number
  model?: string
  /** Tokens in the non-Messages categories (from the breakdown), when measured. */
  overhead?: number
  agents: AgentLite[]
  lastPromptAt?: number
  lastCompleteAt?: number
  lastEvalAt?: number
  returned: boolean
  handoff: HandoffRt
  orchOn?: boolean
  orchLoaded: boolean
  toastArmed: boolean
  lastShownAt?: number
  /** Toast bookkeeping: an offer held back by a peer toast or quiet period. */
  toastQueued?: string
  toastQueuedPriority?: number
  timer?: Timer
  flushTimer?: Timer
  /** A /handoff prompt waiting to be submitted from a later dispatch. */
  outbox?: string
  outboxTimer?: Timer
  compactTimer?: Timer
  hasBand: boolean
  headless: boolean
  cmd: Record<'handoff' | 'coach' | 'orch', string>
  overrides?: PriceOverrides
  pricesBad: boolean
  pricesLogged: boolean
  nudge: NudgeRt
  alert: AlertRt
  winOverrides?: WindowOverrides
  winBad: boolean
  winLogged: boolean
  missingLogged: boolean
  statusSet: boolean
}

export const freshHandoff = (): HandoffRt => ({ state: 'idle', failures: 0, noCompact: false, epoch: 0, usedPaths: new Set(), awaitAfter: false })

export function makeRt(opts: Opts): Rt {
  const p = parsePricesJson(opts.pricesJson)
  const w = parseWindowsJson(opts.windowsJson)
  return {
    agents: [],
    returned: false,
    handoff: freshHandoff(),
    orchLoaded: false,
    toastArmed: true,
    hasBand: true,
    headless: false,
    cmd: { handoff: 'handoff', coach: 'coach', orch: 'orch' },
    overrides: p.ok ? p.overrides : undefined,
    pricesBad: !p.ok,
    pricesLogged: false,
    nudge: makeNudgeRt(),
    alert: makeAlertRt(),
    winOverrides: w.ok ? w.overrides : undefined,
    winBad: !w.ok,
    winLogged: false,
    missingLogged: false,
    statusSet: false,
  }
}

export type Ctx = { rt: Rt; opts: Opts }

export type CommandDef = {
  name: 'handoff' | 'coach' | 'orch'
  description: string
  argumentHint?: string
}

export const COMMANDS: CommandDef[] = [
  { name: 'handoff', description: 'Write a handoff file, then compact', argumentHint: '[--no-compact] [slug] | go | cancel | retry' },
  { name: 'coach', description: 'Show the compaction cost card' },
  { name: 'orch', description: 'Orchestrator mode on/off/status', argumentHint: 'on|off|status [--yes]' },
]

// ---------------------------------------------------------------------------
// Formatting helpers

/** Two-decimal dollars: `$0.07`, `$0.01` (0.008 rounds up), `$2.80`. */
export const usd2 = (n: number): string => `$${n.toFixed(2)}`

/** Terminal cell width of a string: emoji and wide symbols count 2. */
export function cellWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    w += c >= 0x1f000 || c === 0x2705 || c === 0x2614 || c === 0x26d4 ? 2 : 1
  }
  return w
}

// ---------------------------------------------------------------------------
// Cost maths (spec s5). Prices are USD per MTok, tokens are plain counts.

export type Costs = {
  row: PriceRow
  isDefault: boolean
  isCustom: boolean
  /** Context now and target. */
  C: number
  Cp: number
  Tw: number
  Tc: number
  Twp: number
  Tcp: number
  /** Saving per warm turn / per cold turn. */
  save: number
  saveCold: number
  passWarm: number
  passCold: number
  handoffWarm: number
  handoffCold: number
}

export function costs(model: string | undefined, C: number, Cp: number, o: { overrides?: PriceOverrides; summaryOut: number; handoffOut: number; passHit: boolean }): Costs {
  const r = rowFor(model, { overrides: o.overrides, promptTokens: C })
  const { cacheRead: R, write1h: W1, write5m: W5, output: O } = r.row
  const M = 1e6
  const Tw = (C * R) / M
  const Tc = (C * W1) / M
  const Twp = (Cp * R) / M
  const Tcp = (Cp * W1) / M
  const tail = (o.summaryOut * O) / M + (Cp * W1) / M
  const passWarm = (o.passHit ? (C * R) / M : (C * W5) / M) + tail
  const passCold = (C * W5) / M + tail
  return {
    row: r.row,
    isDefault: r.isDefault,
    isCustom: r.isCustom,
    C,
    Cp,
    Tw,
    Tc,
    Twp,
    Tcp,
    save: Tw - Twp,
    saveCold: Tc - Tcp,
    passWarm,
    passCold,
    handoffWarm: Tw + (o.handoffOut * O) / M,
    handoffCold: Tc + (o.handoffOut * O) / M,
  }
}

/** Smallest n >= 1 with baseline(n) >= P + Twp*(n-1); undefined when the saving never repays it. */
export function paybackTurns(c: Costs, passTotal: number, cold: boolean): number | undefined {
  for (let n = 1; n <= 2000; n++) {
    const baseline = cold ? c.Tc + c.Tw * (n - 1) : c.Tw * n
    const compacted = passTotal + c.Twp * (n - 1)
    if (baseline + 1e-12 >= compacted) return n
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Coach calculation

export type Calc = {
  hasCtx: boolean
  ctx?: number
  model?: string
  cost?: Costs
  target: number
  floor?: number
  floorWon: boolean
  cacheState: 'unknown' | 'warm' | 'expiring' | 'cold'
  cold: boolean
  agentsRunning: number
  score: number
  points: { label: string; pts: number }[]
  verdict: Moment
  gate?: string
  /** Pass cost for the current cache state, /compact path and /handoff + compact path. */
  passUsd?: number
  passHandoffUsd?: number
  payback?: number
  paybackHandoff?: number
  reasonText: string
}

export const RUNNING = new Set(['pending', 'running', 'waiting'])

export type CalcInputs = {
  now: number
  ctx?: number
  model?: string
  overhead?: number
  cache?: { state?: string; expiresAt?: number }
  aw?: { phase?: string; isComplete?: boolean; specTotal?: number; specDone?: number }
  missionAllDone?: boolean
  agents: AgentLite[]
  returned: boolean
  handoffState: HandoffState
  opts: Opts
  overrides?: PriceOverrides
}

/** Pure Coach calculation: costs, moment score, gates, payback. Inputs are read by register.tsx. */
export function buildCalc(i: CalcInputs): Calc {
  const { opts } = i
  const agentsRunning = i.agents.filter(a => RUNNING.has(a.status)).length
  const C = i.ctx
  const hasCtx = typeof C === 'number' && C > 0
  let floor: number | undefined
  let target = opts.target
  let floorWon = false
  if (i.overhead != null) {
    floor = i.overhead + opts.summaryOut
    if (floor > target) {
      target = floor
      floorWon = true
    }
  }
  const cost = hasCtx ? costs(i.model, C as number, target, { overrides: i.overrides, summaryOut: opts.summaryOut, handoffOut: opts.handoffOut, passHit: opts.passHit }) : undefined

  const points: { label: string; pts: number }[] = []
  let cacheState: Calc['cacheState'] = 'unknown'
  const cs = i.cache?.state
  if (cs === 'warm' || cs === 'expiring' || cs === 'cold') cacheState = cs
  const expiresSoon = cacheState === 'warm' && typeof i.cache?.expiresAt === 'number' && i.cache.expiresAt - i.now <= opts.expiringSec * 1000
  if (cacheState === 'cold') points.push({ label: 'cache cold', pts: 3 })
  else if (cacheState === 'expiring' || expiresSoon) points.push({ label: 'cache expiring', pts: 3 })
  const aw = i.aw
  const phaseDone = !!aw && (aw.phase === 'report' || aw.isComplete === true || ((aw.specTotal ?? 0) > 0 && aw.specDone === aw.specTotal))
  if (phaseDone || i.missionAllDone === true) points.push({ label: 'phase finished', pts: 2 })
  if (agentsRunning === 0) points.push({ label: 'no agents', pts: 2 })
  else points.push({ label: 'agents running', pts: 0 })
  if (i.returned) points.push({ label: 'back from idle', pts: 1 })
  const score = points.reduce((n, p) => n + p.pts, 0)

  let verdict: Moment = score >= opts.strongAt ? 'good' : score >= 3 ? 'ok' : 'notnow'
  let gate: string | undefined
  if (!hasCtx || (C as number) < opts.showFrom) gate = `below ${fmtTokens(opts.showFrom)}`
  else if (cost && cost.save < opts.minSaving) gate = `saving < ${usd2(opts.minSaving)} min`
  else if (i.handoffState === 'compacting') gate = 'compacting'
  if (gate) verdict = 'notnow'

  const cold = cacheState === 'cold'
  let passUsd: number | undefined
  let passHandoffUsd: number | undefined
  let payback: number | undefined
  let paybackHandoff: number | undefined
  if (cost) {
    passUsd = cold ? cost.passCold : cost.passWarm
    passHandoffUsd = (cold ? cost.handoffCold : cost.handoffWarm) + cost.passWarm
    payback = paybackTurns(cost, passUsd, cold)
    paybackHandoff = paybackTurns(cost, passHandoffUsd, cold)
  }

  const cacheText = cacheState === 'cold' ? '💤 cold' : cacheState === 'warm' ? (expiresSoon ? '🍅 expiring' : '🍅 warm') : cacheState === 'expiring' ? '🍅 expiring' : 'cache ?'
  const reasonText = `${cacheText} · ${agentsRunning > 0 ? 'agents running' : 'no agents'}`

  return { hasCtx, ctx: C, model: i.model, cost, target, floor, floorWon, cacheState, cold, agentsRunning, score, points, verdict, gate, passUsd, passHandoffUsd, payback, paybackHandoff, reasonText }
}

export function toView(c: Calc, rt: Rt): CoachView {
  return {
    ctx: c.ctx,
    model: c.model,
    warmUsd: c.cost?.Tw,
    coldUsd: c.cost?.Tc,
    targetTokens: c.target,
    afterWarmUsd: c.cost?.Twp,
    saveWarmUsd: c.cost?.save,
    passUsd: c.passUsd,
    paybackTurns: c.payback,
    score: c.score,
    verdict: c.verdict,
    reasons: [...(c.gate ? [c.gate] : []), ...c.points.map(p => (p.pts > 0 ? `${p.label} +${p.pts}` : p.label))],
    floorWon: c.floorWon,
    lastShownAt: rt.lastShownAt,
  }
}

/** Handoff state as the chip should show it now: an expired `ready` or an old `done` counts as idle. */
export function effState(rt: Rt, opts: Opts, now: number): HandoffState {
  const h = rt.handoff
  if (h.state === 'ready' && h.readyAt != null && now - h.readyAt > opts.confirmTtlMin * 60_000) return 'idle'
  if (h.state === 'done' && h.doneAt != null && now - h.doneAt > 10 * 60_000) return 'idle'
  return h.state
}
