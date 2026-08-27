import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BwSttClient } from "../src/client";
import { AuthenticationError, ConnectionClosedError } from "../src/errors";
import type { Segment, SttEvent, Transcript } from "../src/events";
import type { ErrorEvent as SttErrorEvent } from "../src/events";
import { buildWav, pcmBytes } from "./helpers/audio";
import { MockSttServer, waitFor } from "./helpers/mock-server";

const KEY = "bwa_key_test";
let savedEnvKey: string | undefined;

beforeAll(() => {
  savedEnvKey = process.env.BW_STT_API_KEY;
  delete process.env.BW_STT_API_KEY;
});

afterAll(() => {
  if (savedEnvKey === undefined) delete process.env.BW_STT_API_KEY;
  else process.env.BW_STT_API_KEY = savedEnvKey;
});

const servers: MockSttServer[] = [];

async function startServer(...args: Parameters<typeof MockSttServer.start>): Promise<MockSttServer> {
  const server = await MockSttServer.start(...args);
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

function segmentEvent(text: string, start = 0): Record<string, unknown> {
  return {
    type: "Segment",
    channel: 0,
    start,
    end: start + 0.16,
    text,
    words: text
      .trim()
      .split(" ")
      .map((word, index) => ({ word, start: start + index * 0.05, end: start + index * 0.05 + 0.04 })),
  };
}

function transcriptEvent(
  channel: number,
  text: string,
  options: { applied?: boolean; entities?: number } = {},
): Record<string, unknown> {
  const applied = options.applied ?? false;
  return {
    type: "Transcript",
    channel,
    text,
    words: text === "" ? [] : [{ word: text, start: 0, end: 0.2 }],
    redaction: {
      applied,
      policies: applied ? ["ssn"] : [],
      entities_redacted: options.entities ?? 0,
    },
  };
}

describe("auth carriers", () => {
  it("auto uses the X-BW-LABS-API-KEY header in Node and no api_key parameter", async () => {
    const server = await startServer({ validKey: KEY });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const connection = await server.waitForConnection();
    expect(connection.headers["x-bw-labs-api-key"]).toBe(KEY);
    expect(connection.query.get("api_key")).toBeNull();
    session.disconnect();
  });

  it("query carrier puts the key in api_key and sends no header", async () => {
    const server = await startServer({ validKey: KEY });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url, authCarrier: "query" });
    const session = await client.connect();
    const connection = await server.waitForConnection();
    expect(connection.headers["x-bw-labs-api-key"]).toBeUndefined();
    expect(connection.query.get("api_key")).toBe(KEY);
    session.disconnect();
  });

  it("falls back to the BW_STT_API_KEY environment variable", async () => {
    const server = await startServer({ validKey: KEY });
    process.env.BW_STT_API_KEY = KEY;
    try {
      const client = new BwSttClient({ baseUrl: server.url });
      const session = await client.connect();
      const connection = await server.waitForConnection();
      expect(connection.headers["x-bw-labs-api-key"]).toBe(KEY);
      session.disconnect();
    } finally {
      delete process.env.BW_STT_API_KEY;
    }
  });

  it("rejects when no key is available anywhere", async () => {
    const client = new BwSttClient({ baseUrl: "ws://127.0.0.1:1" });
    await expect(client.connect()).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe("connect", () => {
  it("resolves on SessionOpened and exposes it", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ sampleRate: 8000, channels: 2 });
    expect(session.opened.type).toBe("SessionOpened");
    expect(session.opened.requestId).toBe("req-1");
    expect(session.opened.sampleRate).toBe(8000);
    expect(session.opened.modelInfo.name).toBe("bw-streaming-en");
    session.disconnect();
  });

  it("sends mode, PII, and keyword parameters on the wire", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({
      mode: "demand",
      redactPii: true,
      redactPiiPolicies: ["ssn"],
      redactPiiSub: "hash",
      redactPiiReturn: true,
      keywords: ["dry van", "reefer"],
    });
    const connection = await server.waitForConnection();
    expect(connection.query.get("mode")).toBe("demand");
    expect(connection.query.get("redact_pii")).toBe("true");
    expect(connection.query.get("redact_pii_policies")).toBe("ssn");
    expect(connection.query.get("redact_pii_sub")).toBe("hash");
    expect(connection.query.get("redact_pii_return")).toBe("true");
    expect(connection.query.getAll("keywords")).toEqual(["dry van", "reefer"]);
    session.disconnect();
  });
});

describe("audio sending", () => {
  it("validates frame bounds and alignment in sendAudio", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    expect(() => session.sendAudio(pcmBytes(638))).toThrow(RangeError);
    expect(() => session.sendAudio(pcmBytes(32002))).toThrow(RangeError);
    expect(() => session.sendAudio(pcmBytes(641))).toThrow(TypeError);
    session.sendAudio(pcmBytes(5120));
    const connection = await server.waitForConnection();
    await waitFor(() => connection.audioBytes === 5120);
    session.disconnect();
  });

  it("skips duration validation for opus packets", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ encoding: "opus" });
    session.sendAudio(pcmBytes(3));
    const connection = await server.waitForConnection();
    await waitFor(() => connection.audioBytes === 3);
    expect(() => session.sendAudio(new Uint8Array(0))).toThrow(TypeError);
    expect(() => session.streamChunks([pcmBytes(10)])).toThrow(/opus/);
    session.disconnect();
  });

  it("streamChunks cuts exact 160 ms frames from odd chunk sizes and yields segments", async () => {
    const texts = ["i need", " a dr", "y van"];
    const server = await startServer({
      onAudio: (connection) => {
        const text = texts[connection.audioFrames.length - 1];
        if (text !== undefined) connection.send(segmentEvent(text));
      },
    });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    let observed = 0;
    session.on("segment", () => observed++);
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield pcmBytes(5120);
      await waitFor(() => observed >= 1);
      yield pcmBytes(3000);
      yield pcmBytes(2760);
      await waitFor(() => observed >= 2);
    }
    const yielded: Segment[] = [];
    for await (const segment of session.streamChunks(chunks())) yielded.push(segment);
    expect(yielded.map((segment) => segment.text)).toEqual(["i need", " a dr"]);
    const connection = await server.waitForConnection();
    await waitFor(() => connection.audioBytes === 10880);
    expect(connection.audioFrames).toEqual([5120, 5120, 640]);
    const closed = await session.closeStream();
    expect(observed).toBe(3);
    expect(closed.audioDurationSeconds).toBeCloseTo(10880 / 32000, 5);
  });

  it("throws when the leftover tail is shorter than 20 ms", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    await expect(async () => {
      for await (const _segment of session.streamChunks([pcmBytes(5120 + 100)])) {
        // drain
      }
    }).rejects.toThrow(RangeError);
    session.disconnect();
  });
});

describe("event delivery", () => {
  it("closeStream drains trailing segments to listeners and resolves with billing fields", async () => {
    const server = await startServer({
      closeScript: () => [segmentEvent(" almost"), segmentEvent(" done")],
    });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const drained: string[] = [];
    session.on("segment", (segment) => drained.push(segment.text));
    session.sendAudio(pcmBytes(32000));
    const closed = await session.closeStream();
    expect(drained).toEqual([" almost", " done"]);
    expect(closed.type).toBe("SessionClosed");
    expect(closed.audioDurationSeconds).toBeCloseTo(1.0, 5);
    expect(closed.sessionDurationSeconds).toBeGreaterThan(0);
    expect(closed.raw.audio_duration_seconds).toBe(1.0);
  });

  it("closeStream is idempotent after SessionClosed", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const first = await session.closeStream();
    const second = await session.closeStream();
    expect(second).toBe(first);
  });

  it("surfaces in-band Error events without throwing and keeps the session usable", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const errors: SttErrorEvent[] = [];
    session.on("error", (event) => errors.push(event));
    const connection = await server.waitForConnection();
    connection.send({ type: "Error", code: "invalid_frame", message: "bad frame" });
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.code).toBe("invalid_frame");
    session.sendAudio(pcmBytes(5120));
    const closed = await session.closeStream();
    expect(closed.type).toBe("SessionClosed");
  });

  it("surfaces transcript_too_large as an in-band Error event", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const errors: SttErrorEvent[] = [];
    session.on("error", (event) => errors.push(event));
    const connection = await server.waitForConnection();
    connection.send({ type: "Error", code: "transcript_too_large", message: "too large" });
    await waitFor(() => errors.length === 1);
    expect(errors[0]!.code).toBe("transcript_too_large");
    await session.closeStream();
  });

  it("passes unknown event types through events() and on(event)", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const all: SttEvent[] = [];
    session.on("event", (event) => all.push(event));
    const collected: SttEvent[] = [];
    const iteration = (async () => {
      for await (const event of session.events()) collected.push(event);
    })();
    const connection = await server.waitForConnection();
    connection.send({ type: "SpeechStarted", offset: 0.5 });
    await waitFor(() => all.length === 1);
    await session.closeStream();
    await iteration;
    expect(collected.map((event) => event.type)).toEqual(["Unknown", "SessionClosed"]);
    const unknown = collected[0]!;
    expect(unknown.type === "Unknown" && unknown.eventType).toBe("SpeechStarted");
    expect(unknown.raw).toEqual({ type: "SpeechStarted", offset: 0.5 });
  });

  it("off() unregisters a listener", async () => {
    const server = await startServer({ closeScript: () => [segmentEvent("late")] });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    let calls = 0;
    const listener = () => calls++;
    session.on("segment", listener);
    session.off("segment", listener);
    await session.closeStream();
    expect(calls).toBe(0);
  });

  it("rejects pending iterators with ConnectionClosedError carrying the last Error event", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const iteration = (async () => {
      for await (const _event of session.events()) {
        // consume until failure
      }
    })();
    const connection = await server.waitForConnection();
    connection.send({ type: "Error", code: "internal_error", message: "server fault" });
    connection.terminate();
    const failure = await iteration.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConnectionClosedError);
    expect((failure as ConnectionClosedError).lastErrorEvent?.code).toBe("internal_error");
    await expect(session.closeStream()).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("events() keeps events that arrive before the first pull", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const iterator = session.events();
    const seen: string[] = [];
    session.on("segment", (segment) => seen.push(segment.text));
    const connection = await server.waitForConnection();
    connection.send(segmentEvent("one"));
    connection.send(segmentEvent(" two"));
    await waitFor(() => seen.length === 2);
    await session.closeStream();
    const collected: SttEvent[] = [];
    for await (const event of iterator) collected.push(event);
    const texts = collected.filter((event): event is Segment => event.type === "Segment").map((event) => event.text);
    expect(texts).toEqual(["one", " two"]);
    expect(collected[collected.length - 1]!.type).toBe("SessionClosed");
  });

  it("a throwing closed listener does not break shutdown and surfaces asynchronously", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const surfaced: unknown[] = [];
    const previous = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const capture: NodeJS.UncaughtExceptionListener = (error) => {
      surfaced.push(error);
    };
    process.on("uncaughtException", capture);
    try {
      session.on("closed", () => {
        throw new Error("listener bug");
      });
      const iteration = (async () => {
        const seen: SttEvent[] = [];
        for await (const event of session.events()) seen.push(event);
        return seen;
      })();
      const closed = await session.closeStream();
      expect(closed.type).toBe("SessionClosed");
      const iterated = await iteration;
      expect(iterated[iterated.length - 1]!.type).toBe("SessionClosed");
      await waitFor(() => surfaced.length === 1);
      expect((surfaced[0] as Error).message).toBe("listener bug");
    } finally {
      process.removeListener("uncaughtException", capture);
      for (const listener of previous) process.on("uncaughtException", listener);
    }
  });

  it("a throwing listener does not starve later listeners of the same event", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const previous = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    const surfaced: unknown[] = [];
    const capture: NodeJS.UncaughtExceptionListener = (error) => {
      surfaced.push(error);
    };
    process.on("uncaughtException", capture);
    try {
      let secondRan = false;
      session.on("segment", () => {
        throw new Error("first listener bug");
      });
      session.on("segment", () => {
        secondRan = true;
      });
      const connection = await server.waitForConnection();
      connection.send(segmentEvent("hello"));
      await waitFor(() => secondRan);
      await waitFor(() => surfaced.length === 1);
    } finally {
      process.removeListener("uncaughtException", capture);
      for (const listener of previous) process.on("uncaughtException", listener);
      session.disconnect();
    }
  });

  it("completes iterators quietly on local disconnect", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    const iteration = (async () => {
      const seen: SttEvent[] = [];
      for await (const event of session.events()) seen.push(event);
      return seen;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.disconnect();
    await expect(iteration).resolves.toEqual([]);
  });
});

describe("keepalive", () => {
  it("sends KeepAlive during send-side quiet", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ keepAliveIntervalMs: 40 });
    const connection = await server.waitForConnection();
    await waitFor(() => connection.keepAlives >= 2);
    session.disconnect();
  });

  it("sends nothing when disabled with 0", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ keepAliveIntervalMs: 0 });
    const connection = await server.waitForConnection();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(connection.keepAlives).toBe(0);
    session.disconnect();
  });

  it("sends nothing when disabled with null", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ keepAliveIntervalMs: null });
    const connection = await server.waitForConnection();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(connection.keepAlives).toBe(0);
    session.disconnect();
  });

  it("rejects a negative interval", async () => {
    const client = new BwSttClient({ apiKey: KEY, baseUrl: "ws://127.0.0.1:1" });
    await expect(client.connect({ keepAliveIntervalMs: -1 })).rejects.toThrow(RangeError);
  });
});

describe("finalize", () => {
  it("sends the Finalize control message", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    session.finalize();
    const connection = await server.waitForConnection();
    await waitFor(() => connection.finalizes === 1);
    session.disconnect();
  });

  it("waits for distinct per-cycle demand transcripts and calls transcript listeners", async () => {
    const server = await startServer({
      finalizeScript: (_connection, count) => [
        transcriptEvent(0, count === 1 ? "first" : "second", count === 2 ? { applied: true, entities: 1 } : {}),
      ],
    });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ mode: "demand" });
    const seen: string[] = [];
    session.on("transcript", (transcript) => seen.push(transcript.text));
    const first = await session.finalizeTranscript();
    const second = await session.finalizeTranscript();
    expect(first.map((transcript) => transcript.text)).toEqual(["first"]);
    expect(second.map((transcript) => transcript.text)).toEqual(["second"]);
    expect(second[0]!.redaction.entitiesRedacted).toBe(1);
    expect(seen).toEqual(["first", "second"]);
    const connection = await server.waitForConnection();
    expect(connection.finalizes).toBe(2);
    session.disconnect();
  });

  it("returns an empty Transcript for an empty demand Finalize", async () => {
    const server = await startServer({
      finalizeScript: () => [transcriptEvent(0, "")],
    });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ mode: "demand" });
    const result = await session.finalizeTranscript();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ channel: 0, text: "", words: [] });
    expect(result[0]!.redaction).toEqual({ applied: false, policies: [], entitiesRedacted: 0 });
    session.disconnect();
  });

  it("times out when a demand Finalize has no Transcript response", async () => {
    const server = await startServer();
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ mode: "demand" });
    await expect(session.finalizeTranscript(30)).rejects.toThrow(/finalizeTranscript timed out/);
    session.disconnect();
  });

  it("returns multichannel demand transcripts ordered by channel", async () => {
    const server = await startServer({
      finalizeScript: () => [transcriptEvent(1, "right"), transcriptEvent(0, "left")],
    });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ mode: "demand", channels: 2, multichannel: true });
    const result: Transcript[] = await session.finalizeTranscript();
    expect(result.map((transcript) => [transcript.channel, transcript.text])).toEqual([
      [0, "left"],
      [1, "right"],
    ]);
    session.disconnect();
  });

  it("delivers demand close remainder as Transcript before SessionClosed", async () => {
    const server = await startServer({ closeScript: () => [transcriptEvent(0, "remainder")] });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ mode: "demand" });
    const seen: string[] = [];
    session.on("transcript", (transcript) => seen.push(transcript.text));
    const iterator = session.events();
    const closed = await session.closeStream();
    const events: SttEvent[] = [];
    for await (const event of iterator) events.push(event);
    expect(seen).toEqual(["remainder"]);
    expect(closed.deliveryFailed).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["Transcript", "SessionClosed"]);
  });
});

describe("streamFile", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "bw-stt-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("streams a matching WAV file as exact frames", async () => {
    const server = await startServer();
    const path = join(directory, "ok.wav");
    await writeFile(path, buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 8000 }));
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    for await (const _segment of session.streamFile(path)) {
      // no segments scripted for this server
    }
    const connection = await server.waitForConnection();
    await waitFor(() => connection.audioBytes === 16000);
    expect(connection.audioFrames).toEqual([5120, 5120, 5120, 640]);
    await session.closeStream();
  });

  it("rejects a WAV whose format does not match the session", async () => {
    const server = await startServer();
    const path = join(directory, "mismatch.wav");
    await writeFile(path, buildWav({ sampleRate: 8000, channels: 1, samplesPerChannel: 4000 }));
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect({ sampleRate: 16000 });
    await expect(async () => {
      for await (const _segment of session.streamFile(path)) {
        // unreachable
      }
    }).rejects.toThrow(/8000 Hz.*16000 Hz/s);
    session.disconnect();
  });

  it("streams a WAVE_FORMAT_EXTENSIBLE file with a PCM subformat", async () => {
    const server = await startServer();
    const path = join(directory, "extensible.wav");
    await writeFile(path, buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 2880, extensibleSubFormat: 1 }));
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    for await (const _segment of session.streamFile(path)) {
      // no segments scripted for this server
    }
    const connection = await server.waitForConnection();
    await waitFor(() => connection.audioBytes === 5760);
    expect(connection.audioFrames).toEqual([5120, 640]);
    await session.closeStream();
  });

  it("rejects a WAVE_FORMAT_EXTENSIBLE file with a non-PCM subformat", async () => {
    const server = await startServer();
    const path = join(directory, "extensible-float.wav");
    await writeFile(path, buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 2880, extensibleSubFormat: 3 }));
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    await expect(async () => {
      for await (const _segment of session.streamFile(path)) {
        // unreachable
      }
    }).rejects.toThrow(/16-bit PCM/);
    session.disconnect();
  });

  it("streams raw PCM with raw: true", async () => {
    const server = await startServer();
    const path = join(directory, "audio.pcm");
    await writeFile(path, pcmBytes(5120 + 640));
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const session = await client.connect();
    for await (const _segment of session.streamFile(path, { raw: true })) {
      // no segments scripted
    }
    const connection = await server.waitForConnection();
    await waitFor(() => connection.audioBytes === 5760);
    expect(connection.audioFrames).toEqual([5120, 640]);
    await session.closeStream();
  });
});
