// src/colors.ts — deterministic per-player color (no three.js / DOM).
// Same id -> same color on every client, so a player looks consistent to everyone.

// Returns a 24-bit 0xRRGGBB color for a player id, spread by the golden angle so
// consecutive ids are visually distinct.
export function playerColor(id: number): number {
  const h = (((id * 137.508) % 360) + 360) % 360 / 360; // hue in [0,1)
  const s = 0.65;
  const l = 0.55;
  const a = s * Math.min(l, 1 - l);
  const ch = (n: number): number => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c);
  };
  return (ch(0) << 16) | (ch(8) << 8) | ch(4);
}
