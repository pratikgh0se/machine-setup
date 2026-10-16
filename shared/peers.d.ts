// Typed READ-ONLY slices of the other plugins' public $.state atoms (conventions s2.4, s7.5).
// Only the owner writes an atom; a missing atom (peer not installed) = "no information".
//
// Use in a plugin's types/index.d.ts (replace 'usage' by the plugin's own name so it does not redeclare itself):
//   import type { PeerSlices } from '../hooks/_shared/peers'
//   declare module 'claude-code' {
//     interface PluginState extends PeerSlices<'usage'> { usage: { ...own full contract... } }
//   }
// Or declare single slices: `awareness: PeerAwareness`. Read with literal refs:
//   const { value } = await $.state.get({ plugin: 'usage', key: 'cache' } as const)

// --- usage (usage.md s5) -----------------------------------------------------
export type PeerCacheView = {
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
export type PeerUsage = {
  limits: { kind: 'five_hour' | 'seven_day' | 'spend_limit'; percent: number; resetsAt?: number }[]
  pace: { worst: 'learning' | 'plenty' | 'onpace' | 'hot' | 'limit'; text: string } | null
  /** Read by compact.md (`usage.cache.state|ttl|expiresAt`) and awareness (cache warning). */
  cache: PeerCacheView
  context: { percent?: number; toCompact?: number; autoCompact: boolean; compactions: number } | null
  clock: number
}

// --- awareness (awareness.md s5) -------------------------------------------------
export type PeerPhase = 'research' | 'plan' | 'build' | 'verify' | 'report'
export type PeerAwareness = {
  /** Read by compact.md and the mission board (counts must match). */
  now: { phase?: PeerPhase; visited: PeerPhase[]; now: string; done: number; total: number; isComplete: boolean; cmd?: { exe: string; startedAt: number }; specDone?: number; specTotal?: number; specNext?: string }
  /** `phase: 'focus'` = quiet. */
  focus: { phase: 'idle' | 'focus' | 'break' | 'paused'; endsAt?: number; remainingMs?: number; count: number; ofTotal: number }
  /** `lastShownAt` and `mutedUntil` feed createLimiter peers. */
  headsup: { mutedUntil?: number; queued: string[]; lastShownAt?: number; shown: number }
  clock: number
}

// --- agents (agents.md, mission-board.md s4) ---------------------------------------
export type PeerMission = {
  /** The shared "plan all done" signal: view.total >= 1 and nothing running, in review or blocked. */
  allDone: boolean
  plan?: { path: string; count: number }
}
export type PeerAgents = {
  /** Optional slice published by the mission board (agents 1.1.0). */
  mission?: PeerMission
}

// --- dev (dev.md) ---------------------------------------------------------------------
export type PeerDev = {
  toast: { lastShownAt?: number; shown: number; held: number }
}

// --- compact (compact.md) -------------------------------------------------------------
export type PeerCompact = {
  coach: { lastShownAt?: number; verdict?: 'good' | 'ok' | 'notnow'; ctx?: number }
}

// --- safety: nothing public is read by other plugins ------------------------------------

export type AllPeers = {
  usage: PeerUsage
  awareness: PeerAwareness
  agents: PeerAgents
  dev: PeerDev
  compact: PeerCompact
}
/** All peer slices except the plugin's own: `interface PluginState extends PeerSlices<'usage'> {...}`. */
export type PeerSlices<Self extends keyof AllPeers> = Omit<AllPeers, Self>
