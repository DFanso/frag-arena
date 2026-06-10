# Third-Person Animation, Held Weapons & Interp Smoothing — Implementation Plan (PR-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote players hold their actual weapon, animate directionally without foot-sliding, die with an animation, and move smoothly (velocity-aware interpolation).

**Architecture:** Pure helpers (`pickLocomotion` in `src/anim.ts`, Hermite sampling in `src/interp.ts`) drive `RemotePlayer`. Weapon meshes are extracted once from the already-shipped `character_soldier.glb` into per-weapon templates (`src/armory.ts`) and socketed onto the SWAT rig's `Wrist.R` bone. The held weapon id travels `InMsg.w → PlayerRec.curWeapon → PlayerSnap.w` (display-only, clamped server-side).

**Tech Stack:** Three.js (SkeletonUtils, AnimationMixer), vitest, existing GLBs only — no new assets.

**Spec:** `docs/superpowers/specs/2026-06-10-player-animation-weapons-feel-design.md`

---

### Task 1: `pickLocomotion` pure helper

**Files:**
- Modify: `src/anim.ts` (add; keep `pickAnim` until Task 6 removes its last consumer)
- Test: `test/anim.test.ts` (extend)

- [ ] **Step 1: Write failing tests** (append to `test/anim.test.ts`)

```ts
import { pickLocomotion, RUN_REFERENCE_SPEED } from "../src/anim";

describe("pickLocomotion (third-person overhaul)", () => {
  // yaw=0 faces -Z (three.js camera convention; snapshot r[0] is the camera yaw).
  it("idles (gun pose) when slow", () => {
    expect(pickLocomotion(0, 0, 0, false).clip).toBe("Idle_Gun");
    expect(pickLocomotion(0.2, 0, 0, false).clip).toBe("Idle_Gun");
  });
  it("idle + shooting uses the gun-shoot idle", () => {
    expect(pickLocomotion(0, 0, 0, true).clip).toBe("Idle_Gun_Shoot");
  });
  it("forward run at yaw=0 is -Z", () => {
    expect(pickLocomotion(0, -5, 0, false).clip).toBe("Run");
  });
  it("forward + shooting runs-and-guns", () => {
    expect(pickLocomotion(0, -5, 0, true).clip).toBe("Run_Shoot");
  });
  it("backpedal at yaw=0 is +Z", () => {
    expect(pickLocomotion(0, 5, 0, false).clip).toBe("Run_Back");
  });
  it("strafe right at yaw=0 is +X", () => {
    expect(pickLocomotion(5, 0, 0, false).clip).toBe("Run_Right");
  });
  it("strafe left at yaw=0 is -X", () => {
    expect(pickLocomotion(-5, 0, 0, false).clip).toBe("Run_Left");
  });
  it("rotating the player rotates the frame: moving -Z while facing -X (yaw=+90°) is a left strafe... or forward?", () => {
    // facing -X (yaw = PI/2), moving -Z → velocity points to the character's RIGHT.
    expect(pickLocomotion(0, -5, Math.PI / 2, false).clip).toBe("Run_Right");
  });
  it("timeScale tracks speed and clamps", () => {
    expect(pickLocomotion(0, -RUN_REFERENCE_SPEED, 0, false).timeScale).toBeCloseTo(1, 5);
    expect(pickLocomotion(0, -100, 0, false).timeScale).toBe(1.6);
    expect(pickLocomotion(0, -0.6, 0, false).timeScale).toBe(0.6);
    expect(pickLocomotion(0, 0, 0, false).timeScale).toBe(1); // idle always 1
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/anim.test.ts` → FAIL (`pickLocomotion` not exported)

- [ ] **Step 3: Implement** (append to `src/anim.ts`)

```ts
// --- Third-person locomotion (spec 2026-06-10): pick a SWAT clip from character-local velocity.
export const RUN_REFERENCE_SPEED = 6; // world u/s at which Run plays at timeScale 1
export type LocomotionClip =
  | "Idle_Gun" | "Idle_Gun_Shoot" | "Run" | "Run_Back" | "Run_Left" | "Run_Right" | "Run_Shoot";
export interface Locomotion { clip: LocomotionClip; timeScale: number; }

// vx/vz: world-space horizontal velocity. yaw: facing (r[0]; yaw=0 faces -Z).
// Rotates velocity into the character frame, picks the dominant direction, and scales the
// clip speed to the actual ground speed so feet match the floor (no skating).
export function pickLocomotion(vx: number, vz: number, yaw: number, shooting: boolean): Locomotion {
  const speed = Math.hypot(vx, vz);
  if (speed <= RUN_SPEED_THRESHOLD) {
    return { clip: shooting ? "Idle_Gun_Shoot" : "Idle_Gun", timeScale: 1 };
  }
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const fwd = -vz * cos - vx * sin;  // + = moving the way the character faces
  const right = vx * cos - vz * sin; // + = moving toward the character's right
  let clip: LocomotionClip;
  if (Math.abs(fwd) >= Math.abs(right)) clip = fwd > 0 ? (shooting ? "Run_Shoot" : "Run") : "Run_Back";
  else clip = right > 0 ? "Run_Right" : "Run_Left";
  const timeScale = Math.min(1.6, Math.max(0.6, speed / RUN_REFERENCE_SPEED));
  return { clip, timeScale };
}
```

- [ ] **Step 4: Run** `npx vitest run test/anim.test.ts` → PASS
- [ ] **Step 5: Commit** `git add src/anim.ts test/anim.test.ts && git commit -m "feat: pickLocomotion — directional clip + speed-matched timeScale (no foot-slide)"`

---

### Task 2: Velocity-aware interpolation (Hermite + bounded extrapolation)

**Files:**
- Modify: `src/interp.ts` (Snapshot gains `v?`; sampleBuffer upgraded)
- Modify: `src/main.ts:527` (pass `v` into addSnapshot)
- Test: `test/interp.test.ts` (extend)

- [ ] **Step 1: Write failing tests** (append to `test/interp.test.ts`)

```ts
import { sampleBuffer, type Snapshot } from "../src/interp";

describe("velocity-aware sampling (spec 2026-06-10)", () => {
  const snap = (t: number, x: number, vx = 0): Snapshot =>
    ({ t, p: [x, 0, 0], r: [0, 0], v: [vx, 0, 0] });

  it("matches endpoints exactly", () => {
    const buf = [snap(0, 0, 10), snap(100, 1, 10)];
    expect(sampleBuffer(buf, 0)!.p[0]).toBeCloseTo(0, 6);
    expect(sampleBuffer(buf, 100)!.p[0]).toBeCloseTo(1, 6);
  });
  it("constant-velocity motion interpolates linearly (hermite degenerates to lerp)", () => {
    // moving at 10 u/s: x(t) = 10 * t(s); samples at t=0(x=0) and t=100ms(x=1)
    const buf = [snap(0, 0, 10), snap(100, 1, 10)];
    expect(sampleBuffer(buf, 50)!.p[0]).toBeCloseTo(0.5, 3);
  });
  it("eases direction reversals instead of kinking (cubic, not linear)", () => {
    // moving +10 at t=0 but back at the same x at t=100 with -10: midpoint overshoots > 0
    const buf = [snap(0, 0, 10), snap(100, 0, -10)];
    expect(sampleBuffer(buf, 50)!.p[0]).toBeGreaterThan(0.05);
  });
  it("extrapolates past the newest snapshot using its velocity, capped at 100ms", () => {
    const buf = [snap(0, 0, 10), snap(100, 1, 10)];
    expect(sampleBuffer(buf, 150)!.p[0]).toBeCloseTo(1.5, 3);  // +50ms * 10u/s
    expect(sampleBuffer(buf, 900)!.p[0]).toBeCloseTo(2.0, 3);  // capped at +100ms
  });
  it("falls back to lerp when snapshots carry no velocity", () => {
    const buf: Snapshot[] = [{ t: 0, p: [0, 0, 0], r: [0, 0] }, { t: 100, p: [1, 0, 0], r: [0, 0] }];
    expect(sampleBuffer(buf, 50)!.p[0]).toBeCloseTo(0.5, 6);
    expect(sampleBuffer(buf, 200)!.p[0]).toBeCloseTo(1, 6); // no v → no extrapolation
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/interp.test.ts` → FAIL (Snapshot has no `v`; extrapolation/cubic missing)

- [ ] **Step 3: Implement in `src/interp.ts`**

Replace the `Snapshot` interface and `sampleBuffer` with:

```ts
export interface Snapshot {
  t: number;
  p: Vec3;
  r: Rot;
  v?: Vec3; // world-units/sec; enables cubic sampling + extrapolation when present
}

export const EXTRAPOLATE_MAX_MS = 100; // never project a remote further than this past its last snap

// Cubic Hermite on one axis: positions p0/p1, tangents scaled to the segment duration.
function hermite(p0: number, m0: number, p1: number, m1: number, t: number): number {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0
       + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}

// Pick interpolated {p,r} for renderTime from a time-sorted (ascending t) buffer.
// With per-snapshot velocities this is cubic Hermite (smooth through direction changes)
// plus bounded dead-reckoning past the newest snapshot; without them it falls back to
// the original linear behavior. Returns null only when the buffer is empty.
export function sampleBuffer(
  buf: Snapshot[],
  renderTime: number,
): { p: Vec3; r: Rot } | null {
  if (buf.length === 0) return null;
  const first = buf[0]!;
  const last = buf[buf.length - 1]!;

  if (buf.length === 1 || renderTime <= first.t) {
    return { p: [...first.p] as Vec3, r: [...first.r] as Rot };
  }
  if (renderTime >= last.t) {
    // Buffer ran dry: project along the last known velocity, hard-capped so a dropped
    // stream parks the player instead of sending them through a wall.
    if (!last.v) return { p: [...last.p] as Vec3, r: [...last.r] as Rot };
    const dt = Math.min(renderTime - last.t, EXTRAPOLATE_MAX_MS) / 1000;
    return {
      p: [last.p[0] + last.v[0] * dt, last.p[1] + last.v[1] * dt, last.p[2] + last.v[2] * dt],
      r: [...last.r] as Rot,
    };
  }

  for (let i = 1; i < buf.length; i++) {
    const hi = buf[i]!;
    if (renderTime < hi.t) {
      const lo = buf[i - 1]!;
      const span = hi.t - lo.t;
      const t = span > 0 ? (renderTime - lo.t) / span : 0;
      const r: Rot = [lerpAngle(lo.r[0], hi.r[0], t), lerpAngle(lo.r[1], hi.r[1], t)];
      if (lo.v && hi.v && span > 0) {
        const s = span / 1000; // tangents are u/s; scale into the segment's parameter space
        const p: Vec3 = [
          hermite(lo.p[0], lo.v[0] * s, hi.p[0], hi.v[0] * s, t),
          hermite(lo.p[1], lo.v[1] * s, hi.p[1], hi.v[1] * s, t),
          hermite(lo.p[2], lo.v[2] * s, hi.p[2], hi.v[2] * s, t),
        ];
        return { p, r };
      }
      return { p: lerpVec3(lo.p, hi.p, t), r };
    }
  }
  return { p: [...last.p] as Vec3, r: [...last.r] as Rot };
}
```

- [ ] **Step 4: Wire velocity in `src/main.ts:527`**

```ts
        rp.addSnapshot({ t: m.ts, p: ps.p, r: ps.r, v: ps.v });
```

- [ ] **Step 5: Run** `npx vitest run test/interp.test.ts` then `npm test` → PASS (all)
- [ ] **Step 6: Commit** `git add src/interp.ts src/main.ts test/interp.test.ts && git commit -m "feat: hermite interpolation + bounded extrapolation for remote players"`

---

### Task 3: Held-weapon id over the wire (`InMsg.w` → `PlayerSnap.w`)

**Files:**
- Modify: `worker/protocol.ts` (InMsg, PlayerSnap)
- Modify: `worker/game-core.ts` (PlayerRec, ingestInput, snapOf)
- Modify: `src/player.ts` (LocalPlayer.buildInput), `src/weapons.ts` (getter), `src/main.ts` (send)
- Test: `test/room.test.ts` (extend)

- [ ] **Step 1: Write failing tests** (append to `test/room.test.ts`)

```ts
describe("held weapon id in snapshots (display-only)", () => {
  it("stores a valid InMsg.w and echoes it in snapOf", async () => {
    const stub = env.ROOMS.getByName("heldw-valid");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const i = instance as any;
      const rec = makeRec(1, [0, 1, 0]);
      i.byId.set(1, rec);
      i.players.set(rec.ws, rec);
      i.ingestInput(rec, { t: "in", seq: 1, ts: Date.now(), p: [0, 1, 0], r: [0, 0], v: [0, 0, 0], w: 1 });
      expect(i.snapOf(rec).w).toBe(1);
    });
  });
  it("ignores invalid w (non-integer / out of range) and keeps the last value", async () => {
    const stub = env.ROOMS.getByName("heldw-invalid");
    await runInDurableObject(stub, async (instance: GameRoom) => {
      const i = instance as any;
      const rec = makeRec(1, [0, 1, 0]);
      i.byId.set(1, rec);
      i.players.set(rec.ws, rec);
      const base = { t: "in", seq: 1, ts: Date.now(), p: [0, 1, 0], r: [0, 0], v: [0, 0, 0] };
      for (const bad of [1.5, -1, 99, "1"]) i.ingestInput(rec, { ...base, w: bad });
      expect(i.snapOf(rec).w).toBe(0); // default stayed
    });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/room.test.ts -t "held weapon"` → FAIL

- [ ] **Step 3: Implement**

`worker/protocol.ts` — extend both interfaces (note the added `w`):

```ts
export interface InMsg  { t: "in";    seq: number; ts: number; p: Vec3; r: Rot; v: Vec3; c?: boolean; pc?: boolean; w?: number; }
```
and in `PlayerSnap` add `w?: number;` after `credits?: number;` (held weapon id — display only).

`worker/game-core.ts`:
- `PlayerRec` interface: add `curWeapon: number;` (next to `c`/`pc`).
- Every PlayerRec literal (addPlayer ~line 369, addBot ~line 440): add `curWeapon: 0,`.
- `ingestInput` (after `rec.pc = !!m.pc;`):

```ts
    // Held weapon for remote rendering (display-only; combat still validates per ShootMsg).
    if (typeof m.w === "number" && Number.isInteger(m.w) && m.w >= 0 && m.w < WEAPONS.length) {
      rec.curWeapon = m.w;
    }
```
- `snapOf`: add `w: rec.curWeapon,`.

`src/weapons.ts` — add next to `getOwned()`:

```ts
  /** Currently-held weapon id (rides along in InMsg so remotes render the right gun). */
  getCurrentWeapon(): number {
    return this.cur;
  }
```

`src/player.ts` — `LocalPlayer.buildInput` gains a trailing param `w = 0` and emits `w`:

```ts
  buildInput(p: Vec3, r: Rot, v: Vec3, tsMs: number, crouch = false, parachute = false, w = 0): InMsg {
    return { t: "in", seq: this.nextSeq(), ts: tsMs, p: [p[0], p[1], p[2]], r: [r[0], r[1]],
             v: [v[0], v[1], v[2]], c: crouch, pc: parachute, w };
  }
```

`src/main.ts` `sendInputIfDue` (~line 840) — add the argument:

```ts
      const msg = local.buildInput(
        controls.getPosition(),
        controls.getRotation(),
        controls.getVelocity(),
        Date.now(),
        controls.isCrouching,
        controls.isParachuting(),
        shootHandle?.getCurrentWeapon() ?? 0,
      );
```

- [ ] **Step 4: Run** `npm test` and `npm run typecheck` → PASS
- [ ] **Step 5: Commit** `git add worker/protocol.ts worker/game-core.ts src/player.ts src/weapons.ts src/main.ts test/room.test.ts && git commit -m "feat: held-weapon id travels InMsg.w -> PlayerSnap.w (display-only, clamped)"`

---

### Task 4: Armory — extract held-weapon templates from the soldier GLB

**Files:**
- Create: `src/armory.ts`
- Modify: `src/assets.ts` (load `character_soldier.glb` as `soldier`)
- Test: `test/armory.test.ts` (create)

- [ ] **Step 1: Write failing tests** (`test/armory.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { extractWeaponTemplates, WEAPON_MESH_NAMES, HELD_WEAPON_LEN } from "../src/armory";

// Synthetic stand-in for the soldier GLTF scene: named meshes like the real GLB.
function fakeSoldier(): { scene: THREE.Group } {
  const scene = new THREE.Group();
  for (const name of ["AK", "Sniper", "RocketLauncher", "Pistol", "Body"]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 0.4, 0.4), new THREE.MeshStandardMaterial());
    m.name = name;
    scene.add(m);
  }
  return { scene };
}

describe("extractWeaponTemplates", () => {
  it("maps weapon ids to the right soldier meshes", () => {
    expect(WEAPON_MESH_NAMES).toEqual({ 0: "AK", 1: "Sniper", 2: "RocketLauncher" });
  });
  it("extracts a normalized, no-hit template per weapon id", () => {
    const t = extractWeaponTemplates(fakeSoldier() as never);
    for (const id of [0, 1, 2]) {
      const obj = t[id]!;
      expect(obj).toBeTruthy();
      let noHit = true;
      obj.traverse((o) => { if (!o.userData["noHit"]) noHit = false; });
      expect(noHit).toBe(true);
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(obj).getSize(size);
      expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(HELD_WEAPON_LEN[id]!, 3);
    }
  });
  it("returns nulls when the soldier model is missing", () => {
    expect(extractWeaponTemplates(null)).toEqual([null, null, null]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/armory.test.ts` → FAIL (module missing)

- [ ] **Step 3: Implement `src/armory.ts`**

```ts
// src/armory.ts — held-weapon templates for remote players (spec 2026-06-10).
// The Quaternius soldier GLB ships real modeled guns as separate meshes; extract one
// template per catalog weapon id, normalized to a hand-relative size, ready to clone
// into a character's Wrist.R socket. Purely visual: templates are noHit.
import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

export const WEAPON_MESH_NAMES: Record<number, string> = {
  0: "AK",             // Rifle
  1: "Sniper",         // Sniper
  2: "RocketLauncher", // Rocket
};

// Target size (largest dimension, in character-local units) per weapon id.
export const HELD_WEAPON_LEN: Record<number, number> = { 0: 0.9, 1: 1.15, 2: 1.1 };

// Extract one template Object3D per weapon id from the soldier GLTF (null per id on failure).
// SkinnedMeshes are rebuilt as plain Meshes (geometry is in bind pose — fine for a held prop).
export function extractWeaponTemplates(soldier: GLTF | null): (THREE.Object3D | null)[] {
  const out: (THREE.Object3D | null)[] = [null, null, null];
  if (!soldier) return out;
  for (const idStr of Object.keys(WEAPON_MESH_NAMES)) {
    const id = Number(idStr);
    const want = WEAPON_MESH_NAMES[id]!.toLowerCase();
    let found: THREE.Mesh | null = null;
    soldier.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!found && mesh.isMesh && mesh.name.toLowerCase() === want) found = mesh;
    });
    if (!found) continue;
    const src = found as THREE.Mesh;
    const mesh = new THREE.Mesh(src.geometry, src.material); // un-skinned copy, bind pose
    const holder = new THREE.Group();
    holder.add(mesh);
    // Center on the origin and normalize the largest dimension to the per-weapon length.
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const s = HELD_WEAPON_LEN[id]! / (Math.max(size.x, size.y, size.z) || 1);
    mesh.scale.setScalar(s);
    mesh.position.set(-center.x * s, -center.y * s, -center.z * s);
    holder.traverse((o) => { o.userData["noHit"] = true; (o as THREE.Mesh).castShadow = true; });
    out[id] = holder;
  }
  return out;
}
```

- [ ] **Step 4: Load the soldier GLB in `src/assets.ts`**
  - Add `| "soldier"` to `GltfKey`, `soldier: GLTF | null;` to `AssetRegistry`,
    `soldier: "/models/character_soldier.glb",` to `FILES`, and `soldier: null,` to the
    `reg` initializer in `loadAssets`.

- [ ] **Step 5: Run** `npx vitest run test/armory.test.ts` and `npm run typecheck` → PASS
- [ ] **Step 6: Commit** `git add src/armory.ts src/assets.ts test/armory.test.ts && git commit -m "feat: armory — extract AK/Sniper/RocketLauncher held-weapon templates from soldier GLB"`

---

### Task 5: RemotePlayer holds its weapon (Wrist.R socket) + directional locomotion + death anim

**Files:**
- Modify: `src/player.ts` (RemotePlayer)
- Modify: `src/main.ts` (templates into ensureRemote; `setWeapon` from snap; kill handler plays death)
- Test: covered by Tasks 1/3 pure tests + visual verification (Task 6); `npm test` must stay green.

- [ ] **Step 1: RemotePlayer constructor takes weapon templates and sockets the default**

In `src/player.ts`, change the constructor signature and add fields:

```ts
  private wrist: THREE.Object3D | null = null; // Wrist.R bone — held-weapon socket
  private heldWeapon: THREE.Object3D | null = null;
  private heldId = -1;
  private velocity: Vec3 = [0, 0, 0];
  private yaw = 0;
  private deadAt = 0; // performance.now() of death-anim start (0 = alive)

  constructor(id: number, name: string, character: GLTF | null,
              private weaponTemplates: readonly (THREE.Object3D | null)[] = []) {
```

Inside the `if (character)` block, after the mixer/aliases are set up, locate the wrist:

```ts
      // Held-weapon socket: the SWAT rig's right wrist. Name match is fuzzy so a future
      // character swap (different naming) degrades to "no held gun" instead of crashing.
      model.traverse((o) => {
        if (!this.wrist && /wrist.*r$/i.test(o.name.replace(/\s/g, ""))) this.wrist = o;
      });
      this.setWeapon(0);
```

Add the methods:

```ts
  // Swap the held weapon mesh (driven by PlayerSnap.w). Clones the armory template into
  // the wrist socket with a per-weapon grip offset (tuned visually).
  setWeapon(id: number): void {
    if (id === this.heldId || !this.wrist) return;
    this.heldId = id;
    if (this.heldWeapon) { this.wrist.remove(this.heldWeapon); this.heldWeapon = null; }
    const tpl = this.weaponTemplates[id];
    if (!tpl) return;
    this.heldWeapon = tpl.clone(true);
    // Grip offset/rotation in wrist-bone space (bone scale ≈ character scale): tuned in Task 6.
    this.heldWeapon.position.set(HELD_POS[id]?.[0] ?? 0, HELD_POS[id]?.[1] ?? 0.05, HELD_POS[id]?.[2] ?? 0.1);
    this.heldWeapon.rotation.set(HELD_ROT[id]?.[0] ?? 0, HELD_ROT[id]?.[1] ?? Math.PI / 2, HELD_ROT[id]?.[2] ?? 0);
    this.wrist.add(this.heldWeapon);
  }

  // Death (spec item 3): play the Death clip once; update() hides the body when it ends.
  playDeath(): void {
    if (this.deadAt) return;
    this.deadAt = performance.now();
    this.nameplate.visible = false;
    this.healthBar.visible = false;
    this.parachute.visible = false;
    const death = this.actions["Death"];
    if (death) {
      death.reset();
      death.setLoop(THREE.LoopOnce, 1);
      death.clampWhenFinished = true;
      if (this.current) this.current.crossFadeTo(death, 0.1, false);
      death.play();
      this.current = death;
    } else {
      this.group.visible = false; // no clip → old instant-vanish behavior
    }
  }
```

Module-scope tuning constants (top of `src/player.ts`, after `PLAYER_HEIGHT`):

```ts
// Held-weapon grip offsets in wrist-bone space, per weapon id (tuned visually).
const HELD_POS: Record<number, [number, number, number]> = {
  0: [0, 0.06, 0.12], 1: [0, 0.06, 0.16], 2: [0, 0.1, 0.05],
};
const HELD_ROT: Record<number, [number, number, number]> = {
  0: [0, Math.PI / 2, 0], 1: [0, Math.PI / 2, 0], 2: [0, Math.PI / 2, 0],
};
```

- [ ] **Step 2: Death-clip alias + gun-pose aliases**

In the alias block of the constructor add (the SWAT clip names are
`CharacterArmature|Idle_Gun` etc., so substring matching works):

```ts
      alias("Idle_Gun", find("idle_gun"));
      alias("Idle_Gun_Shoot", find("idle_gun_shoot"));
      alias("Run_Shoot", find("run_shoot"));
      alias("Run_Back", find("run_back"));
      alias("Run_Left", find("run_left"));
      alias("Run_Right", find("run_right"));
      alias("Run", find("run"));
      alias("Death", find("death"));
      this.current = this.actions["Idle_Gun"] ?? this.actions["Idle"] ?? null;
```

NOTE: `alias()` skips keys that already exist, and `find("run")` would match `Run_Back`
first (clip order) — so alias the specific names BEFORE the bare `Run`, and change the
`Run` line to use an exact-name match:

```ts
      const findExact = (suffix: string): THREE.AnimationClip | undefined =>
        clips.find((c) => c.name.toLowerCase().endsWith(`|${suffix}`) || c.name.toLowerCase() === suffix);
      alias("Run", findExact("run") ?? find("run"));
      alias("Idle_Gun", findExact("idle_gun") ?? find("idle_gun"));
```
(Apply `findExact` to all seven locomotion keys above for safety.)

- [ ] **Step 3: Drive locomotion from velocity + yaw in `update()`**

Replace the `setVelocity` body and the mixer block of `update()`:

```ts
  setVelocity(v: Vec3): void {
    this.velocity = v;
    this.speedXZ = Math.hypot(v[0], v[2]);
  }
```

```ts
  update(nowMs: number, dtMs: number): void {
    const sample = sampleBuffer(this.buffer, nowMs - INTERP_DELAY_MS);
    if (sample && !this.deadAt) {
      const eye = this.crouching ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
      this.group.position.set(sample.p[0], sample.p[1] - eye, sample.p[2]);
      this.group.rotation.y = sample.r[0];
      this.yaw = sample.r[0];
    }
    if (this.mixer) {
      if (this.deadAt) {
        // Death clip plays out (~1s), then the body vanishes until respawn.
        if (nowMs - this.deadAt > 1400) this.group.visible = false;
      } else {
        const shooting = nowMs < this.shootingUntil;
        const want = pickLocomotion(this.velocity[0], this.velocity[2], this.yaw, shooting);
        const next = this.actions[want.clip] ?? this.actions[want.clip.startsWith("Idle") ? "Idle" : "Running"];
        if (next) {
          next.timeScale = want.timeScale;
          if (next !== this.current) {
            next.reset().play();
            if (this.current) this.current.crossFadeTo(next, 0.15, false);
            this.current = next;
          }
        }
      }
      this.mixer.update(dtMs / 1000);
    }
  }
```

Update imports in `src/player.ts`: `import { pickLocomotion } from "./anim";` (drop
`pickAnim` once unused). `playShoot()` keeps `shootingUntil` and the positional-audio
contract but drops the Punch overlay:

```ts
  playShoot(): void {
    this.shootingUntil = performance.now() + SHOOT_CUE_MS;
  }
```

`setAlive` revives from the death state:

```ts
  setAlive(alive: boolean): void {
    this.group.visible = alive;
    if (alive) {
      this.deadAt = 0;
      this.nameplate.visible = true;
      this.healthBar.visible = true;
      const idle = this.actions["Idle_Gun"] ?? this.actions["Idle"];
      if (idle) { idle.reset().play(); this.current = idle; }
    }
  }
```

- [ ] **Step 4: Wire `src/main.ts`**
  - After assets load (where `reg` exists, before `ensureRemote` is defined), build the
    templates once: `const weaponTemplates = extractWeaponTemplates(reg.soldier);`
    (import from `./armory`).
  - `ensureRemote`: `rp = new RemotePlayer(ps.id, ps.name, reg.character, weaponTemplates);`
  - In the `net.on("snap")` per-player loop (where `setCrouch`/`setParachute` are driven):
    `rp.setWeapon(ps.w ?? 0);`
  - In `net.on("kill")`: replace `remotes.get(m.on)?.setAlive(false);` with

```ts
    const victimRp = remotes.get(m.on);
    if (victimRp) { if (m.blast) victimRp.setAlive(false); else victimRp.playDeath(); }
```
  (gibs keep the instant vanish; the blood gib FX already covers it).

- [ ] **Step 5: Run** `npm test` and `npm run typecheck` → PASS; fix any import fallout
      (`pickAnim` may now be unused in player.ts — remove the import; keep the function +
      its tests in anim.ts only if still referenced elsewhere, else delete both).
- [ ] **Step 6: Commit** `git add src/player.ts src/main.ts src/anim.ts test/anim.test.ts && git commit -m "feat: remotes hold their weapon, directional locomotion, death animation"`

---

### Task 6: Visual verification + grip/mirror tuning

**Files:**
- Modify (tuning only): `src/player.ts` (HELD_POS/HELD_ROT), `src/anim.ts` (left/right mirror if needed)

- [ ] **Step 1: Build + run the Node target**

```bash
npm run build:node
PORT=8217 node dist/server/index.js
```

- [ ] **Step 2: In the browser (chrome-devtools MCP):** join `?room=tuning` with 3 bots,
      ready up, and screenshot bots: (a) standing — gun in hand at a believable grip,
      (b) running — feet match ground speed, (c) strafing bot — correct left/right clip
      (if mirrored, swap the `Run_Left`/`Run_Right` returns in `pickLocomotion` and
      update its two strafe tests), (d) kill a bot — death animation plays, body sinks.
- [ ] **Step 3: Iterate `HELD_POS`/`HELD_ROT` until the grip reads naturally** (typically
      2–3 rebuild+screenshot rounds; only `build:client` is needed per round).
- [ ] **Step 4: Full suite** `npm test && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `git add -A && git commit -m "polish: tune held-weapon grips + strafe mirroring from visual check"`

---

### Task 7: Push + PR

- [ ] **Step 1:** `git push -u origin feat/player-anim-weapons`
- [ ] **Step 2:** `gh pr create` — title
      `feat: third-person overhaul — held weapons, directional animation, death anim, smooth interp`,
      body summarizing spec items 1–4, screenshots from Task 6, test counts, and a note that
      `InMsg.w` is display-only (no combat meaning; server clamps).
