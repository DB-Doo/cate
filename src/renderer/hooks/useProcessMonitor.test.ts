// =============================================================================
// Tests for the agent-state → notification transition logic.
//
// These tests document the *current* behavior. Several cases marked with
// `OVER-NOTIFY` flag known sources of notification spam — they currently pass
// because the production code does fire a notification, but the user does not
// actually want one in those situations. Use these as the failing-expectation
// list when tightening the rules.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { decideNotification } from './notificationTransitions'
import type { AgentState } from '../../shared/types'

const STATES: AgentState[] = ['notRunning', 'running', 'waitingForInput', 'finished']

describe('decideNotification — fires correctly', () => {
  it('fires waitingForInput when agent transitions from running → waitingForInput', () => {
    expect(decideNotification('running', 'waitingForInput')).toBe('waitingForInput')
  })

  it('fires finished when agent transitions from running → finished', () => {
    expect(decideNotification('running', 'finished')).toBe('finished')
  })

  it('fires finished from waitingForInput → finished (user dismissed mid-prompt)', () => {
    expect(decideNotification('waitingForInput', 'finished')).toBe('finished')
  })
})

describe('decideNotification — does not fire', () => {
  it('does not fire on steady-state running', () => {
    expect(decideNotification('running', 'running')).toBeNull()
  })

  it('does not fire on steady-state waitingForInput', () => {
    expect(decideNotification('waitingForInput', 'waitingForInput')).toBeNull()
  })

  it('does not fire on steady-state finished', () => {
    expect(decideNotification('finished', 'finished')).toBeNull()
  })

  it('does not fire on running → notRunning (agent exited cleanly without finishing)', () => {
    // finished is the only "done" trigger; raw exit to notRunning is silent.
    expect(decideNotification('running', 'notRunning')).toBeNull()
  })

  it('does not fire on notRunning → running (agent just started)', () => {
    expect(decideNotification('notRunning', 'running')).toBeNull()
  })
})

describe('decideNotification — OVER-NOTIFY cases (raw transitions before debounce)', () => {
  // decideNotification is the *raw* transition rule. The hook layer wraps
  // every waitingForInput result in a debouncer (see notificationDebouncer.ts +
  // useProcessMonitor.ts WAITING_FOR_INPUT_DEBOUNCE_MS) so the flicker case
  // below results in zero actual notifications. The cases below document the
  // raw transitions that still flow through; the debouncer is what filters
  // the spam in practice.

  it('OVER-NOTIFY: fires on notRunning → waitingForInput (fresh-start spam)', () => {
    expect(decideNotification('notRunning', 'waitingForInput')).toBe('waitingForInput')
  })

  it('OVER-NOTIFY: fires on finished → waitingForInput (agent re-launched in same shell)', () => {
    expect(decideNotification('finished', 'waitingForInput')).toBe('waitingForInput')
  })

  it('OVER-NOTIFY: each running ↔ waitingForInput flicker fires another notification', () => {
    // Simulate a pause-burst-pause sequence the detector would emit if
    // streaming stalls for >1.2s between chunks.
    const sequence: AgentState[] = ['running', 'waitingForInput', 'running', 'waitingForInput']
    let prev: AgentState = 'running'
    const fired: string[] = []
    for (const next of sequence) {
      const k = decideNotification(prev, next)
      if (k) fired.push(k)
      prev = next
    }
    // Two flips up to waitingForInput → two notifications. Ideally this is 0 or 1.
    expect(fired).toEqual(['waitingForInput', 'waitingForInput'])
  })
})

describe('decideNotification — exhaustive transition matrix', () => {
  // Sanity check: only transitions *into* waitingForInput or finished can fire,
  // and only when prev is a different state.
  for (const prev of STATES) {
    for (const next of STATES) {
      it(`${prev} → ${next}`, () => {
        const result = decideNotification(prev, next)
        if (next === 'waitingForInput' && prev !== 'waitingForInput') {
          expect(result).toBe('waitingForInput')
        } else if (next === 'finished' && prev !== 'finished') {
          expect(result).toBe('finished')
        } else {
          expect(result).toBeNull()
        }
      })
    }
  }
})
