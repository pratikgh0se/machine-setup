// Context windows per model, tokens. AS OF 2026-10-11. Source: https://code.claude.com/docs/en/model-config
// (research/10-compaction-and-orchestration.md lines 16-17, 103-104). Native 1M: Fable, Sonnet 5+, Haiku 5.5+, Opus 4.7+
// (bare aliases fable/opus/sonnet/haiku resolve to the 5.5 family). Older models (Opus <= 4.6, Sonnet 4.x, Haiku < 5.5)
// are 200k. A `[1m]` / `-1m` marker in the id means 1M. Unknown model -> undefined (the row shows tokens, never a guess).
// Overridable via the plugin-level `windowsJson` userConfig (parseWindowsJson), same pattern as shared/prices.ts.
import { modelFamily } from './fmt'
import type { ModelFamily } from './fmt'

export const WINDOWS_AS_OF = '2026-10-11'

const M1 = 1_000_000
const K200 = 200_000

/** Built-in window for a model id; undefined when the model is unknown. */
export function builtinWindow(id: string): number | undefined {
  if (/\[1m\]|-1m\b/.test(id)) return M1
  const fam = modelFamily(id)
  if (fam === 'other') return undefined
  if (fam === 'fable') return M1
  // Version after the name (`sonnet-4-5`, `opus-4.7`, `haiku-5-5`), else before it (`claude-3-5-haiku`: old).
  const after = new RegExp(`${fam}[-_ ]?(\\d{1,2})(?!\\d)(?:[-.](\\d{1,2})(?!\\d))?`).exec(id)
  if (after) {
    const maj = Number(after[1])
    const min = Number(after[2] ?? 0)
    if (fam === 'opus') return maj > 4 || (maj === 4 && min >= 7) ? M1 : K200
    if (fam === 'sonnet') return maj >= 5 ? M1 : K200
    return maj > 5 || (maj === 5 && min >= 5) ? M1 : K200
  }
  if (new RegExp(`\\d[-.]?(?:\\d[-.])?${fam}`).test(id)) return K200
  return M1 // bare alias: resolves to the 5.5 family
}

/** `byFamily` keys are family names; `byId` keys are lowercase substrings of a model id (longest match wins). */
export type WindowOverrides = { asOf?: string; byFamily: Partial<Record<ModelFamily, number>>; byId: Record<string, number> }

const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'other']
const okWin = (n: unknown): n is number => typeof n === 'number' && isFinite(n) && n > 0

/** Parses the `windowsJson` option: `{"asOf":"YYYY-MM-DD","sonnet":200000,"claude-sonnet-5-5":1000000}` or `[["sonnet",200000],...]`. Invalid -> `{ok:false}`. */
export function parseWindowsJson(s: string | undefined): { ok: true; overrides: WindowOverrides } | { ok: false } {
  const empty: WindowOverrides = { byFamily: {}, byId: {} }
  if (!s || !s.trim()) return { ok: true, overrides: empty }
  try {
    const parsed = JSON.parse(s) as unknown
    const o: WindowOverrides = { byFamily: {}, byId: {} }
    const put = (k: string, v: unknown): boolean => {
      if (!okWin(v)) return false
      const key = k.toLowerCase()
      if (FAMILIES.includes(key)) o.byFamily[key as ModelFamily] = v
      else o.byId[key] = v
      return true
    }
    if (Array.isArray(parsed)) {
      for (const r of parsed) {
        if (!Array.isArray(r) || typeof r[0] !== 'string' || !put(r[0], r[1])) return { ok: false }
        if (typeof r[2] === 'string') o.asOf = r[2]
      }
      return { ok: true, overrides: o }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k === 'asOf') {
        if (typeof v === 'string') o.asOf = v
        continue
      }
      put(k, v)
    }
    return { ok: true, overrides: o }
  } catch {
    return { ok: false }
  }
}

/** Window for a model id (override by id, then by family, then the built-in table); undefined when unknown. */
export function windowFor(model: string | undefined, overrides?: WindowOverrides): number | undefined {
  const id = String(model ?? '').toLowerCase()
  if (overrides) {
    const hit = Object.keys(overrides.byId)
      .filter(k => id.includes(k))
      .sort((a, b) => b.length - a.length)[0]
    if (hit !== undefined) return overrides.byId[hit]
  }
  const fam = modelFamily(id)
  const ov = overrides?.byFamily[fam]
  if (ov !== undefined) return ov
  return builtinWindow(id)
}
