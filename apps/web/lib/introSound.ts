/**
 * The opening animation's score — a short trailer-style cue synthesised with
 * the Web Audio API (no audio files, so it starts the instant the picture
 * does). Timed to components/OpeningIntro.tsx:
 *
 *   0.00–2.20  riser + accelerating war-drum pulses (embers converge)
 *   2.20       IMPACT: sub boom, distorted brass "braam" (D minor), crash
 *   2.40–5.60  driving bass ostinato, brass chords Dm–B♭–F–C, timpani,
 *              shimmering arpeggio; letter hits at 3.20+
 *   4.30       whoosh (welcome line)
 *   4.70–6.20  cymbal swell
 *   6.20       FINAL HIT: boom + D major braam, long tail
 *
 * Mixed loud on purpose, through a hard limiter so it is big without
 * clipping. Browsers only allow sound after a user gesture, so the caller
 * passes an AudioContext it has already confirmed (or resumed) as running.
 */
export const IMPACT_AT = 2.2;
export const FINAL_AT = 6.2;

export function createIntroAudio(): AudioContext | null {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    return new Ctx();
  } catch {
    return null;
  }
}

export function playIntroScore(ctx: AudioContext, volume = 1): () => void {
  const T = ctx.currentTime + 0.04;
  const sr = ctx.sampleRate;

  // ---- mix bus: loud, glued, never clipping
  const master = ctx.createGain();
  master.gain.value = 1.15 * volume;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -18;
  glue.knee.value = 6;
  glue.ratio.value = 4;
  glue.attack.value = 0.01;
  glue.release.value = 0.2;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  master.connect(glue).connect(limiter).connect(ctx.destination);

  // Hall reverb from a generated stereo impulse.
  const reverb = ctx.createConvolver();
  const rlen = Math.floor(sr * 3.8);
  const imp = ctx.createBuffer(2, rlen, sr);
  for (let ch = 0; ch < 2; ch += 1) {
    const d = imp.getChannelData(ch);
    for (let i = 0; i < rlen; i += 1) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rlen, 2.6);
  }
  reverb.buffer = imp;
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  reverb.connect(wet).connect(master);
  const out = (node: AudioNode, reverbAmount = 1) => {
    node.connect(master);
    if (reverbAmount > 0) {
      const s = ctx.createGain();
      s.gain.value = reverbAmount;
      node.connect(s).connect(reverb);
    }
  };

  const noiseBuf = ctx.createBuffer(1, sr * 3, sr);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < nd.length; i += 1) nd[i] = Math.random() * 2 - 1;
  const noise = (at: number, dur: number) => {
    const n = ctx.createBufferSource();
    n.buffer = noiseBuf;
    n.start(at);
    n.stop(at + dur);
    return n;
  };
  const drive = (amount: number) => {
    const ws = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i += 1) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * amount);
    }
    ws.curve = curve;
    return ws;
  };
  const env = (g: GainNode, at: number, peak: number, attack: number, hold: number, release: number) => {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.setValueAtTime(peak, at + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  };

  // ---- instruments
  const drum = (at: number, level: number, pitch = 150) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(pitch, at);
    o.frequency.exponentialRampToValueAtTime(42, at + 0.28);
    const g = ctx.createGain();
    env(g, at, level, 0.004, 0.02, 0.7);
    o.connect(g);
    out(g, 0.5);
    o.start(at);
    o.stop(at + 0.8);
    const n = noise(at, 0.12);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    const ng = ctx.createGain();
    env(ng, at, level * 0.5, 0.002, 0.01, 0.1);
    n.connect(lp).connect(ng);
    out(ng, 0.6);
  };

  const boom = (at: number, level: number) => {
    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(78, at);
    sub.frequency.exponentialRampToValueAtTime(26, at + 2.2);
    const sg = ctx.createGain();
    env(sg, at, level, 0.005, 0.15, 2.6);
    sub.connect(sg);
    out(sg, 0.3);
    sub.start(at);
    sub.stop(at + 3);
    // Crunchy body.
    const body = ctx.createOscillator();
    body.type = "sawtooth";
    body.frequency.setValueAtTime(110, at);
    body.frequency.exponentialRampToValueAtTime(36, at + 0.9);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, at);
    lp.frequency.exponentialRampToValueAtTime(120, at + 1);
    const bg = ctx.createGain();
    env(bg, at, level * 0.55, 0.003, 0.05, 1.1);
    body.connect(drive(4)).connect(lp).connect(bg);
    out(bg, 0.8);
    body.start(at);
    body.stop(at + 1.3);
    // Blast of air.
    const n = noise(at, 2);
    const bp = ctx.createBiquadFilter();
    bp.type = "lowpass";
    bp.frequency.setValueAtTime(5000, at);
    bp.frequency.exponentialRampToValueAtTime(200, at + 1.6);
    const ng = ctx.createGain();
    env(ng, at, level * 0.6, 0.003, 0.05, 1.7);
    n.connect(bp).connect(ng);
    out(ng, 1.2);
  };

  const crash = (at: number, level: number, dur = 2.6) => {
    const n = noise(at, dur);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5200;
    const g = ctx.createGain();
    env(g, at, level, 0.003, 0.04, dur - 0.1);
    n.connect(hp).connect(g);
    out(g, 1);
  };

  const swell = (at: number, dur: number, level: number) => {
    const n = noise(at, dur + 0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(1500, at);
    hp.frequency.exponentialRampToValueAtTime(7000, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + dur);
    g.gain.linearRampToValueAtTime(0, at + dur + 0.04);
    n.connect(hp).connect(g);
    out(g, 0.8);
  };

  /** Brass "braam": detuned saws through a filter that blares open. */
  const braam = (at: number, freqs: number[], dur: number, level: number, bright = 2600) => {
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(220, at);
    lp.frequency.exponentialRampToValueAtTime(bright, at + 0.18);
    lp.frequency.exponentialRampToValueAtTime(bright * 0.4, at + dur);
    const g = ctx.createGain();
    env(g, at, level, 0.03, dur * 0.55, dur * 0.6);
    lp.connect(drive(1.8)).connect(g);
    out(g, 0.9);
    for (const f of freqs) {
      for (const cents of [-9, 0, 8]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.detune.value = cents;
        const vg = ctx.createGain();
        vg.gain.value = 0.22 / freqs.length;
        o.connect(vg).connect(lp);
        o.start(at);
        o.stop(at + dur * 1.2);
      }
    }
  };

  const pluck = (at: number, f: number, level: number, type: OscillatorType = "sawtooth", cutoff = 700, len = 0.18) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(cutoff * 2.2, at);
    lp.frequency.exponentialRampToValueAtTime(cutoff * 0.5, at + len);
    const g = ctx.createGain();
    env(g, at, level, 0.004, 0.01, len);
    o.connect(lp).connect(g);
    out(g, 0.35);
    o.start(at);
    o.stop(at + len + 0.1);
  };

  const bell = (at: number, f: number, level: number) => {
    for (const [ratio, amp, decay] of [
      [1, 1, 1.6],
      [2.756, 0.25, 0.7],
      [5.4, 0.08, 0.35],
    ] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f * ratio;
      const g = ctx.createGain();
      env(g, at, level * amp, 0.004, 0.01, decay);
      o.connect(g);
      out(g, 1);
      o.start(at);
      o.stop(at + decay + 0.1);
    }
  };

  const whoosh = (at: number, dur: number, level: number) => {
    const n = noise(at, dur);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(300, at);
    bp.frequency.exponentialRampToValueAtTime(4500, at + dur * 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    n.connect(bp).connect(g);
    out(g, 0.9);
  };

  // ---- the cue
  const I = T + IMPACT_AT;
  const F = T + FINAL_AT;

  // Riser: noise opening up + a climbing saw.
  {
    const n = noise(T, IMPACT_AT + 0.05);
    const hp = ctx.createBiquadFilter();
    hp.type = "bandpass";
    hp.Q.value = 0.8;
    hp.frequency.setValueAtTime(200, T);
    hp.frequency.exponentialRampToValueAtTime(7000, I);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, T);
    g.gain.exponentialRampToValueAtTime(0.35, I - 0.02);
    g.gain.linearRampToValueAtTime(0, I);
    n.connect(hp).connect(g);
    out(g, 0.6);
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(73.42, T);
    o.frequency.exponentialRampToValueAtTime(587.33, I);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(300, T);
    lp.frequency.exponentialRampToValueAtTime(3000, I);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, T);
    og.gain.exponentialRampToValueAtTime(0.12, I - 0.02);
    og.gain.linearRampToValueAtTime(0, I);
    o.connect(lp).connect(og);
    out(og, 0.5);
    o.start(T);
    o.stop(I + 0.05);
  }
  // Accelerating war drums.
  [0.15, 0.75, 1.2, 1.52, 1.76, 1.94, 2.06, 2.14].forEach((t, i) => drum(T + t, 0.45 + i * 0.07, 130 + i * 6));

  // IMPACT.
  boom(I, 1);
  crash(I, 0.35, 3);
  braam(I, [73.42, 110, 146.83, 174.61, 220], 1.7, 0.9);

  // Driving section: 8th-note bass under Dm – B♭ – F – C.
  const start = I + 0.2;
  const bar = 0.8;
  const roots = [73.42, 58.27, 87.31, 65.41];
  const chords = [
    [146.83, 174.61, 220, 293.66],
    [116.54, 146.83, 174.61, 233.08],
    [174.61, 220, 261.63, 349.23],
    [130.81, 164.81, 196, 261.63],
  ];
  const arps = [
    [587.33, 698.46, 880, 1174.66],
    [466.16, 587.33, 698.46, 932.33],
    [698.46, 880, 1046.5, 1396.91],
    [523.25, 659.25, 783.99, 1046.5],
  ];
  roots.forEach((root, c) => {
    const at = start + c * bar;
    for (let k = 0; k < 8; k += 1) pluck(at + k * 0.1, root * (k % 2 ? 2 : 1), k % 4 === 0 ? 0.32 : 0.22, "sawtooth", 520, 0.12);
    braam(at, chords[c]!, bar * 0.95, 0.42, 1800);
    drum(at, 0.55, 110);
    drum(at + 0.4, 0.38, 120);
    drum(at + 0.6, 0.3, 125);
    if (at >= T + 3.0) arps[c]!.concat([...arps[c]!].reverse()).forEach((f, k) => pluck(at + k * 0.1, f, 0.07, "triangle", 3000, 0.25));
  });

  // PODIUM letters stamp in.
  for (let i = 0; i < 6; i += 1) {
    bell(T + 3.2 + i * 0.12, [1174.66, 1318.51, 1396.91, 1567.98, 1760, 2349.32][i]!, 0.09);
    drum(T + 3.2 + i * 0.12, 0.18, 220);
  }
  whoosh(T + 4.05, 0.7, 0.3);

  // Build to the final hit.
  swell(T + 4.7, FINAL_AT - 4.7, 0.3);
  braam(T + 5.4, [73.42, 110, 146.83, 185, 220], 0.8, 0.35, 1400);
  [5.6, 5.8, 5.95, 6.05, 6.12].forEach((t, i) => drum(T + t, 0.4 + i * 0.1, 140));

  boom(F, 1);
  crash(F, 0.4, 3.4);
  braam(F, [73.42, 110, 146.83, 185, 220, 293.66, 369.99], 2.6, 0.95, 3200);
  bell(F, 1174.66, 0.12);
  bell(F + 0.05, 1479.98, 0.09);

  let closed = false;
  const stop = (fade = 0.5) => {
    if (closed) return;
    closed = true;
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + fade);
    window.setTimeout(() => void ctx.close().catch(() => undefined), fade * 1000 + 200);
  };
  window.setTimeout(() => stop(1.5), (FINAL_AT + 2.6) * 1000);
  return () => stop(0.35);
}
