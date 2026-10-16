// Orchestrator mode: one constant system-prompt section, ON by default, switchable. Spec s6.
// The section rides `prompt.compose` after `next`, so it survives compaction with no re-injection.

import { rowFor } from '../_shared/prices'
import type { PriceOverrides } from '../_shared/prices'
import { fmtTokens } from '../_shared/fmt'
import { usd2 } from '../core'

export const ORCH_ID = 'compact:orchestrator'
export const ORCH_TEXT =
  'Orchestrator: you reason, spec, review. Sonnet builds; Haiku gathers. Opus/Fable only for hard reasoning, state why. ALWAYS set model explicitly on every Agent call. One scoped brief per agent. Review, do not redo. Parallelise.'


/** What one cold turn costs after the system prompt changes: `$2.80 at 350k on Opus 5.5`. */
export function coldTurnFigure(model: string | undefined, overrides: PriceOverrides | undefined, ctxTokens: number | undefined): string {
  const tokens = ctxTokens && ctxTokens > 0 ? ctxTokens : 350_000
  const r = rowFor(model, { overrides, promptTokens: tokens })
  const [fam, ver] = r.row.id.split('-')
  const label = `${(fam ?? '').charAt(0).toUpperCase()}${(fam ?? '').slice(1)}${ver ? ` ${ver.replace(/>.*/, '')}` : ''}`
  return `${usd2((tokens * r.row.write1h) / 1e6)} at ${fmtTokens(tokens)} on ${label}`
}

export function statusText(on: boolean, env: string): string {
  return [
    `Orchestrator mode: ${on ? 'ON' : 'OFF'} (adds ~100 tokens to the system prompt while on).`,
    `CLAUDE_CODE_SUBAGENT_MODEL: ${env}.`,
    'CLAUDE_CODE_SUBAGENT_MODEL_FORCE: not recommended. It makes the env var beat the per-call model and agent frontmatter, so it blocks deliberate escalation to Opus or Fable. Keep the env var as the fallback, this section as the instruction, and Delegation Guard deny as the enforcement.',
    'This mod never sets env or settings.',
  ].join('\n')
}
