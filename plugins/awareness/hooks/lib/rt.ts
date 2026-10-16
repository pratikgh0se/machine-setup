// Runtime shared by the four mods. Module variables here are caches only (hot reload loses them).
import type { D } from './d'
import type { Opts } from './opts'

export type CmdNames = { focus: string; headsup: string; spec: string; nowdoing: string }

export type Rt = {
  options: Opts
  cwd: string
  /** Slash command names actually registered (a collision renames to `awareness-<name>`). */
  names: CmdNames
  /** Heads-Up entry points other mods call. No-ops while Heads-Up is disabled. */
  hu: {
    onFocusEnd: ($: D) => Promise<void>
  }
  /** Session id (for per-session store keys). */
  sid: string
}

export type ModId = 'headsup' | 'nowdoing' | 'spec' | 'focus'

/** Visible cell width: wide emoji and astral symbols count 2. */
export function cellWidth(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    if (cp === 0xfe0f) continue
    n += cp >= 0x1f000 || cp === 0x23f1 || cp === 0x26d4 || cp === 0x2705 || cp === 0x26a0 ? 2 : 1
  }
  return n
}
