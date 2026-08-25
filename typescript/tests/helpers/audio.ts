/** Build a minimal 16-bit PCM WAV file with a silent payload. */
export function buildWav(options: {
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
  extraChunkBytes?: number;
  formatTag?: number;
  bitsPerSample?: number;
}): Uint8Array {
  const bits = options.bitsPerSample ?? 16;
  const bytesPerSample = bits / 8;
  const dataLength = options.samplesPerChannel * options.channels * bytesPerSample;
  const extra = options.extraChunkBytes ?? 0;
  const extraChunkLength = extra > 0 ? 8 + extra + (extra % 2) : 0;
  const total = 12 + 8 + 16 + extraChunkLength + 8 + dataLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, total - 8, true);
  writeAscii(8, "WAVE");
  let offset = 12;
  writeAscii(offset, "fmt ");
  view.setUint32(offset + 4, 16, true);
  view.setUint16(offset + 8, options.formatTag ?? 1, true);
  view.setUint16(offset + 10, options.channels, true);
  view.setUint32(offset + 12, options.sampleRate, true);
  view.setUint32(offset + 16, options.sampleRate * options.channels * bytesPerSample, true);
  view.setUint16(offset + 20, options.channels * bytesPerSample, true);
  view.setUint16(offset + 22, bits, true);
  offset += 24;
  if (extra > 0) {
    writeAscii(offset, "LIST");
    view.setUint32(offset + 4, extra, true);
    offset += 8 + extra + (extra % 2);
  }
  writeAscii(offset, "data");
  view.setUint32(offset + 4, dataLength, true);
  return bytes;
}

/** Deterministic non-zero PCM payload for byte-level assertions. */
export function pcmBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = index % 251;
  return bytes;
}
