// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/engine';
import { WINDOW_SAMPLES } from '../src/model/constants';

/** Minimal fakes for the Web Audio and getUserMedia surface the engine touches. */
class FakeNode {
  connections = new Set<FakeNode>();
  connect(n: FakeNode) {
    this.connections.add(n);
  }
  disconnect(n?: FakeNode) {
    if (n) this.connections.delete(n);
    else this.connections.clear();
  }
}
class FakeBiquad extends FakeNode {
  type = 'lowpass';
  frequency = { value: 350 };
  Q = { value: 1 };
}
class FakeWorkletNode extends FakeNode {
  static instances: FakeWorkletNode[] = [];
  port = { onmessage: null as null | ((e: { data: Float32Array }) => void), postMessage: vi.fn() };
  constructor(
    public ctx: unknown,
    public name: string,
    public opts: unknown,
  ) {
    super();
    FakeWorkletNode.instances.push(this);
  }
}
class FakeContext {
  state = 'running';
  sampleRate = 48000;
  destination = new FakeNode();
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  sources: FakeNode[] = [];
  filters: FakeBiquad[] = [];
  createMediaStreamSource() {
    const n = new FakeNode();
    this.sources.push(n);
    return n;
  }
  createBiquadFilter() {
    const f = new FakeBiquad();
    this.filters.push(f);
    return f;
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } });
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let trackSettings: Record<string, unknown>;
let lastCtx: FakeContext | null;

beforeEach(() => {
  FakeWorkletNode.instances = [];
  lastCtx = null;
  trackSettings = { sampleRate: 48000, channelCount: 1, deviceId: 'mic' };
  getUserMedia = vi.fn(async () => {
    const track = { getSettings: () => trackSettings, addEventListener: vi.fn(), stop: vi.fn() };
    return { getAudioTracks: () => [track], getTracks: () => [track] };
  });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('window', {
    isSecureContext: true,
    AudioContext: new Proxy(FakeContext, {
      construct(target) {
        lastCtx = new target();
        return lastCtx;
      },
    }),
  });
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});
afterEach(() => vi.unstubAllGlobals());

describe('AudioEngine microphone handling', () => {
  it('requests raw audio, reports what the browser applied, and builds the low-cut analysis path', async () => {
    const engine = new AudioEngine('worklet.js', 1.5, true);
    const mic = vi.fn();
    engine.on('mic', mic);
    await engine.start();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    // iPhone-style settings object: none of the three keys reported.
    expect(mic).toHaveBeenCalledTimes(1);
    expect(engine.getMicReport().status).toBe('not-controllable');

    const ctx = lastCtx!;
    const [source] = ctx.sources;
    const [filter] = ctx.filters;
    const [rawTap, analysisTap] = FakeWorkletNode.instances;
    expect(filter.type).toBe('highpass');
    expect(filter.frequency.value).toBe(150);
    expect(source.connections.has(rawTap)).toBe(true); // raw path straight from the mic
    expect(source.connections.has(filter)).toBe(true);
    expect(filter.connections.has(analysisTap)).toBe(true); // analysis path through the low-cut
    expect(source.connections.has(analysisTap)).toBe(false);

    engine.setLowCut(false);
    expect(filter.connections.has(analysisTap)).toBe(false);
    expect(source.connections.has(analysisTap)).toBe(true);
    engine.setLowCut(true);
    expect(filter.connections.has(analysisTap)).toBe(true);
    await engine.stop();
  });

  it('classifies a desktop Chrome answer as "off"', async () => {
    trackSettings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 };
    const engine = new AudioEngine('worklet.js', 1.5);
    await engine.start();
    expect(engine.getMicReport().status).toBe('off');
    await engine.stop();
  });

  it('emits windows from the analysis tap with the matching raw audio, whichever tap reports first', async () => {
    const engine = new AudioEngine('worklet.js', 0, true); // hop = 3 s, one window per 3 s
    const windows: Array<{ audio: Float32Array; raw: Float32Array | null; offsetSamples: number }> = [];
    engine.on('window', (w) => windows.push(w));
    await engine.start();
    const [rawTap, analysisTap] = FakeWorkletNode.instances;
    const chunks = WINDOW_SAMPLES / 1000; // 1000-sample batches divide the 144 000-sample window exactly
    for (let i = 0; i < chunks; i++) {
      // Analysis tap first (filtered values = 1), raw tap second (raw values = 2).
      analysisTap.port.onmessage!({ data: new Float32Array(1000).fill(1) });
      expect(windows.length).toBe(0); // waits for the raw ring
      rawTap.port.onmessage!({ data: new Float32Array(1000).fill(2) });
    }
    expect(windows.length).toBe(1);
    expect(windows[0].offsetSamples).toBe(0);
    expect(windows[0].audio[0]).toBe(1);
    expect(windows[0].raw?.length).toBe(WINDOW_SAMPLES);
    expect(windows[0].raw?.[WINDOW_SAMPLES - 1]).toBe(2);
    await engine.stop();
  });
});
