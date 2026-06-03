// src/death-ui.ts — pure death-screen text helpers (no three.js / DOM).
export function countdownText(remainingMs: number): string {
  if (remainingMs <= 0) return "Respawning…";
  return `Respawning in ${Math.ceil(remainingMs / 1000)}`;
}

export function deathMessage(killerName: string): string {
  const name = killerName && killerName.trim() ? killerName.trim() : "the void";
  return `Fragged by ${name}`;
}
