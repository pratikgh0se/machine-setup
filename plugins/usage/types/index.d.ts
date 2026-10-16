// Public contract of the `usage` plugin (usage.md s5). Other plugins READ these atoms (conventions s2.4):
//   const { value } = await $.state.get({ plugin: 'usage', key: 'cache' } as const)
// A missing atom (plugin not installed) means "no information". Only `usage` writes them.

export type UsageWindow = { kind: 'five_hour' | 'seven_day' | 'spend_limit'; percent: number; resetsAt?: number }
export type PaceState = 'learning' | 'plenty' | 'onpace' | 'hot' | 'limit'
export type PaceWindowView = { state: PaceState; projected?: number; hitAt?: number }
export type PaceView = { five?: PaceWindowView; seven?: PaceWindowView; worst: PaceState; text: string }
export type CacheState = 'unknown' | 'warm' | 'expiring' | 'cold'
export type CacheView = {
  state: CacheState
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
export type ContextView = {
  percent?: number
  toCompact?: number
  autoCompact: boolean
  compactions: number
  lastCompact?: { before: number; after: number; at: number }
}

/** One reading of the two plan windows (percent 0..100) with the reset of the window it belongs to. */
export type UsageSample = { t: number; five?: number; seven?: number; r5?: number; r7?: number }

/** Internal model behind the views. Not a public contract: peers read `limits|pace|cache|context|clock` only. */
export type UsageCore = {
  sid?: string
  merged?: boolean
  seenMeasure: boolean
  hasRateLimits: boolean
  readingAt?: number
  cost?: number
  samples: UsageSample[]
  /** kind -> resetsAt (0 when unknown) of a window whose reading contradicted the 5 h / 7 d model. */
  learning: { five_hour?: number; seven_day?: number }
  lastReq?: number
  forcedCold: boolean
  resumeUsd?: number
  ttlEvent?: '5m' | '1h'
  learned?: { ttl: '5m' | '1h'; at: number; family?: string }
  /** Trimmed slice of `$.settings.read()`: only what cache-tax detection needs. */
  settings?: {
    enabledPlugins?: Record<string, boolean>
    pluginConfigs?: Record<string, { options?: Record<string, string> }>
    promptCacheTtl?: string
  }
  prev?: { at: number; total: number }
  reqs: { read: number; creation: number; input: number }[]
  /** Sum of the other sessions' `cache:day:<date>:*` savings, rescanned at most once a minute (outside render). */
  othersSaved?: { date: string; at: number; sum: number }
  day: { date: string; saved: number; reads: number; writes: number; reqs: number }
  coldWrites: number
  coldUsd: number
  model?: string
  ctxTokens?: number
  lastInputTotal?: number
  lastPingAt?: number
  kw?: { state: 'on' | 'off'; untilAt?: number; at: number }
  ctx: { percent?: number; tokens?: number; window?: number; threshold?: number; thresholdAt?: number; thresholdModel?: string; autoCompact: boolean }
  compactions: number
  lastCompact?: { before?: number; after?: number; at: number }
  compactPending?: boolean
  wrote: Record<string, number>
  dirty: Record<string, boolean>
}

declare module 'claude-code' {
  interface PluginState {
    usage: {
      limits: UsageWindow[]
      pace: PaceView | null
      cache: CacheView
      context: ContextView | null
      /** Epoch ms, ticked while a countdown is visible, so the band and the pane redraw. */
      clock: number
      /** Internal model (see UsageCore). */
      core: UsageCore
    }
  }
}
