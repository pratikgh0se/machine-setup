import { test, expect, mock } from 'claude-code/testing'

const BAND: any = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 160, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const PANE: any = { title: 'x', isFocused: false, bodyColumns: 120, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} }
const VP = { columns: 160, rows: 50 }
const textOf = (n: any): string => {
  if (n == null || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(textOf).join(' ')
  const p = n.props ?? {}
  const own = ['label', 'text', 'value', 'alt'].map(k => (typeof p[k] === 'string' ? p[k] : '')).join(' ')
  return own + ' ' + textOf(n.children ?? p.children)
}
type Proc = (argv: string[], init: any) => { exitCode: number; stdout: string; stderr: string } | undefined
const calls: { argv: string[]; init: any }[] = []
let clk: any
const setup = ($: any, on: any, proc: Proc, extra?: (on: any) => void, skip: string[] = []) => {
  const raw = on
  on = ((name: any, ...rest: any[]) => (skip.includes(typeof name === 'string' ? name : '') ? undefined : raw(name, ...rest))) as any
  const on2 = raw
  calls.length = 0
  clk = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('process.run', async (_$: any, e: any) => {
    const argv = e.argv ?? e
    calls.push({ argv, init: e })
    const r = proc(argv, e) ?? { exitCode: 0, stdout: '', stderr: '' }
    return { value: r }
  })
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'Text', props: {}, children: ['SENTINEL'] }))
  on('command.run', async () => ({ text: '' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('turn.complete', async (_$: any, e: any) => ({ text: e.answer }))
  on('tool.call', async (_$: any, e: any) => ({ result: { ok: true } }))
  extra?.(on2)
}
const start = ($: any) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
const band = async ($: any, surface: any = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'dev', surface, component: 'AbovePrompt', props: BAND, viewport: VP })
  const t = textOf(await ui.drawn()); await ui.unmount(); return t
}
const pane = async ($: any, id: string, surface: any = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'dev', surface, component: 'Pane', props: PANE, requestId: id, viewport: VP })
  const t = textOf(await ui.drawn()); return { t, ui }
}
const turn = ($: any) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

const GIT = (a: string[]) => {
  if (a[0] === 'git' && a[1] === '--version') return { exitCode: 0, stdout: 'git version 2.4', stderr: '' }
  if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('--show-toplevel') && !a.includes('--git-path')) return { exitCode: 0, stdout: '/repo\n', stderr: '' }
  if (a[0] === 'git' && a[1] === 'rev-parse' && a.includes('--git-dir')) return { exitCode: 0, stdout: '/repo/.git\n/repo/.git\n', stderr: '' }
  return undefined
}

test('C01 git chip', async ($, on) => {
  setup($, on, a => GIT(a) ?? (a[1] === 'status' ? { exitCode: 0, stdout: '# branch.head main\n# branch.ab +2 -0\n1 M. N... 100644 100644 100644 a a a.ts\n1 M. N... 100644 100644 100644 a a b.ts\n1 A. N... 100644 100644 100644 a a c.ts\n1 .M N... 100644 100644 100644 a a d.ts\n? x\n', stderr: '' } : undefined))
  await start($)
  const t = await band($)
  expect(t).toContain('main*'); expect(t).toContain('↑2'); expect(t).toContain('+3'); expect(t).toContain('~1'); expect(t).toContain('?1'); expect(t).not.toContain('↓')
})
test('C03 worktree', async ($, on) => {
  setup($, on, a => (a[1] === 'rev-parse' && a.includes('--git-dir') ? { exitCode: 0, stdout: '/main/.git/worktrees/auth-flow\n/main/.git\n', stderr: '' } : a[1] === 'rev-parse' ? { exitCode: 0, stdout: '/wt/auth-flow\n', stderr: '' } : a[1] === 'status' ? { exitCode: 0, stdout: '# branch.head main\n', stderr: '' } : GIT(a)))
  await start($)
  expect(await band($)).toContain('wt auth-flow')
})
test('C04 coalesce', async ($, on) => {
  setup($, on, a => GIT(a) ?? (a[1] === 'status' ? { exitCode: 0, stdout: '# branch.head main\n', stderr: '' } : undefined))
  await start($)
  const n0 = calls.filter(c => c.argv[1] === 'status').length
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as any)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m y' } as any)
  await clk.advance(4000)
  const n1 = calls.filter(c => c.argv[1] === 'status').length
  await clk.advance(2000)
  const n2 = calls.filter(c => c.argv[1] === 'status').length
  expect(n2 - n0).toBe(1)
})
test('C05 diff', async ($, on) => {
  let trees = ['T1', 'T2']
  setup($, on, a => {
    const g = GIT(a); if (g) return g
    if (a[1] === 'rev-parse') return { exitCode: 0, stdout: '/repo\n/repo/.git/index\n/repo/.git/claude-diff-x.index\n/repo/.git/index.lock\n', stderr: '' }
    if (a[1] === 'write-tree') return { exitCode: 0, stdout: trees.shift() + '\n', stderr: '' }
    if (a[1] === 'diff' && a.includes('--numstat')) return { exitCode: 0, stdout: '10\t2\ta.ts\0-\t-\tlogo.png\0', stderr: '' }
    if (a[1] === 'diff') return { exitCode: 0, stdout: 'M\0a.ts\0A\0logo.png\0', stderr: '' }
    if (a[1] === 'status') return { exitCode: 0, stdout: '# branch.head main\n', stderr: '' }
    return undefined
  })
  await start($)
  await turn($)
  const t = await band($)
  expect(t).toContain('2 files +10 −2')
  const p = await pane($, 'changes')
  expect(p.t).toMatch(/logo\.png\s+bin/)
})
test('C07 tools only', async ($, on) => {
  setup($, on, () => { throw new Error('no process') }, o => o('tool.call', async () => ({ result: { structuredPatch: [{ lines: ['+a', '+b', '-c', ' k'] }] } })), ['tool.call'])
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/x.ts', old_string: 'a', new_string: 'b' } as any)
  expect(await band($)).toContain('+2 −1')
  const p = await pane($, 'changes'); expect(p.t).toContain('(tools only)'); expect(p.t).toContain('src/x.ts')
})
test('C21 coverage deltas', async ($, on) => {
  let pct = '83.2'
  setup($, on, a => GIT(a), o => { o('fs.stat', async () => ({ value: { kind: 'file', size: 10, mtimeMs: 2_000_000, isLink: false } })); o('fs.read', async () => ({ value: `{"total":{"lines":{"pct":${pct}}}}` })) })
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'vitest --coverage' } as any)
  expect(await band($)).toContain('83.2%')
  pct = '80.9'
  await $.tool.call({ tool: 'Bash', command: 'vitest --coverage' } as any)
  const t = await band($)
  expect(t).toContain('(-2.3)'); expect(t).toContain('⚠')
})
const WT = 'worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /wt/auth\nHEAD b\nbranch refs/heads/auth\n\nworktree /wt/x\nHEAD c\nbranch refs/heads/x\n'
const mkPr = (n: number, branch: string, rollup: any[], rd: string | null, state = 'OPEN', login = 'octocat') => ({ number: n, title: 'Title ' + n, author: { login }, headRefName: branch, url: 'https://github.com/o/r/pull/' + n, isDraft: false, state, reviewDecision: rd, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: rollup, updatedAt: '2026-10-01T00:00:00Z' })
const OK = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const BAD = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }]
const RUN = [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }]
const prProc = (get: () => any[]) => (a: string[]) => {
  const g = GIT(a); if (g) return g
  if (a[0] === 'git' && a[1] === 'worktree') return { exitCode: 0, stdout: WT, stderr: '' }
  if (a[0] === 'git' && a[1] === 'status') return { exitCode: 0, stdout: '# branch.head main\n', stderr: '' }
  if (a[0] === 'gh' && a[1] === 'auth') return { exitCode: 0, stdout: '', stderr: '' }
  if (a[0] === 'gh' && a[1] === 'api') return { exitCode: 0, stdout: 'octocat\n', stderr: '' }
  if (a[0] === 'gh' && a[1] === 'pr') return { exitCode: 0, stdout: JSON.stringify(get()), stderr: '' }
  return undefined
}
const repoMock = (o: any) => o('session.repo', async () => ({ value: { root: '/repo', remote: 'git@github.com:o/r.git', internal: false, name: null } }))
test('C33 pr radar', async ($, on) => {
  setup($, on, prProc(() => [mkPr(412, 'main', OK, 'APPROVED'), mkPr(418, 'auth', BAD, 'CHANGES_REQUESTED'), mkPr(421, 'x', RUN, 'REVIEW_REQUIRED'), mkPr(400, 'x', OK, null, 'MERGED')]), repoMock)
  await start($)
  await clk.advance(6000)
  for (const surface of ['terminal', 'desktop']) {
    const p = await pane($, 'pr-radar', surface)
    expect(p.t).toContain('3 WORKTREES'); expect(p.t).toContain('#412 pass APPROVED'); expect(p.t).toContain('#418 fail CHANGES'); expect(p.t).toContain('#421 running PENDING')
  }
  expect(calls.filter(c => c.argv[1] === 'pr').length).toBe(1)
})
test('C48 toast', async ($, on) => {
  let rollup = OK
  const toasts: string[] = []
  setup($, on, prProc(() => [mkPr(418, 'auth', rollup, null)]), (o) => { repoMock(o); o('ui.toast', async (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } }); o('session.surfaces', async () => ({ value: ['desktop'] })) }, ['ui.toast'])
  await start($)
  await clk.advance(6000)
  rollup = BAD
  await clk.advance(200_000)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('PR #418'); expect(toasts[0]).toContain('CHECKS FAILING'); expect(toasts[0]).toContain('/prs')
})
test('C35 backoff', async ($, on) => {
  let fail = true
  setup($, on, a => (a[0] === 'gh' && a[1] === 'pr' ? (fail ? { exitCode: 1, stdout: '', stderr: 'boom' } : { exitCode: 0, stdout: '[]', stderr: '' }) : prProc(() => [])(a)), repoMock)
  await start($)
  await clk.advance(1000)
  const n = () => calls.filter(c => c.argv[1] === 'pr').length
  expect(n()).toBe(1)
  await clk.advance(118_000); expect(n()).toBe(1)
  await clk.advance(6000); expect(n()).toBe(2)
  await clk.advance(230_000); expect(n()).toBe(2)
  await clk.advance(15_000); expect(n()).toBe(3)
})
test('C41 ports stop', async ($, on) => {
  let phase = 0
  setup($, on, a => {
    if (a[0] === 'lsof' && a.includes('-iTCP')) return { exitCode: 0, stdout: phase ? 'p4242\ncnode\nf11\nn*:3000\np5151\ncpostgres\nn127.0.0.1:5432\n' : 'p5151\ncpostgres\nn127.0.0.1:5432\n', stderr: '' }
    if (a[0] === 'lsof') return { exitCode: 0, stdout: 'p4242\nfcwd\nn/repo/app\n', stderr: '' }
    return GIT(a)
  })
  await start($)
  phase = 1
  await turn($)
  const p = await pane($, 'ports')
  expect(p.t).toContain('STOP')
  await p.ui.press({ key: 'stop-4242' })
  expect(textOf(await p.ui.drawn())).toContain('CONFIRM')
  expect(calls.filter(c => c.argv[0] === 'kill').length).toBe(0)
  await p.ui.press({ key: 'stop-4242' })
  expect(calls.filter(c => c.argv[0] === 'kill').map(c => c.argv.join(' '))).toEqual(['kill -TERM 4242'])
})
test('C29/53 tsc budget', async ($, on) => {
  setup($, on, a => {
    if (a.includes('tsc')) return { exitCode: 2, stdout: "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.", stderr: '' }
    return GIT(a)
  }, o => { o('fs.exists', async (_$: any, e: any) => ({ value: String(e.path).endsWith('tsconfig.json') })) })
  await start($)
  const r1: any = await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: 'x' } as any)
  const r2: any = await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: 'y' } as any)
  expect(r1.context).toBeDefined(); expect(r2.context).toBeUndefined()
  expect(calls.filter(c => c.argv.includes('tsc')).length).toBe(2)
  expect(calls.filter(c => c.argv.includes('tsc'))[0]!.init.init.timeoutMs).toBe(20000)
})

test('C45 probe rejects', async ($, on) => {
  const statuses: string[] = []
  setup($, on, () => { throw new Error('no host') }, o => { o('ui.status', async (_$: any, e: any) => { statuses.push(String(e.text)); return { value: undefined } }); o('tool.call', async () => ({ result: { stdout: '3 failed, 12 passed in 2.31s', stderr: '' } })) }, ['tool.call'])
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'pytest' } as any)
  expect(statuses.join('|')).toContain('needs host commands')
  expect(await band($)).toContain('12 pass 3 fail')
})
test('C31 tsc n/a and C32 throwing checker', async ($, on) => {
  const statuses: string[] = []
  setup($, on, a => (a.includes('tsc') ? (() => { throw new Error('boom') })() : GIT(a)), o => { o('ui.status', async (_$: any, e: any) => { statuses.push(String(e.text)); return { value: undefined } }); o('fs.exists', async (_$: any, e: any) => ({ value: String(e.path).endsWith('tsconfig.json') })) })
  await start($)
  const r: any = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as any)
  expect(r.context).toBeUndefined()
  expect(r.result).toEqual({ ok: true })
  expect(statuses.join('|')).toContain('tsc: n/a')
})
test('C27 clean after errors, C26 no repeat', async ($, on) => {
  let out = "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'."
  setup($, on, a => (a.includes('tsc') ? { exitCode: out ? 2 : 0, stdout: out, stderr: '' } : GIT(a)), o => o('fs.exists', async (_$: any, e: any) => ({ value: String(e.path).endsWith('tsconfig.json') })))
  await start($)
  const e = { tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as any
  const r1: any = await $.tool.call(e)
  const r2: any = await $.tool.call(e)
  out = ''
  const r3: any = await $.tool.call(e)
  expect(r1.context?.[0]).toContain('1 error in files you touched (tsc)')
  expect(r2.context).toBeUndefined()
  expect(r3.context?.[0]).toContain('TYPECHECK: clean (tsc)')
  expect(await band($)).not.toContain('TSC')
})
test('C28 ruff', async ($, on) => {
  setup($, on, a => (a[0] === 'ruff' ? { exitCode: 1, stdout: 'a.py:3:1: F401 os imported but unused\nFound 1 error.', stderr: '' } : GIT(a)))
  await start($)
  const r: any = await $.tool.call({ tool: 'Write', file_path: '/repo/a.py', content: 'import os' } as any)
  expect(r.context?.[0]).toContain('F401')
})
test('C18 flaky', async ($, on) => {
  let out = ''
  setup($, on, a => GIT(a), o => o('tool.call', async () => ({ result: { stdout: out, stderr: '' } })), ['tool.call'])
  await start($)
  const run = async (o: string) => { out = o; await $.tool.call({ tool: 'Bash', command: 'pytest' } as any); return band($) }
  const F = 'FAILED tests/t.py::test_x - assert\n1 failed, 3 passed in 1.00s'
  const P = '4 passed in 1.00s'
  await run(F)
  expect(await run(P)).not.toContain('flaky')
  await run(F)
  expect(await run(P)).toContain('⚠ 1 flaky')
})
test('C37 idle interval', async ($, on) => {
  const at: number[] = []
  setup($, on, a => { if (a[0] === 'gh' && a[1] === 'pr') at.push(clk.now()); return prProc(() => [mkPr(418, 'auth', RUN, null)])(a) }, repoMock)
  await start($)
  await clk.advance(20 * 60_000)
  const late = at.filter(x => x - 1_000_000 > 11 * 60_000)
  expect(late.length).toBeGreaterThan(2)
  for (let i = 1; i < late.length; i++) expect(late[i]! - late[i - 1]!).toBeGreaterThanOrEqual(180_000)
  const early = at.filter(x => x - 1_000_000 < 9 * 60_000)
  for (let i = 1; i < early.length; i++) expect(early[i]! - early[i - 1]!).toBeLessThan(120_000)
})
