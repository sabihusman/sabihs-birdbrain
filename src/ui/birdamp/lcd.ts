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

/** How full the volume-style meter is, in percent, on the same scale as the Listen level bar. Display only. */
export function levelPercent(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0;
  return Math.min(100, Math.round(Math.sqrt(level) * 140));
}
