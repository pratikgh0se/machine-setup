// Typed read-only slices of the other plugins' public atoms (copied from shared/peers.d.ts; the contract must be
// self-contained, so no import). Only the owner writes an atom; a missing atom means "no information".
export type CompactPeerCacheView = {
  state: 'unknown' | 'warm' | 'expiring' | 'cold'
  expiresAt?: number
  ttl: '5m' | '1h'
  ttlSource: 'option' | 'event' | 'learned' | 'cache-tax' | 'settings' | 'assumed'
  keepwarm?: { state: 'on' | 'off' | 'unknown'; untilAt?: number; lastPingAt?: number }
  ctxTokens?: number
  recacheUsd?: number
  savedTodayUsd: number
  hitRatio?: number
  coldWrites: number
  coldUsd: number
}
export type CompactPeerPhase = 'research' | 'plan' | 'build' | 'verify' | 'report'
export type CompactPeerUsage = {
  limits: { kind: 'five_hour' | 'seven_day' | 'spend_limit'; percent: number; resetsAt?: number }[]
  pace: { worst: 'learning' | 'plenty' | 'onpace' | 'hot' | 'limit'; text: string } | null
  cache: CompactPeerCacheView
  context: { percent?: number; toCompact?: number; autoCompact: boolean; compactions: number } | null
  clock: number
}
export type CompactPeerAwareness = {
  now: { phase?: CompactPeerPhase; visited: CompactPeerPhase[]; now: string; done: number; total: number; isComplete: boolean; cmd?: { exe: string; startedAt: number }; specDone?: number; specTotal?: number; specNext?: string }
  focus: { phase: 'idle' | 'focus' | 'break' | 'paused'; endsAt?: number; remainingMs?: number; count: number; ofTotal: number }
  headsup: { mutedUntil?: number; queued: string[]; lastShownAt?: number; shown: number }
  clock: number
}
export type CompactPeerAgents = { mission?: { allDone: boolean; plan?: { path: string; count: number } } }
export type CompactPeerDev = { toast: { lastShownAt?: number; shown: number; held: number } }

export type Moment = 'good' | 'ok' | 'notnow'
export type CoachView = {
  ctx?: number
  model?: string
  warmUsd?: number
  coldUsd?: number
  targetTokens: number
  afterWarmUsd?: number
  saveWarmUsd?: number
  passUsd?: number
  paybackTurns?: number
  score: number
  verdict: Moment
  reasons: string[]
  floorWon: boolean
  lastShownAt?: number
}
export type NudgeView = { armed: boolean; lastK: number; next?: number; window?: number; lastNudgeAt?: number; fresh: 'fresh' | 'stale' | 'none' }
export type HandoffState = 'idle' | 'writing' | 'ready' | 'saved' | 'compacting' | 'done' | 'failed'
export type HandoffView = {
  state: HandoffState
  path?: string
  readyAt?: number
  failures: number
  missing?: string[]
  before?: number
  after?: number
  /** Epoch ms when the state became `done`; the chip shows COMPACTED for a while. */
  doneAt?: number
  /** Short reason shown with `failed`. */
  reason?: string
  noCompact?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    usage: CompactPeerUsage
    awareness: CompactPeerAwareness
    agents: CompactPeerAgents
    dev: CompactPeerDev
    compact: {
      coach: CoachView
      handoff: HandoffView
      orch: { on: boolean }
      resume: { pending: boolean }
      nudge: NudgeView
      clock: number
      agents: { id: string; description: string; status: string }[]
    }
  }
}
