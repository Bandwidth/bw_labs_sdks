import { AuthenticationError, BwSttError } from "./errors";

export interface TransportRequest {
  readonly url: string;
  /** Empty when the API key travels as a query parameter. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface TransportHandlers {
  onOpen(): void;
  onTextMessage(text: string): void;
  onBinaryMessage(data: Uint8Array): void;
  onClose(code?: number, reason?: string): void;
  onError(error: unknown): void;
  /** Pre-upgrade HTTP rejection (401/403/429/503), when the transport can observe it. */
  onUpgradeFailed(status: number, headers: Readonly<Record<string, string>>): void;
}

export interface TransportSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Opens a WebSocket and wires its lifecycle into the handlers. Injectable for tests. */
export type Transport = (request: TransportRequest, handlers: TransportHandlers) => Promise<TransportSocket>;

export function isNode(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

export const defaultTransport: Transport = (request, handlers) => {
  return isNode() ? nodeTransport(request, handlers) : Promise.resolve(browserTransport(request, handlers));
};

async function nodeTransport(request: TransportRequest, handlers: TransportHandlers): Promise<TransportSocket> {
  const { WebSocket: NodeWebSocket } = await import("ws");
  const socket = new NodeWebSocket(request.url, { headers: { ...request.headers } });
  socket.on("open", () => handlers.onOpen());
  socket.on("message", (data, isBinary) => {
    const bytes = Array.isArray(data)
      ? new Uint8Array(Buffer.concat(data))
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (isBinary) handlers.onBinaryMessage(bytes);
    else handlers.onTextMessage(new TextDecoder().decode(bytes));
  });
  socket.on("close", (code, reason) => handlers.onClose(code, reason.toString()));
  socket.on("error", (error) => handlers.onError(error));
  socket.on("unexpected-response", (clientRequest, response) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers)) {
      if (typeof value === "string") headers[name.toLowerCase()] = value;
      else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
    }
    handlers.onUpgradeFailed(response.statusCode ?? 0, headers);
    response.resume();
    clientRequest.destroy();
  });
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}

interface BrowserWebSocket {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

function browserTransport(request: TransportRequest, handlers: TransportHandlers): TransportSocket {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => BrowserWebSocket }).WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new BwSttError("no WebSocket implementation is available in this environment");
  }
  if (Object.keys(request.headers).length > 0) {
    throw new AuthenticationError(
      'this environment cannot set WebSocket headers; use authCarrier: "query"',
    );
  }
  const socket = new WebSocketCtor(request.url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") handlers.onTextMessage(event.data);
    else if (event.data instanceof ArrayBuffer) handlers.onBinaryMessage(new Uint8Array(event.data));
  });
  socket.addEventListener("close", (event) => handlers.onClose(event.code, event.reason));
  socket.addEventListener("error", (event) => handlers.onError(event));
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}
