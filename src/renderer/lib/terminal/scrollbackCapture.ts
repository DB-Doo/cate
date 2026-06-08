// =============================================================================
// scrollbackCapture — the canonical xterm buffer->string extraction reused by
// every call site that previously hand-rolled the baseY+cursorY /
// translateToString(true) / trailing-trim loop.
// =============================================================================

import type { Terminal } from '@xterm/xterm'

export interface CaptureScrollbackOptions {
  /**
   * Exclude the cursor row from the capture. Used by the cross-window transfer /
   * session-persistence paths: the PTY re-sends the prompt line on the receiving
   * side (panelTransferAck) or on replay, so including the cursor row here would
   * duplicate the prompt and push it to the bottom behind blank viewport rows.
   * Defaults to false (include the cursor row), which is what an in-place
   * follow-output capture wants so it keeps its freshest line.
   */
  excludeCursorRow?: boolean
}

/**
 * Extract an xterm buffer's scrollback (including the visible viewport) as a
 * newline-joined string, trimming trailing blank lines. Short-circuits to a
 * previously-captured `entry.scrollback` if present.
 *
 * This is the canonical buffer->string extraction, reused by every call site
 * that previously hand-rolled the same baseY+cursorY / translateToString(true) /
 * trailing-trim loop. Pass `excludeCursorRow` for the transfer/persistence
 * variant that must not duplicate the re-sent prompt line.
 */
export function captureScrollback(
  entry: { terminal?: Terminal; scrollback?: string },
  options: CaptureScrollbackOptions = {},
): string | undefined {
  if (typeof entry.scrollback === 'string') return entry.scrollback
  const terminal = entry.terminal
  if (!terminal) return undefined
  try {
    const buffer = terminal.buffer.active
    // Capture scrollback + the active viewport (baseY rows of history plus the
    // cursor row), so a follow-output terminal keeps its freshest lines. The
    // transfer/persistence variant stops one row short of the cursor.
    const lastRow = buffer.baseY + buffer.cursorY
    const endRow = options.excludeCursorRow ? lastRow : lastRow + 1
    const lines: string[] = []
    for (let i = 0; i < endRow; i++) {
      const line = buffer.getLine(i)
      lines.push(line ? line.translateToString(true) : '')
    }
    // Trim trailing blank lines so a freshly-cleared terminal doesn't carry a
    // wall of empty rows across a transfer / save.
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    return lines.length > 0 ? lines.join('\n') : undefined
  } catch {
    return undefined
  }
}
