import type { GitView } from '../../types'
import { createThrottle } from '../core'
import type { Ctx, D, Mod } from '../core'
import { chipSegment } from '../ui'
import { GLYPH } from '../_shared/glyphs'

/** Parses `git status --porcelain=v2 --branch` (NUL- or newline-separated). */
export function parseStatus(out: string): GitView | null {
  const nul = out.includes('\0')
  const fields = out.split(nul ? '\0' : '\n')
  const v: GitView = { branch: '', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  let oid = ''
  let hasAb = false
  for (let i = 0; i < fields.length; i++) {
    const l = fields[i] as string
    if (!l) continue
    if (l.startsWith('# branch.head ')) v.branch = l.slice(14).trim()
    else if (l.startsWith('# branch.oid ')) oid = l.slice(13).trim()
    else if (l.startsWith('# branch.upstream ')) v.upstream = l.slice(18).trim()
    else if (l.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(l)
      if (m) { v.ahead = +(m[1] as string); v.behind = +(m[2] as string); hasAb = true }
    } else if (l.startsWith('1 ') || l.startsWith('2 ')) {
      const xy = l.slice(2, 4)
      if (xy[0] !== '.') v.staged++
      if (xy[1] !== '.') v.unstaged++
      if (l.startsWith('2 ') && nul) i++ // original path follows
    } else if (l.startsWith('u ')) v.conflicts++
    else if (l.startsWith('? ')) v.untracked++
  }
  void hasAb
  if (v.branch === '' && !oid) return null
  if (v.branch === '(detached)' || v.branch === '') {
    v.detached = true
    v.branch = `HEAD@${(oid && oid !== '(initial)' ? oid : 'unknown').slice(0, 7)}`
  }
  return v
}

const dirty = (g: GitView): boolean => g.staged + g.unstaged + g.untracked + g.conflicts > 0

/** Terminal strings for the three widths (spec s2). */
export function gitTexts(g: GitView, showWt: boolean): { full: string; mid: string; min: string } {
  const star = dirty(g) ? '*' : ''
  const head = `${GLYPH.branch} ${g.branch}${star}`
  const arrows = [g.ahead > 0 ? `↑${g.ahead}` : '', g.behind > 0 ? `↓${g.behind}` : ''].filter(Boolean).join(' ')
  const counts = [g.staged ? `+${g.staged}` : '', g.unstaged ? `~${g.unstaged}` : '', g.untracked ? `?${g.untracked}` : '', g.conflicts ? `!${g.conflicts}` : ''].filter(Boolean).join(' ')
  const full = [head, arrows, counts].filter(Boolean).join(' ') + (showWt && g.worktree ? ` · wt ${g.worktree}` : '')
  const mid = [head, [g.staged ? `+${g.staged}` : '', g.unstaged ? `~${g.unstaged}` : ''].filter(Boolean).join(' ')].filter(Boolean).join(' ')
  return { full, mid, min: head }
}

export function createGit(ctx: Ctx): Mod {
  let busyNote = false
  const refresh = async ($: D): Promise<void> => {
    await ctx.ready($)
    if (!ctx.rt.hostOk) return
    const untracked = ctx.str('git.untracked', 'normal') === 'no' ? 'no' : 'normal'
    const r = await ctx.proc($, 'git', ['git', 'status', '--porcelain=v2', '--branch', '-z', `--untracked-files=${untracked}`], { cwd: ctx.root(), timeoutMs: 5000 })
    if (!r.ok) {
      if (r.reason === 'busy' || r.reason === 'paused') return
      await $.update('git', g => (g ? { ...g, error: true } : null))
      return
    }
    if (r.exitCode !== 0) {
      busyNote = /not a git repository/i.test(r.stderr)
      await $.update('git', g => (busyNote || !g ? null : { ...g, error: true }))
      return
    }
    const v = parseStatus(r.stdout)
    if (!v) {
      await $.update('git', g => (g ? { ...g, error: true } : null))
      return
    }
    if (ctx.rt.isLinked) v.worktree = ctx.rt.worktreeName
    await $.update('git', () => v)
  }
  const th = createThrottle(() => ctx.num('git.minRefreshSec', 5) * 1000, refresh)

  return {
    id: 'git',
    start: async $ => { await th.now($) },
    cwdChanged: async $ => { th.reset(); await th.now($) },
    end: async () => { th.reset() },
    turn: async $ => { await th.request($, 0, true) },
    tool: async ($, t) => {
      if (!t.ok) return
      const tool = String(t.e.tool)
      if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') await th.request($, 1500)
      else if (tool === 'Bash') {
        const op = t.ran?.result?.gitOperation
        if (op || t.ran?.isReadOnly !== true) await th.request($, 1500)
      }
    },
    segment: async $ => {
      const g = await $.read('git')
      if (!g) return null
      if (g.error) return chipSegment('git', 0, 3, [{ text: `${GLYPH.branch} git: error`, dim: true }])
      const t = gitTexts(g, ctx.bool('git.showWorktree', true))
      const signal = g.conflicts ? 'danger' : dirty(g) ? 'warn' : 'ok'
      return chipSegment('git', 0, 3, [
        { text: t.full, signal },
        { text: t.mid, signal },
        { text: t.min, signal },
      ])
    },
  }
}
