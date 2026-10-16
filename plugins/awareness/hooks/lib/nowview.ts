// Projection of the private Now Doing + Spec state to the public NowView, and its publisher.
import type { D } from './d'
import { countDone, isAllDone, nowOf } from '../_shared/checklist'
import type { NdState, NowView, SpecState } from '../../types'

export function project(nd: NdState, sp: SpecState): NowView {
  const items = nd.checklist.items
  const hasList = items.length > 0
  const fromTool = nd.toolTotal != null && nd.toolTotal > 0
  const total = fromTool ? (nd.toolTotal as number) : items.length
  const done = fromTool ? Math.min(nd.toolDone ?? 0, total) : countDone(items)
  const isComplete = fromTool ? done >= total : hasList && isAllDone(items)
  const hasSpec = !!sp.path && !sp.missing && sp.total > 0
  return {
    phase: nd.phase,
    visited: nd.visited,
    now: nd.note || nowOf(items) || nd.derived,
    done,
    total,
    isComplete,
    cmd: nd.cmd,
    specDone: hasSpec ? sp.done : undefined,
    specTotal: hasSpec ? sp.total : undefined,
    specNext: hasSpec ? sp.next : undefined,
  }
}

/** Percent shown: checklist (or tool counts) first, else the spec. undefined = nothing to measure. */
export function percentOf(v: NowView): number | undefined {
  if (v.total > 0) return Math.round((100 * v.done) / v.total)
  if (v.specTotal && v.specTotal > 0) return Math.round((100 * (v.specDone ?? 0)) / v.specTotal)
  return undefined
}

export type StatusSink = { on: boolean }
export const statusSink: StatusSink = { on: false }

/** Writes the public `awareness.now` atom (and the `$.ui.status` fallback where there is no band). */
export async function publishNow($: D): Promise<void> {
  try {
    const view = project(await $.read('nd'), await $.read('sp'))
    await $.update('now', () => view)
    if (statusSink.on) {
      const pct = percentOf(view)
      const shown = view.phase || view.total > 0 || view.specTotal
      $.ui.status(shown ? `now: ${view.now || (view.phase ?? 'working')}${pct != null ? ` ${pct}%` : ''}` : undefined)
    }
  } catch {
    // Publishing is best effort.
  }
}

export async function touchClock($: D, now?: number): Promise<void> {
  const at = now ?? (await $.clock.now())
  await $.update('clock', () => at)
}
