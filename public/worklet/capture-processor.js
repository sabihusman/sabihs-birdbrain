/* global AudioWorkletProcessor, registerProcessor */
/**
 * AudioWorklet processor: mixes the input to mono and posts fixed-size
 * Float32Array batches (at the AudioContext sample rate) to the main thread.
 * Plain JS on purpose: it is served as-is from /worklet/ and loaded with
 * audioWorklet.addModule().
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.batchSize = opts.batchSize || 2048;
    this.buffer = new Float32Array(this.batchSize);
    this.pos = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === 'stop') this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i];
      this.buffer[this.pos++] = sum / channels;
      if (this.pos === this.batchSize) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.batchSize);
        this.pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
