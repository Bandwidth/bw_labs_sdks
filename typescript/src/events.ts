import { ProtocolError } from "./errors";

/** A single recognized word with timestamps in seconds. */
export interface Word {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/**
 * First event after a successful connection.
 * Wire mapping: `request_id` -> requestId, `model_info` -> modelInfo,
 * `sample_rate` -> sampleRate.
 */
export interface SessionOpened {
  readonly type: "SessionOpened";
  readonly requestId: string;
  readonly modelInfo: { readonly name: string; readonly version: string };
  readonly channels: number;
  readonly sampleRate: number;
  readonly encoding: string;
  /** The event exactly as received from the server. */
  readonly raw: Record<string, unknown>;
}

/**
 * A final transcript delta. Segments are append-only and never revised;
 * concatenating `text` in arrival order reconstructs the transcript verbatim.
 * `start`/`end` are seconds of audio time. All field names match the wire.
 */
export interface Segment {
  readonly type: "Segment";
  readonly channel: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly words: readonly Word[];
  /** The event exactly as received from the server. */
  readonly raw: Record<string, unknown>;
}

/** Redaction summary attached to a demand-mode Transcript. */
export interface RedactionSummary {
  readonly applied: boolean;
  readonly policies: readonly string[];
  readonly entitiesRedacted: number;
}

/** A complete demand-mode transcript for one channel. */
export interface Transcript {
  readonly type: "Transcript";
  readonly channel: number;
  readonly text: string;
  readonly words: readonly Word[];
  readonly redaction: RedactionSummary;
  /** The event exactly as received from the server. */
  readonly raw: Record<string, unknown>;
}

/** In-band error codes the server may send. */
export type SttErrorCode =
  | "invalid_params"
  | "invalid_message"
  | "invalid_frame"
  | "idle_timeout"
  | "identity_revalidation_failed"
  | "upstream_unavailable"
  | "transcript_too_large"
  | "internal_error"
  | (string & {});

/** An in-band error event. Field names match the wire. */
export interface ErrorEvent {
  readonly type: "Error";
  readonly code: SttErrorCode;
  readonly message: string;
  /** The event exactly as received from the server. */
  readonly raw: Record<string, unknown>;
}

/**
 * Terminal event of a graceful close. Wire mapping: `request_id` -> requestId,
 * `audio_duration_seconds` -> audioDurationSeconds (the server usage echo),
 * `session_duration_seconds` -> sessionDurationSeconds.
 */
export interface SessionClosed {
  readonly type: "SessionClosed";
  readonly requestId: string;
  readonly audioDurationSeconds: number;
  readonly sessionDurationSeconds: number;
  readonly deliveryFailed: boolean;
  /** The event exactly as received from the server. */
  readonly raw: Record<string, unknown>;
}

/**
 * An event type this SDK version does not recognize. The protocol adds new
 * event types over time; unknown types are surfaced, never treated as errors.
 * `eventType` carries the wire `type` value.
 */
export interface UnknownEvent {
  readonly type: "Unknown";
  readonly eventType: string;
  /** The event exactly as received from the server. */
  readonly raw: Record<string, unknown>;
}

export type SttEvent = SessionOpened | Segment | Transcript | ErrorEvent | SessionClosed | UnknownEvent;

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${context} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string") throw new ProtocolError(`${context} is not a string`);
  return value;
}

function asNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`${context} is not a finite number`);
  }
  return value;
}

function asInteger(value: unknown, context: string): number {
  const number = asNumber(value, context);
  if (!Number.isInteger(number)) throw new ProtocolError(`${context} is not an integer`);
  return number;
}

function parseRedaction(raw: Record<string, unknown>): RedactionSummary {
  const redaction = asObject(raw.redaction, "Transcript.redaction");
  if (typeof redaction.applied !== "boolean") {
    throw new ProtocolError("Transcript.redaction.applied is not a boolean");
  }
  if (!Array.isArray(redaction.policies)) {
    throw new ProtocolError("Transcript.redaction.policies is not an array");
  }
  const policies = redaction.policies.map((policy, index) =>
    asString(policy, `Transcript.redaction.policies[${index}]`),
  );
  return {
    applied: redaction.applied,
    policies,
    entitiesRedacted: asInteger(redaction.entities_redacted, "Transcript.redaction.entities_redacted"),
  };
}

/** Parse one server text message into a typed event. Throws ProtocolError. */
export function parseEvent(text: string): SttEvent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new ProtocolError("server message is not valid JSON", { cause });
  }
  const raw = asObject(value, "server message");
  const type = asString(raw.type, "server message type");
  switch (type) {
    case "SessionOpened": {
      const model = asObject(raw.model_info, "model_info");
      return {
        type,
        requestId: asString(raw.request_id, "request_id"),
        modelInfo: {
          name: asString(model.name, "model_info.name"),
          version: asString(model.version, "model_info.version"),
        },
        channels: asNumber(raw.channels, "channels"),
        sampleRate: asNumber(raw.sample_rate, "sample_rate"),
        encoding: asString(raw.encoding, "encoding"),
        raw,
      };
    }
    case "Segment": {
      const words = raw.words;
      if (!Array.isArray(words)) throw new ProtocolError("Segment.words is not an array");
      return {
        type,
        channel: asNumber(raw.channel, "channel"),
        start: asNumber(raw.start, "start"),
        end: asNumber(raw.end, "end"),
        text: asString(raw.text, "text"),
        words: words.map((entry, index) => {
          const word = asObject(entry, `words[${index}]`);
          return {
            word: asString(word.word, `words[${index}].word`),
            start: asNumber(word.start, `words[${index}].start`),
            end: asNumber(word.end, `words[${index}].end`),
          };
        }),
        raw,
      };
    }
    case "Transcript": {
      const words = raw.words;
      if (!Array.isArray(words)) throw new ProtocolError("Transcript.words is not an array");
      return {
        type,
        channel: asInteger(raw.channel, "channel"),
        text: asString(raw.text, "text"),
        words: words.map((entry, index) => {
          const word = asObject(entry, `words[${index}]`);
          return {
            word: asString(word.word, `words[${index}].word`),
            start: asNumber(word.start, `words[${index}].start`),
            end: asNumber(word.end, `words[${index}].end`),
          };
        }),
        redaction: parseRedaction(raw),
        raw,
      };
    }
    case "Error":
      return {
        type,
        code: asString(raw.code, "code"),
        message: asString(raw.message, "message"),
        raw,
      };
    case "SessionClosed":
      if (raw.delivery_failed !== undefined && typeof raw.delivery_failed !== "boolean") {
        throw new ProtocolError("delivery_failed is not a boolean");
      }
      return {
        type,
        requestId: asString(raw.request_id, "request_id"),
        audioDurationSeconds: asNumber(raw.audio_duration_seconds, "audio_duration_seconds"),
        sessionDurationSeconds: asNumber(raw.session_duration_seconds, "session_duration_seconds"),
        deliveryFailed: raw.delivery_failed ?? false,
        raw,
      };
    default:
      return { type: "Unknown", eventType: type, raw };
  }
}
