// Agents-local test-runner detection (Review Queue, agents.md s3 F31). Pure.
import { detectRunner, type Runner } from './_shared/testparse'

const READERS = /^(?:grep|egrep|fgrep|rg|cat|sed|head|tail|less|more|echo|printf|ls|find|awk|git\s+(?:log|show|diff|grep))\b/

/** Strip quoted text so a runner word inside quotes is not a match. */
const unquote = (s: string): string => s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' ')

/** Runner invoked by the command, judging `&&` `;` `|` segments separately; a reader command never counts. */
export function testRunnerOf(command: string): Runner | undefined {
  for (const seg of unquote(command).split(/&&|\|\||;|\||\n/)) {
    let t = seg.trim().replace(/^(?:\w+=\S*\s+)+/, '').replace(/^(?:sudo|time|env|command|exec)\s+/, '')
    if (!t || READERS.test(t)) continue
    const r = detectRunner(t)
    if (r) return r
  }
  return undefined
}
