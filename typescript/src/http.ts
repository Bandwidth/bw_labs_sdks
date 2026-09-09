import { ProtocolError } from "./errors";
import { version } from "../package.json";

/** Browsers manage User-Agent themselves. */
export function userAgentHeaders(): Record<string, string> {
  return !("window" in globalThis) && typeof process !== "undefined" && process.versions?.node !== undefined
    ? { "User-Agent": `bw-stt-typescript/${version}` }
    : {};
}

/** Fetch hides redirect status and browsers may hide the reason as well. */
export function redirectFailure(cause: unknown): ProtocolError | undefined {
  if (cause instanceof Error && cause.cause instanceof Error &&
      cause.cause.message === "unexpected redirect") {
    return new ProtocolError("API redirect rejected (HTTP 3xx; status unavailable)");
  }
  return undefined;
}
