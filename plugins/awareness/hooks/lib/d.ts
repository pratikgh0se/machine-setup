// The facade of `$` that every file but register.tsx uses (`claude plugin validate` follows `$` only inside the file
// that holds the hooks, so register.tsx builds this object per event with mkD($) and nothing else sees `$`).
import type { FocusView, HeadsUpView, NdState, NowView, SpecState } from '../../types'

export type StateMap = { now: NowView; focus: FocusView; headsup: HeadsUpView; clock: number; nd: NdState; sp: SpecState }
export type Timer = { cancel: () => void }

export type D = {
  clock: {
    now: () => Promise<number>
    sleep: (ms: number, o?: { signal?: AbortSignal }) => Promise<void>
    after: (ms: number, fn: () => void) => Timer
    every: (ms: number, fn: () => void) => Timer
  }
  process: { run: (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }> }
  fs: { stat: (p: string) => Promise<{ kind?: string; size: number; mtimeMs: number }>; read: (p: string) => Promise<string> }
  session: { cwd: () => Promise<string>; id: () => Promise<string>; surfaces: () => Promise<readonly string[]> }
  store: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> }
  command: { list: () => Promise<{ name: string }[]> }
  agent: { list: () => Promise<{ status: string }[]> }
  settings: { read: () => Promise<any> }
  http: { fetch: (url: string) => Promise<any> }
  vaultPath: () => Promise<string | undefined>
  audio: { play: (clip: { asset: string }) => Promise<void> }
  ui: {
    toast: (text: string, o?: { timeoutMs?: number }) => void
    status: (text: string | undefined) => void
    notify: (text: string, o?: { title?: string }) => Promise<unknown>
    resolve: (e: any) => any
    invalidate: () => void
  }
  /** Peer atoms by literal ref; shaped like `$.state` for shared/toast.ts. */
  state: { get: (ref: { plugin: string; key: string }) => Promise<{ value?: any }> }
  setClock: (n: number) => Promise<unknown>
  read: <K extends keyof StateMap>(k: K) => Promise<StateMap[K]>
  update: <K extends keyof StateMap>(k: K, fn: (v: StateMap[K]) => StateMap[K]) => Promise<unknown>
}
