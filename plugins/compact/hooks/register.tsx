// compact plugin: Compact Coach, /handoff, Resume loader, Orchestrator mode. Spec: specs/compact.md.
// Tokens spent by the plugin: zero, except the Orchestrator section (~100, default on), the one-shot resume
// entry, and the prompt /handoff sends on purpose. `$.session.compact` is called from `/handoff go` only.
//
// Shape forced by `claude plugin validate`: one hook per event for the whole plugin; hooks are function
// literals; and `$` is only followed into functions declared in THIS file, never across an import. So every
// `$` call lives here, as top-level function declarations; the other files hold pure code (options, cost
// maths, scoring, text and SVG builders). The mods are sections of this file: Coach, Handoff, Resume, Orch.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { META_STEP } from './mods/nudge'
import { renderBand } from './_shared/band'
import type { Segment } from './_shared/band'
import { run } from './_shared/proc'
import type { ProcPorts } from './_shared/proc'
import { toastText, toastWaitMs } from './_shared/toast'
import type { PeerName } from './_shared/toast'
import { localDate, fmtTokens } from './_shared/fmt'
import { COMMANDS, RUNNING, buildCalc, effState, makeRt, readOpts, toView, usd2 } from './core'
import type { AgentLite, Calc, Ctx } from './core'
import { ORCH_ID, ORCH_TEXT, coldTurnFigure, statusText as orchStatus } from './mods/orch'
import { cardText, coachSegment, statusText as coachStatus } from './mods/coach'
import { buildPrompt, compactInstructions, kebab, missingHeadings, parseArgs } from './mods/handoff'
import { resumeEntry } from './mods/resume'
import { alertSegment, cardLine, clearedBody, degradedPath, parseAlert, reasonTexts, shownKey, statusPrefix, toastLine } from './mods/handoffalert'
import { agentResumeEntry, handoffsDir, buildMeta, highestK, isFresh, isStaleSections, metaPathFor, agentPathFor, nudgeLine, nudgeText, parseEnvWindow, sectionHashes, STALE_TARGETS, threshold } from './mods/nudge'
import type { AgentFresh } from './mods/nudge'
import { windowFor } from './_shared/windows'
import { ORCH_KEY, TOAST_KEY, isLast, lastKey, pendingKey } from './store'
import type { LastHandoff, Pending } from './store'
import type { CoachView, HandoffHealthView, HandoffState, NudgeView } from '../types'

export { isFresh }

// Atoms (the state library reads their literal refs from this file; render hooks subscribe to them).
const emptyCoach: CoachView = { targetTokens: 40_000, score: 0, verdict: 'notnow', reasons: [], floorWon: false }
const coachAtom = atom({ plugin: 'compact', key: 'coach' } as const, emptyCoach)
const handoffAtom = atom({ plugin: 'compact', key: 'handoff' } as const, { state: 'idle' as HandoffState, failures: 0 })
const orchAtom = atom({ plugin: 'compact', key: 'orch' } as const, { on: true })
const resumeAtom = atom({ plugin: 'compact', key: 'resume' } as const, { pending: false })
const nudgeAtom = atom({ plugin: 'compact', key: 'nudge' } as const, { armed: false, lastK: -1, fresh: 'none' } as NudgeView)
const handoffHealthAtom = atom({ plugin: 'compact', key: 'handoffHealth' } as const, { degraded: false, reasons: [] as string[] } as HandoffHealthView)
const clockAtom = atom({ plugin: 'compact', key: 'clock' } as const, 0)
/** Agent list for the band render, which must not call `$.agent` (conventions s3.1a); refreshed on agent events and steps. */
const agentsAtom = atom({ plugin: 'compact', key: 'agents' } as const, [] as { id: string; description: string; status: string }[])

/** Runs an observer and swallows its failure: observers never break the event chain (conventions s3.2). */
async function safe(f: () => Promise<unknown>): Promise<void> {
  try {
    await f()
  } catch {
    // observer only
  }
}

const errText = (err: unknown): string => String((err as Error | undefined)?.message ?? err).slice(0, 160)

// ---------------------------------------------------------------------------
// Shared plumbing

/** Ports of the shared proc kit, built from `$` here (conventions s8: never throws, `ok` means the command ran). */
const procPorts = ($: EngineInterface): ProcPorts => ({ run: (argv, init) => $.process.run(argv, init), now: () => $.clock.now() })

async function sessionId($: EngineInterface): Promise<string> {
  try {
    return (await $.session.id()) || 'session'
  } catch {
    return 'session'
  }
}

async function listAgents($: EngineInterface, ctx: Ctx): Promise<AgentLite[]> {
  try {
    const l = await $.agent.list()
    ctx.rt.agents = l.map(a => ({ id: a.id, description: a.description, status: a.status }))
    const prev = await read($, agentsAtom)
    if (JSON.stringify(prev) !== JSON.stringify(ctx.rt.agents)) await update($, agentsAtom, () => ctx.rt.agents)
  } catch {
    // keep the last list
  }
  return ctx.rt.agents
}

/** Writes the atoms the render hooks subscribe to (render never writes). */
async function publish($: EngineInterface, ctx: Ctx, calc?: Calc): Promise<void> {
  const { rt } = ctx
  const now = await $.clock.now()
  const h = rt.handoff
  await update($, handoffAtom, () => ({ state: h.state, path: h.path, readyAt: h.readyAt, failures: h.failures, missing: h.missing, before: h.before, after: h.after, doneAt: h.doneAt, reason: h.reason ?? h.note, noCompact: h.noCompact }))
  await update($, orchAtom, () => ({ on: rt.orchOn ?? true }))
  if (calc) await update($, coachAtom, () => toView(calc, rt))
  await update($, clockAtom, () => now)
}

// ---------------------------------------------------------------------------
// Coach

async function calcNow($: EngineInterface, ctx: Ctx, render = false): Promise<Calc> {
  const { rt, opts } = ctx
  const now = await $.clock.now()
  let cache: { state?: string; expiresAt?: number } | undefined
  let aw: { phase?: string; isComplete?: boolean; specTotal?: number; specDone?: number } | undefined
  let allDone: boolean | undefined
  try {
    cache = (await $.state.get({ plugin: 'usage', key: 'cache' } as const)).value
  } catch {
    cache = undefined
  }
  try {
    aw = (await $.state.get({ plugin: 'awareness', key: 'now' } as const)).value
  } catch {
    aw = undefined
  }
  try {
    allDone = (await $.state.get({ plugin: 'agents', key: 'mission' } as const)).value?.allDone
  } catch {
    allDone = undefined
  }
  const agents = render ? await read($, agentsAtom) : await listAgents($, ctx)
  return buildCalc({ now, ctx: rt.ctx, model: rt.model, overhead: rt.overhead, cache, aw, missionAllDone: allDone, agents, returned: rt.returned, handoffState: rt.handoff.state, opts, overrides: rt.overrides })
}

function ensureTimer($: EngineInterface, ctx: Ctx, show: boolean): void {
  const { rt } = ctx
  if (show && !rt.timer) rt.timer = $.clock.every(30_000, () => void refreshCoach($, ctx))
  else if (!show && rt.timer) {
    rt.timer.cancel()
    rt.timer = undefined
  }
}

/** Idle return (+1): a turn starting after a gap >= coach.idleReturnMin since the last prompt or turn end. */
async function evalReturn($: EngineInterface, ctx: Ctx, via: 'prompt' | 'turn'): Promise<void> {
  const { rt, opts } = ctx
  if (!opts.mods.coach) return
  const now = await $.clock.now()
  if (via !== 'prompt' && rt.lastEvalAt != null && now - rt.lastEvalAt < 10_000) return
  const ref = Math.max(rt.lastPromptAt ?? -Infinity, rt.lastCompleteAt ?? -Infinity)
  rt.returned = Number.isFinite(ref) && now - ref >= opts.idleReturnMin * 60_000
  rt.lastEvalAt = now
  rt.lastPromptAt = now
}

/** ms until a Coach toast may show (0 = now, Infinity = quiet): own gap plus the peer convention (conventions s7.5). */
async function toastWait($: EngineInterface, ctx: Ctx, now: number): Promise<number> {
  return toastWaitMs(
    { readPeer: name => peerValue($, name) },
    { now, lastShownAt: ctx.rt.lastShownAt, minGapMs: 60_000, peers: ['awareness.headsup', 'dev.toast'], respectQuiet: true },
  )
}

/** Peer slices by name; the refs are literals here (validate needs them in register.tsx). */
async function peerValue($: EngineInterface, name: PeerName): Promise<any> {
  switch (name) {
    case 'awareness.focus': return (await $.state.get({ plugin: 'awareness', key: 'focus' } as const)).value
    case 'awareness.headsup': return (await $.state.get({ plugin: 'awareness', key: 'headsup' } as const)).value
    case 'dev.toast': return (await $.state.get({ plugin: 'dev', key: 'toast' } as const)).value
    case 'compact.coach': return (await $.state.get({ plugin: 'compact', key: 'coach' } as const)).value
  }
}

async function showToast($: EngineInterface, ctx: Ctx, text: string, now: number): Promise<void> {
  $.ui.toast(text)
  ctx.rt.lastShownAt = now
  ctx.rt.toastQueued = undefined
  await $.store.set(TOAST_KEY, { v: 1, lastShownAt: now })
}

function holdToast($: EngineInterface, ctx: Ctx, text: string, waitMs: number): void {
  const { rt } = ctx
  rt.toastQueued = text
  if (Number.isFinite(waitMs)) {
    rt.flushTimer?.cancel()
    rt.flushTimer = $.clock.after(waitMs + 50, () => void refreshCoach($, ctx))
  }
}

/** One toast per strong episode (spec s1): armed until shown, re-armed when the score falls below 3 or after a compaction. */
async function offerToast($: EngineInterface, ctx: Ctx, c: Calc, now: number): Promise<void> {
  const { rt, opts } = ctx
  if (c.score < 3) rt.toastArmed = true
  const hs = rt.handoff.state
  const busy = hs === 'writing' || hs === 'ready' || hs === 'compacting'
  if (!opts.mods.coach || !opts.toast || c.verdict !== 'good' || busy || !c.cost) {
    if (c.verdict !== 'good') rt.toastQueued = undefined
    return
  }
  if (rt.toastQueued) {
    const w = await toastWait($, ctx, now)
    if (w === 0) await showToast($, ctx, rt.toastQueued, now)
    else holdToast($, ctx, rt.toastQueued, w)
    return
  }
  if (!rt.toastArmed) return
  rt.toastArmed = false
  if (rt.lastShownAt != null && now - rt.lastShownAt < opts.toastGapMin * 60_000) return
  const text = toastText('COMPACT', `good moment at ${fmtTokens(c.ctx ?? 0)}. Saves ~${usd2(c.cost.save)}/turn.`, 'Run /handoff.')
  const w = await toastWait($, ctx, now)
  if (w === 0) await showToast($, ctx, text, now)
  else holdToast($, ctx, text, w)
}

/** Recompute the Coach view, maybe toast, publish atoms, keep the 30 s timer and the status fallback right. */
async function refreshCoach($: EngineInterface, ctx: Ctx): Promise<void> {
  const { rt, opts } = ctx
  try {
    const now = await $.clock.now()
    const c = await calcNow($, ctx)
    await offerToast($, ctx, c, now)
    await publish($, ctx, c)
    const shows = opts.mods.coach && ((c.hasCtx && (c.ctx as number) >= opts.showFrom) || effState(rt, opts, now) !== 'idle')
    ensureTimer($, ctx, shows)
    if (opts.mods.coach || opts.mods.handoffalert) {
      let noBand = rt.headless
      if (!noBand) {
        try {
          const s = await $.session.surfaces()
          noBand = Array.isArray(s) && s.length === 0
        } catch {
          noBand = !rt.hasBand
        }
      }
      rt.hasBand = !noBand
      const base = opts.mods.coach ? coachStatus(c, rt, opts, now) : undefined
      const pre = opts.mods.handoffalert && rt.alert.active ? statusPrefix(reasonTexts(rt.alert.reasons)) : undefined
      const t = noBand ? (pre ? (base ? `${pre} · ${base}` : pre) : base) : undefined
      if (t || rt.statusSet) $.ui.status(t)
      rt.statusSet = !!t
    }
  } catch (err) {
    $.ui.log(`compact coach: ${errText(err)}`, { to: 'debug' })
  }
}

async function coachOnStep($: EngineInterface, e: { agentId?: string; model: string; index: number }, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.coach || e.agentId) return
  if (e.model) ctx.rt.model = e.model
  if (e.index === 0) await evalReturn($, ctx, 'turn')
}

async function coachOnMeasure($: EngineInterface, e: { context?: { tokens?: number } }, ctx: Ctx): Promise<void> {
  const { rt, opts } = ctx
  const t = e.context?.tokens
  if (typeof t === 'number') rt.ctx = t
  if (rt.handoff.awaitAfter && typeof t === 'number') {
    rt.handoff.after = t
    rt.handoff.awaitAfter = false
  }
  if ((rt.ctx ?? 0) >= opts.showFrom) {
    try {
      const u = await $.session.usage({ breakdown: 'summary' })
      const cats = u.context.breakdown?.categories
      rt.overhead = cats
        ? cats.filter(x => x.kind !== 'free' && x.kind !== 'buffer' && x.kind !== 'deferred' && !/^(messages|free space|autocompact)/i.test(x.name)).reduce((n, x) => n + x.tokens, 0)
        : undefined
    } catch {
      // keep the last overhead
    }
  }
  await refreshCoach($, ctx)
}

async function coachOnComplete($: EngineInterface, e: { agentId?: string }, ctx: Ctx): Promise<void> {
  if (!e.agentId) ctx.rt.lastCompleteAt = await $.clock.now()
  await refreshCoach($, ctx)
}

async function coachOnCompact($: EngineInterface, e: { agentId?: string; trigger: string }, r: { skip?: string; tokensAfter?: number }, ctx: Ctx): Promise<void> {
  const { rt } = ctx
  if (e.agentId || e.trigger === 'precompute' || r.skip !== undefined) return
  rt.toastArmed = true
  rt.returned = false
  if (typeof r.tokensAfter === 'number') rt.ctx = r.tokensAfter
  await refreshCoach($, ctx)
}

async function coachOnEnd($: EngineInterface, e: { reason: string }, ctx: Ctx): Promise<void> {
  const { rt } = ctx
  if (e.reason !== 'clear') return
  rt.ctx = undefined
  rt.overhead = undefined
  rt.toastArmed = true
  rt.returned = false
  rt.toastQueued = undefined
  if (rt.statusSet) $.ui.status(undefined)
  rt.statusSet = false
}

async function coachCommand($: EngineInterface, ctx: Ctx): Promise<{ text: string }> {
  let card = cardText(await calcNow($, ctx), ctx)
  if (ctx.opts.mods.handoffalert) card = `${card}\n${cardLine(ctx.rt.alert.active, reasonTexts(ctx.rt.alert.reasons))}`
  if (!ctx.opts.mods.nudge) return { text: card }
  let line = ''
  try {
    line = await nudgeCardLine($, ctx)
  } catch {
    line = ''
  }
  return { text: line ? `${card}\n${line}` : card }
}

// ---------------------------------------------------------------------------
// Handoff

async function repoRoot($: EngineInterface, cwd: string): Promise<string | undefined> {
  const r = await run(procPorts($), ['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
  if (r.ok) {
    const t = r.stdout.trim()
    return r.exitCode === 0 && t ? t : undefined
  }
  // The command could not run at all: walk up looking for .git.
  let dir = cwd
  for (let i = 0; i < 40 && dir; i++) {
    try {
      if (await $.fs.exists(`${dir.replace(/\/$/, '')}/.git`)) return dir
    } catch {
      return undefined
    }
    const up = dir.replace(/\/[^/]*$/, '')
    if (up === dir || up === '') break
    dir = up
  }
  return undefined
}

async function homeDir($: EngineInterface, cwd: string): Promise<string> {
  const r = await run(procPorts($), ['printenv', 'HOME'], { cwd, timeoutMs: 5000 })
  const t = r.ok && r.exitCode === 0 ? r.stdout.trim() : ''
  if (t) return t
  try {
    const e = await $.env.get('HOME')
    if (e) return e
  } catch {
    // fall through
  }
  return cwd
}

/** `<repo>/handoff/<date>-<slug>.md`, else `~/.local/state/claude-handoffs/...`; a taken name gets `-2`, `-3`. */
async function resolvePath($: EngineInterface, ctx: Ctx, slugIn: string, now: number): Promise<{ path: string; rel: string; root?: string }> {
  const cwd = await $.session.cwd()
  const root = await repoRoot($, cwd)
  const base = root ? `${root.replace(/\/$/, '')}/handoff` : handoffsDir(await homeDir($, cwd))
  const stem = `${localDate(now)}-${kebab(slugIn) || 'session'}`
  let path = `${base}/${stem}.md`
  for (let n = 2; n < 200; n++) {
    let taken = ctx.rt.handoff.usedPaths.has(path)
    if (!taken) {
      try {
        taken = await $.fs.exists(path)
      } catch {
        taken = false
      }
    }
    if (!taken) break
    path = `${base}/${stem}-${n}.md`
  }
  return { path, rel: root ? path.slice(root.replace(/\/$/, '').length + 1) : path, root }
}

function sayTo($: EngineInterface, text: string): void {
  try {
    $.ui.log(text)
  } catch {
    // log only
  }
  try {
    $.ui.notice('compact-handoff', text)
  } catch {
    // no open dialog to attach to
  }
}

/** The host refuses `$.prompt.submit` / `$.session.compact` while the calling chain descends from a `command.run`
 * dispatch that has not returned (host check). Only that rejection is retried. */
const HOLD_TRIES = 5
const HOLD_WAIT_MS = 250
const isHostHold = (err: unknown): boolean => {
  const m = errText(err)
  return m.includes('(host check)') && /command\.run|turn\.complete/.test(m)
}

/** `$.prompt.submit` is refused from a command.run hook (host check), so /handoff queues the prompt and a timer
 * submits it from its own dispatch (resolves when the turn starts, spec s2). Call it as the LAST statement of the command. */
function queueSubmit($: EngineInterface, ctx: Ctx, text: string): void {
  ctx.rt.outbox = text
  ctx.rt.outboxTimer?.cancel()
  ctx.rt.outboxTimer = $.clock.after(0, () => void flushOutbox($, ctx, 1))
}

async function flushOutbox($: EngineInterface, ctx: Ctx, tryNo: number): Promise<void> {
  const text = ctx.rt.outbox
  if (!text) return
  try {
    await $.prompt.submit({ text })
    ctx.rt.outbox = undefined
  } catch (err) {
    if (isHostHold(err) && tryNo < HOLD_TRIES) {
      ctx.rt.outboxTimer = $.clock.after(HOLD_WAIT_MS, () => void flushOutbox($, ctx, tryNo + 1))
      return
    }
    ctx.rt.outbox = undefined
    // The host refused the submit too: say so and let the user retry.
    const h = ctx.rt.handoff
    h.failures++
    h.state = 'failed'
    h.reason = h.failures >= 3 ? `prompt not sent (${errText(err)}); stopped after 3 failures` : `prompt not sent (${errText(err)})`
    sayTo($, `HANDOFF failed: ${h.reason}. Ask again: /handoff retry`)
    await syncAll($, ctx)
  }
}

async function syncAll($: EngineInterface, ctx: Ctx): Promise<void> {
  await publish($, ctx)
  await refreshCoach($, ctx)
}

async function failHandoff($: EngineInterface, ctx: Ctx, reason: string, missing?: string[]): Promise<void> {
  const h = ctx.rt.handoff
  h.failures++
  h.state = 'failed'
  h.reason = h.failures >= 3 ? `${reason}; stopped after 3 failures` : reason
  h.missing = missing
  const text = missing && missing.length > 0 ? `HANDOFF incomplete: missing ${missing.join(', ')}. Ask again: /handoff retry` : `HANDOFF failed: ${h.reason}. Ask again: /handoff retry`
  sayTo($, h.failures >= 3 ? `HANDOFF stopped after 3 failures (${reason}). Write the file by hand or run /handoff cancel.` : text)
  await syncAll($, ctx)
}

/** First main-loop answer after our submit: check the file the model wrote (exists, size, eight headings). */
async function detect($: EngineInterface, ctx: Ctx): Promise<void> {
  const { rt, opts } = ctx
  const h = rt.handoff
  const path = h.path
  if (!path) return
  let exists = false
  try {
    exists = await $.fs.exists(path)
  } catch {
    exists = false
  }
  if (!exists) return failHandoff($, ctx, 'file not found')
  let body = ''
  try {
    body = (await $.fs.read(path)) ?? ''
  } catch {
    return failHandoff($, ctx, 'file not readable')
  }
  let size = body.length
  try {
    const st = await $.fs.stat(path)
    if (typeof st.size === 'number') size = st.size
  } catch {
    // keep text length
  }
  const missing = missingHeadings(body)
  if (size < opts.minBytes) return failHandoff($, ctx, `file too small (${size} bytes)`, missing.length > 0 ? missing : undefined)
  if (missing.length > 0) return failHandoff($, ctx, 'incomplete', missing)
  const now = await $.clock.now()
  h.failures = 0
  h.missing = undefined
  h.reason = undefined
  const rec: LastHandoff = { v: 1, path, savedAt: now }
  await $.store.set(lastKey(await sessionId($)), rec)
  if (h.noCompact) {
    h.state = 'saved'
    sayTo($, `Handoff saved: ${path}. Not compacting (--no-compact).`)
  } else {
    h.state = 'ready'
    h.readyAt = now
    h.note = undefined
    let cost = ''
    try {
      const c = await calcNow($, ctx)
      if (c.cost) cost = ` (~${usd2(c.cost.passWarm)})`
    } catch {
      // no estimate
    }
    sayTo($, `Handoff saved: ${path}. Compaction is irreversible. Run /handoff go to compact${cost} or /handoff cancel.`)
  }
  await syncAll($, ctx)
}

async function handoffOnComplete($: EngineInterface, e: { agentId?: string; reason: string }, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.handoff) return
  if (!e.agentId && e.reason === 'answer' && ctx.rt.handoff.state === 'writing') await detect($, ctx)
}

async function handoffOnCompact($: EngineInterface, e: { agentId?: string; trigger: string }, r: { skip?: string; tokensBefore?: number; tokensAfter?: number }, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.handoff) return
  const { rt } = ctx
  const h = rt.handoff
  if (e.agentId || e.trigger === 'precompute' || r.skip !== undefined) return
  if (h.state === 'ready' || h.state === 'saved' || h.state === 'compacting') {
    h.before = r.tokensBefore ?? rt.ctx
    h.after = r.tokensAfter
    h.awaitAfter = r.tokensAfter == null
    h.state = 'done'
    h.doneAt = await $.clock.now()
  }
  await publish($, ctx)
}

async function handoffOnEnd($: EngineInterface, e: { reason: string; sessionId?: string }, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.handoff || e.reason !== 'clear') return
  const h = ctx.rt.handoff
  h.epoch++
  Object.assign(h, { note: undefined, state: 'idle', path: undefined, rel: undefined, readyAt: undefined, failures: 0, missing: undefined, before: undefined, after: undefined, doneAt: undefined, reason: undefined, noCompact: false, awaitAfter: false })
  if (e.sessionId) {
    await $.store.delete(lastKey(e.sessionId))
    await $.store.delete(pendingKey(e.sessionId))
  }
}

const tk = (n: number | undefined): string => (n == null ? '?' : fmtTokens(n))

/** The one place `$.session.compact` is called. Runs from a timer started by `/handoff go`; never from a hook, toast or timer of the Coach. */
async function runCompact($: EngineInterface, ctx: Ctx, path: string, agentIds: string[], tryNo = 1): Promise<void> {
  const { rt } = ctx
  const h = rt.handoff
  if (h.state !== 'compacting') return
  let res
  try {
    res = await $.session.compact({ instructions: compactInstructions(path, agentIds) })
  } catch (err) {
    const msg = errText(err)
    if (isHostHold(err) && tryNo < HOLD_TRIES) {
      rt.compactTimer = $.clock.after(HOLD_WAIT_MS, () => void runCompact($, ctx, path, agentIds, tryNo + 1))
      return
    }
    $.ui.log(`compact: ${msg}`, { to: 'debug' })
    h.state = 'ready'
    if (msg.includes('not available in a headless')) h.note = 'Compaction is not available in a headless (-p / SDK) session. Run /handoff go in the interactive terminal.'
    else h.note = 'Turn running. Run /handoff go when it ends.'
    sayTo($, h.note)
    await syncAll($, ctx)
    return
  }
  if (res.skip !== undefined) {
    h.state = 'ready'
    h.note = `Compaction skipped: ${res.skip}`
    sayTo($, `${h.note}. The handoff is still ready: /handoff go or /handoff cancel.`)
    await syncAll($, ctx)
    return
  }
  const at = await $.clock.now()
  if (h.state === 'compacting' || h.state === 'ready') {
    h.before = res.tokensBefore ?? rt.ctx
    h.after = res.tokensAfter
    h.awaitAfter = res.tokensAfter == null
    h.state = 'done'
    h.doneAt = at
  }
  if (typeof res.tokensAfter === 'number') rt.ctx = res.tokensAfter
  await markPending($, ctx)
  rt.toastArmed = true
  sayTo($, `Compacted ${tk(h.before)} → ${tk(h.after)}. The next prompt tells the model to read ${path}.`)
  await syncAll($, ctx)
}

async function handoffCommand($: EngineInterface, args: string, ctx: Ctx): Promise<{ text: string }> {
  const { rt, opts } = ctx
  const h = rt.handoff
  const now = await $.clock.now()
  const a = parseArgs(args)

  if (a.kw === 'cancel') {
    if (h.state === 'idle' || h.state === 'done') return { text: 'Nothing to cancel.' }
    const path = h.path
    h.epoch++
    h.state = 'idle'
    h.readyAt = undefined
    h.missing = undefined
    await syncAll($, ctx)
    return { text: `Handoff cancelled.${path ? ` The file stays at ${path}.` : ''}` }
  }

  if (a.kw === 'go') {
    if (effState(rt, opts, now) !== 'ready' || !h.path) {
      if (h.state === 'ready') h.state = 'idle'
      await syncAll($, ctx)
      return { text: 'Nothing to compact. Run /handoff first.' }
    }
    const agentIds = (await listAgents($, ctx)).filter(x => RUNNING.has(x.status)).map(x => x.id)
    const path = h.path
    h.state = 'compacting'
    h.note = undefined
    await syncAll($, ctx)
    // `$.session.compact` is refused from a command.run hook (host check), so the compaction runs from a timer's own dispatch.
    // Armed last, nothing awaited after it: the command must return before the timer fires.
    rt.compactTimer?.cancel()
    rt.compactTimer = $.clock.after(0, () => void runCompact($, ctx, path, agentIds))
    return { text: `Compacting now. The result shows in the band and the log: COMPACTED before → after, or the reason it did not run.` }
  }

  if (a.kw === 'retry') {
    if (h.state !== 'failed' || !h.path) return { text: 'Nothing to retry. Run /handoff first.' }
    if (h.failures >= 3) return { text: 'Stopped after 3 failures. Write the file by hand or run /handoff cancel.' }
    const agents = (await listAgents($, ctx)).filter(x => RUNNING.has(x.status))
    const note = `The previous attempt was incomplete${h.missing && h.missing.length ? ` (missing: ${h.missing.join('; ')})` : ''}. Write the complete file.`
    h.state = 'writing'
    h.epoch++
    await syncAll($, ctx)
    const title = (h.path.split('/').pop() ?? 'session').replace(/\.md$/, '')
    const prompt = buildPrompt(h.path, title, localDate(now), agents, note)
    queueSubmit($, ctx, prompt)
    return { text: `Handoff retry: the model is writing ${h.path} again.` }
  }

  if (h.state === 'compacting') return { text: 'Compaction is running. Wait for it to finish.' }
  if (h.state === 'writing') return { text: `Handoff in progress: ${(h.path?.split('/').pop() ?? 'session').replace(/\.md$/, '')}. /handoff cancel first.` }

  const p = await resolvePath($, ctx, a.slugWords, now)
  const slug = kebab(a.slugWords) || 'session'
  const agents = (await listAgents($, ctx)).filter(x => RUNNING.has(x.status))
  h.usedPaths.add(p.path)
  Object.assign(h, { note: undefined, state: 'writing', path: p.path, rel: p.rel, readyAt: undefined, missing: undefined, reason: undefined, before: undefined, after: undefined, doneAt: undefined, failures: 0, noCompact: a.noCompact, awaitAfter: false })
  h.epoch++
  await syncAll($, ctx)
  let tip = ''
  if (p.root) {
    let ignored = false
    try {
      ignored = /^\/?handoff\/?$/m.test((await $.fs.read(`${p.root.replace(/\/$/, '')}/.gitignore`)) ?? '')
    } catch {
      ignored = false
    }
    if (!ignored) tip = ' Tip: add "handoff/" to .gitignore if this repo is shared.'
  }
  let headless = false
  try {
    headless = /^sdk/i.test((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? '')
  } catch {
    headless = false
  }
  const how = a.noCompact ? ' (no compact)' : ''
  const next = a.noCompact ? '' : ' When it is ready, /handoff go compacts and /handoff cancel stops.'
  const hl = headless ? ' (Headless: this works only in a session that stays open, e.g. stream-json or interactive.)' : ''
  const text = `Handoff started: the model is writing ${p.path}${how}.${next}${tip}${hl}`
  const prompt = buildPrompt(p.path, slug.replace(/-/g, ' '), localDate(now), agents)
  // Last statement before the return, nothing awaited after it (host hold rule, spec s2).
  queueSubmit($, ctx, prompt)
  return { text }
}

// ---------------------------------------------------------------------------
// Resume loader

/** Marks a pending resume when this session saved a handoff within `handoff.resumeMaxAgeMin`. Idempotent. */
async function markPending($: EngineInterface, ctx: Ctx, agentFallback = false): Promise<boolean> {
  if (!ctx.opts.mods.resume) return false
  const sid = await sessionId($)
  const last = await $.store.get(lastKey(sid))
  const now = await $.clock.now()
  if (isLast(last) && now - last.savedAt <= ctx.opts.resumeMaxAgeMin * 60_000) {
    const p: Pending = { v: 1, path: last.path, at: now, savedAt: last.savedAt }
    await $.store.set(pendingKey(sid), p)
    await update($, resumeAtom, () => ({ pending: true }))
    return true
  }
  // F33.11: no usable /handoff; the agent's own file wins when it is fresh right now (only from the compaction hook).
  if (!agentFallback) return false
  const p = await agentPending($, ctx, now)
  if (!p) return false
  await $.store.set(pendingKey(sid), p)
  await update($, resumeAtom, () => ({ pending: true }))
  return true
}

/** The `kind:'agent'` pending record when `<sid>-agent.md` is fresh by the F33.4 rule at this moment. */
async function agentPending($: EngineInterface, ctx: Ctx, now: number): Promise<Pending | undefined> {
  const n = ctx.rt.nudge
  if (!(await nudgeIdentity($, ctx)) || !n.agentPath) return undefined
  let size = n.agentSize
  let mtime: number | undefined
  try {
    const st = await $.fs.stat(n.agentPath)
    if (typeof st.size === 'number') size = st.size
    if (typeof st.mtimeMs === 'number') mtime = st.mtimeMs
  } catch {
    // keep what the write detection learned
  }
  if (size == null) return undefined
  const known = n.agentWrittenAt != null || n.lastNudgeAt != null
  if (!isFresh(known ? buildMeta(n, ctx.rt.ctx) : undefined, size, now, mtime, n.lastUserMsgAt)) return undefined
  return { v: 1, path: n.agentPath, at: now, savedAt: n.agentWrittenAt ?? mtime ?? now, kind: 'agent' }
}

/** The one-shot context entry for this prompt, when a resume is pending. */
async function resumeOnPrompt($: EngineInterface, ctx: Ctx): Promise<string | undefined> {
  if (!ctx.opts.mods.resume) return undefined
  const sid = await sessionId($)
  const p = (await $.store.get(pendingKey(sid))) as Pending | undefined
  if (!p || typeof p.path !== 'string') return undefined
  await $.store.delete(pendingKey(sid))
  await update($, resumeAtom, () => ({ pending: false }))
  let present = false
  try {
    present = await $.fs.exists(p.path)
  } catch {
    present = false
  }
  if (present) return p.kind === 'agent' ? agentResumeEntry(p.path) : resumeEntry(p.path)
  $.ui.log(`compact resume: handoff file is gone (${p.path}); nothing injected`)
  return undefined
}

async function resumeOnCompact($: EngineInterface, e: { agentId?: string; trigger: string }, r: { skip?: string }, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.resume) return
  if (!e.agentId && e.trigger !== 'precompute' && r.skip === undefined) await markPending($, ctx, true)
}

async function resumeOnEnd($: EngineInterface, e: { reason: string; sessionId?: string }, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.resume || e.reason !== 'clear' || !e.sessionId) return
  await $.store.delete(pendingKey(e.sessionId))
  await update($, resumeAtom, () => ({ pending: false }))
}

// ---------------------------------------------------------------------------
// Handoff nudge (F33): one reminder, appended to a model request that happens anyway. Never blocks, never spends a turn.

/** Home and session id -> agent file path. Needs `$`; the `tool.call` hook only reads the cached path. */
async function nudgeIdentity($: EngineInterface, ctx: Ctx): Promise<boolean> {
  const n = ctx.rt.nudge
  if (!n.home) {
    try {
      const h = await $.env.get('HOME')
      if (h) n.home = h
    } catch {
      // no home: no nudge
    }
  }
  if (!n.home) return false
  const sid = await sessionId($)
  if (n.sid !== undefined && n.sid !== sid) {
    n.lastK = -1
    n.armText = n.armedK = n.armTokens = undefined
    n.agentWrittenAt = n.agentWrittenAtTokens = n.agentSize = n.lastNudgeAt = n.lastNudgeTokens = n.metaTokens = undefined
    n.nudgeCount = 0
    n.sections = n.baseSections = n.prevSections = n.staleSections = n.lastUserMsgAt = undefined
    n.armStale = false
    n.userTurns = n.toolCalls = 0
  }
  n.sid = sid
  n.agentPath = agentPathFor(n.home, sid)
  return true
}

/** W (F33.2): env, then the usage breakdown (cached 10 min), then the built-in table with `windowsJson` overrides. */
async function nudgeWindow($: EngineInterface, ctx: Ctx, now: number): Promise<number | undefined> {
  const { rt } = ctx
  const n = rt.nudge
  let w: number | undefined
  try {
    w = parseEnvWindow(await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))
  } catch {
    w = undefined
  }
  if (w === undefined) {
    if (n.rawAt == null || now - n.rawAt > 600_000) {
      n.rawAt = now
      try {
        const u = await $.session.usage({ breakdown: 'summary' })
        const r = u.context.breakdown?.rawMaxTokens
        n.rawMax = typeof r === 'number' && r > 0 ? r : undefined
      } catch {
        n.rawMax = undefined
      }
    }
    w = n.rawMax
  }
  if (w === undefined) {
    if (rt.winBad && !rt.winLogged) {
      rt.winLogged = true
      $.ui.log('compact: windowsJson is not valid JSON; using the built-in window table', { to: 'debug' })
    }
    w = windowFor(rt.model, rt.winOverrides)
  }
  n.window = w
  return w
}

/** Fresh state from memory only (no stat): none until the file is known to exist. */
function freshMem(ctx: Ctx, now: number): AgentFresh {
  const n = ctx.rt.nudge
  if (n.agentWrittenAt == null && n.agentSize == null) return 'none'
  return isFresh(buildMeta(n, ctx.rt.ctx), n.agentSize ?? 0, now) ? 'fresh' : 'stale'
}

async function nudgePublish($: EngineInterface, ctx: Ctx): Promise<void> {
  const n = ctx.rt.nudge
  const now = await $.clock.now()
  const next = n.window ? threshold(n.window, ctx.opts.nudgeAtPercent, ctx.opts.nudgeEvery, n.lastK + 1) : undefined
  const v: NudgeView = { armed: n.armText != null, lastK: n.lastK, next, window: n.window, lastNudgeAt: n.lastNudgeAt, fresh: freshMem(ctx, now) }
  const j = JSON.stringify(v)
  if (j === n.pub) return
  n.pub = j
  await update($, nudgeAtom, () => v)
}

async function writeMeta($: EngineInterface, ctx: Ctx, t: number | undefined): Promise<void> {
  const n = ctx.rt.nudge
  if (!n.home || !n.sid) return
  n.metaTokens = t ?? ctx.rt.ctx
  try {
    await $.fs.write(metaPathFor(n.home, n.sid), JSON.stringify(buildMeta(n, t ?? ctx.rt.ctx)))
  } catch (err) {
    if (!n.metaFailedLogged) {
      n.metaFailedLogged = true
      $.ui.log(`compact nudge: meta not written (${errText(err)})`, { to: 'debug' })
    }
  }
}

/** Takes the pending arm for delivery: sets `lastK` and clears it. The caller books the delivery. */
function takeArm(ctx: Ctx): { text: string; tokens: number } | undefined {
  const n = ctx.rt.nudge
  if (n.armText == null) return undefined
  const out = { text: n.armText, tokens: n.armTokens ?? ctx.rt.ctx ?? 0 }
  if (n.armedK != null) n.lastK = n.armedK
  n.armText = n.armedK = n.armTokens = undefined
  return out
}

async function nudgeDelivered($: EngineInterface, ctx: Ctx, tokens: number): Promise<void> {
  const n = ctx.rt.nudge
  n.lastNudgeAt = await $.clock.now()
  n.lastNudgeTokens = tokens
  n.nudgeCount++
  n.baseSections = n.sections
  n.userTurns = n.toolCalls = 0
  await writeMeta($, ctx, tokens)
  await nudgePublish($, ctx)
}

/** `session.measure`: thresholds, arming, mtime adoption and meta upkeep (F33.2, F33.4). */
async function nudgeOnMeasure($: EngineInterface, e: { agentId?: string; context?: { tokens?: number } }, ctx: Ctx): Promise<void> {
  const { opts } = ctx
  const n = ctx.rt.nudge
  const t = e.context?.tokens
  if (!opts.mods.nudge || e.agentId || typeof t !== 'number') return
  if (!(await nudgeIdentity($, ctx)) || !n.agentPath) return
  const now = await $.clock.now()
  const w = await nudgeWindow($, ctx, now)
  if (w) {
    if (t < threshold(w, opts.nudgeAtPercent, opts.nudgeEvery, 0) / 2) {
      n.lastK = -1
      n.armText = n.armedK = n.armTokens = undefined
    } else {
      const k = highestK(t, w, opts.nudgeAtPercent, opts.nudgeEvery)
      if (k > n.lastK && (n.armedK ?? -1) < k) {
        let exists = false
        try {
          exists = await $.fs.exists(n.agentPath)
        } catch {
          exists = false
        }
        // F35.2: hashes at arm time, compared with the ones at the previous delivery (idempotent across re-arms).
        let stale = false
        if (exists) {
          try {
            const cur = await sectionHashes((await $.fs.read(n.agentPath)) ?? '')
            n.prevSections = n.baseSections
            n.sections = cur
            stale = isStaleSections(cur, n.baseSections, n.userTurns, n.toolCalls)
            n.staleSections = stale ? [...STALE_TARGETS] : []
          } catch {
            // unreadable: no staleness verdict
          }
        }
        n.armStale = stale
        n.armText = nudgeText(t, w, n.agentPath, exists, stale)
        n.armedK = k
        n.armTokens = t
      }
    }
  }
  let dirty = false
  if (n.lastNudgeAt != null) {
    try {
      const st = await $.fs.stat(n.agentPath)
      if (typeof st.size === 'number') n.agentSize = st.size
      if (typeof st.mtimeMs === 'number' && st.mtimeMs > (n.agentWrittenAt ?? -Infinity)) {
        n.agentWrittenAt = st.mtimeMs
        n.agentWrittenAtTokens = t
        await clearStaleIfRewritten($, ctx)
        dirty = true
      }
    } catch {
      // no file yet, or unreadable
    }
  }
  const upkeep = n.lastNudgeAt != null || n.agentWrittenAt != null
  if (dirty || (upkeep && n.metaTokens != null && Math.abs(t - n.metaTokens) >= META_STEP)) await writeMeta($, ctx, t)
  await nudgePublish($, ctx)
}

/** `tool.call`, after `next`: pure memory work plus `$.clock.after(0)` scheduling (F33.6). Appends `context` only. */
function nudgeToolCall<R extends { context?: readonly string[] }>($: EngineInterface, e: unknown, r: R, ctx: Ctx): R {
  const n = ctx.rt.nudge
  const ev = e as { tool?: string; file_path?: unknown; content?: unknown }
  n.toolCalls++
  if (n.agentPath && ev.file_path === n.agentPath && (ev.tool === 'Write' || ev.tool === 'Edit' || ev.tool === 'MultiEdit') && (r as { isError?: boolean }).isError !== true) {
    if (typeof ev.content === 'string') n.agentSize = ev.content.length
    $.clock.after(0, () => void safe(() => nudgeWritten($, ctx)))
  }
  const taken = takeArm(ctx)
  if (!taken) return r
  $.clock.after(0, () => void safe(() => nudgeDelivered($, ctx, taken.tokens)))
  return { ...r, context: [...(r.context ?? []), taken.text] }
}

/** A detected write of the agent file by the model. */
async function nudgeWritten($: EngineInterface, ctx: Ctx): Promise<void> {
  const n = ctx.rt.nudge
  n.agentWrittenAt = await $.clock.now()
  n.agentWrittenAtTokens = ctx.rt.ctx
  if (n.agentPath) {
    try {
      const st = await $.fs.stat(n.agentPath)
      if (typeof st.size === 'number') n.agentSize = st.size
    } catch {
      // keep the size from the Write input
    }
  }
  await clearStaleIfRewritten($, ctx)
  await writeMeta($, ctx, ctx.rt.ctx)
  await nudgePublish($, ctx)
}

/** F35.2: a detected write that changed BOTH target sections' hashes (against the latest arm) clears `stale_sections` at once. */
async function clearStaleIfRewritten($: EngineInterface, ctx: Ctx): Promise<void> {
  const n = ctx.rt.nudge
  if (!n.agentPath || !n.sections || !n.staleSections || n.staleSections.length === 0) return
  try {
    const cur = await sectionHashes((await $.fs.read(n.agentPath)) ?? '')
    if (STALE_TARGETS.every(h => cur[h] !== n.sections?.[h])) n.staleSections = []
  } catch {
    // keep the verdict
  }
}

/** `prompt.submit`: the secondary channel; returns the entry when an arm is pending. */
async function nudgeOnPrompt($: EngineInterface, ctx: Ctx, text?: string): Promise<string | undefined> {
  if (!ctx.opts.mods.nudge) return undefined
  if (typeof text === 'string' && text.trim() !== '') {
    ctx.rt.nudge.userTurns++
    ctx.rt.nudge.lastUserMsgAt = await $.clock.now()
  }
  const taken = takeArm(ctx)
  if (!taken) return undefined
  await safe(() => nudgeDelivered($, ctx, taken.tokens))
  return taken.text
}

async function nudgeOnStart($: EngineInterface, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.nudge) return
  if (await nudgeIdentity($, ctx)) await nudgeWindow($, ctx, await $.clock.now())
  await nudgePublish($, ctx)
}

/** Reset (F33.2): `lastK = -1`, arm cleared, `agentWrittenAt` kept. Runs AFTER Resume's pick so `lastNudgeAt` is intact for it. */
async function nudgeOnCompact($: EngineInterface, e: { agentId?: string; trigger: string }, r: { skip?: string }, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.nudge || e.agentId || e.trigger === 'precompute' || r.skip !== undefined) return
  const n = ctx.rt.nudge
  n.lastK = -1
  n.armText = n.armedK = n.armTokens = undefined
  n.rawAt = undefined
  if (await nudgeIdentity($, ctx)) await nudgeWindow($, ctx, await $.clock.now())
  await nudgePublish($, ctx)
}

async function nudgeOnEnd($: EngineInterface, ctx: Ctx): Promise<void> {
  if (!ctx.opts.mods.nudge) return
  const n = ctx.rt.nudge
  n.lastK = -1
  n.armText = n.armedK = n.armTokens = undefined
  await nudgePublish($, ctx)
}

async function nudgeCardLine($: EngineInterface, ctx: Ctx): Promise<string> {
  const n = ctx.rt.nudge
  await nudgeIdentity($, ctx)
  await nudgeWindow($, ctx, await $.clock.now())
  return nudgeLine(n, ctx.opts.nudgeAtPercent, ctx.opts.nudgeEvery, freshMem(ctx, await $.clock.now()))
}

// ---------------------------------------------------------------------------
// Handoff alert (F36): reads <sid>-degraded.json (written by the handoff hooks), toast + band chip, clears on /handoff or a fresh agent file.

async function alertIdentity($: EngineInterface, ctx: Ctx): Promise<boolean> {
  const a = ctx.rt.alert
  if (!a.home) {
    try {
      const h = await $.env.get('HOME')
      if (h) a.home = h
    } catch {
      // no home: no alert
    }
  }
  if (!a.home) return false
  const sid = (await sessionId($)).replace(/\//g, '_')
  if (a.sid !== undefined && a.sid !== sid) {
    a.flush?.cancel()
    Object.assign(a, { active: false, reasons: [], ts: undefined, raw: undefined, clearedTs: -Infinity, shownTs: undefined, shownLoaded: false, compactAt: undefined, readsLeft: 0, lastReadAt: undefined, pub: undefined, flush: undefined })
  }
  a.sid = sid
  return true
}

async function alertPublish($: EngineInterface, ctx: Ctx): Promise<void> {
  const a = ctx.rt.alert
  const v: HandoffHealthView = a.active ? { degraded: true, reasons: reasonTexts(a.reasons), since: a.ts } : { degraded: false, reasons: [] }
  const j = JSON.stringify(v)
  if (j === a.pub) return
  a.pub = j
  await update($, handoffHealthAtom, () => v)
  await refreshCoach($, ctx)
}

/** One toast per (sid, ts): same queue and peer-gap rules as the Coach toast, none of its episode rules. */
async function alertToast($: EngineInterface, ctx: Ctx): Promise<void> {
  const { rt } = ctx
  const a = rt.alert
  if (!a.active || a.ts == null || !a.sid) return
  if (!a.shownLoaded) {
    a.shownLoaded = true
    try {
      const v = (await $.store.get(shownKey(a.sid))) as { ts?: unknown } | undefined
      if (v && typeof v.ts === 'number') a.shownTs = v.ts
    } catch {
      // not shown before
    }
  }
  if (a.shownTs != null && a.shownTs >= a.ts) return
  if (!rt.hasBand) return
  const now = await $.clock.now()
  const w = await toastWaitMs(
    { readPeer: name => peerValue($, name) },
    { now, lastShownAt: undefined, minGapMs: 60_000, peers: ['awareness.headsup', 'dev.toast'], respectQuiet: true },
  )
  if (w === 0) {
    $.ui.toast(toastLine(reasonTexts(a.reasons)))
    a.shownTs = a.ts
    a.flush = undefined
    await $.store.set(shownKey(a.sid), { v: 1, ts: a.ts })
  } else {
    // Infinity = quiet (focus phase or Heads-Up mute): retry at the mute end, else in 30 s.
    let delay = w
    if (!Number.isFinite(w)) {
      delay = 30_000
      try {
        const h = await peerValue($, 'awareness.headsup')
        if (typeof h?.mutedUntil === 'number' && h.mutedUntil > now) delay = h.mutedUntil - now
      } catch {
        // keep 30 s
      }
    }
    a.flush?.cancel()
    a.flush = $.clock.after(delay + 50, () => void safe(() => alertToast($, ctx)))
  }
}

async function alertClear($: EngineInterface, ctx: Ctx, writeFile: boolean): Promise<void> {
  const a = ctx.rt.alert
  if (!a.active) return
  const raw = a.raw
  const path = a.home && a.sid ? degradedPath(a.home, a.sid) : undefined
  if (a.ts != null) a.clearedTs = a.ts
  a.active = false
  a.reasons = []
  a.flush?.cancel()
  if (writeFile && raw && path) {
    try {
      await $.fs.write(path, clearedBody(raw, await $.clock.now()))
    } catch (err) {
      if (!a.clearFailLogged) {
        a.clearFailLogged = true
        $.ui.log(`compact handoff alert: could not mark the alert cleared (${errText(err)})`, { to: 'debug' })
      }
    }
  }
  await alertPublish($, ctx)
}

/** Reads the degraded file and moves the alert state; toast on a new (sid, ts). */
async function alertRead($: EngineInterface, ctx: Ctx): Promise<void> {
  const a = ctx.rt.alert
  if (!ctx.opts.mods.handoffalert || !(await alertIdentity($, ctx)) || !a.home || !a.sid) return
  const path = degradedPath(a.home, a.sid)
  a.lastReadAt = await $.clock.now()
  let body: string | undefined
  try {
    if (await $.fs.exists(path)) body = (await $.fs.read(path)) ?? undefined
  } catch (err) {
    if (!a.unreadableLogged) {
      a.unreadableLogged = true
      $.ui.log(`compact handoff alert: degraded file unreadable (${errText(err)})`, { to: 'debug' })
    }
    body = undefined
  }
  const f = parseAlert(body)
  if (f && !f.cleared && f.ts > a.clearedTs) {
    a.active = true
    a.reasons = f.reasons
    a.ts = f.ts
    a.raw = f.raw
    if (a.compactAt != null && f.ts > a.compactAt) a.readsLeft = 0
    await alertPublish($, ctx)
    await safe(() => alertToast($, ctx))
    return
  }
  if (a.active) {
    a.active = false
    a.reasons = []
  }
  await alertPublish($, ctx)
}

/** Clearing (F36.6): a /handoff saved after `ts`, or the agent file rewritten after `ts` and fresh. */
async function alertCheckClear($: EngineInterface, ctx: Ctx): Promise<void> {
  const a = ctx.rt.alert
  if (!ctx.opts.mods.handoffalert || !a.active || a.ts == null || !a.sid) return
  const last = await $.store.get(lastKey(a.sid))
  if (isLast(last) && last.savedAt > a.ts) return alertClear($, ctx, true)
  const p = await agentPending($, ctx, await $.clock.now())
  if (p && p.savedAt > a.ts) return alertClear($, ctx, true)
}

async function alertOnCompact($: EngineInterface, e: { agentId?: string; trigger: string }, r: { skip?: string }, ctx: Ctx): Promise<void> {
  const a = ctx.rt.alert
  if (!ctx.opts.mods.handoffalert || e.agentId || e.trigger === 'precompute' || r.skip !== undefined) return
  a.compactAt = await $.clock.now()
  a.readsLeft = 3
  a.lastReadAt = undefined
  await alertRead($, ctx)
}

async function alertOnMeasure($: EngineInterface, ctx: Ctx): Promise<void> {
  const a = ctx.rt.alert
  if (!ctx.opts.mods.handoffalert) return
  const now = await $.clock.now()
  if (a.readsLeft > 0 && (a.lastReadAt == null || now - a.lastReadAt >= 5000)) {
    a.readsLeft--
    await alertRead($, ctx)
    if (a.readsLeft === 0 && a.active && a.compactAt != null && a.ts != null && a.ts <= a.compactAt) await alertClear($, ctx, false)
    return
  }
  if (a.active) {
    await alertCheckClear($, ctx)
    if (a.active && (a.shownTs == null || a.ts == null || a.shownTs < a.ts)) await safe(() => alertToast($, ctx))
  }
}

async function alertOnEnd($: EngineInterface, e: { reason: string }, ctx: Ctx): Promise<void> {
  const a = ctx.rt.alert
  if (!ctx.opts.mods.handoffalert || e.reason !== 'clear') return
  a.flush?.cancel()
  a.active = false
  a.reasons = []
  a.sid = undefined
  await alertPublish($, ctx)
}

// ---------------------------------------------------------------------------
// Orchestrator mode

async function loadOrch($: EngineInterface, ctx: Ctx): Promise<void> {
  let on = ctx.opts.orchDefault
  try {
    const v = (await $.store.get(ORCH_KEY)) as { v?: number; on?: unknown } | undefined
    if (v && typeof v.on === 'boolean') on = v.on
  } catch {
    // keep the default
  }
  ctx.rt.orchOn = on
  ctx.rt.orchLoaded = true
}

type Section = { id: string; text: string; scope: 'shared' | 'session' }

/** Appends the orchestrator section after the engine's own when the mode is on; engine sections are never edited. */
async function orchOnCompose($: EngineInterface, e: { traits?: readonly string[] }, r: { sections: readonly Section[] }, ctx: Ctx): Promise<{ sections: readonly Section[] }> {
  const { rt } = ctx
  if (!ctx.opts.mods.orch) return r
  if (!rt.orchLoaded) await loadOrch($, ctx)
  if (!rt.orchOn) return r
  const traits = e.traits ?? []
  if (traits.includes('bare') || traits.includes('teammate')) return r
  if (r.sections.some(s => s.id === ORCH_ID)) return r
  return { sections: [...r.sections, { id: ORCH_ID, text: ORCH_TEXT, scope: 'session' as const }] }
}

async function envModel($: EngineInterface): Promise<string> {
  try {
    const s = (await $.settings.read()) as { env?: Record<string, unknown> }
    const v = s.env?.CLAUDE_CODE_SUBAGENT_MODEL
    return typeof v === 'string' && v ? v : 'not set'
  } catch {
    return 'unknown'
  }
}

async function orchCommand($: EngineInterface, args: string, ctx: Ctx): Promise<{ text: string }> {
  const { rt } = ctx
  if (!rt.orchLoaded) await loadOrch($, ctx)
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = words.find(w => w === 'on' || w === 'off' || w === 'status') ?? 'status'
  const yes = words.includes('--yes')
  const state = rt.orchOn ? 'ON' : 'OFF'
  if (sub === 'status') return { text: orchStatus(!!rt.orchOn, await envModel($)) }
  const target = sub === 'on'
  if (target === !!rt.orchOn) return { text: `Orchestrator mode is already ${state}.` }
  const figure = coldTurnFigure(rt.model, rt.overrides, rt.ctx)
  if (!yes) {
    return { text: `Turning Orchestrator mode ${sub} changes the system prompt and costs one cold turn (~${figure}). Run /orch ${sub} --yes to confirm. Best right after a compaction or at session start.` }
  }
  await $.store.set(ORCH_KEY, { v: 1, on: target })
  rt.orchOn = target
  await publish($, ctx)
  return { text: `Orchestrator mode ${target ? 'ON' : 'OFF'}. The next turn is a cold turn (~${figure}) because the system prompt changed.` }
}

// ---------------------------------------------------------------------------
// Commands and band

/** Registers the plugin's commands; a name that collides with another source gets the `compact-` prefix. */
async function registerCommands($: EngineInterface, ctx: Ctx): Promise<void> {
  const { opts, rt } = ctx
  let taken = new Set<string>()
  try {
    taken = new Set((await $.command.list()).filter(c => c.plugin !== 'compact').map(c => c.name))
  } catch {
    // assume no collisions
  }
  for (const def of COMMANDS) {
    if (!opts.mods[def.name]) continue
    const name = taken.has(def.name) ? `compact-${def.name}` : def.name
    rt.cmd[def.name] = name
    try {
      await $.command.register({ name, description: def.description, argumentHint: def.argumentHint })
    } catch {
      if (name === def.name) {
        rt.cmd[def.name] = `compact-${def.name}`
        try {
          await $.command.register({ name: `compact-${def.name}`, description: def.description, argumentHint: def.argumentHint })
        } catch {
          // command unavailable
        }
      }
    }
  }
}

async function bandSegments($: EngineInterface, ctx: Ctx): Promise<(Segment | null)[]> {
  const segs: (Segment | null)[] = []
  if (ctx.opts.mods.handoffalert) {
    const v = await read($, handoffHealthAtom)
    if (v.degraded) segs.push(alertSegment(v.reasons))
  }
  if (ctx.opts.mods.coach) {
    const now = await $.clock.now()
    segs.push(coachSegment(await calcNow($, ctx, true), ctx, now))
  }
  return segs
}

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const opts = readOpts(options)
  const rt = makeRt(opts)
  const ctx: Ctx = { rt, opts }

  on('session.start', async ($, e, next) => {
    try {
      rt.headless = e.isInteractive === false
      rt.hasBand = !(e.isInteractive === false || e.surface === null)
      try {
        const s = await $.session.surfaces()
        if (Array.isArray(s) && s.length === 0) rt.hasBand = false
      } catch {
        // keep what start said
      }
      await registerCommands($, ctx)
      try {
        const t = (await $.store.get(TOAST_KEY)) as { lastShownAt?: unknown } | undefined
        if (t && typeof t.lastShownAt === 'number') rt.lastShownAt = t.lastShownAt
      } catch {
        // no stored toast time
      }
      try {
        rt.model = await $.session.model()
      } catch {
        // learned from turn.step
      }
      try {
        const u = await $.session.usage()
        if (typeof u.context.tokens === 'number') rt.ctx = u.context.tokens
      } catch {
        // learned from session.measure
      }
      if (rt.pricesBad && !rt.pricesLogged) {
        rt.pricesLogged = true
        $.ui.log('compact: pricesJson is not valid JSON; using the built-in prices', { to: 'debug' })
      }
      if (opts.mods.orch) await loadOrch($, ctx)
      await safe(() => nudgeOnStart($, ctx))
      await safe(() => alertRead($, ctx))
      await refreshCoach($, ctx)
    } catch (err) {
      $.ui.log(`compact: start ${errText(err)}`, { to: 'debug' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Keeps the agents atom (what the band reads) fresh: there is no agent-end event, so spawn plus every step.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    $.clock.after(1000, () => void safe(() => listAgents($, ctx)))
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    await safe(() => listAgents($, ctx))
    await safe(() => coachOnStep($, e, ctx))
    return yield* next(e)
  })

  on('turn.start', async ($, e, next) => {
    await safe(() => evalReturn($, ctx, 'turn'))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    await safe(() => evalReturn($, ctx, 'prompt'))
    let entry: string | undefined
    await safe(async () => {
      entry = await resumeOnPrompt($, ctx)
    })
    let nudge: string | undefined
    await safe(async () => {
      nudge = await nudgeOnPrompt($, ctx, (e as { text?: string; agentId?: string }).agentId ? undefined : e.text)
    })
    await safe(() => alertCheckClear($, ctx))
    const add = [entry, nudge].filter((x): x is string => x != null)
    return next(add.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...add] })
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await safe(() => nudgeOnMeasure($, e, ctx))
    await safe(() => alertOnMeasure($, ctx))
    await safe(() => coachOnMeasure($, e, ctx))
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    await safe(() => handoffOnComplete($, e, ctx))
    await safe(() => coachOnComplete($, e, ctx))
    return r
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    await safe(() => handoffOnCompact($, e, r, ctx))
    await safe(() => resumeOnCompact($, e, r, ctx))
    await safe(() => nudgeOnCompact($, e, r, ctx))
    await safe(() => alertOnCompact($, e, r, ctx))
    await safe(() => coachOnCompact($, e, r, ctx))
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await safe(() => handoffOnEnd($, e, ctx))
    await safe(() => resumeOnEnd($, e, ctx))
    await safe(() => nudgeOnEnd($, ctx))
    await safe(() => alertOnEnd($, e, ctx))
    await safe(() => coachOnEnd($, e, ctx))
    return next(e)
  }).catch(($, e, next) => next(e))

  // Handoff nudge (F33): appends `context` after `next`, never changes `result` or `deny`. Not registered when the mod is off.
  if (opts.mods.nudge) {
    on('tool.call', async ($, e, next) => {
      const r = await next(e)
      try {
        if (r.deny !== undefined || (e as { agentId?: string }).agentId) return r
        return nudgeToolCall($, e, r, ctx)
      } catch {
        return r
      }
    }).catch(($, e, next) => next(e))
  }

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    try {
      return await orchOnCompose($, e, r, ctx)
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))

  // Commands: each hook is a function literal naming a literal command; /name and /compact-name both answer.
  on('command.run', { command: 'handoff' }, async ($, e) => handoffCommand($, e.args, ctx)).catch(($, e, next) => next(e))
  on('command.run', { command: 'compact-handoff' }, async ($, e) => handoffCommand($, e.args, ctx)).catch(($, e, next) => next(e))
  on('command.run', { command: 'coach' }, async $ => coachCommand($, ctx)).catch(($, e, next) => next(e))
  on('command.run', { command: 'compact-coach' }, async $ => coachCommand($, ctx)).catch(($, e, next) => next(e))
  on('command.run', { command: 'orch' }, async ($, e) => orchCommand($, e.args, ctx)).catch(($, e, next) => next(e))
  on('command.run', { command: 'compact-orch' }, async ($, e) => orchCommand($, e.args, ctx)).catch(($, e, next) => next(e))

  // One AbovePrompt hook for the whole plugin (conventions s4.1); only Coach contributes a segment.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view?.agentId) return next(e)
    try {
      await read($, clockAtom)
      const segs = await bandSegments($, ctx)
      if (segs.every(s => s == null)) return next(e)
      return await renderBand({ resolve: x => $.ui.resolve(x) }, e, next, { segments: segs, flat: true, minBandRows: opts.minBandRows })
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))
}
