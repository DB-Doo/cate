// =============================================================================
// Pure agent-state → notification transition rules.
// Kept in its own module (no zustand / electron imports) so it is cheaply
// unit-testable from the renderer test suite.
// =============================================================================

import type { AgentState } from '../../shared/types'

export type NotificationKind = 'waitingForInput' | 'finished' | null

/**
 * Decide whether an agent-state transition should fire an OS notification.
 *
 * Current rules:
 *   - 'waitingForInput' fires whenever the agent enters waitingForInput from a
 *     different state. NOTE: this includes 'notRunning' → 'waitingForInput',
 *     which fires the moment the screen detector classifies a freshly-started
 *     agent as idle (e.g. claude sitting at its welcome prompt). That is a
 *     known source of over-notification.
 *   - 'finished' fires whenever the agent enters 'finished' from a different
 *     state.
 */
export function decideNotification(
  prev: AgentState,
  current: AgentState,
): NotificationKind {
  if (current === 'waitingForInput' && prev !== 'waitingForInput') return 'waitingForInput'
  if (current === 'finished' && prev !== 'finished') return 'finished'
  return null
}
