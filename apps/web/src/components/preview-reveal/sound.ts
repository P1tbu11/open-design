/**
 * The swarm's own sounds, at the moments this port actually has.
 *
 * Two of the reference's cues are reproduced: `press()` — the three-band noise
 * click that lands whenever a cursor grabs something — and the finale's
 * `intro()`/`release()` sweeps, which are the page "coming apart" and the real
 * page coming back. The piano/glass arpeggios are deliberately absent: they are
 * a soundtrack for a two-minute page rebuild, and this curtain is six seconds
 * long with its own rhythm.
 *
 * The graph is created once, on the first gesture the stage sees, and lives as
 * long as the host. Nothing here touches the page or the preview frame.
 */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
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

  /**
   * The page dissolving: an airy band-passed swell plus a low open fifth, the
   * reference's `intro()`. Fired when the curtain starts and again, one octave
   * up and quieter, as the crew folds into the single remaining cursor.
   */
  gather(): void {
    this.sweep(260, 2400, 900, 1.8, 0.16, 2.2);
    this.pad(40, 0.3, 0.07, 2.4);
  }

  /** Back to the real page: the reference's falling `release()` sweep. */
  release(): void {
    this.sweep(3000, 220, 220, 1, 0.12, 1.1);
  }

  private sweep(from: number, peak: number, to: number, rise: number, gain: number, length: number): void {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running' || !this.noise) return;
    const t = ctx.currentTime + 0.01;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.8;
    band.frequency.setValueAtTime(from, t);
    band.frequency.exponentialRampToValueAtTime(peak, t + rise * 0.5);
    band.frequency.exponentialRampToValueAtTime(to, t + rise);
    const bus = this.bus(t, 0, 0.6);
    bus.gain.setValueAtTime(0, t);
    bus.gain.linearRampToValueAtTime(gain, t + rise * 0.4);
    bus.gain.exponentialRampToValueAtTime(0.0005, t + length);
    src.connect(band);
    band.connect(bus);
    src.start(t);
    src.stop(t + length + 0.1);
  }

  /** Two detuned triangles: the low fifth under the sweep. */
  private pad(midi: number, delay: number, gain: number, length: number): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const when = ctx.currentTime + delay;
    const bus = this.bus(when, 0, 0.6);
    bus.gain.setValueAtTime(0, when);
    bus.gain.linearRampToValueAtTime(gain, when + length * 0.4);
    bus.gain.exponentialRampToValueAtTime(0.0005, when + length);
    for (const detune of [-4, 4]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToHz(midi);
      osc.detune.value = detune;
      osc.connect(bus);
      osc.start(when);
      osc.stop(when + length + 0.05);
    }
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
