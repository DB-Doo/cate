import { describe, expect, it } from 'vitest'
import { extractFileRefs, isSafeWorkspaceRelativePath } from './fileRefs.js'

describe('extractFileRefs', () => {
  it('finds workspace-relative path and line references', () => {
    const refs = extractFileRefs('Check src/server.ts:42 and docs/readme.md line 7.')
    expect(refs).toEqual([
      { path: 'src/server.ts', line: 42 },
      { path: 'docs/readme.md', line: 7 },
    ])
  })

  it('deduplicates identical references', () => {
    const refs = extractFileRefs('src/server.ts:3 then src/server.ts:3')
    expect(refs).toEqual([{ path: 'src/server.ts', line: 3 }])
  })

  it('rejects absolute paths, parent traversal, urls, and shell metacharacters', () => {
    expect(isSafeWorkspaceRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeWorkspaceRelativePath('../secret.md')).toBe(false)
    expect(isSafeWorkspaceRelativePath('https://example.com/a.ts')).toBe(false)
    expect(isSafeWorkspaceRelativePath('src/a.ts;rm')).toBe(false)
    expect(extractFileRefs('/etc/passwd:1 ../secret.md:2 https://x.test/a.ts:3')).toEqual([])
  })
})
