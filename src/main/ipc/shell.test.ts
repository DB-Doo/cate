import { describe, expect, it, vi } from 'vitest'
import {
  computeRawState,
  applyHysteresis,
  RUNNING_HOLD_MS,
  type HysteresisState,
  type DetectorSignals,
} from '../../renderer/lib/agentScreenDetectorLogic'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))
vi.mock('./pathValidation', () => ({ validateCwd: (p: string) => p }))
vi.mock('./terminalLogger', () => ({
  getOrCreateLogger: () => ({ append: () => {}, flush: () => {}, readAll: () => '' }),
  removeLogger: () => {},
  flushAll: () => {},
  disposeAll: () => {},
  TerminalLogger: { getLogDir: () => '' },
}))
vi.mock('../windowRegistry', () => ({
  sendToWindow: () => {},
  broadcastToAll: () => {},
  windowFromEvent: () => null,
}))
vi.mock('../shellEnv', () => ({ getShellEnv: () => ({}) }))
vi.mock('../shellResolver', () => ({ resolveShell: () => ({ path: '/bin/sh', fallback: false }) }))
vi.mock('../logger', () => ({ default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }))
vi.mock('../store', () => ({ getSettingSync: () => false }))

import { __parseEtimeForTests } from './shell'

function signals(overrides: Partial<DetectorSignals> = {}): DetectorSignals {
  return { agentPresent: true, wasAgentPresent: true, subprocessActive: false, isStreaming: false, ...overrides }
}

describe('parseEtime', () => {
  it('parses MM:SS', () => {
    expect(__parseEtimeForTests('00:42')).toBe(42)
    expect(__parseEtimeForTests('01:30')).toBe(90)
  })
  it('parses HH:MM:SS', () => {
    expect(__parseEtimeForTests('1:02:03')).toBe(3_723)
  })
  it('parses DD-HH:MM:SS', () => {
    expect(__parseEtimeForTests('2-03:04:05')).toBe(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5)
  })
  it('returns null for empty / garbage', () => {
    expect(__parseEtimeForTests('')).toBeNull()
    expect(__parseEtimeForTests('not a duration')).toBeNull()
  })
})

describe('computeRawState', () => {
  it('not present, never was → notRunning', () => {
    expect(computeRawState(signals({ agentPresent: false, wasAgentPresent: false }))).toBe('notRunning')
  })

  it('disappeared → finished', () => {
    expect(computeRawState(signals({ agentPresent: false, wasAgentPresent: true }))).toBe('finished')
  })

  it('streaming → running', () => {
    expect(computeRawState(signals({ isStreaming: true }))).toBe('running')
  })

  it('recently-spawned subprocess (no streaming yet) → running', () => {
    expect(computeRawState(signals({ subprocessActive: true }))).toBe('running')
  })

  it('present, nothing active → waitingForInput', () => {
    expect(computeRawState(signals())).toBe('waitingForInput')
  })
})

describe('applyHysteresis', () => {
  it('running → waitingForInput holds for RUNNING_HOLD_MS', () => {
    const h: HysteresisState = { lastReported: 'running', pendingWaitingSince: null }
    expect(applyHysteresis('waitingForInput', h, 1000)).toBe('running')
    expect(applyHysteresis('waitingForInput', h, 1000 + RUNNING_HOLD_MS - 1)).toBe('running')
    expect(applyHysteresis('waitingForInput', h, 1000 + RUNNING_HOLD_MS)).toBe('waitingForInput')
  })

  it('finished passes through immediately', () => {
    const h: HysteresisState = { lastReported: 'running', pendingWaitingSince: null }
    expect(applyHysteresis('finished', h, 1000)).toBe('finished')
  })

  it('running resets hold timer', () => {
    const h: HysteresisState = { lastReported: 'running', pendingWaitingSince: null }
    applyHysteresis('waitingForInput', h, 1000)
    expect(h.pendingWaitingSince).toBe(1000)
    applyHysteresis('running', h, 1500)
    expect(h.pendingWaitingSince).toBeNull()
  })
})

describe('lifecycle', () => {
  it('notRunning → waiting → running → waiting → finished', () => {
    const states: string[] = []
    const h: HysteresisState = { lastReported: null, pendingWaitingSince: null }

    let s = applyHysteresis(computeRawState(signals()), h, 0)
    h.lastReported = s; states.push(s)

    s = applyHysteresis(computeRawState(signals({ isStreaming: true })), h, 100)
    h.lastReported = s; states.push(s)

    s = applyHysteresis(computeRawState(signals({ isStreaming: false })), h, 200)
    h.lastReported = s; states.push(s) // held by hysteresis

    s = applyHysteresis(computeRawState(signals({ isStreaming: false })), h, 200 + RUNNING_HOLD_MS)
    h.lastReported = s; states.push(s)

    s = applyHysteresis(computeRawState(signals({ agentPresent: false, wasAgentPresent: true })), h, 200 + RUNNING_HOLD_MS + 1000)
    h.lastReported = s; states.push(s)

    expect(states).toEqual(['waitingForInput', 'running', 'running', 'waitingForInput', 'finished'])
  })
})
