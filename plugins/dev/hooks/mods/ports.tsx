import type { PortRow } from '../../types'
import type { Ctx, D, Mod, ToolAfter } from '../core'
import { chipSegment, plural } from '../ui'
import { GLYPH } from '../_shared/glyphs'

export type Listener = { pid: number; port: number; cmd: string }

/** `lsof -Fpcn` listener output -> unique pid+port rows. */
export function parseLsof(out: string): Listener[] {
  const res: Listener[] = []
  const seen = new Set<string>()
  let pid = 0
  let cmd = ''
  for (const raw of out.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const k = l[0]
    const v = l.slice(1)
    if (k === 'p') { pid = parseInt(v, 10) || 0; cmd = '' }
    else if (k === 'c') cmd = v
    else if (k === 'n' && pid) {
      const m = /:(\d+)$/.exec(v)
      if (!m) continue
      const port = +(m[1] as string)
      const key = `${pid}:${port}`
      if (seen.has(key)) continue
      seen.add(key)
      res.push({ pid, port, cmd })
    }
  }
  return res
}
export function parseCwds(out: string): Map<number, string> {
  const m = new Map<number, string>()
  let pid = 0
  for (const raw of out.split('\n')) {
    const l = raw.trim()
    if (l.startsWith('p')) pid = parseInt(l.slice(1), 10) || 0
    else if (l.startsWith('n') && pid) m.set(pid, l.slice(1))
  }
  return m
}

const BASH_RE = /\b(?:dev|start|serve|run|nohup)\b|&/

export function portsChip(ours: PortRow[]): string | undefined {
  if (!ours.length) return undefined
  const ps = [...new Set(ours.map(p => p.port))].sort((a, b) => a - b)
  const list = ps.slice(0, 4).join(', ') + (ps.length > 4 ? ', …' : '')
  return `${GLYPH.port} ${plural(ps.length, 'port')} (${list})`
}

export function createPorts(ctx: Ctx): Mod {
  let baseline: Set<string> | undefined
  const firstSeen = new Map<string, number>()
  let lastScan = Number.NEGATIVE_INFINITY
  let scanning = false
  let armTimer: { cancel: () => void } | undefined
  let afterBash: { cancel: () => void } | undefined

  const underRoots = (cwd: string | undefined): boolean => {
    if (!cwd) return false
    const roots = [ctx.rt.top ?? ctx.rt.cwd, ...ctx.rt.worktrees].filter((x): x is string => !!x)
    return roots.some(r => cwd === r || cwd.startsWith(r.endsWith('/') ? r : r + '/'))
  }

  /** One listing + one cwd lookup (new pids only). */
  const snapshot = async ($: D): Promise<{ rows: PortRow[] } | undefined> => {
    const r = await ctx.proc($, 'lsof', ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 8000 })
    if (!r.ok) return undefined
    const ls = parseLsof(r.stdout)
    const now = await ctx.safeNow($)
    if (!baseline) {
      baseline = new Set(ls.map(l => `${l.pid}:${l.port}`))
    }
    const fresh = [...new Set(ls.filter(l => !baseline!.has(`${l.pid}:${l.port}`)).map(l => l.pid))]
    let cwds = new Map<number, string>()
    if (fresh.length) {
      const c = await ctx.proc($, 'lsof', ['lsof', '-a', '-p', fresh.join(','), '-d', 'cwd', '-Fpn'], { timeoutMs: 8000 })
      if (c.ok) cwds = parseCwds(c.stdout)
    }
    const rows: PortRow[] = ls.map(l => {
      const key = `${l.pid}:${l.port}`
      if (!firstSeen.has(key)) firstSeen.set(key, now)
      const isNew = !baseline!.has(key)
      const cwd = cwds.get(l.pid)
      return { pid: l.pid, port: l.port, cmd: l.cmd, cwd, firstSeen: firstSeen.get(key) as number, ours: isNew && underRoots(cwd) }
    })
    return { rows }
  }

  const scan = async ($: D): Promise<void> => {
    if (scanning) return
    scanning = true
    try {
      await ctx.ready($)
      if (!ctx.rt.hostOk) return
      const s = await snapshot($)
      lastScan = await ctx.safeNow($)
      if (!s) return
      await $.update('ports', () => s.rows)
      await ctx.onChange($)
    } finally {
      scanning = false
    }
  }

  const clearArm = async ($: D, note?: string): Promise<void> => {
    armTimer?.cancel()
    armTimer = undefined
    await $.update('portsUi', u => ({ note: note ?? u.note }))
  }

  const stop = async ($: D, pid: number, port: number): Promise<void> => {
    if (!ctx.bool('ports.kill', true)) return
    const now = await ctx.safeNow($)
    const row = (await $.read('ports')).find(r => r.pid === pid && r.port === port)
    if (!row || !row.ours) return // list-only listeners have no kill path
    const ui = await $.read('portsUi')
    if (ui.armed && ui.armed.pid === pid && ui.armed.port === port && ui.armed.until > now) {
      // Second press: re-verify pid, port and cwd, then TERM.
      armTimer?.cancel()
      armTimer = undefined
      const s = await snapshot($)
      const fresh = s?.rows.find(r => r.pid === pid && r.port === port)
      if (!fresh || !fresh.ours || fresh.cwd !== row.cwd || fresh.cmd !== row.cmd) {
        await $.update('portsUi', () => ({ note: `:${port} changed; not stopped` }))
        return
      }
      const k = await ctx.proc($, 'kill', ['kill', '-TERM', String(pid)], { timeoutMs: 5000 })
      await $.update('portsUi', () => ({ note: k.ok && k.exitCode === 0 ? `:${port} TERM sent` : `:${port} kill failed` }))
      $.clock.after(3000, () => {
        void (async () => {
          try {
            const again = await snapshot($)
            const alive = again?.rows.some(r => r.pid === pid && r.port === port)
            if (again) await $.update('ports', () => again.rows)
            await $.update('portsUi', () => ({ note: alive ? `:${port} still running` : `:${port} stopped` }))
          } catch { /* note only */ }
        })()
      })
      return
    }
    await $.update('portsUi', () => ({ armed: { pid, port, until: now + 5000 } }))
    armTimer?.cancel()
    armTimer = $.clock.after(5000, () => {
      void $.update('portsUi', () => ({})).catch(() => undefined)
    })
  }

  const mod: Mod = {
    id: 'ports',
    start: async $ => {
      baseline = undefined
      firstSeen.clear()
      await ctx.ready($)
      if (!ctx.rt.hostOk) return
      const s = await snapshot($)
      lastScan = await ctx.safeNow($)
      if (s) await $.update('ports', () => s.rows)
    },
    end: async $ => {
      armTimer?.cancel()
      afterBash?.cancel()
      baseline = undefined
      firstSeen.clear()
      await $.update('ports', () => [])
      await $.update('portsUi', () => ({}))
    },
    turn: async $ => { await scan($) },
    tool: async ($, t: ToolAfter) => {
      if (String(t.e.tool) !== 'Bash' || !t.ok) return
      const cmd = String(t.e.command ?? '')
      if (!(BASH_RE.test(cmd) || t.e.run_in_background)) return
      afterBash?.cancel()
      afterBash = $.clock.after(3000, () => { void scan($).catch(() => undefined) })
    },
    tick: async ($, now) => {
      if (!ctx.rt.hostOk || baseline === undefined) return
      if (ctx.isIdle(now)) return
      const ours = (await $.read('ports')).some(p => p.ours)
      let open = false
      try { open = (await $.ui.panes()).some(p => p.id === 'ports') } catch { /* closed */ }
      const every = open ? 15_000 : ours ? 60_000 : Infinity
      if (now - lastScan >= every) await scan($)
    },
    segment: async $ => {
      const ours = (await $.read('ports')).filter(p => p.ours)
      const t = portsChip(ours)
      if (!t) return null
      return chipSegment('ports', 5, 6, [
        { text: t, signal: 'info' },
        { text: `${GLYPH.port} ${new Set(ours.map(p => p.port)).size}`, signal: 'info' },
      ])
    },
    commands: [
      {
        name: 'ports',
        description: 'Dev servers started by agents in this session',
        run: async $ => {
          await scan($).catch(() => undefined)
          try { await $.ui.open({ id: 'ports', title: 'Port watch' }) } catch { /* pane optional */ }
          const rows = await $.read('ports')
          const ours = rows.filter(r => r.ours)
          const now = await ctx.safeNow($)
          const staleMin = ctx.num('ports.stale.min', 30)
          const lines = ['PORT WATCH', ...ours.map(r => ourLine(r, now, staleMin))]
          if (!ours.length) lines.push('No listeners started by agents this session.')
          const other = rows.length - ours.length
          if (other > 0) lines.push(otherText(other))
          return { text: lines.join('\n') }
        },
      },
    ],
    panes: [
      {
        id: 'ports',
        title: 'Port watch',
        render: async ($, e) => {
          const t = $.ui.resolve(e) as any
          const { Box, Text, Button } = t
          const rows = await $.read('ports')
          const ui = await $.read('portsUi')
          const clock = await $.read('clock')
          const now = Math.max(clock, await ctx.safeNow($))
          const ours = rows.filter(r => r.ours).sort((a, b) => a.port - b.port)
          const other = rows.length - ours.length
          const staleMin = ctx.num('ports.stale.min', 30)
          const canKill = ctx.bool('ports.kill', true)
          return (
            <Box flexDirection="column">
              <Text bold>OURS</Text>
              {ours.length === 0 && <Text dimColor>No listeners started by agents this session.</Text>}
              {ours.map(r => {
                const armed = !!ui.armed && ui.armed.pid === r.pid && ui.armed.port === r.port && ui.armed.until > now
                return (
                  <Box key={`${r.pid}:${r.port}`} flexDirection="row" gap={1}>
                    <Text>{ourLine(r, now, staleMin)}</Text>
                    {canKill && <Button key={`stop-${r.pid}`} label={armed ? 'CONFIRM' : 'STOP'} onPress={() => void stop($, r.pid, r.port)} />}
                  </Box>
                )
              })}
              {other > 0 && <Text dimColor>{otherText(other)}</Text>}
              {ui.note && <Text dimColor>{ui.note}</Text>}
            </Box>
          )
        },
      },
    ],
  }
  return mod
}

const otherText = (n: number): string => `${n} other ${n === 1 ? 'listener' : 'listeners'}`
function ourLine(r: PortRow, now: number, staleMin: number): string {
  const min = Math.max(0, Math.floor((now - r.firstSeen) / 60_000))
  return `:${r.port} ${r.cmd} pid ${r.pid} age ${min} min${min >= staleMin ? ' stale?' : ''}`
}
