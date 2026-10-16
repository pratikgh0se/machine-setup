// Store keys and record shapes (spec s7). Values are { v: 1, ... }; paths only, never file contents.
// Pure: every `$` call lives in register.tsx (claude plugin validate does not follow `$` across imports).
export const lastKey = (sid: string): string => `handoff:last:${sid}`
export const pendingKey = (sid: string): string => `compact:pending:${sid}`
export const ORCH_KEY = 'orch:on'
export const TOAST_KEY = 'coach:toast'

export type LastHandoff = { v: 1; path: string; savedAt: number }
export type Pending = { v: 1; path: string; at: number; savedAt: number; kind?: 'agent' }

export const isLast = (x: unknown): x is LastHandoff => !!x && typeof x === 'object' && typeof (x as LastHandoff).path === 'string' && typeof (x as LastHandoff).savedAt === 'number'
