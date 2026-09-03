import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BwSttClient } from "../src/client";
import {
  JobLimitError,
  JobPlatformUnavailableError,
  TranscriptionJobError,
  TranscriptionNotFoundError,
} from "../src/errors";
import { pcmBytes } from "./helpers/audio";

const KEY = "bwa_key_test";

interface CapturedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

interface ResponseScript {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

class MockTranscriptionsServer {
  readonly requests: CapturedRequest[] = [];
  readonly url: string;
  responses: ResponseScript[] = [];
  private readonly server: Server;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.url = `ws://127.0.0.1:${port}`;
  }

  static start(): Promise<MockTranscriptionsServer> {
    return new Promise((resolve) => {
      let instance: MockTranscriptionsServer;
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
          const script = instance.responses.shift() ?? { status: 200, body: {} };
          response.writeHead(script.status, {
            ...(script.headers ?? {}),
            ...(script.status === 204 ? {} : { "content-type": "application/json" }),
          });
          if (script.status === 204) response.end();
          else response.end(typeof script.body === "string" ? script.body : JSON.stringify(script.body ?? {}));
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no port");
        instance = new MockTranscriptionsServer(server, address.port);
        resolve(instance);
      });
    });
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const SUBMISSION = { id: "job-1", status: "queued" };
const result = {
  request_id: "req-job",
  text: "",
  words: [],
  segments: [],
  audio_duration_seconds: 0.5,
  model_info: { name: "bw-streaming-en", version: "current" },
  channels: [
    {
      channel: 0,
      text: "left",
      words: [{ word: "left", start: 0, end: 0.2 }],
      segments: [{ start: 0, end: 0.2, text: "left" }],
    },
    {
      channel: 1,
      text: "right",
      words: [{ word: "right", start: 0, end: 0.2 }],
      segments: [{ start: 0, end: 0.2, text: "right" }],
    },
  ],
};

function status(status: "queued" | "processing" | "completed" | "error", extra: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status,
    progress: status === "queued" ? 0.25 : 1,
    created_at: "2026-09-03T12:00:00Z",
    updated_at: "2026-09-03T12:00:01Z",
    result: null,
    error: null,
    ...extra,
  };
}

let server: MockTranscriptionsServer;

beforeAll(async () => {
  server = await MockTranscriptionsServer.start();
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  server.requests.length = 0;
  server.responses = [];
});

function client(): BwSttClient {
  return new BwSttClient({ apiKey: KEY, baseUrl: server.url });
}

describe("transcriptions.submit", () => {
  it("uploads bytes with callback credentials in request headers", async () => {
    server.responses = [{ status: 202, body: SUBMISSION }];
    const audio = pcmBytes(3200);
    const submission = await client().transcriptions.submit({
      audio,
      channels: 2,
      multichannel: true,
      model: "pinned",
      callbackUrl: "https://hooks.example.test/stt",
      callbackAuthHeaderName: "X-Callback-Key",
      callbackAuthHeaderValue: "callback-secret",
    });
    expect(submission).toMatchObject(SUBMISSION);
    const request = server.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url.pathname).toBe("/audio/v1/transcriptions");
    expect(request.headers["x-bw-labs-api-key"]).toBe(KEY);
    expect(request.headers["content-type"]).toBe("application/octet-stream");
    expect(new Uint8Array(request.body)).toEqual(audio);
    expect(request.url.searchParams.get("encoding")).toBe("linear16");
    expect(request.url.searchParams.get("sample_rate")).toBe("16000");
    expect(request.url.searchParams.get("channels")).toBe("2");
    expect(request.url.searchParams.get("multichannel")).toBe("true");
    expect(request.url.searchParams.get("model")).toBe("pinned");
    expect(request.url.searchParams.get("callback_url")).toBe("https://hooks.example.test/stt");
    expect(request.url.searchParams.get("callback_auth_header_name")).toBeNull();
    expect(request.url.searchParams.get("callback_auth_header_value")).toBeNull();
    expect(request.headers["x-callback-auth-name"]).toBe("X-Callback-Key");
    expect(request.headers["x-callback-auth-value"]).toBe("callback-secret");
  });

  it("submits an audio URL as JSON and preserves explicit media options", async () => {
    server.responses = [{ status: 202, body: SUBMISSION }];
    await client().transcriptions.submit({
      audioUrl: "https://media.example.test/call.wav",
      sampleRate: 8000,
      channels: 2,
      multichannel: true,
      callbackUrl: "https://hooks.example.test/stt",
      callbackAuthHeaderName: "X-Callback-Key",
      callbackAuthHeaderValue: "callback-secret",
    });
    const request = server.requests[0]!;
    expect(request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request.body.toString())).toEqual({
      audio_url: "https://media.example.test/call.wav",
      callback: {
        url: "https://hooks.example.test/stt",
        auth_header_name: "X-Callback-Key",
        auth_header_value: "callback-secret",
      },
    });
    expect(request.url.searchParams.get("sample_rate")).toBe("8000");
    expect(request.url.searchParams.get("channels")).toBe("2");
    expect(request.url.searchParams.get("multichannel")).toBe("true");
    expect(request.url.searchParams.get("callback_url")).toBeNull();
    expect(request.url.searchParams.get("callback_auth_header_name")).toBeNull();
    expect(request.url.searchParams.get("callback_auth_header_value")).toBeNull();
    expect(request.headers["x-callback-auth-name"]).toBeUndefined();
    expect(request.headers["x-callback-auth-value"]).toBeUndefined();
  });
});

describe("transcriptions lifecycle", () => {
  it("gets a typed processing job and deletes it", async () => {
    server.responses = [
      { status: 200, body: status("processing") },
      { status: 204 },
    ];
    const jobs = client().transcriptions;
    const job = await jobs.get("job-1");
    await jobs.delete("job-1");
    expect(job.status).toBe("processing");
    expect(job.progress).toBe(1);
    expect(job.createdAt).toBe("2026-09-03T12:00:00Z");
    expect(server.requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);
    expect(server.requests[0]!.url.pathname).toBe("/audio/v1/transcriptions/job-1");
  });

  it("waits for completion and parses per-channel results", async () => {
    server.responses = [
      { status: 200, body: status("queued") },
      { status: 200, body: status("completed", { result }) },
    ];
    const transcription = await client().transcriptions.wait("job-1", {
      pollIntervalMs: 0,
      timeoutMs: 1000,
    });
    expect(transcription.text).toBe("");
    expect(transcription.channels?.map((channel) => channel.text)).toEqual(["left", "right"]);
    expect(server.requests).toHaveLength(2);
  });

  it("maps unknown jobs and platform limits to distinct typed errors", async () => {
    server.responses = [{ status: 404, body: { code: "not_found", message: KEY } }];
    await expect(client().transcriptions.get("foreign")).rejects.toBeInstanceOf(TranscriptionNotFoundError);
    server.responses = [{ status: 429, headers: { "retry-after": "7" }, body: { code: "job_limit_reached", message: KEY } }];
    const limited = await client().transcriptions.get("job-1").catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(JobLimitError);
    expect((limited as JobLimitError).code).toBe("job_limit_reached");
    expect((limited as Error).message).not.toContain(KEY);
    server.responses = [{ status: 503, body: { code: "job_platform_unavailable", message: KEY } }];
    const unavailable = await client().transcriptions.get("job-1").catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(JobPlatformUnavailableError);
    expect((unavailable as Error).message).not.toContain(KEY);
    server.responses = [{ status: 429, headers: { "retry-after": "5" }, body: { code: "job_submission_busy", message: KEY } }];
    const busy = await client().transcriptions.submit({ audio: pcmBytes(3200) }).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(JobLimitError);
    expect((busy as JobLimitError).code).toBe("job_submission_busy");
    expect((busy as JobLimitError).retryAfterSeconds).toBe(5);
    expect((busy as Error).message).not.toContain(KEY);
  });
});

describe("transcription validation", () => {
  it("sends multichannel transcribe requests and parses their channels", async () => {
    server.responses = [{ status: 200, body: result }];
    const transcription = await client().transcribe(pcmBytes(3200), {
      channels: 2,
      multichannel: true,
    });
    expect(transcription.channels?.map((channel) => channel.text)).toEqual(["left", "right"]);
    expect(server.requests[0]!.url.searchParams.get("multichannel")).toBe("true");
  });

  it("rejects multichannel requests that do not specify two channels", async () => {
    await expect(client().transcribe(pcmBytes(3200), { multichannel: true })).rejects.toThrow(/channels: 2/);
    await expect(client().transcriptions.submit({ audio: pcmBytes(3200), multichannel: true })).rejects.toThrow(/channels: 2/);
    await expect(
      client().transcriptions.submit({ audioUrl: "https://media.example.test/call.wav", channels: 1, multichannel: true }),
    ).rejects.toThrow(/channels: 2/);
    expect(server.requests).toHaveLength(0);
  });

  it("keeps the legacy single-channel response shape", async () => {
    server.responses = [
      {
        status: 200,
        body: {
          request_id: "req-single",
          text: "hello",
          words: [],
          segments: [],
          audio_duration_seconds: 0.2,
          model_info: {},
        },
      },
    ];
    const value = await client().transcribe(pcmBytes(3200));
    expect(value).not.toHaveProperty("channels");
    expect(value.text).toBe("hello");
  });

  it("raises the typed terminal job error without the API key", async () => {
    server.responses = [
      {
        status: 200,
        body: status("error", {
          error: { code: "audio_unavailable", message: `failed for ${KEY}` },
        }),
      },
    ];
    const failure = await client().transcriptions.wait("job-1", { timeoutMs: 1000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TranscriptionJobError);
    expect((failure as TranscriptionJobError).code).toBe("audio_unavailable");
    expect((failure as Error).message).not.toContain(KEY);
  });
});
