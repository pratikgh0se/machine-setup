import type { ChangeRow } from '../../types'
import { createThrottle } from '../core'
import type { Ctx, D, Mod, ToolAfter } from '../core'
import { chipSegment, plural } from '../ui'
import { GLYPH } from '../_shared/glyphs'
import { fmtWhen, middleClip } from '../_shared/fmt'
import { parseNameStatusZ, parseNumstatZ, snapshotTree } from '../_shared/snapshot'

const MAX_FILES = 2000

/** Counts `+` / `-` lines of a structuredPatch (hunks with `lines`, or bare lines). */
export function countPatch(sp: unknown): { add: number; del: number } {
  let add = 0
  let del = 0
  const line = (l: unknown): void => {
    if (typeof l !== 'string') return
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  if (Array.isArray(sp)) {
    for (const h of sp) {
      if (typeof h === 'string') line(h)
      else if (h && Array.isArray((h as { lines?: unknown }).lines)) for (const l of (h as { lines: unknown[] }).lines) line(l)
    }
  }
  return { add, del }
}

const toLf = (s: string): string => (s.includes('\0') ? s : s.replace(/\n/g, '\0'))
const bar = (r: ChangeRow): string => {
  if (r.bin) return '········'
  const t = r.add + r.del
  const a = t ? Math.max(r.add ? 1 : 0, Math.round((8 * r.add) / t)) : 0
  return '█'.repeat(Math.min(8, a)) + '▒'.repeat(8 - Math.min(8, a))
}

export function createDiff(ctx: Ctx): Mod {
  let base: string | undefined
  let snapRows: ChangeRow[] = []
  const tools = new Map<string, { add: number; del: number; status: 'A' | 'M' }>()
  let since = 0

  const rel = (p: string): string => {
    const r = ctx.root()
    return r && p.startsWith(r + '/') ? p.slice(r.length + 1) : p
  }

  const publish = async ($: D): Promise<void> => {
    const noBase = base === undefined
    let rows: ChangeRow[]
    if (noBase) rows = [...tools].map(([path, x]) => ({ path, status: x.status, add: x.add, del: x.del, touched: true }))
    else {
      const have = new Set(snapRows.map(r => r.path))
      rows = [...snapRows, ...[...tools].filter(([p]) => !have.has(p)).map(([path, x]) => ({ path, status: 'M' as const, add: x.add, del: x.del, touched: true }))]
    }
    rows.sort((a, b) => b.add + b.del - (a.add + a.del))
    const capped = rows.slice(0, MAX_FILES)
    const add = capped.reduce((n, r) => n + r.add, 0)
    const del = capped.reduce((n, r) => n + r.del, 0)
    await $.update('changes', () => ({ rows: capped, files: rows.length, add, del, since, toolsOnly: noBase }))
    await ctx.onChange($)
  }

  const snap = async ($: D) => {
    const run = ctx.runner($)
    const exists = async (p: string): Promise<boolean> => {
      try { return await $.fs.exists(p) } catch { return false }
    }
    return snapshotTree(run, { cwd: ctx.root(), name: 'diff', sid: ctx.rt.sid, exists })
  }

  const startBase = async ($: D): Promise<void> => {
    await ctx.ready($)
    since = await ctx.safeNow($)
    base = undefined
    snapRows = []
    tools.clear()
    if (ctx.rt.hostOk) {
      const r = await snap($)
      if (r.ok) base = r.tree
    }
    await publish($)
  }

  const refreshCur = async ($: D): Promise<void> => {
    await ctx.ready($)
    if (!ctx.rt.hostOk || !base) return
    const r = await snap($)
    if (!r.ok) return
    const run = ctx.runner($)
    const cwd = ctx.root()
    const [ns, st] = await Promise.all([run(['git', 'diff', '--numstat', '-z', base, r.tree], { cwd }), run(['git', 'diff', '--name-status', '-z', base, r.tree], { cwd })])
    if (!ns.ok || ns.exitCode !== 0) return
    const nums = parseNumstatZ(toLf(ns.stdout))
    const status = st.ok && st.exitCode === 0 ? parseNameStatusZ(toLf(st.stdout)) : new Map()
    snapRows = [...nums].map(([path, n]) => ({ path, status: (status.get(path) ?? 'M') as ChangeRow['status'], add: n.add, del: n.del, bin: n.bin }))
    tools.clear()
    await publish($)
  }
  const th = createThrottle(() => ctx.num('changes.minRefreshSec', 5) * 1000, refreshCur)
  /** Force a fresh snapshot (bypasses the throttle); a slow or failed snapshot falls back to cached state. */
  const forceRefresh = async ($: D): Promise<void> => {
    try {
      await Promise.race([th.now($), new Promise<void>(res => { $.clock.after(4000, res) })])
    } catch { /* cached */ }
  }

  return {
    id: 'diff',
    start: async $ => { await startBase($) },
    end: async ($, e) => {
      th.reset()
      if (e?.reason === 'clear') { base = undefined; snapRows = []; tools.clear(); await $.update('changes', () => ({ rows: [], files: 0, add: 0, del: 0, since: 0, toolsOnly: false })) }
    },
    cwdChanged: async $ => { th.reset(); await startBase($) },
    turn: async ($, e) => { if (e?.agentId === undefined) await th.request($, 0, true) },
    tool: async ($, t: ToolAfter) => {
      if (!t.ok) return
      const tool = String(t.e.tool)
      if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
        const f: string | undefined = t.e.file_path ?? t.e.notebook_path
        if (!f) return
        const r = t.ran?.result
        const { add, del } = countPatch(r?.structuredPatch)
        const path = rel(f)
        const prev = tools.get(path)
        tools.set(path, { add: (prev?.add ?? 0) + add, del: (prev?.del ?? 0) + del, status: r?.type === 'create' ? 'A' : (prev?.status ?? 'M') })
        await publish($)
      } else if (tool === 'Bash' && t.ran?.isReadOnly !== true && t.isMain) {
        await th.request($, 0, false)
      }
    },
    segment: async $ => {
      const c = await $.read('changes')
      if (!c.files) return null
      const body = `${plural(c.files, 'file')}`
      return chipSegment('diff', 6, 7, [
        { text: `${GLYPH.edit} ${body} +${c.add} −${c.del}`, signal: 'info' },
        { text: `${GLYPH.edit} ${body}`, signal: 'info' },
        { text: `${GLYPH.edit} ${c.files}`, signal: 'info' },
      ])
    },
    commands: [
      {
        name: 'changes',
        description: 'Files changed this session (use "open <n>" to open one)',
        argumentHint: '[open <n>]',
        run: async ($, args) => {
          const m = /^open\s+(\d+)/i.exec(args.trim())
          if (m) {
            const row = (await $.read('changes')).rows[+(m[1] as string) - 1]
            if (!row) return { text: `No file number ${m[1]} in the changes list.` }
            const root = ctx.root()
            const abs = row.path.startsWith('/') || !root ? row.path : `${root}/${row.path}`
            const argv = ctx.str('changes.openCommand', 'open {path}').split(/\s+/).filter(Boolean).map(x => (x === '{path}' ? abs : x.replace('{path}', abs)))
            if (!argv.length) return { text: 'changes.openCommand is empty.' }
            const r = await ctx.proc($, 'open', argv, { timeoutMs: 5000 })
            return { text: r.ok && r.exitCode === 0 ? `Opened ${row.path}` : `Could not open ${row.path}.` }
          }
          await forceRefresh($)
          const c = await $.read('changes')
          try { await $.ui.open({ id: 'changes', title: 'Session diff' }) } catch { /* pane optional */ }
          const files = c.rows.slice(0, 5).map(r => `${r.path} ${r.bin ? 'bin' : `+${r.add} −${r.del}`}`)
          return { text: [changesHeader(c, await ctx.safeNow($)), ...files, ...(c.files > files.length ? [`+${c.files - files.length} more`] : [])].join('\n') }
        },
      },
    ],
    panes: [
      {
        id: 'changes',
        title: 'Session diff',
        render: async ($, e) => {
          const t = $.ui.resolve(e) as any
          const { Box, Text, Link } = t
          await forceRefresh($)
          const c = await $.read('changes')
          const now = await ctx.safeNow($)
          const max = ctx.num('changes.maxRows', 50)
          const shown = c.rows.slice(0, max)
          const hidden = c.files - shown.length
          const root = ctx.root()
          return (
            <Box flexDirection="column">
              <Text bold>{changesHeader(c, now)}</Text>
              {c.files === 0 && <Text dimColor>No changes yet this session.</Text>}
              {shown.map((r, i) => {
                const abs = r.path.startsWith('/') || !root ? r.path : `${root}/${r.path}`
                return (
                  <Box key={r.path} flexDirection="row" gap={1}>
                    <Text>{`${i + 1} ${r.touched ? '~' : r.status} ${middleClip(r.path, 48)} ${r.bin ? 'bin' : `+${r.add} −${r.del}`} ${bar(r)}`}</Text>
                    <Link href={`file://${encodeURI(abs)}`} label="open" />
                  </Box>
                )
              })}
              {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
            </Box>
          )
        },
      },
    ],
  }
}

export function changesHeader(c: { files: number; add: number; del: number; since: number; toolsOnly: boolean }, now: number): string {
  return `SESSION DIFF · ${plural(c.files, 'file')} · +${c.add} −${c.del}${c.since ? ` · since ${fmtWhen(c.since, now).split(' ').pop()}` : ''}${c.toolsOnly ? ' (tools only)' : ''}`
}
