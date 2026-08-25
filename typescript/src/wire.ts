export const DEFAULT_BASE_URL = "wss://api.labs.bandwidth.com";
export const LISTEN_PATH = "/audio/v1/listen";
export const API_KEY_HEADER = "X-BW-LABS-API-KEY";
export const API_KEY_PARAM = "api_key";
export const API_KEY_ENV_VAR = "BW_STT_API_KEY";

// Wire names for the PII-redaction and keyword parameters and the offline
// transcribe route. The serving contract may still adjust these; reconcile here.
export const PARAM_REDACT_PII = "redact_pii";
export const PARAM_REDACT_PII_POLICIES = "redact_pii_policies";
export const PARAM_REDACT_PII_SUB = "redact_pii_sub";
export const PARAM_KEYWORDS = "keywords";
export const TRANSCRIBE_PATH = "/audio/v1/transcribe";

export const MAX_KEYWORDS = 100;
export const TRANSCRIBE_MAX_AUDIO_MINUTES = 5;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 25_000;
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 120_000;
