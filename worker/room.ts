// worker/room.ts — authoritative game-room Durable Object.
import { DurableObject } from "cloudflare:workers";
import {
  SERVER_TICK_MS,
  SERVER_TICK_HZ,
  MAX_PLAYERS_PER_ROOM,
  MAX_HP,
  ST_ALIVE,
  ST_PROTECTED,
  ST_DEAD,
  SPAWN_POINTS,
  IDLE_TIMEOUT_MS,
  WEAPONS,
  RESPAWN_MS,
  SPAWN_PROTECTION_MS,
  encode,
  decode,
  sanitizeName,
} from "./protocol";
import type {
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
} from "./protocol";
import { clampMove, validateShoot } from "./validate";
import type { Env } from "./index";

interface PlayerRec {
  id: number;
  name: string;
  ws: WebSocket;
  p: Vec3;
  r: Rot;
  v: Vec3;
  hp: number;
  st: PlayerStateCode;
  frags: number;
  deaths: number;
  lastShotAt: number;
  lastInputAt: number;
  respawnAt: number;
  protectedUntil: number;
  lastSeq: number;
  rate: { windowStart: number; count: number };
}

export class GameRoom extends DurableObject<Env> {
  private players = new Map<WebSocket, PlayerRec>();
  private byId = new Map<number, PlayerRec>();
  private nextId = 1;
  private tick = 0;
  private tickHandle: ReturnType<typeof setInterval> | undefined;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (this.players.size >= MAX_PLAYERS_PER_ROOM) {
      // Accept then immediately close so the client sees a clean 1013.
      // The socket is NEVER added to players/byId.
      this.ctx.acceptWebSocket(server);
      server.close(1013, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Nickname travels in the WS URL query (?name=...). Sanitize before use.
    const name = sanitizeName(
      new URL(req.url).searchParams.get("name") ?? undefined,
    );

    // Hibernation API: do NOT call server.accept(). Auto-respond to pings for free.
    this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    this.addPlayer(server, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Single spawn helper used by BOTH addPlayer (initial) and spawn (respawn).
  private pickSpawn(id: number): Vec3 {
    return SPAWN_POINTS[(id - 1) % SPAWN_POINTS.length]!;
  }

  private spawn(rec: PlayerRec): void {
    const now = Date.now();
    rec.p = this.pickSpawn(rec.id);
    rec.v = [0, 0, 0];
    rec.hp = MAX_HP;
    rec.st = ST_PROTECTED;
    rec.protectedUntil = now + SPAWN_PROTECTION_MS;
    rec.respawnAt = 0;
    const msg: SpawnMsg = { t: "spawn", id: rec.id, p: rec.p, prot: SPAWN_PROTECTION_MS };
    this.broadcast(msg);
  }

  private addPlayer(ws: WebSocket, name: string): void {
    const id = this.nextId++;
    const spawn = this.pickSpawn(id);
    const now = Date.now();
    const rec: PlayerRec = {
      id,
      name,
      ws,
      p: [spawn[0], spawn[1], spawn[2]],
      r: [0, 0],
      v: [0, 0, 0],
      hp: MAX_HP,
      st: ST_ALIVE,
      frags: 0,
      deaths: 0,
      lastShotAt: 0,
      lastInputAt: now,
      respawnAt: 0,
      protectedUntil: 0,
      lastSeq: 0,
      rate: { windowStart: now, count: 0 },
    };

    // Welcome carries the snapshots of players already in the room.
    const existing: PlayerSnap[] = [];
    for (const other of this.players.values()) existing.push(this.snapOf(other));

    this.players.set(ws, rec);
    this.byId.set(id, rec);

    const welcome: WelcomeMsg = {
      t: "welcome",
      id,
      tickRate: SERVER_TICK_HZ,
      players: existing,
    };
    this.send(ws, welcome);

    this.startLoop();
  }

  private removePlayer(ws: WebSocket): void {
    const rec = this.players.get(ws);
    if (!rec) return;
    this.players.delete(ws);
    this.byId.delete(rec.id);
    try {
      ws.close(1000, "bye");
    } catch {
      // socket may already be closed; ignore.
    }
    const leave: LeaveMsg = { t: "leave", id: rec.id };
    this.broadcast(leave);
    this.stopLoopIfEmpty();
  }

  webSocketClose(ws: WebSocket): void {
    this.removePlayer(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.removePlayer(ws);
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    const rec = this.players.get(ws);
    if (!rec) return;
    // (Size cap + rate limit are added in T8, ahead of decode.)
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const msg = decode<ClientMsg>(text);
    if (!msg) return;
    if (msg.t === "in") {
      this.ingestInput(rec, msg);
      return;
    }
    if (msg.t === "shoot") {
      this.handleShoot(rec, msg);
      return;
    }
  }

  private ingestInput(rec: PlayerRec, m: InMsg): void {
    const now = Date.now();
    // Anti-teleport uses TRUSTED server dt (not the client-controlled m.ts).
    const dtMs = rec.lastInputAt
      ? Math.min(Math.max(now - rec.lastInputAt, 1), 250)
      : 50;
    rec.p = clampMove(rec.p, m.p, dtMs);
    rec.r = [m.r[0], m.r[1]];
    rec.v = [m.v[0], m.v[1], m.v[2]];
    rec.lastInputAt = now;
    rec.lastSeq = m.seq;
  }

  private handleShoot(rec: PlayerRec, m: ShootMsg): void {
    const now = Date.now();
    const weapon = WEAPONS[m.w] ?? WEAPONS[0]!;
    const target = m.hit === null ? null : (this.byId.get(m.hit) ?? null);

    // Firing while spawn-protected drops the protection immediately so that
    // validateShoot (which only accepts ST_ALIVE shooters) sees the right state.
    if (rec.st === ST_PROTECTED) {
      rec.st = ST_ALIVE;
      rec.protectedUntil = 0;
    }

    // Combat validates against CURRENT server-authoritative positions (no lag-comp
    // rewind in v1, per contract D4).
    const reject = validateShoot(
      { p: rec.p, st: rec.st, lastShotAt: rec.lastShotAt },
      target === null ? null : { p: target.p, st: target.st },
      m.d,
      weapon,
      now,
    );

    // "dead" / "firerate" mean the gun did NOT discharge: leave lastShotAt untouched.
    if (reject === "dead" || reject === "firerate") return;

    // The gun fired. Record the shot time.
    rec.lastShotAt = now;

    // Fired, but the claimed hit was not valid (no/dead/protected target, range, aim).
    if (reject !== null || target === null) return;

    const dmg = m.head ? weapon.damage * weapon.headMult : weapon.damage;
    this.applyDamage(target, dmg, rec, m.head);
  }

  // Apply damage, broadcast a hit, and handle death/respawn/scoring (T7).
  private applyDamage(target: PlayerRec, dmg: number, killer: PlayerRec, head: boolean): void {
    if (target.st === ST_DEAD || target.st === ST_PROTECTED) return;
    target.hp -= dmg;
    const hit: HitMsg = {
      t: "hit",
      by: killer.id,
      on: target.id,
      dmg,
      hp: Math.max(0, target.hp),
      head,
    };
    this.broadcast(hit);

    if (target.hp <= 0) {
      target.hp = 0;
      target.st = ST_DEAD;
      target.deaths += 1;
      target.respawnAt = Date.now() + RESPAWN_MS;
      killer.frags += 1;
      const kill: KillMsg = { t: "kill", by: killer.id, on: target.id, w: 0 };
      this.broadcast(kill);
    }
  }

  // --- tick loop (filled in by T5; defined here so add/remove can call it) ---

  private startLoop(): void {
    if (this.tickHandle !== undefined) return;
    if (this.players.size === 0) return;
    // NEVER use ctx.storage alarms for the tick: alarm invocations bill as
    // requests (1 each), which would blow the free-tier request budget. setInterval
    // runs inside the DO's active duration (GB-s only), so it is free.
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

    // 1) Advance respawn / spawn-protection timers (T7).
    for (const rec of this.players.values()) {
      if (rec.st === ST_DEAD && rec.respawnAt !== 0 && now >= rec.respawnAt) {
        this.spawn(rec);
      } else if (rec.st === ST_PROTECTED && now > rec.protectedUntil) {
        rec.st = ST_ALIVE;
      }
    }

    // 2) Drop idle players via removePlayer (broadcasts LeaveMsg + stopLoopIfEmpty).
    //    Iterate a SNAPSHOT so removePlayer can mutate the maps during iteration.
    for (const rec of [...this.players.values()]) {
      if (now - rec.lastInputAt > IDLE_TIMEOUT_MS) {
        this.removePlayer(rec.ws);
      }
    }
    if (this.players.size === 0) return;

    // 3) Build + broadcast a SnapMsg.
    this.tick++;
    const ack: Record<number, number> = {};
    const snaps: PlayerSnap[] = [];
    for (const rec of this.players.values()) {
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

  // --- helpers ---

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
    };
  }

  private broadcast(msg: ServerMsg): void {
    const raw = encode(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(raw);
      } catch {
        // socket may be closing; ignore.
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(encode(msg));
    } catch {
      // ignore send on a closing socket.
    }
  }
}
