/** Inferno-like colour map sampled into a 256-entry RGB table. */
const ANCHORS: Array<[number, [number, number, number]]> = [
  [0.0, [0, 0, 4]],
  [0.13, [27, 12, 65]],
  [0.25, [74, 12, 107]],
  [0.38, [120, 28, 109]],
  [0.5, [165, 44, 96]],
  [0.63, [207, 68, 70]],
  [0.75, [237, 105, 37]],
  [0.88, [251, 155, 6]],
  [1.0, [252, 255, 164]],
];

export const INFERNO: Uint8ClampedArray = (() => {
  const table = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < ANCHORS.length - 2 && t > ANCHORS[k + 1][0]) k++;
    const [t0, c0] = ANCHORS[k];
    const [t1, c1] = ANCHORS[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) table[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * f;
  }
  return table;
})();

/** Map a magnitude (dB-scaled 0..1) to a table index. */
export function dbToIndex(mag: number, floorDb = -80): number {
  const db = 20 * Math.log10(mag + 1e-9);
  const t = Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
  return Math.round(t * 255);
}
