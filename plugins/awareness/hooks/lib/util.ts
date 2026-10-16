import { basename, clip } from '../_shared/fmt'

/** Executable name of a shell command: the first word that is not a VAR=value assignment, as a basename. Never arguments. */
export function exeOf(cmd: string): string {
  for (const w of cmd.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue
    return clip(basename(w.replace(/^["']+|["']+$/g, '')) || 'command', 24)
  }
  return 'command'
}

export const isOkResult = (r: { deny?: unknown; isError?: unknown } | undefined): boolean => !!r && r.deny === undefined && r.isError !== true
