// Gitignore-like glob matching (`*`, `**`, `?`). Pure. Used by safety (Protected Files), awareness (Spec Tracker), mission board.
// Forward slashes only. A pattern without `/` matches the basename at any depth (like .gitignore).

export function splitGlobs(csv: string): string[] {
  return csv.split(',').map(s => s.trim()).filter(Boolean)
}

const esc = (c: string): string => c.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/** Compile one glob to a RegExp over a normalised path. `**\/` = zero or more dirs, `**` = anything, `*` = within a segment. */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  let g = glob.replace(/\\/g, '/')
  const anchored = g.startsWith('/') || g.startsWith('~') || g.includes('/')
  if (!anchored) g = '**/' + g
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += esc(c)
  }
  return new RegExp('^' + re + '$', caseInsensitive ? 'i' : '')
}

export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

export type MatcherOpts = { home?: string; cwd?: string; caseInsensitive?: boolean }
/**
 * Matcher over a list of globs. Patterns starting `~` expand with `home`; repo-relative patterns containing `/`
 * are tried against the path as given and against the path relative to `cwd`, and also match at any depth when
 * they start with `**\/`. `match(path)` accepts absolute or relative paths.
 */
export function makeMatcher(globs: readonly string[], o: MatcherOpts = {}): (path: string) => boolean {
  const ci = o.caseInsensitive ?? false
  const home = o.home ? normPath(o.home).replace(/\/$/, '') : undefined
  const cwd = o.cwd ? normPath(o.cwd).replace(/\/$/, '') : undefined
  const res = globs.map(g => {
    let p = normPath(g)
    if (p.startsWith('~') && home) p = home + p.slice(1)
    return globToRegExp(p, ci)
  })
  return (path: string): boolean => {
    const p = normPath(path)
    const rel = cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : undefined
    return res.some(re => re.test(p) || (rel !== undefined && re.test(rel)) || (!p.startsWith('/') && re.test('/' + p)))
  }
}

export const matchGlob = (path: string, glob: string, o: MatcherOpts = {}): boolean => makeMatcher([glob], o)(path)
export const matchAny = (path: string, globs: readonly string[], o: MatcherOpts = {}): boolean => makeMatcher(globs, o)(path)
