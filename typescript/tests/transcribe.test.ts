import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BwSttClient } from "../src/client";
import {
  AuthenticationError,
  InvalidRequestError,
  ProtocolError,
  RateLimitError,
  ServiceUnavailableError,
} from "../src/errors";
import { buildWav, pcmBytes } from "./helpers/audio";

const KEY = "bwa_key_test";

interface CapturedRequest {
  method: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  hang?: boolean;
  /** Send headers and a partial body, then stall without ending the response. */
  stallBody?: boolean;
}

const OK_BODY = JSON.stringify({
  request_id: "req-t1",
  text: "i need a dry van",
  words: [
    { word: "i", start: 0.0, end: 0.12 },
    { word: "need", start: 0.16, end: 0.2 },
  ],
  segments: [{ start: 0.0, end: 0.5, text: "i need a dry van" }],
  audio_duration_seconds: 0.5,
  model_info: { name: "bw-streaming-en", version: "current" },
  pii_entities: [{ type: "ssn", start: 0.1, end: 0.2 }],
});

class MockTranscribeServer {
  requests: CapturedRequest[] = [];
  response: MockResponse = {};
  readonly url: string;
  private readonly server: Server;

  private constructor(server: Server, port: number) {
    this.server = server;
    // ws scheme: the client derives http from it for the transcribe route.
    this.url = `ws://127.0.0.1:${port}`;
  }

  static start(): Promise<MockTranscribeServer> {
    return new Promise((resolve) => {
      let instance: MockTranscribeServer;
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          instance.requests.push({
            method: request.method ?? "",
            url: new URL(request.url ?? "/", "http://localhost"),
            headers: request.headers,
            body: Buffer.concat(chunks),
          });
          const mock = instance.response;
          if (mock.hang) return;
          response.writeHead(mock.status ?? 200, {
            "content-type": "application/json",
            ...mock.headers,
          });
          if (mock.stallBody) {
            response.write((mock.body ?? OK_BODY).slice(0, 8));
            return;
          }
          response.end(mock.body ?? OK_BODY);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no port");
        instance = new MockTranscribeServer(server, address.port);
        resolve(instance);
      });
    });
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

let server: MockTranscribeServer;
let directory: string;

beforeAll(async () => {
  server = await MockTranscribeServer.start();
  directory = await mkdtemp(join(tmpdir(), "bw-stt-transcribe-"));
});

afterAll(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

afterEach(() => {
  server.requests = [];
  server.response = {};
});

function client(): BwSttClient {
  return new BwSttClient({ apiKey: KEY, baseUrl: server.url });
}

describe("transcribe", () => {
  it("posts the bytes with auth header, content type, and query parameters", async () => {
    const audio = pcmBytes(3200);
    const result = await client().transcribe(audio, {
      sampleRate: 8000,
      channels: 2,
      model: "pinned",
      redactPii: true,
      redactPiiSub: "entity_name",
      keywords: ["dry van", "reefer"],
    });
    const request = server.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url.pathname).toBe("/audio/v1/transcribe");
    expect(request.headers["x-bw-labs-api-key"]).toBe(KEY);
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(new Uint8Array(request.body)).toEqual(audio);
    const params = request.url.searchParams;
    expect(params.get("encoding")).toBe("linear16");
    expect(params.get("sample_rate")).toBe("8000");
    expect(params.get("channels")).toBe("2");
    expect(params.get("multichannel")).toBeNull();
    expect(params.get("model")).toBe("pinned");
    expect(params.get("redact_pii")).toBe("true");
    expect(params.get("redact_pii_sub")).toBe("entity_name");
    expect(params.getAll("keywords")).toEqual(["dry van", "reefer"]);
    expect(result.requestId).toBe("req-t1");
    expect(result.text).toBe("i need a dry van");
    expect(result.words).toHaveLength(2);
    expect(result.segments).toEqual([{ start: 0.0, end: 0.5, text: "i need a dry van" }]);
    expect(result.audioDurationSeconds).toBe(0.5);
    expect(result.modelInfo).toEqual({ name: "bw-streaming-en", version: "current" });
    expect(result.redactedEntities).toBeUndefined();
    expect(result.raw.pii_entities).toEqual([{ type: "ssn", start: 0.1, end: 0.2 }]);
  });

  it("sends redacted entity return and parses returned entities", async () => {
    server.response.body = JSON.stringify({
      request_id: "req-t1",
      text: "card hash:v1:9f2c41d08ab37e15",
      words: [],
      segments: [],
      audio_duration_seconds: 0.5,
      redacted_entities: [
        {
          token: "hash:v1:9f2c41d08ab37e15",
          kind: "credit_card",
          text: "4111 1111 1111 1111",
          start: 0.5,
          end: 1.2,
        },
        { token: "hash:v1:abc", kind: "ssn", text: "123-45-6789", start: null, end: null },
      ],
    });
    const result = await client().transcribe(pcmBytes(3200), {
      redactPii: true,
      redactPiiReturn: true,
    });
    const params = server.requests[0]!.url.searchParams;
    expect(params.get("redact_pii")).toBe("true");
    expect(params.get("redact_pii_return")).toBe("true");
    expect(params.get("redact_pii_sub")).toBeNull();
    expect(result.redactedEntities).toEqual([
      {
        token: "hash:v1:9f2c41d08ab37e15",
        kind: "credit_card",
        text: "4111 1111 1111 1111",
        start: 0.5,
        end: 1.2,
      },
      { token: "hash:v1:abc", kind: "ssn", text: "123-45-6789", start: null, end: null },
    ]);
  });

  it("preserves an empty redacted entity array in a transcribe result", async () => {
    server.response.body = JSON.stringify({
      request_id: "req-t1",
      text: "hello",
      words: [],
      segments: [],
      audio_duration_seconds: 0.5,
      redacted_entities: [],
    });
    const result = await client().transcribe(pcmBytes(3200));
    expect(result.redactedEntities).toEqual([]);
  });

  it("rejects invalid keyword lists before sending", async () => {
    await expect(client().transcribe(pcmBytes(2), { keywords: [""] })).rejects.toThrow(TypeError);
    await expect(client().transcribe(pcmBytes(2), { keywords: ["  \t"] })).rejects.toThrow(TypeError);
    const many = Array.from({ length: 101 }, (_, index) => `kw${index}`);
    await expect(client().transcribe(pcmBytes(2), { keywords: many })).rejects.toThrow(RangeError);
    expect(server.requests).toHaveLength(0);
  });
});

describe("transcribeFile", () => {
  it("extracts rate and channels from the WAV header and uploads the WAV container", async () => {
    const payload = pcmBytes(1600);
    const wav = buildWav({ sampleRate: 8000, channels: 2, samplesPerChannel: 400 });
    wav.set(payload, wav.byteLength - payload.byteLength);
    const path = join(directory, "call.wav");
    await writeFile(path, wav);
    await client().transcribeFile(path);
    const request = server.requests[0]!;
    expect(request.headers["content-type"]).toBe("audio/wav");
    expect(request.url.searchParams.get("encoding")).toBeNull();
    expect(request.url.searchParams.get("sample_rate")).toBeNull();
    expect(request.url.searchParams.get("channels")).toBe("2");
    expect(new Uint8Array(request.body)).toEqual(wav);
    expect(new Uint8Array(request.body.slice(-payload.byteLength))).toEqual(payload);
  });

  it("sends raw files untouched with the caller's options", async () => {
    const bytes = pcmBytes(1234);
    const path = join(directory, "audio.pcm");
    await writeFile(path, bytes);
    await client().transcribeFile(path, { raw: true, encoding: "linear16", sampleRate: 8000 });
    const request = server.requests[0]!;
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(request.url.searchParams.get("encoding")).toBe("linear16");
    expect(request.url.searchParams.get("sample_rate")).toBe("8000");
    expect(new Uint8Array(request.body)).toEqual(bytes);
  });

  it("rejects options that contradict the WAV header", async () => {
    const path = join(directory, "contradiction.wav");
    await writeFile(path, buildWav({ sampleRate: 8000, channels: 1, samplesPerChannel: 400 }));
    await expect(client().transcribeFile(path, { sampleRate: 16000 })).rejects.toThrow(/8000/);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects non-PCM16 WAV files", async () => {
    const path = join(directory, "wrongbits.wav");
    await writeFile(path, buildWav({ sampleRate: 8000, channels: 1, samplesPerChannel: 400, bitsPerSample: 8 }));
    await expect(client().transcribeFile(path)).rejects.toThrow(/16-bit PCM/);
  });

  it("accepts WAVE_FORMAT_EXTENSIBLE with a PCM subformat", async () => {
    const payload = pcmBytes(800);
    const wav = buildWav({ sampleRate: 8000, channels: 1, samplesPerChannel: 400, extensibleSubFormat: 1 });
    wav.set(payload, wav.byteLength - payload.byteLength);
    const path = join(directory, "extensible.wav");
    await writeFile(path, wav);
    await client().transcribeFile(path);
    const request = server.requests[0]!;
    expect(request.headers["content-type"]).toBe("audio/wav");
    expect(request.url.searchParams.get("encoding")).toBeNull();
    expect(request.url.searchParams.get("sample_rate")).toBeNull();
    expect(new Uint8Array(request.body)).toEqual(wav);
    expect(new Uint8Array(request.body.slice(-payload.byteLength))).toEqual(payload);
  });

  it("rejects WAVE_FORMAT_EXTENSIBLE with a non-PCM subformat", async () => {
    const path = join(directory, "extensible-float.wav");
    await writeFile(path, buildWav({ sampleRate: 8000, channels: 1, samplesPerChannel: 400, extensibleSubFormat: 3 }));
    await expect(client().transcribeFile(path)).rejects.toThrow(/16-bit PCM/);
    expect(server.requests).toHaveLength(0);
  });

  it("accepts an empty words array while preserving offline segments", async () => {
    server.response = {
      body: JSON.stringify({
        request_id: "req-empty-words",
        text: "wav transcript",
        words: [],
        segments: [{ start: 0.0, end: 0.2, text: "wav transcript" }],
        audio_duration_seconds: 0.2,
        model_info: { name: "bw-streaming-en", version: "current" },
      }),
    };
    const result = await client().transcribe(pcmBytes(2));
    expect(result.words).toEqual([]);
    expect(result.segments[0]).toEqual({ start: 0.0, end: 0.2, text: "wav transcript" });
  });
});

describe("transcribe error mapping", () => {
  it("maps 401 to AuthenticationError", async () => {
    server.response = { status: 401, body: "{}" };
    await expect(client().transcribe(pcmBytes(2))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("maps 429 to RateLimitError with Retry-After", async () => {
    server.response = { status: 429, headers: { "retry-after": "9" }, body: "{}" };
    const failure = await client()
      .transcribe(pcmBytes(2))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(RateLimitError);
    expect((failure as RateLimitError).retryAfterSeconds).toBe(9);
  });

  it("maps 429 with an HTTP-date Retry-After to seconds from now", async () => {
    const retryDate = new Date(Date.now() + 30_000).toUTCString();
    server.response = { status: 429, headers: { "retry-after": retryDate }, body: "{}" };
    const failure = await client()
      .transcribe(pcmBytes(2))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(RateLimitError);
    const seconds = (failure as RateLimitError).retryAfterSeconds;
    expect(seconds).toBeGreaterThanOrEqual(25);
    expect(seconds).toBeLessThanOrEqual(30);
  });

  it("maps 413 to InvalidRequestError naming the five minute cap", async () => {
    server.response = { status: 413, body: "{}" };
    const failure = await client()
      .transcribe(pcmBytes(2))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(InvalidRequestError);
    expect((failure as InvalidRequestError).message).toContain("five minutes");
    expect((failure as InvalidRequestError).status).toBe(413);
  });

  it("maps 400 to InvalidRequestError with the response detail", async () => {
    server.response = { status: 400, body: "unknown parameter: pitch" };
    const failure = await client()
      .transcribe(pcmBytes(2))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(InvalidRequestError);
    expect((failure as InvalidRequestError).message).toContain("unknown parameter: pitch");
    expect((failure as InvalidRequestError).status).toBe(400);
  });

  it("maps 5xx to ServiceUnavailableError", async () => {
    server.response = { status: 503, body: "{}" };
    await expect(client().transcribe(pcmBytes(2))).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("maps network failures to ServiceUnavailableError", async () => {
    const unreachable = new BwSttClient({ apiKey: KEY, baseUrl: "ws://127.0.0.1:9" });
    await expect(unreachable.transcribe(pcmBytes(2))).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it("times out before headers with ServiceUnavailableError", async () => {
    server.response = { hang: true };
    const failure = await client()
      .transcribe(pcmBytes(2), { timeoutMs: 60 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect((failure as ServiceUnavailableError).message).toContain("timed out");
  });

  it("times out during a stalled body with ServiceUnavailableError, not ProtocolError", async () => {
    server.response = { stallBody: true };
    const started = Date.now();
    const failure = await client()
      .transcribe(pcmBytes(2), { timeoutMs: 80 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect((failure as ServiceUnavailableError).message).toContain("timed out");
  });

  it("rejects malformed response bodies with ProtocolError", async () => {
    server.response = { body: "not json" };
    await expect(client().transcribe(pcmBytes(2))).rejects.toBeInstanceOf(ProtocolError);
    server.response = { body: JSON.stringify({ text: "missing fields" }) };
    await expect(client().transcribe(pcmBytes(2))).rejects.toBeInstanceOf(ProtocolError);
  });
});

describe("transcribe caller signal", () => {
  it("rejects with the caller's abort reason mid-request", async () => {
    server.response = { hang: true };
    const controller = new AbortController();
    const pending = client().transcribe(pcmBytes(2), { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("caller cancelled")), 20);
    await expect(pending).rejects.toThrow("caller cancelled");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    await expect(client().transcribe(pcmBytes(2), { signal: controller.signal })).rejects.toThrow("pre-aborted");
  });

  it("composes signals manually when AbortSignal.any is unavailable", async () => {
    server.response = { hang: true };
    const signalClass = AbortSignal as unknown as Record<string, unknown>;
    const originalAny = signalClass.any;
    delete signalClass.any;
    try {
      const controller = new AbortController();
      const pending = client().transcribe(pcmBytes(2), { timeoutMs: 5000, signal: controller.signal });
      setTimeout(() => controller.abort(new Error("manual compose")), 20);
      await expect(pending).rejects.toThrow("manual compose");
    } finally {
      signalClass.any = originalAny;
    }
  });
});
