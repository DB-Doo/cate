export interface FileRef {
  path: string
  line?: number
  column?: number
}

const PATH_REF = /(?:^|[\s([`"'])((?!https?:\/\/)(?!\/)(?!\.\.\/)[A-Za-z0-9._@+~/-]+\.[A-Za-z0-9]{1,12})(?::(\d+))?(?::(\d+))?/g
const LINE_WORD_REF = /(?:^|[\s([`"'])((?!https?:\/\/)(?!\/)(?!\.\.\/)[A-Za-z0-9._@+~/-]+\.[A-Za-z0-9]{1,12})\s+line\s+(\d+)/gi
const UNSAFE_CHARS = /[<>|;&$\\]/

export function isSafeWorkspaceRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('~')) return false
  if (value.includes('://')) return false
  if (value.split('/').some((part) => part === '..' || part === '')) return false
  if (UNSAFE_CHARS.test(value)) return false
  return true
}

function addRef(out: FileRef[], seen: Set<string>, path: string, lineRaw?: string, columnRaw?: string): void {
  if (!isSafeWorkspaceRelativePath(path)) return
  const line = lineRaw ? Number(lineRaw) : undefined
  const column = columnRaw ? Number(columnRaw) : undefined
  const ref: FileRef = { path }
  if (line !== undefined && Number.isInteger(line) && line > 0) ref.line = line
  if (column !== undefined && Number.isInteger(column) && column > 0) ref.column = column
  const key = `${ref.path}:${ref.line ?? ''}:${ref.column ?? ''}`
  if (seen.has(key)) return
  seen.add(key)
  out.push(ref)
}

interface FileRefCandidate {
  start: number
  path: string
  lineRaw?: string
  columnRaw?: string
}

export function extractFileRefs(text: string): FileRef[] {
  const candidates: FileRefCandidate[] = []
  const lineWordRanges: Array<[number, number]> = []

  for (const match of text.matchAll(LINE_WORD_REF)) {
    const start = match.index ?? 0
    lineWordRanges.push([start, start + match[0].length])
    const candidate: FileRefCandidate = { start, path: match[1] ?? '' }
    if (match[2]) candidate.lineRaw = match[2]
    candidates.push(candidate)
  }

  for (const match of text.matchAll(PATH_REF)) {
    const start = match.index ?? 0
    if (lineWordRanges.some(([from, to]) => start >= from && start < to)) continue
    const candidate: FileRefCandidate = { start, path: match[1] ?? '' }
    if (match[2]) candidate.lineRaw = match[2]
    if (match[3]) candidate.columnRaw = match[3]
    candidates.push(candidate)
  }

  const out: FileRef[] = []
  const seen = new Set<string>()
  for (const candidate of candidates.sort((a, b) => a.start - b.start)) {
    addRef(out, seen, candidate.path, candidate.lineRaw, candidate.columnRaw)
  }

  return out
}
