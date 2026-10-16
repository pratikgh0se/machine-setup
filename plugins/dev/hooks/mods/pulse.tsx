import type { TestRun } from '../../types'
import type { Ctx, D, Mod, ToolAfter } from '../core'
import { chipSegment, fmtDuration, plural } from '../ui'
import { GLYPH } from '../_shared/glyphs'
import { fnv1a, fmtWhen } from '../_shared/fmt'
import { detectRunner, exitStatus, parseGo, parseTestOutput } from '../_shared/testparse'

// Kept for importers: the go rule now lives in shared/testparse.ts.
export { parseGo }

const MAX_RUNS = 20
const DECAY_MS = 14 * 24 * 3600 * 1000
type FlakyStore = { v: 1; t: Record<string, { n: number; at: number }> }

/** Chip text for the latest run. */
export function pulseText(run: TestRun, flaky: number): string {
  let body: string
  if (!run.hasSummary) body = run.exitOnly ? (run.exitCode !== undefined ? `ran, failed (exit ${run.exitCode})` : 'ran, failed') : run.exitOk ? 'ran, ok' : 'ran, no summary'
  else {
    const u = run.unit === 'pkgs' ? ' pkg' : ''
    body = [`${run.pass}${u} pass`, run.fail ? `${run.fail}${u} fail` : '', run.skip ? `${run.skip}${u} skip` : ''].filter(Boolean).join(' ')
  }
  const dur = run.hasSummary ? fmtDuration(run.durationMs) : undefined
  let s = `${GLYPH.tests} ${body}${dur ? ` · ${dur}` : ''} · ${run.runner}`
  if (run.editsSince > 0) s += ` · stale (${plural(run.editsSince, 'edit')})`
  if (flaky > 0) s += ` · ${GLYPH.warn} ${flaky} flaky`
  return s
}

export function createPulse(ctx: Ctx): Mod {
  let store: FlakyStore | undefined
  let storeKey: string | undefined

  const key = (): string => `pulse:flaky:${fnv1a(ctx.root() ?? 'none')}`
  const loadStore = async ($: D): Promise<FlakyStore> => {
    const k = key()
    if (store && storeKey === k) return store
    storeKey = k
    let v: FlakyStore = { v: 1, t: {} }
    try {
      const raw = (await $.store.get(k)) as FlakyStore | undefined
      if (raw && raw.v === 1 && raw.t) v = raw
    } catch { /* memory only */ }
    store = v
    return v
  }
  const saveStore = async ($: D): Promise<void> => {
    if (!store) return
    try { await $.store.set(key(), store) } catch { /* memory only */ }
  }
  const flakyList = (now: number): { name: string; flips: number }[] =>
    Object.entries(store?.t ?? {})
      .filter(([, x]) => now - x.at <= DECAY_MS)
      .map(([name, x]) => ({ name, flips: x.n }))
      .sort((a, b) => b.flips - a.flips)
  const publishFlaky = async ($: D, now: number): Promise<void> => {
    const l = flakyList(now)
    const names = l.slice(0, ctx.num('pulse.maxNames', 20))
    await $.update('flaky', () => ({ count: l.filter(x => x.flips >= 2).length, names }))
  }

  const onBash = async ($: D, t: ToolAfter): Promise<void> => {
    if (!t.isMain && !ctx.bool('pulse.includeSubagents', false)) return
    const cmd = String(t.e.command ?? '')
    const runner = detectRunner(cmd)
    if (!runner) return
    const r = t.ran?.result
    const stdout = r && typeof r === 'object' && typeof r.stdout === 'string' ? r.stdout : typeof t.ran?.text === 'string' ? t.ran.text : ''
    const stderr = r && typeof r === 'object' && typeof r.stderr === 'string' ? r.stderr : ''
    const parsed = parseTestOutput(runner, `${stdout}\n${stderr}`, cmd)
    const now = await ctx.safeNow($)
    let exit: ReturnType<typeof exitStatus>
    if (!parsed.hasSummary) exit = exitStatus(typeof t.ran?.text === 'string' && t.ran.text ? t.ran.text : stdout, t.ok ? undefined : true) ?? (t.ok ? { failed: false } : undefined)
    const run: TestRun = {
      at: now,
      runner: parsed.runner === 'unknown' ? runner : parsed.runner,
      pass: parsed.pass,
      fail: exit?.failed ? 1 : parsed.fail,
      skip: parsed.skip,
      durationMs: parsed.durationMs,
      failed: parsed.failed.slice(0, ctx.num('pulse.maxNames', 20)),
      hasSummary: parsed.hasSummary,
      editsSince: 0,
      unit: parsed.unit,
      ...(exit?.failed ? { exitOnly: true, exitCode: exit.code } : exit ? { exitOk: true } : {}),
    }
    const prev = [...(await $.read('runs'))].reverse().find(x => x.runner === run.runner)
    await $.update('runs', rs => [...rs, run].slice(-MAX_RUNS * 3))
    if (ctx.bool('pulse.flaky', true) && prev && run.hasSummary && prev.hasSummary && prev.editsSince === 0) {
      const st = await loadStore($)
      let changed = false
      for (const n of prev.failed) {
        if (!run.failed.includes(n)) {
          const cur = st.t[n]
          st.t[n] = { n: (cur && now - cur.at <= DECAY_MS ? cur.n : 0) + 1, at: now }
          changed = true
        }
      }
      if (changed) await saveStore($)
    }
    if (ctx.bool('pulse.flaky', true)) { await loadStore($); await publishFlaky($, now) }
  }

  return {
    id: 'pulse',
    start: async $ => { await ctx.ready($); await loadStore($); await publishFlaky($, await ctx.safeNow($)) },
    cwdChanged: async () => { store = undefined },
    end: async $ => { await $.update('runs', () => []) },
    tool: async ($, t) => {
      const tool = String(t.e.tool)
      if (t.ok && (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit')) {
        await $.update('runs', rs => rs.map(r => ({ ...r, editsSince: r.editsSince + 1 })))
        return
      }
      if (tool === 'Bash') await onBash($, t)
    },
    segment: async $ => {
      const runs = await $.read('runs')
      const run = runs[runs.length - 1]
      if (!run) return null
      const fl = ctx.bool('pulse.flaky', true) ? (await $.read('flaky')).count : 0
      const sig = run.exitOnly ? 'danger' : run.exitOk ? 'ok' : !run.hasSummary ? undefined : run.fail > 0 ? 'danger' : 'ok'
      const full = pulseText(run, fl)
      const mid = pulseText({ ...run, durationMs: undefined, editsSince: 0 }, 0).replace(/ · [a-z]+$/, '')
      const min = `${GLYPH.tests} ${run.exitOnly ? 'ran, failed' : run.exitOk ? 'ran, ok' : run.hasSummary ? (run.fail ? `${run.fail}${run.unit === 'pkgs' ? ' pkg' : ''} fail` : `${run.pass}${run.unit === 'pkgs' ? ' pkg' : ''} pass`) : 'ran'}`
      return chipSegment('pulse', 1, 2, [{ text: full, signal: sig, dim: !run.hasSummary && !run.exitOnly && !run.exitOk }, { text: mid, signal: sig, dim: !run.hasSummary && !run.exitOnly && !run.exitOk }, { text: min, signal: sig, dim: !run.hasSummary && !run.exitOnly && !run.exitOk }])
    },
    commands: [
      {
        name: 'pulse',
        description: 'Last test runs and flaky tests',
        run: async $ => {
          const runs = await $.read('runs')
          const now = await ctx.safeNow($)
          if (!runs.length) return { text: 'No test run seen yet this session.' }
          const lines = runs.slice(-5).reverse().map(r => `${pulseText({ ...r, editsSince: 0 }, 0).replace(`${GLYPH.tests} `, '')} · ${fmtWhen(r.at, now)}`)
          await loadStore($)
          const fl = flakyList(now).slice(0, ctx.num('pulse.maxNames', 20))
          const out = ['TEST PULSE · last runs', ...lines]
          const last = runs[runs.length - 1]
          if (last && last.failed.length) out.push(`failing: ${last.failed.slice(0, 5).join(', ')}${last.failed.length > 5 ? ` +${last.failed.length - 5} more` : ''}`)
          if (fl.length) out.push('Flaky candidates:', ...fl.map(f => `${f.name} (flips ${f.flips})`))
          return { text: out.join('\n') }
        },
      },
    ],
  }
}
