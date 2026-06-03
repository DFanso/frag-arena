// src/net-helpers.ts — DOM-free WS helpers (unit-tested; no window / no WebSocket).
import type { Vec3 } from "../worker/protocol";

// Re-export the shared Vec3 type so callers can pull wire shapes from one place.
export type { Vec3 };

export interface LocationLike {
  protocol: string; // "http:" | "https:"
  host: string; // "host:port"
}

// Build the WebSocket URL for a room. wss:// over https, ws:// otherwise.
// The nickname travels as a url-encoded `?name=` query (contract D5 — no JoinMsg).
export function buildWsUrl(loc: LocationLike, room: string, name: string): string {
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/ws/${room}?name=${encodeURIComponent(name)}`;
}

// Exponential backoff: 500ms, 1000, 2000, 4000, 8000, capped at 8000ms.
export function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}
