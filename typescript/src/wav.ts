export interface WavInfo {
  /** WAVE format tag; 1 is PCM. */
  readonly formatTag: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
}

const enum State {
  Riff,
  ChunkHeader,
  ChunkBody,
  Data,
  Done,
}

/**
 * Incremental RIFF/WAVE reader. Push raw file bytes in any chunk sizes; the
 * reader emits the payload of the data chunk and exposes the fmt fields once
 * both have been seen. Trailing chunks after data are ignored.
 */
export class WavReader {
  private state = State.Riff;
  private pending: Uint8Array = new Uint8Array(0);
  private currentChunkId = "";
  private currentChunkSize = 0;
  private dataRemaining = 0;
  private wavInfo: WavInfo | undefined;

  get info(): WavInfo | undefined {
    return this.wavInfo;
  }

  push(bytes: Uint8Array): Uint8Array[] {
    const output: Uint8Array[] = [];
    let input = bytes;
    while (true) {
      switch (this.state) {
        case State.Riff: {
          input = this.buffer(input);
          if (this.pending.byteLength < 12) return output;
          const header = this.take(12);
          if (ascii(header, 0) !== "RIFF" || ascii(header, 8) !== "WAVE") {
            throw new TypeError("not a RIFF/WAVE file; pass raw: true for headerless PCM");
          }
          this.state = State.ChunkHeader;
          break;
        }
        case State.ChunkHeader: {
          input = this.buffer(input);
          if (this.pending.byteLength < 8) return output;
          const header = this.take(8);
          this.currentChunkId = ascii(header, 0);
          const size = readUint32(header, 4);
          // RIFF chunks are word aligned; odd sizes carry one pad byte.
          this.currentChunkSize = size + (this.currentChunkId === "data" ? 0 : size % 2);
          if (this.currentChunkId === "data") {
            if (this.wavInfo === undefined) throw new TypeError("WAV data chunk appears before fmt");
            this.dataRemaining = size;
            this.state = State.Data;
          } else {
            this.state = State.ChunkBody;
          }
          break;
        }
        case State.ChunkBody: {
          if (this.currentChunkId === "fmt ") {
            input = this.buffer(input);
            if (this.pending.byteLength < this.currentChunkSize) return output;
            const body = this.take(this.currentChunkSize);
            if (body.byteLength < 16) throw new TypeError("WAV fmt chunk is too short");
            this.wavInfo = {
              formatTag: readUint16(body, 0),
              channels: readUint16(body, 2),
              sampleRate: readUint32(body, 4),
              bitsPerSample: readUint16(body, 14),
            };
            this.state = State.ChunkHeader;
          } else {
            // Skip unknown chunks without buffering them.
            const buffered = Math.min(this.pending.byteLength, this.currentChunkSize);
            this.pending = this.pending.slice(buffered);
            this.currentChunkSize -= buffered;
            const skipped = Math.min(input.byteLength, this.currentChunkSize);
            input = input.slice(skipped);
            this.currentChunkSize -= skipped;
            if (this.currentChunkSize > 0) return output;
            this.state = State.ChunkHeader;
          }
          break;
        }
        case State.Data: {
          const fromPending = this.pending.slice(0, Math.min(this.pending.byteLength, this.dataRemaining));
          if (fromPending.byteLength > 0) {
            this.pending = this.pending.slice(fromPending.byteLength);
            this.dataRemaining -= fromPending.byteLength;
            output.push(fromPending);
          }
          const fromInput = input.slice(0, Math.min(input.byteLength, this.dataRemaining));
          if (fromInput.byteLength > 0) {
            input = input.slice(fromInput.byteLength);
            this.dataRemaining -= fromInput.byteLength;
            output.push(fromInput);
          }
          if (this.dataRemaining === 0) this.state = State.Done;
          return output;
        }
        case State.Done:
          return output;
      }
    }
  }

  /** Call after the last push. Throws if no complete data chunk was found. */
  end(): void {
    if (this.state === State.Done) return;
    if (this.state === State.Data) {
      // A stated data size larger than the file; accept what was read.
      this.state = State.Done;
      return;
    }
    throw new TypeError("WAV file has no data chunk");
  }

  private buffer(input: Uint8Array): Uint8Array {
    if (input.byteLength === 0) return input;
    const merged = new Uint8Array(this.pending.byteLength + input.byteLength);
    merged.set(this.pending);
    merged.set(input, this.pending.byteLength);
    this.pending = merged;
    return new Uint8Array(0);
  }

  private take(count: number): Uint8Array {
    const taken = this.pending.slice(0, count);
    this.pending = this.pending.slice(count);
    return taken;
  }
}

/** Parse a complete in-memory WAV file into fmt fields and PCM payload. */
export function parseWav(bytes: Uint8Array): { info: WavInfo; data: Uint8Array } {
  const reader = new WavReader();
  const parts = reader.push(bytes);
  reader.end();
  const info = reader.info;
  if (info === undefined) throw new TypeError("WAV file has no fmt chunk");
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  return { info, data };
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000;
}
