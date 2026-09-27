/** Base class for every runner failure. `type` is stored on runs; `detail` is shown in the dashboard. */
export class RunnerError extends Error {
  constructor(type, message, { retryable = false, detail, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = type;
    this.type = type;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export class NetworkError extends RunnerError {
  constructor(message, opts = {}) {
    super('NetworkError', message, { retryable: true, ...opts });
  }
}

export class HttpError extends RunnerError {
  constructor(status, message, opts = {}) {
    super('HttpError', message || `HTTP ${status}`, { retryable: status >= 500, ...opts });
    this.status = status;
  }
}

export class Blocked extends RunnerError {
  constructor(message, opts = {}) {
    super('Blocked', message, { retryable: true, ...opts });
    this.status = opts.status;
  }
}

export class ParseError extends RunnerError {
  constructor(message, opts = {}) {
    super('ParseError', message, opts);
  }
}

export class SelectorNotFound extends RunnerError {
  constructor(message, opts = {}) {
    super('SelectorNotFound', message, opts);
  }
}

export class Timeout extends RunnerError {
  constructor(message, opts = {}) {
    super('Timeout', message, { retryable: true, ...opts });
  }
}

export class ScriptError extends RunnerError {
  constructor(message, opts = {}) {
    super('ScriptError', message, opts);
  }
}

export class Cancelled extends RunnerError {
  constructor(message = 'cancelled', opts = {}) {
    super('Cancelled', message, opts);
  }
}

export class InvalidRule extends RunnerError {
  constructor(message, opts = {}) {
    super('InvalidRule', message, opts);
  }
}

export class RobotsDisallowed extends RunnerError {
  constructor(message, opts = {}) {
    super('RobotsDisallowed', message, opts);
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new Cancelled(typeof signal.reason === 'string' ? signal.reason : 'cancelled');
}
