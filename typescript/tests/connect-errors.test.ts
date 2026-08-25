import { afterEach, describe, expect, it } from "vitest";
import { BwSttClient } from "../src/client";
import {
  AuthenticationError,
  ProtocolError,
  RateLimitError,
  ServiceUnavailableError,
} from "../src/errors";
import { MockSttServer } from "./helpers/mock-server";

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

  it("maps 503 to ServiceUnavailableError", async () => {
    const server = await startServer({ rejectUpgrade: { status: 503 } });
    const client = new BwSttClient({ apiKey: KEY, baseUrl: server.url });
    await expect(client.connect()).rejects.toBeInstanceOf(ServiceUnavailableError);
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
