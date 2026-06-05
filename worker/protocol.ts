// worker/protocol.ts — shared wire protocol + tunables. No runtime deps.

export const SERVER_TICK_HZ = 20;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;      // 50
export const CLIENT_SEND_HZ = 15;
export const CLIENT_SEND_MS = 1000 / CLIENT_SEND_HZ;      // ~66.67
export const INTERP_DELAY_MS = 120;
export const MAX_PLAYERS_PER_ROOM = 12;
export const IDLE_TIMEOUT_MS = 30_000;
export const MAX_MESSAGE_BYTES = 1024;                    // app-level cap (platform max is 32 MiB)
export const RATE_LIMIT_MSGS_PER_SEC = 40;                // per connection
export const RESPAWN_MS = 3000;
export const SPAWN_PROTECTION_MS = 2500;
export const LAGCOMP_MAX_REWIND_MS = 500;
export const POSITION_BUFFER_MS = 1000;                   // keep ~1s of positions for rewind
export const MAX_HP = 100;
export const EYE_HEIGHT = 1.0;                            // capsule top y at spawn
export const AIM_CONE_DOT = Math.cos((4 * Math.PI) / 180); // ~4 degrees (legacy; superseded by HIT_RADIUS)
export const HIT_RADIUS = 1.2;                            // accept a shot whose aim ray passes within this of the target body
export const MAX_MOVE_SPEED = 12;                         // units/sec
export const MOVE_SPEED_TOLERANCE = 1.6;                  // allow bursts (jump pads etc.)
export const MOVE_BUDGET_SEC = 0.2;                       // anti-teleport token-bucket burst (sec of travel absorbed before clamping; tolerates network jitter)
export const MATCH_DURATION_MS = 300_000;                 // 5-minute matches
export const FRAG_LIMIT = 25;                             // match also ends at this many frags

export type Vec3 = [number, number, number];
export type Rot = [number, number];                       // [yaw, pitch] in radians

export interface Weapon {
  id: number; name: string; damage: number; headMult: number; maxRange: number; cooldownMs: number;
  clipSize: number; reserveAmmo: number; reloadMs: number;
}
export const WEAPONS: readonly Weapon[] = [
  { id: 0, name: "rifle", damage: 25, headMult: 2, maxRange: 200, cooldownMs: 120, clipSize: 30, reserveAmmo: 120, reloadMs: 1500 },
];

export const ST_DEAD = 0;
export const ST_ALIVE = 1;
export const ST_PROTECTED = 3;                            // alive + spawn protection
export type PlayerStateCode = typeof ST_DEAD | typeof ST_ALIVE | typeof ST_PROTECTED;

// Server-assigned spawn points (ground positions; capsule end y = EYE_HEIGHT).
// 12 points on a radius-~78 ring of the 180x180 arena (every 30°), clear of all buildings.
export const SPAWN_POINTS: readonly Vec3[] = [
  [78, EYE_HEIGHT, 0], [67.5, EYE_HEIGHT, 39], [39, EYE_HEIGHT, 67.5],
  [0, EYE_HEIGHT, 78], [-39, EYE_HEIGHT, 67.5], [-67.5, EYE_HEIGHT, 39],
  [-78, EYE_HEIGHT, 0], [-67.5, EYE_HEIGHT, -39], [-39, EYE_HEIGHT, -67.5],
  [0, EYE_HEIGHT, -78], [39, EYE_HEIGHT, -67.5], [67.5, EYE_HEIGHT, -39],
];

// ---- Client -> Server ----
export interface InMsg  { t: "in";    seq: number; ts: number; p: Vec3; r: Rot; v: Vec3; }
export interface ShootMsg { t: "shoot"; seq: number; ts: number; o: Vec3; d: Vec3; w: number; hit: number | null; head: boolean; }
export interface ReadyMsg { t: "ready"; ready: boolean; }
export interface ReloadMsg { t: "reload"; }
export type ClientMsg = InMsg | ShootMsg | ReadyMsg | ReloadMsg;

// ---- Server -> Client ----
export interface PlayerSnap {
  id: number; name: string; p: Vec3; r: Rot; v: Vec3; hp: number; st: PlayerStateCode; frags: number; deaths: number;
}
export interface SnapMsg    { t: "snap";    tick: number; ts: number; ack: Record<number, number>; players: PlayerSnap[]; }
export interface WelcomeMsg { t: "welcome"; id: number; tickRate: number; players: PlayerSnap[]; matchEndsAt: number; fragLimit: number; }
export interface HitMsg     { t: "hit";     by: number; on: number; dmg: number; hp: number; head: boolean; }
export interface KillMsg    { t: "kill";    by: number; on: number; w: number; }
export interface SpawnMsg   { t: "spawn";   id: number; p: Vec3; prot: number; }
export interface LeaveMsg   { t: "leave";   id: number; }
export interface Standing { id: number; name: string; frags: number; deaths: number; }
export interface MatchStartMsg { t: "matchstart"; endsAt: number; fragLimit: number; }
export interface MatchOverMsg  { t: "matchover";  standings: Standing[]; }
export interface LobbyPlayer { id: number; name: string; ready: boolean; }
export interface LobbyMsg { t: "lobby"; players: LobbyPlayer[]; matchActive: boolean; }
export type ServerMsg = SnapMsg | WelcomeMsg | HitMsg | KillMsg | SpawnMsg | LeaveMsg | MatchStartMsg | MatchOverMsg | LobbyMsg;

export function encode(msg: ServerMsg | ClientMsg): string { return JSON.stringify(msg); }
export function decode<T>(raw: string): T | null { try { return JSON.parse(raw) as T; } catch { return null; } }

export function sanitizeRoom(code: string | undefined): string {
  if (!code) return "public";
  const c = code.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return c.length ? c : "public";
}
export function sanitizeName(name: string | undefined): string {
  const n = (name ?? "").trim().replace(/[^\x20-\x7e]/g, "").slice(0, 16);
  return n.length ? n : "anon";
}
