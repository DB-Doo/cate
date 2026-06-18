// =============================================================================
// createRecursiveWatcher — a drop-in for chokidar's per-directory watch that
// uses ONE native recursive handle on platforms that support it.
//
// Why (issue #398): chokidar v4 has no FSEvents backend, so a full-tree watch
// opens one `fs.watch` handle PER DIRECTORY. On macOS each handle is a kqueue
// file descriptor; Electron caps the process at ~8k fds, so a workspace with
// >8k directories hits `EMFILE` and floods unhandled rejections, freezing the
// UI. Node's `fs.watch(root, { recursive: true })` instead uses FSEvents
// (macOS) / ReadDirectoryChangesW (Windows) — ONE OS handle for the whole
// subtree, independent of directory count (the same model VS Code uses).
//
// Linux has no native recursive watch, so there we fall back to chokidar
// unchanged. The surface exposed here is the subset both call sites already use
// (`.on('add'|'change'|'unlink'|'error')`, `.removeAllListeners()`, `.close()`),
// so swapping the import is the only change at the two sites.
// =============================================================================

import { watch as fsWatch } from 'fs'
import { stat as fsStat } from 'fs/promises'
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import path from 'path'
import { EventEmitter } from 'events'

/** The chokidar `ignored` predicate shape (also usable as a post-hoc filter). */
export type IgnoredPredicate = (filePath: string, stats?: { isDirectory(): boolean }) => boolean

/** The minimal watcher surface both call sites consume. `close()` always
 *  returns a Promise so callers can uniformly `.catch()` / `await` it,
 *  matching chokidar's async close. */
export interface RecursiveWatcher {
  on(event: 'add' | 'change' | 'unlink', listener: (filePath: string) => void): unknown
  on(event: 'error', listener: (err: unknown) => void): unknown
  removeAllListeners(): unknown
  close(): Promise<void>
}

/** Injectable seams — defaulted to the real implementations; overridden in tests
 *  so the event-mapping/filtering logic is exercised deterministically on every
 *  OS (and so the platform branch can be forced). */
export interface RecursiveWatcherDeps {
  watch?: typeof fsWatch
  stat?: (p: string) => Promise<{ isDirectory(): boolean }>
  chokidar?: (root: string, opts: { ignoreInitial: boolean; ignored: IgnoredPredicate }) => FSWatcher
  platform?: NodeJS.Platform
}

const supportsNativeRecursive = (platform: NodeJS.Platform): boolean =>
  platform === 'darwin' || platform === 'win32'

/**
 * Watch `root` recursively, emitting file `add`/`change`/`unlink` events whose
 * paths pass `ignored`. Directory events are suppressed (call sites never wire
 * dir events). On Linux, returns a chokidar watcher with the same `ignored`
 * predicate so behavior is identical to the pre-fix code there.
 */
export function createRecursiveWatcher(
  root: string,
  ignored: IgnoredPredicate,
  deps: RecursiveWatcherDeps = {},
): RecursiveWatcher {
  const platform = deps.platform ?? process.platform

  // Linux (and any future platform without native recursive watch): unchanged
  // chokidar path. The per-directory fd cost remains, but inotify limits differ
  // from macOS's fd ceiling and this preserves existing behavior.
  if (!supportsNativeRecursive(platform)) {
    const chokidar = deps.chokidar ?? chokidarWatch
    return chokidar(root, { ignoreInitial: true, ignored }) as unknown as RecursiveWatcher
  }

  const watch = deps.watch ?? fsWatch
  const stat = deps.stat ?? ((p: string) => fsStat(p))

  const emitter = new EventEmitter()
  // EMFILE etc. must never become an unhandled rejection (the original bug). A
  // listener may be attached AFTER construction, so an error raised by the
  // synchronous fs.watch() call is deferred to a microtask before emitting.
  let handle: ReturnType<typeof fsWatch> | null = null
  // Coalesce concurrent events for the same path so a burst on one file doesn't
  // fan out into N stats. Cleared once the stat settles.
  const inFlight = new Set<string>()

  const onRaw = (eventType: string, filename: string | Buffer | null): void => {
    if (!filename) return
    const fp = path.resolve(root, filename.toString())

    // Cheap, syscall-free prune FIRST: excluded basenames and hidden-ancestor
    // trees (node_modules, .git/objects, …) are dropped before any stat, so
    // churn inside an ignored subtree (npm install) can't trigger a stat storm.
    if (ignored(fp)) return
    if (inFlight.has(fp)) return
    inFlight.add(fp)

    void (async () => {
      try {
        let stats: { isDirectory(): boolean }
        try {
          stats = await stat(fp)
        } catch {
          // Path is gone → delete. (Harmless if it was a directory: no
          // subscriber prefixes a non-watched dir path.)
          emitter.emit('unlink', fp)
          return
        }
        // Suppress directory events; also re-check the predicate WITH stats so a
        // hidden-directory leaf (its name only known to be a dir after stat) is
        // pruned like chokidar would.
        if (stats.isDirectory()) return
        if (ignored(fp, stats)) return
        // The native eventType is only ADVISORY for add-vs-change: macOS reports
        // even a content modify of an existing file as `rename`, so we cannot
        // reliably tell a create from an update here. That's fine — the stat
        // above is authoritative for the ONE distinction consumers depend on
        // (existence → unlink, handled in the catch). For the rest, downstream
        // collapses them anyway: classifyExternalEvent treats create/update
        // identically and the file tree just re-reads on-disk state. So we map
        // the advisory type through best-effort and let the existence check rule.
        emitter.emit(eventType === 'change' ? 'change' : 'add', fp)
      } catch (err) {
        emitter.emit('error', err)
      } finally {
        inFlight.delete(fp)
      }
    })()
  }

  try {
    handle = watch(root, { recursive: true }, onRaw)
    handle.on('error', (err) => emitter.emit('error', err))
  } catch (err) {
    queueMicrotask(() => emitter.emit('error', err))
  }

  return {
    on: (event: string, listener: (arg: never) => void) =>
      emitter.on(event, listener as (arg: unknown) => void),
    removeAllListeners: () => emitter.removeAllListeners(),
    close: async () => {
      handle?.close()
      handle = null
      emitter.removeAllListeners()
    },
  }
}
