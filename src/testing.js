// Hooks used only by the e2e harness (EARLYBIRD_TEST=1). Services register handlers here.
export const testHooks = {
  /** Run one scheduler tick now (and wait for due runs to finish). */
  tick: async () => ({ ran: 0 }),
  /** Drain queued agent tasks now. */
  drainTasks: async () => ({ started: 0 }),
  /** Drain the Discord outbox now. */
  drainOutbox: async () => ({ sent: 0 }),
  /** Run cleanup now. */
  cleanup: async () => ({}),
};
