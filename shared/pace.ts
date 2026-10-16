// Pace maths (usage.md s1, awareness.md Heads-Up). Pure. Times are epoch ms, percents 0..100.
import { fmtWhen } from './fmt'

export type PaceState = 'learning' | 'plenty' | 'onpace' | 'hot' | 'limit'
export type WindowKind = 'five_hour' | 'seven_day'
export const WINDOW_MS: Record<WindowKind, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 }

export type PaceSample = { t: number; p: number }
export type PaceOpts = {
  hotAt?: number // 100
  plentyBelow?: number // 60
  recentWindowMin?: number // 60
  minElapsedFiveMin?: number // 10
  minElapsedSevenHr?: number // 3
}
export type WindowPace = {
  kind: WindowKind
  state: PaceState
  percent: number
  elapsedMs: number
  rate?: number // percent per ms
  projected?: number // percent at reset, uncapped
  hitAt?: number // only when before reset
  resetsAt?: number
}

/** Least-squares slope (percent per ms) over samples in the last `windowMs`; needs >= 3 samples spanning >= 15 min. Floored at 0. */
export function recentRate(samples: readonly PaceSample[], now: number, windowMs = 3600_000): number | undefined {
  const s = samples.filter(x => x.t <= now && x.t >= now - windowMs)
  if (s.length < 3) return undefined
  const first = s[0] as PaceSample
  const last = s[s.length - 1] as PaceSample
  if (last.t - first.t < 15 * 60_000) return undefined
  const n = s.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const x of s) {
    const dx = x.t - first.t
    sx += dx; sy += x.p; sxx += dx * dx; sxy += dx * x.p
  }
  const den = n * sxx - sx * sx
  if (den === 0) return undefined
  return Math.max(0, (n * sxy - sx * sy) / den)
}

/** True when a reading contradicts the window model: same resetsAt, percent fell by more than 20 points. */
export const isResetJump = (prev: { p: number; resetsAt?: number }, cur: { p: number; resetsAt?: number }): boolean =>
  prev.resetsAt === cur.resetsAt && prev.p - cur.p > 20

/** Pace of one window. five_hour uses the recent slope when available, seven_day the average. */
export function windowPace(a: { kind: WindowKind; percent: number; resetsAt?: number; now: number; samples?: readonly PaceSample[]; lengthMs?: number }, opts: PaceOpts = {}): WindowPace {
  const hotAt = opts.hotAt ?? 100
  const plentyBelow = opts.plentyBelow ?? 60
  const p = a.percent
  const len = a.lengthMs ?? WINDOW_MS[a.kind]
  const base: WindowPace = { kind: a.kind, state: 'learning', percent: p, elapsedMs: 0, resetsAt: a.resetsAt }
  if (p >= 100) return { ...base, state: 'limit' }
  if (a.resetsAt == null) return base
  const start = a.resetsAt - len
  const E = a.now - start
  base.elapsedMs = Math.max(0, E)
  const minE = a.kind === 'five_hour' ? (opts.minElapsedFiveMin ?? 10) * 60_000 : (opts.minElapsedSevenHr ?? 3) * 3600_000
  if (E < minE) return base
  const avg = p / E
  const rec = a.kind === 'five_hour' ? recentRate(a.samples ?? [], a.now, (opts.recentWindowMin ?? 60) * 60_000) : undefined
  const rate = rec ?? avg
  const projected = p + rate * (a.resetsAt - a.now)
  const hit = rate > 0 ? a.now + (100 - p) / rate : undefined
  const hitAt = hit != null && hit < a.resetsAt ? hit : undefined
  const state: PaceState = projected >= hotAt ? 'hot' : projected < plentyBelow ? 'plenty' : 'onpace'
  return { ...base, state, rate, projected, hitAt }
}

const RANK: Record<PaceState, number> = { limit: 4, hot: 3, onpace: 2, plenty: 1, learning: 0 }
/** The worse of two windows: LIMIT > HOT > ON PACE > PLENTY > LEARNING. Ties keep `a`. */
export const worse = (a: WindowPace | undefined, b: WindowPace | undefined): WindowPace | undefined =>
  !a ? b : !b ? a : RANK[b.state] > RANK[a.state] ? b : a

export const windowWord = (k: WindowKind): string => (k === 'seven_day' ? 'weekly' : '5-hour')

/** Forecast sentence per usage.md s1 (terminal text; desktop alt is identical). */
export function paceSentence(w: WindowPace, now: number): string {
  const reset = w.resetsAt != null ? fmtWhen(w.resetsAt, now) : ''
  const proj = w.projected != null ? Math.min(999, Math.round(w.projected)) : 0
  switch (w.state) {
    case 'limit':
      return `${cap(windowWord(w.kind))} limit reached. Resets ${reset}.`
    case 'learning':
      return `Gathering pace, ${Math.floor(w.elapsedMs / 60_000)} min of data`
    case 'hot':
      return w.hitAt != null
        ? `At this pace: ${windowWord(w.kind)} limit ${fmtWhen(w.hitAt, now)} (resets ${reset})`
        : `At this pace: ${windowWord(w.kind)} limit by reset ${reset} (~${proj}%)`
    case 'plenty':
      return `Plenty left: ~${proj}% by reset ${reset}`
    default:
      return `On pace: ~${proj}% by reset ${reset}`
  }
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Chip words (usage.md s1). */
export function paceWord(state: PaceState, terminal: boolean): string {
  const d = { onpace: 'ON PACE', hot: 'RUNNING HOT', plenty: 'PLENTY LEFT', learning: 'LEARNING', limit: 'LIMIT HIT' } as const
  const t = { onpace: 'ON PACE', hot: '🔥 HOT', plenty: '🧊 PLENTY', learning: 'LEARNING', limit: '⛔ LIMIT' } as const
  return (terminal ? t : d)[state]
}

/** Carrot bites: round(sevenDay/25) clamped 0..4. */
export const bites = (sevenDayPct: number): number => Math.max(0, Math.min(4, Math.round(sevenDayPct / 25)))

/** Thin samples to 1 per 5 min beyond 6 h old, drop beyond 7 d; ring-capped at `max`. */
export function thinSamples<T extends { t: number }>(s: readonly T[], now: number, max = 200): T[] {
  const out: T[] = []
  let lastKept = -Infinity
  for (const x of s) {
    if (x.t > now || now - x.t > 7 * 86400_000) continue
    if (now - x.t > 6 * 3600_000 && x.t - lastKept < 5 * 60_000) continue
    out.push(x)
    lastKept = x.t
  }
  return out.length > max ? out.slice(out.length - max) : out
}
