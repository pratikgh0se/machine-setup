// Resume loader text (spec s3). The hooks live in register.tsx.
export function resumeEntry(path: string): string {
  const full = `Context was compacted. Read ${path} first, then continue from its "Next steps". Handle background agent reports as that file lists.`
  return full.length <= 240 ? full : `Context was compacted. Read ${path} first, then continue from its "Next steps".`
}
