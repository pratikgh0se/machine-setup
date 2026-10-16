import type { CoverageView } from '../../types'
import type { Ctx, D, Mod, ToolAfter } from '../core'
import { chipSegment } from '../ui'
import { GLYPH } from '../_shared/glyphs'
import { fnv1a, fmtWhen } from '../_shared/fmt'
import { detectRunner } from '../_shared/testparse'

const FILES = ['coverage/coverage-summary.json', 'coverage/lcov.info', 'lcov.info', 'coverage.xml', 'coverage/cobertura-coverage.xml', 'coverage.json']
const MAX_BYTES = 4 * 1024 * 1024

export type Lcov = { lf: number; lh: number; brf: number; brh: number; fnf: number; fnh: number; files: { file: string; lf: number; lh: number }[] }
export function parseLcov(text: string): Lcov {
  const r: Lcov = { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0, files: [] }
  let cur: { file: string; lf: number; lh: number } | undefined
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (l.startsWith('SF:')) cur = { file: l.slice(3), lf: 0, lh: 0 }
    else if (l.startsWith('LF:')) { const n = +l.slice(3) || 0; r.lf += n; if (cur) cur.lf += n }
    else if (l.startsWith('LH:')) { const n = +l.slice(3) || 0; r.lh += n; if (cur) cur.lh += n }
    else if (l.startsWith('BRF:')) r.brf += +l.slice(4) || 0
    else if (l.startsWith('BRH:')) r.brh += +l.slice(4) || 0
    else if (l.startsWith('FNF:')) r.fnf += +l.slice(4) || 0
    else if (l.startsWith('FNH:')) r.fnh += +l.slice(4) || 0
    else if (l === 'end_of_record' && cur) { r.files.push(cur); cur = undefined }
  }
  if (cur) r.files.push(cur)
  return r
}

type Reading = { pct: number; file: string; lcov?: Lcov }
const round1 = (n: number): number => Math.round(n * 10) / 10

function parseFile(name: string, text: string, metric: 'lines' | 'statements'): Reading | undefined {
  try {
    if (name.endsWith('coverage-summary.json')) {
      const j = JSON.parse(text)
      const pct = metric === 'statements' ? j?.total?.statements?.pct ?? j?.total?.lines?.pct : j?.total?.lines?.pct ?? j?.total?.statements?.pct
      return typeof pct === 'number' ? { pct, file: name } : undefined
    }
    if (name.endsWith('lcov.info')) {
      const l = parseLcov(text)
      return l.lf > 0 ? { pct: (l.lh / l.lf) * 100, file: name, lcov: l } : undefined
    }
    if (name.endsWith('.xml')) {
      const m = /line-rate="([\d.]+)"/.exec(text.slice(0, 2048))
      return m ? { pct: parseFloat(m[1] as string) * 100, file: name } : undefined
    }
    if (name.endsWith('coverage.json')) {
      const j = JSON.parse(text)
      const p = j?.totals?.percent_covered
      return typeof p === 'number' ? { pct: p, file: name } : undefined
    }
  } catch { /* unreadable */ }
  return undefined
}

export function coverageText(c: CoverageView, warnDrop: number): { text: string; warn: boolean } {
  const warn = c.delta !== undefined && c.delta < -warnDrop
  let s = `${GLYPH.coverage} ${c.pct.toFixed(1)}%`
  if (c.delta !== undefined) s += ` (${c.delta >= 0 ? '+' : '-'}${Math.abs(c.delta).toFixed(1)})`
  if (warn) s += ` ${GLYPH.warn}`
  return { text: s, warn }
}

export function createCoverage(ctx: Ctx): Mod {
  let first: { pct: number; at: number } | undefined
  let lastLcov: Lcov | undefined
  const repoKey = (): string => `cov:base:${fnv1a(ctx.root() ?? 'none')}`
  const metric = (): 'lines' | 'statements' => (ctx.str('coverage.metric', 'lines') === 'statements' ? 'statements' : 'lines')

  const scan = async ($: D, runStart: number): Promise<Reading | undefined> => {
    const root = ctx.root()
    for (const f of FILES) {
      const path = root ? `${root}/${f}` : f
      try {
        const st = await $.fs.stat(path)
        if (st.kind && st.kind !== 'file') continue
        if (st.mtimeMs < runStart - 2000) continue
        if (st.size > MAX_BYTES) continue
        const text = (await $.fs.read(path)) as string
        const rd = parseFile(f, text, metric())
        if (rd) return rd
      } catch { /* missing or unreadable: next candidate */ }
    }
    return undefined
  }

  const onRun = async ($: D, t: ToolAfter): Promise<void> => {
    if (!t.isMain) return
    if (!detectRunner(String(t.e.command ?? ''))) return
    await ctx.ready($)
    const rd = await scan($, t.startedAt)
    if (!rd) return
    const now = await ctx.safeNow($)
    const kind = ctx.str('coverage.baseline', 'session-first') === 'last-clean' ? 'last-clean' : 'session-first'
    let base: number | undefined
    let baseAt: number | undefined
    if (kind === 'session-first') {
      if (!first) first = { pct: rd.pct, at: now }
      else { base = first.pct; baseAt = first.at }
    } else {
      try {
        const st = (await $.store.get(repoKey())) as { v: 1; pct: number; at: number } | undefined
        if (st && st.v === 1 && typeof st.pct === 'number') { base = st.pct; baseAt = st.at }
      } catch { /* none */ }
      const r = await ctx.proc($, 'git', ['git', 'status', '--porcelain'], { cwd: ctx.root(), timeoutMs: 5000 })
      if (r.ok && r.exitCode === 0 && r.stdout.trim() === '') {
        try { await $.store.set(repoKey(), { v: 1, pct: round1(rd.pct), at: now }) } catch { /* memory only */ }
      }
    }
    lastLcov = rd.lcov
    const delta = base === undefined ? undefined : round1(round1(rd.pct) - round1(base))
    const view: CoverageView = { pct: round1(rd.pct), metric: metric(), base: base === undefined ? undefined : round1(base), delta, at: now, file: rd.file, baseKind: kind, baseAt }
    await $.update('coverage', () => view)
    await ctx.onChange($)
  }

  return {
    id: 'coverage',
    start: async () => { first = undefined },
    end: async $ => { first = undefined; lastLcov = undefined; await $.update('coverage', () => null) },
    tool: async ($, t) => { if (String(t.e.tool) === 'Bash') await onRun($, t) },
    segment: async $ => {
      const c = await $.read('coverage')
      if (!c) return null
      const warnDrop = ctx.num('coverage.warnDropPts', 1)
      const { text, warn } = coverageText(c, warnDrop)
      const plain = `${GLYPH.coverage} ${c.pct.toFixed(1)}%`
      return chipSegment('coverage', 2, 5, [
        { text, signal: warn ? 'warn' : 'ok' },
        { text: plain, signal: warn ? 'warn' : 'ok' },
      ])
    },
    commands: [
      {
        name: 'coverage',
        description: 'Coverage total, delta and worst changed files',
        run: async $ => {
          const c = await $.read('coverage')
          if (!c) return { text: 'No coverage file found. Run the tests with coverage (vitest --coverage, pytest --cov).' }
          const now = await ctx.safeNow($)
          const out = [`COVERAGE · ${c.pct.toFixed(1)}% ${c.metric}${c.delta !== undefined ? ` (${c.delta >= 0 ? '+' : '-'}${Math.abs(c.delta).toFixed(1)})` : ''}`]
          out.push(c.base !== undefined ? `Baseline ${c.base.toFixed(1)}% (${c.baseKind}${c.baseAt ? `, ${fmtWhen(c.baseAt, now)}` : ''})` : `Baseline: this reading (${c.baseKind})`)
          out.push(`Source ${c.file}`)
          if (lastLcov) {
            const changed = (await $.read('changes')).rows.map(r => r.path)
            const worst = lastLcov.files
              .filter(f => f.lf > 0 && changed.some(p => f.file === p || f.file.endsWith('/' + p) || p.endsWith('/' + f.file)))
              .map(f => ({ file: f.file, pct: (f.lh / f.lf) * 100 }))
              .sort((a, b) => a.pct - b.pct)
              .slice(0, 3)
            if (worst.length) out.push('Worst changed files:', ...worst.map(w => `${w.file} ${w.pct.toFixed(1)}%`))
          }
          return { text: out.join('\n') }
        },
      },
    ],
  }
}
