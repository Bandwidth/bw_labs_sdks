import { describe, expect, it } from "vitest";
import { isPcm16, parseWav, WavReader } from "../src/wav";
import { buildWav, pcmBytes } from "./helpers/audio";

function withPayload(container: Uint8Array, payload: Uint8Array): Uint8Array {
  const combined = container.slice();
  combined.set(payload, container.byteLength - payload.byteLength);
  return combined;
}

describe("WavReader", () => {
  it("parses a header split across arbitrary push boundaries", () => {
    const payload = pcmBytes(3200);
    const file = withPayload(
      buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 1600 }),
      payload,
    );
    const reader = new WavReader();
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < file.byteLength; offset += 7) {
      parts.push(...reader.push(file.slice(offset, offset + 7)));
    }
    reader.end();
    expect(reader.info).toEqual({ formatTag: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    expect(total).toBe(3200);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    expect(merged).toEqual(payload);
  });

  it("skips unknown chunks between fmt and data", () => {
    const file = buildWav({ sampleRate: 8000, channels: 2, samplesPerChannel: 800, extraChunkBytes: 33 });
    const reader = new WavReader();
    const parts = reader.push(file);
    reader.end();
    expect(reader.info?.sampleRate).toBe(8000);
    expect(reader.info?.channels).toBe(2);
    expect(parts.reduce((sum, part) => sum + part.byteLength, 0)).toBe(800 * 2 * 2);
  });

  it("rejects non-WAV bytes with a raw hint", () => {
    const reader = new WavReader();
    expect(() => reader.push(pcmBytes(64))).toThrow(/raw: true/);
  });

  it("rejects a file with no data chunk", () => {
    const file = buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 16 }).slice(0, 36);
    const reader = new WavReader();
    reader.push(file);
    expect(() => reader.end()).toThrow(/data chunk/);
  });
});

describe("parseWav", () => {
  it("returns fmt fields and the PCM payload", () => {
    const payload = pcmBytes(640);
    const file = withPayload(buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 320 }), payload);
    const { info, data } = parseWav(file);
    expect(info).toEqual({ formatTag: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
    expect(data).toEqual(payload);
  });
});

describe("WAVE_FORMAT_EXTENSIBLE", () => {
  it("parses the PCM subformat from the GUID", () => {
    const payload = pcmBytes(640);
    const file = withPayload(
      buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 320, extensibleSubFormat: 1 }),
      payload,
    );
    const { info, data } = parseWav(file);
    expect(info.formatTag).toBe(0xfffe);
    expect(info.subFormat).toBe(1);
    expect(isPcm16(info)).toBe(true);
    expect(data).toEqual(payload);
  });

  it("is not PCM16 when the subformat is IEEE float", () => {
    const file = buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 320, extensibleSubFormat: 3 });
    const { info } = parseWav(file);
    expect(info.subFormat).toBe(3);
    expect(isPcm16(info)).toBe(false);
  });

  it("is not PCM16 for a plain extensible tag without a readable GUID", () => {
    const file = buildWav({ sampleRate: 16000, channels: 1, samplesPerChannel: 320, formatTag: 0xfffe });
    const { info } = parseWav(file);
    expect(info.subFormat).toBeUndefined();
    expect(isPcm16(info)).toBe(false);
  });
});
