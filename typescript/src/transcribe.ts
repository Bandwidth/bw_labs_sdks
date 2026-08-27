import {
  AuthenticationError,
  InvalidRequestError,
  parseRetryAfter,
  ProtocolError,
  RateLimitError,
  ServiceUnavailableError,
} from "./errors";
import type { Word } from "./events";
import {
  API_KEY_HEADER,
  TRANSCRIBE_MAX_AUDIO_DESCRIPTION,
} from "./wire";
import type { TRANSCRIBE_RAW_CONTENT_TYPE, TRANSCRIBE_WAV_CONTENT_TYPE } from "./wire";

export interface TranscriptionSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Result of an offline transcription. Wire mapping: `request_id` -> requestId,
 * `audio_duration_seconds` -> audioDurationSeconds. `words` may be empty.
 * `raw` preserves the full response body for fields this SDK version does not
 * model.
 */
export interface Transcription {
  readonly requestId: string;
  readonly text: string;
  readonly words: readonly Word[];
  readonly segments: readonly TranscriptionSegment[];
  readonly audioDurationSeconds: number;
  readonly raw: Record<string, unknown>;
}

export interface TranscribeRequest {
  url: string;
  apiKey: string;
  body: Uint8Array;
  contentType: typeof TRANSCRIBE_RAW_CONTENT_TYPE | typeof TRANSCRIBE_WAV_CONTENT_TYPE;
  timeoutMs: number;
  signal?: AbortSignal;
}

function composeSignals(timeout: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  if (caller === undefined) return timeout;
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return any([timeout, caller]);
  const controller = new AbortController();
  for (const signal of [timeout, caller]) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** The whole-request deadline spans connection, headers, and body parse. */
export async function requestTranscription(request: TranscribeRequest): Promise<Transcription> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  const timeoutError = () =>
    new ServiceUnavailableError(`transcribe request timed out after ${request.timeoutMs} ms`);
  const callerAborted = () => request.signal?.aborted === true;
  try {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: {
          [API_KEY_HEADER]: request.apiKey,
          "Content-Type": request.contentType,
        },
        body: request.body,
        signal: composeSignals(controller.signal, request.signal),
      });
    } catch (cause) {
      if (callerAborted()) throw request.signal?.reason ?? cause;
      if (timedOut) throw timeoutError();
      throw new ServiceUnavailableError("transcribe request failed", { cause });
    }
    if (!response.ok) {
      throw await mapHttpFailure(response);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      if (callerAborted()) throw request.signal?.reason ?? cause;
      if (timedOut) throw timeoutError();
      throw new ProtocolError("transcribe response is not valid JSON", { cause });
    }
    return parseTranscription(payload);
  } finally {
    clearTimeout(timer);
  }
}

async function mapHttpFailure(response: Response): Promise<Error> {
  const status = response.status;
  if (status === 401 || status === 403) {
    return new AuthenticationError(`the API key was rejected (HTTP ${status})`, status);
  }
  if (status === 429) {
    return new RateLimitError(
      "transcribe request refused: rate or concurrency limit reached (HTTP 429)",
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  if (status === 413) {
    return new InvalidRequestError(
      `audio exceeds the transcribe limit of ${TRANSCRIBE_MAX_AUDIO_DESCRIPTION} (HTTP 413)`,
      status,
    );
  }
  if (status >= 500) {
    return new ServiceUnavailableError(`transcribe service unavailable (HTTP ${status})`);
  }
  const detail = await response.text().catch(() => "");
  return new InvalidRequestError(
    `transcribe request rejected (HTTP ${status})${detail ? `: ${detail}` : ""}`,
    status,
  );
}

function parseTranscription(payload: unknown): Transcription {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProtocolError("transcribe response is not a JSON object");
  }
  const raw = payload as Record<string, unknown>;
  if (typeof raw.request_id !== "string") throw new ProtocolError("transcribe response is missing request_id");
  if (typeof raw.text !== "string") throw new ProtocolError("transcribe response is missing text");
  if (typeof raw.audio_duration_seconds !== "number") {
    throw new ProtocolError("transcribe response is missing audio_duration_seconds");
  }
  const rawWords = raw.words ?? [];
  if (!Array.isArray(rawWords)) throw new ProtocolError("transcribe response words is not an array");
  const words: Word[] = rawWords.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new ProtocolError(`transcribe response words[${index}] is not an object`);
    }
    const word = entry as Record<string, unknown>;
    if (typeof word.word !== "string" || typeof word.start !== "number" || typeof word.end !== "number") {
      throw new ProtocolError(`transcribe response words[${index}] is malformed`);
    }
    return { word: word.word, start: word.start, end: word.end };
  });
  const rawSegments = raw.segments ?? [];
  if (!Array.isArray(rawSegments)) {
    throw new ProtocolError("transcribe response segments is not an array");
  }
  const segments: TranscriptionSegment[] = rawSegments.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new ProtocolError(`transcribe response segments[${index}] is not an object`);
    }
    const segment = entry as Record<string, unknown>;
    if (typeof segment.start !== "number" || typeof segment.end !== "number" || typeof segment.text !== "string") {
      throw new ProtocolError(`transcribe response segments[${index}] is malformed`);
    }
    return { start: segment.start, end: segment.end, text: segment.text };
  });
  return {
    requestId: raw.request_id,
    text: raw.text,
    words,
    segments,
    audioDurationSeconds: raw.audio_duration_seconds,
    raw,
  };
}
