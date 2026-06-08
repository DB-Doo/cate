import { BrowserWindow, ipcMain } from 'electron'
import { WINDOW_PANELS_REPORT } from '../../shared/ipc-channels'
import type { WindowPanelReport } from '../../shared/types'
import { setWindowPanels } from '../windowPanels'

/** Cross-window panel discovery: every window reports its own panels here (on
 *  appStore change). Main stamps them with the owning window and rebroadcasts the
 *  union so every window's overview + Cmd+K can find panels living elsewhere. */
export function registerWindowPanelHandlers(): void {
  ipcMain.handle(WINDOW_PANELS_REPORT, async (event, report: WindowPanelReport[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setWindowPanels(win.id, Array.isArray(report) ? report : [])
  })
}
