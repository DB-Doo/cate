// =============================================================================
// windowPanelSync — every window reports its own panels to the main process so
// the cross-window panel union (windowPanelStore) stays current. This is the
// lightweight DISCOVERY path: a flat panel list, debounced, for ALL window types
// (main, dock, panel). It is deliberately separate from the heavier dock/panel
// session-persistence syncs (dockState, terminal scrollback, canvas snapshots)
// which run on their own cadence — so discovery is event-driven and never lags
// behind a 5s persistence tick.
//
// Wired once per window from useWindowRuntime. Debounced so a burst of store
// updates collapses into a single IPC.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { peekCanvasStoreForPanel, getAllCanvasStores } from '../../stores/canvasStore'
import { getLiveNodeDockLayout } from '../../panels/nodeDockRegistry'
import { buildColdStartCanvasChildOwners } from '../../sidebar/partitionWorkspacePanels'
import type { WindowPanelReport } from '../../../shared/types'

let cleanup: (() => void) | null = null

/** Build the panel id → parent canvas panel id map for one workspace by walking
 *  each mounted canvas store's nodes. Reuses the same pure ownership logic
 *  (buildColdStartCanvasChildOwners) and the same per-node layout resolution
 *  (getLiveNodeDockLayout, falling back to the canvas store's raw projection)
 *  that useWorkspaceCanvasChildOwners uses for the in-window tree — so the
 *  overview's "Other windows" section and the local tree can't disagree about
 *  which canvas hosts a panel. Reading the raw projection alone missed any panel
 *  living in a node's mini-dock that isn't the node's seed `panelId` (a second
 *  terminal added to a node, or a node whose seed was moved out). Canvases that
 *  aren't mounted are skipped (their children report as top-level, matching how
 *  the overview already treats not-yet-loaded canvases). */
function canvasChildMap(panels: Record<string, { id: string; type: string }>): Map<string, string> {
  const snapshots = []
  for (const p of Object.values(panels)) {
    if (p.type !== 'canvas') continue
    const store = peekCanvasStoreForPanel(p.id)
    if (!store) continue
    snapshots.push({
      canvasPanelId: p.id,
      nodes: Object.values(store.getState().nodes).map((node) => {
        const live = getLiveNodeDockLayout(p.id, node.id)
        return { panelId: node.panelId, dockLayout: live !== undefined ? live : node.dockLayout }
      }),
    })
  }
  return buildColdStartCanvasChildOwners(snapshots)
}

export function setupWindowPanelSync(): () => void {
  if (cleanup) return cleanup

  let timer: ReturnType<typeof setTimeout> | null = null

  const send = (): void => {
    const report: WindowPanelReport[] = []
    for (const ws of useAppStore.getState().workspaces) {
      const childToCanvas = canvasChildMap(ws.panels)
      for (const p of Object.values(ws.panels)) {
        report.push({
          panelId: p.id,
          type: p.type,
          title: p.title,
          workspaceId: ws.id,
          parentCanvasId: childToCanvas.get(p.id),
        })
      }
    }
    window.electronAPI.reportWindowPanels?.(report).catch(() => { /* best-effort */ })
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(send, 200)
  }

  // parentCanvasId is derived from the canvas stores, NOT the appStore: moving a
  // panel onto/off a canvas (addNode / removeNode — e.g. dragging a dock tab onto
  // it) mutates a canvas store while ws.panels is unchanged, so an appStore-only
  // subscription would leave the report stale and the moved panel keeps reporting
  // as top-level (the overview then renders it at base level, not nested). So
  // subscribe to every canvas store too, exactly as useWorkspaceCanvasChildOwners
  // does. The set is kept current by a cheap identity diff on each appStore change
  // (creating/removing a canvas panel always touches the appStore), so unchanged
  // stores keep their subscription instead of churning every tick.
  type CanvasStoreRef = ReturnType<typeof getAllCanvasStores>[number]
  const canvasSubs = new Map<CanvasStoreRef, () => void>()
  const syncCanvasSubscriptions = (): void => {
    const live = new Set(getAllCanvasStores())
    for (const [store, unsub] of canvasSubs) {
      if (!live.has(store)) { unsub(); canvasSubs.delete(store) }
    }
    for (const store of live) {
      if (!canvasSubs.has(store)) canvasSubs.set(store, store.subscribe(schedule))
    }
  }

  send() // initial report so other windows learn this window's panels promptly
  const unsubscribeApp = useAppStore.subscribe(() => {
    syncCanvasSubscriptions()
    schedule()
  })
  syncCanvasSubscriptions()

  cleanup = () => {
    unsubscribeApp()
    for (const unsub of canvasSubs.values()) unsub()
    canvasSubs.clear()
    if (timer) clearTimeout(timer)
    cleanup = null
  }
  return cleanup
}
