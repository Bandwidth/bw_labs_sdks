import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

export interface MockConnection {
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  audioBytes: number;
  audioFrames: number[];
  keepAlives: number;
  finalizes: number;
  send(event: Record<string, unknown>): void;
  sendText(text: string): void;
  terminate(): void;
  requestId: string;
}

export interface MockServerOptions {
  /** Reject non-matching keys pre-upgrade with 401. Accepts header or api_key query forms. */
  validKey?: string;
  /** Reject every upgrade pre-handshake with this HTTP status. */
  rejectUpgrade?: { status: number; message?: string; headers?: Record<string, string> };
  /** Called for every binary audio frame. */
  onAudio?: (connection: MockConnection, frame: Buffer) => void;
  /** Extra events sent after CloseStream, before SessionClosed. */
  closeScript?: (connection: MockConnection) => Record<string, unknown>[];
  /** Suppress the automatic SessionOpened. */
  omitSessionOpened?: boolean;
}

function bytesPerSecond(query: URLSearchParams): number {
  const encoding = query.get("encoding") ?? "linear16";
  const rate = Number(query.get("sample_rate") ?? "16000");
  const channels = Number(query.get("channels") ?? "1");
  if (encoding === "linear16") return rate * 2 * channels;
  if (encoding === "g722") return rate / 2;
  return rate * channels;
}

export class MockSttServer {
  readonly url: string;
  readonly connections: MockConnection[] = [];
  private readonly server: WebSocketServer;
  private connectionWaiters: ((connection: MockConnection) => void)[] = [];
  private counter = 0;

  private constructor(server: WebSocketServer, port: number, options: MockServerOptions) {
    this.server = server;
    this.url = `ws://127.0.0.1:${port}`;
    server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      this.counter += 1;
      const query = new URL(request.url ?? "/", "http://localhost").searchParams;
      const connection: MockConnection = {
        query,
        headers: request.headers,
        audioBytes: 0,
        audioFrames: [],
        keepAlives: 0,
        finalizes: 0,
        requestId: `req-${this.counter}`,
        send: (event) => socket.send(JSON.stringify(event)),
        sendText: (text) => socket.send(text),
        terminate: () => socket.terminate(),
      };
      this.connections.push(connection);
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          const frame = data as Buffer;
          connection.audioBytes += frame.length;
          connection.audioFrames.push(frame.length);
          options.onAudio?.(connection, frame);
          return;
        }
        const message = JSON.parse(data.toString()) as { type: string };
        if (message.type === "KeepAlive") connection.keepAlives += 1;
        else if (message.type === "Finalize") connection.finalizes += 1;
        else if (message.type === "CloseStream") {
          for (const event of options.closeScript?.(connection) ?? []) connection.send(event);
          const audioSeconds = connection.audioBytes / bytesPerSecond(query);
          connection.send({
            type: "SessionClosed",
            request_id: connection.requestId,
            audio_duration_seconds: Math.round(audioSeconds * 100) / 100,
            session_duration_seconds: Math.round(audioSeconds * 100) / 100 + 0.25,
          });
          socket.close(1000, "session complete");
        }
      });
      if (!options.omitSessionOpened) {
        connection.send({
          type: "SessionOpened",
          request_id: connection.requestId,
          model_info: { name: "bw-streaming-en", version: "current" },
          channels: Number(query.get("channels") ?? "1"),
          sample_rate: Number(query.get("sample_rate") ?? "16000"),
          encoding: query.get("encoding") ?? "linear16",
        });
      }
      const waiters = this.connectionWaiters;
      this.connectionWaiters = [];
      for (const waiter of waiters) waiter(connection);
    });
  }

  static start(options: MockServerOptions = {}): Promise<MockSttServer> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        verifyClient: (
          info: { req: IncomingMessage },
          callback: (result: boolean, code?: number, message?: string, headers?: Record<string, string>) => void,
        ) => {
          if (options.rejectUpgrade) {
            const { status, message, headers } = options.rejectUpgrade;
            callback(false, status, message ?? "rejected", headers);
            return;
          }
          if (options.validKey !== undefined) {
            const fromHeader = info.req.headers["x-bw-labs-api-key"];
            const fromQuery = new URL(info.req.url ?? "/", "http://localhost").searchParams.get("api_key");
            if (fromHeader !== options.validKey && fromQuery !== options.validKey) {
              callback(false, 401, "Unauthorized");
              return;
            }
          }
          callback(true);
        },
      });
      server.on("listening", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("mock server has no port"));
          return;
        }
        resolve(new MockSttServer(server, address.port, options));
      });
      server.on("error", reject);
    });
  }

  waitForConnection(): Promise<MockConnection> {
    const existing = this.connections[this.connections.length - 1];
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => this.connectionWaiters.push(resolve));
  }

  close(): Promise<void> {
    for (const client of this.server.clients) client.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** Poll until the condition holds; fails the test on timeout. */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
