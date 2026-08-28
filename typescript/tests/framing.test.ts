import { describe, expect, it } from "vitest";
import { FrameChunker, frameBytes, validateFrame } from "../src/framing";
import { BwSttError } from "../src/errors";
import { pcmBytes } from "./helpers/audio";

const LINEAR16_16K_MONO = { encoding: "linear16", sampleRate: 16000, channels: 1 } as const;

describe("frame byte math", () => {
  it("cuts 5120-byte frames for 160 ms of 16 kHz mono linear16", () => {
    expect(frameBytes(LINEAR16_16K_MONO)).toBe(5120);
  });

  it("matches the documented sizes for the other encodings", () => {
    expect(frameBytes({ encoding: "linear16", sampleRate: 16000, channels: 2 })).toBe(10240);
    expect(frameBytes({ encoding: "linear16", sampleRate: 8000, channels: 1 })).toBe(2560);
    expect(frameBytes({ encoding: "mulaw", sampleRate: 8000, channels: 1 })).toBe(1280);
    expect(frameBytes({ encoding: "alaw", sampleRate: 8000, channels: 2 })).toBe(2560);
    expect(frameBytes({ encoding: "g722", sampleRate: 16000, channels: 1 })).toBe(1280);
  });
});

describe("FrameChunker", () => {
  it("reassembles odd chunk sizes into exact frames without losing bytes", () => {
    const chunker = new FrameChunker(LINEAR16_16K_MONO);
    const input = pcmBytes(5120 * 2 + 640);
    const frames: Uint8Array[] = [];
    let offset = 0;
    for (const size of [1, 3333, 4444, 2222, input.byteLength - 1 - 3333 - 4444 - 2222]) {
      frames.push(...chunker.push(input.slice(offset, offset + size)));
      offset += size;
    }
    const tail = chunker.flush();
    expect(frames.map((frame) => frame.byteLength)).toEqual([5120, 5120]);
    expect(tail?.byteLength).toBe(640);
    const roundTrip = new Uint8Array(input.byteLength);
    let position = 0;
    for (const part of [...frames, tail!]) {
      roundTrip.set(part, position);
      position += part.byteLength;
    }
    expect(roundTrip).toEqual(input);
  });

  it("emits a 20 ms minimum tail and nothing for an exact fit", () => {
    const exact = new FrameChunker(LINEAR16_16K_MONO);
    exact.push(pcmBytes(5120));
    expect(exact.flush()).toBeUndefined();

    const minimum = new FrameChunker(LINEAR16_16K_MONO);
    minimum.push(pcmBytes(5120 + 640));
    expect(minimum.flush()?.byteLength).toBe(640);
  });

  it("throws on a leftover shorter than 20 ms", () => {
    const chunker = new FrameChunker(LINEAR16_16K_MONO);
    chunker.push(pcmBytes(5120 + 638));
    expect(() => chunker.flush()).toThrow(RangeError);
  });

  it("throws on a sample-misaligned leftover", () => {
    const chunker = new FrameChunker(LINEAR16_16K_MONO);
    chunker.push(pcmBytes(5120 + 641));
    expect(() => chunker.flush()).toThrow(TypeError);
  });

  it("refuses opus", () => {
    expect(() => new FrameChunker({ encoding: "opus", sampleRate: 16000, channels: 1 })).toThrow(BwSttError);
  });
});

describe("validateFrame", () => {
  it("accepts the documented bounds inclusive", () => {
    expect(() => validateFrame(LINEAR16_16K_MONO, 640)).not.toThrow();
    expect(() => validateFrame(LINEAR16_16K_MONO, 32000)).not.toThrow();
    expect(() => validateFrame({ encoding: "g722", sampleRate: 16000, channels: 1 }, 1280)).not.toThrow();
  });

  it("rejects frames outside 20-1000 ms", () => {
    expect(() => validateFrame(LINEAR16_16K_MONO, 638)).toThrow(RangeError);
    expect(() => validateFrame(LINEAR16_16K_MONO, 32002)).toThrow(RangeError);
  });

  it("rejects incomplete interleaved samples", () => {
    expect(() => validateFrame(LINEAR16_16K_MONO, 641)).toThrow(TypeError);
    expect(() => validateFrame({ encoding: "linear16", sampleRate: 16000, channels: 2 }, 5122)).toThrow(TypeError);
    expect(() => validateFrame(LINEAR16_16K_MONO, 0)).toThrow(TypeError);
  });
});
