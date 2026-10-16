import type { TypecheckView } from '../../types'
import type { Ctx, D, Mod, ToolAfter } from '../core'
import { chipSegment, plural } from '../ui'
import { GLYPH } from '../_shared/glyphs'
import { fnv1a } from '../_shared/fmt'

type Kind = 'tsc' | 'ruff' | 'eslint'
export type TcErr = { file: string; line: number; col: number; code: string; msg: string }
type Result = { errors: TcErr[]; at: number }
type KS = {
  chain?: Promise<Result | undefined>
  pendingFile?: string
  finished?: Result
  sent: Map<string, string>
  available?: boolean
}

const TS_EXT = /\.(?:ts|tsx|mts|cts)$/
const JS_EXT = /\.(?:js|jsx|mjs|cjs)$/
const PY_EXT = /\.py$/
const ESLINT_CFG = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml']

export const parseTsc = (out: string): TcErr[] => {
  const res: TcErr[] = []
  for (const l of out.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(l.trim())
    if (m) res.push({ file: m[1] as string, line: +(m[2] as string), col: +(m[3] as string), code: m[4] as string, msg: (m[5] as string).trim() })
  }
  return res
}
export const parseRuff = (out: string): TcErr[] => {
  const res: TcErr[] = []
  for (const l of out.split('\n')) {
    const m = /^(.+?):(\d+):(\d+): (\S+) (.*)$/.exec(l.trim())
    if (m) res.push({ file: m[1] as string, line: +(m[2] as string), col: +(m[3] as string), code: m[4] as string, msg: (m[5] as string).trim() })
  }
  return res
}
export const parseEslint = (out: string): TcErr[] => {
  const res: TcErr[] = []
  try {
    const arr = JSON.parse(out) as { filePath: string; messages: { ruleId?: string | null; severity: number; message: string; line?: number; column?: number }[] }[]
    for (const f of arr) for (const m of f.messages ?? []) if (m.severity === 2) res.push({ file: f.filePath, line: m.line ?? 0, col: m.column ?? 0, code: m.ruleId ?? 'eslint', msg: m.message })
  } catch { /* not json */ }
  return res
}

const dirname = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
const norm = (p: string): string => p.replace(/^\.\//, '')
const sameFile = (a: string, b: string): boolean => {
  const x = norm(a)
  const y = norm(b)
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x)
}

export function createTypecheck(ctx: Ctx): Mod {
  const ks: Record<Kind, KS> = { tsc: { sent: new Map() }, ruff: { sent: new Map() }, eslint: { sent: new Map() } }
  const tsconfigCache = new Map<string, string | null>()
  let ruffCmd: 'ruff' | 'python3' | 'none' | undefined
  let eslintOk: boolean | undefined

  const exists = async ($: D, p: string): Promise<boolean> => {
    try { return await $.fs.exists(p) } catch { return false }
  }
  const abs = (f: string): string => (f.startsWith('/') ? f : ctx.root() ? `${ctx.root()}/${norm(f)}` : norm(f))
  const rel = (f: string): string => {
    const r = ctx.root()
    return r && f.startsWith(r + '/') ? f.slice(r.length + 1) : f
  }
  const isTouched = (f: string): boolean => {
    for (const t of ctx.rt.touched) if (sameFile(t, f)) return true
    return false
  }

  const findTsconfig = async ($: D, file: string): Promise<string | null> => {
    const root = ctx.root()
    let dir = dirname(abs(file))
    const start = dir
    if (tsconfigCache.has(start)) return tsconfigCache.get(start) ?? null
    for (let i = 0; i < 40; i++) {
      const cand = `${dir}/tsconfig.json`
      if (await exists($, cand)) { tsconfigCache.set(start, cand); return cand }
      if (!dir || dir === '/' || (root && dir === root)) break
      dir = dirname(dir)
    }
    tsconfigCache.set(start, null)
    return null
  }

  const publish = async ($: D): Promise<void> => {
    const byKind: Record<string, number> = {}
    let errors = 0
    let other = 0
    let kind: Kind | undefined
    let lastAt = 0
    for (const k of ['tsc', 'ruff', 'eslint'] as Kind[]) {
      const f = ks[k].finished
      if (!f) continue
      const touched = f.errors.filter(e => k !== 'tsc' || isTouched(e.file))
      if (touched.length) { byKind[k] = touched.length; errors += touched.length; kind = k }
      other += f.errors.length - touched.length
      lastAt = Math.max(lastAt, f.at)
    }
    const running = (['tsc', 'ruff', 'eslint'] as Kind[]).some(k => !!ks[k].chain)
    const available: Record<string, boolean> = {}
    for (const k of ['tsc', 'ruff', 'eslint'] as Kind[]) if (ks[k].available !== undefined) available[k] = ks[k].available as boolean
    const v: TypecheckView = { errors, other, lastRunAt: lastAt || undefined, kind, running, available, byKind, fedBack: ctx.str('tc.mode', 'context') === 'context' }
    await $.update('typecheck', () => v)
  }

  const runOnce = async ($: D, kind: Kind, file: string): Promise<Result | undefined> => {
    const now = await ctx.safeNow($)
    const root = ctx.root()
    let errors: TcErr[] = []
    if (kind === 'tsc') {
      const tsconfig = await findTsconfig($, file)
      if (!tsconfig) { ks.tsc.available = false; return undefined }
      const localBin = `${root ?? ''}/node_modules/.bin/tsc`
      const bin = root && (await exists($, localBin)) ? [localBin] : ['npx', '--no-install', 'tsc']
      const info = `${ctx.rt.gitDir ?? '/tmp'}/claude-tsc-${fnv1a(tsconfig)}.tsbuildinfo`
      const r = await ctx.proc($, 'tc:tsc', [...bin, '--noEmit', '--incremental', '--tsBuildInfoFile', info, '-p', tsconfig, '--pretty', 'false'], {
        cwd: dirname(tsconfig),
        timeoutMs: ctx.num('tc.timeoutSec', 20) * 1000,
      })
      if (!r.ok) { if (r.reason !== 'busy') ks.tsc.available = false; return undefined }
      errors = parseTsc(`${r.stdout}\n${r.stderr}`)
      if (!errors.length && r.exitCode !== 0 && /missing packages|could not determine executable|command not found|not found/i.test(r.stderr + r.stdout) && !/error TS/.test(r.stdout)) {
        ks.tsc.available = false
        return undefined
      }
      ks.tsc.available = true
    } else if (kind === 'ruff') {
      const tryRun = async (argv: string[]) => ctx.proc($, 'tc:ruff', argv, { cwd: root, timeoutMs: 8000 })
      let r = ruffCmd === 'python3' ? await tryRun(['python3', '-m', 'ruff', 'check', '--output-format=concise', file]) : await tryRun(['ruff', 'check', '--output-format=concise', file])
      if (ruffCmd === undefined && (!r.ok ? r.reason !== 'busy' : r.exitCode === 127 || (r.exitCode === 2 && /No module|not found/i.test(r.stderr)))) {
        r = await tryRun(['python3', '-m', 'ruff', 'check', '--output-format=concise', file])
        if (r.ok && r.exitCode !== 127 && !/No module named ruff/i.test(r.stderr)) ruffCmd = 'python3'
        else ruffCmd = 'none'
      } else if (r.ok && ruffCmd === undefined) ruffCmd = 'ruff'
      if (!r.ok || ruffCmd === 'none') { ks.ruff.available = ruffCmd === 'none' ? false : ks.ruff.available; return undefined }
      ks.ruff.available = true
      errors = parseRuff(r.stdout)
    } else {
      if (eslintOk === undefined) {
        let cfg = false
        for (const n of ESLINT_CFG) if (await exists($, `${root ?? ''}/${n}`)) { cfg = true; break }
        eslintOk = cfg && (await exists($, `${root ?? ''}/node_modules/.bin/eslint`))
      }
      if (!eslintOk) { ks.eslint.available = false; return undefined }
      const r = await ctx.proc($, 'tc:eslint', [`${root}/node_modules/.bin/eslint`, '--no-warn-ignored', '-f', 'json', file], { cwd: root, timeoutMs: 8000 })
      if (!r.ok) return undefined
      ks.eslint.available = true
      errors = parseEslint(r.stdout)
    }
    return { errors, at: now }
  }

  const trigger = ($: D, kind: Kind, file: string): Promise<Result | undefined> => {
    const s = ks[kind]
    if (s.chain) { s.pendingFile = file; return s.chain }
    s.chain = (async () => {
      let f: string | undefined = file
      let res: Result | undefined
      try {
        while (f) {
          s.pendingFile = undefined
          await $.update('typecheck', v => ({ ...v, running: true }))
          try { res = await runOnce($, kind, f) } catch { res = undefined }
          if (res) s.finished = res
          f = s.pendingFile
        }
      } finally {
        s.chain = undefined
        try { await publish($) } catch { /* chip only */ }
        try { await ctx.onChange($) } catch { /* status only */ }
      }
      return res
    })()
    return s.chain
  }
  const kindsFor = (file: string): Kind[] => {
    const out: Kind[] = []
    if (TS_EXT.test(file)) {
      if (ctx.bool('tc.tsc', true)) out.push('tsc')
      if (ctx.bool('tc.eslint', true)) out.push('eslint')
    } else if (JS_EXT.test(file)) {
      if (ctx.bool('tc.eslint', true)) out.push('eslint')
    } else if (PY_EXT.test(file)) {
      if (ctx.bool('tc.ruff', true)) out.push('ruff')
    }
    return out
  }

  const feedback = (kind: Kind, res: Result, loop: string): string[] => {
    const s = ks[kind]
    const touched = res.errors.filter(e => kind !== 'tsc' || isTouched(e.file))
    const others = res.errors.length - touched.length
    const sig = touched.map(e => `${rel(e.file)}|${e.code}|${e.msg}`).sort().join('\n')
    const last = s.sent.get(loop) ?? ''
    if (sig === last) return []
    s.sent.set(loop, sig)
    const tail = others > 0 ? ` (+${plural(others, 'error')} in other files)` : ''
    if (sig === '') return [`TYPECHECK: clean (${kind}).${tail}`]
    const max = ctx.num('tc.maxLines', 10)
    const lines: string[] = []
    let chars = 0
    for (const e of touched) {
      const l = `${rel(e.file)}(${e.line},${e.col}): ${e.code} ${e.msg}`
      if (lines.length >= max || chars + l.length > 2000) break
      lines.push(l)
      chars += l.length + 1
    }
    const more = touched.length - lines.length
    const out = [`TYPECHECK: ${plural(touched.length, 'error')} in files you touched (${kind}):`, ...lines]
    if (more > 0) out.push(`(+${more} more in files you touched)`)
    if (others > 0) out.push(`(+${plural(others, 'error')} in other files)`)
    return [out.join('\n')]
  }

  const statusText = (v: TypecheckView): string => {
    const bits: string[] = []
    for (const k of ['tsc', 'ruff', 'eslint']) {
      const n = v.byKind?.[k]
      if (n) bits.push(`${k}: ${plural(n, 'error')}`)
      else if (v.available[k] === false) bits.push(`${k}: n/a`)
    }
    return bits.length ? bits.join(' · ') : 'clean'
  }

  const mod: Mod = {
    id: 'typecheck',
    end: async () => {
      for (const k of ['tsc', 'ruff', 'eslint'] as Kind[]) ks[k] = { sent: new Map(), available: ks[k].available }
    },
    cwdChanged: async () => { tsconfigCache.clear(); eslintOk = undefined },
    tool: async ($, t: ToolAfter) => {
      const mode = ctx.str('tc.mode', 'context')
      if (mode === 'off' || !t.ok) return
      const tool = String(t.e.tool)
      if (tool !== 'Write' && tool !== 'Edit' && tool !== 'NotebookEdit') return
      const file: string | undefined = t.e.file_path ?? t.e.notebook_path
      if (!file || typeof file !== 'string') return
      await ctx.ready($)
      if (!ctx.rt.hostOk) return
      ctx.rt.touched.add(abs(file))
      const kinds = kindsFor(file)
      if (!kinds.length) return
      const loop = String(t.e.agentId ?? 'main')
      const results = await Promise.all(
        kinds.map(async kind => {
          const budget = (kind === 'tsc' ? ctx.num('tc.timeoutSec', 20) : 8) * 1000
          const p = trigger($, kind, abs(file))
          const timeout = $.clock.sleep(budget).then(() => 'timeout' as const)
          const winner = await Promise.race([p, timeout]).catch(() => 'timeout' as const)
          if (winner === 'timeout') return { kind, res: ks[kind].finished }
          return { kind, res: winner ?? ks[kind].finished }
        }),
      )
      if (mode !== 'context') return
      const lines: string[] = []
      for (const { kind, res } of results) if (res) lines.push(...feedback(kind, res, loop))
      return lines.length ? { context: lines } : undefined
    },
    segment: async $ => {
      const v = await $.read('typecheck')
      if (!v.errors) return null
      const kinds = Object.entries(v.byKind ?? {}).filter(([, n]) => n > 0)
      const label = kinds.map(([k, n]) => `${k.toUpperCase()} ${plural(n, 'error')}`).join(' · ')
      const base = `${GLYPH.warn} ${label}`
      const fed = v.fedBack ? `${base} · fed back to Claude` : base
      return chipSegment('typecheck', 3, 1, [
        { text: fed, signal: 'danger' },
        { text: base, signal: 'danger' },
        { text: `${GLYPH.warn} ${v.errors}`, signal: 'danger' },
      ])
    },
    commands: [
      {
        name: 'typecheck',
        description: 'Typecheck feedback status',
        run: async $ => {
          const v = await $.read('typecheck')
          return { text: `TYPECHECK · ${statusText(v)}${v.other ? ` · ${plural(v.other, 'error')} in other files` : ''}` }
        },
      },
    ],
  }
  return mod
}
