// src/audio.ts — WebAudio SFX: lazily-created context + short synthesized blips.

export class Sfx {
  private ctx: AudioContext | undefined;

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
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
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
    env.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }
}
