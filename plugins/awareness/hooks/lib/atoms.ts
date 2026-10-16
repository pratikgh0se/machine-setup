// Initial values of the awareness atoms (the atom() declarations themselves must be literals in register.tsx).
import { EMPTY_CHECKLIST } from '../_shared/checklist'
import type { FocusView, HeadsUpView, NdState, NowView, SpecState } from '../../types'

export const EMPTY_NOW: NowView = { visited: [], now: '', done: 0, total: 0, isComplete: false }
export const EMPTY_ND: NdState = { turn: false, visited: [], derived: '', checklist: EMPTY_CHECKLIST }
export const EMPTY_SPEC: SpecState = { pinned: false, done: 0, total: 0 }
export const EMPTY_FOCUS: FocusView = { phase: 'idle', count: 0, ofTotal: 4 }
export const EMPTY_HEADSUP: HeadsUpView = { queued: [], shown: 0 }
