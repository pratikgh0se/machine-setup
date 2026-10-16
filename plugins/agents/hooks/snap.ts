// The state a band or pane draws from, as one plain value (pure; the reads happen in register.tsx).
import type { MissionView, PetChecklist, PetRun, Spend, StepReport } from '../types'
import type { Opts } from './model'

export type Snap = {
  runs: PetRun[]
  spend: Spend
  checklist: PetChecklist
  mission: { view: MissionView; steps: Record<string, StepReport>; links: Record<string, string>; plan?: { path: string; count: number }; allDone: boolean; clock?: { epoch?: number; frozen?: number } }
  guardMode: 'off' | 'warn' | 'deny'
  nestMode: 'off' | 'warn' | 'deny'
  at: number
  opts: Opts
}
