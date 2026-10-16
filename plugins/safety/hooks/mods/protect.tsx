// Protected Files: a gating tool.call hook that denies writes to protected paths, plus /protect.
// Every function that takes `$` is declared at the top level of this file (validate requires it);
// per-load state travels in `St`, never in module variables.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { PROTECT_INIT } from '../common'
import type { Ctx } from '../common'
import { fmtAgo, parseDuration } from '../_shared/fmt'
import { toastGlyph } from '../_shared/glyphs'
import { toastText } from '../_shared/toast'
import type { Mode, Opts } from '../options'
import { baseName, buildMatcher, classify, classifyLiteral, denyText, extractTargets, normalizePath, verbOf } from '../protect-core'
import type { Cfg, Hit, Kind } from '../protect-core'

const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])
const MODES = new Set(['off', 'warn', 'deny'])
const MAX_BASH_TARGETS = 24
const TOAST_GAP_MS = 30_000

type Block = { path: string; rel: string; hit: Hit; kind: Kind | 'edit'; text: string }
type Env = { home?: string; cwd?: string; vault?: string }
type Event = { tool: unknown; [k: string]: unknown }

const protectAtom = atom({ plugin: 'safety', key: 'protect' } as const, PROTECT_INIT)

type St = {
  o: Opts
  loaded: boolean
  mode?: Mode
  extras: string[]
  /** Last toast time per path (1 per path per 30 s). */
  toasted: Map<string, number>
}

const asExtras = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { items?: unknown }).items) ? (v as { items: unknown[] }).items : []
  return arr.filter((x): x is string => typeof x === 'string')
}

const modeNow = (st: St): Mode => st.mode ?? st.o.mode

async function load($: EngineInterface, st: St): Promise<void> {
  if (st.loaded) return
  st.loaded = true
  try {
    const m = await $.store.get('protect:mode')
    if (typeof m === 'string' && MODES.has(m)) st.mode = m as Mode
  } catch { /* option default */ }
  try {
    st.extras = asExtras(await $.store.get('protect:extra'))
  } catch { /* none */ }
}

/** Environment reads. `$.session.cwd()` is called only when `needCwd` (a relative path or pattern is in play). */
async function readEnv($: EngineInterface, needCwd: boolean): Promise<Env> {
  let home: string | undefined
  let cwd: string | undefined
  let vault: string | undefined
  try { home = await $.env.get('HOME') } catch { /* unknown */ }
  try { vault = await $.env.get('OBSIDIAN_VAULT_PATH') } catch { /* unknown */ }
  if (needCwd) {
    try { cwd = await $.session.cwd() } catch { /* unknown */ }
  }
  return { home, cwd, vault: vault && vault.trim() ? vault : undefined }
}

const isRelative = (p: string): boolean => !p.startsWith('/') && !p.startsWith('~')

const vaultRoot = (ev: Env): string | undefined => ev.vault ?? (ev.home ? ev.home.replace(/\/+$/, '') + '/second-brain' : undefined)

function makeCfg(st: St, ev: Env): Cfg {
  const o = st.o
  const roots: string[] = []
  const vr = vaultRoot(ev)
  if (vr) {
    const n = normalizePath(vr, ev.cwd, ev.home)
    roots.push(n)
  }
  return { env: o.env, lockfiles: o.lockfiles, vault: o.vault, allow: o.allow, ci: o.ci, vaultRoots: roots, extra: [...o.globs, ...st.extras], home: ev.home, cwd: ev.cwd }
}

/** realPath of an existing target, else realPath of its parent + name; undefined when unresolvable. */
async function realOf($: EngineInterface, spelling: string): Promise<string | undefined> {
  try {
    const stat = await $.fs.stat(spelling, { resolve: true })
    if (stat?.realPath) return stat.realPath
  } catch { /* does not exist */ }
  try {
    const i = spelling.lastIndexOf('/')
    const parent = i <= 0 ? '/' : spelling.slice(0, i)
    const stat = await $.fs.stat(parent, { resolve: true })
    if (stat?.realPath) return stat.realPath.replace(/\/+$/, '') + '/' + spelling.slice(i + 1)
  } catch { /* unresolvable: keep the spelling */ }
  return undefined
}

function relTo(p: string, cfg: Cfg): string {
  const under = (root: string | undefined): string | undefined => {
    if (!root) return undefined
    const r = root.replace(/\/+$/, '')
    return p.startsWith(r + '/') ? p.slice(r.length + 1) : undefined
  }
  return under(cfg.cwd) ?? cfg.vaultRoots.map(under).find(Boolean) ?? p
}

async function judge($: EngineInterface, st: St, e: Event): Promise<Block | undefined> {
  const o = st.o
  const tool = String(e.tool)
  const items: { raw: string; kind: Kind | 'edit'; dyn: boolean; dir?: string }[] = []
  let ev: Env | undefined
  if (FILE_TOOLS.has(tool)) {
    const p = e.file_path ?? e.notebook_path
    if (typeof p === 'string' && p) items.push({ raw: p, kind: 'edit', dyn: false })
  } else if (tool === 'Bash') {
    if (o.bash && typeof e.command === 'string') {
      ev = await readEnv($, true)
      for (const t of extractTargets(e.command, { cwd: ev.cwd, home: ev.home }).slice(0, MAX_BASH_TARGETS)) items.push({ raw: t.raw, kind: t.kind, dyn: t.dyn, dir: t.cwd })
    }
  } else if (o.mcpRules.length) {
    for (const r of o.mcpRules) {
      if (r.tool !== tool) continue
      const p = e[r.arg]
      if (typeof p === 'string' && p) items.push({ raw: p, kind: 'edit', dyn: false })
    }
  }
  if (items.length === 0) return undefined

  ev = ev ?? (await readEnv($, true))
  const cfg = makeCfg(st, ev)
  const pv = await read($, protectAtom)
  const now = pv.allowances.length ? await $.clock.now() : 0
  const live = pv.allowances.filter(a => a.until > now)
  const active = live.map(a => buildMatcher([a.pattern], { home: ev?.home, cwd: ev?.cwd, ci: o.ci }))
  const isAllowed = (cands: string[]): boolean => cands.some(c => active.some(m => m(c)))

  for (const it of items) {
    let hit: Hit | undefined
    let path: string
    let viaReal: string | undefined
    // A relative target in a directory we could not determine: judged by its spelling and basename only.
    const unknownDir = !it.dyn && it.dir === 'unknown' && isRelative(it.raw)
    if (it.dyn || unknownDir) {
      hit = classifyLiteral(baseName(it.raw), cfg)
      path = it.raw
      if (hit && isAllowed(unknownDir ? [it.raw, baseName(it.raw)] : [it.raw])) hit = undefined
      if (hit && unknownDir && live.some(a => a.pattern === it.raw)) hit = undefined
    } else {
      path = normalizePath(it.raw, it.dir && it.dir !== 'unknown' ? it.dir : ev.cwd, ev.home)
      hit = classify(path, cfg)
      if (hit && isAllowed([path])) hit = undefined
      else if (!hit) {
        // Not protected by spelling: a symlink may still lead to a protected file.
        const real = await realOf($, path)
        if (real && real !== path) {
          hit = classify(real, cfg)
          if (hit) viaReal = real
          if (hit && isAllowed([path, real])) hit = undefined
        }
      }
    }
    if (!hit) continue
    if (viaReal) hit = { ...hit, reason: `symlink to ${viaReal}: ${hit.reason}` }
    return { path, rel: unknownDir ? path : relTo(path, cfg), hit, kind: it.kind, text: denyText(path, hit, it.kind === 'edit' ? undefined : verbOf(it.kind), unknownDir) }
  }
  return undefined
}

async function record($: EngineInterface, st: St, b: Block, mode: Mode): Promise<void> {
  try {
    const now = await $.clock.now()
    if (mode === 'deny') {
      await update($, protectAtom, v => ({ ...v, mode, blocked: v.blocked + 1, last: { path: b.rel, at: now, group: b.hit.group } }))
    }
    const prev = st.toasted.get(b.path)
    if (prev === undefined || now - prev >= TOAST_GAP_MS) {
      st.toasted.set(b.path, now)
      let surfaces: readonly string[] = []
      try { surfaces = await $.session.surfaces() } catch { /* terminal assumed */ }
      const what = b.kind === 'edit' ? 'Edit' : 'Command'
      const text =
        mode === 'warn'
          ? toastText('FILE PROTECTED', `${b.rel} edited anyway (warn mode).`, undefined, toastGlyph(surfaces, 'warn'))
          : toastText('FILE PROTECTED', `${what} blocked: ${b.rel} is ${b.hit.short}.`, undefined, toastGlyph(surfaces, 'denied'))
      $.ui.toast(text)
    }
  } catch { /* bookkeeping never changes the verdict */ }
}

/** Pure fallback for the gate's .catch: literal rules on the event alone, no `$`. */
function pure(o: Opts, e: Event): string | undefined {
  if (o.mode !== 'deny') return undefined
  const cfg: Cfg = { env: o.env, lockfiles: o.lockfiles, vault: false, allow: o.allow, ci: o.ci, vaultRoots: [], extra: o.globs }
  const tool = String(e.tool)
  const raws: { raw: string; kind: Kind | 'edit'; dir?: string }[] = []
  if (FILE_TOOLS.has(tool)) {
    const p = e.file_path ?? e.notebook_path
    if (typeof p === 'string') raws.push({ raw: p, kind: 'edit' })
  } else if (tool === 'Bash' && o.bash && typeof e.command === 'string') {
    for (const t of extractTargets(e.command)) raws.push({ raw: t.raw, kind: t.kind, dir: t.cwd })
  }
  for (const r of raws) {
    const unknownDir = r.dir === 'unknown' && isRelative(r.raw)
    const p = normalizePath(r.raw, r.dir && r.dir !== 'unknown' && r.dir.startsWith('/') ? r.dir : undefined)
    const hit = classify(p, cfg) ?? classifyLiteral(baseName(p), cfg)
    if (hit) return denyText(unknownDir ? r.raw : p, hit, r.kind === 'edit' ? undefined : verbOf(r.kind), unknownDir)
  }
  return undefined
}

async function startProtect($: EngineInterface, st: St): Promise<void> {
  try {
    await load($, st)
    await update($, protectAtom, () => ({ mode: modeNow(st), blocked: 0, allowances: [], extras: [...st.extras] }))
    const taken = new Set((await $.command.list()).filter(c => c.plugin !== 'safety').map(c => c.name))
    const description = 'Protected files: status, allow, list, add, remove, off|warn|deny.'
    if (taken.has('protect')) await $.command.register({ name: 'safety-protect', description, argumentHint: '[allow|list|add|remove|status|off|warn|deny]' })
    else await $.command.register({ name: 'protect', description, argumentHint: '[allow|list|add|remove|status|off|warn|deny]' })
  } catch { /* start-up is best effort */ }
}

async function runCommand($: EngineInterface, st: St, args: string): Promise<string> {
  const o = st.o
  await load($, st)
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const sub = (tokens[0] ?? 'status').toLowerCase()
  const ev = await readEnv($, false)
  const now = await $.clock.now()
  const view = await read($, protectAtom)

  if (sub === 'off' || sub === 'warn' || sub === 'deny') {
    const m: Mode = sub
    st.mode = m
    try { await $.store.set('protect:mode', m) } catch { /* session only */ }
    await update($, protectAtom, v => ({ ...v, mode: m }))
    return `Protected files: mode ${m}.`
  }
  if (sub === 'allow') {
    if (tokens.length < 2) return `Usage: /protect allow <path|glob> [duration]  (default 10m, max ${o.maxAllowMin}m)`
    let ms = 10 * 60_000
    let end = tokens.length
    const last = tokens.length > 2 ? (tokens[tokens.length - 1] as string) : ''
    if (last) {
      const d = parseDuration(last) ?? (/^\d+$/.test(last) ? Number(last) * 60_000 : undefined)
      if (d !== undefined) { ms = d; end = tokens.length - 1 }
    }
    const pattern = tokens.slice(1, end).join(' ')
    const capMs = o.maxAllowMin * 60_000
    const clamped = ms > capMs
    ms = Math.min(ms, capMs)
    const until = now + ms
    await update($, protectAtom, v => ({ ...v, allowances: [...v.allowances.filter(a => a.until > now && a.pattern !== pattern), { pattern, until }] }))
    return `Allowing ${pattern} for ${Math.round(ms / 60_000)} min${clamped ? ` (clamped to ${o.maxAllowMin} min)` : ''}. Gone at session end.`
  }
  if (sub === 'add') {
    const g = tokens.slice(1).join(' ').trim()
    if (!g) return 'Usage: /protect add <glob>'
    if (!st.extras.includes(g)) st.extras = [...st.extras, g]
    try { await $.store.set('protect:extra', st.extras) } catch { /* session only */ }
    const extras = [...st.extras]
    await update($, protectAtom, v => ({ ...v, extras }))
    return `Protecting ${g}.`
  }
  if (sub === 'remove') {
    const g = tokens.slice(1).join(' ').trim()
    if (!g) return 'Usage: /protect remove <glob>'
    if (st.extras.includes(g)) {
      st.extras = st.extras.filter(x => x !== g)
      try { await $.store.set('protect:extra', st.extras) } catch { /* session only */ }
      const extras = [...st.extras]
      await update($, protectAtom, v => ({ ...v, extras }))
      return `No longer protecting ${g}.`
    }
    if (o.globs.includes(g)) return `${g} comes from the protect.globs option; edit it in /config.`
    const cfg = makeCfg(st, ev)
    const isDefault = classify(normalizePath(g, ev.cwd, ev.home), { ...cfg, extra: [] }) !== undefined || classifyLiteral(g, cfg) !== undefined
    return isDefault
      ? `${g} is a default protected entry and cannot be removed. Switch its group off with the protect.group.* options, or use /protect allow.`
      : `${g} is not one of the extra globs. Only extras added with /protect add can be removed (defaults stay).`
  }
  const cfg = makeCfg(st, ev)
  const active = view.allowances.filter(a => a.until > now)
  const allowLines = active.map(a => `${a.pattern} · ${Math.max(1, Math.ceil((a.until - now) / 60_000))} min left`)
  if (sub === 'list') {
    const lines = ['PROTECTED FILES · effective set']
    lines.push(`env        ${o.env ? 'on ' : 'off'}  .env, .env.* (except ${o.allow.join(', ') || 'none'})`)
    lines.push(`lockfiles  ${o.lockfiles ? 'on ' : 'off'}  package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, bun.lockb, Cargo.lock, poetry.lock, uv.lock`)
    lines.push(`vault      ${o.vault ? 'on ' : 'off'}  ${cfg.vaultRoots[0] ?? '(no vault)'}: Boards/Engineering.md, .obsidian/**, Ledger/**`)
    const extras = [...o.globs, ...st.extras]
    lines.push(`extra      ${extras.length ? extras.join(', ') : '(none)'}`)
    lines.push(`allow      ${allowLines.length ? allowLines.join(' · ') : '(none)'}`)
    return lines.join('\n')
  }
  const onOff = (b: boolean): string => (b ? 'on' : 'off')
  const lastBlock = view.last ? `${view.last.path} ${fmtAgo(now - view.last.at)} ago` : 'none'
  return [
    `PROTECTED FILES · ${modeNow(st)}`,
    `groups  env ${onOff(o.env)} · lockfiles ${onOff(o.lockfiles)} · vault ${onOff(o.vault)}`,
    `blocked ${view.blocked} this session · last: ${lastBlock}`,
    `allow   ${allowLines.length ? allowLines.join(' · ') : '(none)'}`,
  ].join('\n')
}

async function handleCommand($: EngineInterface, st: St, args: string): Promise<{ text: string }> {
  try {
    return { text: await runCommand($, st, args) }
  } catch (err) {
    return { text: `Protected files: ${String((err as { message?: string } | undefined)?.message ?? err).slice(0, 120)}` }
  }
}

export function registerProtect(on: On, { opts: o }: Ctx): void {
  const st: St = { o, loaded: false, extras: [], toasted: new Map() }
  const gated = new RegExp('^(?:Write|Edit|NotebookEdit|MultiEdit|Bash' + o.mcpRules.map(r => '|' + r.tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + ')$')

  on('tool.call', { tool: gated }, async ($, e, next) => {
    await load($, st)
    const mode = modeNow(st)
    if (mode === 'off') return next(e)
    const block = await judge($, st, e as never)
    if (!block) return next(e)
    await record($, st, block, mode)
    if (mode === 'warn') return next(e)
    return { deny: block.text }
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const text = pure(o, e as never)
    return text ? { deny: text } : next(e)
  })

  // Matcher `{}` matches every start; it keeps this apart from the other mod's unmatched session.start (validate allows one each).
  on('session.start', {}, async ($, e, next) => {
    await startProtect($, st)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'protect' }, ($, e) => handleCommand($, st, e.args)).catch(($, e, next) => next(e))
  on('command.run', { command: 'safety-protect' }, ($, e) => handleCommand($, st, e.args)).catch(($, e, next) => next(e))
}
