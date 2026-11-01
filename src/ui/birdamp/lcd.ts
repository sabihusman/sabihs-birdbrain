/** BirdAmp's LCD readouts (DECISIONS.md #110). Pure. */

/** The big clock: "00:47", "12:05", "1:02:03". */
export function lcdClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
}

/** The spec line: only real values. 48 kHz mono is what BirdNET takes; the dB range is the spectrogram's own. */
export function specLine(db: { bottomDb: number; topDb: number }): string {
  const n = (v: number) => String(Math.round(v)).replace('-', '−');
  return `48K · MONO · BIRDNET V2.4 · ${n(db.bottomDb)} TO ${n(db.topDb)} dBFS`;
}

/** How many of `n` LED segments a mic level (0…1, the same scale as the Listen level bar) lights. */
export function levelSegments(level: number, n = 6): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.max(0, Math.min(n, Math.round(Math.min(1, Math.sqrt(level) * 1.4) * n)));
}
