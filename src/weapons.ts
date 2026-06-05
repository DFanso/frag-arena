// src/weapons.ts — client weapon controller: multiple weapons with per-weapon ammo,
// switching (1/2), reload (R / auto), and aim-down-sights (right mouse → FOV zoom + scope).
// Ammo is client-predicted for instant HUD feedback; the server enforces it authoritatively.
import * as THREE from "three";
import { WEAPONS, type ShootMsg, type ReloadMsg } from "../worker/protocol";
import { fireRay } from "./combat";

export interface WeaponDeps {
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  getTargets: () => THREE.Object3D[];
  isLocked: () => boolean;
  nextSeq: () => number;
  send: (m: ShootMsg | ReloadMsg) => void;
  baseFov: number;
  onLocalShoot: (hit: boolean) => void;
  onAmmo: (clip: number, reserve: number, reloading: boolean) => void;
  onWeapon: (name: string, id: number) => void;
  onScope: (active: boolean) => void;
  sfx: { shoot(): void; reload(): void; dryFire(): void };
}

export class WeaponController {
  private cur = 0;
  private clip: number[] = WEAPONS.map((w) => w.clipSize);
  private reserve: number[] = WEAPONS.map((w) => w.reserveAmmo);
  private reloading: boolean[] = WEAPONS.map(() => false);
  private timers: Array<ReturnType<typeof setTimeout> | undefined> = WEAPONS.map(() => undefined);
  private ads = false;

  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseUp: (e: MouseEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onCtx: (e: Event) => void;
  private readonly onLock: () => void;

  constructor(private d: WeaponDeps) {
    this.onMouseDown = (e) => {
      if (!d.isLocked()) return;
      if (e.button === 0) this.fire();
      else if (e.button === 2) this.setADS(true);
    };
    this.onMouseUp = (e) => { if (e.button === 2) this.setADS(false); };
    this.onKeyDown = (e) => {
      if (!d.isLocked()) return;
      if (e.code === "KeyR") this.startReload(this.cur);
      else if (e.code === "Digit1") this.switchTo(0);
      else if (e.code === "Digit2") this.switchTo(1);
    };
    this.onCtx = (e) => e.preventDefault();
    this.onLock = () => { if (!d.isLocked()) this.setADS(false); };

    d.dom.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("keydown", this.onKeyDown);
    d.dom.addEventListener("contextmenu", this.onCtx);
    document.addEventListener("pointerlockchange", this.onLock);

    this.emit();
    d.onWeapon(WEAPONS[0]!.name, 0);
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

  private fire(): void {
    const w = this.cur;
    if (this.reloading[w]) return;
    if (this.clip[w]! <= 0) { this.d.sfx.dryFire(); this.startReload(w); return; }
    this.clip[w]! -= 1;
    this.emit();
    const res = fireRay(this.d.camera, this.d.getTargets());
    this.d.send({ t: "shoot", seq: this.d.nextSeq(), ts: Date.now(), o: res.o, d: res.d, w, hit: res.hit, head: res.head });
    this.d.onLocalShoot(res.hit !== null);
    if (this.clip[w]! <= 0) this.startReload(w);
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

  switchTo(id: number): void {
    if (id < 0 || id >= WEAPONS.length || id === this.cur) return;
    this.cur = id;
    this.applyFov();
    this.d.onScope(this.ads && WEAPONS[id]!.scoped);
    this.d.onWeapon(WEAPONS[id]!.name, id);
    this.emit();
  }

  // Refill every weapon and reset to the rifle (called on (re)spawn).
  reset(): void {
    for (let w = 0; w < WEAPONS.length; w++) {
      if (this.timers[w]) clearTimeout(this.timers[w]);
      this.timers[w] = undefined;
      this.clip[w] = WEAPONS[w]!.clipSize;
      this.reserve[w] = WEAPONS[w]!.reserveAmmo;
      this.reloading[w] = false;
    }
    this.cur = 0;
    this.ads = false;
    this.applyFov();
    this.d.onScope(false);
    this.d.onWeapon(WEAPONS[0]!.name, 0);
    this.emit();
  }

  dispose(): void {
    this.d.dom.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("keydown", this.onKeyDown);
    this.d.dom.removeEventListener("contextmenu", this.onCtx);
    document.removeEventListener("pointerlockchange", this.onLock);
    for (const t of this.timers) if (t) clearTimeout(t);
    this.ads = false;
    this.applyFov();
  }
}
