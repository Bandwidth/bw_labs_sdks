import {
  AuthenticationError,
  BwSttError,
  ConnectionClosedError,
  parseRetryAfter,
  ProtocolError,
  RateLimitError,
  ServiceUnavailableError,
} from "./errors";
import type { ErrorEvent, Segment, SessionClosed, SessionOpened, SttEvent } from "./events";
import { parseEvent } from "./events";
import type { FrameConfig } from "./framing";
import { FrameChunker, toUint8Array, validateFrame } from "./framing";
import { KeepAliveTimer } from "./keepalive";
import type { TransportHandlers, TransportSocket } from "./transport";
import { isNode } from "./transport";
import { WavReader } from "./wav";

export interface SessionEventMap {
  segment: Segment;
  error: ErrorEvent;
  closed: SessionClosed;
  event: SttEvent;
}

type Listener<K extends keyof SessionEventMap> = (event: SessionEventMap[K]) => void;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Per-iterator event buffer so every consumer sees every event once. */
class EventQueue {
  private buffered: SttEvent[] = [];
  private waiter: Deferred<IteratorResult<SttEvent>> | undefined;
  private ended = false;
  private failure: unknown;

  push(event: SttEvent): void {
    if (this.ended) return;
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: event, done: false });
    } else {
      this.buffered.push(event);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.reject(error);
    }
  }

  /** Buffered events, without waiting. */
  drain(): SttEvent[] {
    const drained = this.buffered;
    this.buffered = [];
    return drained;
  }

  next(): Promise<IteratorResult<SttEvent>> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    this.waiter = deferred<IteratorResult<SttEvent>>();
    return this.waiter.promise;
  }
}

type SessionState = "connecting" | "open" | "closing" | "closed" | "failed" | "disconnected";

export interface SttSessionInit {
  frameConfig: FrameConfig;
  keepAliveIntervalMs: number | null;
}

/** A live streaming session. Created by BwSttClient.connect. */
export class SttSession {
  private readonly frameConfig: FrameConfig;
  private readonly keepAlive: KeepAliveTimer;
  private socket: TransportSocket | undefined;
  private state: SessionState = "connecting";
  private openedEvent: SessionOpened | undefined;
  private openedDeferred = deferred<SessionOpened>();
  private closedEvent: SessionClosed | undefined;
  private closeDeferred: Deferred<SessionClosed> | undefined;
  private closeStreamSent = false;
  private failure: Error | undefined;
  private lastErrorEvent: ErrorEvent | undefined;
  private readonly queues = new Set<EventQueue>();
  private readonly listeners = new Map<keyof SessionEventMap, Set<(event: never) => void>>();

  constructor(init: SttSessionInit) {
    this.frameConfig = init.frameConfig;
    this.keepAlive = new KeepAliveTimer(init.keepAliveIntervalMs, () => {
      try {
        this.socket?.send(JSON.stringify({ type: "KeepAlive" }));
      } catch {
        // A dying socket surfaces through its own close/error events.
      }
    });
  }

  /** The SessionOpened handshake event. */
  get opened(): SessionOpened {
    if (this.openedEvent === undefined) throw new BwSttError("session is not open yet");
    return this.openedEvent;
  }

  /** Send one binary audio frame, or one raw Opus packet per call. */
  sendAudio(data: Uint8Array | ArrayBuffer): void {
    this.ensureOpen();
    const bytes = toUint8Array(data);
    if (this.frameConfig.encoding === "opus") {
      if (bytes.byteLength === 0) throw new TypeError("audio frame is empty");
    } else {
      validateFrame(this.frameConfig, bytes.byteLength);
    }
    this.send(bytes);
  }

  /** Flush buffered audio server-side. The session stays open; there is no ack. */
  finalize(): void {
    this.ensureOpen();
    this.send(JSON.stringify({ type: "Finalize" }));
  }

  /**
   * Send arbitrarily sized audio chunks. Bytes are re-cut into exact 160 ms
   * frames with a final 20-160 ms tail. Yields segments as they arrive while
   * sending; segments still in flight afterwards reach listeners and events()
   * iterators, including during the closeStream drain. Not usable with opus.
   */
  streamChunks(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncIterableIterator<Segment> {
    this.ensureOpen();
    const chunker = new FrameChunker(this.frameConfig);
    return this.runStream(this.frames(chunks, chunker));
  }

  /**
   * Stream an audio file. Node only. The default path expects a WAV file whose
   * format matches the session; pass raw: true for headerless audio bytes.
   */
  streamFile(path: string, options: { raw?: boolean } = {}): AsyncIterableIterator<Segment> {
    this.ensureOpen();
    if (!isNode()) throw new BwSttError("streamFile requires Node; stream your own chunks instead");
    const chunker = new FrameChunker(this.frameConfig);
    const source = options.raw ? this.fileBytes(path) : this.wavFileBytes(path);
    return this.runStream(this.frames(source, chunker));
  }

  /** All server events in arrival order. Completes after SessionClosed. */
  events(): AsyncIterableIterator<SttEvent> {
    return this.subscribeIterator((event) => event);
  }

  on<K extends keyof SessionEventMap>(name: K, listener: Listener<K>): void {
    let set = this.listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener as (event: never) => void);
  }

  off<K extends keyof SessionEventMap>(name: K, listener: Listener<K>): void {
    this.listeners.get(name)?.delete(listener as (event: never) => void);
  }

  /**
   * Graceful shutdown: sends CloseStream, drains remaining Segments (delivered
   * to listeners and iterators), and resolves with the terminal SessionClosed.
   */
  closeStream(): Promise<SessionClosed> {
    if (this.closedEvent !== undefined) return Promise.resolve(this.closedEvent);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.state === "disconnected") {
      return Promise.reject(new ConnectionClosedError("session was disconnected before SessionClosed"));
    }
    if (this.state === "connecting") {
      return Promise.reject(new BwSttError("session is not open yet"));
    }
    if (!this.closeStreamSent) {
      this.closeStreamSent = true;
      this.state = "closing";
      // Nothing more will be sent; a KeepAlive after CloseStream would be invalid.
      this.keepAlive.stop();
      try {
        this.send(JSON.stringify({ type: "CloseStream" }));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    this.closeDeferred ??= deferred<SessionClosed>();
    return this.closeDeferred.promise;
  }

  /** Abrupt local teardown. No SessionClosed will arrive; iterators complete. */
  disconnect(): void {
    if (this.state === "closed" || this.state === "failed" || this.state === "disconnected") return;
    this.state = "disconnected";
    this.keepAlive.stop();
    for (const queue of this.queues) queue.end();
    this.closeDeferred?.reject(new ConnectionClosedError("session was disconnected before SessionClosed"));
    this.closeDeferred = undefined;
    try {
      this.socket?.close(1000, "client disconnect");
    } catch {
      // Socket may already be gone.
    }
  }

  /** Wiring used by BwSttClient; not part of the public API. */
  transportHandlers(): TransportHandlers {
    return {
      onOpen: () => {
        // The protocol handshake completes on SessionOpened, not on WS open.
      },
      onTextMessage: (text) => this.handleText(text),
      onBinaryMessage: () => {
        this.fail(new ProtocolError("server sent an unexpected binary message"));
      },
      onClose: (code, reason) => this.handleClose(code, reason),
      onError: (error) => this.handleError(error),
      onUpgradeFailed: (status, headers) => this.handleUpgradeFailed(status, headers),
    };
  }

  /** Wiring used by BwSttClient; not part of the public API. */
  attach(socket: TransportSocket): Promise<SessionOpened> {
    this.socket = socket;
    return this.openedDeferred.promise;
  }

  private ensureOpen(): void {
    if (this.failure !== undefined) throw this.failure;
    switch (this.state) {
      case "open":
        return;
      case "connecting":
        throw new BwSttError("session is not open yet");
      case "closing":
        throw new BwSttError("CloseStream was already sent");
      case "closed":
        throw new BwSttError("session is closed");
      case "disconnected":
        throw new BwSttError("session was disconnected");
      case "failed":
        throw new BwSttError("session failed");
    }
  }

  private send(payload: string | Uint8Array): void {
    if (this.socket === undefined) throw new BwSttError("session has no transport");
    this.socket.send(payload);
    this.keepAlive.notifyActivity();
  }

  private handleText(text: string): void {
    let event: SttEvent;
    try {
      event = parseEvent(text);
    } catch (error) {
      this.fail(error instanceof Error ? error : new ProtocolError(String(error)));
      return;
    }
    if (this.state === "connecting") {
      if (event.type === "SessionOpened") {
        this.openedEvent = event;
        this.state = "open";
        this.keepAlive.start();
        this.openedDeferred.resolve(event);
      } else if (event.type === "Error") {
        this.lastErrorEvent = event;
        this.settleConnect(new ProtocolError(`${event.code}: ${event.message}`, { errorEvent: event }));
      } else {
        this.settleConnect(new ProtocolError(`expected SessionOpened, received ${event.type}`));
      }
      return;
    }
    this.dispatch(event);
  }

  private dispatch(event: SttEvent): void {
    if (event.type === "Error") this.lastErrorEvent = event;
    if (event.type === "SessionClosed") this.closedEvent = event;
    for (const queue of this.queues) queue.push(event);
    this.emit("event", event);
    if (event.type === "Segment") this.emit("segment", event);
    else if (event.type === "Error") this.emit("error", event);
    else if (event.type === "SessionClosed") this.emit("closed", event);
    if (event.type === "SessionClosed") {
      this.state = "closed";
      this.keepAlive.stop();
      for (const queue of this.queues) queue.end();
      this.closeDeferred?.resolve(event);
      try {
        this.socket?.close(1000, "session complete");
      } catch {
        // Server side usually closes first.
      }
    }
  }

  private emit<K extends keyof SessionEventMap>(name: K, event: SessionEventMap[K]): void {
    const set = this.listeners.get(name);
    if (set === undefined) return;
    for (const listener of set) (listener as Listener<K>)(event);
  }

  private handleClose(code?: number, reason?: string): void {
    if (this.state === "closed" || this.state === "disconnected" || this.state === "failed") return;
    const detail = code !== undefined ? ` (code ${code}${reason ? `: ${reason}` : ""})` : "";
    if (this.state === "connecting") {
      this.settleConnect(
        new ConnectionClosedError(`connection closed before the session opened${detail}`, {
          ...(this.lastErrorEvent !== undefined ? { lastErrorEvent: this.lastErrorEvent } : {}),
          ...(code !== undefined ? { closeCode: code } : {}),
          ...(reason !== undefined && reason !== "" ? { closeReason: reason } : {}),
        }),
      );
      return;
    }
    this.fail(
      new ConnectionClosedError(`connection closed unexpectedly${detail}`, {
        ...(this.lastErrorEvent !== undefined ? { lastErrorEvent: this.lastErrorEvent } : {}),
        ...(code !== undefined ? { closeCode: code } : {}),
        ...(reason !== undefined && reason !== "" ? { closeReason: reason } : {}),
      }),
    );
  }

  private handleError(error: unknown): void {
    if (this.state === "closed" || this.state === "disconnected" || this.state === "failed") return;
    const wrapped = new ConnectionClosedError("WebSocket error", {
      cause: error,
      ...(this.lastErrorEvent !== undefined ? { lastErrorEvent: this.lastErrorEvent } : {}),
    });
    if (this.state === "connecting") this.settleConnect(wrapped);
    else this.fail(wrapped);
  }

  private handleUpgradeFailed(status: number, headers: Readonly<Record<string, string>>): void {
    if (this.state !== "connecting") return;
    this.settleConnect(mapUpgradeFailure(status, headers));
  }

  private settleConnect(error: Error): void {
    this.state = "failed";
    this.failure = error;
    this.keepAlive.stop();
    this.openedDeferred.reject(error);
    try {
      this.socket?.close();
    } catch {
      // Never opened or already closing.
    }
  }

  private fail(error: Error): void {
    if (this.state === "closed" || this.state === "disconnected" || this.state === "failed") return;
    this.state = "failed";
    this.failure = error;
    this.keepAlive.stop();
    for (const queue of this.queues) queue.fail(error);
    this.closeDeferred?.reject(error);
    this.closeDeferred = undefined;
    try {
      this.socket?.close();
    } catch {
      // Already torn down.
    }
  }

  private subscribe(): EventQueue {
    const queue = new EventQueue();
    if (this.failure !== undefined) queue.fail(this.failure);
    else if (this.state === "closed" || this.state === "disconnected") queue.end();
    this.queues.add(queue);
    return queue;
  }

  private unsubscribe(queue: EventQueue): void {
    this.queues.delete(queue);
  }

  private async *subscribeIterator<T>(map: (event: SttEvent) => T): AsyncIterableIterator<T> {
    const queue = this.subscribe();
    try {
      while (true) {
        const result = await queue.next();
        if (result.done) return;
        yield map(result.value);
      }
    } finally {
      this.unsubscribe(queue);
    }
  }

  private async *frames(
    chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    chunker: FrameChunker,
  ): AsyncGenerator<Uint8Array> {
    for await (const chunk of chunks) {
      yield* chunker.push(toUint8Array(chunk));
    }
    const tail = chunker.flush();
    if (tail !== undefined) yield tail;
  }

  private async *runStream(frames: AsyncGenerator<Uint8Array>): AsyncIterableIterator<Segment> {
    const queue = this.subscribe();
    try {
      for await (const frame of frames) {
        this.sendAudio(frame);
        for (const event of queue.drain()) {
          if (event.type === "Segment") yield event;
        }
      }
      for (const event of queue.drain()) {
        if (event.type === "Segment") yield event;
      }
      if (this.failure !== undefined) throw this.failure;
    } finally {
      this.unsubscribe(queue);
      await frames.return(undefined);
    }
  }

  private async *fileBytes(path: string): AsyncGenerator<Uint8Array> {
    const { createReadStream } = await import("node:fs");
    const stream = createReadStream(path);
    try {
      for await (const chunk of stream) {
        yield toUint8Array(chunk as Uint8Array);
      }
    } finally {
      stream.destroy();
    }
  }

  private async *wavFileBytes(path: string): AsyncGenerator<Uint8Array> {
    const reader = new WavReader();
    let validated = false;
    for await (const chunk of this.fileBytes(path)) {
      const payloads = reader.push(chunk);
      if (!validated && reader.info !== undefined) {
        this.validateWavInfo(reader.info, path);
        validated = true;
      }
      yield* payloads;
    }
    reader.end();
    if (!validated) {
      if (reader.info === undefined) throw new TypeError(`${path}: WAV file has no fmt chunk`);
      this.validateWavInfo(reader.info, path);
    }
  }

  private validateWavInfo(info: { formatTag: number; channels: number; sampleRate: number; bitsPerSample: number }, path: string): void {
    if (this.frameConfig.encoding !== "linear16") {
      throw new TypeError(
        `${path}: WAV input requires a linear16 session (this session is ${this.frameConfig.encoding}); pass raw: true for headerless audio`,
      );
    }
    if (info.formatTag !== 1 || info.bitsPerSample !== 16) {
      throw new TypeError(`${path}: only 16-bit PCM WAV is supported; pass raw: true for headerless audio`);
    }
    if (info.sampleRate !== this.frameConfig.sampleRate || info.channels !== this.frameConfig.channels) {
      throw new TypeError(
        `${path}: WAV is ${info.sampleRate} Hz, ${info.channels} channel(s); the session is ` +
          `${this.frameConfig.sampleRate} Hz, ${this.frameConfig.channels} channel(s)`,
      );
    }
  }
}

function mapUpgradeFailure(status: number, headers: Readonly<Record<string, string>>): Error {
  if (status === 401 || status === 403) {
    return new AuthenticationError(`the API key was rejected (HTTP ${status})`, status);
  }
  if (status === 429) {
    return new RateLimitError(
      "connection refused: rate or concurrency limit reached (HTTP 429)",
      parseRetryAfter(headers["retry-after"]),
    );
  }
  if (status === 503) {
    return new ServiceUnavailableError("service temporarily unavailable (HTTP 503)");
  }
  return new ConnectionClosedError(`WebSocket upgrade failed with HTTP ${status}`);
}
