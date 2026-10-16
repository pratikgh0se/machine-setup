import type { PrRow } from '../../types'
import type { Ctx, D, Mod, ToolAfter } from '../core'
import { chipSegment } from '../ui'
import { GLYPH } from '../_shared/glyphs'
import { basename, clip } from '../_shared/fmt'
import { PEER_REFS, createLimiter, toastText } from '../_shared/toast'
import type { Limiter } from '../_shared/toast'
import { toastGlyph } from '../_shared/glyphs'

type Wt = { path: string; branch?: string; main: boolean }
type GhPr = {
  number: number
  title: string
  author?: { login?: string }
  headRefName: string
  url: string
  state: string
  reviewDecision?: string | null
  mergeable?: string
  statusCheckRollup?: any[] | null
  updatedAt?: string
}

const FAIL_CONCL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING_WORDS = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'EXPECTED', 'REQUESTED'])
const FIFTEEN_MIN = 15 * 60_000

export function parseWorktrees(out: string): Wt[] {
  const res: Wt[] = []
  for (const block of out.split(/\n\s*\n/)) {
    let path = ''
    let branch: string | undefined
    for (const l of block.split('\n')) {
      if (l.startsWith('worktree ')) path = l.slice(9).trim()
      else if (l.startsWith('branch ')) branch = l.slice(7).trim().replace(/^refs\/heads\//, '')
    }
    if (path) res.push({ path, branch, main: res.length === 0 })
  }
  return res
}

export function checksOf(rollup: any[] | null | undefined): PrRow['checks'] {
  const items = rollup ?? []
  if (!items.length) return 'none'
  let pending = false
  for (const it of items) {
    const concl = String(it?.conclusion ?? '').toUpperCase()
    const state = String(it?.state ?? '').toUpperCase()
    const status = String(it?.status ?? '').toUpperCase()
    if (FAIL_CONCL.has(concl) || state === 'FAILURE' || state === 'ERROR') return 'fail'
    if ((status && status !== 'COMPLETED') || PENDING_WORDS.has(state) || PENDING_WORDS.has(concl)) pending = true
  }
  return pending ? 'pending' : 'pass'
}

const reviewOf = (d: string | null | undefined): PrRow['review'] => (d === 'APPROVED' ? 'approved' : d === 'CHANGES_REQUESTED' ? 'changes' : d === 'REVIEW_REQUIRED' ? 'pending' : 'none')
const REVIEW_WORD: Record<PrRow['review'], string> = { approved: 'APPROVED', changes: 'CHANGES', pending: 'PENDING', none: '-' }
const CHECK_WORD: Record<PrRow['checks'], string> = { pass: 'pass', pending: 'running', fail: 'fail', none: 'none' }

export function chipText(r: PrRow): string {
  const g = r.checks === 'pass' ? '✅' : r.checks === 'fail' ? '⛔' : r.checks === 'pending' ? '⏳' : '–'
  let s = `${GLYPH.pr} #${r.number} ${g} checks`
  if (r.review !== 'none') s += ` · ${REVIEW_WORD[r.review]}`
  if (r.mergeable === 'conflict') s += ' · CONFLICT'
  return s
}

const hhmm = (ts: number): string => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function stateMessage(state: string, until?: number): string | undefined {
  switch (state) {
    case 'no-gh': return 'gh: not signed in. Run gh auth login in a terminal.'
    case 'no-remote': return 'no GitHub remote'
    case 'rate-limited': return `rate limited until ${hhmm(until ?? 0)}`
    case 'error': return 'gh: error. Retrying with backoff.'
    case 'loading': return 'Loading pull requests…'
    case 'no-repo': return 'not a git repository'
    default: return undefined
  }
}

export function createPr(ctx: Ctx): Mod {
  let me: string | undefined
  let authOk: boolean | undefined
  let authRetryAt = 0
  let nextAt = 0
  let fails = 0
  let rateUntil = 0
  let lastCycleAt = Number.NEGATIVE_INFINITY
  let running = false
  let paused = false
  const seen = new Map<number, PrRow['checks']>()
  const held = new Map<number, { title: string; at: number }>()
  let limiter: Limiter | undefined

  const getLimiter = ($: D): Limiter => {
    limiter ??= createLimiter({
      minGapMs: 60_000,
      peers: ['awareness.headsup'],
      onShown: async ({ at }) => {
        await $.update('toast', t => ({ lastShownAt: at, shown: t.shown + 1, held: held.size }))
      },
    })
    return limiter
  }

  const base = (): number => Math.max(60_000, ctx.num('pr.intervalSec', 60) * 1000)
  const publish = async ($: D, patch: Partial<{ rows: PrRow[]; state: string; at: number; until: number; intervalMs: number }>): Promise<void> => {
    await $.update('prs', p => ({ ...p, ...patch }))
    await ctx.onChange($)
  }

  const getRemote = async ($: D): Promise<'ok' | 'no-remote' | 'no-repo'> => {
    try {
      const r: any = await $.session.repo()
      if (!r) return ctx.rt.top ? 'ok' : 'no-repo'
      const remote: string | null | undefined = r.remote ?? r.originUrl
      return remote && remote.includes('github.com') ? 'ok' : 'no-remote'
    } catch {
      return 'ok'
    }
  }

  const tryToast = async ($: D): Promise<void> => {
    if (!ctx.bool('pr.toastOnFail', true)) { held.clear(); return }
    if (held.size === 0) return
    const now = await ctx.safeNow($)
    const rows = (await $.read('prs')).rows
    for (const [n, h] of [...held]) {
      const row = rows.find(r => r.number === n)
      if (now - h.at > 60 * 60_000 || !row || row.checks !== 'fail' || row.state !== 'open') held.delete(n)
    }
    await $.update('toast', t => ({ ...t, held: held.size }))
    if (held.size === 0) return
    const prefix = toastGlyph(await ctx.surfaces($), 'warn')
    const entries = [...held]
    const text =
      entries.length === 1
        ? toastText(`PR #${entries[0]![0]}`, `CHECKS FAILING: ${clip(entries[0]![1].title, 40)}.`, 'Run /prs.', prefix)
        : toastText('PR CHECKS FAILING', `${entries.length} PRs.`, 'Run /prs.', prefix)
    const lim = getLimiter($)
    const res = await lim.offer(
      {
        now: () => $.clock.now(),
        toast: (t, o) => $.ui.toast(t, o),
        readPeer: async n => (await $.state.get(PEER_REFS[n])).value,
      },
      'pr-fail',
      text,
      { timeoutMs: 8000, priority: 1 },
    )
    lim.clearQueue()
    if (res === 'shown') {
      held.clear()
      await $.update('toast', t => ({ ...t, held: 0 }))
    }
  }

  const observe = (rows: PrRow[], now: number): void => {
    if (!me) return
    for (const r of rows) {
      if (!r.number || r.state !== 'open' || !r.mine) continue
      const prev = seen.get(r.number)
      if (prev !== undefined && prev !== 'fail' && r.checks === 'fail') held.set(r.number, { title: r.title ?? '', at: now })
      seen.set(r.number, r.checks)
    }
  }

  const cycle = async ($: D): Promise<void> => {
    if (running) return
    running = true
    try {
      await ctx.ready($)
      if (!ctx.rt.hostOk) return
      const now = await ctx.safeNow($)
      lastCycleAt = now
      const rem = await getRemote($)
      if (rem !== 'ok') {
        await publish($, { state: rem, rows: [] })
        nextAt = now + 10 * 60_000
        return
      }
      if (authOk === undefined || (authOk === false && now >= authRetryAt)) {
        const a = await ctx.proc($, 'gh', ['gh', 'auth', 'status'], { cwd: ctx.root(), timeoutMs: 15_000 })
        authOk = a.ok && a.exitCode === 0
        if (authOk) {
          const u = await ctx.proc($, 'gh', ['gh', 'api', 'user', '--jq', '.login'], { cwd: ctx.root(), timeoutMs: 15_000 })
          me = u.ok && u.exitCode === 0 && u.stdout.trim() ? u.stdout.trim() : undefined
        } else authRetryAt = now + 10 * 60_000
      }
      if (!authOk) {
        await publish($, { state: 'no-gh', rows: [] })
        nextAt = authRetryAt
        return
      }
      // Worktrees.
      const wtr = await ctx.proc($, 'git', ['git', 'worktree', 'list', '--porcelain'], { cwd: ctx.root(), timeoutMs: 5000 })
      let wts: Wt[] = wtr.ok && wtr.exitCode === 0 ? parseWorktrees(wtr.stdout) : []
      ctx.rt.worktrees = wts.map(w => w.path)
      if (!wts.length) {
        const g = await $.read('git')
        if (g && !g.detached && ctx.root()) wts = [{ path: ctx.root() as string, branch: g.branch, main: true }]
      }
      // One gh call.
      const limit = Math.max(1, Math.min(1000, ctx.num('pr.maxPrs', 100)))
      const fields = 'number,title,author,headRefName,url,isDraft,state,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,updatedAt'
      const g = await ctx.proc($, 'gh', ['gh', 'pr', 'list', '--state', 'all', '--limit', String(limit), '--json', fields], {
        cwd: ctx.root(),
        timeoutMs: 30_000,
        isFailure: r => !r.ok || r.exitCode !== 0,
      })
      if (!g.ok && (g.reason === 'busy' || g.reason === 'paused')) { nextAt = now + 60_000; return }
      const errText = g.ok ? `${g.stderr}\n${g.exitCode !== 0 ? g.stdout : ''}` : g.reason
      if (!g.ok || g.exitCode !== 0) {
        if (/rate limit|HTTP 403|HTTP 429/i.test(errText)) {
          rateUntil = now + FIFTEEN_MIN
          nextAt = rateUntil
          await publish($, { state: 'rate-limited', until: rateUntil })
          return
        }
        fails++
        nextAt = now + Math.min(FIFTEEN_MIN, 60_000 * 2 ** fails)
        await publish($, { state: 'error' })
        return
      }
      let list: GhPr[]
      try { list = JSON.parse(g.stdout) as GhPr[] } catch { list = [] ; fails++; nextAt = now + Math.min(FIFTEEN_MIN, 60_000 * 2 ** fails); await publish($, { state: 'error' }); return }
      fails = 0
      const gv = await $.read('git')
      const top = ctx.rt.top
      const cwd = ctx.rt.cwd
      let currentIdx = wts.findIndex(w => top !== undefined && w.path === top)
      if (currentIdx < 0 && cwd) currentIdx = wts.findIndex(w => cwd === w.path || cwd.startsWith(w.path + '/'))
      if (currentIdx < 0 && gv && !gv.detached) currentIdx = wts.findIndex(w => w.branch === gv.branch)
      const rows: PrRow[] = wts.map((w, i) => {
        const cands = w.branch ? list.filter(p => p.headRefName === w.branch) : []
        cands.sort((a, b) => (a.state === 'OPEN' ? 0 : 1) - (b.state === 'OPEN' ? 0 : 1) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        const p = cands[0]
        const name = w.main ? basename(w.path) : `wt/${basename(w.path)}`
        const row: PrRow = { worktree: name, branch: w.branch ?? '(detached)', checks: 'none', review: 'none', current: i === currentIdx }
        if (p) {
          row.number = p.number
          row.title = clip(p.title ?? '', 60)
          row.url = p.url
          row.mine = !!me && p.author?.login === me
          row.checks = checksOf(p.statusCheckRollup)
          row.review = reviewOf(p.reviewDecision)
          row.mergeable = p.mergeable === 'CONFLICTING' ? 'conflict' : p.mergeable === 'MERGEABLE' ? 'ok' : 'unknown'
          row.state = p.state === 'OPEN' ? 'open' : p.state === 'MERGED' ? 'merged' : 'closed'
        }
        return row
      })
      const anyPending = rows.some(r => r.checks === 'pending')
      const idle = ctx.rt.lastInput > 0 && now - ctx.rt.lastInput >= 10 * 60_000
      const interval = anyPending && !idle ? base() : base() * 3
      nextAt = now + interval
      observe(rows, now)
      await publish($, { rows, state: 'ok', at: now, intervalMs: interval })
      await tryToast($)
    } catch {
      /* a failed cycle never disturbs the session */
    } finally {
      running = false
    }
  }

  const lines = (rows: PrRow[]): string[] =>
    rows.map(r => `${r.worktree}  ${r.number ? `#${r.number}` : 'no PR'}  ${CHECK_WORD[r.checks]}  ${REVIEW_WORD[r.review]}${r.mergeable === 'conflict' ? '  CONFLICT' : ''}`)

  return {
    id: 'pr',
    start: async $ => {
      nextAt = 0
      paused = false
      authOk = undefined
      fails = 0
      rateUntil = 0
      seen.clear()
      held.clear()
      void cycle($)
    },
    end: async () => { seen.clear(); held.clear() },
    cwdChanged: async () => { nextAt = 0 },
    prompt: async $ => {
      if (paused) { paused = false; nextAt = Math.min(nextAt, await ctx.safeNow($)) }
    },
    tool: async ($, t: ToolAfter) => {
      if (String(t.e.tool) !== 'Bash') return
      if (t.ran?.result?.ghRateLimitHint) {
        const now = await ctx.safeNow($)
        rateUntil = now + FIFTEEN_MIN
        nextAt = Math.max(nextAt, rateUntil)
        await publish($, { state: 'rate-limited', until: rateUntil })
      }
    },
    tick: async ($, now) => {
      if (ctx.isIdle(now)) { paused = true; return }
      if (now >= rateUntil && now >= nextAt && !running) await cycle($)
      await tryToast($)
    },
    segment: async $ => {
      const p = await $.read('prs')
      const r = p.rows.find(x => x.current && x.number && x.state !== undefined)
      if (!r) return null
      const sig = r.checks === 'fail' ? 'danger' : r.checks === 'pending' ? 'warn' : r.checks === 'pass' ? 'ok' : undefined
      const full = chipText(r)
      const mid = `${GLYPH.pr} #${r.number} ${r.checks === 'pass' ? '✅' : r.checks === 'fail' ? '⛔' : r.checks === 'pending' ? '⏳' : '–'} checks`
      return chipSegment('pr', 4, 4, [{ text: full, signal: sig }, { text: mid, signal: sig }, { text: `${GLYPH.pr} #${r.number}`, signal: sig }])
    },
    commands: [
      {
        name: 'prs',
        description: 'Pull requests per worktree (use "refresh" to poll now)',
        argumentHint: '[refresh]',
        run: async ($, args) => {
          let note = ''
          if (/^refresh/i.test(args.trim())) {
            const now = await ctx.safeNow($)
            if (now - lastCycleAt < 15_000) note = 'Refreshed less than 15 s ago.\n'
            else if (now < rateUntil) note = 'Rate limited; not calling gh.\n'
            else await cycle($)
          }
          try { await $.ui.open({ id: 'pr-radar', title: 'PR radar' }) } catch { /* pane optional */ }
          const p = await $.read('prs')
          const msg = stateMessage(p.state, p.until)
          const out = [`PR RADAR · ${p.rows.length} ${p.rows.length === 1 ? 'WORKTREE' : 'WORKTREES'}`]
          if (msg) out.push(msg)
          out.push(...lines(p.rows))
          return { text: note + out.join('\n') }
        },
      },
    ],
    panes: [
      {
        id: 'pr-radar',
        title: 'PR radar',
        render: async ($, e) => {
          const t = $.ui.resolve(e) as any
          const { Box, Text, Link } = t
          const p = await $.read('prs')
          const clock = await $.read('clock')
          const now = Math.max(clock, await ctx.safeNow($))
          const msg = stateMessage(p.state, p.until)
          const stale = p.at !== undefined && p.intervalMs !== undefined && now - p.at > 3 * p.intervalMs
          const age = p.at !== undefined ? Math.max(0, Math.round((now - p.at) / 1000)) : undefined
          const ageText = age === undefined ? undefined : age < 60 ? `${age} s` : age < 3600 ? `${Math.round(age / 60)} min` : `${Math.round(age / 3600)} h`
          const showRows = p.state !== 'no-gh' && p.state !== 'no-remote' && p.state !== 'no-repo'
          return (
            <Box flexDirection="column">
              <Text bold>{`${p.rows.length} ${p.rows.length === 1 ? 'WORKTREE' : 'WORKTREES'}`}</Text>
              {msg && <Text dimColor={p.state === 'loading'} color={p.state === 'loading' ? undefined : 'yellow'}>{msg}</Text>}
              {showRows &&
                p.rows.map(r => (
                  <Box key={`${r.worktree}:${r.branch}`} flexDirection="row" gap={1}>
                    <Text color={r.checks === 'fail' ? 'red' : r.checks === 'pending' ? 'yellow' : r.checks === 'pass' ? 'green' : undefined} dimColor={r.checks === 'none'}>■</Text>
                    <Text>{`${r.worktree} ${r.number ? `#${r.number}` : 'no PR'} ${CHECK_WORD[r.checks]} ${REVIEW_WORD[r.review]}${r.mergeable === 'conflict' ? ' CONFLICT' : ''}${r.title ? ` ${clip(r.title, 40)}` : ''}`}</Text>
                    {r.url && <Link href={r.url} label="PR" />}
                  </Box>
                ))}
              {ageText && <Text dimColor>{`updated ${ageText} ago${stale ? ' (stale)' : ''}`}</Text>}
            </Box>
          )
        },
      },
    ],
  }
}
