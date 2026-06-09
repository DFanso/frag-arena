// src/settings.ts — client preferences (mouse sensitivity, FOV, master volume, movement
// keybinds) persisted to localStorage. The clamp/parse/rebind helpers are pure so they can be
// unit-tested; loadSettings/saveSettings wrap them with a guarded localStorage access.

export type Action =
  | "forward" | "back" | "left" | "right"
  | "jump" | "sprint" | "crouch" | "interact" | "zipline";

export const ACTIONS: readonly Action[] = [
  "forward", "back", "left", "right", "jump", "sprint", "crouch", "interact", "zipline",
];

// Human labels for the keybind UI.
export const ACTION_LABELS: Record<Action, string> = {
  forward: "Move forward", back: "Move back", left: "Strafe left", right: "Strafe right",
  jump: "Jump", sprint: "Sprint", crouch: "Crouch", interact: "Interact / parachute", zipline: "Zipline",
};

export interface Settings {
  sensitivity: number;  // mouse-look multiplier, 0.1 .. 5
  fov: number;          // vertical FOV degrees, 60 .. 120
  masterVolume: number; // 0 .. 1
  keymap: Record<Action, string>; // action -> KeyboardEvent.code
}

export const SENS_MIN = 0.1, SENS_MAX = 5;
export const FOV_MIN = 60, FOV_MAX = 120;

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1.0,
  fov: 75,
  masterVolume: 1.0,
  keymap: {
    forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD",
    jump: "Space", sprint: "ShiftLeft", crouch: "KeyC", interact: "KeyE", zipline: "KeyF",
  },
};

const STORAGE_KEY = "cf-fps-settings";

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

/**
 * Pure: merge an untrusted partial onto the defaults, clamping numeric ranges and validating the
 * keymap (every action gets a string code; unknown actions and non-string codes are dropped in
 * favour of the default for that action). Never mutates the defaults or the input.
 */
export function clampSettings(partial: Partial<Settings> | Record<string, unknown> | null | undefined): Settings {
  const p = (partial ?? {}) as Record<string, unknown>;
  const km: Record<Action, string> = { ...DEFAULT_SETTINGS.keymap };
  const inKm = p.keymap;
  if (inKm && typeof inKm === "object") {
    for (const a of ACTIONS) {
      const code = (inKm as Record<string, unknown>)[a];
      if (typeof code === "string" && code.length > 0) km[a] = code;
    }
  }
  return {
    sensitivity: clampNum(p.sensitivity, SENS_MIN, SENS_MAX, DEFAULT_SETTINGS.sensitivity),
    fov: clampNum(p.fov, FOV_MIN, FOV_MAX, DEFAULT_SETTINGS.fov),
    masterVolume: clampNum(p.masterVolume, 0, 1, DEFAULT_SETTINGS.masterVolume),
    keymap: km,
  };
}

/** Pure: parse a raw localStorage string (or null) into validated Settings; junk → defaults. */
export function parseSettings(raw: string | null): Settings {
  if (raw == null) return clampSettings({});
  try {
    const obj = JSON.parse(raw);
    if (obj === null || typeof obj !== "object") return clampSettings({});
    return clampSettings(obj as Record<string, unknown>);
  } catch {
    return clampSettings({});
  }
}

export interface RebindResult {
  ok: boolean;
  keymap?: Record<Action, string>; // present only when ok
  conflict?: Action;               // the action already bound to `code` (present only when !ok)
}

/**
 * Pure: bind `action` to `code`. Rebinding an action to its own current code is a no-op success.
 * If a *different* action already owns `code`, the rebind is rejected (returns the conflicting
 * action) so the caller can surface it. Never mutates the input keymap.
 */
export function rebind(keymap: Record<Action, string>, action: Action, code: string): RebindResult {
  if (keymap[action] === code) return { ok: true, keymap: { ...keymap } };
  const owner = ACTIONS.find((a) => a !== action && keymap[a] === code);
  if (owner) return { ok: false, conflict: owner };
  return { ok: true, keymap: { ...keymap, [action]: code } };
}

// ---- localStorage-backed singleton (guarded so non-browser/test envs don't throw) ----

function hasStorage(): boolean {
  try { return typeof localStorage !== "undefined"; } catch { return false; }
}

export function loadSettings(): Settings {
  if (!hasStorage()) return clampSettings({});
  return parseSettings(localStorage.getItem(STORAGE_KEY));
}

export function saveSettings(s: Settings): void {
  if (!hasStorage()) return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota / disabled — ignore */ }
}

/** Mutable singleton applied across the app; call saveSettings(settings) after edits to persist. */
export const settings: Settings = loadSettings();
