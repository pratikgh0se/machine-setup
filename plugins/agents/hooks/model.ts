// Pure helpers: options, classification, labels, review state, spend arithmetic. No engine calls.
import type { MissionView, PetCostume, PetRun, Spend, Tier } from '../types'
import { clip, fmtClock, fmtUsd, modelFamily } from './_shared/fmt'
import { GLYPH } from './_shared/glyphs'

export { clip, fmtClock, modelFamily }

// ---------------------------------------------------------------------------
// Options (plugin.json userConfig)

// Manifest keys cannot hold dots, so each dotted name is also read as `dotted_name_with_underscores` (dotted wins).
type Raw = Record<string, unknown>
const pick = (x: Raw, k: string): unknown => (x[k] !== undefined ? x[k] : x[k.replace(/\./g, '_')])
const bool = (x: Raw, k: string, d: boolean): boolean => {
  const v = pick(x, k)
  return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d
}
const num = (x: Raw, k: string, d: number): number => {
  const v = pick(x, k)
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : d
}
const str = (x: Raw, k: string, d: string): string => {
  const v = pick(x, k)
  return typeof v === 'string' ? v : d
}

export const DEFAULT_SPEC_GLOBS =
  '**/docs/**/*plan*.md,**/docs/**/*spec*.md,**/plans/**/*.md,**/specs/**/*.md,**/PLAN.md,**/SPEC.md,**/.claude/plans/**/*.md'

export function parseOptions(o: Record<string, unknown> | undefined) {
  const x = o ?? {}
  const mascots = str(x, 'pets.mascots', 'auto')
  const mode = str(x, 'delegation.mode', 'warn')
  const via = str(x, 'mission.stepVia', 'tool')
  return {
    petsOn: bool(x, 'mod.pets.enabled', true),
    reviewOn: bool(x, 'mod.review.enabled', true),
    delegationOn: bool(x, 'mod.delegation.enabled', true),
    missionOn: bool(x, 'mod.mission.enabled', true) && bool(x, 'mission.enabled', true),
    minBandRows: num(x, 'minBandRows', 4),
    mascots: (mascots === 'on' || mascots === 'off' ? mascots : 'auto') as 'auto' | 'on' | 'off',
    maxRuns: Math.max(1, num(x, 'pets.maxRuns', 100)),
    maxDone: Math.max(0, num(x, 'pets.maxDone', 12)),
    autoOpen: bool(x, 'pets.autoOpen', true),
    showChecklist: bool(x, 'showChecklist', false),
    remindMin: num(x, 'review.remindMin', 10),
    includeBackfilled: bool(x, 'review.includeBackfilled', false),
    delegationMode: (mode === 'deny' || mode === 'off' ? mode : 'warn') as 'off' | 'warn' | 'deny',
    allowTypes: str(x, 'delegation.allowTypes', 'savvy-*,*:savvy-*'),
    guardToast: bool(x, 'delegation.toast', true),
    guardGapMs: num(x, 'delegation.minGapMs', 30000),
    nestMode: ((v: string) => (v === 'deny' || v === 'off' ? v : 'warn'))(str(x, 'nesting.mode', 'warn')) as 'off' | 'warn' | 'deny',
    nestAllow: str(x, 'nesting.allowTypes', ''),
    nestToast: bool(x, 'nesting.toast', true),
    nestGapMs: num(x, 'nesting.minGapMs', 30000),
    runawaySteps: Math.max(0, num(x, 'runaway.maxSteps', 100)),
    runawayCtx: Math.max(0, num(x, 'runaway.maxContext', 300000)),
    runawayToast: bool(x, 'runaway.toast', true),
    pricesJson: str(x, 'pricesJson', ''),
    windowsJson: str(x, 'windowsJson', ''),
    stepLine: bool(x, 'mission.stepLine', true),
    stepVia: (via === 'bash' ? 'bash' : 'tool') as 'tool' | 'bash',
    typicalTurns: str(x, 'mission.typicalTurns', '{"Explore":8,"general-purpose":20,"other":15}'),
    maxTiles: Math.max(0, num(x, 'mission.maxTiles', 120)),
    specGlobs: str(x, 'mission.specGlobs', DEFAULT_SPEC_GLOBS),
  }
}
export type Opts = ReturnType<typeof parseOptions>

// ---------------------------------------------------------------------------
// Classification: the first rule that matches wins (unchanged from agent-pets).

export function costumeOf(subagentType: string, description: string): PetCostume {
  const type = String(subagentType ?? '').replace(/^.*:/, '')
  const text = String(description ?? '')
  if (type === 'Explore' || /\b(research|explore|search|find|investigat|look up|crawl|scan|sweep|gather|read\b)/i.test(text)) return 'detective'
  if (/\b(test|verify|validat|check|review|audit|qa|debug)/i.test(text)) return 'scientist'
  if (type === 'Plan' || /\b(plan|design|architect|spec|outline|brainstorm)/i.test(text)) return 'planner'
  if (type === 'claude-code-guide' || /\b(doc|readme|write-?up|summar|explain|report|draft)/i.test(text)) return 'scribe'
  if (/\b(build|implement|fix|code|refactor|add|create|migrat|setup|set up|install|deploy)/i.test(text)) return 'builder'
  return 'plain'
}

export const COSTUME_TAG: Record<PetCostume, string> = {
  detective: 'SCOUT',
  scientist: 'LAB',
  planner: 'PLAN',
  scribe: 'DOCS',
  builder: 'BUILD',
  plain: '',
}
export const costumeEmoji = (c: PetCostume): string => GLYPH[c]

export const tierOf = (model: string | undefined): Tier => modelFamily(model)
export const TIERS: Tier[] = ['fable', 'opus', 'sonnet', 'haiku', 'other']
export const TIER_LABEL: Record<Tier, string> = { fable: 'FABLE', opus: 'OPUS', sonnet: 'SONNET', haiku: 'HAIKU', other: 'OTHER' }
export const TIER_LETTER: Record<Tier, string> = { fable: 'F', opus: 'O', sonnet: 'S', haiku: 'H', other: 'X' }

export const elapsed = (r: { startedAt: number; endedAt?: number }, at: number): number =>
  (r.endedAt ?? Math.max(at, r.startedAt)) - r.startedAt

/** Terminal pet row (unchanged from agent-pets). The desktop Svg alt is this same string. */
export function petLine(r: PetRun, at: number): string {
  return `${costumeEmoji(r.costume)} ${r.costume} · ${r.type} · ${tierOf(r.model)} · ${r.status} ${fmtClock(elapsed(r, at))}${r.status === 'running' && r.runaway ? ' · ⚠ RUNAWAY' : ''} — ${clip(r.description, 60)}`
}

export const isFinished = (r: PetRun): boolean => r.status !== 'running'

// ---------------------------------------------------------------------------
// Review queue

export type RState = 'failed' | 'untested' | 'tests-failed' | 'tests-passed' | 'no-edits'
export const RLABEL: Record<RState, string> = {
  failed: 'FAILED',
  untested: 'UNTESTED',
  'tests-failed': 'TESTS FAILED',
  'tests-passed': 'TESTS PASSED',
  'no-edits': 'NO EDITS',
}
const RRANK: Record<RState, number> = { failed: 0, untested: 1, 'tests-failed': 2, 'tests-passed': 3, 'no-edits': 4 }

export function reviewState(r: PetRun): RState {
  if (r.status === 'failed') return 'failed'
  if (r.tests) return r.lastFail ? 'tests-failed' : 'tests-passed'
  return r.files > 0 ? 'untested' : 'no-edits'
}

/** Unreviewed finished runs in display order: FAILED, UNTESTED, TESTS FAILED, TESTS PASSED, NO EDITS, then oldest first. */
export function queueOf(runs: readonly PetRun[], includeBackfilled: boolean): PetRun[] {
  return runs
    .filter(r => isFinished(r) && !r.reviewed && (!r.isBackfilled || includeBackfilled))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => RRANK[reviewState(a.r)] - RRANK[reviewState(b.r)] || (a.r.endedAt ?? 0) - (b.r.endedAt ?? 0) || a.i - b.i)
    .map(x => x.r)
}

export function reviewDetail(r: PetRun): string {
  const files = r.files === 0 ? 'no edits' : `${r.files} ${r.files === 1 ? 'file' : 'files'}`
  const tests = r.tests ? `${r.tests.pass} pass ${r.tests.fail} fail` : 'no tests'
  return `${files} · ${tests}`
}

/** One queue line. The desktop Svg alt is this same string. */
export function reviewLine(n: number, r: PetRun, at: number): string {
  const s = reviewState(r)
  return `${n}. ${RLABEL[s]} · ${clip(r.description, 60)} · ${tierOf(r.model)} · ${fmtClock(elapsed(r, at))} · ${reviewDetail(r)} · [${s}]`
}

// ---------------------------------------------------------------------------
// Spend

export const EMPTY_SPEND: Spend = {
  byTier: { fable: 0, opus: 0, sonnet: 0, haiku: 0, other: 0 },
  main: 0,
  subagents: 0,
  steps: 0,
  spawns: 0,
  explicit: 0,
  violations: [],
  nested: [],
  nestedCount: 0,
}
export const totalSpend = (s: Spend): number => TIERS.reduce((n, t) => n + s.byTier[t], 0)

/** Bar of `cells` cells, widths proportional to dollars, largest remainder. Tiers with $0 get none. */
export function barCells(s: Spend, cells = 20): Tier[] {
  const total = totalSpend(s)
  if (total <= 0) return []
  const parts = TIERS.map((t, i) => {
    const exact = (s.byTier[t] / total) * cells
    return { t, i, n: Math.floor(exact), rem: exact - Math.floor(exact), has: s.byTier[t] > 0 }
  })
  let left = cells - parts.reduce((n, p) => n + p.n, 0)
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || a.i - b.i)) {
    if (left <= 0) break
    if (!p.has) continue
    p.n++
    left--
  }
  return parts.flatMap(p => Array<Tier>(p.n).fill(p.t))
}
export const barText = (s: Spend, cells = 20): string => `[${barCells(s, cells).map(t => TIER_LETTER[t]).join('')}]`

export function captions(s: Spend): string {
  const ts = TIERS.filter(t => t !== 'other' || s.byTier.other > 0)
  return ts.map(t => `${TIER_LABEL[t]} ${fmtUsd(s.byTier[t])}`).join(' · ')
}

/** Mini footer of the pets pane: `SPEND $9.35 · F $3.10 O $4.90 S $1.20 H $0.15`. */
export function miniSpend(s: Spend): string {
  const ts = TIERS.filter(t => t !== 'other' || s.byTier.other > 0)
  return `SPEND ${fmtUsd(totalSpend(s))} · ${ts.map(t => `${TIER_LETTER[t]} ${fmtUsd(s.byTier[t])}`).join(' ')}`
}

export const EMPTY_VIEW: MissionView = {
  items: [],
  counts: { queued: 0, running: 0, review: 0, done: 0, blocked: 0 },
  total: 0,
  pct: 0,
  stripePct: 0,
  unplanned: 0,
  planName: 'checklist',
}

/** Approximate terminal cell width: emoji and wide symbols take 2. */
export function cellsOf(s: string): number {
  let n = 0
  for (const ch of s) n += (ch.codePointAt(0) ?? 0) >= 0x1f000 ? 2 : 1
  return n
}
