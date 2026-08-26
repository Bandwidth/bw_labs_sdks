import { AuthenticationError, BwSttError, ServiceUnavailableError } from "./errors";
import { toUint8Array } from "./framing";
import type { AuthCarrier, ConnectOptions, TranscribeOptions } from "./options";
import { buildListenUrl, buildTranscribeUrl, resolveAuthCarrier, resolveMediaOptions } from "./options";
import { SttSession } from "./session";
import type { Transcription } from "./transcribe";
import { requestTranscription } from "./transcribe";
import type { Transport, TransportSocket } from "./transport";
import { defaultTransport, isNode } from "./transport";
import { isPcm16, parseWav } from "./wav";
import {
  API_KEY_ENV_VAR,
  API_KEY_HEADER,
  DEFAULT_BASE_URL,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_TRANSCRIBE_TIMEOUT_MS,
} from "./wire";

export interface BwSttClientOptions {
  /** Falls back to the BW_STT_API_KEY environment variable in Node. */
  apiKey?: string;
  /** Default wss://api.labs.bandwidth.com. A baseUrl without a path gets the standard endpoint paths appended. */
  baseUrl?: string;
  /** How the key travels: "auto" picks the header in Node and the api_key query parameter in browsers. */
  authCarrier?: AuthCarrier;
  /** Custom WebSocket transport, mainly for tests. */
  transport?: Transport;
}

export class BwSttClient {
  private readonly options: BwSttClientOptions;
  private readonly baseUrl: string;
  private readonly transport: Transport;

  constructor(options: BwSttClientOptions = {}) {
    this.options = options;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.transport = options.transport ?? defaultTransport;
  }

  /** Open a streaming session. Resolves on SessionOpened. */
  async connect(options: ConnectOptions = {}): Promise<SttSession> {
    const apiKey = this.resolveApiKey();
    const media = resolveMediaOptions(options);
    const carrier = resolveAuthCarrier(this.options.authCarrier ?? "auto", isNode());
    if (options.keepAliveIntervalMs !== undefined && options.keepAliveIntervalMs !== null && options.keepAliveIntervalMs < 0) {
      throw new RangeError("keepAliveIntervalMs must be a non-negative number or null");
    }
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    if (!(connectTimeoutMs > 0)) throw new RangeError("connectTimeoutMs must be a positive number");
    const url = buildListenUrl(this.baseUrl, options, carrier === "query" ? apiKey : undefined);
    const headers = carrier === "header" ? { [API_KEY_HEADER]: apiKey } : {};
    const session = new SttSession({
      frameConfig: media,
      keepAliveIntervalMs: options.keepAliveIntervalMs === undefined ? DEFAULT_KEEPALIVE_INTERVAL_MS : options.keepAliveIntervalMs,
    });
    const timeoutError = new ServiceUnavailableError(`connect timed out after ${connectTimeoutMs} ms`);
    let timedOut = false;
    let socket: TransportSocket | undefined;
    let rejectOnTimeout!: (error: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectOnTimeout = reject;
    });
    timeoutPromise.catch(() => {
      // Observed through the race below when the timer wins during socket open.
    });
    const timer = setTimeout(() => {
      timedOut = true;
      session.failConnect(timeoutError);
      try {
        socket?.close();
      } catch {
        // Already torn down.
      }
      rejectOnTimeout(timeoutError);
    }, connectTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const socketPromise = Promise.resolve(this.transport({ url, headers }, session.transportHandlers()));
    socketPromise.then(
      (opened) => {
        socket = opened;
        if (timedOut) {
          try {
            opened.close();
          } catch {
            // Never opened.
          }
        }
      },
      () => {
        // Surfaced through the race below.
      },
    );
    try {
      socket = await Promise.race([socketPromise, timeoutPromise]);
      await session.attach(socket);
      return session;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Transcribe a complete recording in one HTTP request. */
  async transcribe(input: Uint8Array | ArrayBuffer, options: TranscribeOptions = {}): Promise<Transcription> {
    const apiKey = this.resolveApiKey();
    const url = buildTranscribeUrl(this.baseUrl, options);
    return requestTranscription({
      url,
      apiKey,
      body: toUint8Array(input),
      timeoutMs: options.timeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * Transcribe an audio file. Node only. The default path expects a 16-bit PCM
   * WAV file and takes sample rate and channel count from its header; pass
   * raw: true to send headerless bytes described by the options instead.
   */
  async transcribeFile(path: string, options: TranscribeOptions & { raw?: boolean } = {}): Promise<Transcription> {
    if (!isNode()) throw new BwSttError("transcribeFile requires Node; pass bytes to transcribe instead");
    const { readFile } = await import("node:fs/promises");
    const bytes = new Uint8Array(await readFile(path));
    if (options.raw) {
      const { raw: _raw, ...rest } = options;
      return this.transcribe(bytes, rest);
    }
    const { info, data } = parseWav(bytes);
    if (!isPcm16(info)) {
      throw new TypeError(`${path}: only 16-bit PCM WAV is supported; pass raw: true for headerless audio`);
    }
    if (options.encoding !== undefined && options.encoding !== "linear16") {
      throw new TypeError(`${path}: WAV input is linear16; the options request ${options.encoding}`);
    }
    if (options.sampleRate !== undefined && options.sampleRate !== info.sampleRate) {
      throw new TypeError(`${path}: WAV sample rate is ${info.sampleRate}, the options request ${options.sampleRate}`);
    }
    if (options.channels !== undefined && options.channels !== info.channels) {
      throw new TypeError(`${path}: WAV has ${info.channels} channel(s), the options request ${options.channels}`);
    }
    const { raw: _raw, ...rest } = options;
    return this.transcribe(data, {
      ...rest,
      encoding: "linear16",
      sampleRate: info.sampleRate,
      channels: info.channels,
    });
  }

  private resolveApiKey(): string {
    const fromEnv = isNode() ? process.env[API_KEY_ENV_VAR] : undefined;
    const apiKey = this.options.apiKey ?? fromEnv;
    if (apiKey === undefined || apiKey === "") {
      throw new AuthenticationError(`no API key: pass apiKey or set ${API_KEY_ENV_VAR}`);
    }
    if (/[\r\n]/.test(apiKey)) throw new TypeError("apiKey must not contain line breaks");
    return apiKey;
  }
}
