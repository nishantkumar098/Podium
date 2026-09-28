/**
 * Interface sounds, synthesised with the Web Audio API (no files to load):
 *
 *   notify   a new notification arrived          — two-note bell
 *   message  a chat message from someone else     — soft bubble pop
 *   sent     your chat message went out           — quick airy swoosh
 *   success  a save / create / approve succeeded  — bright little ding
 *   error    something was refused or failed      — low, soft double buzz
 *
 * Deliberately short and quiet next to the opening title music. One shared
 * AudioContext; the same sound cannot stack within 350 ms (a burst of saves
 * or messages makes one sound, not a machine-gun). The on/off choice is
 * per browser (localStorage) and changes broadcast a "podium-sounds" event
 * so any toggle in the UI stays in step.
 */
export type SoundName = "notify" | "message" | "sent" | "success" | "error";

const PREF_KEY = "podium.sounds";
let ctx: AudioContext | null = null;
const lastPlayed = new Map<SoundName, number>();

export function soundsEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundsEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    // storage unavailable — applies for this page only
  }
  window.dispatchEvent(new Event("podium-sounds"));
  if (on) playSound("success");
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    try {
      ctx = new Ctx();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

// Browsers hold audio until the first gesture; wake the context on it so the
// first real notification is not the one that gets swallowed.
if (typeof window !== "undefined") {
  const wake = () => {
    audio();
    window.removeEventListener("pointerdown", wake);
    window.removeEventListener("keydown", wake);
  };
  window.addEventListener("pointerdown", wake, { passive: true });
  window.addEventListener("keydown", wake);
}

export function playSound(name: SoundName): void {
  if (typeof window === "undefined" || !soundsEnabled()) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? 0) < 350) return;
  lastPlayed.set(name, now);
  const ac = audio();
  if (!ac || ac.state !== "running") return;

  const t = ac.currentTime + 0.01;
  const out = ac.createGain();
  out.gain.value = 0.55;
  out.connect(ac.destination);

  const tone = (freq: number, at: number, len: number, level: number, type: OscillatorType = "sine", glideTo?: number) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + len * 0.6);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + len + 0.05);
  };
  const bell = (freq: number, at: number, level: number, len = 0.9) => {
    tone(freq, at, len, level);
    tone(freq * 2.756, at, len * 0.45, level * 0.22);
    tone(freq * 5.4, at, len * 0.2, level * 0.07);
  };

  switch (name) {
    case "notify":
      bell(783.99, t, 0.28);
      bell(1174.66, t + 0.13, 0.24, 1.1);
      break;
    case "message":
      tone(420, t, 0.12, 0.3, "sine", 980);
      tone(1320, t + 0.06, 0.18, 0.1);
      break;
    case "sent": {
      const len = 0.22;
      const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const bp = ac.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(600, t);
      bp.frequency.exponentialRampToValueAtTime(4200, t + len);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + len * 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      src.connect(bp).connect(g).connect(out);
      src.start(t);
      src.stop(t + len);
      tone(880, t + 0.04, 0.12, 0.08, "sine", 1320);
      break;
    }
    case "success":
      bell(1046.5, t, 0.16, 0.5);
      bell(1567.98, t + 0.07, 0.13, 0.6);
      break;
    case "error":
      tone(311.13, t, 0.14, 0.2, "triangle");
      tone(233.08, t + 0.15, 0.22, 0.2, "triangle");
      break;
  }
}
