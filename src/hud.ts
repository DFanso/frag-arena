// src/hud.ts — HUD overlay: crosshair, health bar, prompt, scoreboard, kill feed, hit marker.
import { MAX_HP, MAX_ARMOR, SPRING_DURATION_MS } from "../worker/protocol";
import type { PlayerSnap, KillMsg, Standing } from "../worker/protocol";
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
    prompt.textContent = "Click to play  ·  WASD move · Shift sprint · Ctrl/C crouch · Space jump · Hold to fire · Right-click aim · R reload · Wheel/1·2·3 weapon · G grenade · E parachute · F zipline · Grab the rocket launcher atop the tower · Tab scores";
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
    this.root.remove();
    this.resultsEl.remove();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
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
