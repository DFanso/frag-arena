// worker/match.ts — pure match-lifecycle helpers. No runtime deps.
import type { Standing } from "./protocol";

// Is the match over? True once the timer expires OR a player reaches the frag limit.
export function matchOutcome(now: number, endsAt: number, maxFrags: number, fragLimit: number): boolean {
  return now >= endsAt || maxFrags >= fragLimit;
}

// Rank players best-first: frags desc, then deaths asc, then id asc. Returns a new array.
export function rankPlayers(players: Standing[]): Standing[] {
  return [...players].sort(
    (a, b) => b.frags - a.frags || a.deaths - b.deaths || a.id - b.id,
  );
}
