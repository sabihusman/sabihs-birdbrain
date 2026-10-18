/** WAV (RIFF) encoding and decoding without the Web Audio API. */

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
  durationSec: number;
}

function clamp16(v: number): number {
  const s = Math.max(-1, Math.min(1, v));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

/**
 * Encode float samples as 16-bit PCM WAV. Accepts one mono array or an array
 * of equal-length channel arrays.
 */
export function encodeWav(input: Float32Array | Float32Array[], sampleRate: number): ArrayBuffer {
  const channels = Array.isArray(input) ? input : [input];
  const numChannels = channels.length;
  if (numChannels === 0) throw new Error('encodeWav: no channels');
  const frames = channels[0].length;
  for (const c of channels) if (c.length !== frames) throw new Error('encodeWav: channel length mismatch');
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      view.setInt16(off, Math.round(clamp16(channels[c][i])), true);
      off += 2;
    }
  }
  return buffer;
}

/** Decode PCM (8/16/24/32-bit) or IEEE float (32/64-bit) WAV. */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);
  const tag = (off: number) => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let off = 12;
  while (off + 8 <= buffer.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) {
        // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buffer.byteLength - body);
    }
    off = body + size + (size & 1);
  }
  if (dataOffset < 0) throw new Error('WAV has no data chunk');
  if (numChannels === 0 || sampleRate === 0) throw new Error('WAV has no fmt chunk');
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * numChannels));
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frames));
  let p = dataOffset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let v: number;
      if (format === 3) {
        v = bitsPerSample === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
      } else if (format === 1) {
        switch (bitsPerSample) {
          case 8:
            v = (view.getUint8(p) - 128) / 128;
            break;
          case 16:
            v = view.getInt16(p, true) / 32768;
            break;
          case 24: {
            const b0 = view.getUint8(p);
            const b1 = view.getUint8(p + 1);
            const b2 = view.getInt8(p + 2);
            v = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
            break;
          }
          case 32:
            v = view.getInt32(p, true) / 2147483648;
            break;
          default:
            throw new Error(`Unsupported PCM bit depth ${bitsPerSample}`);
        }
      } else {
        throw new Error(`Unsupported WAV format code ${format}`);
      }
      channels[c][i] = v;
      p += bytesPerSample;
    }
  }
  return { sampleRate, channels, durationSec: frames / sampleRate };
}

/** Average channels down to mono. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}
