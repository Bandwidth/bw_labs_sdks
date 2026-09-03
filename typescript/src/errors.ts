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

/** Parse a Retry-After header value (delta-seconds or HTTP-date) into seconds. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : undefined;
  const dateMs = new Date(value).getTime();
  if (Number.isNaN(dateMs)) return undefined;
  const deltaMs = dateMs - Date.now();
  return deltaMs <= 0 ? 0 : Math.ceil(deltaMs / 1000);
}

/** The connection was refused with HTTP 429. */
export class RateLimitError extends BwSttError {
  override name = "RateLimitError";
  /** Parsed from the Retry-After response header when present. */
  readonly retryAfterSeconds?: number;
  readonly code?: string;

  constructor(message: string, retryAfterSeconds?: number, code?: string) {
    super(message);
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
    if (code !== undefined) this.code = code;
  }
}

/** The service failed with HTTP 5xx, or the request failed at the transport level (network failure, timeout). */
export class ServiceUnavailableError extends BwSttError {
  override name = "ServiceUnavailableError";
}

/** A per-key or per-instance asynchronous transcription limit was reached (HTTP 429). */
export class JobLimitError extends RateLimitError {
  override name = "JobLimitError";
  override readonly code: string;

  constructor(message: string, retryAfterSeconds?: number, code = "job_limit_reached") {
    super(message, retryAfterSeconds, code);
    this.code = code;
  }
}

export { JobLimitError as JobLimitReachedError };

/** The asynchronous transcription job platform is unavailable (HTTP 503). */
export class JobPlatformUnavailableError extends ServiceUnavailableError {
  override name = "JobPlatformUnavailableError";
  readonly code = "job_platform_unavailable";
}

/** The job id is unknown or is not visible to this API key (HTTP 404). */
export class TranscriptionNotFoundError extends BwSttError {
  override name = "TranscriptionNotFoundError";
  readonly code = "not_found";
  readonly status = 404;
}

export { TranscriptionNotFoundError as NotFoundError };

/** A transcription job reached the terminal error state. */
export class TranscriptionJobError extends BwSttError {
  override name = "TranscriptionJobError";
  readonly code: string;
  readonly jobMessage: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.jobMessage = message;
  }
}

/** The server rejected the request as invalid (HTTP 400, 413, or another unexpected 4xx). */
export class InvalidRequestError extends BwSttError {
  override name = "InvalidRequestError";
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
  }
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
