// src/main.ts — bootstrap: nickname screen, read ?room, connect Net (name in WS query),
// build the scene, run the rAF game loop, and route server messages to players/HUD/SFX.
import * as THREE from "three";
import {
  MAX_HP,
  RESPAWN_MS,
  CLIENT_SEND_MS,
  EYE_HEIGHT,
  ST_DEAD,
  GRENADE_START,
  STARTING_CREDITS,
  BARREL_RADIUS,
  WEAPONS,
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
  RocketFxMsg,
  ShootFxMsg,
  Vec3,
  WeaponPickupMsg,
  GrenadePickupMsg,
  HealthPickupMsg,
  ArmorPickupMsg,
  SpringPickupMsg,
  ChatMsg,
  BoughtMsg,
} from "../worker/protocol";
import { Net } from "./net";
import { buildArena, MINIMAP_BUILDINGS, ARENA_HALF } from "./map";
import { buildOctree } from "./physics";
import { FpsControls } from "./controls";
import { LocalPlayer, RemotePlayer } from "./player";
import { WeaponController } from "./weapons";
import { Grenades } from "./projectiles";
import { AmmoPickups, GrenadePickups, RocketPickups, HealthPickups, ArmorPickups, SpringPickups } from "./pickups";
import { Barrels } from "./barrels";
import { Blood } from "./blood";
import { Tracers } from "./tracers";
import { Doors } from "./doors";
import { Hud, damageDirectionAngle } from "./hud";
import { settings } from "./settings";
import { buildSettingsPanel, disposeSettingsPanel } from "./settings-ui";
import { Sfx } from "./audio";
import { loadAssets } from "./assets";
import { Viewmodel } from "./viewmodel";

// ---- nickname entry screen --------------------------------------------------

function randomRoomCode(): string {
  return Math.random().toString(36).slice(2, 7);
}

function showStartScreen(): Promise<{ name: string; room: string; bots: number }> {
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

    // Add-bots row: a checkbox + a count (1–11). When checked, the room creator spawns AI bots.
    const botRow = document.createElement("label");
    botRow.style.cssText = "display:flex;align-items:center;gap:8px;font:14px monospace;cursor:pointer;";
    const botToggle = document.createElement("input");
    botToggle.type = "checkbox";
    const botCount = document.createElement("input");
    botCount.type = "number";
    botCount.min = "1";
    botCount.max = "11";
    botCount.value = "3";
    botCount.disabled = true;
    botCount.style.cssText = "width:56px;font:14px monospace;padding:4px 6px;text-align:center;";
    botToggle.addEventListener("change", () => { botCount.disabled = !botToggle.checked; });
    botRow.appendChild(botToggle);
    botRow.append("Add AI bots");
    botRow.appendChild(botCount);

    overlay.appendChild(nameInput);
    overlay.appendChild(roomInput);
    overlay.appendChild(botRow);
    overlay.appendChild(btnRow);
    overlay.appendChild(note);

    // Settings (sensitivity / FOV / volume / keybinds) — persisted now, applied when the game boots.
    const settingsPanel = buildSettingsPanel();
    settingsPanel.style.marginTop = "8px";
    overlay.appendChild(settingsPanel);

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
      const bots = botToggle.checked ? Math.max(1, Math.min(11, Math.floor(Number(botCount.value) || 0))) : 0;
      disposeSettingsPanel(settingsPanel); // detach the panel's key-capture listener
      overlay.remove();
      resolve({ name, room, bots });
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
        const tag = p.ai ? " 🤖" : p.id === myId ? " (you)" : "";
        row.textContent = `${p.name}${tag}  —  ${p.ready ? "✓ ready" : "· not ready"}`;
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
  const { name, room, bots } = await showStartScreen();
  const loading = showLoading();

  // Renderer + canvas (#game from index.html).
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Scene + sky + lights — haunted Cold-War overcast dusk: dark desaturated gray-green sky,
  // dense cold fog, dim cold hemisphere fill, and a low pale sun for long oppressive shadows.
  const scene = new THREE.Scene();
  const SKY = 0x343a3a;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 50, 230);
  const hemi = new THREE.HemisphereLight(0x5a6a72, 0x24261f, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xb8b6a4, 0.6); // low pale cold sun
  sun.position.set(40, 26, 26);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -120; sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
  sun.shadow.camera.far = 360;
  scene.add(sun);
  // A faint cold ambient so deep shadows / interiors don't crush to pure black.
  scene.add(new THREE.AmbientLight(0x3a4248, 0.35));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // Camera (rides the capsule top at EYE_HEIGHT). Must be in the scene for viewmodel to render.
  const camera = new THREE.PerspectiveCamera(
    settings.fov, // persisted field-of-view (WeaponController captures this as baseFov below)
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
  // The collision group isn't added to the scene; update its world matrices once so the rocket
  // impact raycast (which casts against this static geometry) sees correct transforms.
  arena.collision.updateMatrixWorld(true);
  loading.done(); // assets + arena ready — reveal the game

  // Controls, HUD, SFX. LocalPlayer is created once we know our id (on welcome).
  const controls = new FpsControls(camera, renderer.domElement, octree, arena.ladders);
  const hud = new Hud();
  const sfx = new Sfx();
  sfx.setVolume(settings.masterVolume); // apply persisted master volume (sensitivity is applied inside FpsControls)
  let local: LocalPlayer | undefined;

  // Hard landings claim fall damage from the server + kick the camera.
  controls.onFall((dmg) => {
    net.send({ t: "fall", dmg });
    sfx.hit();
  });

  // Footsteps (#21): the stride timer fires this while the local player is grounded + moving.
  controls.onStep(() => sfx.footstep());

  // Suspend audio when the tab is backgrounded so no SFX plays out of view (resume on return).
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) sfx.suspend();
    else sfx.resume();
  });

  // First-person viewmodel: weapon + procedural arms gripping it.
  const viewmodel = new Viewmodel(camera, reg.gun);

  // Thrown-grenade visuals + explosion FX. Every blast (grenade/rocket/barrel) funnels through
  // this callback, so it also shakes the camera when the detonation is near the local player.
  const grenades = new Grenades(scene, reg.grenade, (p) => {
    sfx.explosion();
    const me = controls.getPosition();
    const d = Math.hypot(p[0] - me[0], p[1] - me[1], p[2] - me[2]);
    if (d < 22) controls.addShake(0.5 * (1 - d / 22));
  });

  // Ammo crate pickups (server-authoritative refill; this renders + animates the crates).
  const pickups = new AmmoPickups(scene);

  // Grenade pickups + rocket launchers (both non-center towers) + health / armor / spring pickups.
  const grenadePickups = new GrenadePickups(scene, reg.grenade);
  const rocketPickups = new RocketPickups(scene);
  const healthPickups = new HealthPickups(scene);
  const armorPickups = new ArmorPickups(scene);
  const springPickups = new SpringPickups(scene);

  // Interactive building doors (open/close with E; closed doors collide via a dynamic octree).
  const doors = new Doors(scene, arena.doors);
  controls.setDoorOctree(doors.getOctree());
  controls.onUse((pos) => {
    const i = doors.nearest(pos);
    if (i >= 0) controls.setDoorOctree(doors.toggle(i));
  });

  // Blood spray on hits + gib pieces on explosion kills.
  const blood = new Blood(scene);

  // Bullet tracers (#67): pooled streaks for local + remote hitscan fire.
  const tracers = new Tracers(scene);
  const _muzzleTmp = new THREE.Vector3();

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
  let clockOffset = 0;     // serverNow ≈ Date.now() + clockOffset (drives pickup respawn timing)
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

  // Play a remote player's shoot cue: the muzzle animation plus a positional gunfire blip at the
  // shooter's world position (#21), so enemy fire is louder/closer-panned when nearby. The local
  // player's own shot SFX is handled non-positionally by WeaponController, so skip self.
  const shootCueAt = new Map<number, number>(); // last cue time per shooter (see guard below)
  function playRemoteShoot(byId: number): void {
    const rp = remotes.get(byId);
    if (rp === undefined) return;
    // A landed shot arrives as BOTH a shootfx (#67) and a hit/kill in the same broadcast batch —
    // cue at most once per shot (the rifle's 120ms cooldown keeps real shots outside the window).
    const now = performance.now();
    if (now - (shootCueAt.get(byId) ?? -1e9) < 60) return;
    shootCueAt.set(byId, now);
    rp.playShoot();
    if (byId !== myId) {
      const p = rp.group.position;
      sfx.positionalShot([p.x, p.y + EYE_HEIGHT, p.z]); // back to eye height (group origin is feet)
    }
  }

  // ---- networking (name travels in the WS URL query — D5) -------------------

  const net = new Net(room, name, bots);
  const lobby = makeLobby((ready: boolean) => net.send({ t: "ready", ready }));

  // Round-trip latency (#18): record the wall-clock send time per input seq; the server echoes
  // the last processed seq in snap.ack, so RTT = now - sentAt[ack]. (ack is a seq, not a clock —
  // and client/server clocks are unsynced — so this is the only correct ping source.)
  const pingSentAt = new Map<number, number>();

  net.on("welcome", (m: WelcomeMsg) => {
    myId = m.id;
    local = new LocalPlayer(myId);
    hud.setMyId(myId);
    matchEndsAt = m.matchEndsAt;
    // On reconnect, dispose any remote players left over from before the drop, then rebuild.
    if (m.rejoin) {
      for (const rp of remotes.values()) { scene.remove(rp.group); rp.dispose(); }
      remotes.clear();
    }
    for (const ps of m.players) {
      if (ps.id !== myId) ensureRemote(ps);
    }
    if (m.rejoin && m.matchEndsAt > 0) {
      // Rejoined an in-progress match: stay in the match (a SpawnMsg repositions us).
      phase = "match";
      lobby.hide();
      hud.hideResults();
    } else {
      // New players land in the ready-up lobby (no auto-spawn). The "lobby" message follows.
      phase = "lobby";
      lobby.show();
    }
  });

  // Reconnect feedback: show a banner the moment the socket drops, hide it once it reopens.
  net.on("close", () => hud.showReconnecting());
  net.on("open", () => hud.hideReconnecting());

  net.on("lobby", (m: LobbyMsg) => {
    lobby.render(m.players, myId, m.matchActive);
    if (phase === "lobby") lobby.show();
  });

  net.on("snap", (m: SnapMsg) => {
    latestSnap = m.players;
    latestSnapTs = m.ts;
    clockOffset = m.ts - Date.now(); // estimate the server clock for skew-free pickup respawns
    hud.setPlayers(m.players);
    for (const ps of m.players) {
      if (ps.id === myId) {
        hud.setHealth(ps.hp);
        hud.setGrenades(ps.g ?? 0);
        hud.setArmor(ps.a ?? 0);
        hud.setCredits(ps.credits ?? 0); // server-authoritative credit balance (issue #25)
        // Keep the buy menu's affordability in sync with the live balance + owned set (issue #26).
        hud.setBuyState(ps.credits ?? 0, shootHandle?.getOwned() ?? []);
        // Latency: ack echoes the last input seq the server processed → RTT = now - its send time.
        const ackSeq = m.ack[myId];
        if (ackSeq !== undefined) {
          const sentAt = pingSentAt.get(ackSeq);
          if (sentAt !== undefined) hud.setPing(Date.now() - sentAt);
          for (const k of pingSentAt.keys()) if (k <= ackSeq) pingSentAt.delete(k); // drop acked + stale
        }
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
        rp.setParachute(ps.pc ?? false);
      }
    }
  });

  net.on("hit", (m: HitMsg) => {
    if (m.on === myId) {
      hud.setHealth(m.hp);
      hud.flashDamage();      // red screen vignette
      controls.addShake(0.12);
      // Directional indicator pointing at the attacker. Skip self-damage and attackers
      // not in the latest snapshot (already dead / left → no position to aim at).
      if (m.by !== myId) {
        const attacker = latestSnap.find((p) => p.id === m.by);
        if (attacker) {
          const angle = damageDirectionAngle(controls.getPosition(), attacker.p, controls.getRotation()[0]);
          hud.flashDamageDirection(angle);
        }
      }
    }
    if (m.by === myId) {
      hud.flashHitMarker();
      sfx.hit();
    }
    // Blood spray at the victim (remote players only — the local player has no mesh).
    const victim = remotes.get(m.on);
    if (victim) {
      const p = victim.group.position;
      blood.spray([p.x, p.y + 1.1, p.z], m.head ? 1.5 : 1);
    }
    // Trigger shoot cue on the remote who fired (animation + positional gunfire SFX).
    playRemoteShoot(m.by);
  });

  net.on("kill", (m: KillMsg) => {
    hud.addKill(m);
    if (m.on === myId) {
      sfx.death();
      hud.showDeath(nameOf(m.by));
      deadUntil = performance.now() + RESPAWN_MS;
      shootHandle?.setAlive(false); // stop the corpse from firing during the respawn window
    }
    // Gib the victim into bloody pieces on an explosion kill; otherwise a final blood spray.
    const victim = remotes.get(m.on);
    if (victim) {
      const p = victim.group.position;
      if (m.blast) blood.gib([p.x, p.y + 0.9, p.z]);
      else blood.spray([p.x, p.y + 1.1, p.z], 1.6);
    }
    // The victim vanishes immediately (don't wait for the next snapshot).
    remotes.get(m.on)?.setAlive(false);
    // Trigger shoot cue on the remote who got the kill (animation + positional gunfire SFX).
    playRemoteShoot(m.by);
  });

  net.on("spawn", (m: SpawnMsg) => {
    if (m.id === myId) {
      hud.setHealth(MAX_HP);
      hud.setGrenades(GRENADE_START); // instant feedback; snapshots then confirm
      hud.setArmor(0);
      hud.hideDeath();
      controls.setPosition(m.p);
      shootHandle?.reset(); // refill magazine + reserve on (re)spawn (also drops the rocket launcher)
      shootHandle?.setAlive(true);
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
    pickups.setTaken(m.id, m.availableAt); // self-managing respawn (no stale setTimeout)
    if (m.by === myId) { shootHandle?.refillReserve(); sfx.pickup(); }
  });

  net.on("barrel", (m: BarrelMsg) => {
    barrels.setTaken(m.id, m.respawnAt);
    grenades.blast(m.pos, BARREL_RADIUS); // explosion FX + sound at the barrel
  });

  net.on("rocketfx", (m: RocketFxMsg) => {
    grenades.spawnRocket(m.o, m.d, m.p, m.travelMs); // render the rocket flying to its blast
  });

  // Another player's hitscan discharge (#67): streak a tracer from near their muzzle along the
  // shot ray. The local player's own tracer is drawn at fire time from the exact viewmodel
  // muzzle, so skip self. Occlusion (depth test) clips the streak at walls naturally.
  net.on("shootfx", (m: ShootFxMsg) => {
    if (m.by === myId) return;
    const range = WEAPONS[m.w]?.maxRange ?? 200;
    // Start just ahead of and below the shooter's reported eye so the streak clears their model.
    const start: Vec3 = [m.o[0] + m.d[0] * 0.8, m.o[1] + m.d[1] * 0.8 - 0.12, m.o[2] + m.d[2] * 0.8];
    const end: Vec3 = [m.o[0] + m.d[0] * range, m.o[1] + m.d[1] * range, m.o[2] + m.d[2] * range];
    tracers.spawn(start, end, m.w);
    playRemoteShoot(m.by); // misses get the muzzle anim + positional crack too (deduped vs hit/kill)
  });

  net.on("weaponpickup", (m: WeaponPickupMsg) => {
    rocketPickups.setTaken(m.id, m.availableAt); // hide the launcher on the specific tower
    if (m.by === myId) { shootHandle?.grantRocket(); sfx.pickup(); }
  });

  net.on("gpickup", (m: GrenadePickupMsg) => {
    grenadePickups.setTaken(m.id, m.availableAt);
    if (m.by === myId) sfx.pickup();
  });

  net.on("hpickup", (m: HealthPickupMsg) => {
    healthPickups.setTaken(m.id, m.availableAt);
    if (m.by === myId) sfx.pickup();
  });

  net.on("apickup", (m: ArmorPickupMsg) => {
    armorPickups.setTaken(m.id, m.availableAt);
    if (m.by === myId) sfx.pickup();
  });

  net.on("sppickup", (m: SpringPickupMsg) => {
    springPickups.setTaken(m.id, m.availableAt);
    if (m.by === myId) { controls.grantSpring(m.durationMs); sfx.pickup(); }
  });

  // Text chat (issue #10): append incoming messages to the HUD log. Opening the input releases
  // pointer lock so typing doesn't drive the camera/fire; closing it re-locks if we were locked
  // (i.e. mid-match) so play resumes seamlessly. The server is authoritative for sender + body.
  net.on("chat", (m: ChatMsg) => hud.addChat(m));
  let wasLockedBeforeChat = false;
  hud.onChat(
    (body) => net.send({ t: "chat", from: myId, name, body }),
    (open) => {
      if (open) {
        wasLockedBeforeChat = controls.isLocked;
        if (controls.isLocked) controls.unlock();
      } else if (wasLockedBeforeChat) {
        controls.lock();
      }
    },
  );

  // Buy menu (issue #26): a confirmed purchase. The server already deducted credits + granted
  // ownership; equip the weapon locally and reflect the new balance immediately (snapshots confirm).
  net.on("bought", (m: BoughtMsg) => {
    shootHandle?.grantWeapon(m.weaponId); // mark owned + switch to it
    hud.setCredits(m.credits);
    hud.setBuyState(m.credits, shootHandle?.getOwned() ?? []);
    sfx.pickup();
  });

  // Wire the buy menu (B): ship the purchase to the server and pause pointer lock while open (so
  // the cursor can click rows), re-locking on close — mirrors the chat input (#10). The server is
  // authoritative for the deduction + grant; the menu only requests.
  let wasLockedBeforeBuy = false;
  hud.onBuy(
    (weaponId) => net.send({ t: "buy", weaponId }),
    (open) => {
      if (open) {
        wasLockedBeforeBuy = controls.isLocked;
        if (controls.isLocked) controls.unlock();
      } else if (wasLockedBeforeBuy) {
        controls.lock();
      }
    },
  );

  net.on("matchstart", (m: MatchStartMsg) => {
    matchEndsAt = m.endsAt;
    phase = "match";
    lobby.hide();
    sfx.stopMusic(); // cut the outro if a new match starts
    hud.hideResults();
    hud.hideDeath();
    deadUntil = 0;
    pickups.showAll();
    grenadePickups.showAll();
    rocketPickups.showAll();
    healthPickups.showAll();
    armorPickups.showAll();
    springPickups.showAll();
    barrels.showAll();
    hud.setGrenades(GRENADE_START);
    hud.setRocket(false);
    hud.setArmor(0);
    hud.setSpring(0);
    hud.setCredits(STARTING_CREDITS); // instant feedback; snapshots then confirm (issue #25)
    shootHandle?.resetOwned();        // back to the free starter; rebuy each match (issue #26)
    hud.setBuyAvailable(true);        // the buy menu (B) is usable during the match
    hud.setBuyState(STARTING_CREDITS, shootHandle?.getOwned() ?? []);
  });

  net.on("matchover", (m: MatchOverMsg) => {
    matchEndsAt = 0; // stop the countdown
    deadUntil = 0;
    phase = "lobby";
    hud.hideDeath();
    hud.setBuyAvailable(false); // no buying between matches (also closes the menu if open) (#26)
    controls.unlock(); // free the cursor for the lobby
    lobby.show();      // the lobby sits behind the results board (server also resent "lobby")
    sfx.playMusic("outro"); // game-over outro song (stops on Continue / next match)
    // Results board on top; closing it reveals the lobby to ready up for the next match.
    hud.showResults(m.standings, myId, () => { sfx.stopMusic(); hud.hideResults(); });
  });

  // ---- weapons (fire / reload / switch / ADS — single owner) ----------------

  shootHandle = new WeaponController({
    camera,
    dom: renderer.domElement,
    getTargets: () => [...[...remotes.values()].map((rp) => rp.body), ...barrels.getTargets()],
    getWorldTargets: () => [arena.collision], // arena geometry, so rockets explode on walls/floor
    isLocked: () => controls.isLocked,
    nextSeq: () => (local ? local.nextSeq() : 0),
    send: (m) => net.send(m),
    baseFov: camera.fov,
    onLocalShoot: (hit, weaponId, res) => {
      // sniper (id 1) → its fire+reload clip; rocket launcher / "mortar" (id 2) → launcher thump; else machine-gun.
      sfx.shoot(weaponId === 1 ? "sniper" : weaponId === 2 ? "mortar" : "shoot");
      viewmodel.recoil(1 + (shootHandle?.getSpread() ?? 0) * 6); // kick scales with bloom (#20)
      viewmodel.flash();
      if (hit) hud.flashHitMarker();
      // Tracer (#67) from the viewmodel muzzle to the impact (or far along the ray on a miss).
      // `res` is only set for hitscan weapons — rockets keep their existing projectile visual.
      if (res) {
        const from = viewmodel.getMuzzleWorld(_muzzleTmp);
        const range = WEAPONS[weaponId]?.maxRange ?? 200;
        const end: Vec3 = res.point ?? [
          res.o[0] + res.d[0] * range, res.o[1] + res.d[1] * range, res.o[2] + res.d[2] * range,
        ];
        tracers.spawn([from.x, from.y, from.z], end, weaponId);
      }
    },
    onAmmo: (clip, reserve, reloading) => hud.setAmmo(clip, reserve, reloading),
    onWeapon: (name, id) => { hud.setWeapon(name); viewmodel.setWeapon(id); },
    onScope: (active) => hud.setScope(active),
    // Lower look sensitivity while zoomed (#28) so the on-screen aim speed stays consistent;
    // scale off the persisted base (the settings slider writes settings.sensitivity directly).
    onZoomSensitivity: (scale) => controls.setSensitivity(settings.sensitivity * scale),
    onRocket: (has) => hud.setRocket(has),
    sfx: { shoot: () => sfx.shoot(), reload: (ms) => sfx.reload(ms), dryFire: () => sfx.dryFire() },
  });

  // ---- Esc pause / settings overlay ---------------------------------------
  // PointerLockControls releases the lock on Esc; show a pause overlay with the live settings
  // panel (sliders + keybinds) once the player has locked at least once (so it doesn't cover the
  // initial "Click to play" state). Resume re-locks (must be a user gesture, which the click is).
  const pauseOverlay = document.createElement("div");
  pauseOverlay.style.cssText =
    "position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;" +
    "gap:16px;background:rgba(0,0,0,.7);z-index:40;font-family:monospace;color:#dfe;";
  const pauseTitle = document.createElement("div");
  pauseTitle.textContent = "PAUSED";
  pauseTitle.style.cssText = "font:700 30px monospace;letter-spacing:2px;";
  const pausePanel = buildSettingsPanel({
    onSensitivity: (v) => controls.setSensitivity(v),
    onFov: (v) => shootHandle?.setBaseFov(v),
    onVolume: (v) => sfx.setVolume(v),
    onKeymap: (km) => controls.setKeymap(km),
  });
  const resumeBtn = document.createElement("button");
  resumeBtn.textContent = "Resume";
  resumeBtn.style.cssText =
    "font:700 18px monospace;padding:10px 28px;cursor:pointer;background:#3c9;border:none;border-radius:4px;color:#062;";
  resumeBtn.addEventListener("click", () => controls.lock());
  pauseOverlay.appendChild(pauseTitle);
  pauseOverlay.appendChild(pausePanel);
  pauseOverlay.appendChild(resumeBtn);
  document.body.appendChild(pauseOverlay);

  let hasEverLocked = false;
  controls.onLockChange((locked: boolean) => {
    if (locked) { hasEverLocked = true; pauseOverlay.style.display = "none"; }
    // Don't surface the pause menu when the unlock was caused by opening the chat input (#10) or
    // the buy menu (#26) — each re-locks on its own when closed.
    else if (hasEverLocked && !hud.chatInputActive && !hud.buyMenuOpen) { pauseOverlay.style.display = "flex"; }
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
  const listenerFwd = new THREE.Vector3(); // scratch: camera look direction for the audio listener

  function sendInputIfDue(accum: number, dtMs: number): number {
    const a = accum + dtMs;
    if (a >= CLIENT_SEND_MS && controls.isLocked && local !== undefined) {
      const msg = local.buildInput(
        controls.getPosition(),
        controls.getRotation(),
        controls.getVelocity(),
        Date.now(),
        controls.isCrouching,
        controls.isParachuting(),
      );
      pingSentAt.set(msg.seq, Date.now());
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

    // Keep the audio listener on the camera so positional gunfire (#21) attenuates + pans
    // relative to the local player's position and facing.
    camera.getWorldDirection(listenerFwd);
    sfx.setListenerPosition(
      [camera.position.x, camera.position.y, camera.position.z],
      [listenerFwd.x, listenerFwd.y, listenerFwd.z],
    );

    // Send InMsg at CLIENT_SEND_MS cadence (NOT per frame) — exactly one cadence line.
    sendAccum = sendInputIfDue(sendAccum, dtMs);

    // Update remote players (interpolation + animation mixer). Pass the current epoch
    // time; RemotePlayer.update subtracts INTERP_DELAY_MS itself (don't double-subtract).
    const nowEpoch = Date.now();
    const serverNow = nowEpoch + clockOffset; // server-clock estimate for pickup respawn timing
    for (const rp of remotes.values()) rp.update(nowEpoch, dtMs);
    grenades.update(dt);
    blood.update(dt);
    tracers.update(dt);
    doors.update(dt);
    pickups.update(dt, serverNow);
    grenadePickups.update(dt, serverNow);
    rocketPickups.update(dt, serverNow);
    healthPickups.update(dt, serverNow);
    armorPickups.update(dt, serverNow);
    springPickups.update(dt, serverNow);
    barrels.update(serverNow);

    // HUD meters + contextual hints (spring timer / parachute + zipline + door prompts).
    hud.setSpring(controls.springRemainingMs());
    hud.setHint(
      controls.isParachuting() ? "Parachute open — E to cut"
      : controls.canParachute() ? "Press E — parachute"
      : (controls.isGrounded && doors.nearest(controls.getPosition()) >= 0) ? "Press E — door"
      : controls.nearZipline() ? "Press F — zipline"
      : "",
    );

    // Auto-fire (hold-to-shoot for full-auto weapons) + viewmodel recoil/flash ease.
    shootHandle?.update(dtMs);
    hud.setCrosshairSpread(shootHandle?.getSpread() ?? 0); // bloom widens the crosshair gap (#20)
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

    // Minimap / radar — local position + facing drive the overlay (M toggles, N flips mode).
    hud.updateMinimap(latestSnap, myId, controls.getPosition(), controls.getRotation()[0], MINIMAP_BUILDINGS, ARENA_HALF);

    renderer.render(scene, camera);
  }

  frame();
}

void main();
