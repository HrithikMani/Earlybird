// In-memory registry of everything currently running (scrape runs and agent tasks), so it can be stopped/killed.
const running = new Map();

/** Registers a running unit of work. Returns { controller, done() }. */
export function register(id, info) {
  const controller = new AbortController();
  const entry = { id, controller, startedAt: Date.now(), killers: [], ...info };
  running.set(id, entry);
  return {
    controller,
    signal: controller.signal,
    /** Extra cleanup for a hard kill (e.g. close MCP / browser processes). */
    onKill: (fn) => entry.killers.push(fn),
    done: () => running.delete(id),
  };
}

export function get(id) {
  return running.get(id);
}

export function list() {
  return [...running.values()].map(({ controller, killers, ...rest }) => ({ ...rest, aborted: controller.signal.aborted }));
}

/** Graceful stop: aborts the signal. */
export function stop(id, reason = 'stopped by user') {
  const e = running.get(id);
  if (!e) return false;
  e.stopRequested = reason;
  e.controller.abort(reason);
  return true;
}

/** Hard kill: abort + run killers after a grace period. */
export function kill(id, { graceMs = 5000 } = {}) {
  const e = running.get(id);
  if (!e) return false;
  e.killRequested = true;
  e.controller.abort('killed by user');
  setTimeout(async () => {
    for (const fn of e.killers) {
      try {
        await fn();
      } catch {
        // best effort
      }
    }
  }, graceMs).unref();
  return true;
}

export function stopAll(reason = 'shutting down') {
  for (const e of running.values()) e.controller.abort(reason);
}

export function count(kind) {
  let n = 0;
  for (const e of running.values()) if (!kind || e.kind === kind) n++;
  return n;
}
