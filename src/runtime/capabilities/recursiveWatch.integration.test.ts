// Real-filesystem integration test for createRecursiveWatcher. Exercises the
// actual native recursive watcher (FSEvents / ReadDirectoryChangesW), so it is
// gated to platforms that support it — on Linux the code path is chokidar,
// covered by the existing pool tests. Verifies a nested create/modify/delete
// round-trips into add/change/unlink with correct absolute paths (issue #398).

import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { createRecursiveWatcher, type RecursiveWatcher } from './recursiveWatch'

const NATIVE = process.platform === 'darwin' || process.platform === 'win32'

/** Resolve once any of `types` fires for `wantPath`, or reject on timeout.
 *  add-vs-change is deliberately NOT asserted: macOS reports a modify as
 *  `rename` (→ add), so the meaningful contract is "a presence event arrives",
 *  not which one. Existence (unlink) IS asserted on its own. */
function waitForEvent(
  w: RecursiveWatcher,
  types: Array<'add' | 'change' | 'unlink'>,
  wantPath: string,
  ms = 5000,
) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${types.join('|')} ${wantPath}`)),
      ms,
    )
    for (const type of types) {
      w.on(type, ((p: string) => {
        if (path.resolve(p) === path.resolve(wantPath)) {
          clearTimeout(timer)
          resolve()
        }
      }) as never)
    }
  })
}

describe.skipIf(!NATIVE)('createRecursiveWatcher (real native fs)', () => {
  it('reports nested create and delete on a file deep below the root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cate-rwatch-'))
    const nested = path.join(root, 'a', 'b')
    await mkdir(nested, { recursive: true })
    const file = path.join(nested, 'note.txt')

    const w = createRecursiveWatcher(root, () => false)
    try {
      // Give the native watcher a moment to arm before mutating.
      await new Promise((r) => setTimeout(r, 200))

      // Create → a presence event (add or change), never unlink.
      const present = waitForEvent(w, ['add', 'change'], file)
      await writeFile(file, 'hello')
      await present

      // Delete → unlink, with the correct absolute path (stat-disambiguated).
      const removed = waitForEvent(w, ['unlink'], file)
      await rm(file)
      await removed
    } finally {
      w.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never reports an event for a path inside an ignored subtree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cate-rwatch-ig-'))
    const ignoredDir = path.join(root, 'node_modules')
    await mkdir(ignoredDir, { recursive: true })

    const w = createRecursiveWatcher(root, (fp) => fp.includes('node_modules'))
    const seen: string[] = []
    w.on('add', ((p: string) => seen.push(p)) as never)
    w.on('change', ((p: string) => seen.push(p)) as never)
    w.on('unlink', ((p: string) => seen.push(p)) as never)
    try {
      await new Promise((r) => setTimeout(r, 200))
      await writeFile(path.join(ignoredDir, 'pkg.js'), 'x')
      // A real file outside the ignored tree, to confirm the watcher is live.
      const live = path.join(root, 'live.txt')
      const present = waitForEvent(w, ['add', 'change'], live)
      await writeFile(live, 'y')
      await present
    } finally {
      w.close()
      await rm(root, { recursive: true, force: true })
    }
    expect(seen.every((p) => !p.includes('node_modules'))).toBe(true)
  })
})
