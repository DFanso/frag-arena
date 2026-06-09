// worker/game-core.ts — transport-agnostic authoritative game room.
//
// This is the SINGLE SOURCE OF TRUTH for the game logic. It holds all room state in memory and
// runs the server tick (SERVER_TICK_HZ), combat validation, pickups, and the match lifecycle. It knows NOTHING
// about Cloudflare Durable Objects or the Node `ws` library — it operates only on the minimal
// `Conn` seam (send/close). Two thin adapters drive it:
//   - worker/room.ts   — the Cloudflare Durable Object (hibernation WebSocket API)
//   - server/index.ts  — the Node process (@hono/node-server + ws)
// Public entry points the adapters call: accept / routeMessage / removePlayer / isEmpty.
import {
  SERVER_TICK_MS,
  SERVER_TICK_HZ,
  MAX_PLAYERS_PER_ROOM,
  MAX_HP,
  KZ_FLOOR,
  ST_ALIVE,
  ST_PROTECTED,
  ST_DEAD,
  SPAWN_POINTS,
  IDLE_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  WEAPONS,
  RESPAWN_MS,
  SPAWN_PROTECTION_MS,
  MAX_MESSAGE_BYTES,
  RATE_LIMIT_MSGS_PER_SEC,
  MATCH_DURATION_MS,
  FRAG_LIMIT,
  STARTING_CREDITS,
  CREDITS_PER_HIT,
  CREDITS_PER_KILL,
  addCredits,
  defaultOwnedWeapons,
  canBuy,
  MAX_MOVE_SPEED,
  MOVE_SPEED_TOLERANCE,
  MOVE_BUDGET_SEC,
  GRENADE_SPEED,
  GRENADE_GRAVITY,
  GRENADE_FUSE_MS,
  GRENADE_RADIUS,
  GRENADE_DAMAGE,
  GRENADE_COOLDOWN_MS,
  AMMO_PICKUPS,
  PICKUP_RADIUS,
  PICKUP_RESPAWN_MS,
  EXPLOSIVE_BARRELS,
  BARREL_STREAK_COUNT,
  BARREL_STREAK_WINDOW_MS,
  BARREL_RADIUS,
  BARREL_DAMAGE,
  BARREL_RESPAWN_MS,
  BARREL_HIT_RADIUS,
  HEALTH_AMOUNT,
  HEALTH_PICKUPS,
  HEALTH_PICKUP_RADIUS,
  HEALTH_RESPAWN_MS,
  ARMOR_AMOUNT,
  MAX_ARMOR,
  ARMOR_PICKUPS,
  ARMOR_PICKUP_RADIUS,
  ARMOR_RESPAWN_MS,
  SPRING_PICKUPS,
  SPRING_PICKUP_RADIUS,
  SPRING_RESPAWN_MS,
  SPRING_DURATION_MS,
  GRENADE_START,
  GRENADE_MAX,
  GRENADE_PICKUPS,
  GRENADE_PICKUP_RADIUS,
  GRENADE_PICKUP_RESPAWN_MS,
  ROCKET_ID,
  ROCKET_CLIP,
  ROCKET_RESPAWN_MS,
  ROCKET_PICKUP_RADIUS,
  ROCKET_SPEED,
  ROCKET_RADIUS,
  ROCKET_DAMAGE,
  ROCKET_MAX_RANGE,
  ROCKET_TOWERS,
  CHAT_MIN_INTERVAL_MS,
  POSITION_BUFFER_MS,
  decode,
  encode,
  sanitizeName,
  sanitizeChat,
} from "./protocol";
import type {
  Conn,
  Vec3,
  Rot,
  PlayerStateCode,
  PlayerSnap,
  ServerMsg,
  WelcomeMsg,
  LeaveMsg,
  SnapMsg,
  ClientMsg,
  InMsg,
  ShootMsg,
  HitMsg,
  KillMsg,
  SpawnMsg,
  MatchStartMsg,
  MatchOverMsg,
  LobbyMsg,
  LobbyPlayer,
  ThrowMsg,
  GrenadeMsg,
  PickupMsg,
  BarrelMsg,
  RocketMsg,
  RocketFxMsg,
  WeaponPickupMsg,
  GrenadePickupMsg,
  HealthPickupMsg,
  ArmorPickupMsg,
  SpringPickupMsg,
  FallMsg,
  ChatMsg,
  BuyMsg,
  BoughtMsg,
  Weapon,
} from "./protocol";
import { validateShoot, chooseSpawn, isHeadshot, rewindTargetTime, posAtTime } from "./validate";
import type { PosSample } from "./validate";
import { matchOutcome, rankPlayers } from "./match";

interface PlayerRec {
  id: number;
  token: string; // session token (sent in welcome; reconnect with it restores id/score/in-match)
  name: string;
  ws: Conn;
  p: Vec3;
  r: Rot;
  v: Vec3;
  hp: number;
  st: PlayerStateCode;
  frags: number;
  deaths: number;
  credits: number;     // CS-style currency: earned on hits/kills, reset at match start (issue #25)
  ownedWeapons: boolean[]; // buy menu (issue #26): per-WEAPONS-id ownership; only DEFAULT_WEAPON free
  lastShotAt: number;
  lastInputAt: number;
  respawnAt: number;
  protectedUntil: number;
  lastSeq: number;
  rate: { windowStart: number; count: number };
  moveBudget?: number; // anti-teleport token bucket (units of travel available)
  ready: boolean;      // lobby: has this player clicked Ready?
  inMatch: boolean;    // is this player part of the CURRENT match (vs waiting in the lobby)?
  ammo: number[];        // rounds in the magazine, per weapon id
  reserveAmmo: number[]; // rounds in reserve, per weapon id
  reloadEndsAt: number[]; // server epoch ms a reload completes, per weapon (0 = not reloading)
  lastGrenadeAt: number; // server epoch ms of the last grenade throw (cooldown)
  lastChatAt: number;    // server epoch ms of the last chat message (per-player chat cooldown)
  grenades: number;      // grenades in hand (limited resource; refilled by pickups / on spawn)
  hasRocket: boolean;    // is the player currently holding the rocket launcher (tower pickup)?
  rocketAmmo: number;    // rockets left in the held launcher (dropped when it hits 0)
  armor: number;         // armor points (soak damage before hp; 0..MAX_ARMOR)
  c: boolean;            // crouching
  pc: boolean;           // parachute deployed (echoed for remote rendering)
  posHistory: PosSample[]; // lag-comp (issue #13): recent {ts,p} positions, oldest→newest, ~POSITION_BUFFER_MS deep
}

// A pending area-of-effect blast (grenade or rocket) awaiting detonation.
interface PendingBlast { pos: Vec3; explodeAt: number; shooterId: number; radius: number; damage: number; }

// Per-barrel rapid-hit streak: BARREL_STREAK_COUNT same-weapon hits within the window detonate it.
interface BarrelStreak { by: number; w: number; count: number; lastAt: number; }

export class GameRoomCore {
  private players = new Map<Conn, PlayerRec>();
  private byId = new Map<number, PlayerRec>();
  private nextId = 1;
  // Identity of recently-disconnected players, keyed by session token, so a reconnect within
  // RECONNECT_GRACE_MS restores their id / score / in-match state instead of joining fresh.
  private savedIdentities = new Map<string, { id: number; name: string; frags: number; deaths: number; inMatch: boolean; savedAt: number }>();
  private tick = 0;
  private tickHandle: ReturnType<typeof setInterval> | undefined;
  private matchEndsAt = 0;     // server epoch ms the current match ends (0 = no active match)
  private matchActive = false; // a match is currently running (vs lobby / ready-up phase)
  private pendingBlasts: PendingBlast[] = []; // grenades + rockets awaiting detonation
  private pickupAvail: number[] = AMMO_PICKUPS.map(() => 0); // epoch ms each ammo crate is available again
  private grenadePickupAvail: number[] = GRENADE_PICKUPS.map(() => 0); // epoch ms each grenade crate is available again
  private healthPickupAvail: number[] = HEALTH_PICKUPS.map(() => 0); // epoch ms each health syringe is available again
  private armorPickupAvail: number[] = ARMOR_PICKUPS.map(() => 0);   // epoch ms each armor pickup is available again
  private springPickupAvail: number[] = SPRING_PICKUPS.map(() => 0); // epoch ms each spring pad is available again
  private rocketTowerDownUntil: number[] = ROCKET_TOWERS.map(() => 0); // epoch ms each tower's launcher returns
  private barrelStreak: (BarrelStreak | null)[] = EXPLOSIVE_BARRELS.map(() => null); // rapid-hit streak per barrel
  private barrelDownUntil: number[] = EXPLOSIVE_BARRELS.map(() => 0);  // epoch ms each barrel respawns (0 = alive)

  // ---- public entry points (called by the CF + Node transport adapters) ----

  // Register a new connection. Returns false if the room is full (the caller should close the
  // socket); the socket is NEVER added to players/byId in that case.
  public accept(conn: Conn, rawName: string | undefined, rawToken?: string): boolean {
    if (this.players.size >= MAX_PLAYERS_PER_ROOM) return false;
    this.addPlayer(conn, sanitizeName(rawName), rawToken);
    return true;
  }

  // True when no players remain — the Node adapter drops the room from its registry (mirrors DO
  // eviction); the CF adapter relies on stopLoopIfEmpty + platform eviction.
  public isEmpty(): boolean {
    return this.players.size === 0;
  }

  // Route one inbound client message: size cap → rate limit → decode → dispatch. Synchronous.
  public routeMessage(conn: Conn, raw: string | ArrayBuffer): void {
    // App-level message-size cap (string messages only; binary is unused in v1).
    // Use UTF-8 byte length, not character count, so the cap is in bytes.
    if (typeof raw === "string" && new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) {
      conn.close(1009, "message too large");
      return;
    }

    const rec = this.players.get(conn);
    if (!rec) return;

    // Per-connection sliding 1-second rate limit. Silently drop excess.
    const now = Date.now();
    if (now - rec.rate.windowStart >= 1000) {
      rec.rate.windowStart = now;
      rec.rate.count = 0;
    }
    if (rec.rate.count >= RATE_LIMIT_MSGS_PER_SEC) {
      return; // dropped: budget for this window exhausted
    }
    rec.rate.count += 1;

    // ----- parse + route -----
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const msg = decode<ClientMsg>(text);
    if (!msg) return;
    if (msg.t === "in") {
      if (rec.inMatch) this.ingestInput(rec, msg); // lobby players send no input
      return;
    }
    if (msg.t === "shoot") {
      this.handleShoot(rec, msg); // guards on matchActive + inMatch
      return;
    }
    if (msg.t === "ready") {
      this.handleReady(rec, !!msg.ready);
      return;
    }
    if (msg.t === "reload") {
      this.handleReload(rec, msg.w);
      return;
    }
    if (msg.t === "throw") {
      this.handleThrow(rec, msg);
      return;
    }
    if (msg.t === "rocket") {
      this.handleRocket(rec, msg);
      return;
    }
    if (msg.t === "fall") {
      this.handleFall(rec, msg);
      return;
    }
    if (msg.t === "chat") {
      this.handleChat(rec, msg);
      return;
    }
    if (msg.t === "buy") {
      this.handleBuy(rec, msg);
      return;
    }
  }

  // ---- match / player lifecycle ----

  // Positions of living players other than `selfId` (combat targets to spawn away from).
  private livingEnemyPositions(selfId: number): Vec3[] {
    const out: Vec3[] = [];
    for (const p of this.byId.values()) {
      if (p.id !== selfId && p.inMatch && p.st !== ST_DEAD) out.push(p.p);
    }
    return out;
  }

  private spawn(rec: PlayerRec): void {
    const now = Date.now();
    rec.p = chooseSpawn(SPAWN_POINTS as Vec3[], this.livingEnemyPositions(rec.id), Math.random);
    rec.v = [0, 0, 0];
    rec.hp = MAX_HP;
    rec.st = ST_PROTECTED;
    rec.protectedUntil = now + SPAWN_PROTECTION_MS;
    rec.respawnAt = 0;
    rec.ammo = WEAPONS.map((w) => w.clipSize);        // full mags + reserve on (re)spawn
    rec.ammo[ROCKET_ID] = 0;                          // the launcher tracks ammo via rocketAmmo, never the magazine
    rec.reserveAmmo = WEAPONS.map((w) => w.reserveAmmo);
    rec.reloadEndsAt = WEAPONS.map(() => 0);
    rec.lastGrenadeAt = 0;
    rec.grenades = GRENADE_START;                     // a couple of grenades on (re)spawn
    rec.hasRocket = false;                            // the rocket launcher is a tower pickup — lost on death
    rec.rocketAmmo = 0;
    rec.armor = 0;                                    // armor is lost on death (grab a pickup again)
    rec.c = false;
    rec.pc = false;
    rec.posHistory = [{ ts: now, p: [rec.p[0], rec.p[1], rec.p[2]] }]; // reset lag-comp history at the spawn point
    const msg: SpawnMsg = { t: "spawn", id: rec.id, p: rec.p, prot: SPAWN_PROTECTION_MS };
    this.broadcast(msg);
  }

  private addPlayer(ws: Conn, name: string, rawToken?: string): void {
    const now = Date.now();
    this.pruneSavedIdentities(now);
    // Reconnect: a matching, still-free saved token restores the player's identity + score.
    const saved = rawToken ? this.savedIdentities.get(rawToken) : undefined;
    const rejoin = saved !== undefined && !this.byId.has(saved.id);
    const id = rejoin ? saved!.id : this.nextId++;
    const token = rejoin ? rawToken! : this.newToken();
    if (rejoin) this.savedIdentities.delete(rawToken!);
    const resumeMatch = rejoin && saved!.inMatch && this.matchActive;
    const rec: PlayerRec = {
      id,
      token,
      name,
      ws,
      p: [0, 0, 0] as Vec3, // will be set below after rec is created

      r: [0, 0],
      v: [0, 0, 0],
      hp: MAX_HP,
      st: ST_ALIVE,
      frags: rejoin ? saved!.frags : 0,
      deaths: rejoin ? saved!.deaths : 0,
      credits: STARTING_CREDITS, // reset again at startMatch; seeded here so a lobby snap is sane
      ownedWeapons: defaultOwnedWeapons(), // only the free Rifle until bought (issue #26)
      lastShotAt: 0,
      lastInputAt: now,
      respawnAt: 0,
      protectedUntil: 0,
      lastSeq: 0,
      rate: { windowStart: now, count: 0 },
      ready: false,
      inMatch: resumeMatch,
      ammo: WEAPONS.map((w) => w.clipSize),
      reserveAmmo: WEAPONS.map((w) => w.reserveAmmo),
      reloadEndsAt: WEAPONS.map(() => 0),
      lastGrenadeAt: 0,
      lastChatAt: 0,
      grenades: GRENADE_START,
      hasRocket: false,
      rocketAmmo: 0,
      armor: 0,
      c: false,
      pc: false,
      posHistory: [],
    };

    // Welcome carries the snapshots of players already IN THE MATCH (so a late joiner can
    // pre-build their remotes); lobby-only players aren't game entities yet.
    const existing: PlayerSnap[] = [];
    for (const other of this.players.values()) if (other.inMatch) existing.push(this.snapOf(other));

    this.players.set(ws, rec);
    this.byId.set(id, rec);

    // Welcome first (id + roster). New players ALWAYS land in the lobby — they do not spawn
    // and no match auto-starts; a match begins only when everyone has readied up.
    const welcome: WelcomeMsg = {
      t: "welcome",
      id,
      token,
      rejoin,
      tickRate: SERVER_TICK_HZ,
      players: existing,
      matchEndsAt: this.matchActive ? this.matchEndsAt : 0,
      fragLimit: FRAG_LIMIT,
    };
    this.send(ws, welcome);
    // Rejoining an in-progress match: spawn straight back into the fight (broadcasts a SpawnMsg).
    if (resumeMatch) this.spawn(rec);
    this.broadcastLobby();
    this.startLoop(); // keep the room resident (state in memory) while ≥1 player is connected
  }

  // A fresh session token. crypto.randomUUID is available in workerd, Node 18+, and browsers.
  private newToken(): string {
    return crypto.randomUUID();
  }

  // Drop saved identities whose reconnect grace window has elapsed.
  private pruneSavedIdentities(now: number): void {
    for (const [tok, s] of this.savedIdentities) {
      if (now - s.savedAt > RECONNECT_GRACE_MS) this.savedIdentities.delete(tok);
    }
  }

  // Toggle a player's ready state (lobby phase only) and start the match once ALL are ready.
  private handleReady(rec: PlayerRec, ready: boolean): void {
    if (this.matchActive) return; // ready only matters between matches
    rec.ready = ready;
    this.broadcastLobby();
    this.maybeStartMatch();
  }

  // Start the match iff there is ≥1 player and EVERY connected player is ready (no fallback).
  private maybeStartMatch(): void {
    if (this.matchActive || this.players.size === 0) return;
    for (const p of this.players.values()) if (!p.ready) return;
    this.startMatch();
  }

  // Begin a fresh match: bring everyone in, reset scores, spawn, set the timer, broadcast.
  private startMatch(): void {
    const now = Date.now();
    this.matchActive = true;
    this.matchEndsAt = now + MATCH_DURATION_MS;
    this.pickupAvail = AMMO_PICKUPS.map(() => 0); // all ammo crates available at match start
    this.grenadePickupAvail = GRENADE_PICKUPS.map(() => 0); // all grenade crates available
    this.healthPickupAvail = HEALTH_PICKUPS.map(() => 0);
    this.armorPickupAvail = ARMOR_PICKUPS.map(() => 0);
    this.springPickupAvail = SPRING_PICKUPS.map(() => 0);
    this.rocketTowerDownUntil = ROCKET_TOWERS.map(() => 0); // both launchers are on their towers
    this.barrelStreak = EXPLOSIVE_BARRELS.map(() => null); // restore all barrels
    this.barrelDownUntil = EXPLOSIVE_BARRELS.map(() => 0);
    for (const rec of this.players.values()) {
      rec.frags = 0;
      rec.deaths = 0;
      rec.credits = STARTING_CREDITS; // fresh economy each match (issue #25)
      rec.ownedWeapons = defaultOwnedWeapons(); // back to the free starter; rebuy each match (issue #26)
      rec.ready = false;
      rec.inMatch = true;
      rec.lastInputAt = now; // fresh idle window — they were in the lobby, not sending input
      this.spawn(rec); // resets hp/pos/protection + broadcasts a SpawnMsg
    }
    const msg: MatchStartMsg = { t: "matchstart", endsAt: this.matchEndsAt, fragLimit: FRAG_LIMIT };
    this.broadcast(msg);
    this.startLoop();
  }

  // End the current match: rank the players who played, broadcast results, and drop everyone
  // back to the lobby (ready=false). The loop keeps running while players remain (so in-memory
  // state survives between matches); stopLoopIfEmpty handles the empty case.
  private endMatch(): void {
    this.matchActive = false;
    const standings = rankPlayers(
      [...this.byId.values()].filter((r) => r.inMatch).map((r) => ({ id: r.id, name: r.name, frags: r.frags, deaths: r.deaths })),
    );
    const msg: MatchOverMsg = { t: "matchover", standings };
    this.broadcast(msg);
    for (const rec of this.players.values()) { rec.inMatch = false; rec.ready = false; }
    this.pendingBlasts = [];
    this.matchEndsAt = 0;
    this.broadcastLobby();
  }

  // Broadcast the current lobby roster (id/name/ready) + whether a match is running.
  private broadcastLobby(): void {
    const players: LobbyPlayer[] = [];
    for (const rec of this.players.values()) players.push({ id: rec.id, name: rec.name, ready: rec.ready });
    const msg: LobbyMsg = { t: "lobby", players, matchActive: this.matchActive };
    this.broadcast(msg);
  }

  // Remove a connection: drop from the maps, close the socket, broadcast a leave, and stop the
  // loop if the room emptied. Public so both transport adapters can call it on socket close.
  public removePlayer(ws: Conn): void {
    const rec = this.players.get(ws);
    if (!rec) return;
    // Preserve identity briefly so a reconnect with the same token restores id/score/in-match.
    this.savedIdentities.set(rec.token, {
      id: rec.id, name: rec.name, frags: rec.frags, deaths: rec.deaths,
      inMatch: rec.inMatch, savedAt: Date.now(),
    });
    this.players.delete(ws);
    this.byId.delete(rec.id);
    try {
      ws.close(1000, "bye");
    } catch {
      // socket may already be closed; ignore.
    }
    const leave: LeaveMsg = { t: "leave", id: rec.id };
    this.broadcast(leave);
    this.broadcastLobby();          // roster changed
    this.stopLoopIfEmpty();
    if (!this.matchActive) this.maybeStartMatch(); // a leave may leave only ready players
  }

  private ingestInput(rec: PlayerRec, m: InMsg): void {
    const now = Date.now();
    // Anti-teleport via a token bucket replenished on TRUSTED server time (NOT the
    // client-controlled m.ts). The bucket accumulates a small burst so that packets
    // bunched by network jitter aren't over-clamped (which would make the server position
    // lag and the client rubber-band), while a sustained teleport is still capped.
    const rate = MAX_MOVE_SPEED * MOVE_SPEED_TOLERANCE; // units/sec
    const cap = rate * MOVE_BUDGET_SEC;                 // max burst (units)
    const refillSec = Math.min(Math.max(now - rec.lastInputAt, 0), 1000) / 1000;
    let budget = Math.min(cap, (rec.moveBudget ?? cap) + rate * refillSec);

    const dx = m.p[0] - rec.p[0], dy = m.p[1] - rec.p[1], dz = m.p[2] - rec.p[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist === 0 || dist <= budget) {
      rec.p = [m.p[0], m.p[1], m.p[2]];
      budget -= dist;
    } else {
      const s = budget / dist; // snap toward the claim, up to the available budget
      rec.p = [rec.p[0] + dx * s, rec.p[1] + dy * s, rec.p[2] + dz * s];
      budget = 0;
    }
    rec.moveBudget = budget;
    rec.r = [m.r[0], m.r[1]];
    rec.v = [m.v[0], m.v[1], m.v[2]];
    rec.c = !!m.c;
    rec.pc = !!m.pc;
    rec.lastInputAt = now;
    rec.lastSeq = m.seq;

    // Lag compensation (issue #13): record the accepted position with the TRUSTED server time so
    // handleShoot can rewind a target to where it actually was at the shooter's perceived fire
    // moment. Drop entries older than POSITION_BUFFER_MS so the ring-buffer stays bounded.
    rec.posHistory.push({ ts: now, p: [rec.p[0], rec.p[1], rec.p[2]] });
    const cutoff = now - POSITION_BUFFER_MS;
    while (rec.posHistory.length > 0 && rec.posHistory[0]!.ts < cutoff) rec.posHistory.shift();

    // Out-of-bounds kill floor (issue #23): falling below the world is an instant suicide (no
    // frag credit), so it can't be used to silently escape a fight. The normal death + respawn
    // flow then repositions the player. Authoritative here — the client only stops the fall; it
    // no longer teleports to center.
    if (rec.p[1] < KZ_FLOOR && rec.st !== ST_DEAD) {
      if (rec.st === ST_PROTECTED) { rec.st = ST_ALIVE; rec.protectedUntil = 0; }
      rec.armor = 0; // ensure the fall is lethal regardless of armor
      this.applyDamage(rec, MAX_HP, rec, false);
    }
  }

  private handleShoot(rec: PlayerRec, m: ShootMsg): void {
    if (!rec.inMatch) return; // no combat in the lobby (inMatch ⇒ a match is active)
    // The rocket launcher must ONLY fire via handleRocket (gated on the tower pickup + AoE). A
    // crafted shoot with w=ROCKET_ID would otherwise be a free hitscan one-shot — reject it.
    if (m.w === ROCKET_ID) return;
    const now = Date.now();
    const w = m.w >= 0 && m.w < WEAPONS.length ? m.w : 0;
    // Buy menu (issue #26): only an OWNED weapon may fire. The client can't fire a gun it never
    // purchased — ownership is server-authoritative (the Rifle is free; others must be bought).
    if (!rec.ownedWeapons[w]) return;
    const weapon = WEAPONS[w]!;
    this.completeReloadIfDue(rec, w, now);
    if (rec.reloadEndsAt[w]! > now) return; // gun can't fire mid-reload
    if (rec.ammo[w]! <= 0) return;          // empty magazine (client auto-reloads)
    const rawTarget = m.hit === null ? null : (this.byId.get(m.hit) ?? null);
    const target = rawTarget && rawTarget.inMatch ? rawTarget : null; // only in-match players are valid targets

    // Firing while spawn-protected drops the protection immediately so that
    // validateShoot (which only accepts ST_ALIVE shooters) sees the right state.
    if (rec.st === ST_PROTECTED) {
      rec.st = ST_ALIVE;
      rec.protectedUntil = 0;
    }

    // Lag compensation (issue #13): rewind the target to where it was at the shooter's perceived
    // fire moment instead of its current position, so shots that looked on-target on-screen (one
    // RTT + the interpolation delay ago) are accepted. The rewind is clamped to
    // LAGCOMP_MAX_REWIND_MS, and falls back to the current position when there is no history
    // (a target that never moved this match) — neither path widens the anti-cheat envelope.
    const targetPos = target === null
      ? null
      : posAtTime(target.posHistory, rewindTargetTime(now, m.ts)) ?? target.p;

    // Combat validates against the rewound target position (current positions for the shooter).
    const reject = validateShoot(
      { p: rec.p, st: rec.st, lastShotAt: rec.lastShotAt },
      target === null ? null : { p: targetPos!, st: target.st },
      m.d,
      weapon,
      now,
    );

    // "dead" / "firerate" mean the gun did NOT discharge: leave lastShotAt untouched.
    if (reject === "dead" || reject === "firerate") return;

    // The gun fired. Record the shot time and consume a round (of the fired weapon).
    rec.lastShotAt = now;
    rec.ammo[w]! -= 1;

    // Shot an explosive barrel? (validated against the barrel, not a player.)
    if (m.barrel != null) {
      this.handleBarrelHit(rec, m, m.barrel, weapon, now);
      return;
    }

    // Fired, but the claimed hit was not valid (no/dead/protected target, range, aim).
    if (reject !== null || target === null) return;

    // Headshot is server-verified (issue #17): honor the client's `head` claim only when the
    // aim ray actually crosses the target's head zone. Uses the SAME rewound position as the
    // hit validation (issue #13) so the head zone is where the shooter saw it. A body/leg shot
    // can no longer claim 2x.
    const head = m.head && isHeadshot(rec.p, targetPos!, m.d, target.c);
    const dmg = head ? weapon.damage * weapon.headMult : weapon.damage;
    this.applyDamage(target, dmg, rec, head);
  }

  // Begin a reload of weapon `wRaw` if its magazine isn't full and reserve remains.
  private handleReload(rec: PlayerRec, wRaw: number): void {
    if (!rec.inMatch) return;
    const w = wRaw >= 0 && wRaw < WEAPONS.length ? wRaw : 0;
    const now = Date.now();
    this.completeReloadIfDue(rec, w, now);
    const weapon = WEAPONS[w]!;
    if (rec.reloadEndsAt[w]! > now || rec.ammo[w]! >= weapon.clipSize || rec.reserveAmmo[w]! <= 0) return;
    rec.reloadEndsAt[w] = now + weapon.reloadMs;
  }

  // Finish weapon `w`'s reload if its timer elapsed: move rounds from reserve into the magazine.
  private completeReloadIfDue(rec: PlayerRec, w: number, now: number): void {
    if (rec.reloadEndsAt[w]! !== 0 && now >= rec.reloadEndsAt[w]!) {
      const weapon = WEAPONS[w]!;
      const need = Math.min(weapon.clipSize - rec.ammo[w]!, rec.reserveAmmo[w]!);
      rec.ammo[w]! += need;
      rec.reserveAmmo[w]! -= need;
      rec.reloadEndsAt[w] = 0;
    }
  }

  // Throw a grenade: compute its ballistic detonation point/time server-side (no bounces; it
  // bursts on the fuse or when the arc reaches the ground), schedule the AoE, and broadcast
  // the arc so every client renders the same flying grenade + detonation.
  private handleThrow(rec: PlayerRec, m: ThrowMsg): void {
    if (!rec.inMatch) return;
    if (rec.st === ST_DEAD) return; // no throwing from beyond the grave
    if (rec.grenades <= 0) return; // out of grenades (limited resource)
    const now = Date.now();
    if (now - rec.lastGrenadeAt < GRENADE_COOLDOWN_MS) return;
    rec.lastGrenadeAt = now;
    rec.grenades -= 1;
    if (rec.st === ST_PROTECTED) { rec.st = ST_ALIVE; rec.protectedUntil = 0; }

    const dl = Math.hypot(m.d[0], m.d[1], m.d[2]) || 1;
    const v: Vec3 = [(m.d[0] / dl) * GRENADE_SPEED, (m.d[1] / dl) * GRENADE_SPEED, (m.d[2] / dl) * GRENADE_SPEED];
    const g = GRENADE_GRAVITY;
    const tGround = (v[1] + Math.sqrt(Math.max(0, v[1] * v[1] + 2 * g * m.o[1]))) / g; // sec to y=0
    const t = Math.min(GRENADE_FUSE_MS / 1000, tGround > 0 ? tGround : GRENADE_FUSE_MS / 1000);
    const pos: Vec3 = [
      m.o[0] + v[0] * t,
      Math.max(0, m.o[1] + v[1] * t - 0.5 * g * t * t),
      m.o[2] + v[2] * t,
    ];
    this.pendingBlasts.push({ pos, explodeAt: now + t * 1000, shooterId: rec.id, radius: GRENADE_RADIUS, damage: GRENADE_DAMAGE });
    const gm: GrenadeMsg = { t: "grenade", o: m.o, v, fuseMs: t * 1000 };
    this.broadcast(gm);
  }

  // Fire a rocket. The client computed the impact point against the real map geometry; we
  // validate ownership/ammo/fire-rate, clamp the impact onto the aim ray within range (the
  // blast still resolves against true server positions), time the detonation by flight
  // distance, and broadcast the arc so every client renders the same rocket + blast.
  private handleRocket(rec: PlayerRec, m: RocketMsg): void {
    if (!rec.inMatch) return;
    if (rec.st === ST_DEAD) return; // no firing from beyond the grave
    if (!rec.hasRocket || rec.rocketAmmo <= 0) return;
    const now = Date.now();
    const weapon = WEAPONS[ROCKET_ID]!;
    if (now - rec.lastShotAt < weapon.cooldownMs - 25) return; // fire-rate gate
    rec.lastShotAt = now;
    if (rec.st === ST_PROTECTED) { rec.st = ST_ALIVE; rec.protectedUntil = 0; }
    rec.rocketAmmo -= 1;
    if (rec.rocketAmmo <= 0) rec.hasRocket = false; // launcher is dropped when it runs dry

    const dl = Math.hypot(m.d[0], m.d[1], m.d[2]) || 1;
    const dir: Vec3 = [m.d[0] / dl, m.d[1] / dl, m.d[2] / dl];
    const claimed = Math.hypot(m.p[0] - m.o[0], m.p[1] - m.o[1], m.p[2] - m.o[2]);
    const dist = Math.min(claimed, ROCKET_MAX_RANGE); // respect wall impacts; clamp overlong claims
    const pos: Vec3 = [m.o[0] + dir[0] * dist, m.o[1] + dir[1] * dist, m.o[2] + dir[2] * dist];
    const travelMs = (dist / ROCKET_SPEED) * 1000;
    this.pendingBlasts.push({ pos, explodeAt: now + travelMs, shooterId: rec.id, radius: ROCKET_RADIUS, damage: ROCKET_DAMAGE });
    this.broadcast({ t: "rocketfx", o: m.o, d: dir, p: pos, travelMs } satisfies RocketFxMsg);
  }

  // AoE damage with linear falloff to everyone alive in the blast radius (grenades + barrels +
  // rockets). Tagged as a blast so the client can gib the victim on a lethal explosion.
  private detonate(pos: Vec3, shooterId: number, radius: number, damage: number): void {
    const killer = this.byId.get(shooterId);
    for (const v of this.players.values()) {
      if (!v.inMatch || v.st === ST_DEAD || v.st === ST_PROTECTED) continue;
      const dx = v.p[0] - pos[0], dy = v.p[1] - pos[1], dz = v.p[2] - pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > radius) continue;
      this.applyDamage(v, damage * (1 - dist / radius), killer ?? v, false, true);
    }
  }

  // Handle a claimed explosive-barrel hit: validate the ray, advance the rapid same-weapon hit
  // streak, and detonate once BARREL_STREAK_COUNT hits land within the window.
  private handleBarrelHit(rec: PlayerRec, m: ShootMsg, b: number, weapon: Weapon, now: number): void {
    if (b < 0 || b >= EXPLOSIVE_BARRELS.length) return;
    if (now < this.barrelDownUntil[b]!) return; // destroyed / respawning
    const bp = EXPLOSIVE_BARRELS[b]!;
    const cy = bp[1] + 1; // barrel centre ~1 unit up
    const ox = bp[0] - m.o[0], oy = cy - m.o[1], oz = bp[2] - m.o[2];
    const t = ox * m.d[0] + oy * m.d[1] + oz * m.d[2]; // project onto the (normalized) aim ray
    if (t <= 0) return; // barrel is behind the shooter
    const px = m.o[0] + m.d[0] * t, py = m.o[1] + m.d[1] * t, pz = m.o[2] + m.d[2] * t;
    if (Math.hypot(px - bp[0], py - cy, pz - bp[2]) > BARREL_HIT_RADIUS) return; // aim missed the barrel

    // Advance the streak: same shooter + same weapon within the window counts up; otherwise reset.
    const s = this.barrelStreak[b];
    if (s && s.by === rec.id && s.w === weapon.id && now - s.lastAt <= BARREL_STREAK_WINDOW_MS) {
      s.count += 1;
      s.lastAt = now;
    } else {
      this.barrelStreak[b] = { by: rec.id, w: weapon.id, count: 1, lastAt: now };
    }
    if (this.barrelStreak[b]!.count < BARREL_STREAK_COUNT) return; // not enough rapid hits yet

    this.barrelStreak[b] = null;
    this.barrelDownUntil[b] = now + BARREL_RESPAWN_MS;
    const center: Vec3 = [bp[0], cy, bp[2]];
    this.detonate(center, rec.id, BARREL_RADIUS, BARREL_DAMAGE);
    this.broadcast({ t: "barrel", id: b, pos: center, respawnAt: this.barrelDownUntil[b]! } satisfies BarrelMsg);
  }

  // Self-inflicted fall damage claimed by the client on a hard landing. Clamp it and apply it
  // to the sender (only while ST_ALIVE — spawn protection / dead take none).
  private handleFall(rec: PlayerRec, m: FallMsg): void {
    if (!rec.inMatch || rec.st !== ST_ALIVE) return;
    const dmg = Math.max(0, Math.min(MAX_HP, Math.floor(m.dmg)));
    if (dmg <= 0) return;
    this.applyDamage(rec, dmg, rec, false, false); // killer === target → a suicide, no frag credit
  }

  // Text chat (issue #10). Sanitize the body, enforce a per-player cooldown (≤2 msgs/sec on top
  // of the connection-wide rate limit), and re-broadcast with the SERVER's authoritative id/name
  // (never the client's claimed `from`/`name`) so a client can't impersonate another player.
  // Works in the lobby AND in-match — chat doesn't depend on being a game entity.
  private handleChat(rec: PlayerRec, m: ChatMsg): void {
    const body = sanitizeChat(m.body);
    if (!body) return; // empty / whitespace-only after sanitizing — nothing to say
    const now = Date.now();
    if (now - rec.lastChatAt < CHAT_MIN_INTERVAL_MS) return; // too fast (chat flood guard)
    rec.lastChatAt = now;
    this.broadcast({ t: "chat", from: rec.id, name: rec.name, body } satisfies ChatMsg);
  }

  // Buy menu (issue #26): purchase + equip a weapon. Server-authoritative end of the CS-style
  // economy — validates the buy (match active + sender in-match + weapon buyable + affordable +
  // not already owned via the shared `canBuy`), deducts the cost, grants ownership, and replies
  // with a `bought` so the client equips it and refreshes its balance. An invalid request is
  // silently dropped (no reply). Buying is allowed any time during a live match (the menu opens
  // mid-fight); the new gun then passes the handleShoot ownership gate.
  private handleBuy(rec: PlayerRec, m: BuyMsg): void {
    if (!this.matchActive || !rec.inMatch) return; // nothing to buy in the lobby
    const id = m.weaponId;
    if (!canBuy(id, rec.credits, rec.ownedWeapons)) return; // unknown / non-buyable / owned / too poor
    rec.credits = addCredits(rec.credits, -WEAPONS[id]!.cost); // deduct (clamps ≥ 0)
    rec.ownedWeapons[id] = true;
    this.send(rec.ws, { t: "bought", weaponId: id, credits: rec.credits } satisfies BoughtMsg);
  }

  // Apply damage (armor soaks first), broadcast a hit, and handle death/respawn/scoring.
  private applyDamage(target: PlayerRec, dmg: number, killer: PlayerRec, head: boolean, blast = false): void {
    if (target.st === ST_DEAD || target.st === ST_PROTECTED) return;
    // Armor absorbs damage before health.
    let toHp = dmg;
    if (target.armor > 0) {
      const soak = Math.min(target.armor, toHp);
      target.armor -= soak;
      toHp -= soak;
    }
    target.hp -= toHp;
    const hit: HitMsg = {
      t: "hit",
      by: killer.id,
      on: target.id,
      dmg,
      hp: Math.max(0, target.hp),
      head,
    };
    this.broadcast(hit);

    // Credits economy (issue #25): reward the shooter for landing a confirmed hit. Self-inflicted
    // damage (own grenade / fall / kill floor — killer === target) earns nothing; there are no
    // teams, so every cross-player hit is hostile. Snapshots carry the new balance to the HUD.
    if (killer.id !== target.id) killer.credits = addCredits(killer.credits, CREDITS_PER_HIT);

    if (target.hp <= 0) {
      target.hp = 0;
      target.st = ST_DEAD;
      target.deaths += 1;
      target.respawnAt = Date.now() + RESPAWN_MS;
      // Drop held consumables at the moment of death (not only at respawn) so a corpse can't
      // keep firing during the respawn window even if a stale client message arrives.
      target.hasRocket = false;
      target.rocketAmmo = 0;
      target.grenades = 0;
      target.armor = 0;
      if (killer.id !== target.id) {
        killer.frags += 1; // no frag credit for a self-kill (e.g. own grenade / fall)
        killer.credits = addCredits(killer.credits, CREDITS_PER_KILL); // kill bonus on top of the hit
      }
      const kill: KillMsg = { t: "kill", by: killer.id, on: target.id, w: 0, blast };
      this.broadcast(kill);
    }
  }

  // ---- tick loop ----

  private startLoop(): void {
    if (this.tickHandle !== undefined) return;
    if (this.players.size === 0) return;
    // On Cloudflare the tick MUST be setInterval, never ctx.storage alarms (alarms bill as
    // requests and would blow the free-tier budget; setInterval runs inside billed duration).
    // On Node setInterval is simply the game clock. Same code path for both.
    this.tickHandle = setInterval(() => this.loopTick(), SERVER_TICK_MS);
  }

  private stopLoopIfEmpty(): void {
    if (this.players.size === 0 && this.tickHandle !== undefined) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
  }

  private loopTick(): void {
    const now = Date.now();

    // 1) Advance respawn / spawn-protection timers for IN-MATCH players.
    for (const rec of this.players.values()) {
      if (!rec.inMatch) continue;
      for (let w = 0; w < WEAPONS.length; w++) this.completeReloadIfDue(rec, w, now);
      if (rec.st === ST_DEAD && rec.respawnAt !== 0 && now >= rec.respawnAt) {
        this.spawn(rec);
      } else if (rec.st === ST_PROTECTED && now > rec.protectedUntil) {
        rec.st = ST_ALIVE;
      }
    }

    // 2) Drop IN-MATCH players who stopped sending input (AFK). Lobby players send no input,
    //    so they are never idle-dropped. Iterate a SNAPSHOT (removePlayer mutates the maps).
    for (const rec of [...this.players.values()]) {
      if (rec.inMatch && now - rec.lastInputAt > IDLE_TIMEOUT_MS) {
        this.removePlayer(rec.ws);
      }
    }
    if (this.players.size === 0) return;

    // Lobby phase: the loop just keeps the room resident (state in memory). No snaps.
    if (!this.matchActive) return;

    // If everyone in the match has left, end it so lobby players can start a new one.
    let anyInMatch = false;
    for (const rec of this.players.values()) if (rec.inMatch) { anyInMatch = true; break; }
    if (!anyInMatch) { this.endMatch(); return; }

    // Detonate grenades + rockets whose fuse / flight time has elapsed (AoE damage).
    if (this.pendingBlasts.length) {
      const remaining: PendingBlast[] = [];
      for (const b of this.pendingBlasts) {
        if (now >= b.explodeAt) this.detonate(b.pos, b.shooterId, b.radius, b.damage);
        else remaining.push(b);
      }
      this.pendingBlasts = remaining;
    }

    // Ammo pickups: refill reserve when a player walks over an available crate.
    for (let i = 0; i < AMMO_PICKUPS.length; i++) {
      if (now < this.pickupAvail[i]!) continue;
      const c = AMMO_PICKUPS[i]!;
      for (const rec of this.players.values()) {
        if (!rec.inMatch || rec.st === ST_DEAD) continue;
        const dx = rec.p[0] - c[0], dz = rec.p[2] - c[2];
        if (dx * dx + dz * dz > PICKUP_RADIUS * PICKUP_RADIUS) continue;
        let needed = false;
        for (let w = 0; w < WEAPONS.length; w++) if (rec.reserveAmmo[w]! < WEAPONS[w]!.reserveAmmo) { needed = true; break; }
        if (!needed) continue; // don't waste the crate when already topped up
        for (let w = 0; w < WEAPONS.length; w++) rec.reserveAmmo[w] = WEAPONS[w]!.reserveAmmo;
        this.pickupAvail[i] = now + PICKUP_RESPAWN_MS;
        this.broadcast({ t: "pickup", id: i, by: rec.id, availableAt: this.pickupAvail[i]! } satisfies PickupMsg);
        break; // one taker per crate per tick
      }
    }

    // Grenade pickups: top a player up to GRENADE_MAX when they walk over an available crate.
    for (let i = 0; i < GRENADE_PICKUPS.length; i++) {
      if (now < this.grenadePickupAvail[i]!) continue;
      const c = GRENADE_PICKUPS[i]!;
      for (const rec of this.players.values()) {
        if (!rec.inMatch || rec.st === ST_DEAD) continue;
        if (rec.grenades >= GRENADE_MAX) continue; // already topped up
        const dx = rec.p[0] - c[0], dz = rec.p[2] - c[2];
        if (dx * dx + dz * dz > GRENADE_PICKUP_RADIUS * GRENADE_PICKUP_RADIUS) continue;
        rec.grenades = GRENADE_MAX;
        this.grenadePickupAvail[i] = now + GRENADE_PICKUP_RESPAWN_MS;
        this.broadcast({ t: "gpickup", id: i, by: rec.id, availableAt: this.grenadePickupAvail[i]! } satisfies GrenadePickupMsg);
        break; // one taker per crate per tick
      }
    }

    // Health syringes: heal a hurt player to full when they walk over an available one.
    for (let i = 0; i < HEALTH_PICKUPS.length; i++) {
      if (now < this.healthPickupAvail[i]!) continue;
      const c = HEALTH_PICKUPS[i]!;
      for (const rec of this.players.values()) {
        if (!rec.inMatch || rec.st === ST_DEAD || rec.hp >= MAX_HP) continue;
        const dx = rec.p[0] - c[0], dz = rec.p[2] - c[2];
        if (dx * dx + dz * dz > HEALTH_PICKUP_RADIUS * HEALTH_PICKUP_RADIUS) continue;
        rec.hp = HEALTH_AMOUNT;
        this.healthPickupAvail[i] = now + HEALTH_RESPAWN_MS;
        this.broadcast({ t: "hpickup", id: i, by: rec.id, availableAt: this.healthPickupAvail[i]! } satisfies HealthPickupMsg);
        break;
      }
    }

    // Armor: grant ARMOR_AMOUNT to a player who isn't already topped up.
    for (let i = 0; i < ARMOR_PICKUPS.length; i++) {
      if (now < this.armorPickupAvail[i]!) continue;
      const c = ARMOR_PICKUPS[i]!;
      for (const rec of this.players.values()) {
        if (!rec.inMatch || rec.st === ST_DEAD || rec.armor >= MAX_ARMOR) continue;
        const dx = rec.p[0] - c[0], dz = rec.p[2] - c[2];
        if (dx * dx + dz * dz > ARMOR_PICKUP_RADIUS * ARMOR_PICKUP_RADIUS) continue;
        rec.armor = ARMOR_AMOUNT;
        this.armorPickupAvail[i] = now + ARMOR_RESPAWN_MS;
        this.broadcast({ t: "apickup", id: i, by: rec.id, availableAt: this.armorPickupAvail[i]! } satisfies ArmorPickupMsg);
        break;
      }
    }

    // Spring boots: grant a timed super-jump (jump is client-side; the server just manages the
    // pickup + its respawn, and tells the taker the duration). Any living player can grab one.
    for (let i = 0; i < SPRING_PICKUPS.length; i++) {
      if (now < this.springPickupAvail[i]!) continue;
      const c = SPRING_PICKUPS[i]!;
      for (const rec of this.players.values()) {
        if (!rec.inMatch || rec.st === ST_DEAD) continue;
        const dx = rec.p[0] - c[0], dz = rec.p[2] - c[2];
        if (dx * dx + dz * dz > SPRING_PICKUP_RADIUS * SPRING_PICKUP_RADIUS) continue;
        this.springPickupAvail[i] = now + SPRING_RESPAWN_MS;
        this.broadcast({ t: "sppickup", id: i, by: rec.id, availableAt: this.springPickupAvail[i]!, durationMs: SPRING_DURATION_MS } satisfies SpringPickupMsg);
        break;
      }
    }

    // Rocket launcher tower pickups: a living player who climbs onto either non-center tower top
    // (and isn't already holding the launcher) claims it for ROCKET_CLIP rockets; it returns later.
    for (let ti = 0; ti < ROCKET_TOWERS.length; ti++) {
      if (now < this.rocketTowerDownUntil[ti]!) continue;
      const [tx, ty, tz] = ROCKET_TOWERS[ti]!;
      for (const rec of this.players.values()) {
        if (!rec.inMatch || rec.st === ST_DEAD || rec.hasRocket) continue;
        if (rec.p[1] < ty - 2) continue; // must be up on the tower, not standing under it
        const dx = rec.p[0] - tx, dz = rec.p[2] - tz;
        if (dx * dx + dz * dz > ROCKET_PICKUP_RADIUS * ROCKET_PICKUP_RADIUS) continue;
        rec.hasRocket = true;
        rec.rocketAmmo = ROCKET_CLIP;
        this.rocketTowerDownUntil[ti] = now + ROCKET_RESPAWN_MS;
        this.broadcast({ t: "weaponpickup", id: ti, by: rec.id, availableAt: this.rocketTowerDownUntil[ti]! } satisfies WeaponPickupMsg);
        break; // one taker per tower per tick
      }
    }

    // Respawn destroyed barrels (client re-shows them via its own timer).
    for (let b = 0; b < EXPLOSIVE_BARRELS.length; b++) {
      if (this.barrelDownUntil[b]! !== 0 && now >= this.barrelDownUntil[b]!) {
        this.barrelStreak[b] = null;
        this.barrelDownUntil[b] = 0;
      }
    }

    // 2.5) Match end check (time expired or someone reached the frag limit).
    let maxFrags = 0;
    for (const rec of this.players.values()) if (rec.inMatch && rec.frags > maxFrags) maxFrags = rec.frags;
    if (matchOutcome(now, this.matchEndsAt, maxFrags, FRAG_LIMIT)) {
      this.endMatch();
      return;
    }

    // 3) Build + broadcast a SnapMsg of the IN-MATCH players only.
    this.tick++;
    const ack: Record<number, number> = {};
    const snaps: PlayerSnap[] = [];
    for (const rec of this.players.values()) {
      if (!rec.inMatch) continue;
      ack[rec.id] = rec.lastSeq;
      snaps.push(this.snapOf(rec));
    }
    const snap: SnapMsg = {
      t: "snap",
      tick: this.tick,
      ts: now,
      ack,
      players: snaps,
    };
    this.broadcast(snap);
  }

  // ---- helpers ----

  private snapOf(rec: PlayerRec): PlayerSnap {
    return {
      id: rec.id,
      name: rec.name,
      p: rec.p,
      r: rec.r,
      v: rec.v,
      hp: rec.hp,
      st: rec.st,
      frags: rec.frags,
      deaths: rec.deaths,
      c: rec.c,
      g: rec.grenades,
      a: rec.armor,
      pc: rec.pc,
      credits: rec.credits,
    };
  }

  // Send to every connected player. Iterates the player map (NOT a platform socket registry),
  // so it works identically on Cloudflare and Node. The room-full socket is never added, and
  // removePlayer deletes before broadcasting a leave, so this is exactly the live set.
  private broadcast(msg: ServerMsg): void {
    const raw = encode(msg);
    for (const conn of this.players.keys()) {
      try {
        conn.send(raw);
      } catch {
        // socket may be closing; ignore.
      }
    }
  }

  private send(ws: Conn, msg: ServerMsg): void {
    try {
      ws.send(encode(msg));
    } catch {
      // ignore send on a closing socket.
    }
  }
}
