import type { Register } from 'claude-code'
import { registerCheckpoint } from './mods/checkpoint'
import { registerProtect } from './mods/protect'
import { readOpts } from './options'

// One module per plugin (R:12): register.tsx wires the mods. A disabled mod registers no hooks.
export const register: Register = (on, options) => {
  const opts = readOpts(options)
  if (opts.protectOn) registerProtect(on, { opts })
  if (opts.ckptOn) registerCheckpoint(on, { opts })
}
