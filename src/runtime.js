// In-memory runtime state shared by the scheduler, task queue and health endpoint.
export const runtime = {
  startedAt: Date.now(),
  shuttingDown: false,
  scheduler: {
    running: false,
    lastTickAt: null,
    lastTickDurationMs: null,
    dueBacklog: 0,
    lastCleanupAt: null,
  },
  pools: {
    api: { active: 0, pending: 0, limit: 0 },
    browser: { active: 0, pending: 0, limit: 0 },
    agent: { active: 0, pending: 0, limit: 0 },
  },
  // Test-mode clock offset (ms), moved by /api/test/advance-clock.
  clockOffsetMs: 0,
};

/** Current time; honours the test clock offset. Use everywhere instead of Date.now() for scheduling logic. */
export function now() {
  return Date.now() + runtime.clockOffsetMs;
}
