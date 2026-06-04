// src/health-ui.ts — pure helpers for the enemy health bar (no three.js / DOM).

// Fraction of health remaining, clamped to [0, 1].
export function healthFraction(hp: number, maxHp: number): number {
  if (maxHp <= 0) return 0;
  return Math.max(0, Math.min(1, hp / maxHp));
}

// CSS rgb() color for a fill fraction: red (0) -> yellow (0.5) -> green (1).
export function healthColor(frac: number): string {
  const f = Math.max(0, Math.min(1, frac));
  const r = f < 0.5 ? 255 : Math.round(255 * (1 - (f - 0.5) * 2));
  const g = f > 0.5 ? 255 : Math.round(255 * (f * 2));
  return `rgb(${r},${g},0)`;
}
