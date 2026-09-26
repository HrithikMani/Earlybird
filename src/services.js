// Starts/stops the background services (scheduler, task queue, notifier). Filled in by later phases.
const started = [];

export async function startServices(_app) {
  // Services register here as they are built.
}

export async function stopServices() {
  for (const stop of started.reverse()) await stop();
}

export function registerStop(fn) {
  started.push(fn);
}
