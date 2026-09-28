"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { INTRO_KEY, useAuth } from "../lib/auth";
import { createIntroAudio, FINAL_AT, IMPACT_AT, playIntroScore } from "../lib/introSound";

const SOUND_KEY = "podium.intro.sound";
/** The scene leaves just after the final hit (ms); the music's tail rings on. */
const LEAVE_AT = (FINAL_AT + 0.35) * 1000;
const GONE_AFTER = 1000;

type Phase = "off" | "gate" | "on" | "leaving";

/**
 * The opening title sequence — once per browser session, as the person
 * enters the app. Game-style: embers converge, the AMM mark slams in with a
 * flash, shockwave and spark burst, rays turn behind it, PODIUM stamps in
 * letter by letter, and a final hit launches into the app. It plays over the
 * app while the first screen loads underneath.
 *
 * Browsers only allow sound after the person has interacted with the page.
 * Straight after signing in that is true and the sequence starts at once; on
 * a plain reload it opens on a "press any key" title screen, so the music
 * always plays. Esc or Skip ends it; the sound choice is remembered.
 */
export function OpeningIntro() {
  const { user } = useAuth();
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("off");
  const [sound, setSound] = useState(true);
  const audio = useRef<AudioContext | null>(null);
  const stopSound = useRef<() => void>(() => undefined);
  const timers = useRef<number[]>([]);

  const finish = useCallback((cutSound: boolean) => {
    setPhase((p) => (p === "on" || p === "gate" ? "leaving" : p));
    if (cutSound) stopSound.current();
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [window.setTimeout(() => setPhase("off"), GONE_AFTER)];
  }, []);

  const start = useCallback(
    (withSound: boolean) => {
      setPhase("on");
      if (withSound && audio.current) {
        void audio.current.resume().catch(() => undefined);
        stopSound.current = playIntroScore(audio.current);
      }
      timers.current = [window.setTimeout(() => finish(false), LEAVE_AT)];
    },
    [finish],
  );

  useEffect(() => {
    if (!user || !pathname || pathname === "/login" || phase !== "off") return;
    let seen = false;
    let soundOn = true;
    try {
      seen = window.sessionStorage.getItem(INTRO_KEY) === "1";
      soundOn = window.localStorage.getItem(SOUND_KEY) !== "off";
      window.sessionStorage.setItem(INTRO_KEY, "1");
    } catch {
      // storage unavailable — play it, just without remembering
    }
    if (seen) return;
    setSound(soundOn);
    if (!soundOn) {
      start(false);
      return;
    }
    audio.current = createIntroAudio();
    // Running already (the person just clicked Sign in): go. Otherwise the
    // browser is holding sound back until a gesture — show the title screen.
    if (audio.current?.state === "running") start(true);
    else if (audio.current) setPhase("gate");
    else start(false);
    // Starts once per session, keyed on the person arriving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, pathname]);

  // Keys: any key opens the gate; Esc skips the sequence.
  useEffect(() => {
    if (phase === "off" || phase === "leaving") return;
    const onKey = (e: KeyboardEvent) => {
      if (phase === "gate") {
        if (e.key === "Escape") finish(true);
        else start(true);
      } else if (e.key === "Escape") finish(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, start, finish]);

  const toggleSound = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !sound;
    setSound(next);
    try {
      window.localStorage.setItem(SOUND_KEY, next ? "on" : "off");
    } catch {
      // storage unavailable
    }
    if (!next) stopSound.current();
  };

  if (phase === "off" || !user) return null;
  const first = user.name.split(" ")[0]?.toUpperCase();

  if (phase === "gate") {
    return (
      <div className="intro intro-gate" onClick={() => start(true)} role="presentation">
        <div className="intro-rays dim" />
        <div className="intro-markwrap gate-mark">
          <div className="intro-mark" />
        </div>
        <div className="intro-press">PRESS ANY KEY TO ENTER</div>
        <div className="intro-controls">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              finish(true);
            }}
          >
            Skip intro
          </button>
        </div>
      </div>
    );
  }

  return <IntroScene first={first ?? ""} leaving={phase === "leaving"} sound={sound} onToggleSound={toggleSound} onSkip={() => finish(true)} />;
}

/** The title sequence itself: particle layer, mark, rays, letters, flashes. */
export function IntroScene({ first, leaving, sound, onToggleSound, onSkip }: { first: string; leaving: boolean; sound: boolean; onToggleSound: (e: React.MouseEvent) => void; onSkip: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    return runParticles(canvasRef.current);
  }, []);

  return (
    <div className={`intro ${leaving ? "leaving" : ""}`} role="presentation" aria-hidden="true">
      <div className="intro-shake">
        <div className="intro-rays" />
        <canvas ref={canvasRef} className="intro-canvas" />
        <div className="intro-core" />
        <div className="intro-stage">
          <div className="intro-markwrap">
            <div className="intro-mark" />
          </div>
          <div className="intro-rule" />
          <div className="intro-word">
            {"PODIUM".split("").map((ch, i) => (
              <span key={i} style={{ animationDelay: `${3.2 + i * 0.12}s` }}>
                {ch}
              </span>
            ))}
          </div>
          <div className="intro-welcome">WELCOME, {first}</div>
        </div>
        <div className="intro-flare" />
        <div className="intro-flash" />
      </div>
      <div className="intro-bars top" />
      <div className="intro-bars bottom" />
      <div className="intro-controls">
        <button type="button" onClick={onToggleSound}>
          {sound ? "Sound on" : "Sound off"}
        </button>
        <span>·</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSkip();
          }}
        >
          Skip ›
        </button>
      </div>
    </div>
  );
}

/**
 * Embers spiral into the centre until the impact, then a spark burst and
 * shockwave rings, drifting gold dust, and a second burst on the final hit.
 * Drawn additively on a trailing canvas for light-streak motion blur.
 */
function runParticles(canvas: HTMLCanvasElement): () => void {
  const g = canvas.getContext("2d");
  if (!g) return () => undefined;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0;
  let H = 0;
  const resize = () => {
    W = canvas.width = Math.floor(window.innerWidth * dpr);
    H = canvas.height = Math.floor(window.innerHeight * dpr);
  };
  resize();
  window.addEventListener("resize", resize);

  const scale = reduced ? 0.35 : 1;
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const reach = () => Math.hypot(W, H) * 0.55;

  const embers = Array.from({ length: Math.floor(340 * scale) }, () => ({
    a: rand(0, Math.PI * 2),
    r: rand(0.35, 1) * reach(),
    spin: rand(1.4, 3.2) * (Math.random() < 0.5 ? -1 : 1),
    size: rand(0.8, 2.4) * dpr,
    delay: rand(0, 0.9),
    px: NaN,
    py: NaN,
  }));
  type Spark = { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; hot: number };
  const sparks: Spark[] = [];
  const burst = (count: number, power: number) => {
    for (let i = 0; i < count * scale; i += 1) {
      const a = rand(0, Math.PI * 2);
      const v = rand(0.25, 1) * power * dpr;
      sparks.push({ x: W / 2, y: H / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8, life: 0, max: rand(0.9, 2.6), size: rand(0.8, 2.6) * dpr, hot: Math.random() });
    }
  };
  const dust = Array.from({ length: Math.floor(140 * scale) }, () => ({ x: rand(0, 1), y: rand(0, 1), vy: rand(0.00004, 0.00018), s: rand(0.6, 1.8), tw: rand(0, 6) }));
  const rings = [IMPACT_AT, IMPACT_AT + 0.14, FINAL_AT];

  const t0 = performance.now();
  let last = t0;
  let burst1 = false;
  let burst2 = false;
  let raf = 0;

  const frame = (now: number) => {
    const t = (now - t0) / 1000;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const cx = W / 2;
    const cy = H / 2;

    g.globalCompositeOperation = "source-over";
    g.fillStyle = "rgba(6,5,4,0.3)";
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = "lighter";

    // Converging embers.
    if (t < IMPACT_AT + 0.05) {
      for (const e of embers) {
        const p = Math.min(1, Math.max(0, (t - e.delay) / (IMPACT_AT - e.delay)));
        if (p <= 0) continue;
        const k = Math.pow(p, 2.2);
        const r = e.r * (1 - k);
        const a = e.a + k * e.spin;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * 0.62;
        if (!Number.isNaN(e.px)) {
          g.strokeStyle = `rgba(255,${190 + Math.floor(50 * k)},${110 + Math.floor(100 * k)},${0.35 + 0.6 * k})`;
          g.lineWidth = e.size;
          g.beginPath();
          g.moveTo(e.px, e.py);
          g.lineTo(x, y);
          g.stroke();
        }
        e.px = x;
        e.py = y;
      }
    }

    if (!burst1 && t >= IMPACT_AT) {
      burst1 = true;
      burst(480, 26);
    }
    if (!burst2 && t >= FINAL_AT) {
      burst2 = true;
      burst(340, 30);
    }

    // Sparks: streaks with drag and a touch of gravity.
    for (let i = sparks.length - 1; i >= 0; i -= 1) {
      const s = sparks[i]!;
      s.life += dt;
      if (s.life > s.max) {
        sparks.splice(i, 1);
        continue;
      }
      const px = s.x;
      const py = s.y;
      const f = Math.pow(0.955, dt * 60);
      s.vx *= f;
      s.vy = s.vy * f + 0.09 * dpr * dt * 60;
      s.x += s.vx * dt * 60;
      s.y += s.vy * dt * 60;
      const fade = 1 - s.life / s.max;
      const gch = Math.floor(170 + 80 * s.hot * fade);
      const bch = Math.floor(60 + 160 * s.hot * fade * fade);
      g.strokeStyle = `rgba(255,${gch},${bch},${fade})`;
      g.lineWidth = s.size * (0.5 + fade);
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(s.x, s.y);
      g.stroke();
    }

    // Shockwave rings.
    for (const rt of rings) {
      const k = (t - rt) / 1.3;
      if (k < 0 || k > 1) continue;
      const ease = 1 - Math.pow(1 - k, 3);
      g.strokeStyle = `rgba(255,220,160,${Math.pow(1 - k, 2) * 0.9})`;
      g.lineWidth = (6 * (1 - k) + 0.6) * dpr;
      g.beginPath();
      g.ellipse(cx, cy, ease * reach() * 1.1, ease * reach() * 0.7, 0, 0, Math.PI * 2);
      g.stroke();
    }

    // Floating dust after the impact.
    if (t > IMPACT_AT) {
      const vis = Math.min(1, (t - IMPACT_AT) / 1.2);
      for (const d of dust) {
        d.y -= d.vy * dt * 60;
        if (d.y < 0) d.y = 1;
        const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 1.6 + d.tw));
        g.fillStyle = `rgba(240,205,140,${0.5 * tw * vis})`;
        g.beginPath();
        g.arc(d.x * W, d.y * H, d.s * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }

    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
  };
}
