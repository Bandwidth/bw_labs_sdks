import type { ErrorEvent } from "./events";

/** Base class for every error thrown by this SDK. */
export class BwSttError extends Error {
  override name = "BwSttError";
}

/** The API key is missing, malformed, or was rejected (HTTP 401/403). */
export class AuthenticationError extends BwSttError {
  override name = "AuthenticationError";
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    if (status !== undefined) this.status = status;
  }
}

/** Parse a numeric Retry-After header value into seconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** The connection was refused with HTTP 429. */
export class RateLimitError extends BwSttError {
  override name = "RateLimitError";
  /** Parsed from the Retry-After response header when present. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The connection was refused with HTTP 503. */
export class ServiceUnavailableError extends BwSttError {
  override name = "ServiceUnavailableError";
}

/** The WebSocket closed before the session completed gracefully. */
export class ConnectionClosedError extends BwSttError {
  override name = "ConnectionClosedError";
  /** The last in-band Error event received before the close, if any. */
  readonly lastErrorEvent?: ErrorEvent;
  readonly closeCode?: number;
  readonly closeReason?: string;

  constructor(
    message: string,
    options: { lastErrorEvent?: ErrorEvent; closeCode?: number; closeReason?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (options.lastErrorEvent !== undefined) this.lastErrorEvent = options.lastErrorEvent;
    if (options.closeCode !== undefined) this.closeCode = options.closeCode;
    if (options.closeReason !== undefined) this.closeReason = options.closeReason;
  }
}

/** The server sent something this SDK cannot interpret, or rejected the setup in-band. */
export class ProtocolError extends BwSttError {
  override name = "ProtocolError";
  /** Set when the server rejected the session with an in-band Error event. */
  readonly errorEvent?: ErrorEvent;

  constructor(message: string, options: { errorEvent?: ErrorEvent; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (options.errorEvent !== undefined) this.errorEvent = options.errorEvent;
  }
}
