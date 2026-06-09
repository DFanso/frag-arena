// src/audio.ts — WebAudio SFX: lazily-created context + short synthesized blips, plus a few
// decoded sample files (gunshot / reload) that play through the master gain.

// Sample SFX served from /public/sfx. Each falls back to a synth blip until it's decoded.
const SAMPLE_URLS: Record<string, string> = {
  shoot: "/sfx/eaglaxle-gun-shot-1-530788.mp3",
  sniper: "/sfx/sniper.mp3",
  reload_start: "/sfx/reload_start.mp3",
  reload_end: "/sfx/reload_end.mp3",
  explosion: "/sfx/flutie8211-bomb-and-echo-2-540400.mp3",
  mortar: "/sfx/freesound_community-grenade-launcher-106342.mp3",
  outro: "/sfx/outro.mp3",
  hit: "/sfx/hit.mp3",
};

// Leading-edge debounce for the hit confirm: the first hit of a streak plays, and further hits
// are suppressed until there's a quiet gap of at least this long — so rapid hits don't machine-gun
// the sound. Every hit extends the window, so a sustained burst only ever plays the first.
const HIT_DEBOUNCE_MS = 1500;

export class Sfx {
  private ctx: AudioContext | undefined;
  private masterGain: GainNode | undefined; // all blips route through this for a master volume
  private volume = 1;                        // desired 0..1 (applied once the ctx/gain exist)
  private samples: Partial<Record<string, AudioBuffer>> = {}; // decoded SFX, keyed by SAMPLE_URLS name
  private samplesLoading = false;
  private musicSrc: AudioBufferSourceNode | undefined; // the one playing music track (outro), so it can be stopped
  private lastHitAt = -Infinity; // performance.now() of the last hit() call (drives the hit debounce)

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
    this.playBuffer(buf, this.ctx.currentTime);
    return true;
  }

  // Play a one-off music track (e.g. the match-over outro) through the master gain. Stops any
  // track already playing first, so it never layers. No-op if the sample isn't loaded yet.
  playMusic(name: string): void {
    const buf = this.samples[name];
    if (!buf || !this.ctx || this.ctx.state !== "running" || !this.masterGain) return;
    this.stopMusic();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.masterGain);
    src.onended = () => { if (this.musicSrc === src) this.musicSrc = undefined; };
    src.start();
    this.musicSrc = src;
  }

  /** Stop the current music track (if any) — e.g. when leaving the results screen / starting a match. */
  stopMusic(): void {
    if (!this.musicSrc) return;
    try { this.musicSrc.stop(); } catch { /* already stopped */ }
    this.musicSrc = undefined;
  }

  // Schedule a buffer to start at AudioContext time `when`, routed through the master gain.
  private playBuffer(buf: AudioBuffer, when: number): void {
    if (!this.ctx || !this.masterGain) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.masterGain);
    src.start(when);
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
    // Leading-edge debounce: only the first hit of a streak plays; later hits extend the window.
    const now = performance.now();
    const play = now - this.lastHitAt >= HIT_DEBOUNCE_MS;
    this.lastHitAt = now;
    if (!play) return;
    if (!this.playSample("hit")) this.blip("triangle", 880, 660, 0.22, 0.06); // sample, else synth fallback
  }

  death(): void {
    this.blip("sawtooth", 260, 60, 0.28, 0.22);
  }

  // Two-part reload synced to the weapon's reload time: the "start" clip plays now, the "end" clip
  // is scheduled to FINISH exactly when the reload completes (durationMs from now). Falls back to a
  // synth blip if the samples aren't loaded.
  reload(durationMs: number): void {
    const start = this.samples["reload_start"];
    const end = this.samples["reload_end"];
    if (!this.ctx || this.ctx.state !== "running" || !this.masterGain || (!start && !end)) {
      this.blip("square", 160, 220, 0.12, 0.09);
      return;
    }
    const now = this.ctx.currentTime;
    if (start) this.playBuffer(start, now);
    if (end) this.playBuffer(end, now + Math.max(0, durationMs / 1000 - end.duration));
  }

  dryFire(): void {
    this.blip("square", 120, 90, 0.10, 0.04);
  }

  explosion(): void {
    if (!this.playSample("explosion")) this.blip("sawtooth", 200, 36, 0.4, 0.38); // sample, else synth fallback
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
