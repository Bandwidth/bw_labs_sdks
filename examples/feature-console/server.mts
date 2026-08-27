import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthenticationError,
  BwSttClient,
  InvalidRequestError,
  ProtocolError,
  RateLimitError,
  ServiceUnavailableError,
  type ConnectOptions,
  type PiiSubstitution,
  type SttEvent,
  type SttSession,
  type Transcript,
  type TranscribeOptions,
} from "@bandwidth/bw-stt";
import { WebSocketServer, WebSocket, type RawData } from "ws";

const HOST = "127.0.0.1";
const PORT = 8099;
const DEFAULT_BASE_URL = "https://api.labs.bandwidth.com";
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const directory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(directory, "public");

const staticFiles: Readonly<Record<string, { file: string; contentType: string }>> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/audio-worklet.js": { file: "audio-worklet.js", contentType: "text/javascript; charset=utf-8" },
};

class ConsoleHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ConsoleHttpError";
    this.status = status;
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (requestUrl.pathname === "/api/transcribe") {
    await handleTranscribe(request, response, requestUrl);
    return;
  }

  const staticFile = staticFiles[requestUrl.pathname];
  if (request.method === "GET" && staticFile !== undefined) {
    const body = await readFile(join(publicDirectory, staticFile.file));
    response.writeHead(200, {
      "content-type": staticFile.contentType,
      "content-length": body.byteLength,
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }

  sendJson(response, request.method === "GET" ? 404 : 405, {
    error: request.method === "GET" ? "not_found" : "method_not_allowed",
    message: request.method === "GET" ? "resource not found" : "use GET for the console or POST for transcription",
  });
}

async function handleTranscribe(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed", message: "POST is required" });
    return;
  }

  const apiKey = headerValue(request, "x-console-key");
  if (apiKey === undefined || apiKey.trim() === "") {
    sendJson(response, 401, { error: "authentication_error", message: "x-console-key header is required" });
    return;
  }

  try {
    const body = await readRequestBody(request);
    const parsed = prepareTranscribeRequest(body, requestUrl.searchParams);
    const client = new BwSttClient({ apiKey, baseUrl: parsed.baseUrl });
    const result = await client.transcribe(parsed.audio, parsed.options);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, statusForError(error), {
      error: errorCode(error),
      message: errorMessage(error, apiKey),
    });
  }
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;

    request.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += bytes.byteLength;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new ConsoleHttpError(413, "audio request is too large"));
        request.resume();
        return;
      }
      chunks.push(bytes);
    });
    request.on("end", () => {
      if (rejected) return;
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    request.on("aborted", () => {
      if (!rejected) {
        rejected = true;
        reject(new ConsoleHttpError(400, "audio request was aborted"));
      }
    });
    request.on("error", (error) => {
      if (!rejected) {
        rejected = true;
        reject(new ConsoleHttpError(400, error instanceof Error ? error.message : "could not read audio request"));
      }
    });
  });
}

interface FeatureValues {
  readonly keywords?: string[];
  readonly redactPii?: boolean;
  readonly redactPiiPolicies?: string[];
  readonly redactPiiSub?: PiiSubstitution;
  readonly redactPiiReturn?: boolean;
}

function parseFeatureQuery(params: URLSearchParams): FeatureValues {
  const keywords = splitList(params.get("keywords"));
  const policies = splitList(params.get("redact_pii_policies"));
  const redactPii = parseBoolean(params.get("redact_pii"), "redact_pii");
  const redactPiiReturn = parseBoolean(params.get("redact_pii_return"), "redact_pii_return");
  const substitutionValue = params.get("redact_pii_sub");
  const redactPiiSub = parseSubstitution(substitutionValue);
  return {
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(redactPii !== undefined ? { redactPii } : {}),
    ...(policies.length > 0 ? { redactPiiPolicies: policies } : {}),
    ...(redactPiiSub !== undefined ? { redactPiiSub } : {}),
    ...(redactPiiReturn !== undefined ? { redactPiiReturn } : {}),
  };
}

function splitList(value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseBoolean(value: string | null, name: string): boolean | undefined {
  if (value === null || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ConsoleHttpError(400, `${name} must be true or false`);
}

function parseNumber(value: string | null, name: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConsoleHttpError(400, `${name} must be a positive integer`);
  }
  return parsed;
}

function parseSubstitution(value: string | null): PiiSubstitution | undefined {
  if (value === null || value === "") return undefined;
  if (value === "entity_name" || value === "hash") return value;
  throw new ConsoleHttpError(400, "redact_pii_sub must be entity_name or hash");
}

interface TranscribeRequestData {
  readonly baseUrl: string;
  readonly audio: Uint8Array;
  readonly options: TranscribeOptions;
}

function prepareTranscribeRequest(body: Uint8Array, params: URLSearchParams): TranscribeRequestData {
  const baseUrl = params.get("base_url")?.trim() || DEFAULT_BASE_URL;
  const raw = parseBoolean(params.get("raw"), "raw") ?? false;
  const requestedSampleRate = parseNumber(params.get("sample_rate"), "sample_rate");
  const requestedChannels = parseNumber(params.get("channels"), "channels");
  let audio = body;
  let sampleRate = requestedSampleRate ?? 16000;
  let channels = requestedChannels ?? 1;

  if (!raw) {
    const wav = parsePcmWav(body);
    if (requestedSampleRate !== undefined && requestedSampleRate !== wav.sampleRate) {
      throw new ConsoleHttpError(400, `sample_rate ${requestedSampleRate} does not match the WAV header ${wav.sampleRate}`);
    }
    if (requestedChannels !== undefined && requestedChannels !== wav.channels) {
      throw new ConsoleHttpError(400, `channels ${requestedChannels} does not match the WAV header ${wav.channels}`);
    }
    audio = wav.data;
    sampleRate = wav.sampleRate;
    channels = wav.channels;
  }

  const features = parseFeatureQuery(params);
  const options: TranscribeOptions = {
    encoding: "linear16",
    sampleRate,
    channels,
    ...features,
  };
  return { baseUrl, audio, options };
}

interface ParsedWav {
  readonly sampleRate: number;
  readonly channels: number;
  readonly data: Uint8Array;
}

function parsePcmWav(bytes: Uint8Array): ParsedWav {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new ConsoleHttpError(400, "audio body must be a RIFF/WAVE file when raw is false");
  }

  let format: { tag: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(bytes, offset, 4);
    const size = readUint32(bytes, offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bytes.byteLength) throw new ConsoleHttpError(400, "WAV chunk extends past the end of the file");
    if (chunkId === "fmt ") {
      if (size < 16) throw new ConsoleHttpError(400, "WAV fmt chunk is too short");
      const body = bytes.slice(bodyStart, bodyEnd);
      const tag = readUint16(body, 0);
      const resolvedTag = tag === 0xfffe ? extensiblePcmTag(body) : tag;
      format = {
        tag: resolvedTag,
        channels: readUint16(body, 2),
        sampleRate: readUint32(body, 4),
        bits: readUint16(body, 14),
      };
    } else if (chunkId === "data" && data === undefined) {
      data = bytes.slice(bodyStart, bodyEnd);
    }
    offset = bodyEnd + (size % 2);
  }

  if (format === undefined) throw new ConsoleHttpError(400, "WAV file has no fmt chunk");
  if (data === undefined) throw new ConsoleHttpError(400, "WAV file has no data chunk");
  if (format.tag !== 1 || format.bits !== 16) {
    throw new ConsoleHttpError(400, "only 16-bit PCM WAV files are supported");
  }
  if (format.channels !== 1 && format.channels !== 2) {
    throw new ConsoleHttpError(400, "WAV channels must be 1 or 2");
  }
  return { sampleRate: format.sampleRate, channels: format.channels, data };
}

function extensiblePcmTag(body: Uint8Array): number {
  const tail = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
  if (body.byteLength < 40) return 0;
  for (let index = 0; index < tail.length; index++) {
    if (body[28 + index] !== tail[index]) return 0;
  }
  return readUint16(body, 24);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) +
    bytes[offset + 3]! * 0x1000000
  );
}

function statusForError(error: unknown): number {
  if (error instanceof ConsoleHttpError) return error.status;
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof InvalidRequestError) return error.status ?? 400;
  if (error instanceof RateLimitError) return 429;
  if (error instanceof ServiceUnavailableError) return 503;
  if (error instanceof ProtocolError) return 502;
  return 500;
}

function errorCode(error: unknown): string {
  if (error instanceof ConsoleHttpError || error instanceof InvalidRequestError) return "invalid_request";
  if (error instanceof AuthenticationError) return "authentication_error";
  if (error instanceof RateLimitError) return "rate_limited";
  if (error instanceof ServiceUnavailableError) return "service_unavailable";
  if (error instanceof ProtocolError) return "protocol_error";
  return "internal_error";
}

function errorMessage(error: unknown, apiKey?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (message.trim() === "") message = "request failed";
  if (apiKey !== undefined && apiKey !== "") message = message.split(apiKey).join("[redacted]");
  return message;
}

interface StartRequest {
  readonly key: string;
  readonly baseUrl: string;
  readonly mode: "instant" | "demand";
  readonly options: ConnectOptions;
}

function parseStartRequest(value: unknown): StartRequest {
  const message = objectValue(value, "start message");
  if (message.op !== "start") throw new Error("the first bridge message must be op=start");
  const key = stringValue(message.key, "key").trim();
  if (key === "") throw new Error("key is required");
  const baseUrl = stringValue(message.baseUrl ?? DEFAULT_BASE_URL, "baseUrl").trim();
  const modeValue = stringValue(message.mode ?? "instant", "mode");
  if (modeValue !== "instant" && modeValue !== "demand") throw new Error("mode must be instant or demand");
  const features = parseFeatureObject(message.options);
  return {
    key,
    baseUrl,
    mode: modeValue,
    options: {
      encoding: "linear16",
      sampleRate: 16000,
      channels: 1,
      mode: modeValue,
      ...features,
    },
  };
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") throw new Error(`${context} must be a string`);
  return value;
}

function booleanValue(value: unknown, context: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

function stringArrayValue(value: unknown, context: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${context} must be an array of strings`);
  }
  return value as string[];
}

function parseFeatureObject(value: unknown): FeatureValues {
  if (value === undefined) return {};
  const options = objectValue(value, "options");
  const keywords = stringArrayValue(options.keywords, "options.keywords");
  const redactPii = booleanValue(options.redactPii, "options.redactPii");
  const redactPiiPolicies = stringArrayValue(options.redactPiiPolicies, "options.redactPiiPolicies");
  const redactPiiReturn = booleanValue(options.redactPiiReturn, "options.redactPiiReturn");
  const redactPiiSubValue = options.redactPiiSub;
  let redactPiiSub: PiiSubstitution | undefined;
  if (redactPiiSubValue !== undefined) {
    if (redactPiiSubValue !== "entity_name" && redactPiiSubValue !== "hash") {
      throw new Error("options.redactPiiSub must be entity_name or hash");
    }
    redactPiiSub = redactPiiSubValue;
  }
  return {
    ...(keywords === undefined ? {} : { keywords }),
    ...(redactPii === undefined ? {} : { redactPii }),
    ...(redactPiiPolicies === undefined ? {} : { redactPiiPolicies }),
    ...(redactPiiSub !== undefined ? { redactPiiSub } : {}),
    ...(redactPiiReturn === undefined ? {} : { redactPiiReturn }),
  };
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function rawDataToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
}

function sendBridge(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // The browser may have closed between the ready-state check and send.
  }
}

function sendBridgeError(socket: WebSocket, error: unknown, apiKey?: string): void {
  sendBridge(socket, { op: "error", message: errorMessage(error, apiKey) });
}

async function monitorSession(socket: WebSocket, session: SttSession, apiKey: string): Promise<void> {
  try {
    for await (const _event of session.events()) {
      // The event listener is the relay. This iterator observes transport failures.
    }
  } catch (error) {
    sendBridgeError(socket, error, apiKey);
  }
}

function handleBridgeConnection(socket: WebSocket): void {
  let started = false;
  let bridgeClosed = false;
  let apiKey: string | undefined;
  let session: SttSession | undefined;
  let operation = Promise.resolve();

  socket.on("message", (data: RawData, isBinary: boolean) => {
    operation = operation
      .then(async () => {
        if (!started) {
          if (isBinary) throw new Error("send op=start before sending audio");
          const start = parseStartRequest(JSON.parse(rawDataToText(data)) as unknown);
          started = true;
          apiKey = start.key;
          const client = new BwSttClient({ apiKey: start.key, baseUrl: start.baseUrl });
          try {
            const connected = await client.connect(start.options);
            session = connected;
            if (bridgeClosed) {
              connected.disconnect();
              return;
            }
            connected.on("event", (event: SttEvent) => sendBridge(socket, { op: "event", event }));
            connected.on("error", (event) => {
              sendBridgeError(socket, `${event.code}: ${event.message}`, apiKey);
            });
            sendBridge(socket, { op: "event", event: connected.opened });
            void monitorSession(socket, connected, start.key);
          } catch (error) {
            sendBridgeError(socket, error, apiKey);
          }
          return;
        }

        if (isBinary) {
          if (session === undefined) throw new Error("streaming session is not connected");
          session.sendAudio(rawDataToBytes(data));
          return;
        }

        const message = objectValue(JSON.parse(rawDataToText(data)) as unknown, "bridge message");
        const op = stringValue(message.op, "op");
        if (op === "finalize") {
          if (session === undefined) throw new Error("streaming session is not connected");
          const transcripts = await session.finalizeTranscript();
          sendBridge(socket, { op: "transcripts", transcripts });
          return;
        }
        if (op === "close") {
          if (session === undefined) throw new Error("streaming session is not connected");
          const remainder: Transcript[] = [];
          const collectRemainder = (transcript: Transcript): void => {
            remainder.push(transcript);
          };
          session.on("transcript", collectRemainder);
          try {
            const closed = await session.closeStream();
            sendBridge(socket, { op: "closed", transcripts: remainder, closed });
          } finally {
            session.off("transcript", collectRemainder);
          }
          return;
        }
        throw new Error(`unsupported bridge operation: ${op}`);
      })
      .catch((error) => sendBridgeError(socket, error, apiKey));
  });

  socket.on("close", () => {
    bridgeClosed = true;
    session?.disconnect();
  });
  socket.on("error", (error) => {
    sendBridgeError(socket, error, apiKey);
    session?.disconnect();
  });
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (response.headersSent) {
      response.end();
      return;
    }
    sendJson(response, 500, { error: "internal_error", message: errorMessage(error) });
  });
});

const webSocketServer = new WebSocketServer({ server, path: "/bridge" });
webSocketServer.on("connection", handleBridgeConnection);

server.on("error", (error) => {
  console.error(`feature console server error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`STT feature console listening on http://${HOST}:${PORT}`);
});
