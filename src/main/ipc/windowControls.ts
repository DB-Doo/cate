import { BrowserWindow, ipcMain } from 'electron'
import { windowFromEvent } from '../windowRegistry'
import { anyWindowFullscreen } from '../windows/fullscreen'
import {
  WINDOW_SET_TITLE,
  WINDOW_MINIMIZE,
  WINDOW_TOGGLE_MAXIMIZE,
  WINDOW_CLOSE,
  WINDOW_IS_MAXIMIZED,
  WINDOW_FULLSCREEN_STATE,
} from '../../shared/ipc-channels'

export function registerWindowControlHandlers(): void {
  // Renderer-driven title sync — used so each native macOS tab shows the
  // active workspace name instead of the generic app title.
  ipcMain.handle(WINDOW_SET_TITLE, async (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (typeof title === 'string' && title.length > 0) {
      win.setTitle(title)
    }
  })

  // Custom window controls (frameless Windows/Linux chrome). Per-window: resolve
  // the calling window from the IPC sender so a panel/dock window controls itself.
  ipcMain.handle(WINDOW_MINIMIZE, (event) => {
    windowFromEvent(event)?.minimize()
  })
  ipcMain.handle(WINDOW_TOGGLE_MAXIMIZE, (event) => {
    const win = windowFromEvent(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(WINDOW_CLOSE, (event) => {
    windowFromEvent(event)?.close()
  })
  ipcMain.on(WINDOW_IS_MAXIMIZED, (event) => {
    event.returnValue = windowFromEvent(event)?.isMaximized() ?? false
  })

  // Synchronous fullscreen getter — renderers hit this on every drag
  // mousemove to decide whether to enter dock-drag / cross-window mode.
  // sendSync is fine at ~60 Hz and guarantees no stale state.
  ipcMain.on(WINDOW_FULLSCREEN_STATE, (event) => {
    event.returnValue = anyWindowFullscreen()
  })
}
