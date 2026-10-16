// Typed view of the plugin's userConfig options (conventions s1.5). Every field has the manifest default.
import type { PluginOptions } from 'claude-code'
import { splitGlobs } from './_shared/glob'
import { DEFAULT_EXCLUDE } from './_shared/snapshot'

export type Mode = 'off' | 'warn' | 'deny'
export type McpRule = { tool: string; arg: string }

export type Opts = {
  protectOn: boolean
  ckptOn: boolean
  mode: Mode
  env: boolean
  lockfiles: boolean
  vault: boolean
  globs: string[]
  allow: string[]
  bash: boolean
  maxAllowMin: number
  ci: boolean
  mcpRules: McpRule[]
  minIntervalSec: number
  keepDays: number
  maxUntracked: number
  maxPerSession: number
  exclude: string[]
  statusLine: boolean
}

// userConfig keys cannot contain dots (validate: "Invalid key in record"), so the manifest spells
// `protect.mode` as `protect_mode`. Both spellings are read; the dotted one wins when present.
const pick = (o: PluginOptions, k: string): PluginOptions[string] | undefined => o[k] ?? o[k.replace(/\./g, '_')]

const bool = (o: PluginOptions, k: string, d: boolean): boolean => {
  const v = pick(o, k)
  return typeof v === 'boolean' ? v : v === 'false' ? false : v === 'true' ? true : d
}
const num = (o: PluginOptions, k: string, d: number): number => {
  const v = pick(o, k)
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : d
}
const str = (o: PluginOptions, k: string, d: string): string => {
  const v = pick(o, k)
  return typeof v === 'string' ? v : d
}

const DEFAULT_ALLOW = '.env.example,.env.sample,.env.template,.env.*.example,.env.*.sample'

export function parseMcpRules(s: string): McpRule[] {
  try {
    const v: unknown = JSON.parse(s)
    if (!Array.isArray(v)) return []
    const out: McpRule[] = []
    for (const r of v) {
      const x = r as { tool?: unknown; arg?: unknown }
      if (x && typeof x.tool === 'string' && typeof x.arg === 'string') out.push({ tool: x.tool, arg: x.arg })
    }
    return out
  } catch {
    return []
  }
}

export function readOpts(o: PluginOptions): Opts {
  const m = str(o, 'protect.mode', 'deny')
  return {
    protectOn: bool(o, 'mod.protect.enabled', true),
    ckptOn: bool(o, 'mod.checkpoint.enabled', true) && bool(o, 'checkpoint.enabled', true),
    mode: m === 'warn' || m === 'off' ? m : 'deny',
    env: bool(o, 'protect.group.env', true),
    lockfiles: bool(o, 'protect.group.lockfiles', true),
    vault: bool(o, 'protect.group.vault', true),
    globs: splitGlobs(str(o, 'protect.globs', '')),
    allow: splitGlobs(str(o, 'protect.allow', DEFAULT_ALLOW)),
    bash: bool(o, 'protect.bash', true),
    maxAllowMin: num(o, 'protect.maxAllowMin', 60),
    ci: bool(o, 'protect.caseInsensitive', true),
    mcpRules: parseMcpRules(str(o, 'protect.mcpRules', '[]')),
    minIntervalSec: num(o, 'checkpoint.minIntervalSec', 120),
    keepDays: num(o, 'checkpoint.keepDays', 14),
    maxUntracked: num(o, 'checkpoint.maxUntracked', 2000),
    maxPerSession: num(o, 'checkpoint.maxPerSession', 500),
    exclude: splitGlobs(str(o, 'checkpoint.exclude', DEFAULT_EXCLUDE.join(','))),
    statusLine: bool(o, 'checkpoint.statusLine', true),
  }
}
