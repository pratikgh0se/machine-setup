export type ProtectView = {
  mode: 'off' | 'warn' | 'deny'
  blocked: number
  last?: { path: string; at: number; group: string }
  allowances: { pattern: string; until: number }[]
  extras: string[]
}

export type CheckpointView = {
  state: 'unavailable' | 'idle' | 'running' | 'ok' | 'capped' | 'error'
  count: number
  lastAt?: number
  lastTree?: string
  ref?: string
  dirty: boolean
  error?: string
  /** Epoch ms of the last attempt (throttle for minIntervalSec). */
  lastRunAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    safety: { protect: ProtectView; checkpoint: CheckpointView; clock: number }
  }
}
