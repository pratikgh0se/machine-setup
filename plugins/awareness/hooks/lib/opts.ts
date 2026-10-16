import type { PluginOptions } from 'claude-code'

export type Opts = PluginOptions

const pick = (o: Opts, names: string | readonly string[]): unknown => {
  // Manifest keys cannot hold dots, so each dotted name is also read as `dotted_name_with_underscores`.
  for (const n of typeof names === 'string' ? [names] : names) {
    if (o[n] !== undefined) return o[n]
    const u = n.replace(/\./g, '_')
    if (u !== n && o[u] !== undefined) return o[u]
  }
  return undefined
}

/** Number option; the first name that is set wins. Defaults live here too (a harness may pass only overrides). */
export function optNum(o: Opts, names: string | readonly string[], d: number): number {
  const v = pick(o, names)
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : d
}
export function optBool(o: Opts, names: string | readonly string[], d: boolean): boolean {
  const v = pick(o, names)
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return d
}
export function optStr(o: Opts, names: string | readonly string[], d: string): string {
  const v = pick(o, names)
  return typeof v === 'string' ? v : d
}
export const modEnabled = (o: Opts, id: string): boolean => optBool(o, `mod.${id}.enabled`, true) && (id !== 'spec' || optBool(o, 'spec.enabled', true))
