// Focus Timer (Pom): pomodoro band segment, /focus, notify + chime at the end of a block.
import type { D } from '../lib/d'
import { sched } from '../lib/sched'
import type { Segment, Variant } from '../_shared/band'
import { fmtClock, fmtWhen, localDate } from '../_shared/fmt'
import { METER_CELLS, termMeterRatio } from '../_shared/glyphs'
import { V } from '../_shared/tokens'
import type { FocusView } from '../../types'
import { optBool, optNum, optStr } from '../lib/opts'
import type { Opts } from '../lib/opts'
import { cellWidth } from '../lib/rt'
import type { Rt } from '../lib/rt'
import { layout } from '../lib/seg'
import type { MascotMode } from '../_shared/svgkit'

const cfg = (o: Opts) => ({
  focusMin: Math.max(0.05, optNum(o, 'focus.focusMin', 25)),
  breakMin: Math.max(0.05, optNum(o, 'focus.breakMin', 5)),
  longMin: Math.max(0.05, optNum(o, 'focus.longBreakMin', 15)),
  every: Math.max(1, Math.floor(optNum(o, 'focus.longEvery', 4))),
  sound: optStr(o, 'focus.sound', 'chime'),
  notify: optBool(o, 'focus.notify', true),
  autoBreak: optBool(o, 'focus.autoBreak', true),
})

const STALE_MS = 5 * 60_000

// Module caches (the truth is in the focusA atom and the store).
let mirror: { phase: FocusView['phase']; endsAt?: number } = { phase: 'idle' }
let owns = false
let busy = false

const dayKey = (now: number): string => `focus:day:${localDate(now)}`

async function dayCount($: D, now: number): Promise<number> {
  try {
    const v = (await $.store.get(dayKey(now))) as { count?: number } | undefined
    return typeof v?.count === 'number' ? v.count : 0
  } catch {
    return 0
  }
}

async function setFocus($: D, rt: Rt, f: FocusView, now: number): Promise<void> {
  mirror = { phase: f.phase, endsAt: f.endsAt }
  sched.wake()
  await $.update('focus', () => f)
  await $.setClock(now)
  try {
    await $.store.set('focus:state', { v: 1, ...f, owner: rt.sid })
  } catch {
    // The store is a convenience for restarts.
  }
}

const hhmm = (ts: number, now: number): string => fmtWhen(ts, now)

async function start($: D, rt: Rt, minutes: number | undefined): Promise<string> {
  const c = cfg(rt.options)
  const now = await $.clock.now()
  const min = minutes != null && minutes > 0 ? minutes : c.focusMin
  const total = Math.round(min * 60_000)
  owns = true
  await setFocus($, rt, { phase: 'focus', startedAt: now, endsAt: now + total, totalMs: total, count: await dayCount($, now), ofTotal: c.every }, now)
  return `Focus started: ${min} min. Heads-Up is quiet until ${hhmm(now + total, now)}.`
}

/** Moves out of the current phase. how: done (ran out), skip, stop. */
async function finish($: D, rt: Rt, how: 'done' | 'skip' | 'stop'): Promise<void> {
  const c = cfg(rt.options)
  const f = await $.read('focus')
  const now = await $.clock.now()
  const was = f.phase === 'paused' ? f.resumeAs : f.phase === 'idle' ? undefined : f.phase
  if (!was) return
  let fire = false
  let count = f.count
  let next: FocusView = { phase: 'idle', count, ofTotal: c.every }
  if (was === 'focus') {
    if (how === 'done') {
      const mine = owns
      if (mine) {
        count = Math.max(f.count, await dayCount($, now)) + 1
        try {
          await $.store.set(dayKey(now), { v: 1, count })
        } catch {
          // Count stays in the atom.
        }
        fire = true
      }
    }
    if (how !== 'stop' && c.autoBreak) {
      const long = how === 'done' && count > 0 && count % c.every === 0
      const total = Math.round((long ? c.longMin : c.breakMin) * 60_000)
      next = { phase: 'break', startedAt: now, endsAt: now + total, totalMs: total, count, ofTotal: c.every }
    } else next = { phase: 'idle', count, ofTotal: c.every }
  }
  const doneMin = Math.round((f.totalMs ?? c.focusMin * 60_000) / 60_000)
  await setFocus($, rt, next, now)
  if (was === 'focus') await rt.hu.onFocusEnd($)
  if (fire) {
    if (c.notify) void Promise.resolve($.ui.notify(`POWER UP · ${doneMin} MIN`, { title: 'Focus' })).catch(() => undefined)
    if (c.sound === 'chime') void Promise.resolve($.audio.play({ asset: 'sounds/done.wav' })).catch(() => undefined)
  }
}

async function status($: D, rt: Rt): Promise<string> {
  const f = await $.read('focus')
  const now = await $.clock.now()
  if (f.phase === 'idle') return `Focus idle. ${f.count} block${f.count === 1 ? '' : 's'} today. /focus start [min]`
  if (f.phase === 'paused') return `PAUSED ${fmtClock(f.remainingMs ?? 0)} left. /focus resume`
  const left = Math.max(0, (f.endsAt ?? now) - now)
  return f.phase === 'focus'
    ? `FOCUS ${fmtClock(left)} left · Focus ${(f.count % f.ofTotal) + 1} of ${f.ofTotal} · Heads-Up quiet until ${hhmm(f.endsAt ?? now, now)}`
    : `BEAN ${fmtClock(left)} left`
}

async function command($: D, rt: Rt, args: string): Promise<string> {
  const [sub = 'status', arg] = args.trim().split(/\s+/)
  const f = await $.read('focus')
  const now = await $.clock.now()
  switch (sub.toLowerCase()) {
    case 'start': {
      const m = arg != null ? Number(arg) : undefined
      return start($, rt, m != null && Number.isFinite(m) ? m : undefined)
    }
    case 'pause': {
      if (f.phase !== 'focus' && f.phase !== 'break') return 'Nothing to pause.'
      await setFocus($, rt, { ...f, phase: 'paused', resumeAs: f.phase, remainingMs: Math.max(0, (f.endsAt ?? now) - now), endsAt: undefined }, now)
      return 'Paused. /focus resume to continue.'
    }
    case 'resume': {
      if (f.phase !== 'paused') return 'Not paused.'
      const left = f.remainingMs ?? 0
      const total = f.totalMs ?? left
      await setFocus($, rt, { ...f, phase: f.resumeAs ?? 'focus', endsAt: now + left, startedAt: now + left - total, remainingMs: undefined, resumeAs: undefined }, now)
      return `Resumed: ${fmtClock(left)} left.`
    }
    case 'stop': {
      if (f.phase === 'idle') return 'Focus is not running.'
      await finish($, rt, 'stop')
      return 'Focus stopped.'
    }
    case 'skip': {
      if (f.phase === 'idle') return 'Nothing to skip.'
      await finish($, rt, 'skip')
      return 'Skipped.'
    }
    case 'status':
    case '':
      return status($, rt)
    default:
      return 'Usage: /focus start [min] | pause | resume | stop | skip | status'
  }
}

async function restore($: D, rt: Rt): Promise<void> {
  const c = cfg(rt.options)
  const now = await $.clock.now()
  const count = await dayCount($, now)
  let raw: any
  try {
    raw = await $.store.get('focus:state')
  } catch {
    raw = undefined
  }
  const s = raw && typeof raw === 'object' ? (raw.focus && typeof raw.focus === 'object' ? raw.focus : raw) : undefined
  let f: FocusView = { phase: 'idle', count, ofTotal: c.every }
  if (s) {
    const ends = typeof s.endsAt === 'number' ? s.endsAt : undefined
    const phase = s.phase === 'break' || s.phase === 'paused' || s.phase === 'idle' ? s.phase : ends != null ? 'focus' : 'idle'
    if (phase === 'paused' && typeof s.remainingMs === 'number') {
      f = { phase: 'paused', remainingMs: s.remainingMs, resumeAs: s.resumeAs === 'break' ? 'break' : 'focus', count, ofTotal: c.every, startedAt: s.startedAt, totalMs: s.totalMs }
    } else if ((phase === 'focus' || phase === 'break') && ends != null && ends > now - STALE_MS) {
      f = { phase, endsAt: ends, startedAt: typeof s.startedAt === 'number' ? s.startedAt : undefined, totalMs: typeof s.totalMs === 'number' ? s.totalMs : undefined, count, ofTotal: c.every }
    }
  }
  if (f.phase !== 'idle') owns = true
  await setFocus($, rt, f, now)
}

function variants(f: FocusView, clock: number, now: number, mode: MascotMode, c: ReturnType<typeof cfg>, drawSvg: boolean): Variant[] {
  const paused = f.phase === 'paused'
  const left = paused ? (f.remainingMs ?? 0) : Math.max(0, (f.endsAt ?? now) - Math.max(clock, now))
  const mm = fmtClock(left)
  const word = paused ? 'PAUSED' : f.phase === 'focus' ? 'FOCUS' : 'BEAN'
  const kind = paused ? (f.resumeAs ?? 'focus') : f.phase
  const total = f.totalMs ?? (kind === 'focus' ? c.focusMin * 60_000 : c.breakMin * 60_000)
  const ratio = total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0
  const meter = termMeterRatio(ratio, METER_CELLS)
  const n = (f.count % f.ofTotal) + 1
  const bites = f.count > 0 && f.count % f.ofTotal === 0 ? f.ofTotal : f.count % f.ofTotal
  const quiet = f.phase === 'focus' && f.endsAt ? `Heads-Up quiet until ${hhmm(f.endsAt, now)}` : ''
  const side = kind === 'focus' ? `Focus ${n} of ${f.ofTotal}` : `${bites} of ${f.ofTotal} bites`
  const sizeOf = (t: string): number => cellWidth(t)
  const mk = (text: string, extra: { side?: string; quiet?: string; meter: boolean }): Variant => {
    const pieces = [
      { k: 'mascot' as const, size: 26, mode },
      { k: 'text' as const, s: word, face: 'pixel' as const, size: 11, fill: V.lAccent },
      { k: 'text' as const, s: mm, face: 'pixel' as const, size: 13 },
      ...(extra.meter ? [{ k: 'meter' as const, ratio, color: V.accent }] : []),
      ...(extra.side ? [{ k: 'text' as const, s: extra.side, face: 'mono' as const, size: 10, fill: V.text2 }] : []),
      ...(extra.quiet ? [{ k: 'text' as const, s: extra.quiet, face: 'mono' as const, size: 10, fill: V.text2 }] : []),
    ]
    const l = drawSvg ? layout(pieces, 8) : { px: sizeOf(text) * 7, svg: '' }
    return { px: l.px, cells: sizeOf(text), svg: l.svg, text, alt: text, dim: paused }
  }
  if (paused) return [mk(`🍅 ${word} ${mm}`, { meter: false })]
  const t1 = `🍅 ${word} ${mm} ${meter} · ${side}${quiet ? ` · ${quiet}` : ''}`
  const t2 = `🍅 ${word} ${mm} ${meter} · ${side}`
  const t3 = `🍅 ${word} ${mm}`
  return [
    mk(t1, { meter: true, side, quiet }),
    mk(t2, { meter: true, side }),
    mk(t3, { meter: false }),
  ]
}

export async function focusStart($: D, rt: Rt): Promise<void> {
  await restore($, rt)
}

function cadence(now: number): number | undefined {
  if ((mirror.phase !== 'focus' && mirror.phase !== 'break') || mirror.endsAt == null) return undefined
  const left = mirror.endsAt - now
  const step = left < 120_000 ? 1000 : left < 600_000 ? 5000 : 30_000
  return Math.max(1, Math.min(step, left))
}

export async function focusTick($: D, rt: Rt, now: number): Promise<number | undefined> {
  if (busy || (mirror.phase !== 'focus' && mirror.phase !== 'break')) return undefined
  busy = true
  try {
    await $.setClock(now)
    if (mirror.endsAt != null && now >= mirror.endsAt) await finish($, rt, 'done')
  } finally {
    busy = false
  }
  return cadence(now)
}

export const focusCommand = command

export async function focusSegments($: D, rt: Rt, e: any): Promise<Segment | null> {
  const f = await $.read('focus')
  if (f.phase === 'idle') return null
  await $.read('clock')
  const now = await $.clock.now()
  const clock = now
  const mode = (optStr(rt.options, 'mascots', 'auto') as MascotMode) || 'auto'
  return { id: 'focus', order: 1, priority: 1, variants: variants(f, clock, now, mode, cfg(rt.options), e?.surface !== 'terminal') }
}
