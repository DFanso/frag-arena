// worker/protocol.ts — shared wire protocol + tunables. No runtime deps.

export const SERVER_TICK_HZ = 64;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;      // ~15.6
export const CLIENT_SEND_HZ = 60;
export const CLIENT_SEND_MS = 1000 / CLIENT_SEND_HZ;      // ~16.67
export const INTERP_DELAY_MS = 45;                        // ~2x tick interval + jitter margin (was 120 @ 20Hz on Cloudflare)
export const MAX_PLAYERS_PER_ROOM = 12;
export const IDLE_TIMEOUT_MS = 30_000;
export const RECONNECT_GRACE_MS = 30_000; // a dropped player's identity (id/score/in-match) is restorable by token for this long
export const MAX_MESSAGE_BYTES = 1024;                    // app-level cap (platform max is 32 MiB)
export const RATE_LIMIT_MSGS_PER_SEC = 40;                // per connection
export const WS_CONN_LIMIT_PER_IP = 12;                   // max WebSocket upgrades one IP may open per WS_CONN_WINDOW_MS
export const WS_CONN_WINDOW_MS = 60_000;                  // sliding window for the per-IP connection cap (1 minute)
export const RESPAWN_MS = 3000;
export const SPAWN_PROTECTION_MS = 2500;
export const LAGCOMP_MAX_REWIND_MS = 500;
export const POSITION_BUFFER_MS = 1000;                   // keep ~1s of positions for rewind
export const MAX_HP = 100;
export const EYE_HEIGHT = 1.0;                            // capsule top y at spawn (standing)
export const CROUCH_EYE_HEIGHT = 0.6;                    // capsule top y while crouching
export const AIM_CONE_DOT = Math.cos((4 * Math.PI) / 180); // ~4 degrees (legacy; superseded by HIT_RADIUS)
export const HIT_RADIUS = 1.2;                            // accept a shot whose aim ray passes within this of the target body
export const HEAD_THRESHOLD = 0.8;                        // impact this far above the target's feet counts as a headshot (client + server)

// --- Per-limb hit zones (issue #29) ---
// The server classifies every hit into a zone by the impact height above the target's feet
// (where the aim ray crosses the target's vertical column — see validate.hitZone). This replaces
// the binary client-trusted head flag: damage = base * zone multiplier, computed server-side.
export const ZONE_LEGS = 0;
export const ZONE_STOMACH = 1;
export const ZONE_CHEST = 2;
export const ZONE_HEAD = 3;
export type HitZone = typeof ZONE_LEGS | typeof ZONE_STOMACH | typeof ZONE_CHEST | typeof ZONE_HEAD;
export const ZONE_NAMES: Record<HitZone, string> = { 0: "legs", 1: "stomach", 2: "chest", 3: "head" };
// Height bands above the feet (standing eye height = 1.0). >= HEAD_THRESHOLD is the head;
// then chest, then stomach; below STOMACH_MIN_HEIGHT is legs.
export const CHEST_MIN_HEIGHT = 0.55;
export const STOMACH_MIN_HEIGHT = 0.4;
// CS-style damage multipliers for the non-head zones (the head uses the weapon's own headMult so
// per-weapon head scaling — e.g. the sniper — is preserved). Stomach hurts more, legs less.
export const ZONE_MULT: Record<HitZone, number> = { 0: 0.75, 1: 1.25, 2: 1.0, 3: 1.0 };
export const MAX_MOVE_SPEED = 12;                         // units/sec
export const MOVE_SPEED_TOLERANCE = 1.6;                  // allow bursts (jump pads etc.)
export const MOVE_BUDGET_SEC = 0.2;                       // anti-teleport token-bucket burst (sec of travel absorbed before clamping; tolerates network jitter)
export const MATCH_DURATION_MS = 300_000;                 // 5-minute matches
export const FRAG_LIMIT = 25;                             // match also ends at this many frags

// --- AI bots / NPCs (issue #31) ---
// Server-driven opponents that occupy a PlayerRec with a no-op connection. Single "medium"
// difficulty in v1: a per-shot hit chance + a short reaction delay before engaging.
export const MAX_BOTS = MAX_PLAYERS_PER_ROOM - 1;         // leave room for at least one human
export const BOT_ACCURACY = 0.35;                         // probability a fired bot shot lands
export const BOT_REACTION_MS = 450;                       // delay after acquiring a target before firing
export const BOT_FIRE_RANGE = 40;                         // bots only engage within this distance (units) — they close in first, no long-range sniping
export const BOT_AIM_DOT = Math.cos((20 * Math.PI) / 180); // must be facing within ~20° to fire
export const BOT_MOVE_SPEED = 6;                          // bot travel speed (units/sec; humans cap at 12)
export const BOT_PREFERRED_RANGE = 28;                    // bots try to hold roughly this distance from a target
export const BOT_WANDER_INTERVAL_MS = 2000;               // re-pick a wander heading this often when no target
export const BOT_BOUND = 110;                             // soft arena bound bots stay within (walls are at ±120)
export const BOT_RADIUS = 0.8;                            // bot body radius for structure collision (keeps them out of buildings)
export const BOT_VISION_RANGE = 90;                       // a bot can only perceive targets within this distance
export const BOT_FOV_DOT = Math.cos((70 * Math.PI) / 180); // 140° view cone: a target must be within ±70° of facing

// Major sight-blocking structures as XZ rectangles (center x/z + full width/depth), used for the
// bots' server-side line-of-sight test (the server has no scene geometry). All of these are far
// taller than eye height, so a 2-D XZ occlusion test is correct for ground players. Mirrors the
// `home(...)` and `ladderTower(...)` placements in src/map.ts. Small cover (crates/logs/containers)
// is intentionally omitted — it doesn't reliably block a standing sightline.
export interface Rect { x: number; z: number; w: number; d: number; }
export const OCCLUDERS: readonly Rect[] = [
  { x: 62, z: 0, w: 18, d: 18 }, { x: -62, z: 0, w: 16, d: 16 },
  { x: 0, z: 62, w: 18, d: 18 }, { x: 0, z: -62, w: 16, d: 16 },
  { x: 62, z: 62, w: 16, d: 16 }, { x: -62, z: -62, w: 18, d: 18 },
  { x: 0, z: 0, w: 5, d: 5 },     // CENTER_TOWER
  { x: 56, z: -56, w: 5, d: 5 },  // ROCKET_TOWER
  { x: -56, z: 56, w: 5, d: 5 },  // WATCH_TOWER
];

// --- Credits economy (issue #25) — the EARNING half of a CS-style economy; spending is a
// separate linked buy-menu issue. Server-authoritative: credits live in PlayerRec, are reset to
// STARTING_CREDITS at match start, awarded on confirmed hits/kills (never self/fall damage), and
// clamped to CREDITS_CAP. They ride along in PlayerSnap so the HUD can show the local balance. ---
export const STARTING_CREDITS = 800;   // credits each player begins a match with
export const CREDITS_PER_HIT = 25;     // granted to the shooter on every confirmed damaging hit
export const CREDITS_PER_KILL = 300;   // bonus granted to the killer on a frag (on top of the hit)
export const CREDITS_CAP = 16000;      // balances are clamped to this ceiling

// --- Buy menu (issue #26) — the SPENDING half of the CS-style economy (#25 earns; this spends).
// Each player owns the Rifle (id 0) for free from spawn; the other catalog guns must be PURCHASED
// from the buy menu (B) with credits, which equips them. Ownership is server-authoritative: it is
// reset to the free starter at match start, the server deducts Weapon.cost on a valid buy, and
// handleShoot only honours a shot from an owned weapon (a client can't fire an unbought gun). The
// Rocket launcher stays a tower pickup (NOT buyable) — its ownership is governed by hasRocket. ---
export const DEFAULT_WEAPON = 0;        // the Rifle (id 0): owned for free from spawn, cost 0

// --- Text chat (issue #10) ---
export const CHAT_MAX_LEN = 120;          // server caps each message body to this many chars
export const CHAT_MIN_INTERVAL_MS = 500;  // per-player chat cooldown (max ~2 messages/sec)
export const CHAT_HISTORY = 10;           // chat log shows the last N messages (client)

// --- Ammo pickups (refill reserve by walking over a crate) ---
export const PICKUP_RADIUS = 2.6;          // pick up within this XZ distance
export const PICKUP_RESPAWN_MS = 15000;    // a used crate returns after this long
export const AMMO_PICKUPS: readonly Vec3[] = [
  [34, 0, 34], [-34, 0, 34], [34, 0, -34], [-34, 0, -34],
  [0, 0, 72], [0, 0, -72], [72, 0, 0], [-72, 0, 0],
];

// --- Grenade (throwable AoE) ---
export const GRENADE_SPEED = 26;          // initial throw speed (units/sec)
export const GRENADE_GRAVITY = 22;        // downward accel on the thrown arc (units/sec^2)
export const GRENADE_FUSE_MS = 1500;      // detonates this long after the throw (or on ground)
export const GRENADE_RADIUS = 9;          // blast radius (units)
export const GRENADE_DAMAGE = 120;        // damage at the center; linear falloff to 0 at the edge
export const GRENADE_COOLDOWN_MS = 4000;  // per-player throw cooldown

// Grenades are a limited resource: you carry a few and refill from map pickups / on (re)spawn.
export const GRENADE_START = 2;           // grenades carried on (re)spawn
export const GRENADE_MAX = 3;             // most you can carry at once
export const GRENADE_PICKUP_RADIUS = 2.6; // pick up within this XZ distance
export const GRENADE_PICKUP_RESPAWN_MS = 15000; // a used grenade crate returns after this long
// Fixed grenade pickup positions (ground); walking over one tops you up to GRENADE_MAX.
export const GRENADE_PICKUPS: readonly Vec3[] = [
  [24, 0, -44], [-24, 0, 44], [44, 0, 24], [-44, 0, -24], [16, 0, 84], [-16, 0, -84],
];

// --- Rocket launcher (tower pickup; fires explosive splash rockets) ---
// The launcher is NOT a default weapon: it sits on top of a tower and is claimed by
// climbing a ladder and walking onto it. Picking it up grants ROCKET_CLIP rockets; when
// they run out the launcher is dropped (you fall back to the rifle) until you grab another.
export const ROCKET_CLIP = 3;              // rockets granted per pickup
export const ROCKET_RESPAWN_MS = 20000;    // the launcher returns to the tower this long after it's taken
export const ROCKET_PICKUP_RADIUS = 3.2;   // claim the launcher within this XZ distance of the tower top
export const ROCKET_SPEED = 60;            // straight-flight speed (units/sec) — server times the detonation
export const ROCKET_RADIUS = 7;            // blast radius (units)
export const ROCKET_DAMAGE = 130;          // damage at the center; linear falloff to 0 at the edge
export const ROCKET_MAX_RANGE = 320;       // server clamps the claimed impact point to this range
// --- Climbable towers ([x, topSurfaceY, z]) — map.ts builds a matching solid tower with a
// ladder at each x/z. The CENTER tower is the tallest (best parachute drop); the ROCKET tower
// carries the launcher perch. Server pickup/zipline checks use these exact coordinates. ---
export const CENTER_TOWER: Vec3 = [0, 26, 0];     // tallest landmark — climb + base-jump (no launcher)
export const ROCKET_TOWER: Vec3 = [56, 18, -56];  // rocket launcher perch
export const WATCH_TOWER: Vec3 = [-56, 18, 56];   // rocket launcher perch
export const TOWERS: readonly Vec3[] = [CENTER_TOWER, ROCKET_TOWER, WATCH_TOWER];
// Both non-center towers carry a rocket launcher pickup (indexed; one per tower).
export const ROCKET_TOWERS: readonly Vec3[] = [ROCKET_TOWER, WATCH_TOWER];

// Ziplines: ride from a tower top (a) down to a far point (b). Purely client-driven traversal.
export interface Zipline { a: Vec3; b: Vec3; }
export const ZIPLINES: readonly Zipline[] = [
  { a: [0, 25, 0], b: [56, 18, -56] },   // center tower top -> rocket tower top
  { a: [0, 25, 0], b: [-56, 18, 56] },   // center tower top -> watch tower top
];

// --- Explosive barrels (shoot to detonate; AoE damages nearby players) ---
// Detonate after BARREL_STREAK_COUNT hits from the SAME weapon landed rapidly (each within
// BARREL_STREAK_WINDOW_MS of the last). A different weapon or a pause resets the streak. This
// rewards dumping a burst into a barrel; the slow sniper effectively can't chain enough in time.
export const BARREL_STREAK_COUNT = 5;
export const BARREL_STREAK_WINDOW_MS = 2000;
export const BARREL_RADIUS = 7;         // blast radius
export const BARREL_DAMAGE = 90;        // damage at the center; linear falloff
export const BARREL_RESPAWN_MS = 20000; // a detonated barrel returns after this long
export const BARREL_HIT_RADIUS = 1.8;   // server accepts a shot whose ray passes within this of the barrel
// Every barrel on the map is an explosive fuel barrel (no inert decorative barrels).
export const EXPLOSIVE_BARRELS: readonly Vec3[] = [
  [40, 0, 10], [-40, 0, -10], [10, 0, 40], [-10, 0, -40],
  [48, 0, 48], [-48, 0, 48], [48, 0, -48], [-48, 0, -48],
  [24, 0, 0], [-24, 0, 0], [0, 0, 24], [0, 0, -24],
  [84, 0, 28], [-84, 0, -28], [28, 0, -84], [-28, 0, 84],
];

// --- Fall damage + parachute ---
export const FALL_SAFE_DIST = 7;        // a fall up to this height (units) does no damage
export const FALL_DMG_PER_UNIT = 9;     // damage per unit fallen beyond FALL_SAFE_DIST (≈ lethal past ~18u)
export const KZ_FLOOR = -20;            // out-of-bounds kill floor: a player whose eye y drops below this dies (issue #23)
export const PARACHUTE_FALL_SPEED = 4.5; // capped descent speed (units/sec) while the chute is open
export const PARACHUTE_GLIDE_SPEED = 8;  // horizontal glide speed while parachuting
export const PARACHUTE_MIN_HEIGHT = 6;   // only offer "press E" when at least this high above the ground

// --- Health syringe pickups (heal to full) ---
export const HEALTH_AMOUNT = MAX_HP;     // a syringe restores you to full health
export const HEALTH_PICKUP_RADIUS = 2.6;
export const HEALTH_RESPAWN_MS = 18000;
export const HEALTH_PICKUPS: readonly Vec3[] = [
  [40, 0, 0], [-40, 0, 0], [0, 0, 40],
];

// --- Armor pickups (grant MAX_ARMOR extra effective health; damage soaks armor first) ---
export const ARMOR_AMOUNT = 50;
export const MAX_ARMOR = 50;
export const ARMOR_PICKUP_RADIUS = 2.6;
export const ARMOR_RESPAWN_MS = 22000;
export const ARMOR_PICKUPS: readonly Vec3[] = [
  [0, 0, -40], [40, 0, 40],
];

// --- Spring boots pickups (timed super-jump) ---
export const SPRING_DURATION_MS = 15000; // boots last 15s after pickup
export const SPRING_RESPAWN_MS = 10000;  // a used spring pad returns after 10s
export const SPRING_PICKUP_RADIUS = 2.4;
export const SPRING_JUMP_MULT = 1.85;    // jump-velocity multiplier while the boots are active
export const SPRING_PICKUPS: readonly Vec3[] = [
  [72, 0, 72], [-72, 0, -72], [72, 0, -72], [-72, 0, 72],
  [96, 0, 0], [-96, 0, 0], [0, 0, 96], [0, 0, -96],
];

export type Vec3 = [number, number, number];
export type Rot = [number, number];                       // [yaw, pitch] in radians

// Transport-agnostic socket seam. Both the Cloudflare Hibernation `WebSocket` and the Node
// `ws` library's socket satisfy this structurally, so the game core (GameRoomCore) runs
// unchanged on both runtimes. Keep it minimal — only what the server actually calls.
export interface Conn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Weapon {
  id: number; name: string; damage: number; headMult: number; maxRange: number; cooldownMs: number;
  clipSize: number; reserveAmmo: number; reloadMs: number;
  // Buy-menu price in credits (issue #26). 0 = free / default-owned (Rifle) or NOT buyable from the
  // menu (Rocket — a tower pickup; see `buyable` below). Spent server-side on a valid `buy`.
  cost: number;
  // True → appears in the buy menu and can be purchased with credits (the Rifle is owned for free;
  // the Rocket is a tower pickup, so both are excluded). Keeps the catalog data-driven.
  buyable: boolean;
  adsZoom: number; // FOV multiplier while aiming down sights (1 = no zoom) — == zoomLevels[1] (#22 reuses #28)
  scoped: boolean; // true → full-screen scope overlay on the zoomed levels (sniper, #2)
  // Per-weapon zoom levels (#28): FOV multipliers, index 0 = hipfire (always 1, no zoom), each
  // further entry zooms in (m < 1 narrows the FOV). Right-click engages level 1; scoped weapons
  // can cycle deeper. A non-scope gun has one extra ADS level; a plain gun is just `[1]`. The
  // zoom is a client-side aiming aid — the server stays HIT_RADIUS-authoritative regardless.
  zoomLevels: number[];
  auto: boolean;   // true → fires continuously while the trigger is held (else one shot per click)
  baseSpread: number;  // resting aim-spread cone radius (NDC); 0 = pinpoint. Client-side bloom (#20).
  sprayGrowth: number; // spread added per shot, recovered over time; server stays HIT_RADIUS-authoritative.
}
// Weapon ids are array indices. Rifle (0) and Sniper (1) are always carried; Rocket (2) is a
// tower pickup (see ROCKET_* above) and only usable while held — its ammo is tracked separately
// (PlayerRec.rocketAmmo), not through the magazine/reserve system, and its blast uses ROCKET_*.
export const WEAPONS: readonly Weapon[] = [
  // master balance (Sniper 150/3000, Rifle reserve 10) + #28 zoomLevels + #20 spread + #26 cost/buyable.
  { id: 0, name: "Rifle", damage: 25, headMult: 2, maxRange: 200, cooldownMs: 120, clipSize: 30, reserveAmmo: 10, reloadMs: 1500, adsZoom: 0.8, scoped: false, zoomLevels: [1, 0.8], auto: true, baseSpread: 0.006, sprayGrowth: 0.004, cost: 0, buyable: false },
  { id: 1, name: "Sniper", damage: 150, headMult: 2, maxRange: 320, cooldownMs: 3000, clipSize: 5, reserveAmmo: 25, reloadMs: 2600, adsZoom: 0.4, scoped: true, zoomLevels: [1, 0.4, 0.2], auto: false, baseSpread: 0.001, sprayGrowth: 0.002, cost: 1500, buyable: true },
  { id: 2, name: "Rocket", damage: ROCKET_DAMAGE, headMult: 1, maxRange: ROCKET_MAX_RANGE, cooldownMs: 900, clipSize: ROCKET_CLIP, reserveAmmo: 0, reloadMs: 0, adsZoom: 0.92, scoped: false, zoomLevels: [1, 0.92], auto: false, baseSpread: 0, sprayGrowth: 0, cost: 0, buyable: false },
];
export const ROCKET_ID = 2; // index of the Rocket launcher in WEAPONS

export const ST_DEAD = 0;
export const ST_ALIVE = 1;
export const ST_PROTECTED = 3;                            // alive + spawn protection
export type PlayerStateCode = typeof ST_DEAD | typeof ST_ALIVE | typeof ST_PROTECTED;

// Server-assigned spawn points (ground positions; capsule end y = EYE_HEIGHT).
// 12 points on a radius-100 ring of the 240x240 arena (every 30°), clear of all buildings.
export const SPAWN_POINTS: readonly Vec3[] = [
  [100, EYE_HEIGHT, 0], [86.6, EYE_HEIGHT, 50], [50, EYE_HEIGHT, 86.6],
  [0, EYE_HEIGHT, 100], [-50, EYE_HEIGHT, 86.6], [-86.6, EYE_HEIGHT, 50],
  [-100, EYE_HEIGHT, 0], [-86.6, EYE_HEIGHT, -50], [-50, EYE_HEIGHT, -86.6],
  [0, EYE_HEIGHT, -100], [50, EYE_HEIGHT, -86.6], [86.6, EYE_HEIGHT, -50],
];

// ---- Client -> Server ----
// `c` = crouching, `pc` = parachute deployed (both echoed in snapshots for remote rendering).
export interface InMsg  { t: "in";    seq: number; ts: number; p: Vec3; r: Rot; v: Vec3; c?: boolean; pc?: boolean; }
export interface ShootMsg { t: "shoot"; seq: number; ts: number; o: Vec3; d: Vec3; w: number; hit: number | null; head: boolean; barrel?: number | null; }
export interface ReadyMsg { t: "ready"; ready: boolean; }
export interface ReloadMsg { t: "reload"; w: number; }
export interface ThrowMsg { t: "throw"; o: Vec3; d: Vec3; } // throw a grenade: origin + aim direction
// Fire a rocket. The client (which has the map geometry) raycasts and sends the impact point
// `p`; the server validates ownership/ammo/fire-rate, times the detonation, and applies AoE.
export interface RocketMsg { t: "rocket"; seq: number; ts: number; o: Vec3; d: Vec3; p: Vec3; hit: number | null; barrel: number | null; }
// Self-inflicted fall damage. The client detects a hard landing and claims the damage; the
// server clamps it and applies it to the sender (movement/landing is client-authoritative).
export interface FallMsg { t: "fall"; dmg: number; }
// Text chat (issue #10). The same shape travels both ways: the client sends a chat with its body
// (the `from`/`name` it fills are advisory — the server overwrites them with the connection's own
// authoritative id/name and re-sanitizes the body before re-broadcasting to the whole room).
export interface ChatMsg { t: "chat"; from: number; name: string; body: string; }
// Buy-menu purchase (issue #26): request to buy + equip the weapon at index `weaponId`. The
// server validates (match active + sender in-match + weapon buyable + affordable + not already
// owned), deducts the cost, grants ownership, and replies with a `bought` (accepted) — an invalid
// request is silently ignored (no reply).
export interface BuyMsg { t: "buy"; weaponId: number; }
export type ClientMsg = InMsg | ShootMsg | ReadyMsg | ReloadMsg | ThrowMsg | RocketMsg | FallMsg | ChatMsg | BuyMsg;

// ---- Server -> Client ----
// c = crouching, g = grenade count, a = armor, pc = parachute deployed.
export interface PlayerSnap {
  id: number; name: string; p: Vec3; r: Rot; v: Vec3; hp: number; st: PlayerStateCode; frags: number; deaths: number; c?: boolean; g?: number; a?: number; pc?: boolean; ai?: boolean; credits?: number;
}
export interface SnapMsg    { t: "snap";    tick: number; ts: number; ack: Record<number, number>; players: PlayerSnap[]; }
export interface WelcomeMsg { t: "welcome"; id: number; tickRate: number; players: PlayerSnap[]; matchEndsAt: number; fragLimit: number; token: string; rejoin: boolean; }
export interface HitMsg     { t: "hit";     by: number; on: number; dmg: number; hp: number; head: boolean; zone?: HitZone; }
export interface KillMsg    { t: "kill";    by: number; on: number; w: number; blast?: boolean; } // blast → client gibs the victim
export interface SpawnMsg   { t: "spawn";   id: number; p: Vec3; prot: number; }
export interface LeaveMsg   { t: "leave";   id: number; }
export interface Standing { id: number; name: string; frags: number; deaths: number; }
export interface MatchStartMsg { t: "matchstart"; endsAt: number; fragLimit: number; }
export interface MatchOverMsg  { t: "matchover";  standings: Standing[]; }
export interface LobbyPlayer { id: number; name: string; ready: boolean; ai?: boolean; }
export interface LobbyMsg { t: "lobby"; players: LobbyPlayer[]; matchActive: boolean; }
export interface GrenadeMsg { t: "grenade"; o: Vec3; v: Vec3; fuseMs: number; } // render the thrown arc + detonation
export interface PickupMsg { t: "pickup"; id: number; by: number; availableAt: number; } // ammo crate taken
export interface BarrelMsg { t: "barrel"; id: number; pos: Vec3; respawnAt: number; } // barrel detonated
export interface RocketFxMsg { t: "rocketfx"; o: Vec3; d: Vec3; p: Vec3; travelMs: number; } // render a rocket flying to p, then a blast
export interface WeaponPickupMsg { t: "weaponpickup"; id: number; by: number; availableAt: number; } // rocket launcher taken off tower `id`
export interface GrenadePickupMsg { t: "gpickup"; id: number; by: number; availableAt: number; } // grenade crate taken
export interface HealthPickupMsg { t: "hpickup"; id: number; by: number; availableAt: number; } // health syringe taken
export interface ArmorPickupMsg { t: "apickup"; id: number; by: number; availableAt: number; } // armor taken
export interface SpringPickupMsg { t: "sppickup"; id: number; by: number; availableAt: number; durationMs: number; } // spring boots taken
// Buy-menu purchase confirmed (issue #26): sent only to the buyer. `weaponId` was granted +
// equipped, `credits` is the new server-authoritative balance after the deduction.
export interface BoughtMsg { t: "bought"; weaponId: number; credits: number; }
export type ServerMsg = SnapMsg | WelcomeMsg | HitMsg | KillMsg | SpawnMsg | LeaveMsg | MatchStartMsg | MatchOverMsg | LobbyMsg | GrenadeMsg | PickupMsg | BarrelMsg | RocketFxMsg | WeaponPickupMsg | GrenadePickupMsg | HealthPickupMsg | ArmorPickupMsg | SpringPickupMsg | ChatMsg | BoughtMsg;

// Credits economy (issue #25): add `amount` to a balance, clamping into [0, CREDITS_CAP]. Pure so
// both the server award path and unit tests share one definition (negative inputs floor at 0).
export function addCredits(current: number, amount: number, cap: number = CREDITS_CAP): number {
  return Math.max(0, Math.min(cap, current + amount));
}

// Buy menu (issue #26): a fresh per-player ownership vector — one boolean per WEAPONS entry, with
// only the free DEFAULT_WEAPON owned. Pure so the server (spawn / match start) and tests share it.
// The Rocket launcher is a tower pickup tracked via PlayerRec.hasRocket, NOT this vector.
export function defaultOwnedWeapons(): boolean[] {
  return WEAPONS.map((w) => w.id === DEFAULT_WEAPON);
}

// Buy menu (issue #26): decide whether `weaponId` can be purchased given the buyer's current
// credits and ownership vector. Pure + server-authoritative so the menu's "can I afford this"
// gating and the server's deduction agree exactly. Rejects an unknown / non-buyable weapon, one
// already owned, or an unaffordable price. The Rocket (a tower pickup) is `buyable:false`.
export function canBuy(weaponId: number, credits: number, owned: readonly boolean[]): boolean {
  if (weaponId < 0 || weaponId >= WEAPONS.length) return false;
  const w = WEAPONS[weaponId]!;
  if (!w.buyable) return false;
  if (owned[weaponId]) return false;
  return credits >= w.cost;
}

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
// Sanitize a chat message body (issue #10): drop non-printable-ASCII, collapse runs of
// whitespace, trim, and cap at CHAT_MAX_LEN. Returns "" for an empty/blank message (the server
// drops those — there's nothing to broadcast).
export function sanitizeChat(body: string | undefined): string {
  return (body ?? "")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CHAT_MAX_LEN);
}
