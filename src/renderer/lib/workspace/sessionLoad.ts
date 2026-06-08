// =============================================================================
// Session load — read the on-disk project files (local + remote) and assemble a
// MultiWorkspaceSession for restore.
// =============================================================================

import log from '../logger'
import { isLocalLocator } from '../../../main/companion/locator'
import { applySidebarSession } from './sidebarSession'
import { projectFilesToSnapshot } from './sessionSerialize'
import type {
  SessionSnapshot,
  MultiWorkspaceSession,
  PanelWindowSnapshot,
  DetachedDockWindowSnapshot,
  ProjectWorkspaceFile,
  ProjectSessionFile,
  RemoteProjectEntry,
} from '../../../shared/types'

export async function loadSession(): Promise<MultiWorkspaceSession | null> {
  return loadFromProjectFiles()
}

async function loadFromProjectFiles(): Promise<MultiWorkspaceSession | null> {
  let recentProjects: string[] = []
  try {
    recentProjects = (await window.electronAPI.recentProjectsGet()) ?? []
  } catch {
    recentProjects = []
  }

  // Remote (cate-companion://) workspaces never appear in recentProjects — they
  // live in the parallel remoteProjects store with their full restore snapshot
  // and reconnect info (Finding 3). Load them up front so they round-trip too.
  let remoteEntries: RemoteProjectEntry[] = []
  try {
    remoteEntries = (await window.electronAPI.remoteProjectsGet()) ?? []
  } catch {
    remoteEntries = []
  }

  if (recentProjects.length === 0 && remoteEntries.length === 0) return null

  const snapshots: SessionSnapshot[] = []
  const panelWindows: PanelWindowSnapshot[] = []
  const dockWindows: DetachedDockWindowSnapshot[] = []

  for (const rootPath of recentProjects) {
    // Defensive: a remote locator must never reach projectStateLoad (it would
    // mangle into a junk local path). Remote workspaces are loaded below.
    if (!isLocalLocator(rootPath)) continue
    try {
      const projectState = await window.electronAPI.projectStateLoad(rootPath) as {
        workspace: ProjectWorkspaceFile
        session: ProjectSessionFile | null
      } | null
      if (!projectState?.workspace) continue

      const ws = projectState.workspace
      const sess = projectState.session

      snapshots.push(projectFilesToSnapshot(ws, sess, rootPath))

      if (sess?.panelWindows) panelWindows.push(...sess.panelWindows)
      if (sess?.dockWindows) dockWindows.push(...sess.dockWindows)
    } catch (err) {
      log.warn('[session] Failed to load project state for %s: %s', rootPath, err)
    }
  }

  // Append remote workspaces. Their snapshot is self-contained (canvas layout +
  // connection), so no projectStateLoad is needed. Skip any whose connection
  // somehow went missing — without it ensureWorkspaceCompanion can't reconnect.
  for (const entry of remoteEntries) {
    if (!entry?.snapshot || !entry.connection || entry.connection.kind === 'local') continue
    const snap = entry.snapshot
    // Ensure the connection rides on the snapshot even for entries persisted
    // before connection was stored on the snapshot itself.
    snapshots.push({ ...snap, connection: snap.connection ?? entry.connection })
  }

  if (snapshots.length === 0) return null

  // Apply the persisted sidebar arrangement: reorder to the saved order and pick
  // the active workspace. Falls back to recentProjects order / index 0 when no
  // arrangement is stored yet (first run after upgrade).
  const sidebarSession = await window.electronAPI.sidebarSessionGet().catch(() => null)
  const { workspaces, selectedWorkspaceIndex } = applySidebarSession(snapshots, sidebarSession)

  return {
    version: 2,
    selectedWorkspaceIndex,
    workspaces,
    panelWindows: panelWindows.length > 0 ? panelWindows : undefined,
    dockWindows: dockWindows.length > 0 ? dockWindows : undefined,
  }
}
