// Handoff nudge (spec F33): pure code. Every `$` call lives in register.tsx.
// The plugin adds one short reminder to a model request that is happening anyway; the model writes its own handoff.

export const HEADINGS = ['## Goal', '## Decisions and why', '## Done', '## In progress', '## Dead ends', '## Exact next step'] as const
export const MIN_BYTES = 300
export const NEAR_TOKENS = 50_000
export const NO_META_MS = 30 * 60_000
export const META_STEP = 10_000
/** F35.1 constants. */
export const STALE_USER_TURNS = 3
export const STALE_TOOL_CALLS = 40
export const FRESH_GRACE_MS = 600_000
/** The two headings whose staleness F35.2 watches (names without `## `), in fixed order. */
export const STALE_TARGETS = ['In progress', 'Exact next step'] as const

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
  /** F35.1, all optional (older readers ignore them). */
  sections?: Record<string, string>
  prevSections?: Record<string, string>
  userTurns?: number
  toolCalls?: number
  lastUserMsgAt?: number
  stale_sections?: string[]
}

/** F35.1: heading text (without `## `) -> first 12 hex chars of SHA-256 over the section body; missing heading = `absent`. */
export async function sectionHashes(text: string): Promise<Record<string, string>> {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const bodies = new Map<string, string[]>()
  let cur: string[] | undefined
  for (const line of lines) {
    if (line.startsWith('## ')) {
      cur = (HEADINGS as readonly string[]).includes(line) && !bodies.has(line) ? [] : undefined
      if (cur) bodies.set(line, cur)
      continue
    }
    cur?.push(line)
  }
  const out: Record<string, string> = {}
  for (const h of HEADINGS) {
    const b = bodies.get(h)
    out[h.slice(3)] = b ? await sha12(b.join('\n').replace(/\s+$/, '')) : 'absent'
  }
  return out
}

async function sha12(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

/** F35.2: stale when both target hashes equal the previous nudge's and enough turns or tool calls passed since. */
export function isStaleSections(cur: Record<string, string>, prev: Record<string, string> | undefined, userTurns: number, toolCalls: number): boolean {
  if (!prev) return false
  for (const t of STALE_TARGETS) if (cur[t] === undefined || cur[t] !== prev[t]) return false
  return userTurns >= STALE_USER_TURNS || toolCalls >= STALE_TOOL_CALLS
}

/**
 * Freshness of the agent-written handoff (F33.4), shared with the PreCompact hook.
 * With a meta: size >= 300 bytes AND an `agentWrittenAt` AND (written at or after the last nudge OR within
 * 50,000 tokens of it), then F35.4: no `stale_sections`, and written no more than 10 min before the last user message
 * (`lastUserMsgAt`, absent = skipped). Without a meta: fresh iff `mtimeMs` is within 30 minutes of `now` (size still >= 300).
 */
export function isFresh(meta: NudgeMeta | undefined, size: number, now: number, mtimeMs?: number, lastUserMsgAt?: number): boolean {
  if (!(size >= MIN_BYTES)) return false
  if (!f33Fresh(meta, now, mtimeMs)) return false
  // F35.4: stale sections and the last-user-message grace.
  if (Array.isArray(meta?.stale_sections) && meta.stale_sections.length > 0) return false
  const lu = lastUserMsgAt ?? meta?.lastUserMsgAt
  if (typeof lu === 'number') {
    const written = Math.max(mtimeMs ?? -Infinity, meta?.agentWrittenAt ?? -Infinity)
    if (written === -Infinity || written < lu - FRESH_GRACE_MS) return false
  }
  return true
}

function f33Fresh(meta: NudgeMeta | undefined, now: number, mtimeMs?: number): boolean {
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

/** F35.3 text (supersedes F33.3), built at arm time. `verb` is `update` when the file exists, else `write`. */
export const STALE_SENTENCE = 'Your last handoff is STALE: "In progress" and "Exact next step" are unchanged since the previous nudge; rewrite them from scratch, do not append.'
export function nudgeText(t: number, w: number, path: string, exists: boolean, stale = false): string {
  const pct = Math.floor((t * 100) / w)
  return `[compact] Context is ${pct}% of the auto-compact window (${kfmt(t)} of ${kfmt(w)}). Compaction will drop your working memory.${stale ? ` ${STALE_SENTENCE}` : ''} Now, in one Write call, ${exists ? 'update' : 'write'} ${path} (create the folder if missing) with exactly these headings: ${HEADINGS.join(', ')}. REWRITE "In progress" and "Exact next step" in place for the current state; never append "DONE since" notes. Move finished items to "Done". Keep the whole file under 5000 chars. Use real paths, commands and ids; no secrets. Then continue the task.`
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
  /** F35.1/F35.2: sections = hashes as of the latest arm, base = as of the latest delivery, prev = what `sections` replaced. */
  sections?: Record<string, string>
  baseSections?: Record<string, string>
  prevSections?: Record<string, string>
  armStale?: boolean
  staleSections?: string[]
  userTurns: number
  toolCalls: number
  lastUserMsgAt?: number
  /** ctx at the last meta write. */
  metaTokens?: number
  metaFailedLogged: boolean
  /** JSON of the last published atom value. */
  pub?: string
}

export const makeNudgeRt = (): NudgeRt => ({ lastK: -1, nudgeCount: 0, metaFailedLogged: false, userTurns: 0, toolCalls: 0 })

/** Meta for isFresh / the file, from the runtime. */
export function buildMeta(n: NudgeRt, ctx: number | undefined): NudgeMeta {
  const m: NudgeMeta = { v: 1, sessionId: n.sid ?? 'session', window: n.window ?? 0, ctxTokens: ctx ?? 0, nudgeCount: n.nudgeCount }
  if (n.lastNudgeAt != null) m.lastNudgeAt = n.lastNudgeAt
  if (n.lastNudgeTokens != null) m.lastNudgeTokens = n.lastNudgeTokens
  if (n.agentWrittenAt != null) m.agentWrittenAt = n.agentWrittenAt
  if (n.agentWrittenAtTokens != null) m.agentWrittenAtTokens = n.agentWrittenAtTokens
  if (n.sections) m.sections = n.sections
  if (n.prevSections) m.prevSections = n.prevSections
  m.userTurns = n.userTurns
  m.toolCalls = n.toolCalls
  if (n.lastUserMsgAt != null) m.lastUserMsgAt = n.lastUserMsgAt
  if (n.staleSections) m.stale_sections = n.staleSections
  return m
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** `/coach` line (F33.5). */
export function nudgeLine(n: NudgeRt, atPercent: number, every: number, fresh: AgentFresh): string {
  const next = n.window ? kfmt(threshold(n.window, atPercent, every, n.lastK + 1)) : '?'
  const last = n.lastNudgeAt == null ? 'never' : `${p2(new Date(n.lastNudgeAt).getHours())}:${p2(new Date(n.lastNudgeAt).getMinutes())}`
  return `handoff nudge: next at ${next} · last ${last} · agent file ${fresh}`
}
