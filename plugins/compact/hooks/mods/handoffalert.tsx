// Handoff alert (F36): reads <sid>-degraded.json written by the handoff hooks and shows a toast + band chip.
// Pure code only; every `$` call lives in register.tsx. Spec: specs/compact.md "F36 Degraded handoff alert".
import { chip } from '../_shared/svgkit'
import type { Segment, Variant } from '../_shared/band'

/** Reason code -> human text (hook spec F36.D). `section_errors` carries no names in the file. */
export const REASON_TEXT: Record<string, string> = {
  agent_absent: 'no agent handoff',
  agent_stale: 'agent handoff stale',
  fallback_failed: 'Haiku fallback failed',
  fallback_timeout: 'Haiku fallback timed out',
  section_errors: 'sections unavailable',
  no_health: 'no health record for this compaction',
  handoff_missing: 'no handoff file for this session',
  handoff_old: 'handoff not refreshed for this compaction',
}

export const degradedPath = (home: string, sid: string): string => `${home.replace(/\/$/, '')}/.local/state/claude-handoffs/${sid.replace(/\//g, '_')}-degraded.json`
export const shownKey = (sid: string): string => `handoff:degradedShown:${sid.replace(/\//g, '_')}`

export type AlertFile = { ts: number; reasons: string[]; raw: Record<string, unknown>; cleared: boolean }

/** A valid degraded file, or undefined (missing, unreadable, non-object, v != 1, no usable ts). */
export function parseAlert(body: string | undefined | null): AlertFile | undefined {
  if (typeof body !== 'string' || body.trim() === '') return undefined
  let o: unknown
  try {
    o = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined
  const r = o as Record<string, unknown>
  if (r.v !== 1 || typeof r.ts !== 'string') return undefined
  const ts = Date.parse(r.ts)
  if (!Number.isFinite(ts)) return undefined
  const reasons = Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === 'string') : []
  return { ts, reasons, raw: r, cleared: r.clearedAt !== undefined && r.clearedAt !== null }
}

export const reasonTexts = (codes: readonly string[]): string[] => codes.map(c => REASON_TEXT[c] ?? c)

export function toastLine(texts: readonly string[]): string {
  const t = `HANDOFF DEGRADED · ${texts.join('; ')}`
  return t.length <= 140 ? t : `${t.slice(0, 137)}...`
}

/** Chip text: first reason only, `+n` for the rest, at most 60 chars. */
export function chipText(texts: readonly string[]): string {
  const first = texts[0] ?? 'degraded'
  const more = texts.length > 1 ? ` +${texts.length - 1}` : ''
  const t = `HANDOFF DEGRADED · ${first}${more}`
  if (t.length <= 60) return t
  const room = 60 - `HANDOFF DEGRADED · `.length - more.length - 3
  return `HANDOFF DEGRADED · ${first.slice(0, Math.max(0, room))}...${more}`
}

/** `$.ui.status` fallback prefix (no band): `HANDOFF DEGRADED · <first reason> · ` + the Coach text. */
export const statusPrefix = (texts: readonly string[]): string => `HANDOFF DEGRADED · ${texts[0] ?? 'degraded'}`

/** The same JSON with `clearedAt` set (ISO-8601 UTC); every other field preserved. */
export const clearedBody = (raw: Record<string, unknown>, at: number): string => JSON.stringify({ ...raw, clearedAt: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') })

export type AlertRt = {
  sid?: string
  home?: string
  active: boolean
  reasons: string[]
  ts?: number
  raw?: Record<string, unknown>
  /** Latest `ts` that was cleared; a file with ts <= this is not an alert again. */
  clearedTs: number
  shownTs?: number
  shownLoaded: boolean
  toastQueuedTs?: number
  compactAt?: number
  readsLeft: number
  lastReadAt?: number
  pub?: string
  unreadableLogged: boolean
  clearFailLogged: boolean
  flush?: { cancel(): void }
}

export const makeAlertRt = (): AlertRt => ({ active: false, reasons: [], clearedTs: -Infinity, shownLoaded: false, readsLeft: 0, unreadableLogged: false, clearFailLogged: false })

function variant(label: string): Variant {
  const c = chip(0, 4, label, { signal: 'warn', size: 10 })
  const cells = [...label].length + 2
  return { px: cells * 8 - 16, cells, svg: c.svg, text: label, alt: label }
}

/** First segment of the band while the alert is active (before the Coach). */
export function alertSegment(texts: readonly string[]): Segment {
  const full = chipText(texts)
  const vs = [variant(full)]
  if (full !== 'HANDOFF DEGRADED') vs.push(variant('HANDOFF DEGRADED'))
  vs.push(variant('HANDOFF !'))
  return { id: 'handoffalert', order: 0, priority: 0, pinned: true, variants: vs }
}

/** `/coach` card line. */
export const cardLine = (active: boolean, texts: readonly string[]): string => `handoff health: ${active ? `DEGRADED: ${texts.join('; ')}` : 'ok'}`
