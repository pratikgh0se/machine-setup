// Pure core of Protected Files: path normalisation, rule matching and the best-effort Bash target extractor.
// No `$` here, so the gate's `.catch` can re-run it on the event alone.
import { globToRegExp, makeMatcher, normPath } from './_shared/glob'

export type Group = 'env' | 'lockfiles' | 'vault' | 'extra'
export type Kind = 'write' | 'delete' | 'move'

export type Hit = { group: Group; reason: string; short: string; fix: string }

export type Cfg = {
  env: boolean
  lockfiles: boolean
  vault: boolean
  /** Basename globs exempt from the env group. */
  allow: string[]
  ci: boolean
  /** Normalised absolute vault roots (no trailing slash). */
  vaultRoots: string[]
  /** Extra globs (option + runtime). */
  extra: string[]
  home?: string
  cwd?: string
}

export const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock']
const LOCK_SET = new Set(LOCKFILES.map(s => s.toLowerCase()))

export const baseName = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

/** Expands `~`, joins relative paths to `cwd`, collapses `.` and `..`. Relative stays relative when no cwd. */
export function normalizePath(raw: string, cwd?: string, home?: string): string {
  let p = normPath(raw.trim())
  if ((p === '~' || p.startsWith('~/')) && home) p = normPath(home) + p.slice(1)
  if (!p.startsWith('/') && cwd) p = normPath(cwd) + '/' + p
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

/** Glob list -> matcher; relative patterns containing `/` are anchored to the session cwd (a leading double-star segment matches any depth); `dir/` means `dir/**`. */
export function buildMatcher(globs: readonly string[], o: { home?: string; cwd?: string; ci?: boolean }): (p: string) => boolean {
  const list: string[] = []
  for (const g0 of globs) {
    let g = normPath(g0.trim())
    if (!g) continue
    if (g.endsWith('/')) g += '**'
    list.push(g)
  }
  if (list.length === 0) return () => false
  return makeMatcher(list, { home: o.home, cwd: o.cwd, caseInsensitive: o.ci })
}

const ENV_RE = /^\.env($|\.)/

/** Classifies one normalised path. */
export function classify(path: string, cfg: Cfg): Hit | undefined {
  const p = normPath(path)
  const base = baseName(p)
  const f = (s: string): string => (cfg.ci ? s.toLowerCase() : s)
  if (cfg.env && (cfg.ci ? /^\.env($|\.)/i : ENV_RE).test(base) && !cfg.allow.some(g => globToRegExp(g, cfg.ci).test(base))) {
    return { group: 'env', reason: 'may hold secrets', short: 'a secrets file', fix: 'Ask the user to edit it, or change .env.example.' }
  }
  if (cfg.lockfiles && LOCK_SET.has(base.toLowerCase())) {
    return {
      group: 'lockfiles',
      reason: 'lockfile managed by the package manager',
      short: 'a managed lockfile',
      fix: 'Change dependencies with npm/pnpm/yarn/bun/cargo/poetry/uv so the lockfile stays consistent.',
    }
  }
  if (cfg.vault) {
    const fp = f(p)
    for (const root of cfg.vaultRoots) {
      const r = f(root)
      if (fp === r + '/boards/engineering.md') {
        return { group: 'vault', reason: 'generated file', short: 'a generated file', fix: "Edit its source or regenerate it as the vault's _CLAUDE.md says." }
      }
      if (fp === r + '/.obsidian' || fp.startsWith(r + '/.obsidian/')) {
        return { group: 'vault', reason: 'Obsidian app settings', short: 'Obsidian app settings', fix: 'Use the Obsidian app.' }
      }
      if (fp === r + '/ledger' || fp.startsWith(r + '/ledger/')) {
        return { group: 'vault', reason: 'protected vault folder', short: 'a protected vault folder', fix: 'Ask the user.' }
      }
    }
  }
  if (cfg.extra.length && buildMatcher(cfg.extra, cfg)(p)) {
    return { group: 'extra', reason: 'matches a protected pattern', short: 'a protected path', fix: 'Ask the user.' }
  }
  return undefined
}

/** Literal-basename check for unresolvable targets (`$DIR/.env`): env and lockfile rules only. */
export function classifyLiteral(raw: string, cfg: Cfg): Hit | undefined {
  return classify(normPath(raw), { ...cfg, vault: false, extra: [] })
}

/** `unknownDir`: the target is relative and the directory it sits in could not be determined; `path` is then the spelling as typed. */
export const denyText = (path: string, hit: Hit, verb?: 'writes to' | 'deletes' | 'moves', unknownDir = false): string => {
  const tail = `To allow it once, ask the user to run: /protect allow ${path} 10m`
  const why = unknownDir ? `${hit.reason}; directory could not be determined` : hit.reason
  return verb
    ? `Protected file: this command ${verb} ${path} (${why}). Command blocked by the safety plugin. ${hit.fix} ${tail}`
    : `Protected file: ${path} (${hit.reason}). Edit blocked by the safety plugin. ${hit.fix} ${tail}`
}

// --- Bash target extraction ------------------------------------------------

export type Word = { v: string; dyn: boolean }
export type Sep = ';' | '&&' | '||' | '|' | '&' | '(' | ')'
type Tok = { k: 'w'; w: Word } | { k: 'sep'; s: Sep } | { k: 'out' } | { k: 'in' }

export function tokenize(s: string): Tok[] {
  const toks: Tok[] = []
  const n = s.length
  let i = 0
  let cur = ''
  let dyn = false
  let has = false
  const heredocs: { delim: string; strip: boolean }[] = []
  const flush = (): void => {
    if (has) toks.push({ k: 'w', w: { v: cur, dyn } })
    cur = ''
    dyn = false
    has = false
  }
  const balanced = (open: string, close: string): void => {
    let depth = 0
    while (i < n) {
      const ch = s[i] as string
      cur += ch
      i++
      if (ch === open) depth++
      else if (ch === close && --depth === 0) return
    }
  }
  const backtick = (): void => {
    cur += '`'
    i++
    while (i < n && s[i] !== '`') { cur += s[i]; i++ }
    cur += '`'
    i++
  }
  while (i < n) {
    const c = s[i] as string
    if (c === "'") {
      i++
      has = true
      while (i < n && s[i] !== "'") { cur += s[i]; i++ }
      i++
      continue
    }
    if (c === '"') {
      i++
      has = true
      while (i < n && s[i] !== '"') {
        const d = s[i] as string
        if (d === '\\' && i + 1 < n && '"\\$`\n'.includes(s[i + 1] as string)) {
          if (s[i + 1] !== '\n') cur += s[i + 1]
          i += 2
        } else if (d === '$') {
          dyn = true
          if (s[i + 1] === '(') { cur += '$'; i++; balanced('(', ')') }
          else if (s[i + 1] === '{') { cur += '$'; i++; balanced('{', '}') }
          else { cur += '$'; i++ }
        } else if (d === '`') {
          dyn = true
          backtick()
        } else { cur += d; i++ }
      }
      i++
      continue
    }
    if (c === '\n') {
      flush()
      toks.push({ k: 'sep', s: ';' })
      i++
      for (const h of heredocs) {
        while (i < n) {
          let j = s.indexOf('\n', i)
          if (j < 0) j = n
          const line = s.slice(i, j)
          i = Math.min(n, j + 1)
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
        }
      }
      heredocs.length = 0
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i += 2; continue }
      if (i + 1 < n) { cur += s[i + 1]; has = true }
      i += 2
      continue
    }
    if (c === '#' && !has) {
      while (i < n && s[i] !== '\n') i++
      continue
    }
    if (c === '$') {
      dyn = true
      has = true
      if (s[i + 1] === '(') { cur += '$'; i++; balanced('(', ')') }
      else if (s[i + 1] === '{') { cur += '$'; i++; balanced('{', '}') }
      else { cur += '$'; i++ }
      continue
    }
    if (c === '`') { dyn = true; has = true; backtick(); continue }
    if (c === '*' || c === '?' || c === '[') { dyn = true; has = true; cur += c; i++; continue }
    if (c === ';') { flush(); toks.push({ k: 'sep', s: ';' }); i++; continue }
    if (c === '(' || c === ')') { flush(); toks.push({ k: 'sep', s: c }); i++; continue }
    if (c === '|') { flush(); toks.push({ k: 'sep', s: s[i + 1] === '|' ? '||' : '|' }); i += s[i + 1] === '|' || s[i + 1] === '&' ? 2 : 1; continue }
    if (c === '&') {
      flush()
      if (s[i + 1] === '>') {
        i += 2
        if (s[i] === '>') i++
        toks.push({ k: 'out' })
      } else {
        toks.push({ k: 'sep', s: s[i + 1] === '&' ? '&&' : '&' })
        i += s[i + 1] === '&' ? 2 : 1
      }
      continue
    }
    if (c === '>') {
      if (has && !dyn && /^\d+$/.test(cur)) { cur = ''; has = false } else flush()
      i++
      if (s[i] === '>') i++
      else if (s[i] === '|') i++
      else if (s[i] === '&') {
        const m = /^&(\d+|-)/.exec(s.slice(i))
        if (m) { i += m[0].length; continue }
        i++
      }
      toks.push({ k: 'out' })
      continue
    }
    if (c === '<') {
      flush()
      if (s[i + 1] === '<' && s[i + 2] === '<') { i += 3; toks.push({ k: 'in' }); continue }
      if (s[i + 1] === '<') {
        i += 2
        let strip = false
        if (s[i] === '-') { strip = true; i++ }
        while (s[i] === ' ' || s[i] === '\t') i++
        let d = ''
        while (i < n && !/[\s;|&<>()]/.test(s[i] as string)) {
          const ch = s[i] as string
          if (ch !== "'" && ch !== '"' && ch !== '\\') d += ch
          i++
        }
        heredocs.push({ delim: d, strip })
        continue
      }
      i += s[i + 1] === '&' ? 2 : 1
      toks.push({ k: 'in' })
      continue
    }
    cur += c
    has = true
    i++
  }
  flush()
  return toks
}

// `undefined` = the session cwd; 'unknown' = could not be determined; otherwise a path (absolute, or relative to the session cwd when no cwd was supplied).
export type Dir = string | undefined
export type Target = { raw: string; dyn: boolean; kind: Kind; cwd: Dir }
type Cmd = { words: Word[]; outs: Word[] }

const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun', 'bunx', 'cargo', 'poetry', 'uv', 'pip', 'pip3', 'npx', 'pnpx', 'corepack'])
const WRAP = new Set(['sudo', 'doas', 'command', 'nohup', 'time', 'exec', 'builtin', 'env', 'nice'])
const KW = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'fi', 'done'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const DELETERS = new Set(['rm', 'unlink', 'shred', 'truncate', 'trash', 'trash-put'])
const COPIERS = new Set(['cp', 'install', 'ln', 'rsync'])
const CD = new Set(['cd', 'chdir'])
const MAX_DIRS = 8

/** Operands: skips flags, everything after `--` counts. */
function operands(args: Word[]): Word[] {
  const out: Word[] = []
  let rest = false
  for (const a of args) {
    if (!rest && a.v === '--') { rest = true; continue }
    if (!rest && a.v.length > 1 && a.v.startsWith('-')) continue
    if (a.v === '') continue
    out.push(a)
  }
  return out
}

const tgt = (w: Word, kind: Kind, cwd: Dir): Target => ({ raw: w.v, dyn: w.dyn, kind, cwd })

function inplaceFiles(args: Word[], inplace: (a: string) => boolean): Word[] {
  if (!args.some(a => inplace(a.v))) return []
  let hasScriptFlag = false
  const rest: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as Word
    if (a.v === '-e' || a.v === '-f' || a.v === '--expression' || a.v === '--file') { hasScriptFlag = true; k++; continue }
    if (a.v.startsWith('-') && a.v.length > 1) continue
    if (a.v === '') continue
    rest.push(a)
  }
  return hasScriptFlag ? rest : rest.slice(1)
}

const isRel = (v: string): boolean => !v.startsWith('/') && !v.startsWith('~')

/** Resolves a directory word against the current directory. Anything dynamic or unparsable gives 'unknown'. */
function resolveDir(w: Word, cur: Dir, home: string | undefined): Dir {
  const v = w.v
  if (w.dyn) return 'unknown'
  if (v.startsWith('~') && v !== '~' && !v.startsWith('~/')) return 'unknown'
  if ((v === '~' || v.startsWith('~/')) && !home) return 'unknown'
  if (cur === 'unknown' && isRel(v)) return 'unknown'
  const r = normalizePath(v, cur === 'unknown' ? undefined : cur, home)
  if (r.startsWith('~')) return 'unknown'
  if (r === '') return undefined
  return r === 'unknown' ? './unknown' : r
}

/** Strips shell keywords, `VAR=x` prefixes and wrappers (`sudo`, `command`, ...): the words of the real command. */
function stripPrefix(words: Word[]): Word[] {
  const ws = words.slice()
  for (;;) {
    const f = ws[0]
    if (!f) break
    if (KW.has(f.v) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(f.v)) { ws.shift(); continue }
    if (WRAP.has(f.v)) {
      ws.shift()
      while (ws[0] && ws[0].v.startsWith('-')) ws.shift()
      continue
    }
    break
  }
  return ws
}

function fromCommand(c: Cmd, dir: Dir, home: string | undefined, depth: number): Target[] {
  const ws = stripPrefix(c.words)
  const first = ws[0]
  const name = first ? baseName(first.v) : ''
  if (PKG.has(name)) return []
  const args = ws.slice(1)
  const res: Target[] = c.outs.map(w => tgt(w, 'write', dir))
  if (!first) return res

  if (name === 'tee') for (const w of operands(args)) res.push(tgt(w, 'write', dir))
  else if (name === 'sed') for (const w of inplaceFiles(args, a => (a.startsWith('--') ? a.startsWith('--in-place') : /^-[A-Za-z]*i/.test(a)))) res.push(tgt(w, 'write', dir))
  else if (name === 'perl') for (const w of inplaceFiles(args, a => !a.startsWith('--') && /^-[A-Za-z]*i/.test(a))) res.push(tgt(w, 'write', dir))
  else if (COPIERS.has(name)) {
    const ops = operands(args)
    if (ops.length >= 2) res.push(tgt(ops[ops.length - 1] as Word, 'write', dir))
  } else if (name === 'dd') {
    for (const a of args) if (a.v.startsWith('of=')) res.push({ raw: a.v.slice(3), dyn: a.dyn, kind: 'write', cwd: dir })
  } else if (DELETERS.has(name)) for (const w of operands(args)) res.push(tgt(w, 'delete', dir))
  else if (name === 'mv') for (const w of operands(args)) res.push(tgt(w, 'move', dir))
  else if (name === 'git') {
    let k = 0
    let eff = dir
    while (k < args.length && (args[k] as Word).v.startsWith('-')) {
      const a = args[k] as Word
      if (a.v === '-C') {
        const d = args[k + 1]
        eff = d ? resolveDir(d, eff, home) : 'unknown'
        k += 2
      } else k += a.v === '-c' ? 2 : 1
    }
    const sub = args[k]?.v
    if (sub === 'rm') for (const w of operands(args.slice(k + 1))) res.push(tgt(w, 'delete', eff))
    else if (sub === 'mv') for (const w of operands(args.slice(k + 1))) res.push(tgt(w, 'move', eff))
  } else if (SHELLS.has(name) && depth < 2) {
    const ci = args.findIndex(a => /^-[A-Za-z]*c$/.test(a.v))
    const script = ci >= 0 ? args[ci + 1] : undefined
    if (script && !script.dyn) res.push(...walk(tokenize(script.v), home, dir, depth + 1))
  }
  return res
}

const uniq = (ds: Dir[]): Dir[] => {
  const out: Dir[] = []
  for (const d of ds) if (!out.includes(d)) out.push(d)
  return out.length > MAX_DIRS ? [...out.slice(0, MAX_DIRS - 1), 'unknown'] : out
}

/** Directories after a cd-like command that ran in each of `dirs`. Returns undefined when the command is not a directory change. */
function nextDirs(name: string, args: Word[], dirs: Dir[], stack: Dir[][], home: string | undefined): Dir[] | undefined {
  if (name === 'popd') {
    if (args.length || stack.length === 0) return ['unknown']
    return stack.pop() as Dir[]
  }
  const pushing = name === 'pushd'
  if (!pushing && !CD.has(name)) return undefined
  const ops: Word[] = []
  let bad = false
  let rest = false
  for (const a of args) {
    if (!rest && a.v === '--') { rest = true; continue }
    if (!rest && !a.dyn && /^-[PLe@]+$/.test(a.v)) continue
    ops.push(a)
  }
  if (pushing) {
    // `pushd` with no operand swaps, `+N`/`-N` rotate, `-n` suppresses the cd: none of those is tracked.
    if (ops.length === 0 || ops.some(a => !a.dyn && /^[-+]\d*$/.test(a.v)) || ops.some(a => !a.dyn && /^-[a-zA-Z]/.test(a.v))) bad = true
    stack.push(dirs)
  }
  if (bad || ops.length > 1 || (!pushing && ops[0] && !ops[0].dyn && ops[0].v === '-')) return ['unknown']
  const op = ops[0]
  if (!op) return home ? [normalizePath(home)] : ['unknown']
  return uniq(dirs.map(d => resolveDir(op, d, home)))
}

/** Walks the token stream, tracking the working directory (cd, pushd, popd, subshells, pipelines). */
function walk(toks: Tok[], home: string | undefined, start: Dir, depth: number): Target[] {
  const res: Target[] = []
  const seen = new Set<string>()
  let dirs: Dir[] = [start]
  let base: Dir[] = dirs
  let stack: Dir[][] = []
  const frames: { dirs: Dir[]; base: Dir[]; stack: Dir[][] }[] = []
  let words: Word[] = []
  let outs: Word[] = []
  let expect: 'out' | 'in' | null = null
  let prev: Sep | '' = ''

  const run = (after: Sep | ''): void => {
    const cmd: Cmd = { words, outs }
    for (const d of dirs) {
      for (const t of fromCommand(cmd, d, home, depth)) {
        const key = `${t.kind}\0${t.cwd ?? ''}\0${t.dyn ? 1 : 0}\0${t.raw}`
        if (!seen.has(key)) { seen.add(key); res.push(t) }
      }
    }
    const ws = stripPrefix(words)
    const first = ws[0]
    if (!first) return
    const saved = stack.slice()
    const nx = nextDirs(baseName(first.v), ws.slice(1), dirs, stack, home)
    if (!nx) return
    // A cd in a pipeline segment or a background job runs in a subshell: the change is dropped.
    if (prev === '|' || after === '|' || after === '&') { stack = saved; return }
    dirs = uniq(nx)
  }
  const finish = (after: Sep | ''): void => {
    if (words.length || outs.length) run(after)
    words = []
    outs = []
    expect = null
  }

  for (const t of toks) {
    if (t.k === 'w') {
      if (expect === 'out') outs.push(t.w)
      else if (expect === 'in') { /* input redirect target: ignored */ }
      else words.push(t.w)
      expect = null
    } else if (t.k === 'sep') {
      finish(t.s)
      if (t.s === '(') {
        frames.push({ dirs, base, stack: stack.slice() })
      } else if (t.s === ')') {
        const f = frames.pop()
        if (f) { dirs = f.dirs; base = f.base; stack = f.stack }
      } else if (t.s === ';' || t.s === '||') {
        // The previous command may have failed (a cd after `&&` never ran): keep every directory we might still be in.
        dirs = uniq([...dirs, ...base])
        base = dirs
      }
      prev = t.s
    } else expect = t.k
  }
  finish('')
  return res
}

export type ExtractOpts = { cwd?: string; home?: string }

/**
 * Write, delete and move targets of a shell command line. Best effort, never complete.
 * With `opts.cwd` every target's `cwd` is absolute or 'unknown'. Without it, `cwd` is undefined (session cwd),
 * relative to the session cwd, absolute, or 'unknown'; the caller resolves it.
 */
export function extractTargets(command: string, opts: ExtractOpts = {}, depth = 0): Target[] {
  const start: Dir = opts.cwd ? normalizePath(opts.cwd, undefined, opts.home) || undefined : undefined
  return walk(tokenize(command), opts.home, start, depth)
}

export const verbOf = (k: Kind): 'writes to' | 'deletes' | 'moves' => (k === 'delete' ? 'deletes' : k === 'move' ? 'moves' : 'writes to')
