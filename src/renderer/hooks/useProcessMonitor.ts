// =============================================================================
// useProcessMonitor — React hook bridging to the main process shell monitor.
// Ported from ProcessMonitor.swift event handling and notification triggers.
// =============================================================================

import { useEffect, useRef } from 'react'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore } from '../stores/appStore'
import { sendOsNotification } from '../lib/osNotifications'
import { decideNotification } from './notificationTransitions'
import { createNotificationDebouncer } from './notificationDebouncer'
import type { TerminalActivity, AgentState } from '../../shared/types'

// Hold a pending waitingForInput notification for this long before firing.
// Long enough to absorb mid-task streaming pauses (~1.2s buffer-stability
// window in agentScreenDetector + slack); short enough that a genuinely parked
// agent still nudges the user within a few seconds.
const WAITING_FOR_INPUT_DEBOUNCE_MS = 3500

// -----------------------------------------------------------------------------
// Previous state tracking for transition detection
// -----------------------------------------------------------------------------

interface PreviousTerminalState {
  agentState: AgentState
  agentName: string | null
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

/**
 * Subscribe to shell activity updates from the main process and update the
 * status store accordingly. Fires OS notifications on agent state transitions
 * (agent awaiting input, agent finished). Works for any agent in
 * AGENT_DEFINITIONS (Claude Code, Codex, Gemini, etc.).
 */
export function useProcessMonitor(workspaceId: string): void {
  // Track previous states per terminal to detect transitions
  const previousStatesRef = useRef<Map<string, PreviousTerminalState>>(new Map())

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellActivityUpdate) return

    const store = useStatusStore.getState

    // Debounce activity updates per terminal to avoid cascading re-renders
    const pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>()

    // Hold waitingForInput notifications so flickers (running → waitingForInput
    // → running during streaming pauses) don't spam the user.
    const waitingDebouncer = createNotificationDebouncer<{
      title: string
      body: string
      action: { type: 'focusTerminal'; workspaceId: string; terminalId: string }
    }>(WAITING_FOR_INPUT_DEBOUNCE_MS, (payload) => sendOsNotification(payload))

    const unsubscribe = api.onShellActivityUpdate(
      (
        terminalId: string,
        activityRaw: unknown,
        agentStateRaw: unknown,
        agentNameRaw: unknown,
        subprocessActiveRaw: unknown,
      ) => {
        const terminalActivity = activityRaw as TerminalActivity
        const agentState = (agentStateRaw as AgentState) ?? 'notRunning'
        const agentName = (agentNameRaw as string | null) ?? null
        const subprocessActive = subprocessActiveRaw === true

        // Resolve the terminal's actual workspace — the hook's workspaceId is
        // always the *selected* workspace, but this event fires for ALL terminals.
        const actualWorkspaceId =
          useStatusStore.getState().terminalWorkspaceMap[terminalId] ?? workspaceId

        // Retrieve previous state for this terminal
        const prevMap = previousStatesRef.current
        const prev = prevMap.get(terminalId) || {
          agentState: 'notRunning' as AgentState,
          agentName: null,
        }

        // subprocessActive is the immediate "definitely running" signal; the
        // detector ORs it with screen activity, so push it ahead of any
        // debouncing.
        store().setSubprocessActive(actualWorkspaceId, terminalId, subprocessActive)

        // --- Update status store (debounced for activity, immediate for state transitions) ---
        const isTransition = agentState !== prev.agentState
        if (isTransition) {
          // State transitions update immediately (for notifications)
          store().setTerminalActivity(actualWorkspaceId, terminalId, terminalActivity)
          store().setAgentState(actualWorkspaceId, terminalId, agentState, agentName)
          // Clear any pending debounced update
          const pending = pendingUpdates.get(terminalId)
          if (pending) {
            clearTimeout(pending)
            pendingUpdates.delete(terminalId)
          }
        } else {
          // Steady-state updates are debounced (200ms)
          const pending = pendingUpdates.get(terminalId)
          if (pending) clearTimeout(pending)
          pendingUpdates.set(terminalId, setTimeout(() => {
            pendingUpdates.delete(terminalId)
            store().setTerminalActivity(actualWorkspaceId, terminalId, terminalActivity)
            store().setAgentState(actualWorkspaceId, terminalId, agentState, agentName)
          }, 200))
        }

        // --- OS notification triggers ---
        // Fire on transitions only — settings gating happens inside sendOsNotification.
        const displayName = agentName ?? prev.agentName ?? 'Agent'
        const action = { type: 'focusTerminal' as const, workspaceId: actualWorkspaceId, terminalId }

        const kind = decideNotification(prev.agentState, agentState)
        if (kind === 'waitingForInput') {
          // Debounced — only fire if the agent stays in waitingForInput long
          // enough to be a real "parked, awaiting you" event, not a brief
          // streaming pause.
          waitingDebouncer.request(terminalId, {
            title: `${displayName} needs input`,
            body: `${displayName} is waiting for your response.`,
            action,
          })
        } else if (kind === 'finished') {
          // The agent left waitingForInput before the debounce window
          // elapsed — drop the pending notification.
          waitingDebouncer.cancel(terminalId)
          const finishedName = prev.agentName ?? displayName
          sendOsNotification({
            title: 'Task complete',
            body: `${finishedName} has finished running.`,
            action,
          })
        } else if (agentState !== 'waitingForInput' && prev.agentState === 'waitingForInput') {
          // Left waitingForInput for some other state (e.g. running) before
          // the debounce fired — cancel.
          waitingDebouncer.cancel(terminalId)
        }

        prevMap.set(terminalId, { agentState, agentName })
      },
    )

    return () => {
      unsubscribe()
      // Clear any pending debounced updates
      for (const timer of pendingUpdates.values()) clearTimeout(timer)
      pendingUpdates.clear()
      waitingDebouncer.dispose()
    }
  }, [workspaceId])

  // --- Port updates ---
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellPortsUpdate) return

    const unsubscribe = api.onShellPortsUpdate((terminalId: string, ports: number[]) => {
      useStatusStore.getState().setTerminalPorts(terminalId, ports)
    })

    return () => { unsubscribe() }
  }, [])

  // --- CWD updates ---
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellCwdUpdate) return

    const unsubscribe = api.onShellCwdUpdate((terminalId: string, cwd: string) => {
      useStatusStore.getState().setTerminalCwd(terminalId, cwd)
    })

    return () => { unsubscribe() }
  }, [])

  // --- Git branch updates ---
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onGitBranchUpdate) return

    const unsubscribe = api.onGitBranchUpdate(
      (workspaceId: string, branch: string, isDirty: boolean) => {
        useStatusStore.getState().setGitInfo(workspaceId, branch, isDirty)
      },
    )

    return () => { unsubscribe() }
  }, [])

  // --- Start git monitor for workspace ---
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.gitMonitorStart) return

    const ws = useAppStore.getState().getWorkspace(workspaceId)
    if (ws?.rootPath) {
      api.gitMonitorStart(workspaceId, ws.rootPath)
    }

    return () => {
      api.gitMonitorStop?.(workspaceId)
    }
  }, [workspaceId])
}
