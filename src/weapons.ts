// src/weapons.ts — client weapon controller: multiple weapons with per-weapon ammo,
// switching (1/2), reload (R / auto), and aim-down-sights (right mouse → FOV zoom + scope).
// Ammo is client-predicted for instant HUD feedback; the server enforces it authoritatively.
import * as THREE from "three";
import { WEAPONS, GRENADE_COOLDOWN_MS, ROCKET_ID, ROCKET_CLIP, defaultOwnedWeapons, type ShootMsg, type ReloadMsg, type ThrowMsg, type RocketMsg } from "../worker/protocol";
import { fireRay, fireRocket, bumpSpread, decaySpread } from "./combat";
import { clampZoomLevel, zoomMultiplier, zoomSensitivityScale, isScopeActive } from "./zoom";

export interface WeaponDeps {
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  getTargets: () => THREE.Object3D[];      // player proxies + barrels (hitscan + rocket entities)
  getWorldTargets: () => THREE.Object3D[]; // arena collision geometry (rocket impact on walls/floor)
  isLocked: () => boolean;
  nextSeq: () => number;
  send: (m: ShootMsg | ReloadMsg | ThrowMsg | RocketMsg) => void;
  baseFov: number;
  onLocalShoot: (hit: boolean, weaponId: number) => void;
  onAmmo: (clip: number, reserve: number, reloading: boolean) => void;
  onWeapon: (name: string, id: number) => void;
  onScope: (active: boolean) => void;
  // Look-sensitivity scale for the active zoom level (#28): 1 at hipfire, < 1 while zoomed so the
  // on-screen aim speed stays roughly constant. main multiplies the persisted base sensitivity by it.
  onZoomSensitivity: (scale: number) => void;
  onRocket: (has: boolean) => void;        // rocket launcher gained / lost (HUD pickup banner)
  sfx: { shoot(sample?: string): void; reload(durationMs: number): void; dryFire(): void };
}

export class WeaponController {
  private cur = 0;
  private clip: number[] = WEAPONS.map((w) => w.clipSize);
  private reserve: number[] = WEAPONS.map((w) => w.reserveAmmo);
  private reloading: boolean[] = WEAPONS.map(() => false);
  private timers: Array<ReturnType<typeof setTimeout> | undefined> = WEAPONS.map(() => undefined);
  // Per-weapon zoom (#28): the active zoom-level index into the current weapon's `zoomLevels`
  // (0 = hipfire). Right-click holds the zoom in; while held the wheel cycles deeper levels.
  private zoomIdx = 0;
  private rmbHeld = false; // right mouse button down (hold-to-zoom)
  private currentSpread = WEAPONS[0]!.baseSpread; // aim-spread/bloom (#20); decays toward baseSpread
  private lastThrow = 0;
  private firing = false;   // left mouse button held
  private lastFireAt = 0;   // performance.now() of the last shot (client fire-rate gate)
  private hasRocket = false; // currently holding the rocket launcher (tower pickup)
  private owned: boolean[] = defaultOwnedWeapons(); // buy menu (#26): which weapons can be switched to + fired
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
      else if (e.button === 2) { this.rmbHeld = true; this.setZoom(1); } // hold-to-zoom: engage level 1
    };
    this.onMouseUp = (e) => {
      if (e.button === 0) this.firing = false;
      else if (e.button === 2) { this.rmbHeld = false; this.setZoom(0); } // release → hipfire
    };
    this.onKeyDown = (e) => {
      if (!d.isLocked()) return;
      if (e.code === "KeyR") this.startReload(this.cur);
      else if (e.code === "Digit1") this.switchTo(0);
      else if (e.code === "Digit2") this.switchTo(1);
      else if (e.code === "Digit3") this.switchTo(ROCKET_ID); // ignored unless holding the launcher
      else if (e.code === "KeyG") this.throwGrenade();
    };
    // Mouse wheel cycles weapons normally, but while zoomed in (right-click held) it steps through
    // the current weapon's zoom levels instead (#28) — so a scoped sniper can dial deeper zoom.
    this.onWheel = (e) => {
      if (!d.isLocked()) return;
      if (this.rmbHeld) this.cycleZoom(e.deltaY > 0 ? -1 : 1); // up = zoom in, down = zoom out
      else this.cycle(e.deltaY > 0 ? 1 : -1);
    };
    this.onCtx = (e) => e.preventDefault();
    this.onLock = () => { if (!d.isLocked()) { this.rmbHeld = false; this.setZoom(0); this.firing = false; } };

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

  // The weapon ids the player can currently switch among: every OWNED catalog gun (buy menu, #26 —
  // the Rifle is free, others are bought) plus the rocket launcher only while it's held (tower pickup).
  private availableWeapons(): number[] {
    const list: number[] = [];
    for (let w = 0; w < WEAPONS.length; w++) {
      if (w === ROCKET_ID) continue; // the launcher is gated by hasRocket below, not ownership
      if (this.owned[w]) list.push(w);
    }
    if (this.hasRocket) list.push(ROCKET_ID);
    return list;
  }

  // Buy menu (#26): the server confirmed a purchase — mark the weapon owned and switch to it for
  // instant feedback (the server already enforced affordability + ownership). Idempotent.
  grantWeapon(id: number): void {
    if (id < 0 || id >= WEAPONS.length || id === ROCKET_ID) return; // the rocket is a tower pickup
    this.owned[id] = true;
    this.switchTo(id);
  }

  // Reconnect (issue #72): adopt the server-restored ownership vector from the welcome so a
  // rejoined player can switch to guns bought before the drop. The rocket launcher stays gated
  // by hasRocket (a tower pickup, never ownership) and the free starter rifle is always owned.
  setOwnedWeapons(owned: readonly boolean[]): void {
    for (let w = 0; w < WEAPONS.length; w++) {
      if (w === ROCKET_ID) continue;
      this.owned[w] = !!owned[w];
    }
    this.owned[0] = true;
    if (this.cur !== ROCKET_ID && !this.owned[this.cur]) this.switchTo(0);
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
    if (w === this.cur) { this.d.sfx.reload(wp.reloadMs); this.emit(); }
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
    const spread = this.zoomIdx > 0 ? this.currentSpread * 0.3 : this.currentSpread; // zoom tightens the cone
    const res = fireRay(this.d.camera, this.d.getTargets(), spread);
    this.currentSpread = bumpSpread(this.currentSpread, wp.baseSpread, wp.sprayGrowth); // bloom for the next shot
    this.d.send({ t: "shoot", seq: this.d.nextSeq(), ts: Date.now(), o: res.o, d: res.d, w, hit: res.hit, head: res.head, barrel: res.barrel });
    this.d.onLocalShoot(res.hit !== null, w);
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
    this.d.onLocalShoot(res.hit !== null || res.barrel !== null, ROCKET_ID); // launch sfx + recoil + flash (blast sfx plays on detonation)
    if (this.clip[ROCKET_ID]! <= 0) {
      this.hasRocket = false;
      this.firing = false; // release the trigger so the auto rifle doesn't fire on the same held click
      this.d.onRocket(false);
      this.switchTo(0); // out of rockets → fall back to the rifle
    }
  }

  /** Set the base (hip) FOV from settings; the active zoom level still multiplies it (#28). */
  setBaseFov(fov: number): void {
    this.d.baseFov = fov;
    this.applyZoom();
  }

  /** Current zoom-level index into the active weapon's zoomLevels (0 = hipfire). For tests/HUD. */
  getZoom(): number {
    return this.zoomIdx;
  }

  // Apply the active zoom level (#28): set the camera FOV from the weapon's multiplier, scale the
  // look sensitivity to match, and drive the scope overlay. Idempotent — safe to call any time.
  private applyZoom(): void {
    const wp = WEAPONS[this.cur]!;
    this.zoomIdx = clampZoomLevel(this.zoomIdx, wp.zoomLevels.length); // clamp after weapon switch
    const m = zoomMultiplier(wp.zoomLevels, this.zoomIdx);
    this.d.camera.fov = this.d.baseFov * m;
    this.d.camera.updateProjectionMatrix();
    this.d.onZoomSensitivity(zoomSensitivityScale(m));
    this.d.onScope(isScopeActive(wp.scoped, this.zoomIdx));
  }

  // Jump to an absolute zoom-level index (clamped to the weapon's levels), then apply it.
  private setZoom(idx: number): void {
    const next = clampZoomLevel(idx, WEAPONS[this.cur]!.zoomLevels.length);
    if (next === this.zoomIdx) return;
    this.zoomIdx = next;
    this.applyZoom();
  }

  // Step the zoom level by `dir` while staying zoomed in (never below level 1 — releasing
  // right-click is what returns to hipfire). No-op on weapons that have no deeper levels.
  private cycleZoom(dir: number): void {
    if (this.zoomIdx < 1) return; // only cycle while already zoomed (right-click held)
    this.setZoom(Math.max(1, this.zoomIdx + dir));
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
    if (id === ROCKET_ID) {
      if (!this.hasRocket) return; // can't select a launcher you don't hold
    } else if (!this.owned[id]) {
      return; // buy menu (#26): can't select a gun you haven't purchased
    }
    this.cur = id;
    this.currentSpread = WEAPONS[id]!.baseSpread; // fresh weapon → reset bloom
    // Carry the right-click hold across the switch: keep zoomed (level 1) on the new gun if the
    // button is still down, else drop to hipfire. applyZoom re-clamps to the new weapon's levels.
    this.zoomIdx = this.rmbHeld ? 1 : 0;
    this.applyZoom();
    this.d.onWeapon(WEAPONS[id]!.name, id);
    this.emit();
  }

  // Refill every weapon's reserve to max (ammo crate pickup). Keeps the current magazine.
  refillReserve(): void {
    for (let w = 0; w < WEAPONS.length; w++) this.reserve[w] = WEAPONS[w]!.reserveAmmo;
    this.emit();
  }

  // Buy menu (#26): clear all purchased weapons back to the free starter (called at MATCH START,
  // mirroring the server resetting ownedWeapons). Respawns within a match keep ownership (see
  // reset(), which preserves `owned`). Drops back to the rifle if the held gun is no longer owned.
  resetOwned(): void {
    this.owned = defaultOwnedWeapons();
    if (this.cur !== ROCKET_ID && !this.owned[this.cur]) this.switchTo(0); // fall back to the rifle
  }

  /** Which catalog weapons the local player currently owns (buy-menu affordability/UI; #26). */
  getOwned(): readonly boolean[] {
    return this.owned;
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
    this.zoomIdx = 0;
    this.rmbHeld = false;
    this.lastThrow = 0;
    this.firing = false;
    this.lastFireAt = 0;
    this.applyZoom(); // resets FOV, sensitivity scale, and the scope overlay to hipfire
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
    this.zoomIdx = 0;
    this.rmbHeld = false;
    this.applyZoom();
  }
}
