export type Tier = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other'
export type PetCostume = 'detective' | 'scientist' | 'planner' | 'scribe' | 'builder' | 'plain'
export type PetStatus = 'running' | 'done' | 'failed'

export type PetRun = {
  /** The subagent's id (or the spawning tool_use_id when the engine gave none). */
  id: string
  agentId?: string
  type: string
  description: string
  /** The model id (or alias) the subagent runs on. */
  model: string
  costume: PetCostume
  status: PetStatus
  startedAt: number
  endedAt?: number
  /** True when learned from `$.agent.list()` rather than `agent.spawn`. */
  isBackfilled?: boolean
  /** Consecutive syncs a running pet was absent from the live agent list. */
  missed?: number
  /** Distinct files written by the subagent (count only, never paths). */
  files: number
  /** Summed test outcomes of the subagent's Bash test runs. */
  tests?: { pass: number; fail: number; skip: number }
  /** The last test run had failures. */
  lastFail?: boolean
  reviewed?: boolean
  /** `turn.step` events seen for this agent. */
  turns?: number
  /** Context size of the last step (tokens), cumulative tokens, estimated cost. */
  ctx?: number
  tokens?: number
  usd?: number
  /** Context % of the model's window (rounded) and peak context tokens; undefined = window unknown / no step yet. */
  ctxPct?: number
  peak?: number
  /** Effort level or integer budget, and where it was last seen. */
  effort?: string | number
  effortSrc?: 'spawn' | 'step'
  /** Derived at read time from the `runaway` atom: a runaway threshold fired for this agent (F34.3). */
  runaway?: boolean
}

export type Spend = {
  byTier: Record<Tier, number>
  main: number
  subagents: number
  steps: number
  spawns: number
  explicit: number
  violations: { at: number; description: string }[]
  /** `session.measure` cost total, for the footnote. */
  sessionUsd?: number
  /** Nested spawns (F34.2), last 50, and the session count. */
  nested: { at: number; description: string; parent: string }[]
  nestedCount: number
}

export type PetChecklistItem = { id: string; content: string; activeForm?: string; status: 'pending' | 'in_progress' | 'completed' }
export type PetChecklist = { items: PetChecklistItem[]; seq: number }

export type MissionState = 'queued' | 'running' | 'review' | 'done' | 'blocked'
export type StepReport = { done: number; total: number; note?: string; at: number; via: 'own' | 'bash' }
export type MissionItem = {
  id: string
  n: number
  title: string
  srcs: ('checklist' | 'spec' | 'plan')[]
  src: { kind: 'checklist' | 'spec' | 'plan'; ref: string; line?: number }
  srcState: 'todo' | 'doing' | 'done'
  runIds: string[]
}
export type MissionView = {
  items: (MissionItem & { state: MissionState; pct?: number; isEst?: boolean; label?: string })[]
  counts: Record<MissionState, number>
  total: number
  pct: number
  stripePct: number
  unplanned: number
  planName: string
  selected?: string
  filter?: MissionState
  /** The `+N more` button switched the grid to text rows. */
  listView?: boolean
}
export type MissionSrc = {
  checklist: PetChecklist
  /** norm()ed titles of deleted checklist items (never resurrected from lower sources). */
  deleted: string[]
  specName?: string
  specMtime?: number
  spec: { line: number; checked: boolean; text: string }[]
  planName?: string
  plan: { line: number; checked: boolean; text: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    agents: {
      runs: PetRun[]
      spend: Spend
      ui: { autoOpened: boolean }
      checklist: PetChecklist
      guard: { mode: 'off' | 'warn' | 'deny'; nestMode: 'off' | 'warn' | 'deny' }
      /** Runaway counters per subagent id (F34.3). */
      runaway: Record<string, { steps: number; ctx: number; hitSteps?: number; hitCtx?: number }>
      /** Epoch ms, ticked each second while a pet runs, so elapsed clocks redraw. */
      clock: number
      mission: {
        view: MissionView
        steps: Record<string, StepReport>
        links: Record<string, string>
        plan?: { path: string; count: number }
        allDone: boolean
        /** Run-total clock: `epoch` restarts it (new plan), `frozen` stops it (allDone). */
        clock?: { epoch?: number; frozen?: number }
      }
      missionSrc: MissionSrc
    }
  }
}
