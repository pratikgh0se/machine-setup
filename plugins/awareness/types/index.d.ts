export type Phase = 'research' | 'plan' | 'build' | 'verify' | 'report'

/** Public: Now Doing, read by compact and the mission board (counts must match). */
export type NowView = {
  phase?: Phase
  visited: Phase[]
  /** The sentence after `now:`; basenames only, never a full path. */
  now: string
  done: number
  total: number
  isComplete: boolean
  cmd?: { exe: string; startedAt: number }
  specDone?: number
  specTotal?: number
  specNext?: string
}

/** Public: `phase: 'focus'` means Heads-Up (and `dev` toasts) are quiet. */
export type FocusView = {
  phase: 'idle' | 'focus' | 'break' | 'paused'
  endsAt?: number
  remainingMs?: number
  count: number
  ofTotal: number
  /** Added fields, all optional. */
  startedAt?: number
  totalMs?: number
  resumeAs?: 'focus' | 'break'
}

/** Public: `lastShownAt` and `mutedUntil` feed the toast limiters of peers. */
export type HeadsUpView = { mutedUntil?: number; queued: string[]; lastShownAt?: number; shown: number }

/** Private: Now Doing internals (a hot reload must not lose them). */
export type NdState = {
  /** A main turn is running (turn.start .. turn.complete). */
  turn: boolean
  phase?: Phase
  visited: Phase[]
  /** Phase and visited as they were before the last tool call (to undo a read-only Bash). */
  prev?: { phase?: Phase; visited: Phase[] }
  /** Sentence derived from the last tool call. */
  derived: string
  /** Sentence from mcp__awareness__phase. */
  note?: string
  toolDone?: number
  toolTotal?: number
  checklist: { items: { id: string; content: string; activeForm?: string; status: 'pending' | 'in_progress' | 'completed' }[]; seq: number }
  cmd?: { exe: string; startedAt: number; id?: string }
  /** The last finished turn's final state, for `/nowdoing` while idle (never drawn in the band). */
  last?: { phase?: Phase; now: string; endedAt: number; done?: number; total?: number }
}

/** Private: Spec Tracker. Labels (<= 60 chars) live in state only. */
export type SpecState = {
  path?: string
  pinned: boolean
  done: number
  total: number
  next?: string
  mtimeMs?: number
  missing?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    // Peer slices this plugin may read (typed copies of the owners' public atoms; a missing atom = no information).
    usage: {
      limits: { kind: 'five_hour' | 'seven_day' | 'spend_limit'; percent: number; resetsAt?: number }[]
      pace: { worst: 'learning' | 'plenty' | 'onpace' | 'hot' | 'limit'; text: string } | null
      cache: {
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
      context: { percent?: number; toCompact?: number; autoCompact: boolean; compactions: number } | null
      clock: number
    }
    agents: { mission?: { allDone: boolean; plan?: { path: string; count: number } } }
    dev: { toast: { lastShownAt?: number; shown: number; held: number } }
    compact: { coach: { lastShownAt?: number; verdict?: 'good' | 'ok' | 'notnow'; ctx?: number } }
    awareness: {
      now: NowView
      focus: FocusView
      headsup: HeadsUpView
      /** Epoch ms, ticked each second while a countdown or timer is visible, so the band redraws. */
      clock: number
      nd: NdState
      sp: SpecState
    }
  }
}
