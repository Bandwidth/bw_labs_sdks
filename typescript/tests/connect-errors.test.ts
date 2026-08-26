import { afterEach, describe, expect, it } from "vitest";
import { BwSttClient } from "../src/client";
import {
  AuthenticationError,
  parseRetryAfter,
  ProtocolError,
  RateLimitError,
  ServiceUnavailableError,
} from "../src/errors";
import type { Transport } from "../src/transport";
import { MockSttServer, waitFor } from "./helpers/mock-server";

const KEY = "bwa_key_test";
const servers: MockSttServer[] = [];

async function startServer(...args: Parameters<typeof MockSttServer.start>): Promise<MockSttServer> {
  const server = await MockSttServer.start(...args);
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

describe("pre-upgrade HTTP failures", () => {
  it("maps 401 to AuthenticationError", async () => {
    const server = await startServer({ rejectUpgrade: { status: 401 } });
    const client = new BwSttClient({ apiKey: "bad", baseUrl: server.url });
    const failure = await client.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AuthenticationError);
    expect((failure as AuthenticationError).status).toBe(401);
  });

  it("maps a wrong key to AuthenticationError via the server key check", async () => {
    const server = await startServer({ validKey: KEY });
    const client = new BwSttClient({ apiKey: "bwa_key_wrong", baseUrl: server.url });
    await expect(client.connect()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("maps 429 to RateLimitError with Retry-After", async () => {
    const server = await startServer({
      rejectUpgrade: { status: 429, headers: { "Retry-After": "7" } },
    });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const failure = await client.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RateLimitError);
    expect((failure as RateLimitError).retryAfterSeconds).toBe(7);
  });

  it("maps 429 with an HTTP-date Retry-After to seconds from now", async () => {
    const retryDate = new Date(Date.now() + 30_000).toUTCString();
    const server = await startServer({
      rejectUpgrade: { status: 429, headers: { "Retry-After": retryDate } },
    });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const failure = await client.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RateLimitError);
    const seconds = (failure as RateLimitError).retryAfterSeconds;
    expect(seconds).toBeGreaterThanOrEqual(25);
    expect(seconds).toBeLessThanOrEqual(30);
  });

  it("maps 5xx to ServiceUnavailableError", async () => {
    for (const status of [500, 503]) {
      const server = await startServer({ rejectUpgrade: { status } });
      const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
      await expect(client.connect()).rejects.toBeInstanceOf(ServiceUnavailableError);
    }
  });
});

describe("connect timeout", () => {
  it("rejects with ServiceUnavailableError when SessionOpened never arrives", async () => {
    const server = await startServer({ omitSessionOpened: true });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const started = Date.now();
    const failure = await client.connect({ connectTimeoutMs: 80 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect((failure as Error).message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reaps the socket and never starts keepalive on timeout", async () => {
    let closes = 0;
    const sent: (string | Uint8Array)[] = [];
    const transport: Transport = () =>
      Promise.resolve({
        send: (data) => {
          sent.push(data);
        },
        close: () => {
          closes += 1;
        },
      });
    const client = new BwSttClient({ apiKey: KEY, transport });
    await expect(client.connect({ connectTimeoutMs: 40, keepAliveIntervalMs: 10 })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(closes).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sent.filter((data) => typeof data === "string" && data.includes("KeepAlive"))).toHaveLength(0);
  });

  it("fires during socket open and closes a socket that arrives late", async () => {
    let closed = false;
    const transport: Transport = () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              send: () => {},
              close: () => {
                closed = true;
              },
            }),
          120,
        ),
      );
    const client = new BwSttClient({ apiKey: KEY, transport });
    const started = Date.now();
    await expect(client.connect({ connectTimeoutMs: 30 })).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(Date.now() - started).toBeLessThan(110);
    await waitFor(() => closed);
  });

  it("rejects a non-positive connectTimeoutMs", async () => {
    const client = new BwSttClient({ apiKey: KEY, baseUrl: "ws://127.0.0.1:1" });
    await expect(client.connect({ connectTimeoutMs: 0 })).rejects.toThrow(RangeError);
    await expect(client.connect({ connectTimeoutMs: -5 })).rejects.toThrow(RangeError);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses an HTTP-date as seconds from now", () => {
    const seconds = parseRetryAfter(new Date(Date.now() + 30_000).toUTCString());
    expect(seconds).toBeGreaterThanOrEqual(25);
    expect(seconds).toBeLessThanOrEqual(30);
  });

  it("floors past HTTP-dates at zero", () => {
    expect(parseRetryAfter(new Date(Date.now() - 30_000).toUTCString())).toBe(0);
  });

  it("returns undefined for unparseable values", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("in-band rejection before SessionOpened", () => {
  it("rejects connect with ProtocolError carrying the Error event", async () => {
    const server = await startServer({ omitSessionOpened: true });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    const pending = client.connect();
    const connection = await server.waitForConnection();
    connection.send({ type: "Error", code: "invalid_params", message: "unknown parameter: pitch" });
    const failure = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as ProtocolError).errorEvent?.code).toBe("invalid_params");
    expect((failure as ProtocolError).message).toContain("unknown parameter: pitch");
  });
});
