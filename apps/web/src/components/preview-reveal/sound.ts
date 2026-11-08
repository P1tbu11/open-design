/**
 * The click the swarm makes when it grabs a box.
 *
 * This is the original's `press()` sound, not its glass piano: three short
 * band-passed noise bursts — a sharp grab, a deeper body, then a lighter
 * release a few dozen milliseconds later. That is what reads as the "click"
 * that accompanies every drag.
 *
 * The graph is created once on the first gesture and lives as long as the
 * stage. Nothing here touches the page or the preview frame.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export interface RevealClickInput {
  /** Pointer x in stage space, used only for the stereo position. */
  x: number;
  viewportWidth: number;
}

export class RevealSound {
  private ctx: AudioContext | null = null;

  private master: GainNode | null = null;

  private noise: AudioBuffer | null = null;

  private enabled = true;

  /** Clicks are rate-limited the same way the original limits them. */
  private pressTimes: number[] = [];

  /** Must be called from a user gesture (the replay click) or the context stays suspended. */
  arm(): void {
    this.ensure();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? 1 : 0, t, 0.05);
  }

  dispose(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.pressTimes = [];
    void ctx.close().catch(() => undefined);
  }

  /**
   * A grab: sharp click, deeper body, then a lighter release. Fires immediately
   * rather than on a grid, which is what keeps it feeling like a physical click.
   */
  click(input: RevealClickInput): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    this.pressTimes = this.pressTimes.filter((k) => t - k < 1);
    if (this.pressTimes.length > 40) return;
    this.pressTimes.push(t);
    const pan = this.pan(input.x, input.viewportWidth);
    this.tick(t + 0.004, pan, rand(2100, 2700), 4, 0.32, 0.012);
    this.tick(t + 0.005, pan, rand(650, 850), 2, 0.16, 0.022);
    this.tick(t + rand(0.055, 0.075), pan, rand(2900, 3400), 4, 0.15, 0.008);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;
    const Ctor = window.AudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.enabled ? 0.9 : 0;
      master.connect(ctx.destination);
      this.master = master;
      this.noise = this.noiseBuffer(1.5);
      return ctx;
    } catch {
      return null;
    }
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, Math.floor(rate * seconds), rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private pan(x: number, viewportWidth: number): number {
    return clamp((x / Math.max(1, viewportWidth)) * 1.6 - 0.8, -0.8, 0.8);
  }

  private bus(when: number, pan: number, send: number): GainNode {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, when);
    gain.connect(panner);
    panner.connect(this.master!);
    if (send) {
      // A whisper of room so the click is not bone-dry.
      const wet = ctx.createGain();
      wet.gain.value = send;
      panner.connect(wet);
      wet.connect(this.master!);
    }
    return gain;
  }

  /** One band-passed noise burst: the whole click is three of these. */
  private tick(when: number, pan: number, freq: number, q: number, vel: number, len: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const gain = this.bus(when, pan, 0.06);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(vel, when + 0.0008);
    gain.gain.exponentialRampToValueAtTime(0.0004, when + len);
    src.connect(bp);
    bp.connect(gain);
    src.start(when, Math.random() * 1.2);
    src.stop(when + len + 0.02);
  }
}
