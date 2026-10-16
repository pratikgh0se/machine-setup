// Small pure formatting helpers shared by all plugins. No imports.

export const clip = (s: string, max: number): string =>
  s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : s

/** Keeps the start and the end: `src/…/deep/file.ts`. */
export function middleClip(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 3) return s.slice(0, max)
  const keep = max - 1
  const tail = Math.ceil(keep / 2)
  const head = keep - tail
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

export const basename = (p: string): string => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? (parts[parts.length - 1] as string) : p
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g
export const stripAnsi = (s: string): string => s.replace(ANSI, '')

export const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const p2 = (n: number): string => String(Math.floor(n)).padStart(2, '0')

/** MM:SS (minutes can exceed 59, two digits minimum). */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${p2(s / 60)}:${p2(s % 60)}`
}

/** Countdown text: `38:12` under an hour, `1h02m` from an hour up. */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 3600) return fmtClock(ms)
  return `${Math.floor(s / 3600)}h${p2((s % 3600) / 60)}m`
}

/** `45s`, `12 min`, `3h 05m`, `2d 4h`. */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${p2((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

/** `$6.80`, `$0.007` (3 dp under a cent), `-$1.20`. */
export function fmtUsd(n: number, dp = 2): string {
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a > 0 && a < 0.01 && dp === 2) return `${sign}$${a.toFixed(3)}`
  return `${sign}$${a.toFixed(dp)}`
}

/** `350k`, `1.2M`, `850`. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

export const fmtPct = (n: number, dp = 0): string => `${n.toFixed(dp)}%`

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** Local `HH:MM` when `ts` is on the same local date as `now`, else `Ddd HH:MM`. */
export function fmtWhen(ts: number, now: number): string {
  const d = new Date(ts)
  const n = new Date(now)
  const hhmm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return same ? hhmm : `${DAYS[d.getDay()]} ${hhmm}`
}

/** Local date `YYYY-MM-DD`. */
export function localDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** FNV-1a 32-bit hash as 8 hex chars (repo hashes: no path is stored). */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other'
export function modelFamily(id: string | undefined): ModelFamily {
  const m = /(haiku|sonnet|opus|fable)/i.exec(String(id ?? ''))
  return (m ? (m[1] as string).toLowerCase() : 'other') as ModelFamily
}

/** Clamp a number into [lo, hi]. */
export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Parse `5m`, `2h30m`, `90m`, `45s`, `2h` to ms; undefined when not a duration. */
export function parseDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)\s*([dhms])/gi
  let total = 0
  let used = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s.trim()))) {
    const n = parseFloat(m[1] as string)
    const u = (m[2] as string).toLowerCase()
    total += n * (u === 'd' ? 86400000 : u === 'h' ? 3600000 : u === 'm' ? 60000 : 1000)
    used += m[0].length
  }
  const compact = s.replace(/\s+/g, '')
  return used > 0 && used >= compact.length ? total : undefined
}
