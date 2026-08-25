import { BwSttError } from "./errors";

export type Encoding = "linear16" | "mulaw" | "alaw" | "g722" | "opus";

export const FRAME_MS = 160;
export const MIN_FRAME_MS = 20;
export const MAX_FRAME_MS = 1000;

export interface FrameConfig {
  readonly encoding: Encoding;
  readonly sampleRate: number;
  readonly channels: number;
}

export function bytesPerSecond(config: FrameConfig): number {
  switch (config.encoding) {
    case "linear16":
      return config.sampleRate * 2 * config.channels;
    case "mulaw":
    case "alaw":
      return config.sampleRate * config.channels;
    case "g722":
      // One byte carries two output samples (64 kbps, mono only).
      return config.sampleRate / 2;
    case "opus":
      throw new BwSttError("opus audio has no fixed byte rate");
  }
}

/**
 * Smallest byte count that holds complete interleaved samples. g722 packs two
 * samples per byte, so every whole byte count is aligned.
 */
export function sampleBlockBytes(config: FrameConfig): number {
  switch (config.encoding) {
    case "linear16":
      return 2 * config.channels;
    case "mulaw":
    case "alaw":
      return config.channels;
    case "g722":
      return 1;
    case "opus":
      throw new BwSttError("opus audio is packet-framed, not sample-framed");
  }
}

export function frameBytes(config: FrameConfig, milliseconds: number = FRAME_MS): number {
  return (bytesPerSecond(config) * milliseconds) / 1000;
}

/** Validate one non-opus audio frame. Throws TypeError or RangeError. */
export function validateFrame(config: FrameConfig, byteLength: number): void {
  if (byteLength === 0) throw new TypeError("audio frame is empty");
  if (byteLength % sampleBlockBytes(config) !== 0) {
    throw new TypeError("audio frame does not contain complete interleaved samples");
  }
  const durationMs = (byteLength / bytesPerSecond(config)) * 1000;
  if (durationMs < MIN_FRAME_MS || durationMs > MAX_FRAME_MS) {
    throw new RangeError(
      `audio frame is ${formatMs(durationMs)} ms; frames must be between ${MIN_FRAME_MS} ms and ${MAX_FRAME_MS} ms`,
    );
  }
}

/**
 * Accumulates arbitrary byte chunks and cuts exact 160 ms frames. `flush`
 * returns the 20-160 ms tail, or throws if a shorter leftover remains.
 */
export class FrameChunker {
  readonly frameBytes: number;
  private readonly config: FrameConfig;
  private pending: Uint8Array = new Uint8Array(0);

  constructor(config: FrameConfig) {
    if (config.encoding === "opus") {
      throw new BwSttError("opus cannot be byte-chunked; send one packet per sendAudio call");
    }
    this.config = config;
    this.frameBytes = frameBytes(config);
  }

  push(chunk: Uint8Array): Uint8Array[] {
    let merged: Uint8Array;
    if (this.pending.byteLength === 0) {
      merged = chunk;
    } else {
      merged = new Uint8Array(this.pending.byteLength + chunk.byteLength);
      merged.set(this.pending);
      merged.set(chunk, this.pending.byteLength);
    }
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (merged.byteLength - offset >= this.frameBytes) {
      frames.push(merged.slice(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    this.pending = merged.slice(offset);
    return frames;
  }

  /** Returns the final tail frame, or undefined when nothing is left over. */
  flush(): Uint8Array | undefined {
    const tail = this.pending;
    if (tail.byteLength === 0) return undefined;
    this.pending = new Uint8Array(0);
    if (tail.byteLength % sampleBlockBytes(this.config) !== 0) {
      throw new TypeError("leftover audio does not contain complete interleaved samples");
    }
    const durationMs = (tail.byteLength / bytesPerSecond(this.config)) * 1000;
    if (durationMs < MIN_FRAME_MS) {
      throw new RangeError(
        `leftover audio is ${formatMs(durationMs)} ms; the final tail must be at least ${MIN_FRAME_MS} ms`,
      );
    }
    return tail;
  }
}

function formatMs(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function toUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}
