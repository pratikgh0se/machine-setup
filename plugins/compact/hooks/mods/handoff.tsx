// /handoff: the model writes a handoff file, the user confirms, then (only then) compaction runs. Spec s2.
// `$.session.compact` is called from `go` and nowhere else. The plugin never writes the handoff body.

export const HEADINGS = [
  { n: 1, title: 'Goal', line: '## 1. Goal' },
  { n: 2, title: 'User preferences and standing rules', line: '## 2. User preferences and standing rules' },
  { n: 3, title: 'What exists (with paths)', line: '## 3. What exists (with paths)' },
  { n: 4, title: 'Verified facts (do not re-derive)', line: '## 4. Verified facts (do not re-derive)' },
  { n: 5, title: 'Decisions (closed and open)', line: '## 5. Decisions (closed and open)' },
  { n: 6, title: 'Running background agents', line: '## 6. Running background agents' },
  { n: 7, title: 'Next steps (in order)', line: '## 7. Next steps (in order)' },
  { n: 8, title: 'Resume prompt', line: '## 8. Resume prompt' },
] as const

const GUIDE: Record<number, string> = {
  1: 'what the user wants, in two or three lines',
  2: 'model policy, how to ask questions, style, standing rules',
  3: 'files, folders, commands, with real paths',
  4: 'facts already checked, with where they came from',
  5: 'what is decided and what is still open',
  6: 'id, task, output file, and what to do with each report (or "none")',
  7: 'numbered, in order, the first one doable at once',
  8: 'a paste-ready prompt for a fresh model',
}

export const kebab = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')

export function buildPrompt(path: string, title: string, date: string, agents: { id: string; description: string }[], retryNote?: string): string {
  const seed = agents.length > 0 ? agents.map(a => `- ${a.id}: ${a.description}`).join('\n') : 'none'
  return [
    '[compact plugin · /handoff] Write a handoff file so a fresh model with no memory can continue this work.',
    `Use the Write tool to create exactly: ${path}`,
    retryNote ?? '',
    'Write the headings exactly as shown, with nothing after the title; the guide lines are instructions, do not copy them.',
    'Structure:',
    `# Handoff: ${title} (${date})`,
    'Read this whole file before doing anything else. It replaces the conversation history compaction removed.',
    ...HEADINGS.flatMap(h => [h.line, `Guide: ${GUIDE[h.n]}`]),
    'Rules: real paths, no secrets or tokens, no tool output dumps. Detail enough that nothing has to be re-derived.',
    `Running background agents right now (for each, say what to do with its report):\n${seed}`,
    'Do nothing else this turn.',
  ]
    .filter(Boolean)
    .join('\n')
}

export function compactInstructions(path: string, agentIds: string[]): string {
  return (
    `Keep one fact above all: the handoff file at ${path} is the source of truth and must be read first. ` +
    `Name the path and the running agent ids${agentIds.length ? ` (${agentIds.join(', ')})` : ''}. ` +
    'Keep decisions and the next step. Drop detail that file already holds.'
  )
}


/** Headings (as `## 7. Next steps (in order)`) that the file body lacks, matched by number. */
export function missingHeadings(body: string): string[] {
  return HEADINGS.filter(x => !new RegExp(`^#{2}\\s*${x.n}[.)]\\s*\\S`, 'm').test(body)).map(x => x.line)
}

export type HandoffArgs = { noCompact: boolean; kw?: 'go' | 'cancel' | 'retry'; slugWords: string }
export function parseArgs(args: string): HandoffArgs {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const noCompact = words.includes('--no-compact')
  const rest = words.filter(w => w !== '--no-compact')
  const only = rest.length === 1 ? rest[0] : undefined
  const kw = only === 'go' || only === 'cancel' || only === 'retry' ? only : undefined
  return { noCompact, kw, slugWords: kw ? '' : rest.join(' ') }
}
