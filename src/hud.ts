// src/hud.ts — HUD overlay: crosshair, health bar, prompt, scoreboard, kill feed, hit marker.
import { MAX_HP } from "../worker/protocol";
import type { PlayerSnap, KillMsg } from "../worker/protocol";
import { countdownText, deathMessage } from "./death-ui";

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

    // "Click to play" prompt (centered overlay).
    const prompt = document.createElement("div");
    prompt.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.55);color:#fff;font-size:24px;text-align:center;";
    prompt.textContent = "Click to play  ·  WASD move · Shift sprint · Space jump · Mouse aim · Click shoot · Tab scores";
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

  /** Detach listeners and remove the overlay (for teardown/tests). */
  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    if (this.hitMarkerTimer !== undefined) clearTimeout(this.hitMarkerTimer);
    this.root.remove();
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
