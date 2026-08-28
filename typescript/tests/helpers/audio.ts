/** Build a minimal 16-bit PCM WAV file with a silent payload. */
export function buildWav(options: {
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
  extraChunkBytes?: number;
  formatTag?: number;
  bitsPerSample?: number;
  /** Write a WAVE_FORMAT_EXTENSIBLE fmt chunk with this subformat code in the GUID. */
  extensibleSubFormat?: number;
}): Uint8Array {
  const bits = options.bitsPerSample ?? 16;
  const bytesPerSample = bits / 8;
  const extensible = options.extensibleSubFormat !== undefined;
  const fmtSize = extensible ? 40 : 16;
  const dataLength = options.samplesPerChannel * options.channels * bytesPerSample;
  const extra = options.extraChunkBytes ?? 0;
  const extraChunkLength = extra > 0 ? 8 + extra + (extra % 2) : 0;
  const total = 12 + 8 + fmtSize + extraChunkLength + 8 + dataLength;
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
  view.setUint32(offset + 4, fmtSize, true);
  view.setUint16(offset + 8, extensible ? 0xfffe : (options.formatTag ?? 1), true);
  view.setUint16(offset + 10, options.channels, true);
  view.setUint32(offset + 12, options.sampleRate, true);
  view.setUint32(offset + 16, options.sampleRate * options.channels * bytesPerSample, true);
  view.setUint16(offset + 20, options.channels * bytesPerSample, true);
  view.setUint16(offset + 22, bits, true);
  if (extensible) {
    view.setUint16(offset + 24, 22, true); // cbSize
    view.setUint16(offset + 26, bits, true); // valid bits per sample
    view.setUint32(offset + 28, 0, true); // channel mask
    view.setUint32(offset + 32, options.extensibleSubFormat!, true);
    const guidTail = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    for (let index = 0; index < guidTail.length; index++) bytes[offset + 36 + index] = guidTail[index]!;
  }
  offset += 8 + fmtSize;
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
