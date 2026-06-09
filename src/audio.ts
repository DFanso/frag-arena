// src/audio.ts — WebAudio SFX: lazily-created context + short synthesized blips, plus a few
// decoded sample files (gunshot / reload) that play through the master gain.

// Sample SFX served from /public/sfx. Each falls back to a synth blip until it's decoded.
const SAMPLE_URLS: Record<string, string> = {
  shoot: "/sfx/eaglaxle-gun-shot-1-530788.mp3",
  sniper: "/sfx/sniper.mp3",
  reload: "/sfx/reload.mp3",
};

export class Sfx {
  private ctx: AudioContext | undefined;
  private masterGain: GainNode | undefined; // all blips route through this for a master volume
  private volume = 1;                        // desired 0..1 (applied once the ctx/gain exist)
  private samples: Partial<Record<string, AudioBuffer>> = {}; // decoded SFX, keyed by SAMPLE_URLS name
  private samplesLoading = false;

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
    void this.loadSamples(); // fetch + decode the SFX samples (once)
  }

  // Fetch + decode the sample SFX once. Best-effort: any that fail keep their synth-blip fallback.
  private async loadSamples(): Promise<void> {
    if (this.samplesLoading || !this.ctx) return;
    this.samplesLoading = true;
    const ctx = this.ctx;
    await Promise.all(
      Object.entries(SAMPLE_URLS).map(async ([name, url]) => {
        if (this.samples[name]) return;
        try {
          const res = await fetch(url);
          this.samples[name] = await ctx.decodeAudioData(await res.arrayBuffer());
        } catch {
          /* network/decode failed — keep the synth fallback for this one */
        }
      }),
    );
    this.samplesLoading = false;
  }

  // Play a decoded sample through the master gain. Returns false if it isn't available yet.
  private playSample(name: string): boolean {
    const buf = this.samples[name];
    if (!buf || !this.ctx || this.ctx.state !== "running" || !this.masterGain) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.masterGain);
    src.start();
    return true;
  }

  /** Set the master volume (0..1); takes effect immediately and is remembered before unlock(). */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain) this.masterGain.gain.value = this.volume;
  }

  // Play a weapon's firing sound. `sample` selects the clip (e.g. "sniper"); it falls back to the
  // default gunshot sample, then to the synth blip, so an unknown/not-yet-loaded sample is safe.
  shoot(sample = "shoot"): void {
    if (this.playSample(sample)) return;
    if (this.playSample("shoot")) return;
    this.blip("square", 320, 140, 0.18, 0.05);
  }

  hit(): void {
    this.blip("triangle", 880, 660, 0.22, 0.06);
  }

  death(): void {
    this.blip("sawtooth", 260, 60, 0.28, 0.22);
  }

  reload(): void {
    if (!this.playSample("reload")) this.blip("square", 160, 220, 0.12, 0.09); // sample, else synth fallback
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
