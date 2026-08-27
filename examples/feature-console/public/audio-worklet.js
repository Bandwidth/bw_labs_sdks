const TARGET_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLES_PER_FRAME = 1600;

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedRate = options.processorOptions?.targetSampleRate;
    this.targetSampleRate = requestedRate || TARGET_SAMPLE_RATE;
    this.step = sampleRate / this.targetSampleRate;
    this.inputSamples = [];
    this.inputPosition = 0;
    this.outputSamples = [];
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") {
        this.emitOutput();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels === undefined || channels.length === 0 || channels[0] === undefined) return true;

    const frameCount = channels[0].length;
    for (let index = 0; index < frameCount; index += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] || 0;
      this.inputSamples.push(sample / channels.length);
    }

    while (this.inputPosition + 1 < this.inputSamples.length) {
      const leftIndex = Math.floor(this.inputPosition);
      const fraction = this.inputPosition - leftIndex;
      const left = this.inputSamples[leftIndex] || 0;
      const right = this.inputSamples[leftIndex + 1] || left;
      const sample = left + (right - left) * fraction;
      this.outputSamples.push(sample);
      this.inputPosition += this.step;
      if (this.outputSamples.length >= OUTPUT_SAMPLES_PER_FRAME) this.emitOutput();
    }

    const consumed = Math.floor(this.inputPosition);
    if (consumed > 0) {
      this.inputSamples.splice(0, consumed);
      this.inputPosition -= consumed;
    }
    return true;
  }

  emitOutput() {
    if (this.outputSamples.length === 0) return;
    const pcm = new Int16Array(this.outputSamples.length);
    for (let index = 0; index < this.outputSamples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.outputSamples[index] || 0));
      pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    }
    this.outputSamples = [];
    this.port.postMessage({ type: "audio", buffer: pcm.buffer }, [pcm.buffer]);
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
