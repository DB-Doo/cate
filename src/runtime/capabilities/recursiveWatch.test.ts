// Tests for createRecursiveWatcher — the native-recursive (FSEvents /
// ReadDirectoryChangesW) drop-in that replaces chokidar's per-directory
// fs.watch on macOS/Windows (fixing the EMFILE storm on large workspaces,
// issue #398). All logic is exercised through injected deps so the suite is
// deterministic on every CI OS, independent of the real platform watcher.

import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import { createRecursiveWatcher } from './recursiveWatch'

const ROOT = path.resolve('/work/repo')
const flush = () => new Promise((r) => setImmediate(r))

/** A fake node fs.watch: captures the raw (eventType, filename) callback and the
 *  'error' listener so a test can drive events synchronously. */
function fakeNativeWatch() {
  let rawCb: ((eventType: string, filename: string | Buffer | null) => void) | undefined
  let errCb: ((err: unknown) => void) | undefined
  const handle = {
    on: (ev: string, cb: (e: unknown) => void) => {
      if (ev === 'error') errCb = cb
    },
    close: vi.fn(),
  }
  const watch = vi.fn((_root: string, _opts: unknown, cb: typeof rawCb) => {
    rawCb = cb
    return handle
  })
  return {
    watch: watch as unknown as typeof import('fs').watch,
    handle,
    fire: (type: string, name: string | null) => rawCb!(type, name),
    fireError: (e: unknown) => errCb!(e),
  }
}

/** Default deps that force the native branch with a file-returning stat and a
 *  never-ignore predicate. Individual tests override pieces. */
function nativeDeps(over: Partial<Parameters<typeof createRecursiveWatcher>[2]> = {}) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    stat: vi.fn(async () => ({ isDirectory: () => false })),
    ...over,
  }
}

describe('createRecursiveWatcher (native branch)', () => {
  it("maps a 'change' on an existing file to a 'change' event with an absolute path", async () => {
    const fake = fakeNativeWatch()
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch: fake.watch }))
    const onChange = vi.fn()
    w.on('change', onChange)

    fake.fire('change', 'src/app.ts')
    await flush()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(path.join(ROOT, 'src/app.ts'))
  })

  it("maps a 'rename' on an existing file to an 'add' event", async () => {
    const fake = fakeNativeWatch()
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch: fake.watch }))
    const onAdd = vi.fn()
    w.on('add', onAdd)

    fake.fire('rename', 'new.txt')
    await flush()

    expect(onAdd).toHaveBeenCalledWith(path.join(ROOT, 'new.txt'))
  })

  it("emits 'unlink' when the path no longer exists (stat rejects)", async () => {
    const fake = fakeNativeWatch()
    const stat = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    })
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch: fake.watch, stat }))
    const onUnlink = vi.fn()
    w.on('unlink', onUnlink)

    fake.fire('rename', 'deleted.txt')
    await flush()

    expect(onUnlink).toHaveBeenCalledWith(path.join(ROOT, 'deleted.txt'))
  })

  it('suppresses directory events (call sites never wire addDir/unlinkDir)', async () => {
    const fake = fakeNativeWatch()
    const stat = vi.fn(async () => ({ isDirectory: () => true }))
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch: fake.watch, stat }))
    const onAdd = vi.fn()
    const onChange = vi.fn()
    w.on('add', onAdd)
    w.on('change', onChange)

    fake.fire('rename', 'src/newdir')
    fake.fire('change', 'src/newdir')
    await flush()

    expect(onAdd).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('cheap-prunes ignored paths WITHOUT calling stat (no stat storm in excluded trees)', async () => {
    const fake = fakeNativeWatch()
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    // ignore anything under node_modules
    const ignored = (fp: string) => fp.includes('node_modules')
    const w = createRecursiveWatcher(ROOT, ignored, nativeDeps({ watch: fake.watch, stat }))
    const onAny = vi.fn()
    w.on('add', onAny)
    w.on('change', onAny)
    w.on('unlink', onAny)

    fake.fire('change', 'node_modules/.bin/x')
    await flush()

    expect(stat).not.toHaveBeenCalled()
    expect(onAny).not.toHaveBeenCalled()
  })

  it('ignores a null filename (no stat, no emit)', async () => {
    const fake = fakeNativeWatch()
    const stat = vi.fn(async () => ({ isDirectory: () => false }))
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch: fake.watch, stat }))
    const onAny = vi.fn()
    w.on('add', onAny)

    fake.fire('rename', null)
    await flush()

    expect(stat).not.toHaveBeenCalled()
    expect(onAny).not.toHaveBeenCalled()
  })

  it('dedupes concurrent events on the same path into a single stat', async () => {
    const fake = fakeNativeWatch()
    let resolveStat: (v: { isDirectory(): boolean }) => void
    const stat = vi.fn(
      () => new Promise<{ isDirectory(): boolean }>((res) => { resolveStat = res }),
    )
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch: fake.watch, stat }))
    w.on('change', () => {})

    fake.fire('change', 'busy.txt')
    fake.fire('change', 'busy.txt') // second event while first stat is in flight
    resolveStat!({ isDirectory: () => false })
    await flush()

    expect(stat).toHaveBeenCalledTimes(1)
  })

  it("re-emits the underlying watcher's error event without throwing", async () => {
    const fake = fakeNativeWatch()
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch: fake.watch }))
    const onError = vi.fn()
    w.on('error', onError)

    const boom = new Error('EMFILE')
    fake.fireError(boom)

    expect(onError).toHaveBeenCalledWith(boom)
  })

  it('surfaces a throwing fs.watch (e.g. EMFILE at creation) as an error event, not a throw', async () => {
    const watch = vi.fn(() => {
      throw Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    }) as unknown as typeof import('fs').watch
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch }))
    const onError = vi.fn()
    w.on('error', onError) // listener attached AFTER construction must still fire
    await flush()

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as { code?: string }).code).toBe('EMFILE')
  })

  it('close() closes the underlying handle and stops emitting', async () => {
    const fake = fakeNativeWatch()
    const w = createRecursiveWatcher(ROOT, () => false, nativeDeps({ watch: fake.watch }))
    const onChange = vi.fn()
    w.on('change', onChange)

    w.close()
    fake.fire('change', 'late.txt')
    await flush()

    expect(fake.handle.close).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('createRecursiveWatcher (non-native fallback)', () => {
  it('returns a chokidar watcher unchanged on Linux and never opens a native watch', () => {
    const sentinel = { on: vi.fn(), removeAllListeners: vi.fn(), close: vi.fn() }
    const chokidar = vi.fn((_root: string, _opts: { ignoreInitial: boolean; ignored: unknown }) => sentinel)
    const nativeWatch = vi.fn()
    const ignored = () => false
    const result = createRecursiveWatcher(ROOT, ignored, {
      platform: 'linux',
      chokidar: chokidar as never,
      watch: nativeWatch as never,
    })

    expect(nativeWatch).not.toHaveBeenCalled()
    expect(chokidar).toHaveBeenCalledTimes(1)
    // chokidar called with the root, ignoreInitial, and the same ignored predicate
    expect(chokidar.mock.calls[0][0]).toBe(ROOT)
    expect(chokidar.mock.calls[0][1]).toMatchObject({ ignoreInitial: true, ignored })
    expect(result).toBe(sentinel)
  })
})
