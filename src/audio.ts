// src/audio.ts — WebAudio SFX: lazily-created context + short synthesized blips.
// Positional cues (remote gunfire) route through a PannerNode so distance attenuates the volume
// and left/right placement gives a directional cue; the listener is moved to follow the camera.

import type { Vec3 } from "../worker/protocol";

// Positional-audio rolloff (PannerNode "inverse" model): full volume within REF_DISTANCE, then
// 1/d falloff, fully inaudible beyond MAX_DISTANCE. Tuned to the arena scale (~ARENA_HALF units).
export const PANNER_REF_DISTANCE = 6;   // world units within which a sound is at full volume
export const PANNER_MAX_DISTANCE = 120; // beyond this the sound is effectively silent
export const PANNER_ROLLOFF = 1.0;      // inverse-distance rolloff factor

// Pure: the gain a PannerNode applies to a sound `dist` units from the listener under the
// "inverse" distance model (clamped to [refDistance, maxDistance]). Exported for unit tests —
// the live audio path lets the PannerNode do this same maths in C++.
export function pannerGain(
  dist: number,
  refDistance: number = PANNER_REF_DISTANCE,
  maxDistance: number = PANNER_MAX_DISTANCE,
  rolloff: number = PANNER_ROLLOFF,
): number {
  const d = Math.max(refDistance, Math.min(maxDistance, Math.abs(dist)));
  return refDistance / (refDistance + rolloff * (d - refDistance));
}

export class Sfx {
  private ctx: AudioContext | undefined;
  private masterGain: GainNode | undefined; // all blips route through this for a master volume
  private volume = 1;                        // desired 0..1 (applied once the ctx/gain exist)

  /**
   * Create (or resume) the AudioContext. MUST be called from a user gesture handler
   * (e.g. the first pointer-lock click) or browsers will keep it suspended.
   */
  unlock(): void {
    if (this.ctx === undefined) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Set the master volume (0..1); takes effect immediately and is remembered before unlock(). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain) this.masterGain.gain.value = this.volume;
  }

  shoot(): void {
    this.blip("square", 320, 140, 0.18, 0.05);
  }

  hit(): void {
    this.blip("triangle", 880, 660, 0.22, 0.06);
  }

  death(): void {
    this.blip("sawtooth", 260, 60, 0.28, 0.22);
  }

  reload(): void {
    this.blip("square", 160, 220, 0.12, 0.09);
  }

  dryFire(): void {
    this.blip("square", 120, 90, 0.10, 0.04);
  }

  explosion(): void {
    this.blip("sawtooth", 200, 36, 0.4, 0.38);
  }

  pickup(): void {
    this.blip("square", 520, 920, 0.14, 0.05);
  }

  /** A short low-frequency footstep thud (local player; non-positional, at the listener). */
  footstep(): void {
    this.blip("sine", 150, 70, 0.10, 0.07);
  }

  /**
   * Move the WebAudio listener to the camera each frame so positional cues (positionalBlip)
   * attenuate + pan relative to where the local player is and which way they face. `forward` is
   * the camera's look direction (need not be normalized). No-op until the context exists.
   */
  setListenerPosition(pos: Vec3, forward: Vec3): void {
    if (this.ctx === undefined) return;
    const lis = this.ctx.listener;
    // Newer browsers expose AudioParams (positionX/forwardX); older WebKit uses setPosition/
    // setOrientation. "up" stays world-up (0,1,0). setValueAtTime avoids glitches on ramp engines.
    if (lis.positionX) {
      const now = this.ctx.currentTime;
      lis.positionX.setValueAtTime(pos[0], now);
      lis.positionY.setValueAtTime(pos[1], now);
      lis.positionZ.setValueAtTime(pos[2], now);
      lis.forwardX.setValueAtTime(forward[0], now);
      lis.forwardY.setValueAtTime(forward[1], now);
      lis.forwardZ.setValueAtTime(forward[2], now);
      lis.upX.setValueAtTime(0, now);
      lis.upY.setValueAtTime(1, now);
      lis.upZ.setValueAtTime(0, now);
    } else {
      const legacy = lis as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(pos[0], pos[1], pos[2]);
      legacy.setOrientation(forward[0], forward[1], forward[2], 0, 1, 0);
    }
  }

  /**
   * Distant gunfire: a short blip placed at world position `at`, routed through a PannerNode so
   * the browser attenuates it by distance and pans it left/right relative to the listener.
   */
  positionalShot(at: Vec3): void {
    this.positionalBlip(at, "square", 360, 150, 0.5, 0.06);
  }

  /**
   * Play one blip through a PannerNode positioned at world `at`. The PannerNode's inverse
   * distance model (matching pannerGain above) does attenuation; HRTF/equal-power panning gives
   * the directional cue. Falls back silently if the context isn't running.
   */
  private positionalBlip(
    at: Vec3,
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    gain: number,
    dur: number,
  ): void {
    if (this.ctx === undefined || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const panner = ctx.createPanner();
    panner.panningModel = "equalpower"; // cheap pan (HRTF would be costlier); good L/R cue
    panner.distanceModel = "inverse";
    panner.refDistance = PANNER_REF_DISTANCE;
    panner.maxDistance = PANNER_MAX_DISTANCE;
    panner.rolloffFactor = PANNER_ROLLOFF;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(at[0], now);
      panner.positionY.setValueAtTime(at[1], now);
      panner.positionZ.setValueAtTime(at[2], now);
    } else {
      (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(at[0], at[1], at[2]);
    }
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), now + dur);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(env);
    env.connect(panner);
    panner.connect(this.masterGain ?? ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  /** Suspend the audio context (e.g. when the tab is hidden) so no sound plays in the background. */
  suspend(): void {
    if (this.ctx !== undefined && this.ctx.state === "running") void this.ctx.suspend();
  }

  /** Resume the audio context when the tab is visible again (no-op before unlock()). */
  resume(): void {
    if (this.ctx !== undefined && this.ctx.state === "suspended") void this.ctx.resume();
  }

  /**
   * Play one short tone: oscillator sweeping freqStart -> freqEnd over `dur` seconds,
   * with a quick gain envelope so it sounds like a blip and never clicks.
   */
  private blip(
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    gain: number,
    dur: number,
  ): void {
    if (this.ctx === undefined || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), now + dur);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(env);
    env.connect(this.masterGain ?? ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }
}
