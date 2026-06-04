// src/match-ui.ts — pure match-HUD helpers (no three.js / DOM).

// Format remaining match time as M:SS (ceiled so it reads 0:01 until truly zero, 0:00 at/below 0).
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
