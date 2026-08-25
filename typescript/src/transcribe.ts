import {
  AuthenticationError,
  BwSttError,
  ConnectionClosedError,
  parseRetryAfter,
  ProtocolError,
  RateLimitError,
  ServiceUnavailableError,
} from "./errors";
import type { Word } from "./events";
import { API_KEY_HEADER, TRANSCRIBE_MAX_AUDIO_MINUTES } from "./wire";

/**
 * Result of an offline transcription. Wire mapping: `request_id` -> requestId,
 * `audio_duration_seconds` -> audioDurationSeconds. `raw` preserves the full
 * response body for fields this SDK version does not model.
 */
export interface Transcription {
  readonly requestId: string;
  readonly text: string;
  readonly words: readonly Word[];
  readonly audioDurationSeconds: number;
  readonly raw: Record<string, unknown>;
}

export interface TranscribeRequest {
  url: string;
  apiKey: string;
  body: Uint8Array;
  timeoutMs: number;
}

export async function requestTranscription(request: TranscribeRequest): Promise<Transcription> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: {
        [API_KEY_HEADER]: request.apiKey,
        "Content-Type": "application/octet-stream",
      },
      body: request.body,
      signal: controller.signal,
    });
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new BwSttError(`transcribe request timed out after ${request.timeoutMs} ms`);
    }
    throw new ConnectionClosedError("transcribe request failed", { cause });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw await mapHttpFailure(response);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new ProtocolError("transcribe response is not valid JSON", { cause });
  }
  return parseTranscription(payload);
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
    return new ProtocolError(
      `audio exceeds the transcribe limit of ${TRANSCRIBE_MAX_AUDIO_MINUTES} minutes (HTTP 413)`,
    );
  }
  if (status >= 500) {
    return new ServiceUnavailableError(`transcribe service unavailable (HTTP ${status})`);
  }
  const detail = await response.text().catch(() => "");
  return new ProtocolError(`transcribe request rejected (HTTP ${status})${detail ? `: ${detail}` : ""}`);
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
  return {
    requestId: raw.request_id,
    text: raw.text,
    words,
    audioDurationSeconds: raw.audio_duration_seconds,
    raw,
  };
}
