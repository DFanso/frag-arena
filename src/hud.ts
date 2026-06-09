// src/hud.ts — HUD overlay: crosshair, health bar, prompt, scoreboard, kill feed, hit marker.
import { MAX_HP, MAX_ARMOR, SPRING_DURATION_MS, ST_DEAD } from "../worker/protocol";
import type { PlayerSnap, KillMsg, Standing, Vec3 } from "../worker/protocol";
import { countdownText, deathMessage } from "./death-ui";
import { formatClock } from "./match-ui";
import { playerColor } from "./colors";

export const KILL_FEED_TTL_MS = 5000;

export interface KillFeedEntry {
  at: number; // ms epoch when the kill happened
  text: string;
}

/**
 * Pure: return a NEW array sorted for scoreboard display.
 * Order: frags desc, then deaths asc, then id asc (deterministic tie-break).
 */
export function sortScoreboard(players: PlayerSnap[]): PlayerSnap[] {
  return players.slice().sort((a, b) => {
    if (b.frags !== a.frags) return b.frags - a.frags;
    if (a.deaths !== b.deaths) return a.deaths - b.deaths;
    return a.id - b.id;
  });
}

/**
 * Pure: return a NEW array containing only entries younger than KILL_FEED_TTL_MS.
 * An entry expires when (now - at) >= KILL_FEED_TTL_MS.
 */
export function pruneKillFeed(entries: KillFeedEntry[], now: number): KillFeedEntry[] {
  return entries.filter((e) => now - e.at < KILL_FEED_TTL_MS);
}

/**
 * Pure: screen-relative bearing (degrees) from the local player to a world point,
 * given the camera yaw (radians, three.js YXZ Euler `y`). Clockwise-positive to match
 * CSS `rotate()`: 0 = dead ahead (top of screen), +90 = right, ±180 = behind (bottom),
 * -90 = left. The vertical (y) axis is ignored — this is a horizontal compass bearing.
 *
 * Camera at yaw θ looks along forward (-sinθ, -cosθ) in the XZ plane with screen-right
 * (cosθ, -sinθ). Projecting the attacker delta onto those axes and taking atan2 gives the
 * bearing in the player's view frame, so it stays correct however the camera is turned.
 */
export function damageDirectionAngle(self: Vec3, attacker: Vec3, yaw: number): number {
  const dx = attacker[0] - self[0];
  const dz = attacker[2] - self[2];
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const fwd = dx * -sin + dz * -cos;  // component along camera forward
  const right = dx * cos + dz * -sin; // component along camera right
  return (Math.atan2(right, fwd) * 180) / Math.PI;
}

export type MinimapMode = "north" | "rotate";
export interface MinimapView {
  mode: MinimapMode; // "north" = arena fixed (player dot moves); "rotate" = player-centred, forward up
  self: Vec3;        // local player world position (used in rotate mode + as the dot origin)
  yaw: number;       // camera yaw (radians) — forward maps to "up" in rotate mode
  half: number;      // arena half-extent in world units (ARENA_HALF)
  size: number;      // minimap canvas size in pixels
}

/**
 * Pure: map a world (x,z) point to minimap canvas pixels (origin top-left, +x right, +y down).
 * Scale maps the arena half-extent onto half the canvas. Points beyond the canvas radius are
 * clamped onto the circular edge (`clamped=true`) so off-map players still show a bearing.
 *
 * - north  : fixed orientation about the arena origin (0,0); ignores self/yaw.
 * - rotate : centred on the player with their facing pointing up; enemies orbit as you turn.
 */
export function minimapPoint(wx: number, wz: number, view: MinimapView): { x: number; y: number; clamped: boolean } {
  const center = view.size / 2;
  const scale = center / view.half;
  let ox: number;
  let oy: number;
  if (view.mode === "north") {
    ox = wx * scale;
    oy = wz * scale;
  } else {
    const dx = wx - view.self[0];
    const dz = wz - view.self[2];
    const sin = Math.sin(view.yaw);
    const cos = Math.cos(view.yaw);
    const right = dx * cos - dz * sin;   // camera-right component
    const fwd = -dx * sin - dz * cos;    // camera-forward component
    ox = right * scale;
    oy = -fwd * scale;                   // forward → up (negative y)
  }
  const r = Math.hypot(ox, oy);
  let clamped = false;
  if (r > center && r > 0) {
    const f = center / r;
    ox *= f;
    oy *= f;
    clamped = true;
  }
  return { x: center + ox, y: center + oy, clamped };
}

export class Hud {
  private root: HTMLDivElement;
  private healthFill: HTMLDivElement;
  private healthText: HTMLSpanElement;
  private armorWrap!: HTMLDivElement;
  private armorFill!: HTMLDivElement;
  private springEl!: HTMLDivElement;
  private springFill!: HTMLDivElement;
  private springLabel!: HTMLSpanElement;
  private hintEl!: HTMLDivElement;
  private damageVignette!: HTMLDivElement;
  private dmgTimer: ReturnType<typeof setTimeout> | undefined;
  private damageArc!: HTMLDivElement;
  private dirTimer: ReturnType<typeof setTimeout> | undefined;
  private ammoEl: HTMLDivElement;
  private weaponEl: HTMLDivElement;
  private grenadeEl: HTMLDivElement;
  private rocketBannerEl: HTMLDivElement;
  private rocketBannerTimer: ReturnType<typeof setTimeout> | undefined;
  private scopeEl: HTMLDivElement;
  private prompt: HTMLDivElement;
  private hitMarker: HTMLDivElement;
  private scoreboard: HTMLDivElement;
  private killFeedEl: HTMLDivElement;
  private feed: KillFeedEntry[] = [];
  private scoreboardVisible = false;
  private latestPlayers: PlayerSnap[] = [];
  private myId = -1;
  private hitMarkerTimer: ReturnType<typeof setTimeout> | undefined;
  private deathEl!: HTMLDivElement;
  private deathTitle!: HTMLDivElement;
  private deathCount!: HTMLDivElement;
  private matchTimerEl!: HTMLDivElement;
  private resultsEl!: HTMLDivElement;
  private minimapWrap!: HTMLDivElement;
  private minimapCanvas!: HTMLCanvasElement;
  private minimapCtx!: CanvasRenderingContext2D | null;
  private minimapVisible = true;
  private minimapMode: MinimapMode = "north";

  constructor(parent: HTMLElement = document.body) {
    const root = document.createElement("div");
    root.id = "hud-overlay";
    root.style.cssText =
      "position:fixed;inset:0;pointer-events:none;font-family:monospace;z-index:10;";

    // Crosshair (center cross).
    const cross = document.createElement("div");
    cross.style.cssText =
      "position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;";
    cross.innerHTML =
      '<div style="position:absolute;left:8px;top:0;width:2px;height:18px;background:#fff;opacity:.7"></div>' +
      '<div style="position:absolute;top:8px;left:0;height:2px;width:18px;background:#fff;opacity:.7"></div>';
    root.appendChild(cross);

    // Hit marker (hidden until flashed).
    const hit = document.createElement("div");
    hit.style.cssText =
      "position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;" +
      "opacity:0;transition:opacity .05s;";
    hit.innerHTML =
      '<div style="position:absolute;left:0;top:0;width:8px;height:2px;background:#f33;transform:rotate(45deg);transform-origin:left"></div>' +
      '<div style="position:absolute;right:0;top:0;width:8px;height:2px;background:#f33;transform:rotate(-45deg);transform-origin:right"></div>' +
      '<div style="position:absolute;left:0;bottom:0;width:8px;height:2px;background:#f33;transform:rotate(-45deg);transform-origin:left"></div>' +
      '<div style="position:absolute;right:0;bottom:0;width:8px;height:2px;background:#f33;transform:rotate(45deg);transform-origin:right"></div>';
    root.appendChild(hit);
    this.hitMarker = hit;

    // Health bar (bottom-left).
    const healthWrap = document.createElement("div");
    healthWrap.style.cssText =
      "position:absolute;left:18px;bottom:18px;width:240px;height:22px;" +
      "background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.25);";
    const fill = document.createElement("div");
    fill.style.cssText = "height:100%;width:100%;background:#3c9;transition:width .1s;";
    const text = document.createElement("span");
    text.style.cssText =
      "position:absolute;left:8px;top:2px;color:#fff;font-size:14px;text-shadow:0 1px 2px #000;";
    text.textContent = `${MAX_HP} / ${MAX_HP}`;
    healthWrap.appendChild(fill);
    healthWrap.appendChild(text);
    root.appendChild(healthWrap);
    this.healthFill = fill;
    this.healthText = text;

    // Armor bar (thin blue bar just above the health bar; hidden at 0 armor).
    const armorWrap = document.createElement("div");
    armorWrap.style.cssText =
      "position:absolute;left:18px;bottom:44px;width:240px;height:10px;display:none;" +
      "background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.2);";
    const armorFill = document.createElement("div");
    armorFill.style.cssText = "height:100%;width:0%;background:#2e72d2;transition:width .1s;";
    armorWrap.appendChild(armorFill);
    root.appendChild(armorWrap);
    this.armorWrap = armorWrap;
    this.armorFill = armorFill;

    // Spring-boots meter (a draining bar that appears while the boots are active).
    const spring = document.createElement("div");
    spring.style.cssText =
      "position:absolute;left:18px;bottom:84px;width:170px;height:16px;display:none;" +
      "background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.2);border-radius:3px;overflow:hidden;";
    const springFill = document.createElement("div");
    springFill.style.cssText = "position:absolute;inset:0;width:100%;background:linear-gradient(90deg,#1f9d55,#7CFC9A);transition:width .1s;";
    const springLabel = document.createElement("span");
    springLabel.style.cssText = "position:absolute;left:6px;top:1px;color:#062;font:700 12px monospace;";
    spring.appendChild(springFill);
    spring.appendChild(springLabel);
    root.appendChild(spring);
    this.springEl = spring;
    this.springFill = springFill;
    this.springLabel = springLabel;

    // Contextual hint (parachute / zipline prompts), bottom-center.
    const hint = document.createElement("div");
    hint.style.cssText =
      "position:absolute;left:50%;bottom:120px;transform:translateX(-50%);color:#fff;" +
      "font:700 16px monospace;text-shadow:0 2px 4px #000;background:rgba(0,0,0,.4);" +
      "padding:4px 12px;border-radius:5px;display:none;";
    root.appendChild(hint);
    this.hintEl = hint;

    // Damage vignette (red screen edges flashed on taking a hit).
    const vign = document.createElement("div");
    vign.style.cssText =
      "position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .25s;" +
      "box-shadow:inset 0 0 140px 42px rgba(170,0,0,.85);z-index:23;";
    root.appendChild(vign);
    this.damageVignette = vign;

    // Damage-direction indicator: a full-screen container rotated about its center so its
    // red edge-arc (pinned to the top) points toward whoever last hit the local player.
    // 0° = ahead, 180° = behind, ±90° = right/left (see flashDamageDirection / damageDirectionAngle).
    const dir = document.createElement("div");
    dir.style.cssText =
      "position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .5s;z-index:24;";
    const arc = document.createElement("div");
    arc.style.cssText =
      "position:absolute;left:50%;top:0;width:340px;height:96px;margin-left:-170px;" +
      "border-radius:0 0 50% 50%;" +
      "background:radial-gradient(ellipse 60% 100% at 50% 0%," +
      "rgba(255,40,40,.9) 0%,rgba(255,40,40,.45) 45%,rgba(255,40,40,0) 75%);";
    dir.appendChild(arc);
    root.appendChild(dir);
    this.damageArc = dir;

    // Ammo counter (bottom-right): "clip / reserve" or "RELOADING…".
    const ammo = document.createElement("div");
    ammo.style.cssText =
      "position:absolute;right:24px;bottom:20px;color:#fff;font:700 24px monospace;" +
      "text-shadow:0 2px 4px #000;text-align:right;";
    root.appendChild(ammo);
    this.ammoEl = ammo;

    // Current weapon name (just above the ammo counter).
    const weaponLbl = document.createElement("div");
    weaponLbl.style.cssText =
      "position:absolute;right:24px;bottom:54px;color:#cdd;font:600 14px monospace;" +
      "text-shadow:0 1px 2px #000;text-align:right;opacity:.85;";
    root.appendChild(weaponLbl);
    this.weaponEl = weaponLbl;

    // Grenade count (above the weapon label).
    const grenades = document.createElement("div");
    grenades.style.cssText =
      "position:absolute;right:24px;bottom:80px;color:#dfe;font:600 15px monospace;" +
      "text-shadow:0 1px 2px #000;text-align:right;";
    root.appendChild(grenades);
    this.grenadeEl = grenades;

    // Rocket-launcher pickup banner (top-center, below the match timer; transient).
    const rocketBanner = document.createElement("div");
    rocketBanner.style.cssText =
      "position:absolute;left:50%;top:54px;transform:translateX(-50%);display:none;" +
      "color:#ffd9a0;font:700 20px monospace;text-shadow:0 2px 4px #000;" +
      "background:rgba(60,20,0,.5);padding:4px 16px;border-radius:6px;white-space:nowrap;";
    root.appendChild(rocketBanner);
    this.rocketBannerEl = rocketBanner;

    // Sniper scope overlay (hidden until ADS with a scoped weapon). Clear center circle,
    // dark surround, thin reticle lines; the normal crosshair shows through the center.
    const scope = document.createElement("div");
    scope.style.cssText =
      "position:fixed;inset:0;display:none;pointer-events:none;z-index:22;" +
      "background:radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0 15%," +
      "rgba(0,0,0,0.5) 16% 18%, rgba(0,0,0,0.97) 23%);";
    scope.innerHTML =
      '<div style="position:absolute;left:50%;top:0;width:1px;height:100%;background:rgba(0,0,0,.55)"></div>' +
      '<div style="position:absolute;top:50%;left:0;height:1px;width:100%;background:rgba(0,0,0,.55)"></div>';
    root.appendChild(scope);
    this.scopeEl = scope;

    // "Click to play" prompt (centered overlay).
    const prompt = document.createElement("div");
    prompt.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.55);color:#fff;font-size:24px;text-align:center;";
    prompt.textContent = "Click to play  ·  WASD move · Shift sprint · Ctrl/C crouch · Space jump · Hold to fire · Right-click aim · R reload · Wheel/1·2·3 weapon · G grenade · E parachute · F zipline · M map · N map-mode · Grab the rocket launcher atop the tower · Tab scores";
    root.appendChild(prompt);
    this.prompt = prompt;

    // Kill feed (top-right).
    const feedEl = document.createElement("div");
    feedEl.style.cssText =
      "position:absolute;right:18px;top:18px;color:#fff;font-size:14px;text-align:right;" +
      "text-shadow:0 1px 2px #000;line-height:1.5;";
    root.appendChild(feedEl);
    this.killFeedEl = feedEl;

    // Scoreboard (centered, hidden until Tab held).
    const sb = document.createElement("div");
    sb.style.cssText =
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;" +
      "min-width:360px;background:rgba(0,0,0,.8);border:1px solid rgba(255,255,255,.25);" +
      "color:#fff;font-size:14px;padding:14px 18px;";
    root.appendChild(sb);
    this.scoreboard = sb;

    // Death overlay (hidden until local player dies).
    this.deathEl = document.createElement("div");
    this.deathEl.style.cssText =
      "position:fixed;inset:0;display:none;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:12px;background:rgba(80,0,0,0.35);color:#fff;" +
      "font:700 28px sans-serif;text-shadow:0 2px 6px #000;pointer-events:none;z-index:20";
    this.deathTitle = document.createElement("div");
    this.deathCount = document.createElement("div");
    this.deathCount.style.cssText = "font-size:20px;opacity:0.9";
    this.deathEl.appendChild(this.deathTitle);
    this.deathEl.appendChild(this.deathCount);
    root.appendChild(this.deathEl);

    // Match timer (top-center). Hidden until a match time is set.
    this.matchTimerEl = document.createElement("div");
    this.matchTimerEl.style.cssText =
      "position:absolute;left:50%;top:12px;transform:translateX(-50%);display:none;" +
      "color:#fff;font:700 26px monospace;text-shadow:0 2px 4px #000;" +
      "background:rgba(0,0,0,.4);padding:2px 14px;border-radius:4px;";
    root.appendChild(this.matchTimerEl);

    // Minimap / radar (top-left; bottom-right is taken by the ammo/weapon stack). Round frame
    // with a circular canvas inside. M toggles it, N flips north-up ↔ player-centred (see onKeyDown).
    const MM = 168;
    const mmWrap = document.createElement("div");
    mmWrap.style.cssText =
      `position:absolute;left:18px;top:18px;width:${MM}px;height:${MM}px;border-radius:50%;` +
      "background:rgba(8,12,20,.55);border:2px solid rgba(255,255,255,.25);box-shadow:0 2px 10px rgba(0,0,0,.5);";
    const mmCanvas = document.createElement("canvas");
    mmCanvas.width = MM;
    mmCanvas.height = MM;
    mmCanvas.style.cssText = "width:100%;height:100%;display:block;border-radius:50%;";
    mmWrap.appendChild(mmCanvas);
    root.appendChild(mmWrap);
    this.minimapWrap = mmWrap;
    this.minimapCanvas = mmCanvas;
    this.minimapCtx = mmCanvas.getContext("2d");

    // End-of-match results overlay (hidden until matchover). Interactive (Continue).
    // Body-level (NOT inside the z-index:10 HUD root) so it can sit ABOVE the lobby overlay.
    this.resultsEl = document.createElement("div");
    this.resultsEl.style.cssText =
      "position:fixed;inset:0;display:none;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:16px;background:rgba(0,0,0,.86);color:#fff;" +
      "font-family:monospace;pointer-events:auto;z-index:45;";
    parent.appendChild(this.resultsEl);

    parent.appendChild(root);
    this.root = root;

    // Tab toggles scoreboard while held (default Tab focus-cycling is suppressed).
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  /** Tell the HUD which player id is the local player (highlighted in scoreboard). */
  setMyId(id: number): void {
    this.myId = id;
  }

  /** Update the ammo counter (magazine / reserve), or show a reloading state. */
  setAmmo(clip: number, reserve: number, reloading: boolean): void {
    if (reloading) {
      this.ammoEl.innerHTML = '<span style="font-size:16px;color:#ffcc66">RELOADING…</span>';
      return;
    }
    const color = clip === 0 ? "#ee4444" : clip <= 5 ? "#ffcc66" : "#ffffff";
    this.ammoEl.innerHTML =
      `<span style="color:${color}">${clip}</span>` +
      `<span style="font-size:15px;opacity:.7"> / ${reserve}</span>`;
  }

  /** Set the current weapon name label. */
  setWeapon(name: string): void {
    this.weaponEl.textContent = name;
  }

  /** Update the grenade-count indicator. */
  setGrenades(n: number): void {
    this.grenadeEl.textContent = `🧨 ${n}`;
  }

  /** Show a transient pickup banner when the rocket launcher is gained; hide it when lost. */
  setRocket(has: boolean): void {
    if (this.rocketBannerTimer !== undefined) {
      clearTimeout(this.rocketBannerTimer);
      this.rocketBannerTimer = undefined;
    }
    if (has) {
      this.rocketBannerEl.textContent = "🚀 ROCKET LAUNCHER — 3 rockets!";
      this.rocketBannerEl.style.display = "block";
      this.rocketBannerTimer = setTimeout(() => { this.rocketBannerEl.style.display = "none"; }, 2600);
    } else {
      this.rocketBannerEl.style.display = "none";
    }
  }

  /** Show/hide the sniper scope overlay (on ADS with a scoped weapon). */
  setScope(active: boolean): void {
    this.scopeEl.style.display = active ? "block" : "none";
  }

  /** Update the armor bar (0..MAX_ARMOR); hidden at 0. */
  setArmor(a: number): void {
    if (a <= 0) { this.armorWrap.style.display = "none"; return; }
    this.armorWrap.style.display = "block";
    this.armorFill.style.width = `${Math.max(0, Math.min(1, a / MAX_ARMOR)) * 100}%`;
  }

  /** Show the spring-boots draining meter (ms remaining); hidden at 0. */
  setSpring(remainingMs: number): void {
    if (remainingMs <= 0) { this.springEl.style.display = "none"; return; }
    this.springEl.style.display = "block";
    this.springFill.style.width = `${Math.max(0, Math.min(1, remainingMs / SPRING_DURATION_MS)) * 100}%`;
    this.springLabel.textContent = `⤴ ${(remainingMs / 1000).toFixed(1)}s`;
  }

  /** Show/hide a contextual hint (pass "" to hide). */
  setHint(text: string): void {
    if (!text) { this.hintEl.style.display = "none"; return; }
    this.hintEl.style.display = "block";
    this.hintEl.textContent = text;
  }

  /** Flash the red damage vignette (call when the local player takes a hit). */
  flashDamage(): void {
    this.damageVignette.style.opacity = "1";
    if (this.dmgTimer !== undefined) clearTimeout(this.dmgTimer);
    this.dmgTimer = setTimeout(() => { this.damageVignette.style.opacity = "0"; }, 130);
  }

  /**
   * Point the damage-direction arc at `angleDeg` (screen-relative bearing from
   * damageDirectionAngle: 0 = ahead, 180 = behind, ±90 = right/left) and fade it
   * out over ~500ms. Call when the local player takes a hit from a known attacker.
   */
  flashDamageDirection(angleDeg: number): void {
    this.damageArc.style.transform = `rotate(${angleDeg}deg)`; // instant (only opacity transitions)
    this.damageArc.style.opacity = "1";
    if (this.dirTimer !== undefined) clearTimeout(this.dirTimer);
    this.dirTimer = setTimeout(() => { this.damageArc.style.opacity = "0"; }, 500);
  }

  /**
   * Draw the minimap each frame. Buildings + arena half-extent come from the caller (src/map.ts)
   * so the HUD stays decoupled from the scene. Local player = white dot + facing arrow; enemies
   * = their player colour; dead players are omitted. Off-map dots clamp to the radar edge.
   */
  updateMinimap(
    players: PlayerSnap[],
    myId: number,
    self: Vec3,
    yaw: number,
    buildings: ReadonlyArray<{ x: number; z: number; w: number; d: number }>,
    half: number,
  ): void {
    const ctx = this.minimapCtx;
    if (!this.minimapVisible) { this.minimapWrap.style.display = "none"; return; }
    this.minimapWrap.style.display = "block";
    if (!ctx) return;

    const size = this.minimapCanvas.width;
    const c = size / 2;
    const view: MinimapView = { mode: this.minimapMode, self, yaw, half, size };

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.clip(); // keep everything inside the round frame

    // Building footprints (transform all four corners → robust for both north and rotate modes).
    ctx.fillStyle = "rgba(150,160,175,.5)";
    ctx.strokeStyle = "rgba(200,210,225,.7)";
    ctx.lineWidth = 1;
    for (const b of buildings) {
      const hw = b.w / 2;
      const hd = b.d / 2;
      const corners = [
        minimapPoint(b.x - hw, b.z - hd, view),
        minimapPoint(b.x + hw, b.z - hd, view),
        minimapPoint(b.x + hw, b.z + hd, view),
        minimapPoint(b.x - hw, b.z + hd, view),
      ];
      ctx.beginPath();
      ctx.moveTo(corners[0]!.x, corners[0]!.y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Enemy dots (skip the local player and the dead).
    for (const p of players) {
      if (p.id === myId || p.st === ST_DEAD) continue;
      const pt = minimapPoint(p.p[0], p.p[2], view);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.clamped ? 2.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#" + (playerColor(p.id) & 0xffffff).toString(16).padStart(6, "0");
      ctx.fill();
    }

    // Local player: dot + facing arrow. The arrow vector is the screen delta from the player to a
    // point 8u ahead, so it stays correct in both modes (points up in rotate mode).
    const me = minimapPoint(self[0], self[2], view);
    const ahead = minimapPoint(self[0] - Math.sin(yaw) * 8, self[2] - Math.cos(yaw) * 8, view);
    let ax = ahead.x - me.x;
    let ay = ahead.y - me.y;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al; ay /= al;
    const px = -ay; // perpendicular for the arrow base
    const py = ax;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(me.x + ax * 7, me.y + ay * 7);          // tip
    ctx.lineTo(me.x - ax * 4 + px * 4, me.y - ay * 4 + py * 4);
    ctx.lineTo(me.x - ax * 4 - px * 4, me.y - ay * 4 - py * 4);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  /** Update the health bar from the local player's hp (0..MAX_HP). */
  setHealth(hp: number): void {
    const clamped = Math.max(0, Math.min(MAX_HP, hp));
    const pct = (clamped / MAX_HP) * 100;
    this.healthFill.style.width = `${pct}%`;
    this.healthFill.style.background = clamped > 30 ? "#3c9" : "#e44";
    this.healthText.textContent = `${Math.round(clamped)} / ${MAX_HP}`;
  }

  /** Show/hide the "click to play" prompt based on pointer-lock state. */
  setLocked(locked: boolean): void {
    this.prompt.style.display = locked ? "none" : "flex";
  }

  /** Flash the hit marker for a short moment (call on a confirmed local hit). */
  flashHitMarker(): void {
    this.hitMarker.style.opacity = "1";
    if (this.hitMarkerTimer !== undefined) clearTimeout(this.hitMarkerTimer);
    this.hitMarkerTimer = setTimeout(() => {
      this.hitMarker.style.opacity = "0";
    }, 90);
  }

  /** Cache the latest snapshot's player list (used for scoreboard + kill-feed names). */
  setPlayers(players: PlayerSnap[]): void {
    this.latestPlayers = players;
    if (this.scoreboardVisible) this.renderScoreboard();
  }

  /** Push a kill into the feed, resolving ids to names via the latest snapshot players. */
  addKill(msg: KillMsg, now: number = Date.now()): void {
    const nameOf = (id: number): string =>
      this.latestPlayers.find((p) => p.id === id)?.name ?? `#${id}`;
    this.feed.push({ at: now, text: `${nameOf(msg.by)} fragged ${nameOf(msg.on)}` });
    this.renderKillFeed(now);
  }

  /** Re-render the kill feed, pruning expired entries (call each frame). */
  renderKillFeed(now: number = Date.now()): void {
    this.feed = pruneKillFeed(this.feed, now);
    this.killFeedEl.innerHTML = this.feed.map((e) => `<div>${escapeHtml(e.text)}</div>`).join("");
  }

  /** Rebuild the scoreboard rows from the cached snapshot (only renders DOM when visible). */
  private renderScoreboard(): void {
    if (!this.scoreboardVisible) return;
    const rows = sortScoreboard(this.latestPlayers)
      .map((p) => {
        const me = p.id === this.myId ? "color:#fd5;" : "";
        return (
          `<tr style="${me}">` +
          `<td style="text-align:left;padding:2px 12px 2px 0">${escapeHtml(p.name)}</td>` +
          `<td style="text-align:right;padding:2px 12px">${p.frags}</td>` +
          `<td style="text-align:right;padding:2px 0">${p.deaths}</td>` +
          `</tr>`
        );
      })
      .join("");
    this.scoreboard.innerHTML =
      '<table style="width:100%;border-collapse:collapse">' +
      '<tr style="opacity:.6"><th style="text-align:left">PLAYER</th>' +
      '<th style="text-align:right">FRAGS</th><th style="text-align:right">DEATHS</th></tr>' +
      rows +
      "</table>";
  }

  showDeath(killerName: string): void {
    this.deathTitle.textContent = deathMessage(killerName);
    this.deathCount.textContent = countdownText(99999);
    this.deathEl.style.display = "flex";
  }
  updateDeath(remainingMs: number): void {
    this.deathCount.textContent = countdownText(remainingMs);
  }
  hideDeath(): void {
    this.deathEl.style.display = "none";
  }

  /** Update the match timer (MM:SS). Pass null to hide it (no active match). */
  setMatchTime(remainingMs: number | null): void {
    if (remainingMs === null) {
      this.matchTimerEl.style.display = "none";
      return;
    }
    this.matchTimerEl.style.display = "block";
    this.matchTimerEl.textContent = formatClock(remainingMs);
    this.matchTimerEl.style.color = remainingMs <= 30000 ? "#f55" : "#fff";
  }

  /** Show the end-of-match results board (ranked best players) with a Play-again button. */
  showResults(standings: Standing[], myId: number, onPlayAgain: () => void): void {
    const winner = standings[0];
    const rows = standings
      .map((s, i) => {
        const swatch = "#" + (playerColor(s.id) & 0xffffff).toString(16).padStart(6, "0");
        const mine = s.id === myId ? "background:rgba(255,221,85,.15);" : "";
        const place = i === 0 ? "🏆" : `${i + 1}`;
        return (
          `<tr style="${mine}">` +
          `<td style="padding:4px 14px 4px 0;text-align:right">${place}</td>` +
          `<td style="padding:4px 8px"><span style="display:inline-block;width:12px;height:12px;` +
          `background:${swatch};border-radius:2px;vertical-align:middle"></span></td>` +
          `<td style="padding:4px 14px 4px 4px;text-align:left">${escapeHtml(s.name)}</td>` +
          `<td style="padding:4px 14px;text-align:right">${s.frags}</td>` +
          `<td style="padding:4px 0;text-align:right;opacity:.7">${s.deaths}</td>` +
          `</tr>`
        );
      })
      .join("");

    this.resultsEl.innerHTML =
      '<div style="font:700 34px monospace">MATCH OVER</div>' +
      (winner
        ? `<div style="font:600 20px monospace;opacity:.9">Winner: ${escapeHtml(winner.name)} — ${winner.frags} frags</div>`
        : "") +
      '<table style="border-collapse:collapse;font-size:16px;margin:6px 0">' +
      '<tr style="opacity:.6"><th></th><th></th><th style="text-align:left">PLAYER</th>' +
      '<th style="text-align:right;padding:0 14px">FRAGS</th><th style="text-align:right">DEATHS</th></tr>' +
      rows +
      "</table>" +
      '<button id="play-again-btn" style="font:700 18px monospace;padding:10px 28px;cursor:pointer;' +
      'background:#3c9;border:none;border-radius:4px;color:#062">Continue to lobby</button>';

    const btn = this.resultsEl.querySelector("#play-again-btn") as HTMLButtonElement | null;
    if (btn) btn.onclick = onPlayAgain;
    this.resultsEl.style.display = "flex";
  }

  hideResults(): void {
    this.resultsEl.style.display = "none";
  }

  /** Detach listeners and remove the overlay (for teardown/tests). */
  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    if (this.hitMarkerTimer !== undefined) clearTimeout(this.hitMarkerTimer);
    if (this.rocketBannerTimer !== undefined) clearTimeout(this.rocketBannerTimer);
    if (this.dmgTimer !== undefined) clearTimeout(this.dmgTimer);
    if (this.dirTimer !== undefined) clearTimeout(this.dirTimer);
    this.root.remove();
    this.resultsEl.remove();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "KeyM") {                 // toggle minimap visibility
      this.minimapVisible = !this.minimapVisible;
      return;
    }
    if (e.code === "KeyN") {                  // toggle minimap orientation mode
      this.minimapMode = this.minimapMode === "north" ? "rotate" : "north";
      return;
    }
    if (e.code !== "Tab") return;
    e.preventDefault();
    if (!this.scoreboardVisible) {
      this.scoreboardVisible = true;
      this.scoreboard.style.display = "block";
      this.renderScoreboard();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code !== "Tab") return;
    e.preventDefault();
    this.scoreboardVisible = false;
    this.scoreboard.style.display = "none";
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
