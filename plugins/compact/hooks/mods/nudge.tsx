// Handoff nudge (spec F33): pure code. Every `$` call lives in register.tsx.
// The plugin adds one short reminder to a model request that is happening anyway; the model writes its own handoff.

export const HEADINGS = ['## Goal', '## Decisions and why', '## Done', '## In progress', '## Dead ends', '## Exact next step'] as const
export const MIN_BYTES = 300
export const NEAR_TOKENS = 50_000
export const NO_META_MS = 30 * 60_000
export const META_STEP = 10_000

/** `~/.local/state/claude-handoffs/<sid>-agent.md` meta file written by the plugin (F33.4). Times are epoch ms. */
export type NudgeMeta = {
  v: 1
  sessionId: string
  window: number
  ctxTokens: number
  lastNudgeAt?: number
  lastNudgeTokens?: number
  nudgeCount: number
  agentWrittenAt?: number
  agentWrittenAtTokens?: number
}

/**
 * Freshness of the agent-written handoff (F33.4), shared with the PreCompact hook.
 * With a meta: size >= 300 bytes AND an `agentWrittenAt` AND (written at or after the last nudge OR within
 * 50,000 tokens of it). Without a meta: fresh iff `mtimeMs` is within 30 minutes of `now` (size still >= 300).
 */
export function isFresh(meta: NudgeMeta | undefined, size: number, now: number, mtimeMs?: number): boolean {
  if (!(size >= MIN_BYTES)) return false
  if (!meta) return typeof mtimeMs === 'number' && now - mtimeMs <= NO_META_MS
  if (typeof meta.agentWrittenAt !== 'number') return false
  if (typeof meta.lastNudgeAt !== 'number' || meta.agentWrittenAt >= meta.lastNudgeAt) return true
  return typeof meta.agentWrittenAtTokens === 'number' && meta.ctxTokens - meta.agentWrittenAtTokens <= NEAR_TOKENS
}

export const clampPercent = (n: number): number => Math.min(95, Math.max(10, n))
export const clampEvery = (n: number): number => Math.max(10_000, n)

/** `CLAUDE_CODE_AUTO_COMPACT_WINDOW` text -> window, or undefined when not an integer > 0. */
export function parseEnvWindow(s: string | undefined | null): number | undefined {
  if (typeof s !== 'string' || !/^\s*\d+\s*$/.test(s)) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** T(k) = ceil(W * atPercent / 100) + k * everyTokens. */
export const threshold = (w: number, atPercent: number, every: number, k: number): number => Math.ceil((w * atPercent) / 100) + k * every

/** Highest k with T(k) <= t, or -1 when t is below T(0). */
export function highestK(t: number, w: number, atPercent: number, every: number): number {
  const t0 = threshold(w, atPercent, every, 0)
  return t < t0 ? -1 : Math.floor((t - t0) / every)
}

export const kfmt = (n: number): string => `${Math.round(n / 1000)}k`

/** F33.12: single source of the handoffs dir, relative to home. */
export const HANDOFFS_REL = '.local/state/claude-handoffs'
export const handoffsDir = (home: string): string => `${home.replace(/\/+$/, '')}/${HANDOFFS_REL}`
export const agentPathFor = (home: string, sid: string): string => `${handoffsDir(home)}/${sid}-agent.md`
export const metaPathFor = (home: string, sid: string): string => `${handoffsDir(home)}/${sid}-agent.meta.json`

/** F33.3 text, built at arm time. `verb` is `update` when the file exists, else `write`. */
export function nudgeText(t: number, w: number, path: string, exists: boolean): string {
  const pct = Math.floor((t * 100) / w)
  return `[compact] Context is ${pct}% of the auto-compact window (${kfmt(t)} of ${kfmt(w)}). Compaction will drop your working memory. Now, in one Write call, ${exists ? 'update' : 'write'} ${path} (create the folder if missing) with exactly these headings: ${HEADINGS.join(', ')}. Use real paths, commands and ids; no secrets. Then continue the task.`
}

/** F33.11 Resume entry for the agent file (<= 240 chars with a normal path). */
export const agentResumeEntry = (path: string): string =>
  `Context was compacted. Read ${path} first (your own handoff), then continue from its "Exact next step". Check its "In progress" and "Dead ends" before acting.`

export type AgentFresh = 'fresh' | 'stale' | 'none'

/** Runtime state of the nudge (closure per register()). */
export type NudgeRt = {
  sid?: string
  home?: string
  agentPath?: string
  window?: number
  /** `rawMaxTokens` from the usage breakdown and when it was read. */
  rawMax?: number
  rawAt?: number
  lastK: number
  armedK?: number
  armText?: string
  armTokens?: number
  lastNudgeAt?: number
  lastNudgeTokens?: number
  nudgeCount: number
  agentWrittenAt?: number
  agentWrittenAtTokens?: number
  agentSize?: number
  /** ctx at the last meta write. */
  metaTokens?: number
  metaFailedLogged: boolean
  /** JSON of the last published atom value. */
  pub?: string
}

export const makeNudgeRt = (): NudgeRt => ({ lastK: -1, nudgeCount: 0, metaFailedLogged: false })

/** Meta for isFresh / the file, from the runtime. */
export function buildMeta(n: NudgeRt, ctx: number | undefined): NudgeMeta {
  const m: NudgeMeta = { v: 1, sessionId: n.sid ?? 'session', window: n.window ?? 0, ctxTokens: ctx ?? 0, nudgeCount: n.nudgeCount }
  if (n.lastNudgeAt != null) m.lastNudgeAt = n.lastNudgeAt
  if (n.lastNudgeTokens != null) m.lastNudgeTokens = n.lastNudgeTokens
  if (n.agentWrittenAt != null) m.agentWrittenAt = n.agentWrittenAt
  if (n.agentWrittenAtTokens != null) m.agentWrittenAtTokens = n.agentWrittenAtTokens
  return m
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** `/coach` line (F33.5). */
export function nudgeLine(n: NudgeRt, atPercent: number, every: number, fresh: AgentFresh): string {
  const next = n.window ? kfmt(threshold(n.window, atPercent, every, n.lastK + 1)) : '?'
  const last = n.lastNudgeAt == null ? 'never' : `${p2(new Date(n.lastNudgeAt).getHours())}:${p2(new Date(n.lastNudgeAt).getMinutes())}`
  return `handoff nudge: next at ${next} · last ${last} · agent file ${fresh}`
}
