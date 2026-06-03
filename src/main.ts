// src/main.ts — bootstrap: nickname screen, read ?room, connect Net (name in WS query),
// build the scene, run the rAF game loop, and route server messages to players/HUD/SFX.
import * as THREE from "three";
import {
  MAX_HP,
  INTERP_DELAY_MS,
  CLIENT_SEND_MS,
  EYE_HEIGHT,
  sanitizeRoom,
  sanitizeName,
} from "../worker/protocol";
import type {
  WelcomeMsg,
  SnapMsg,
  HitMsg,
  KillMsg,
  SpawnMsg,
  LeaveMsg,
  PlayerSnap,
} from "../worker/protocol";
import { Net } from "./net";
import { buildArena } from "./map";
import { buildOctree } from "./physics";
import { FpsControls } from "./controls";
import { LocalPlayer, RemotePlayer } from "./player";
import { wireShooting } from "./combat";
import { Hud } from "./hud";
import { Sfx } from "./audio";

// ---- nickname entry screen --------------------------------------------------

function showNicknameScreen(): Promise<string> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:14px;background:#111;color:#fff;font-family:monospace;z-index:100;";
    overlay.innerHTML =
      '<h1 style="margin:0">CF-FPS</h1>' +
      '<p style="opacity:.7;margin:0">Enter a nickname and press Play.</p>';
    const input = document.createElement("input");
    input.maxLength = 16;
    input.placeholder = "nickname";
    input.value = localStorage.getItem("cf-fps-name") ?? "";
    input.style.cssText = "font:16px monospace;padding:8px 10px;width:220px;text-align:center;";
    const btn = document.createElement("button");
    btn.textContent = "Play";
    btn.style.cssText = "font:16px monospace;padding:8px 22px;cursor:pointer;";
    overlay.appendChild(input);
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
    input.focus();

    const submit = (): void => {
      const name = sanitizeName(input.value);
      localStorage.setItem("cf-fps-name", name);
      overlay.remove();
      resolve(name);
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  });
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const name = await showNicknameScreen();

  const params = new URLSearchParams(location.search);
  const room = sanitizeRoom(params.get("room") ?? undefined);

  // Renderer + canvas (#game from index.html).
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Scene + lights.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a7c0);
  scene.fog = new THREE.Fog(0x87a7c0, 40, 90);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(20, 40, 10);
  scene.add(sun);

  // Camera (rides the capsule top at EYE_HEIGHT).
  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
  );
  camera.position.set(0, EYE_HEIGHT, 0);

  // Arena geometry + collision octree.
  const arena = buildArena();
  scene.add(arena.visual);
  const octree = buildOctree(arena.collision);

  // Controls, HUD, SFX. LocalPlayer is created once we know our id (on welcome).
  const controls = new FpsControls(camera, renderer.domElement, octree);
  const hud = new Hud();
  const sfx = new Sfx();
  let local: LocalPlayer | undefined;

  // Reflect pointer-lock state into the HUD and unlock audio on first lock (user gesture).
  controls.onLockChange((locked: boolean) => {
    hud.setLocked(locked);
    if (locked) sfx.unlock();
  });

  // Click the canvas (while not locked) to engage pointer lock.
  renderer.domElement.addEventListener("click", () => {
    if (!controls.isLocked) controls.lock();
  });

  // Remote players registry + the latest snapshot's player list (kill-feed names + scoreboard).
  const remotes = new Map<number, RemotePlayer>();
  let myId = -1;

  function ensureRemote(ps: PlayerSnap): RemotePlayer {
    let rp = remotes.get(ps.id);
    if (rp === undefined) {
      rp = new RemotePlayer(ps.id, ps.name, null);
      scene.add(rp.group);
      remotes.set(ps.id, rp);
    }
    return rp;
  }

  // ---- networking (name travels in the WS URL query — D5) -------------------

  const net = new Net(room, name);

  net.on("welcome", (m: WelcomeMsg) => {
    myId = m.id;
    local = new LocalPlayer(myId);
    hud.setMyId(myId);
    for (const ps of m.players) {
      if (ps.id !== myId) ensureRemote(ps);
    }
  });

  net.on("snap", (m: SnapMsg) => {
    hud.setPlayers(m.players);
    for (const ps of m.players) {
      if (ps.id === myId) {
        hud.setHealth(ps.hp);
        // Reconcile local prediction against the server POSITION only (never rotation).
        if (local !== undefined) {
          const snapped = local.reconcile(controls.getPosition(), ps.p);
          if (snapped) controls.setPosition(snapped);
        }
      } else {
        const rp = ensureRemote(ps);
        rp.addSnapshot({ t: m.ts, p: ps.p, r: ps.r });
      }
    }
  });

  net.on("hit", (m: HitMsg) => {
    if (m.on === myId) hud.setHealth(m.hp);
    if (m.by === myId) {
      hud.flashHitMarker();
      sfx.hit();
    }
  });

  net.on("kill", (m: KillMsg) => {
    hud.addKill(m);
    if (m.on === myId) sfx.death();
  });

  net.on("spawn", (m: SpawnMsg) => {
    if (m.id === myId) {
      hud.setHealth(MAX_HP);
      controls.setPosition(m.p);
    }
  });

  net.on("leave", (m: LeaveMsg) => {
    const rp = remotes.get(m.id);
    if (rp !== undefined) {
      scene.remove(rp.group);
      rp.dispose();
      remotes.delete(m.id);
    }
  });

  // ---- shooting (single owner: combat.wireShooting — D15) -------------------

  wireShooting({
    camera,
    dom: renderer.domElement,
    getTargets: () => [...remotes.values()].map((rp) => rp.body),
    isLocked: () => controls.isLocked,
    nextSeq: () => (local ? local.nextSeq() : 0),
    send: (m) => net.send(m),
    onLocalShoot: (hit) => {
      sfx.shoot();
      if (hit) hud.flashHitMarker();
    },
  });

  // ---- resize --------------------------------------------------------------

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- game loop -----------------------------------------------------------

  let lastFrame = performance.now();
  let sendAccum = 0;

  function sendInputIfDue(accum: number, dtMs: number): number {
    const a = accum + dtMs;
    if (a >= CLIENT_SEND_MS && controls.isLocked && local !== undefined) {
      const msg = local.buildInput(
        controls.getPosition(),
        controls.getRotation(),
        controls.getVelocity(),
        Date.now(),
      );
      net.send(msg);
      return 0;
    }
    return a;
  }

  function frame(): void {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000); // clamp after tab-switches
    lastFrame = now;

    // Local predicted movement.
    controls.update(dt);

    // Send InMsg at CLIENT_SEND_MS cadence (NOT per frame) — exactly one cadence line.
    sendAccum = sendInputIfDue(sendAccum, dt * 1000);

    // Interpolate remote players ~INTERP_DELAY_MS in the past.
    const renderTime = Date.now() - INTERP_DELAY_MS;
    for (const rp of remotes.values()) rp.update(renderTime, dt * 1000);

    // HUD upkeep (prune expired kill-feed lines).
    hud.renderKillFeed();

    renderer.render(scene, camera);
  }

  frame();
}

void main();
