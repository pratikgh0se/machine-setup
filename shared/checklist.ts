// Main-thread checklist bookkeeping (TodoWrite / TaskCreate / TaskUpdate), moved from agent-pets. Pure.
// Used by awareness (Now Doing), agents (showChecklist) and the mission board.
import { clip } from './fmt'

export type ChecklistStatus = 'pending' | 'in_progress' | 'completed'
export type ChecklistItem = { id: string; content: string; activeForm?: string; status: ChecklistStatus }
export type Checklist = { items: ChecklistItem[]; seq: number }
export const EMPTY_CHECKLIST: Checklist = { items: [], seq: 0 }
export const TRACKED_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

export const countDone = (items: readonly ChecklistItem[]): number => items.filter(i => i.status === 'completed').length
export const isAllDone = (items: readonly ChecklistItem[]): boolean => items.length > 0 && countDone(items) === items.length
/** The in_progress item's `activeForm` (or content), clipped to 80. */
export function nowOf(items: readonly ChecklistItem[]): string {
  const cur = items.find(i => i.status === 'in_progress')
  return cur ? clip((cur.activeForm || cur.content).trim(), 80) : ''
}

/** Id a TaskCreate result carries: the host record `{ task: { id } }` or its text `Task #<n> created successfully: <subject>`; anything else is undefined. */
export function createdId(ran: unknown): string | undefined {
  const r = ran as { result?: unknown; text?: unknown } | string | null | undefined
  const rec = typeof r === 'object' && r !== null ? r : undefined
  const res = rec?.result as { task?: { id?: unknown } } | string | null | undefined
  const id = typeof res === 'object' && res !== null ? res.task?.id : undefined
  if (typeof id === 'string' && id !== '') return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  const texts = [typeof r === 'string' ? r : undefined, typeof rec?.text === 'string' ? rec.text : undefined, typeof res === 'string' ? res : undefined]
  for (const t of texts) {
    const m = t === undefined ? null : /^Task #(\d+) created successfully: [\s\S]*$/.exec(t.trim())
    if (m) return m[1]
  }
  return undefined
}

export type ChecklistEvent =
  | { tool: 'TodoWrite'; todos?: { content: string; activeForm?: string; status: string }[] }
  | { tool: 'TaskCreate'; subject: string; activeForm?: string; resultId?: string }
  | { tool: 'TaskUpdate'; taskId: string; subject?: string; activeForm?: string; status?: string }

/** Pure reducer: next checklist after a successful tool call. Labels are model-visible already (<= 60 kept by callers). */
export function applyChecklist(prev: Checklist, ev: ChecklistEvent): Checklist {
  if (ev.tool === 'TodoWrite') {
    const todos = ev.todos ?? []
    // The engine clears a finished list; keep it so "all done" can show.
    if (todos.length === 0 && isAllDone(prev.items)) return prev
    return { ...prev, items: todos.map((t, i) => ({ id: String(i + 1), content: t.content, activeForm: t.activeForm, status: t.status as ChecklistStatus })) }
  }
  if (ev.tool === 'TaskCreate') {
    if (ev.resultId === undefined) return prev // no valid host result: nothing is added
    const seq = prev.seq + 1
    const id = ev.resultId
    const item: ChecklistItem = { id, content: ev.subject, activeForm: ev.activeForm, status: 'pending' }
    return { items: [...prev.items.filter(i => i.id !== id), item], seq }
  }
  if (ev.status === 'deleted') return { ...prev, items: prev.items.filter(i => i.id !== ev.taskId) }
  return {
    ...prev,
    items: prev.items.map(i => (i.id !== ev.taskId ? i : { ...i, content: ev.subject ?? i.content, activeForm: ev.activeForm ?? i.activeForm, status: (ev.status as ChecklistStatus | undefined) ?? i.status })),
  }
}
