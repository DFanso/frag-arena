// src/audio.ts — WebAudio SFX: lazily-created context + short synthesized blips.

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
