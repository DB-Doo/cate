import { describe, expect, it, beforeEach } from 'vitest'
import { STARTUP_GRACE_MS, __resetPidAges, recordPidFirstSeen, pruneStalePidAges } from './agentPidAge'

describe('agent pid first-seen tracking', () => {
  beforeEach(() => { __resetPidAges() })

  it('records first sight and returns that timestamp', () => {
    expect(recordPidFirstSeen(123, 1_000)).toBe(1_000)
  })

  it('returns the original timestamp on later calls (caller passes actual start time)', () => {
    recordPidFirstSeen(123, 1_000)
    expect(recordPidFirstSeen(123, 99_999)).toBe(1_000)
  })

  it('respects an explicit backdated first-seen for already-running PIDs', () => {
    // simulates shell.ts passing the actual process start time on first sight
    expect(recordPidFirstSeen(7, -50_000)).toBe(-50_000)
  })

  it('pruneStalePidAges drops pids missing from the cycle set', () => {
    recordPidFirstSeen(1, 1_000)
    recordPidFirstSeen(2, 1_000)
    pruneStalePidAges(new Set([1]))
    // pid 2 was pruned → re-records against a new timestamp
    expect(recordPidFirstSeen(2, 5_000)).toBe(5_000)
    // pid 1 was kept → original timestamp preserved
    expect(recordPidFirstSeen(1, 9_999)).toBe(1_000)
  })

  it('startup grace covers helpers spawned right after the agent', () => {
    const agentStartedAt = 0
    const helperFirstSeen = recordPidFirstSeen(10, STARTUP_GRACE_MS - 1)
    expect(helperFirstSeen - agentStartedAt).toBeLessThanOrEqual(STARTUP_GRACE_MS)
  })

  it('post-grace children fall outside the helper window', () => {
    const agentStartedAt = 0
    const toolFirstSeen = recordPidFirstSeen(20, STARTUP_GRACE_MS + 1)
    expect(toolFirstSeen - agentStartedAt).toBeGreaterThan(STARTUP_GRACE_MS)
  })
})
