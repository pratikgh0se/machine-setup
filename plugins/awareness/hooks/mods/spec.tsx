// Spec Tracker: counts markdown checkboxes of the plan/spec file being edited (or pinned with /spec <path>).
import type { D } from '../lib/d'
import { EMPTY_SPEC } from '../lib/atoms'
import { clip } from '../_shared/fmt'
import { matchAny, splitGlobs } from '../_shared/glob'
import { countChecked, firstUnchecked, parseCheckboxes } from '../_shared/plan'
import type { SpecState } from '../../types'
import { publishNow } from '../lib/nowview'
import { optBool, optNum, optStr } from '../lib/opts'
import type { Rt } from '../lib/rt'
import { isOkResult } from '../lib/util'

export const SPEC_GLOBS =
  '**/docs/**/*plan*.md,**/docs/**/*spec*.md,**/plans/**/*.md,**/specs/**/*.md,**/PLAN.md,**/SPEC.md,**/.claude/plans/**/*.md'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

// Raw text of the tracked file (cache only, never in state or store).
let raw: { key: string; text: string } | undefined
// Text of files written/edited this session (fallback when fs.read cannot see them).
const seen = new Map<string, string>()
function remember(rt: Rt, path: string, e: any): void {
  const k = absOf(rt, path)
  if (e.tool === 'Write' && typeof e.content === 'string') seen.set(k, e.content)
  else if (e.tool === 'Edit' && seen.has(k) && typeof e.old_string === 'string' && typeof e.new_string === 'string') {
    const t = seen.get(k) as string
    seen.set(k, e.replace_all ? t.split(e.old_string).join(e.new_string) : t.replace(e.old_string, () => e.new_string))
  }
  if (seen.size > 50) seen.delete(seen.keys().next().value as string)
}

const stripDot = (p: string): string => p.replace(/^\.\//, '')
const absOf = (rt: Rt, p: string): string => (p.startsWith('/') ? p : `${rt.cwd.replace(/\/$/, '')}/${stripDot(p)}`)
const same = (rt: Rt, a: string, b: string): boolean => absOf(rt, a) === absOf(rt, b)

const maxBytes = (rt: Rt): number => Math.max(1, optNum(rt.options, 'spec.maxKb', 256)) * 1024

function parse(rt: Rt, text: string): { done: number; total: number; next?: string } {
  const nested = optStr(rt.options, 'spec.nested', 'all') === 'top' ? 'top' : 'all'
  const items = parseCheckboxes(text.slice(0, maxBytes(rt)), { nested, max: 500 })
  const { done, total } = countChecked(items)
  const nx = firstUnchecked(items)
  return { done, total, next: nx ? clip(nx.text, 60) : undefined }
}

async function readText($: D, path: string, rt?: Rt): Promise<string | undefined> {
  const tries = rt && !path.startsWith('/') && rt.cwd ? [path, absOf(rt, path)] : [path]
  for (const p of tries) {
    try {
      const t: any = await $.fs.read(p)
      if (typeof t === 'string') return t
      if (t && typeof t.text === 'string') return t.text
      if (t && typeof t.content === 'string') return t.content
    } catch {
      // Try the next spelling, then what this session wrote.
    }
  }
  return rt ? seen.get(absOf(rt, path)) : undefined
}

async function mtimeOf($: D, path: string): Promise<number | undefined> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/** Track `path` with this text. false when the text holds no checkbox (nothing changes). */
async function track($: D, rt: Rt, path: string, text: string, pinned: boolean): Promise<boolean> {
  const p = parse(rt, text)
  if (p.total === 0) return false
  raw = { key: absOf(rt, path), text }
  const mtimeMs = await mtimeOf($, path)
  await $.update('sp', () => ({ path, pinned, done: p.done, total: p.total, next: p.next, mtimeMs }))
  await publishNow($)
  return true
}

async function refresh($: D, rt: Rt, e?: any): Promise<void> {
  const sp = await $.read('sp')
  if (!sp.path) return
  let text = await readText($, sp.path, rt)
  if (text === undefined && e) {
    const a = e as any
    if (a.tool === 'Write' && typeof a.content === 'string') text = a.content
    else if (a.tool === 'Edit' && raw && raw.key === absOf(rt, sp.path) && typeof a.old_string === 'string' && typeof a.new_string === 'string') {
      text = a.replace_all ? raw.text.split(a.old_string).join(a.new_string) : raw.text.replace(a.old_string, () => a.new_string)
    }
  }
  if (text === undefined) {
    if (e) return
    await $.update('sp', s => ({ ...s, missing: true }))
    await publishNow($)
    return
  }
  const p = parse(rt, text)
  raw = { key: absOf(rt, sp.path), text }
  const mtimeMs = await mtimeOf($, sp.path)
  await $.update('sp', s => ({ ...s, done: p.done, total: p.total, next: p.next, mtimeMs, missing: false }))
  await publishNow($)
}

async function onEdited($: D, rt: Rt, e: any): Promise<void> {
  const path = String(e.file_path ?? e.notebook_path ?? '')
  if (!path) return
  remember(rt, path, e)
  const sp = await $.read('sp')
  if (sp.path && same(rt, sp.path, path)) return refresh($, rt, e)
  if (sp.pinned || !optBool(rt.options, 'spec.auto', true)) return
  if (!matchAny(path, splitGlobs(optStr(rt.options, 'spec.globs', SPEC_GLOBS)), { cwd: rt.cwd })) return
  let text = await readText($, path, rt)
  if (text === undefined && e.tool === 'Write' && typeof e.content === 'string') text = e.content
  if (text === undefined) return
  await track($, rt, path, text, false)
}

async function command($: D, rt: Rt, args: string): Promise<string> {
  const arg = args.trim()
  const sp = await $.read('sp')
  if (arg === '') {
    if (!sp.path) return 'No spec tracked'
    if (sp.missing) return 'Spec file missing'
    return `Tracking ${sp.path} (${sp.pinned ? 'pinned' : 'auto'}) · SPEC ${sp.done}/${sp.total}`
  }
  if (arg === 'clear') {
    raw = undefined
    await $.update('sp', () => EMPTY_SPEC)
    await publishNow($)
    return 'Spec unpinned. No spec tracked'
  }
  const text = await readText($, arg, rt)
  if (text === undefined) return 'Spec file missing'
  if (!(await track($, rt, arg, text, true))) return 'Spec file has no checkboxes'
  return `Tracking ${arg} (pinned)`
}

export async function spToolAfter($: D, rt: Rt, e: any, ran: any): Promise<void> {
  if (e.agentId !== undefined || !EDIT_TOOLS.has(String(e.tool)) || !isOkResult(ran)) return
  try {
    await onEdited($, rt, e)
  } catch {
    // Never disturb the tool result.
  }
}

/** After each main turn: refresh when the file changed on disk (another tool, the person). */
export async function spTurnComplete($: D, rt: Rt, e: any): Promise<void> {
  if (e?.agentId) return
  try {
    const sp = await $.read('sp')
    if (!sp.path) return
    const m = await mtimeOf($, sp.path)
    if (m === undefined) {
      if (!sp.missing) {
        await $.update('sp', s => ({ ...s, missing: true }))
        await publishNow($)
      }
    } else if (m !== sp.mtimeMs || sp.missing) await refresh($, rt)
  } catch {
    // Best effort.
  }
}

export const spCommand = command

export type { SpecState }
