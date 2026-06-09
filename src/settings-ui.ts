// src/settings-ui.ts — the settings panel DOM (sensitivity / FOV / volume sliders + a rebindable
// keymap list). Reused by the start screen and the in-game Esc pause overlay. Reads/writes the
// `settings` singleton, persists on every change, and notifies the app via hooks for live apply.
import {
  settings, saveSettings, rebind, ACTIONS, ACTION_LABELS,
  SENS_MIN, SENS_MAX, FOV_MIN, FOV_MAX, type Action,
} from "./settings";

export interface SettingsHooks {
  onSensitivity?: (v: number) => void;
  onFov?: (v: number) => void;
  onVolume?: (v: number) => void;
  onKeymap?: (km: Record<Action, string>) => void;
}

/** Human-friendly label for a KeyboardEvent.code (e.g. "KeyW" → "W", "ShiftLeft" → "Shift"). */
export function displayCode(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[code] ?? code;
  const map: Record<string, string> = {
    Space: "Space", ShiftLeft: "L-Shift", ShiftRight: "R-Shift",
    ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl", AltLeft: "L-Alt", AltRight: "R-Alt",
  };
  return map[code] ?? code;
}

/** Build the settings panel element. Caller appends it wherever it wants (start screen / pause). */
export function buildSettingsPanel(hooks: SettingsHooks = {}): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText =
    "display:flex;flex-direction:column;gap:12px;color:#dfe;font-family:monospace;" +
    "background:rgba(12,16,26,.6);border:1px solid rgba(255,255,255,.15);border-radius:8px;" +
    "padding:14px 18px;min-width:320px;max-width:380px;text-align:left;";

  const title = document.createElement("div");
  title.textContent = "SETTINGS";
  title.style.cssText = "font:700 16px monospace;letter-spacing:1px;opacity:.85;";
  root.appendChild(title);

  // --- Sliders -------------------------------------------------------------
  const slider = (
    label: string, min: number, max: number, step: number, value: number,
    fmt: (n: number) => string, onInput: (n: number) => void,
  ): void => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-direction:column;gap:3px;";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;justify-content:space-between;font-size:13px;";
    const name = document.createElement("span");
    name.textContent = label;
    const val = document.createElement("span");
    val.style.cssText = "opacity:.8;";
    val.textContent = fmt(value);
    head.appendChild(name);
    head.appendChild(val);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(value);
    input.style.cssText = "width:100%;cursor:pointer;";
    input.addEventListener("input", () => {
      const n = parseFloat(input.value);
      val.textContent = fmt(n);
      onInput(n);
    });
    row.appendChild(head);
    row.appendChild(input);
    root.appendChild(row);
  };

  slider("Mouse sensitivity", SENS_MIN, SENS_MAX, 0.1, settings.sensitivity, (n) => n.toFixed(1), (n) => {
    settings.sensitivity = n; saveSettings(settings); hooks.onSensitivity?.(n);
  });
  slider("Field of view", FOV_MIN, FOV_MAX, 1, settings.fov, (n) => `${Math.round(n)}°`, (n) => {
    settings.fov = n; saveSettings(settings); hooks.onFov?.(n);
  });
  slider("Master volume", 0, 1, 0.05, settings.masterVolume, (n) => `${Math.round(n * 100)}%`, (n) => {
    settings.masterVolume = n; saveSettings(settings); hooks.onVolume?.(n);
  });

  // --- Keybinds ------------------------------------------------------------
  const kbTitle = document.createElement("div");
  kbTitle.textContent = "Keybinds";
  kbTitle.style.cssText = "font:700 13px monospace;opacity:.7;margin-top:4px;";
  root.appendChild(kbTitle);

  const hint = document.createElement("div");
  hint.style.cssText = "font-size:12px;opacity:.7;min-height:15px;color:#ffd9a0;";
  root.appendChild(hint);

  let capturing: { action: Action; btn: HTMLButtonElement } | null = null;

  const onCapture = (e: KeyboardEvent): void => {
    if (!capturing) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // don't let controls.ts act on the bind keystroke
    const { action, btn } = capturing;
    if (e.code === "Escape") { btn.textContent = displayCode(settings.keymap[action]); hint.textContent = ""; capturing = null; return; }
    const r = rebind(settings.keymap, action, e.code);
    if (!r.ok) {
      hint.textContent = `"${displayCode(e.code)}" already bound to ${ACTION_LABELS[r.conflict!]}`;
      btn.textContent = displayCode(settings.keymap[action]);
      capturing = null;
      return;
    }
    settings.keymap = r.keymap!;
    saveSettings(settings);
    hooks.onKeymap?.(settings.keymap);
    btn.textContent = displayCode(e.code);
    hint.textContent = "";
    capturing = null;
  };

  for (const action of ACTIONS) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-size:13px;";
    const name = document.createElement("span");
    name.textContent = ACTION_LABELS[action];
    const btn = document.createElement("button");
    btn.textContent = displayCode(settings.keymap[action]);
    btn.style.cssText =
      "font:600 12px monospace;min-width:64px;padding:3px 8px;cursor:pointer;color:#dfe;" +
      "background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.25);border-radius:4px;";
    btn.addEventListener("click", () => {
      capturing = { action, btn };
      btn.textContent = "press a key…";
      hint.textContent = "Press a key to bind (Esc to cancel)";
    });
    row.appendChild(name);
    row.appendChild(btn);
    root.appendChild(row);
  }

  // Capture phase so the rebind keystroke is intercepted before controls.ts' bubble handler.
  document.addEventListener("keydown", onCapture, true);
  // Stash the listener so the caller can detach it when the panel is discarded.
  (root as unknown as { _detach: () => void })._detach = () =>
    document.removeEventListener("keydown", onCapture, true);

  return root;
}

/** Detach the panel's global key-capture listener (call when removing a panel from the DOM). */
export function disposeSettingsPanel(panel: HTMLElement): void {
  (panel as unknown as { _detach?: () => void })._detach?.();
}
