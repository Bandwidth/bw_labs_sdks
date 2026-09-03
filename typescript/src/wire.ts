export const DEFAULT_BASE_URL = "wss://api.labs.bandwidth.com";
export const LISTEN_PATH = "/audio/v1/listen";
export const API_KEY_HEADER = "X-BW-LABS-API-KEY";
export const API_KEY_PARAM = "api_key";
export const API_KEY_ENV_VAR = "BW_STT_API_KEY";

// Wire names and offline media rules confirmed against the transcription service
// contract. Keep SDK-to-wire mapping in this module.
export const PARAM_REDACT_PII = "redact_pii";
export const PARAM_REDACT_PII_SUB = "redact_pii_sub";
export const PARAM_REDACT_PII_RETURN = "redact_pii_return";
export const PARAM_KEYWORDS = "keywords";
export const TRANSCRIBE_PATH = "/audio/v1/transcribe";
export const TRANSCRIPTIONS_PATH = "/audio/v1/transcriptions";
export const CALLBACK_URL_PARAM = "callback_url";
export const CALLBACK_AUTH_HEADER_NAME = "X-Callback-Auth-Name";
export const CALLBACK_AUTH_HEADER_VALUE = "X-Callback-Auth-Value";
export const TRANSCRIBE_WAV_CONTENT_TYPE = "audio/wav";
export const TRANSCRIBE_RAW_CONTENT_TYPE = "application/octet-stream";
export const TRANSCRIBE_RAW_ENCODING = "linear16";
export const TRANSCRIBE_MAX_AUDIO_DESCRIPTION = "five minutes";

export const MAX_KEYWORDS = 100;
export const MAX_KEYWORD_BYTES = 4096;
export const TRANSCRIBE_MAX_AUDIO_MINUTES = 5;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 25_000;
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 120_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export interface WireMediaOptions {
  readonly encoding: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly multichannel?: boolean;
  readonly model?: string;
}

export interface WireFeatureOptions {
  readonly redactPii?: boolean;
  readonly redactPiiSub?: string;
  readonly redactPiiReturn?: boolean;
  readonly keywords?: readonly string[];
}

export function validateKeywords(keywords: readonly string[]): void {
  if (keywords.length > MAX_KEYWORDS) {
    throw new RangeError(`keywords accepts at most ${MAX_KEYWORDS} entries`);
  }
  const encoder = new TextEncoder();
  let keywordBytes = 0;
  for (const keyword of keywords) {
    if (typeof keyword !== "string" || keyword.trim().length === 0) {
      throw new TypeError("each keyword must contain non-whitespace text");
    }
    keywordBytes += encoder.encode(keyword).byteLength;
  }
  if (keywordBytes > MAX_KEYWORD_BYTES) {
    throw new RangeError(`keywords must fit within ${MAX_KEYWORD_BYTES} UTF-8 bytes combined`);
  }
}

function appendFeatureQuery(params: URLSearchParams, features: WireFeatureOptions): void {
  if (features.redactPiiReturn && !features.redactPii) {
    throw new TypeError("redactPiiReturn requires redactPii: true");
  }
  if (features.redactPiiReturn && features.redactPiiSub === "entity_name") {
    throw new TypeError("redactPiiReturn cannot be combined with redactPiiSub: entity_name");
  }
  if (features.redactPii) params.set(PARAM_REDACT_PII, "true");
  if (features.redactPiiSub !== undefined) params.set(PARAM_REDACT_PII_SUB, features.redactPiiSub);
  if (features.redactPiiReturn) params.set(PARAM_REDACT_PII_RETURN, "true");
  if (features.keywords !== undefined) {
    validateKeywords(features.keywords);
    for (const keyword of features.keywords) params.append(PARAM_KEYWORDS, keyword);
  }
}

export function appendListenQuery(
  params: URLSearchParams,
  media: WireMediaOptions,
  features: WireFeatureOptions,
  mode: string | undefined,
  apiKey: string | undefined,
): void {
  params.set("encoding", media.encoding);
  params.set("sample_rate", String(media.sampleRate));
  params.set("channels", String(media.channels));
  if (media.multichannel) params.set("multichannel", "true");
  if (media.model !== undefined) params.set("model", media.model);
  if (mode !== undefined) params.set("mode", mode);
  appendFeatureQuery(params, features);
  if (apiKey !== undefined) params.set(API_KEY_PARAM, apiKey);
}

export function appendTranscribeQuery(
  params: URLSearchParams,
  media: WireMediaOptions,
  features: WireFeatureOptions,
  rawInput: boolean,
): void {
  if (rawInput) {
    if (media.encoding !== TRANSCRIBE_RAW_ENCODING) {
      throw new TypeError("raw transcribe uploads require encoding: linear16");
    }
    params.set("encoding", media.encoding);
    params.set("sample_rate", String(media.sampleRate));
  }
  params.set("channels", String(media.channels));
  if (media.multichannel) params.set("multichannel", "true");
  if (media.model !== undefined) params.set("model", media.model);
  appendFeatureQuery(params, features);
}
