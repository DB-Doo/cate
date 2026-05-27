// Agent-child PID first-seen tracking. Used by shell.ts to tell startup
// helpers (MCP servers + the `bun`/`node` runtimes they share names with)
// apart from tool subprocesses spawned later: anything observed within
// STARTUP_GRACE_MS of the agent first appearing is treated as a helper,
// later spawns are real tools regardless of how long they run.

/** Children first seen within this window after the agent appears count as
 *  startup helpers and are ignored. */
export const STARTUP_GRACE_MS = 5_000

const pidFirstSeen: Map<number, number> = new Map()

/** Record (if new) and return the first-seen timestamp for this PID. Callers
 *  should pass the process's *actual* start time when known so reattaching
 *  to a long-running process doesn't shift its anchor forward. */
export function recordPidFirstSeen(pid: number, firstSeen: number): number {
  const existing = pidFirstSeen.get(pid)
  if (existing != null) return existing
  pidFirstSeen.set(pid, firstSeen)
  return firstSeen
}

export function hasPidFirstSeen(pid: number): boolean {
  return pidFirstSeen.has(pid)
}

export function pruneStalePidAges(seenThisCycle: Set<number>): void {
  for (const pid of Array.from(pidFirstSeen.keys())) {
    if (!seenThisCycle.has(pid)) pidFirstSeen.delete(pid)
  }
}

export function __resetPidAges(): void {
  pidFirstSeen.clear()
}
