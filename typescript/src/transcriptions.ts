import {
  AuthenticationError,
  InvalidRequestError,
  JobLimitError,
  JobPlatformUnavailableError,
  parseRetryAfter,
  ProtocolError,
  ServiceUnavailableError,
  TranscriptionJobError,
  TranscriptionNotFoundError,
} from "./errors";
import { toUint8Array } from "./framing";
import {
  resolveTranscribeMediaOptions,
  type TranscribeOptions,
} from "./options";
import {
  API_KEY_HEADER,
  CALLBACK_AUTH_HEADER_NAME_PARAM,
  CALLBACK_AUTH_HEADER_VALUE_PARAM,
  CALLBACK_URL_PARAM,
  TRANSCRIBE_RAW_CONTENT_TYPE,
  TRANSCRIBE_WAV_CONTENT_TYPE,
  TRANSCRIPTIONS_PATH,
  appendTranscribeQuery,
} from "./wire";
import { parseTranscription } from "./transcribe";
import type { Transcription } from "./transcribe";

export type TranscriptionJobStatus = "queued" | "processing" | "completed" | "error";

export interface TranscriptionJobErrorDetail {
  readonly code: string;
  readonly message: string;
}

export interface TranscriptionJobSubmission {
  readonly id: string;
  readonly status: TranscriptionJobStatus;
  readonly raw: Record<string, unknown>;
}

export interface TranscriptionJob {
  readonly id: string;
  readonly status: TranscriptionJobStatus;
  readonly progress: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: Transcription;
  readonly error?: TranscriptionJobErrorDetail;
  readonly raw: Record<string, unknown>;
}

export type TranscriptionJobResult = Transcription;

export interface TranscriptionJobOptions extends TranscribeOptions {
  /** Set true when the submitted bytes are headerless linear16 audio. */
  raw?: boolean;
  /** HTTPS callback destination for job completion notifications. */
  callbackUrl?: string;
  /** Header name to include on callback requests. */
  callbackAuthHeaderName?: string;
  /** Header value to include on callback requests. */
  callbackAuthHeaderValue?: string;
}

export type TranscriptionSubmitRequest = TranscriptionJobOptions &
  (
    | { audio: Uint8Array | ArrayBuffer; audioUrl?: never }
    | { audio?: never; audioUrl: string }
  );

export interface TranscriptionGetOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TranscriptionWaitOptions extends TranscriptionGetOptions {
  pollIntervalMs?: number;
}

const DEFAULT_JOB_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

function checkTimeout(timeoutMs: number, name: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function checkId(id: string): void {
  if (typeof id !== "string" || id.length === 0) throw new TypeError("id must not be empty");
}

function safeText(value: string, apiKey: string): string {
  return apiKey.length === 0 ? value : value.split(apiKey).join("[redacted]");
}

function parseObject(payload: unknown, context: string): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProtocolError(`${context} is not a JSON object`);
  }
  return payload as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string, context: string): string {
  if (typeof value[key] !== "string" || value[key] === "") {
    throw new ProtocolError(`${context} is missing a non-empty ${key}`);
  }
  return value[key] as string;
}

function parseStatus(value: unknown, context: string): TranscriptionJobStatus {
  if (value !== "queued" && value !== "processing" && value !== "completed" && value !== "error") {
    throw new ProtocolError(`${context} has an invalid status`);
  }
  return value;
}

function parseSubmission(payload: unknown): TranscriptionJobSubmission {
  const raw = parseObject(payload, "transcription submission response");
  return {
    id: requiredString(raw, "id", "transcription submission response"),
    status: parseStatus(raw.status, "transcription submission response"),
    raw,
  };
}

function parseJobError(value: unknown): TranscriptionJobErrorDetail | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = parseObject(value, "transcription job error");
  return {
    code: requiredString(raw, "code", "transcription job error"),
    message: requiredString(raw, "message", "transcription job error"),
  };
}

function parseJob(payload: unknown): TranscriptionJob {
  const raw = parseObject(payload, "transcription job response");
  const progress = raw.progress;
  if (typeof progress !== "number" || !Number.isFinite(progress)) {
    throw new ProtocolError("transcription job progress is not a finite number");
  }
  const result = raw.result === undefined || raw.result === null ? undefined : parseTranscription(raw.result);
  const error = parseJobError(raw.error);
  return {
    id: requiredString(raw, "id", "transcription job response"),
    status: parseStatus(raw.status, "transcription job response"),
    progress,
    createdAt: requiredString(raw, "created_at", "transcription job response"),
    updatedAt: requiredString(raw, "updated_at", "transcription job response"),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    raw,
  };
}

function buildTranscriptionsUrl(baseUrl: string, query: URLSearchParams): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new TypeError(`invalid baseUrl: ${baseUrl}`, { cause });
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
    throw new TypeError("baseUrl must use ws, wss, http, or https");
  }
  url.protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = TRANSCRIPTIONS_PATH;
  } else if (url.pathname.endsWith("/listen")) {
    url.pathname = url.pathname.slice(0, -"/listen".length) + "/transcriptions";
  } else if (url.pathname.endsWith("/transcribe")) {
    url.pathname = url.pathname.slice(0, -"/transcribe".length) + "/transcriptions";
  } else if (!url.pathname.endsWith("/transcriptions")) {
    url.pathname = url.pathname.replace(/\/$/, "") + "/transcriptions";
  }
  for (const [name, value] of query) url.searchParams.append(name, value);
  url.hash = "";
  return url.toString();
}

function buildJobQuery(options: TranscriptionJobOptions, rawInput: boolean, urlSource: boolean): URLSearchParams {
  const media = resolveTranscribeMediaOptions(options);
  const query = new URLSearchParams();
  appendTranscribeQuery(query, media, options, rawInput);
  if (urlSource && !rawInput) {
    if (options.channels === undefined && !media.multichannel) query.delete("channels");
    if (options.encoding !== undefined) query.set("encoding", options.encoding);
    if (options.sampleRate !== undefined) query.set("sample_rate", String(options.sampleRate));
  }
  if (options.callbackUrl !== undefined) query.append(CALLBACK_URL_PARAM, options.callbackUrl);
  if (options.callbackAuthHeaderName !== undefined) {
    query.append(CALLBACK_AUTH_HEADER_NAME_PARAM, options.callbackAuthHeaderName);
  }
  if (options.callbackAuthHeaderValue !== undefined) {
    query.append(CALLBACK_AUTH_HEADER_VALUE_PARAM, options.callbackAuthHeaderValue);
  }
  return query;
}

function jobUrl(baseUrl: string, id: string): string {
  checkId(id);
  const collection = new URL(buildTranscriptionsUrl(baseUrl, new URLSearchParams()));
  collection.pathname = `${collection.pathname.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
  return collection.toString();
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

interface JobRequest {
  readonly url: string;
  readonly apiKey: string;
  readonly method: "POST" | "GET" | "DELETE";
  readonly body?: Uint8Array | string;
  readonly contentType?: string;
  readonly expectedStatus: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly operation: string;
}

async function mapJobFailure(response: Response, apiKey: string, operation: string): Promise<Error> {
  const body = await response.text().catch(() => "");
  let code: string | undefined;
  let message: string | undefined;
  try {
    const payload = JSON.parse(body) as unknown;
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const raw = payload as Record<string, unknown>;
      if (typeof raw.code === "string" && raw.code !== "") code = raw.code;
      else if (typeof raw.error === "string" && raw.error !== "") code = raw.error;
      if (typeof raw.message === "string" && raw.message !== "") message = raw.message;
    }
  } catch {
    // The status still gives callers a useful typed error.
  }
  const detail = message === undefined ? code : message;
  const suffix = detail === undefined ? "" : `: ${safeText(detail, apiKey)}`;
  const status = response.status;
  if (status === 401 || status === 403) {
    return new AuthenticationError(`the API key was rejected (HTTP ${status})`, status);
  }
  if (status === 404) {
    return new TranscriptionNotFoundError(`transcription job not found (HTTP ${status})`);
  }
  if (status === 429) {
    return new JobLimitError(
      `transcription job limit reached (HTTP 429)${suffix}`,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  if (status === 503) {
    return new JobPlatformUnavailableError(
      `transcription job platform unavailable (HTTP 503)${suffix}`,
    );
  }
  if (status >= 500) return new ServiceUnavailableError(`${operation} unavailable (HTTP ${status})`);
  return new InvalidRequestError(`${operation} rejected (HTTP ${status})${suffix}`, status, code);
}

async function requestJob(request: JobRequest): Promise<unknown> {
  checkTimeout(request.timeoutMs, "timeoutMs");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: {
          [API_KEY_HEADER]: request.apiKey,
          ...(request.contentType === undefined ? {} : { "Content-Type": request.contentType }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: composeSignals(controller.signal, request.signal),
      });
    } catch (cause) {
      if (request.signal?.aborted) throw request.signal.reason ?? cause;
      if (timedOut) throw new ServiceUnavailableError(`${request.operation} timed out after ${request.timeoutMs} ms`);
      throw new ServiceUnavailableError(`${request.operation} failed`, { cause });
    }
    if (response.status !== request.expectedStatus) {
      throw await mapJobFailure(response, request.apiKey, request.operation);
    }
    if (request.expectedStatus === 204) return undefined;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      if (request.signal?.aborted) throw request.signal.reason ?? cause;
      if (timedOut) throw new ServiceUnavailableError(`${request.operation} timed out after ${request.timeoutMs} ms`);
      throw new ProtocolError(`${request.operation} response is not valid JSON`, { cause });
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export class TranscriptionsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: () => string,
  ) {}

  async submit(request: TranscriptionSubmitRequest): Promise<TranscriptionJobSubmission> {
    const hasAudio = request.audio !== undefined;
    const hasAudioUrl = request.audioUrl !== undefined;
    if (hasAudio === hasAudioUrl) throw new TypeError("submit requires exactly one of audio or audioUrl");
    const timeoutMs = request.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    checkTimeout(timeoutMs, "timeoutMs");
    const apiKey = this.apiKey();
    let body: Uint8Array | string;
    let contentType: string;
    let rawInput: boolean;
    if (hasAudio) {
      const audio = request.audio as Uint8Array | ArrayBuffer;
      const bytes = toUint8Array(audio);
      if (bytes.byteLength === 0) throw new TypeError("audio is empty");
      rawInput = request.raw ?? true;
      body = bytes;
      contentType = rawInput ? TRANSCRIBE_RAW_CONTENT_TYPE : TRANSCRIBE_WAV_CONTENT_TYPE;
    } else {
      const audioUrl = request.audioUrl as string;
      if (audioUrl.length === 0) throw new TypeError("audioUrl must not be empty");
      rawInput = request.raw ?? false;
      body = JSON.stringify({ audio_url: audioUrl });
      contentType = "application/json";
    }
    const query = buildJobQuery(request, rawInput, !hasAudio);
    const payload = await requestJob({
      url: buildTranscriptionsUrl(this.baseUrl, query),
      apiKey,
      method: "POST",
      body,
      contentType,
      expectedStatus: 202,
      timeoutMs,
      signal: request.signal,
      operation: "transcription submission",
    });
    return parseSubmission(payload);
  }

  async get(id: string, options: TranscriptionGetOptions = {}): Promise<TranscriptionJob> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const payload = await requestJob({
      url: jobUrl(this.baseUrl, id),
      apiKey: this.apiKey(),
      method: "GET",
      expectedStatus: 200,
      timeoutMs,
      signal: options.signal,
      operation: "transcription job lookup",
    });
    return parseJob(payload);
  }

  async wait(id: string, options: TranscriptionWaitOptions = {}): Promise<Transcription> {
    checkId(id);
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      throw new RangeError("pollIntervalMs must be a non-negative finite number");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    checkTimeout(timeoutMs, "timeoutMs");
    const apiKey = this.apiKey();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ServiceUnavailableError(`transcription job wait timed out after ${timeoutMs} ms`);
      const job = await this.getWithKey(id, apiKey, Math.min(DEFAULT_JOB_TIMEOUT_MS, remaining), options.signal);
      if (job.status === "completed") {
        if (job.result === undefined) throw new ProtocolError("completed transcription job has no result");
        return job.result;
      }
      if (job.status === "error") {
        if (job.error === undefined) throw new ProtocolError("error transcription job has no error detail");
        throw new TranscriptionJobError(job.error.code, safeText(job.error.message, apiKey));
      }
      const remainingAfter = deadline - Date.now();
      if (remainingAfter <= 0) {
        throw new ServiceUnavailableError(`transcription job wait timed out after ${timeoutMs} ms`);
      }
      if (pollIntervalMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(pollIntervalMs, remainingAfter)),
        );
      }
    }
  }

  async delete(id: string, options: TranscriptionGetOptions = {}): Promise<void> {
    await requestJob({
      url: jobUrl(this.baseUrl, id),
      apiKey: this.apiKey(),
      method: "DELETE",
      expectedStatus: 204,
      timeoutMs: options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
      signal: options.signal,
      operation: "transcription job deletion",
    });
  }

  private async getWithKey(
    id: string,
    apiKey: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<TranscriptionJob> {
    const payload = await requestJob({
      url: jobUrl(this.baseUrl, id),
      apiKey,
      method: "GET",
      expectedStatus: 200,
      timeoutMs,
      signal,
      operation: "transcription job lookup",
    });
    return parseJob(payload);
  }
}
