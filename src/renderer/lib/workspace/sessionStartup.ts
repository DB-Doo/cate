// =============================================================================
// Session startup — multi-workspace restore at launch, detached-window restore,
// and the pure reconstruction helpers for detached dock windows.
// =============================================================================

import log from '../logger'
import { useAppStore } from '../../stores/appStore'
import { deferredSnapshots } from './deferredRestore'
import { restoreSession } from './sessionRestore'
import { collectPanelIdsFromDockState } from './sessionSerialize'
import { mark } from '../perfMarks'
import type {
  MultiWorkspaceSession,
  PanelType,
  DetachedDockWindowSnapshot,
  DockWindowInitPayload,
  PanelTransferSnapshot,
  PanelState,
} from '../../../shared/types'

// ---------------------------------------------------------------------------
// Session-aware panel chunk prefetch — kicks off dynamic imports for only the
// panel types present in the session being restored. Fresh sessions prefetch
// the common defaults (terminal + editor + canvas).
// ---------------------------------------------------------------------------
function prefetchPanelChunks(types: ReadonlySet<PanelType>): void {
  if (types.has('terminal')) void import('../../panels/TerminalPanel')
  if (types.has('editor')) void import('../../panels/EditorPanel')
  if (types.has('browser')) void import('../../panels/BrowserPanel')
  if (types.has('canvas')) void import('../../panels/CanvasPanel')
}

// -----------------------------------------------------------------------------
// Restore — multi-workspace
// -----------------------------------------------------------------------------

export async function restoreMultiWorkspaceSession(session: MultiWorkspaceSession): Promise<void> {
  const appStore = useAppStore.getState()
  const tTotal = performance.now()
  log.debug(`[session] restoring multi-workspace session: ${session.workspaces.length} workspaces`)

  // Kick off dynamic imports for only the panel types this session uses, in
  // parallel with the restore work below. Terminal-only sessions skip Monaco.
  const presentTypes = new Set<PanelType>()
  for (const ws of session.workspaces) {
    for (const p of Object.values(ws.panels ?? {})) presentTypes.add(p.type as PanelType)
  }
  prefetchPanelChunks(presentTypes)

  // Clear any existing workspaces so we don't duplicate on every restart
  const existingIds = appStore.workspaces.map((w) => w.id)
  for (const id of existingIds) {
    appStore.removeWorkspace(id)
  }

  const selectedIdx = session.selectedWorkspaceIndex ?? 0

  // Create all workspaces (entries only) and only restore the active one's panels
  const wsIds: string[] = []
  for (let i = 0; i < session.workspaces.length; i++) {
    const snapshot = session.workspaces[i]
    log.debug(`[session] workspace ${i + 1}/${session.workspaces.length}: "${snapshot.workspaceName}" (${Object.keys(snapshot.panels ?? {}).length} panels)`)
    const wsId = appStore.addWorkspace(
      snapshot.workspaceName,
      snapshot.rootPath ?? undefined,
      snapshot.workspaceId,
      snapshot.connection,
    )
    wsIds.push(wsId)

    if (i === selectedIdx) {
      const isRemote = !!snapshot.connection && snapshot.connection.kind !== 'local'
      if (isRemote) {
        // Remote workspace: do NOT block app startup on the companion connect.
        // selectWorkspace sets the selection + 'connecting' phase synchronously
        // (before its first await), so the sidebar shows this workspace
        // immediately. Defer the snapshot so selectWorkspace's deferred-restore
        // branch replays it AFTER the companion is live (terminals/fs reads can't
        // race an unregistered companion) — the same path non-selected workspaces
        // use, and it keeps the runtime hydrate-on-open hook from double-restoring.
        deferredSnapshots.set(wsId, snapshot)
        void appStore
          .selectWorkspace(wsId)
          .catch((error) => log.error('[session] background restore of remote workspace failed:', error))
      } else {
        // Local workspace: restore into its own stores FIRST (by id), then mark
        // it selected. Doing restore before select means selectWorkspace finds
        // the center canvas already present and won't mint a throwaway one.
        await restoreSession(snapshot, wsId)
        await appStore.selectWorkspace(wsId)
      }
    } else {
      // Defer restoration — store the snapshot for lazy loading on first switch
      deferredSnapshots.set(wsId, snapshot)
    }
  }

  // Re-select the originally selected workspace (may be a no-op if already selected)
  if (selectedIdx < wsIds.length) {
    appStore.selectWorkspace(wsIds[selectedIdx])
  }

  log.debug(`[session] core session restored in ${(performance.now() - tTotal).toFixed(1)}ms`)
  mark('session-restored')
}

// -----------------------------------------------------------------------------
// Restore detached (panel + dock) windows — split out so the main window can
// paint before these (potentially slow) IPC calls run.
// -----------------------------------------------------------------------------

export async function restoreDetachedWindows(session: MultiWorkspaceSession): Promise<void> {
  // Recreate panel windows that were open at the time of last save
  if (session.panelWindows && session.panelWindows.length > 0) {
    log.debug(`[session] restoring ${session.panelWindows.length} panel windows`)
    for (const pw of session.panelWindows) {
      try {
        const snapshot: PanelTransferSnapshot = {
          panel: pw.panel,
          geometry: {
            origin: { x: pw.bounds.x, y: pw.bounds.y },
            size: { width: pw.bounds.width, height: pw.bounds.height },
          },
          sourceLocation: { type: 'canvas', canvasId: '', canvasNodeId: '' },
          terminalReplayPtyId: pw.panel.type === 'terminal' ? pw.terminalPtyId : undefined,
          rootPath: useAppStore.getState().workspaces.find((w) => w.id === pw.workspaceId)?.rootPath || undefined,
          worktrees: useAppStore.getState().workspaces.find((w) => w.id === pw.workspaceId)?.worktrees,
        }
        // Pass the persisted workspaceId so the restored panel window is
        // registered to its workspace at creation — otherwise it is saved to no
        // workspace and lost on the next restart.
        const newWindowId = await window.electronAPI.panelTransfer(snapshot, undefined, pw.workspaceId)
        if (typeof newWindowId === 'number') {
          // Position the new panel window to its saved bounds
          // The main process createWindow positions it, but we passed geometry in the snapshot
          log.debug(`[session] panel window restored: ${pw.panel.title} (windowId=${newWindowId})`)
        }
      } catch (err) {
        log.warn(`[session] failed to restore panel window "${pw.panel.title}":`, err)
      }
    }
  }

  // Recreate dock windows that were open at the time of last save. Unlike a
  // LIVE single-panel detach (dragDetach + buildSinglePanelDockState), a restore
  // must rebuild the FULL window: every top-level tab from dw.dockState.zones,
  // each terminal tab's scrollback replay, and each canvas tab's children.
  if (session.dockWindows && session.dockWindows.length > 0) {
    log.debug(`[session] restoring ${session.dockWindows.length} dock windows`)
    for (const dw of session.dockWindows) {
      try {
        const init = buildDockWindowRestoreInit(dw)
        // A window with no top-level panels has nothing to show — skip it.
        if (init.topLevelPanelIds.length === 0) continue

        const restoreWs = useAppStore.getState().workspaces.find((w) => w.id === dw.workspaceId)
        const rootPath = restoreWs?.rootPath || undefined
        await window.electronAPI.dockWindowRestore({
          ...dw,
          initPayload: {
            ...init.initPayload,
            rootPath: rootPath ?? init.initPayload.rootPath,
            worktrees: restoreWs?.worktrees ?? init.initPayload.worktrees,
          },
        })
        log.debug(`[session] dock window restored: ${init.topLevelPanelIds.length} top-level tabs, ${Object.keys(dw.panels).length} panels`)
      } catch (err) {
        log.warn(`[session] failed to restore dock window:`, err)
      }
    }
  }

}

/**
 * Pure, testable reconstruction of a detached dock window from its persisted
 * snapshot. Returns the list of TOP-LEVEL panels (those referenced by the dock
 * zones — canvas CHILDREN live in dw.panels WITHOUT a zone reference) and a full
 * DockWindowInitPayload that restores the ORIGINAL zone/stack/tab layout with:
 *   • every top-level terminal tab seeded for scrollback replay
 *     (terminalReplayPtyIds[panelId] = dw.terminalPtyIds[panelId]), and
 *   • every top-level canvas tab's children hydrated via buildRestoredCanvasState
 *     (nodes + childPanels + childTerminals replay hints).
 * Back-compat: a snapshot without canvasStates degrades to empty canvases.
 */
export function buildDockWindowRestoreInit(
  dw: DetachedDockWindowSnapshot,
): { topLevelPanelIds: string[]; initPayload: DockWindowInitPayload } {
  const topLevelIds = collectPanelIdsFromDockState(dw.dockState.zones)
  const topLevelSet = new Set(topLevelIds)

  const terminalReplayPtyIds: Record<string, string> = {}
  const canvasStates: Record<string, PanelTransferSnapshot['canvasState']> = {}

  for (const panelId of topLevelIds) {
    const panel = dw.panels[panelId]
    if (!panel) continue
    if (panel.type === 'terminal') {
      const ptyId = dw.terminalPtyIds?.[panelId]
      if (ptyId) terminalReplayPtyIds[panelId] = ptyId
    } else if (panel.type === 'canvas') {
      const cs = buildRestoredCanvasState(dw, panel, topLevelSet)
      if (cs) canvasStates[panelId] = cs
    }
  }

  const initPayload: DockWindowInitPayload = {
    // Send EVERY persisted panel record (top-level tabs AND canvas children) so
    // the receiving shell can resolve types/titles for all of them.
    panels: dw.panels,
    dockState: dw.dockState.zones,
    workspaceId: dw.workspaceId,
    terminalReplayPtyIds: Object.keys(terminalReplayPtyIds).length ? terminalReplayPtyIds : undefined,
    canvasStates: Object.keys(canvasStates).length ? canvasStates : undefined,
  }

  return { topLevelPanelIds: topLevelIds, initPayload }
}

/**
 * Build the `canvasState` for a detached canvas window being restored from a
 * `DetachedDockWindowSnapshot`. Pure (no store/IPC access) so it's unit-testable.
 *
 * Returns undefined when the top-level panel isn't a canvas (non-canvas dock
 * windows restore via terminalReplayPtyId only). When it IS a canvas:
 *   • nodes/viewport come from dw.canvasStates[canvasId] (empty if absent —
 *     old session files degrade gracefully to an empty canvas).
 *   • childPanels = every dw.panels entry that is NOT a top-level dock panel.
 *   • childTerminals = a `replayPtyId` restore hint per child terminal that has
 *     a persisted ptyId — the receiver spawns fresh + replays the dead PTY's log.
 */
export function buildRestoredCanvasState(
  dw: DetachedDockWindowSnapshot,
  topLevelPanel: PanelState,
  topLevelIds: Set<string>,
): PanelTransferSnapshot['canvasState'] | undefined {
  if (topLevelPanel.type !== 'canvas') return undefined

  const layout = dw.canvasStates?.[topLevelPanel.id]
  const childPanels: Record<string, PanelState> = {}
  const childTerminals: Record<string, { replayPtyId?: string }> = {}
  for (const [panelId, panel] of Object.entries(dw.panels)) {
    if (topLevelIds.has(panelId)) continue // top-level dock panels aren't canvas children
    childPanels[panelId] = panel
    if (panel.type === 'terminal') {
      const ptyId = dw.terminalPtyIds?.[panelId]
      if (ptyId) childTerminals[panelId] = { replayPtyId: ptyId }
    }
  }

  return {
    nodes: layout?.nodes ?? {},
    viewportOffset: layout?.viewportOffset ?? { x: 0, y: 0 },
    zoomLevel: layout?.zoomLevel ?? 1,
    childPanels,
    childTerminals,
  }
}
