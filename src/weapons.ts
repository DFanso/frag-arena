// src/weapons.ts — client weapon controller: multiple weapons with per-weapon ammo,
// switching (1/2), reload (R / auto), and aim-down-sights (right mouse → FOV zoom + scope).
// Ammo is client-predicted for instant HUD feedback; the server enforces it authoritatively.
import * as THREE from "three";
import { WEAPONS, GRENADE_COOLDOWN_MS, ROCKET_ID, ROCKET_CLIP, type ShootMsg, type ReloadMsg, type ThrowMsg, type RocketMsg } from "../worker/protocol";
import { fireRay, fireRocket, bumpSpread, decaySpread } from "./combat";

export interface WeaponDeps {
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  getTargets: () => THREE.Object3D[];      // player proxies + barrels (hitscan + rocket entities)
  getWorldTargets: () => THREE.Object3D[]; // arena collision geometry (rocket impact on walls/floor)
  isLocked: () => boolean;
  nextSeq: () => number;
  send: (m: ShootMsg | ReloadMsg | ThrowMsg | RocketMsg) => void;
  baseFov: number;
  onLocalShoot: (hit: boolean) => void;
  onAmmo: (clip: number, reserve: number, reloading: boolean) => void;
  onWeapon: (name: string, id: number) => void;
  onScope: (active: boolean) => void;
  onRocket: (has: boolean) => void;        // rocket launcher gained / lost (HUD pickup banner)
  sfx: { shoot(): void; reload(): void; dryFire(): void };
}

export class WeaponController {
  private cur = 0;
  private clip: number[] = WEAPONS.map((w) => w.clipSize);
  private reserve: number[] = WEAPONS.map((w) => w.reserveAmmo);
  private reloading: boolean[] = WEAPONS.map(() => false);
  private timers: Array<ReturnType<typeof setTimeout> | undefined> = WEAPONS.map(() => undefined);
  private ads = false;
  private currentSpread = WEAPONS[0]!.baseSpread; // aim-spread/bloom (#20); decays toward baseSpread
  private lastThrow = 0;
  private firing = false;   // left mouse button held
  private lastFireAt = 0;   // performance.now() of the last shot (client fire-rate gate)
  private hasRocket = false; // currently holding the rocket launcher (tower pickup)
  private dead = false;     // local player is dead (block firing/throwing until respawn)

  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onCtx: (e: Event) => void;
  private readonly onLock: () => void;

  constructor(private d: WeaponDeps) {
    this.onMouseDown = (e) => {
      if (!d.isLocked()) return;
      if (e.button === 0) { this.firing = true; this.fire(); }
      else if (e.button === 2) this.setADS(true);
    };
    this.onMouseUp = (e) => {
      if (e.button === 0) this.firing = false;
      else if (e.button === 2) this.setADS(false);
    };
    this.onKeyDown = (e) => {
      if (!d.isLocked()) return;
      if (e.code === "KeyR") this.startReload(this.cur);
      else if (e.code === "Digit1") this.switchTo(0);
      else if (e.code === "Digit2") this.switchTo(1);
      else if (e.code === "Digit3") this.switchTo(ROCKET_ID); // ignored unless holding the launcher
      else if (e.code === "KeyG") this.throwGrenade();
    };
    // Mouse wheel cycles through the weapons you currently hold (rocket joins only when held).
    this.onWheel = (e) => { if (d.isLocked()) this.cycle(e.deltaY > 0 ? 1 : -1); };
    this.onCtx = (e) => e.preventDefault();
    this.onLock = () => { if (!d.isLocked()) { this.setADS(false); this.firing = false; } };

    this.clip[ROCKET_ID] = 0; // the rocket launcher starts un-held (no rockets until picked up)

    d.dom.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("wheel", this.onWheel, { passive: true });
    d.dom.addEventListener("contextmenu", this.onCtx);
    document.addEventListener("pointerlockchange", this.onLock);

    this.emit();
    d.onWeapon(WEAPONS[0]!.name, 0);
  }

  // The weapon ids the player can currently switch among (rocket only while held).
  private availableWeapons(): number[] {
    const list = [0, 1];
    if (this.hasRocket) list.push(ROCKET_ID);
    return list;
  }

  // Cycle the current weapon by `dir` (+1 next / -1 prev) within the available set.
  private cycle(dir: number): void {
    const avail = this.availableWeapons();
    const i = avail.indexOf(this.cur);
    const next = avail[(((i < 0 ? 0 : i) + dir) % avail.length + avail.length) % avail.length]!;
    this.switchTo(next);
  }

  // Grant the rocket launcher (tower pickup): refill to ROCKET_CLIP and switch to it.
  grantRocket(): void {
    this.hasRocket = true;
    this.clip[ROCKET_ID] = ROCKET_CLIP;
    this.reserve[ROCKET_ID] = 0;
    this.d.onRocket(true);
    this.switchTo(ROCKET_ID);
  }

  private emit(): void {
    this.d.onAmmo(this.clip[this.cur]!, this.reserve[this.cur]!, this.reloading[this.cur]!);
  }

  private finishReload(w: number): void {
    const wp = WEAPONS[w]!;
    const need = Math.min(wp.clipSize - this.clip[w]!, this.reserve[w]!);
    this.clip[w]! += need;
    this.reserve[w]! -= need;
    this.reloading[w] = false;
    this.timers[w] = undefined;
    if (w === this.cur) this.emit();
  }

  private startReload(w: number): void {
    const wp = WEAPONS[w]!;
    if (this.reloading[w] || this.clip[w]! >= wp.clipSize || this.reserve[w]! <= 0) return;
    this.reloading[w] = true;
    this.d.send({ t: "reload", w });
    if (w === this.cur) { this.d.sfx.reload(); this.emit(); }
    this.timers[w] = setTimeout(() => this.finishReload(w), wp.reloadMs);
  }

  // Auto-fire: keep firing while the trigger is held on a full-auto weapon (rate-limited
  // by the weapon's cooldown so the client stays in sync with the server). Called per frame.
  update(dtMs = 0): void {
    this.currentSpread = decaySpread(this.currentSpread, WEAPONS[this.cur]!.baseSpread, dtMs);
    if (this.firing && this.d.isLocked() && WEAPONS[this.cur]!.auto) this.fire();
  }

  /** Current aim-spread cone radius (NDC) — the HUD widens the crosshair gap from this (#20). */
  getSpread(): number {
    return this.currentSpread;
  }

  // Mark the local player dead/alive — gates firing + throwing so a corpse can't emit messages.
  setAlive(alive: boolean): void {
    this.dead = !alive;
    if (this.dead) this.firing = false;
  }

  private fire(): void {
    if (this.dead) return;
    const w = this.cur;
    const now = performance.now();
    if (now - this.lastFireAt < WEAPONS[w]!.cooldownMs) return; // client fire-rate gate
    if (w === ROCKET_ID) { this.fireRocketShot(now); return; }
    if (this.reloading[w]) return;
    if (this.clip[w]! <= 0) { this.d.sfx.dryFire(); this.startReload(w); return; }
    this.lastFireAt = now;
    this.clip[w]! -= 1;
    this.emit();
    const wp = WEAPONS[w]!;
    const spread = this.ads ? this.currentSpread * 0.3 : this.currentSpread; // ADS tightens the cone
    const res = fireRay(this.d.camera, this.d.getTargets(), spread);
    this.currentSpread = bumpSpread(this.currentSpread, wp.baseSpread, wp.sprayGrowth); // bloom for the next shot
    this.d.send({ t: "shoot", seq: this.d.nextSeq(), ts: Date.now(), o: res.o, d: res.d, w, hit: res.hit, head: res.head, barrel: res.barrel });
    this.d.onLocalShoot(res.hit !== null);
    if (this.clip[w]! <= 0) this.startReload(w);
  }

  // Fire one rocket: raycast the impact against entities + world geometry, send it to the
  // server (which owns the blast), and drop the launcher when the last rocket is spent.
  private fireRocketShot(now: number): void {
    if (!this.hasRocket || this.clip[ROCKET_ID]! <= 0) { this.d.sfx.dryFire(); return; }
    this.lastFireAt = now;
    this.clip[ROCKET_ID]! -= 1;
    this.emit();
    const res = fireRocket(this.d.camera, this.d.getTargets(), this.d.getWorldTargets());
    this.d.send({ t: "rocket", seq: this.d.nextSeq(), ts: Date.now(), o: res.o, d: res.d, p: res.point, hit: res.hit, barrel: res.barrel });
    this.d.onLocalShoot(res.hit !== null || res.barrel !== null); // launch sfx + recoil + flash (blast sfx plays on detonation)
    if (this.clip[ROCKET_ID]! <= 0) {
      this.hasRocket = false;
      this.firing = false; // release the trigger so the auto rifle doesn't fire on the same held click
      this.d.onRocket(false);
      this.switchTo(0); // out of rockets → fall back to the rifle
    }
  }

  /** Set the base (hip) FOV from settings; ADS zoom still multiplies it. Applies immediately. */
  setBaseFov(fov: number): void {
    this.d.baseFov = fov;
    this.applyFov();
  }

  private applyFov(): void {
    this.d.camera.fov = this.d.baseFov * (this.ads ? WEAPONS[this.cur]!.adsZoom : 1);
    this.d.camera.updateProjectionMatrix();
  }

  private setADS(on: boolean): void {
    if (this.ads === on) return;
    this.ads = on;
    this.applyFov();
    this.d.onScope(on && WEAPONS[this.cur]!.scoped);
  }

  private throwGrenade(): void {
    if (this.dead) return;
    const now = Date.now();
    if (now - this.lastThrow < GRENADE_COOLDOWN_MS) return;
    this.lastThrow = now;
    const o = this.d.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.d.camera.getWorldDirection(new THREE.Vector3());
    this.d.send({ t: "throw", o: [o.x, o.y, o.z], d: [dir.x, dir.y, dir.z] });
  }

  switchTo(id: number): void {
    if (id < 0 || id >= WEAPONS.length || id === this.cur) return;
    if (id === ROCKET_ID && !this.hasRocket) return; // can't select a launcher you don't hold
    this.cur = id;
    this.currentSpread = WEAPONS[id]!.baseSpread; // fresh weapon → reset bloom
    this.applyFov();
    this.d.onScope(this.ads && WEAPONS[id]!.scoped);
    this.d.onWeapon(WEAPONS[id]!.name, id);
    this.emit();
  }

  // Refill every weapon's reserve to max (ammo crate pickup). Keeps the current magazine.
  refillReserve(): void {
    for (let w = 0; w < WEAPONS.length; w++) this.reserve[w] = WEAPONS[w]!.reserveAmmo;
    this.emit();
  }

  // Refill every weapon and reset to the rifle (called on (re)spawn). The rocket launcher is a
  // tower pickup, so it is LOST on respawn (you must climb the tower again to get another).
  reset(): void {
    for (let w = 0; w < WEAPONS.length; w++) {
      if (this.timers[w]) clearTimeout(this.timers[w]);
      this.timers[w] = undefined;
      this.clip[w] = WEAPONS[w]!.clipSize;
      this.reserve[w] = WEAPONS[w]!.reserveAmmo;
      this.reloading[w] = false;
    }
    this.hasRocket = false;
    this.clip[ROCKET_ID] = 0; // un-held until the next tower pickup
    this.d.onRocket(false);
    this.cur = 0;
    this.currentSpread = WEAPONS[0]!.baseSpread;
    this.ads = false;
    this.lastThrow = 0;
    this.firing = false;
    this.lastFireAt = 0;
    this.applyFov();
    this.d.onScope(false);
    this.d.onWeapon(WEAPONS[0]!.name, 0);
    this.emit();
  }

  dispose(): void {
    this.d.dom.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("wheel", this.onWheel);
    this.d.dom.removeEventListener("contextmenu", this.onCtx);
    document.removeEventListener("pointerlockchange", this.onLock);
    for (const t of this.timers) if (t) clearTimeout(t);
    this.ads = false;
    this.applyFov();
  }
}
