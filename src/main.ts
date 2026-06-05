// src/main.ts — bootstrap: nickname screen, read ?room, connect Net (name in WS query),
// build the scene, run the rAF game loop, and route server messages to players/HUD/SFX.
import * as THREE from "three";
import {
  MAX_HP,
  RESPAWN_MS,
  CLIENT_SEND_MS,
  EYE_HEIGHT,
  ST_DEAD,
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
  MatchStartMsg,
  MatchOverMsg,
  LobbyMsg,
  LobbyPlayer,
  GrenadeMsg,
  PickupMsg,
  BarrelMsg,
} from "../worker/protocol";
import { Net } from "./net";
import { buildArena } from "./map";
import { buildOctree } from "./physics";
import { FpsControls } from "./controls";
import { LocalPlayer, RemotePlayer } from "./player";
import { WeaponController } from "./weapons";
import { Grenades } from "./projectiles";
import { AmmoPickups } from "./pickups";
import { Barrels } from "./barrels";
import { Hud } from "./hud";
import { Sfx } from "./audio";
import { loadAssets } from "./assets";
import { Viewmodel } from "./viewmodel";

// ---- nickname entry screen --------------------------------------------------

function randomRoomCode(): string {
  return Math.random().toString(36).slice(2, 7);
}

function showStartScreen(): Promise<{ name: string; room: string }> {
  return new Promise((resolve) => {
    const initialRoom = sanitizeRoom(new URLSearchParams(location.search).get("room") ?? undefined);
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;" +
      "justify-content:center;gap:12px;background:#111;color:#fff;font-family:monospace;z-index:100;";
    overlay.innerHTML =
      '<h1 style="margin:0">CF-FPS</h1>' +
      '<p style="opacity:.7;margin:0;max-width:360px;text-align:center">' +
      "Pick a name. Leave the room blank for Quick Play, or enter / create a code for a private room.</p>";

    const inputCss = "font:16px monospace;padding:8px 10px;width:240px;text-align:center;";
    const nameInput = document.createElement("input");
    nameInput.maxLength = 16;
    nameInput.placeholder = "nickname";
    nameInput.value = localStorage.getItem("cf-fps-name") ?? "";
    nameInput.style.cssText = inputCss;

    const roomInput = document.createElement("input");
    roomInput.maxLength = 24;
    roomInput.placeholder = "room code (blank = public)";
    roomInput.value = initialRoom === "public" ? "" : initialRoom;
    roomInput.style.cssText = inputCss;

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:280px;";
    const btnCss = "font:14px monospace;padding:8px 14px;cursor:pointer;";
    const createBtn = document.createElement("button");
    createBtn.textContent = "Create random room";
    createBtn.style.cssText = btnCss;
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy invite link";
    copyBtn.style.cssText = btnCss;
    const playBtn = document.createElement("button");
    playBtn.textContent = "Play";
    playBtn.style.cssText = "font:16px monospace;padding:8px 28px;cursor:pointer;background:#3c9;border:none;color:#062;";
    btnRow.appendChild(createBtn);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(playBtn);

    const note = document.createElement("div");
    note.style.cssText = "font-size:13px;opacity:.7;height:16px";

    overlay.appendChild(nameInput);
    overlay.appendChild(roomInput);
    overlay.appendChild(btnRow);
    overlay.appendChild(note);
    document.body.appendChild(overlay);
    nameInput.focus();

    const linkFor = (): string => {
      const r = sanitizeRoom(roomInput.value || undefined);
      return `${location.origin}/?room=${r}`;
    };
    createBtn.addEventListener("click", () => {
      roomInput.value = randomRoomCode();
      note.textContent = `Room ${roomInput.value} — share the invite link!`;
    });
    copyBtn.addEventListener("click", () => {
      const link = linkFor();
      void navigator.clipboard?.writeText(link);
      note.textContent = `Copied: ${link}`;
    });

    const submit = (): void => {
      const name = sanitizeName(nameInput.value);
      const room = sanitizeRoom(roomInput.value || undefined);
      localStorage.setItem("cf-fps-name", name);
      // Reflect the room in the URL so a refresh / shared link keeps it.
      history.replaceState(null, "", room === "public" ? location.pathname : `?room=${room}`);
      overlay.remove();
      resolve({ name, room });
    };
    playBtn.addEventListener("click", submit);
    for (const el of [nameInput, roomInput]) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
    }
  });
}

// Full-screen loading overlay shown while CC0 assets preload (progress bar + label).
function showLoading(): { update: (loaded: number, total: number, label: string) => void; done: () => void } {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:50;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:18px;background:#0b1020;color:#cfe;font-family:monospace";
  const title = document.createElement("div");
  title.textContent = "CF-FPS";
  title.style.cssText = "font-size:42px;font-weight:bold;letter-spacing:3px";
  const barOuter = document.createElement("div");
  barOuter.style.cssText =
    "width:320px;height:14px;border:1px solid #2a3a5a;border-radius:7px;overflow:hidden;background:#10162c";
  const barInner = document.createElement("div");
  barInner.style.cssText = "height:100%;width:0%;background:linear-gradient(90deg,#3ad6ff,#6fffa0);transition:width .12s";
  barOuter.appendChild(barInner);
  const label = document.createElement("div");
  label.style.cssText = "font-size:13px;opacity:.8";
  label.textContent = "Loading…";
  overlay.appendChild(title);
  overlay.appendChild(barOuter);
  overlay.appendChild(label);
  document.body.appendChild(overlay);
  return {
    update: (loaded, total, lbl) => {
      const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
      barInner.style.width = `${pct}%`;
      label.textContent = `Loading assets… ${pct}%  ·  ${lbl}`;
    },
    done: () => overlay.remove(),
  };
}

// Ready-up lobby overlay: roster + ready states + a Ready toggle. The match starts
// (server-side) only when every connected player is ready.
function makeLobby(onReady: (ready: boolean) => void): {
  show: () => void;
  hide: () => void;
  render: (players: LobbyPlayer[], myId: number, matchActive: boolean) => void;
} {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:25;display:none;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:16px;background:#0b1020;color:#dfe;font-family:monospace";
  const title = document.createElement("div");
  title.textContent = "LOBBY";
  title.style.cssText = "font-size:34px;font-weight:bold;letter-spacing:3px";
  const list = document.createElement("div");
  list.style.cssText = "min-width:300px;display:flex;flex-direction:column;gap:6px;font-size:16px";
  const status = document.createElement("div");
  status.style.cssText = "font-size:13px;opacity:.85;height:18px";
  const btn = document.createElement("button");
  btn.style.cssText =
    "margin-top:8px;padding:12px 30px;font-family:monospace;font-size:18px;font-weight:bold;" +
    "border:0;border-radius:8px;cursor:pointer;background:#2ecc71;color:#06210f";
  overlay.appendChild(title);
  overlay.appendChild(list);
  overlay.appendChild(status);
  overlay.appendChild(btn);
  document.body.appendChild(overlay);

  let myReady = false;
  let canReady = true;
  btn.addEventListener("click", () => {
    if (!canReady) return;
    myReady = !myReady;
    onReady(myReady);
  });

  return {
    show: () => { overlay.style.display = "flex"; },
    hide: () => { overlay.style.display = "none"; },
    render: (players, myId, matchActive) => {
      list.innerHTML = "";
      for (const p of players) {
        const row = document.createElement("div");
        row.textContent = `${p.name}${p.id === myId ? " (you)" : ""}  —  ${p.ready ? "✓ ready" : "· not ready"}`;
        row.style.color = p.ready ? "#7CFC9A" : "#cfd6e6";
        list.appendChild(row);
      }
      myReady = players.find((p) => p.id === myId)?.ready ?? false;
      const readyCount = players.filter((p) => p.ready).length;
      if (matchActive) {
        canReady = false;
        btn.textContent = "Match in progress…";
        btn.style.background = "#566677";
        btn.style.cursor = "default";
        status.textContent = "A match is running — you'll join the next one.";
      } else {
        canReady = true;
        btn.textContent = myReady ? "Cancel ready" : "Ready";
        btn.style.background = myReady ? "#e67e22" : "#2ecc71";
        btn.style.cursor = "pointer";
        status.textContent = `${readyCount}/${players.length} ready — match starts when everyone is ready.`;
      }
    },
  };
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const { name, room } = await showStartScreen();
  const loading = showLoading();

  // Renderer + canvas (#game from index.html).
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Scene + sky + lights (v1.1 — replaced v1 flat ambient/basic lighting).
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4e8);
  scene.fog = new THREE.Fog(0x9fc4e8, 160, 340);
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a5a3a, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.1);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -95; sun.shadow.camera.right = 95;
  sun.shadow.camera.top = 95; sun.shadow.camera.bottom = -95;
  sun.shadow.camera.far = 300;
  scene.add(sun);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // Camera (rides the capsule top at EYE_HEIGHT). Must be in the scene for viewmodel to render.
  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    500,
  );
  camera.position.set(0, EYE_HEIGHT, 0);
  scene.add(camera); // REQUIRED so the camera-attached viewmodel renders

  // Load CC0 GLB assets before starting the game (progress shown on the loading overlay).
  const reg = await loadAssets((l, t, lbl) => loading.update(l, t, lbl));

  // Arena geometry + collision octree.
  const arena = buildArena(reg);
  scene.add(arena.visual);
  const octree = buildOctree(arena.collision);
  loading.done(); // assets + arena ready — reveal the game

  // Controls, HUD, SFX. LocalPlayer is created once we know our id (on welcome).
  const controls = new FpsControls(camera, renderer.domElement, octree, arena.ladders);
  const hud = new Hud();
  const sfx = new Sfx();
  let local: LocalPlayer | undefined;

  // First-person viewmodel: gun + procedural arms gripping it (#6).
  const viewmodel = new Viewmodel(camera, reg.gun);

  // Thrown-grenade visuals + explosion FX (damage is server-authoritative via HitMsg).
  const grenades = new Grenades(scene, reg.grenade, () => sfx.explosion());

  // Ammo crate pickups (server-authoritative refill; this renders + animates the crates).
  const pickups = new AmmoPickups(scene);

  // Explosive barrels (shoot to detonate; server validates + applies AoE).
  const barrels = new Barrels(scene, reg.barrel);

  // Death state tracking.
  let deadUntil = 0;

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
  let latestSnap: PlayerSnap[] = [];
  let matchEndsAt = 0;     // server epoch ms the match ends (0 = no active match)
  let latestSnapTs = 0;    // server clock from the latest snap (skew-free timer reference)
  let phase: "lobby" | "match" = "lobby"; // start in the ready-up lobby
  let shootHandle: WeaponController | undefined; // weapons / ammo / reload / ADS owner

  function nameOf(id: number): string {
    return latestSnap.find((p) => p.id === id)?.name ?? "";
  }

  function ensureRemote(ps: PlayerSnap): RemotePlayer {
    let rp = remotes.get(ps.id);
    if (rp === undefined) {
      rp = new RemotePlayer(ps.id, ps.name, reg.character);
      scene.add(rp.group);
      remotes.set(ps.id, rp);
    }
    return rp;
  }

  // ---- networking (name travels in the WS URL query — D5) -------------------

  const net = new Net(room, name);
  const lobby = makeLobby((ready: boolean) => net.send({ t: "ready", ready }));

  net.on("welcome", (m: WelcomeMsg) => {
    myId = m.id;
    local = new LocalPlayer(myId);
    hud.setMyId(myId);
    matchEndsAt = m.matchEndsAt;
    for (const ps of m.players) {
      if (ps.id !== myId) ensureRemote(ps);
    }
    // New players land in the ready-up lobby (no auto-spawn). The "lobby" message follows.
    phase = "lobby";
    lobby.show();
  });

  net.on("lobby", (m: LobbyMsg) => {
    lobby.render(m.players, myId, m.matchActive);
    if (phase === "lobby") lobby.show();
  });

  net.on("snap", (m: SnapMsg) => {
    latestSnap = m.players;
    latestSnapTs = m.ts;
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
        rp.setAlive(ps.st !== ST_DEAD); // dead players are hidden instantly
        rp.addSnapshot({ t: m.ts, p: ps.p, r: ps.r });
        rp.setVelocity(ps.v);
        rp.setHealth(ps.hp);
        rp.setCrouch(ps.c ?? false);
      }
    }
  });

  net.on("hit", (m: HitMsg) => {
    if (m.on === myId) hud.setHealth(m.hp);
    if (m.by === myId) {
      hud.flashHitMarker();
      sfx.hit();
    }
    // Trigger shoot cue on the remote who fired.
    remotes.get(m.by)?.playShoot();
  });

  net.on("kill", (m: KillMsg) => {
    hud.addKill(m);
    if (m.on === myId) {
      sfx.death();
      hud.showDeath(nameOf(m.by));
      deadUntil = performance.now() + RESPAWN_MS;
    }
    // The victim vanishes immediately (don't wait for the next snapshot).
    remotes.get(m.on)?.setAlive(false);
    // Trigger shoot cue on the remote who got the kill.
    remotes.get(m.by)?.playShoot();
  });

  net.on("spawn", (m: SpawnMsg) => {
    if (m.id === myId) {
      hud.setHealth(MAX_HP);
      hud.hideDeath();
      controls.setPosition(m.p);
      shootHandle?.reset(); // refill magazine + reserve on (re)spawn
    } else {
      // A remote respawned: reappear at the spawn point (no slide from the death spot).
      const rp = remotes.get(m.id);
      if (rp !== undefined) {
        rp.resetTo(m.p);
        rp.setAlive(true);
      }
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

  net.on("grenade", (m: GrenadeMsg) => {
    grenades.spawn(m.o, m.v, m.fuseMs);
  });

  net.on("pickup", (m: PickupMsg) => {
    pickups.setAvailable(m.id, false);
    setTimeout(() => pickups.setAvailable(m.id, true), Math.max(0, m.availableAt - Date.now()));
    if (m.by === myId) { shootHandle?.refillReserve(); sfx.pickup(); }
  });

  net.on("barrel", (m: BarrelMsg) => {
    barrels.setAvailable(m.id, false);
    grenades.blast(m.pos); // explosion FX + sound at the barrel
    setTimeout(() => barrels.setAvailable(m.id, true), Math.max(0, m.respawnAt - Date.now()));
  });

  net.on("matchstart", (m: MatchStartMsg) => {
    matchEndsAt = m.endsAt;
    phase = "match";
    lobby.hide();
    hud.hideResults();
    hud.hideDeath();
    deadUntil = 0;
    pickups.showAll();
    barrels.showAll();
  });

  net.on("matchover", (m: MatchOverMsg) => {
    matchEndsAt = 0; // stop the countdown
    deadUntil = 0;
    phase = "lobby";
    hud.hideDeath();
    controls.unlock(); // free the cursor for the lobby
    lobby.show();      // the lobby sits behind the results board (server also resent "lobby")
    // Results board on top; closing it reveals the lobby to ready up for the next match.
    hud.showResults(m.standings, myId, () => hud.hideResults());
  });

  // ---- weapons (fire / reload / switch / ADS — single owner) ----------------

  shootHandle = new WeaponController({
    camera,
    dom: renderer.domElement,
    getTargets: () => [...[...remotes.values()].map((rp) => rp.body), ...barrels.getTargets()],
    isLocked: () => controls.isLocked,
    nextSeq: () => (local ? local.nextSeq() : 0),
    send: (m) => net.send(m),
    baseFov: camera.fov,
    onLocalShoot: (hit) => {
      sfx.shoot();
      viewmodel.recoil();
      viewmodel.flash();
      if (hit) hud.flashHitMarker();
    },
    onAmmo: (clip, reserve, reloading) => hud.setAmmo(clip, reserve, reloading),
    onWeapon: (name) => hud.setWeapon(name),
    onScope: (active) => hud.setScope(active),
    sfx: { shoot: () => sfx.shoot(), reload: () => sfx.reload(), dryFire: () => sfx.dryFire() },
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
        controls.isCrouching,
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
    const dtMs = dt * 1000;
    lastFrame = now;

    // Local predicted movement.
    controls.update(dt);

    // Send InMsg at CLIENT_SEND_MS cadence (NOT per frame) — exactly one cadence line.
    sendAccum = sendInputIfDue(sendAccum, dtMs);

    // Update remote players (interpolation + animation mixer). Pass the current epoch
    // time; RemotePlayer.update subtracts INTERP_DELAY_MS itself (don't double-subtract).
    const nowEpoch = Date.now();
    for (const rp of remotes.values()) rp.update(nowEpoch, dtMs);
    grenades.update(dt);
    pickups.update(dt, nowEpoch);

    // Update viewmodel (recoil ease + muzzle flash).
    viewmodel.update(dtMs);

    // Death countdown HUD update.
    if (deadUntil > 0) {
      const rem = deadUntil - performance.now();
      hud.updateDeath(rem);
      if (rem <= 0) deadUntil = 0;
    }

    // Match timer (skew-free: server endsAt minus the latest server snapshot time).
    hud.setMatchTime(matchEndsAt > 0 && latestSnapTs > 0 ? matchEndsAt - latestSnapTs : null);

    // HUD upkeep (prune expired kill-feed lines).
    hud.renderKillFeed();

    renderer.render(scene, camera);
  }

  frame();
}

void main();
