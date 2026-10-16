// Auto-checkpoint: after a turn that changed files, commit the working tree to refs/checkpoints/<sid>
// through a temporary index (safety.md s2). Never touches HEAD, the branch, the real index, the stash or any file.
// Every function that takes `$` is declared at the top level of this file (validate requires it);
// per-load state travels in `St`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { CheckpointView } from '../../types'
import { CKPT_INIT, PROTECT_INIT, statusText } from '../common'
import type { Ctx } from '../common'
import { fmtAgo, fmtWhen } from '../_shared/fmt'
import { toastGlyph } from '../_shared/glyphs'
import { bindRunner, isOk, probeHost } from '../_shared/proc'
import type { ProcPorts, ProcOpts, ProcResult, Runner } from '../_shared/proc'
import { commitCheckpoint, refTree, repoPaths, sid8 } from '../_shared/snapshot'
import type { RepoPaths } from '../_shared/snapshot'
import { toastText } from '../_shared/toast'
import type { Mode, Opts } from '../options'

const PAUSE_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000]
const RUN_TIMEOUT = 20_000

type RoundResult =
  | { status: 'saved'; n: number; tree: string }
  | { status: 'nochange' | 'skipped' | 'busy' | 'unavailable' | 'capped' }
  | { status: 'error'; reason: string }

const protectAtom = atom({ plugin: 'safety', key: 'protect' } as const, PROTECT_INIT)
const checkpointAtom = atom({ plugin: 'safety', key: 'checkpoint' } as const, CKPT_INIT)

/** Rewrites the plugin's one status line; never throws. (Declared per file: `$` is not followed across imports.) */
async function refreshStatus($: EngineInterface, opts: Opts, mode?: Mode): Promise<void> {
  try {
    const p = await read($, protectAtom)
    const c = await read($, checkpointAtom)
    $.ui.status(statusText(p, c, await $.clock.now(), opts, mode))
  } catch { /* status is cosmetic */ }
}

/** The ports of the shared proc kit, built from `$` here (validate does not follow `$` across imports). */
const procOf = ($: EngineInterface): ProcPorts => ({
  run: (argv, init) => $.process.run(argv, init),
  now: () => $.clock.now(),
})

type St = {
  o: Opts
  running: boolean
  hostOk?: boolean
  fails: number
  pauses: number
  pausedUntil: number
  failToasted: boolean
  cappedToasted: boolean
  countLoaded: boolean
}

async function sidOf($: EngineInterface): Promise<{ sid: string; s8: string; ref: string }> {
  const raw = await $.session.id()
  const sid = raw.replace(/[^A-Za-z0-9_-]/g, '')
  return { sid, s8: sid8(raw), ref: `refs/checkpoints/${sid}` }
}

const setView = ($: EngineInterface, patch: Partial<CheckpointView>): Promise<CheckpointView> => update($, checkpointAtom, v => ({ ...v, ...patch }))

async function toast($: EngineInterface, body: string): Promise<void> {
  try {
    let surfaces: readonly string[] = []
    try { surfaces = await $.session.surfaces() } catch { /* terminal assumed */ }
    $.ui.toast(toastText('CHECKPOINT', body, undefined, toastGlyph(surfaces, 'checkpoint')))
  } catch { /* cosmetic */ }
}

/** Defensive capability probe, once per session. */
async function ensureHost($: EngineInterface, st: St): Promise<boolean> {
  if (st.hostOk === undefined) {
    st.hostOk = await probeHost(procOf($))
    if (!st.hostOk) {
      await setView($, { state: 'unavailable', error: 'host', dirty: false })
      await refreshStatus($, st.o)
    }
  }
  return st.hostOk
}

async function loadCount($: EngineInterface, st: St, sid: string): Promise<void> {
  if (st.countLoaded) return
  st.countLoaded = true
  try {
    const n = Number(await $.store.get(`checkpoint:n:${sid}`))
    if (Number.isFinite(n) && n > 0) await update($, checkpointAtom, v => ({ ...v, count: Math.max(v.count, n), ref: v.ref ?? `refs/checkpoints/${sid}` }))
  } catch { /* counter restarts */ }
}

/** Fills count / last / tree from the ref tip when the in-memory view has none (new process, resumed session). Never throws. */
async function syncFromRef($: EngineInterface): Promise<void> {
  try {
    const { ref } = await sidOf($)
    const cwd = await $.session.cwd()
    const r = await bindRunner(procOf($), { cwd })(['git', 'log', '-1', '--format=%ct%x09%T%x09%s', ref])
    if (!isOk(r)) return
    const parts = r.stdout.split('\n')[0]?.split('\t') ?? []
    const ct = Number(parts[0])
    const tree = (parts[1] ?? '').trim()
    if (!Number.isFinite(ct) || ct <= 0 || !/^[0-9a-f]{7,}$/.test(tree)) return
    const nMsg = Number(/#(\d+)/.exec(parts.slice(2).join('\t'))?.[1] ?? 0)
    await update($, checkpointAtom, v => ({
      ...v,
      count: Math.max(v.count, Number.isFinite(nMsg) ? nMsg : 0),
      lastAt: v.lastAt ?? ct * 1000,
      lastTree: v.lastTree ?? tree.slice(0, 7),
      ref,
      state: v.state === 'idle' ? 'ok' : v.state,
    }))
  } catch { /* the in-memory view stays as is */ }
}

async function round($: EngineInterface, st: St, force: boolean): Promise<RoundResult> {
  const o = st.o
  if (st.running) return { status: 'busy' }
  st.running = true
  let tmp: string | undefined
  let top: string | undefined
  let run: Runner | undefined
  try {
    if (!(await ensureHost($, st))) return { status: 'unavailable' }
    const now = await $.clock.now()
    if (now < st.pausedUntil) return { status: 'skipped' }
    const { sid, s8, ref } = await sidOf($)
    await loadCount($, st, sid)
    if ((await read($, checkpointAtom)).lastAt === undefined) await syncFromRef($)
    const before = await read($, checkpointAtom)
    if (!force && !before.dirty) return { status: 'skipped' }
    if (!force && before.lastRunAt !== undefined && now - before.lastRunAt < o.minIntervalSec * 1000) return { status: 'skipped' }
    if (before.count >= o.maxPerSession) {
      await setView($, { state: 'capped', dirty: false })
      return { status: 'capped' }
    }
    const cwd = await $.session.cwd()
    const base = bindRunner(procOf($), { cwd })
    run = (argv: readonly string[], opts?: ProcOpts): Promise<ProcResult> => base(argv, { timeoutMs: RUN_TIMEOUT, ...opts })

    // step 1
    const paths: RepoPaths | undefined = await repoPaths(run, { cwd, name: 'ckpt', sid })
    if (!paths) {
      await setView($, { state: 'unavailable', error: 'not a repo', dirty: false })
      return { status: 'unavailable' }
    }
    top = paths.top
    tmp = paths.tmp
    if (await $.fs.exists(paths.lock)) return { status: 'skipped' }

    // guard: too many untracked files
    const ls = await run(['git', 'ls-files', '-o', '--exclude-standard'], { cwd: top })
    if (isOk(ls)) {
      const n = ls.stdout.split('\n').filter(Boolean).length
      if (n > o.maxUntracked) {
        await setView($, { state: 'capped', dirty: false, lastRunAt: now })
        if (!st.cappedToasted) {
          st.cappedToasted = true
          await toast($, `SKIPPED: ${n} untracked files. Add build output to .gitignore.`)
        }
        return { status: 'capped' }
      }
    }
    st.cappedToasted = false
    await setView($, { state: 'running', dirty: false, lastRunAt: now, error: undefined })

    // steps 2-4: temporary index only
    const g = { cwd: top, env: { GIT_INDEX_FILE: paths.tmp } }
    const spec = ['--', '.', ...o.exclude.map(x => `:(exclude,glob)**/${x}`)]
    const cp = await run(['cp', '-p', paths.idx, paths.tmp], { cwd: top })
    if (!isOk(cp)) {
      const rt = await run(['git', 'read-tree', 'HEAD'], g)
      if (!isOk(rt)) await run(['git', 'read-tree', '--empty'], g)
    }
    let add = await run(['git', 'add', '-A', ...spec], g)
    if (!isOk(add)) {
      await run(['git', 'read-tree', 'HEAD'], g)
      add = await run(['git', 'add', '-A', ...spec], g)
      if (!isOk(add)) throw new Error(add.ok ? 'git add failed' : add.reason)
    }
    const wt = await run(['git', 'write-tree'], g)
    if (!isOk(wt) || !wt.stdout.trim()) throw new Error(wt.ok ? 'write-tree failed' : wt.reason)
    const tree = wt.stdout.trim()

    // step 5
    const last = (await refTree(run, ref, top)) ?? (await refTree(run, 'HEAD', top))
    if (last === tree) {
      await setView($, { state: before.count > 0 ? 'ok' : 'idle' })
      st.fails = 0
      st.pauses = 0
      return { status: 'nochange' }
    }

    // steps 6-7
    const n = before.count + 1
    const msg = `checkpoint ${s8} #${n} ${new Date(now).toISOString()}`
    const c = await commitCheckpoint(run, { cwd: top, tree, ref, message: msg })
    if (!c.ok) throw new Error(c.reason)
    try { await $.store.set(`checkpoint:n:${sid}`, n) } catch { /* flushed at session.end */ }
    await setView($, { state: 'ok', count: n, lastAt: now, lastTree: tree.slice(0, 7), ref, error: undefined })
    st.fails = 0
    st.pauses = 0
    await refreshStatus($, o)
    return { status: 'saved', n, tree }
  } catch (err) {
    const reason = String((err as { message?: string } | undefined)?.message ?? err).slice(0, 120)
    st.fails++
    if (st.fails >= 3) {
      st.pausedUntil = (await $.clock.now()) + (PAUSE_MS[Math.min(st.pauses, PAUSE_MS.length - 1)] as number)
      st.pauses++
      st.fails = 0
    }
    try { await setView($, { state: 'error', error: reason, dirty: true }) } catch { /* state is advisory */ }
    if (!st.failToasted) {
      st.failToasted = true
      await toast($, `FAILED: ${reason}.`)
    }
    return { status: 'error', reason }
  } finally {
    // step 8
    if (tmp && run) {
      try { await run(['rm', '-f', tmp], { cwd: top }) } catch { /* temp index only */ }
    }
    st.running = false
  }
}

async function startCheckpoint($: EngineInterface, st: St): Promise<void> {
  const o = st.o
  try {
    st.hostOk = undefined
    st.countLoaded = false
    st.failToasted = false
    st.cappedToasted = false
    const { sid } = await sidOf($)
    await update($, checkpointAtom, () => ({ state: 'idle', count: 0, dirty: false }) as CheckpointView)
    await loadCount($, st, sid)
    try {
      const taken = new Set((await $.command.list()).filter(c => c.plugin !== 'safety').map(c => c.name))
      const description = 'Checkpoints: status, list, diff <n>, now, restore <id> [path].'
      if (taken.has('checkpoint')) await $.command.register({ name: 'safety-checkpoint', description, argumentHint: '[list|diff <n>|now|restore <id> [path]]' })
      else await $.command.register({ name: 'checkpoint', description, argumentHint: '[list|diff <n>|now|restore <id> [path]]' })
    } catch { /* commands are optional; probe and prune still run */ }
    if (await ensureHost($, st)) {
      const cwd = await $.session.cwd()
      const run = bindRunner(procOf($), { cwd })
      const fe = await run(['git', 'for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/checkpoints'])
      if (isOk(fe)) {
        const now = await $.clock.now()
        const cutoff = now - o.keepDays * 86_400_000
        for (const line of fe.stdout.split('\n')) {
          const m = /^(\S+) (\d+)\s*$/.exec(line.trim())
          if (!m) continue
          const name = m[1] as string
          if (name.endsWith('/' + sid)) continue
          if (Number(m[2]) * 1000 < cutoff) await run(['git', 'update-ref', '-d', name])
        }
      }
      await syncFromRef($)
    }
  } catch { /* start-up is best effort */ }
  await refreshStatus($, o)
}

async function endCheckpoint($: EngineInterface): Promise<void> {
  try {
    const { sid } = await sidOf($)
    const v = await read($, checkpointAtom)
    if (v.count > 0) await $.store.set(`checkpoint:n:${sid}`, v.count)
  } catch { /* counter is rebuilt from the ref log */ }
}

async function markDirty($: EngineInterface): Promise<void> {
  const v = await read($, checkpointAtom)
  if (!v.dirty) await setView($, { dirty: true })
}

async function turnDone($: EngineInterface, st: St): Promise<void> {
  const v = await read($, checkpointAtom)
  if (v.dirty) await round($, st, false)
}

async function runCommand($: EngineInterface, st: St, args: string): Promise<string> {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const sub = (tokens[0] ?? 'status').toLowerCase()
  const { ref } = await sidOf($)
  if (sub === 'status' && (await read($, checkpointAtom)).lastAt === undefined) await syncFromRef($)
  const v = await read($, checkpointAtom)
  const now = await $.clock.now()

  if (sub === 'now') {
    const r = await round($, st, true)
    if (r.status === 'saved') return `Checkpoint #${r.n} saved · tree ${r.tree.slice(0, 7)} · ${ref}`
    if (r.status === 'nochange') return 'No changes since the last checkpoint.'
    if (r.status === 'error') return `Checkpoint failed: ${r.reason}.`
    if (r.status === 'capped') return 'Checkpoint skipped: too many untracked files or session cap reached.'
    if (r.status === 'unavailable') return 'Checkpoints need a git repository and host commands.'
    return `Checkpoint skipped (${r.status}).`
  }
  if (sub === 'restore') {
    // Prints the command only. Nothing here runs a process, and no flag changes that.
    const id = Number(tokens[1])
    if (!Number.isInteger(id) || id < 1) return 'Usage: /checkpoint restore <id> [path]'
    const path = tokens.slice(2).find(t => !t.startsWith('-')) ?? '.'
    const k = Math.max(0, v.count - id)
    const note = id > v.count ? `Note: this session has ${v.count} checkpoint${v.count === 1 ? '' : 's'}; #${id} may not exist.\n` : ''
    return `${note}The plugin never restores files itself. Run this yourself:\ngit restore --source=${ref}${k > 0 ? `~${k}` : ''} --worktree -- ${path}`
  }
  if (sub === 'list') {
    const cwd = await $.session.cwd()
    const r = await bindRunner(procOf($), { cwd })(['git', 'log', '-n', '10', '--numstat', '--format=@%H %ct %s', ref])
    if (!isOk(r) || !r.stdout.trim()) return `CHECKPOINTS · none yet · ${ref}`
    const rows: string[] = []
    let cur: { n: string; ts: number; add: number; del: number; files: number } | undefined
    const flush = (): void => {
      if (cur) rows.push(`#${cur.n} ${fmtWhen(cur.ts * 1000, now)} +${cur.add} -${cur.del} ${cur.files} file${cur.files === 1 ? '' : 's'}`)
    }
    for (const line of r.stdout.split('\n')) {
      const h = /^@\S+ (\d+) (.*)$/.exec(line)
      if (h) {
        flush()
        cur = { n: /#(\d+)/.exec(h[2] as string)?.[1] ?? '?', ts: Number(h[1]), add: 0, del: 0, files: 0 }
        continue
      }
      const s = /^(\d+|-)\t(\d+|-)\t/.exec(line)
      if (s && cur) {
        cur.add += s[1] === '-' ? 0 : Number(s[1])
        cur.del += s[2] === '-' ? 0 : Number(s[2])
        cur.files++
      }
    }
    flush()
    return `CHECKPOINTS · last ${rows.length}\n${rows.join('\n')}`
  }
  if (sub === 'diff') {
    const id = Number(tokens[1])
    if (!Number.isInteger(id) || id < 1 || id > v.count) return `Usage: /checkpoint diff <n>  (1..${v.count})`
    const k = v.count - id
    const cwd = await $.session.cwd()
    const r = await bindRunner(procOf($), { cwd })(['git', 'diff', '--stat', `${ref}${k > 0 ? `~${k}` : ''}`])
    if (!isOk(r)) return 'Could not diff that checkpoint.'
    return r.stdout.trim() || `Checkpoint #${id} matches the working tree.`
  }
  const last = v.lastAt !== undefined ? `last ${fmtAgo(now - v.lastAt)} ago` : 'none yet'
  return `CHECKPOINTS · ref ${ref} · ${v.count} saved · ${last}${v.lastTree ? ` · tree ${v.lastTree}` : ''}`
}

async function handleCommand($: EngineInterface, st: St, args: string): Promise<{ text: string }> {
  try {
    return { text: await runCommand($, st, args) }
  } catch (err) {
    return { text: `Checkpoint: ${String((err as { message?: string } | undefined)?.message ?? err).slice(0, 120)}` }
  }
}

export function registerCheckpoint(on: On, { opts: o }: Ctx): void {
  const st: St = { o, running: false, fails: 0, pauses: 0, pausedUntil: 0, failToasted: false, cappedToasted: false, countLoaded: false }

  // Dirty marker: after next, never changes the result.
  on('tool.call', { tool: /^(?:Write|Edit|NotebookEdit|MultiEdit|Bash)$/ }, async ($, e, next) => {
    const r = await next(e)
    try {
      const failed = r.deny !== undefined || r.isError === true
      if (!failed && (String(e.tool) !== 'Bash' || r.isReadOnly !== true)) await markDirty($)
    } catch { /* marker is advisory */ }
    return r
  }).catch(($, e, next) => next(e))

  // Main thread only; subagent turns never trigger a checkpoint.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      try { await turnDone($, st) } catch { /* never breaks the turn */ }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await endCheckpoint($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await startCheckpoint($, st)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'checkpoint' }, ($, e) => handleCommand($, st, e.args)).catch(($, e, next) => next(e))
  on('command.run', { command: 'safety-checkpoint' }, ($, e) => handleCommand($, st, e.args)).catch(($, e, next) => next(e))
}
