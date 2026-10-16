// State atoms, the Mod shape and the single status line shared by both mods.
import type { EngineInterface } from 'claude-code'
import type { CheckpointView, ProtectView } from '../types'
import { fmtAgo } from './_shared/fmt'
import { GLYPH } from './_shared/glyphs'
import type { Opts } from './options'

// Atoms are declared in each file that reads them (validate reads `atom(...)` consts of the same file only);
// these are the shared initial values.
export const PROTECT_INIT: ProtectView = { mode: 'deny', blocked: 0, allowances: [], extras: [] }
export const CKPT_INIT: CheckpointView = { state: 'idle', count: 0, dirty: false }

export type Ctx = { opts: Opts }

/** The plugin's one status line from both views (pure). undefined = nothing to show. */
export function statusText(p: ProtectView, c: CheckpointView, now: number, opts: Opts, mode?: ProtectView['mode']): string | undefined {
  const parts: string[] = []
  if (opts.protectOn) parts.push(`${GLYPH.protected} protect: ${mode ?? p.mode}${p.blocked > 0 ? ` · ${p.blocked} blocked` : ''}`)
  if (opts.ckptOn) {
    if (c.state === 'unavailable' && c.error === 'host') parts.push(`${GLYPH.checkpoint} needs host commands`)
    else if (c.count > 0 && c.lastAt !== undefined) parts.push(`${GLYPH.checkpoint} #${c.count} ${fmtAgo(now - c.lastAt)} ago`)
  }
  return opts.statusLine && parts.length ? parts.join(' · ') : undefined
}
