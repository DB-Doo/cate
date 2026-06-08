import { BrowserWindow, ipcMain } from 'electron'
import log from '../logger'
import {
  sendToWindow,
  broadcastToAll,
  setPanelWindowMeta,
  setPanelWindowTerminalPtyId,
  listPanelWindows,
  getWindowWorkspaceId,
  getActiveMainWindow,
} from '../windowRegistry'
import { anyWindowFullscreen } from '../windows/fullscreen'
import {
  beginTerminalTransfer,
  acknowledgeTerminalTransfer,
  handleCrossWindowDropTerminalTransfer,
} from './terminal'
import type { CateWindowParams, PanelState, PanelTransferSnapshot } from '../../shared/types'
import {
  PANEL_TRANSFER,
  PANEL_RECEIVE,
  PANEL_TRANSFER_ACK,
  PANEL_WINDOWS_LIST,
  PANEL_WINDOW_SYNC_PTY,
  PANEL_WINDOW_SYNC_META,
  PANEL_WINDOW_DOCK_BACK,
} from '../../shared/ipc-channels'

interface PanelWindowDeps {
  createWindow: (params?: CateWindowParams) => BrowserWindow
}

export function registerPanelWindowHandlers({ createWindow }: PanelWindowDeps): void {
  // Panel transfer protocol
  ipcMain.handle(PANEL_TRANSFER, async (event, snapshot: PanelTransferSnapshot, targetWindowId?: number, workspaceId?: string) => {
    // Begin terminal buffering if this is a terminal transfer
    if (snapshot.terminalPtyId) {
      beginTerminalTransfer(snapshot.terminalPtyId, targetWindowId ?? -1)
    }

    if (targetWindowId) {
      // Transfer to existing window
      sendToWindow(targetWindowId, PANEL_RECEIVE, snapshot)
      // Track panel metadata for the target window (keep its existing workspace
      // id unless the caller supplied one)
      setPanelWindowMeta(targetWindowId, snapshot.panel, workspaceId)
    } else {
      // Refuse creating a new panel window while any Cate window is in
      // macOS native fullscreen — the new window would land in a separate
      // Space and appear as an empty black page. Caller should fall back to
      // keeping the panel in the source window.
      if (anyWindowFullscreen()) return null
      // Create a new panel window and send the transfer there. Pass the source
      // workspaceId so the window is registered to it at creation — otherwise it
      // is persisted to no workspace and lost on the next restart. The caller
      // SHOULD supply one, but guard against a falsy value: fall back to the
      // sender window's workspace, then the active main window's.
      const senderId = BrowserWindow.fromWebContents(event.sender)?.id
      const resolvedWorkspaceId =
        workspaceId ||
        (senderId != null ? getWindowWorkspaceId(senderId) : undefined) ||
        (() => {
          const main = getActiveMainWindow()
          return main ? getWindowWorkspaceId(main.id) : undefined
        })()
      if (!resolvedWorkspaceId) {
        log.warn('PANEL_TRANSFER: creating panel window with no workspace id — it may be lost on restart', { panelId: snapshot.panel.id })
      }
      const newWin = createWindow({
        type: 'panel',
        panelType: snapshot.panel.type,
        panelId: snapshot.panel.id,
        workspaceId: resolvedWorkspaceId,
      })

      // Track panel metadata
      setPanelWindowMeta(newWin.id, snapshot.panel, resolvedWorkspaceId)

      // Position at saved geometry if available
      if (snapshot.geometry) {
        newWin.setBounds({
          x: Math.round(snapshot.geometry.origin.x),
          y: Math.round(snapshot.geometry.origin.y),
          width: Math.round(snapshot.geometry.size.width),
          height: Math.round(snapshot.geometry.size.height),
        })
      }

      // Update target for terminal buffering
      if (snapshot.terminalPtyId) {
        beginTerminalTransfer(snapshot.terminalPtyId, newWin.id)
      }

      // Wait for the window to be ready, then send the snapshot
      newWin.webContents.once('did-finish-load', () => {
        sendToWindow(newWin.id, PANEL_RECEIVE, snapshot)
      })

      return newWin.id
    }
  })

  ipcMain.handle(PANEL_TRANSFER_ACK, async (_event, ptyId?: string) => {
    if (ptyId) {
      acknowledgeTerminalTransfer(ptyId)
    }
  })

  // List all active panel windows with their metadata and bounds
  ipcMain.handle(PANEL_WINDOWS_LIST, async () => {
    return listPanelWindows()
  })

  // Renderer reports a panel window's terminal ptyId so we can persist it for replay on next launch
  ipcMain.handle(PANEL_WINDOW_SYNC_PTY, async (event, ptyId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setPanelWindowTerminalPtyId(win.id, ptyId)
  })

  // Renderer pushes an updated PanelState — used after Save-As inside a
  // detached panel window so the windowRegistry meta (the source for
  // session persistence + the panel-window list) reflects the new
  // filePath/title/clean state instead of the at-transfer-time snapshot.
  ipcMain.handle(PANEL_WINDOW_SYNC_META, async (event, payload: { panel: PanelState; workspaceId?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !payload?.panel) return
    setPanelWindowMeta(win.id, payload.panel, payload.workspaceId)
  })

  // Double-click panel window title bar → re-integrate the panel into the main
  // window, then close the panel window. The panel's record was already removed
  // from the main workspace at detach time, so the renderer sends a full
  // snapshot (live panel + canvas/terminal state) the main window uses to
  // reconstruct it. We also arm the terminal-ownership transfer HOME — exactly
  // like a cross-window drop — so the live PTY (and any canvas child PTYs)
  // follow the panel back instead of dying with the window.
  ipcMain.handle(PANEL_WINDOW_DOCK_BACK, async (event, snapshot?: PanelTransferSnapshot) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    const mainWin = getActiveMainWindow()

    // Arm terminal transfer back to the main window so reconnectTerminal's
    // panelTransferAck on the receiving side finds a pending transfer (ack is a
    // no-op without a prior begin).
    if (mainWin && snapshot) {
      if (snapshot.terminalPtyId) {
        handleCrossWindowDropTerminalTransfer(snapshot.terminalPtyId, mainWin.id)
      }
      for (const t of Object.values(snapshot.canvasState?.childTerminals ?? {})) {
        if (t.ptyId) handleCrossWindowDropTerminalTransfer(t.ptyId, mainWin.id)
      }
    }

    // Tell the main window to re-add the panel (App.tsx re-integrates it). Send
    // ONLY to the main window so a second panel window doesn't try to claim it.
    if (mainWin) {
      sendToWindow(mainWin.id, PANEL_WINDOW_DOCK_BACK, { panelWindowId: win.id, snapshot })
    } else {
      // No main window to dock into — fall back to broadcasting the id so any
      // listener can react (and at minimum the window still closes below).
      broadcastToAll(PANEL_WINDOW_DOCK_BACK, { panelWindowId: win.id, snapshot })
    }

    // Close the panel window once the snapshot is on its way home.
    win.close()
  })
}
