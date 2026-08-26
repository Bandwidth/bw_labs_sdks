import type { Encoding, FrameConfig } from "./framing";
import {
  API_KEY_PARAM,
  LISTEN_PATH,
  MAX_KEYWORDS,
  PARAM_KEYWORDS,
  PARAM_REDACT_PII,
  PARAM_REDACT_PII_POLICIES,
  PARAM_REDACT_PII_SUB,
  TRANSCRIBE_PATH,
} from "./wire";

export type AuthCarrier = "auto" | "header" | "query";
export type PiiSubstitution = "entity_name" | "hash";

/** How results are emitted. `instant` streams Segments as text is decoded; `demand` holds results until Finalize or CloseStream. */
export type SttMode = "instant" | "demand" | (string & {});

export interface MediaOptions {
  /** Audio payload interpretation. Default linear16. */
  encoding?: Encoding;
  /** Samples per second: 16000 (default) or 8000. */
  sampleRate?: number;
  /** Interleaved channel count: 1 (default) or 2. */
  channels?: number;
  /** With channels 2: transcribe left/right independently instead of downmixing. */
  multichannel?: boolean;
  /** Pinned model tag; server current model when omitted. */
  model?: string;
}

export interface FeatureOptions {
  /** Redact personally identifiable information in results. */
  redactPii?: boolean;
  /** Redaction policy names; sent comma-joined. */
  redactPiiPolicies?: string[];
  /** Replacement style for redacted spans. */
  redactPiiSub?: PiiSubstitution;
  /** Words or phrases to boost, up to 100. */
  keywords?: string[];
}

export interface ConnectOptions extends MediaOptions, FeatureOptions {
  /** Result timing: "instant" (server default) or "demand". */
  mode?: SttMode;
  /** Send-side quiet period before an automatic KeepAlive. Default 25000; 0 or null disables. */
  keepAliveIntervalMs?: number | null;
  /** Deadline in milliseconds from socket open through SessionOpened. Default 15000. */
  connectTimeoutMs?: number;
}

export interface TranscribeOptions extends MediaOptions, FeatureOptions {
  /** Whole-request deadline in milliseconds, covering connection, headers, and body. Default 120000. */
  timeoutMs?: number;
  /** Caller-side cancellation; composed with the internal timeout. */
  signal?: AbortSignal;
}

const ENCODINGS: readonly Encoding[] = ["linear16", "mulaw", "alaw", "g722", "opus"];

export interface ResolvedMedia extends FrameConfig {
  readonly multichannel: boolean;
  readonly model?: string;
}

export function resolveMediaOptions(options: MediaOptions): ResolvedMedia {
  const encoding = options.encoding ?? "linear16";
  const sampleRate = options.sampleRate ?? 16000;
  const channels = options.channels ?? 1;
  const multichannel = options.multichannel ?? false;
  if (!ENCODINGS.includes(encoding)) {
    throw new TypeError(`encoding must be one of ${ENCODINGS.join(", ")}`);
  }
  if (sampleRate !== 16000 && sampleRate !== 8000) {
    throw new RangeError("sampleRate must be 16000 or 8000");
  }
  if (channels !== 1 && channels !== 2) {
    throw new RangeError("channels must be 1 or 2");
  }
  if (multichannel && channels !== 2) {
    throw new RangeError("multichannel requires channels: 2");
  }
  if ((encoding === "g722" || encoding === "opus") && (sampleRate !== 16000 || channels !== 1)) {
    throw new RangeError(`${encoding} requires sampleRate 16000 and channels 1`);
  }
  const resolved: { encoding: Encoding; sampleRate: number; channels: number; multichannel: boolean; model?: string } =
    { encoding, sampleRate, channels, multichannel };
  if (options.model !== undefined) resolved.model = options.model;
  return resolved;
}

export function validateKeywords(keywords: readonly string[]): void {
  if (keywords.length > MAX_KEYWORDS) {
    throw new RangeError(`keywords accepts at most ${MAX_KEYWORDS} entries`);
  }
  for (const keyword of keywords) {
    if (typeof keyword !== "string" || keyword.trim().length === 0) {
      throw new TypeError("each keyword must contain non-whitespace text");
    }
  }
}

function appendMediaParams(params: URLSearchParams, media: ResolvedMedia): void {
  params.set("encoding", media.encoding);
  params.set("sample_rate", String(media.sampleRate));
  params.set("channels", String(media.channels));
  if (media.multichannel) params.set("multichannel", "true");
  if (media.model !== undefined) params.set("model", media.model);
}

function appendFeatureParams(params: URLSearchParams, features: FeatureOptions): void {
  if (features.redactPii) params.set(PARAM_REDACT_PII, "true");
  if (features.redactPiiPolicies !== undefined && features.redactPiiPolicies.length > 0) {
    params.set(PARAM_REDACT_PII_POLICIES, features.redactPiiPolicies.join(","));
  }
  if (features.redactPiiSub !== undefined) params.set(PARAM_REDACT_PII_SUB, features.redactPiiSub);
  if (features.keywords !== undefined) {
    validateKeywords(features.keywords);
    for (const keyword of features.keywords) params.append(PARAM_KEYWORDS, keyword);
  }
}

function parseBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new TypeError(`invalid baseUrl: ${baseUrl}`, { cause });
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
    throw new TypeError("baseUrl must use ws, wss, http, or https");
  }
  return url;
}

function isDefaultPath(url: URL): boolean {
  return url.pathname === "" || url.pathname === "/";
}

/** WebSocket endpoint for streaming sessions. baseUrl without a path gets the standard listen path appended. */
export function buildListenUrl(baseUrl: string, options: ConnectOptions, apiKey?: string): string {
  const url = parseBaseUrl(baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
  if (isDefaultPath(url)) url.pathname = LISTEN_PATH;
  const params = url.searchParams;
  appendMediaParams(params, resolveMediaOptions(options));
  if (options.mode !== undefined) params.set("mode", options.mode);
  appendFeatureParams(params, options);
  if (apiKey !== undefined) params.set(API_KEY_PARAM, apiKey);
  return url.toString();
}

/** HTTP endpoint for offline transcription, derived from the same baseUrl. */
export function buildTranscribeUrl(baseUrl: string, options: TranscribeOptions): string {
  const url = parseBaseUrl(baseUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  if (isDefaultPath(url)) url.pathname = TRANSCRIBE_PATH;
  else if (url.pathname.endsWith("/listen")) {
    url.pathname = url.pathname.slice(0, -"/listen".length) + "/transcribe";
  } else {
    url.pathname = url.pathname.replace(/\/$/, "") + "/transcribe";
  }
  const params = url.searchParams;
  appendMediaParams(params, resolveMediaOptions(options));
  appendFeatureParams(params, options);
  return url.toString();
}

export function resolveAuthCarrier(carrier: AuthCarrier, runningInNode: boolean): "header" | "query" {
  if (carrier === "auto") return runningInNode ? "header" : "query";
  return carrier;
}
