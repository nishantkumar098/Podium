"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A little white character who lives along the top bar and keeps a day
 * routine by the real clock.
 *
 * Two levels: the bar's bottom edge is a LEDGE (he sits on it swinging his
 * legs over the page, or lies on it), and the page just below is his FLOOR,
 * where he walks, rides a bicycle, works at his desk on a laptop, sleeps in
 * a bed, has coffee and stretches. He jumps down and hops back up between
 * them. Drawn mostly in profile, facing where he's going or what he's doing;
 * hover and he turns to look at you and says something; click and he hops.
 *
 * Pure SVG with CSS / SMIL animation (styles under "Desk buddy" in
 * globals.css). Only his body takes the mouse — props and empty space let
 * clicks through to the page. His place in the day lives at module level,
 * so changing screens (which remounts the shell) doesn't restart it.
 * Hidden on narrow screens; sits still under reduced motion.
 */
type Act = "sit" | "lie" | "walk" | "cycle" | "desk" | "bed" | "coffee" | "stretch" | "jump";
type Level = "ledge" | "floor";

const S = 1.5; // drawing scale
const VBW = 80; // drawing width in units (props extend right of the character)
const GROUND = 51; // ground line in drawing units
const BAR = 52; // top bar height, px
const DROP = 80; // how far below the bar the floor is, px
const CX = 30; // the character's centre line in drawing units
const WALK_SPEED = 34; // px/s
const CYCLE_SPEED = 85; // px/s

const LEVEL: Record<Exclude<Act, "jump">, Level> = { sit: "ledge", lie: "ledge", walk: "floor", cycle: "floor", desk: "floor", bed: "floor", coffee: "floor", stretch: "floor" };
const topFor = (level: Level) => (level === "ledge" ? BAR : BAR + DROP) - GROUND * S;

/** How likely each activity is at this hour. */
function weightsFor(h: number): Partial<Record<Exclude<Act, "jump">, number>> {
  if (h >= 22 || h < 6) return { bed: 9, lie: 0.5 };
  if (h < 9) return { stretch: 2, coffee: 3, walk: 2, cycle: 2, sit: 1 };
  if (h < 13) return { desk: 1.8, coffee: 1.4, walk: 2, sit: 1.5, cycle: 1.2, stretch: 0.6 };
  if (h < 14) return { sit: 3, lie: 1.5, coffee: 2, walk: 1.5, cycle: 1 };
  if (h < 18) return { desk: 1.6, walk: 2, sit: 1.8, coffee: 1.2, cycle: 1.5, lie: 0.8, stretch: 0.7 };
  return { cycle: 2.5, sit: 2.5, lie: 2, walk: 1.5, bed: 0.6 };
}

const DURATION: Record<"sit" | "lie" | "desk" | "bed" | "coffee" | "stretch", [number, number]> = {
  sit: [16, 30],
  lie: [16, 30],
  desk: [14, 24],
  bed: [50, 100],
  coffee: [10, 16],
  stretch: [5, 7],
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function pick(prev: Act): Exclude<Act, "jump"> {
  const w = weightsFor(new Date().getHours());
  const entries = (Object.entries(w) as Array<[Exclude<Act, "jump">, number]>).filter(([a]) => a !== prev || a === "bed");
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let r = Math.random() * total;
  for (const [a, v] of entries) {
    r -= v;
    if (r <= 0) return a;
  }
  return entries[0]?.[0] ?? "sit";
}

interface Step {
  act: Act;
  secs: number;
  x?: number;
  level?: Level;
  dir?: 1 | -1;
}

/** Survives screen changes: where he is and what he's doing. */
const memory: { act: Act; x: number | null; level: Level; dir: 1 | -1; until: number } = { act: "sit", x: null, level: "ledge", dir: 1, until: 0 };

function lineFor(act: Act, name: string): string {
  const h = new Date().getHours();
  switch (act) {
    case "bed":
      return "Zzz… five more minutes";
    case "desk":
      return "Busy busy — invoices won't send themselves!";
    case "coffee":
      return "Coffee first ☕";
    case "lie":
      return "Just resting my eyes…";
    case "stretch":
      return "Big stretch!";
    case "cycle":
      return "Wheee! 🚲";
    case "walk":
      return "Stretching my legs";
    case "jump":
      return "Hup!";
    default:
      return h < 12 ? `Morning, ${name}!` : h < 17 ? `Hi ${name}! 👋` : `Long day, ${name}?`;
  }
}

export function DeskBuddy({ name }: { name: string }) {
  const lane = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [act, setAct] = useState<Act>(memory.act);
  const [x, setX] = useState<number | null>(memory.x);
  const [level, setLevel] = useState<Level>(memory.level);
  const [dir, setDir] = useState<1 | -1>(memory.dir);
  const [secs, setSecs] = useState(0);
  const [hover, setHover] = useState(false);
  const [hopping, setHopping] = useState(false);
  const timer = useRef<number>();
  const reduced = useRef(false);
  const widthRef = useRef(0);
  widthRef.current = width;

  useLayoutEffect(() => {
    reduced.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const el = lane.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Keep the character (not the props) inside the lane. */
  const clamp = (v: number) => Math.max(0, Math.min(v, widthRef.current - VBW * S * 0.75));

  useEffect(() => {
    if (width < 150) return;
    setX((cur) => {
      const v = cur === null ? clamp(rand(0, width)) : clamp(cur);
      memory.x = v;
      return v;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const run = useCallback((plan: Step[], then: Act) => {
    const step = plan.shift();
    if (!step) {
      advance(then);
      return;
    }
    memory.act = step.act;
    memory.until = Date.now() + step.secs * 1000;
    if (step.x !== undefined) memory.x = step.x;
    if (step.level) memory.level = step.level;
    if (step.dir) memory.dir = step.dir;
    setSecs(step.secs);
    setAct(step.act);
    if (step.x !== undefined) setX(step.x);
    if (step.level) setLevel(step.level);
    if (step.dir) setDir(step.dir);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => run(plan, step.act), step.secs * 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Plan what's next: change level if needed, often travel, then do it. */
  const advance = useCallback(
    (prev: Act) => {
      if (reduced.current) return;
      const next = pick(prev);
      const want = LEVEL[next];
      const w = widthRef.current;
      const plan: Step[] = [];
      let at = memory.x ?? 0;
      if (memory.level !== want) {
        const jx = clamp(at + rand(-60, 60));
        plan.push({ act: "jump", secs: 0.9, x: jx, level: want, dir: jx >= at ? 1 : -1 });
        at = jx;
      }
      const travelling = next === "walk" || next === "cycle";
      if (want === "floor" && (travelling || Math.random() < 0.45)) {
        let to = clamp(rand(0, w));
        if (Math.abs(to - at) < 50) to = clamp(at + (at > w / 2 ? -110 : 110));
        const speed = next === "cycle" ? CYCLE_SPEED : WALK_SPEED;
        const laps = next === "cycle" ? 3 + Math.floor(Math.random() * 4) : 1; // 3–6 legs when cycling
for (let i = 0; i < laps; i += 1) {
  const dest = i === laps - 1 ? to : i % 2 === 0 ? clamp(w) : 0; // far end, near end, …, then the chosen spot
  plan.push({ act: next === "cycle" ? "cycle" : "walk", secs: Math.max(1.4, Math.abs(dest - at) / speed), x: dest, dir: dest >= at ? 1 : -1 });
  at = dest;
}
      }
      if (!travelling) {
        const d = DURATION[next];
        plan.push({ act: next, secs: rand(d[0], d[1]), dir: next === "desk" || next === "bed" ? (Math.random() < 0.5 ? 1 : -1) : undefined });
      }
      run(plan, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run],
  );

  // Pick up the routine where it was (or start it) once the lane is ready.
  const ready = width >= 150 && x !== null;
  useEffect(() => {
    if (!ready) return;
    if (reduced.current) {
      setAct("sit");
      setLevel("ledge");
      return;
    }
    const left = memory.until - Date.now();
    const moving = memory.act === "walk" || memory.act === "cycle" || memory.act === "jump";
    if (!moving && left > 1000) {
      setAct(memory.act);
      timer.current = window.setTimeout(() => advance(memory.act), left);
    } else if (moving) {
      advance(memory.act);
    } else {
      run([{ act: "sit", secs: rand(6, 12), level: "ledge" }], "sit");
    }
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!ready) return <div className="bd-lane" ref={lane} aria-hidden="true" />;

  const travel = act === "walk" || act === "cycle";
  const transition = travel ? `left ${secs}s linear` : act === "jump" ? `left ${secs}s linear, top ${secs}s ${level === "floor" ? "cubic-bezier(.5,0,.9,.5)" : "cubic-bezier(.1,.6,.4,1)"}` : "none";
  const mirror = dir === -1 && act !== "sit" && act !== "lie" && act !== "stretch";
  const nearRight = (x ?? 0) > width - 260;

  return (
    <div className="bd-lane" ref={lane} aria-hidden="true">
      <div
        className={`bd-actor bd-${act}`}
        style={{ left: x ?? 0, top: topFor(level), transition }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => {
          setHopping(true);
          window.setTimeout(() => setHopping(false), 600);
        }}
      >
        {hover && (
          <div className={`bd-bubble ${nearRight ? "left" : ""} ${level}`} style={nearRight ? { right: `${VBW * S - (CX + 12) * S}px` } : { left: `${(CX + 12) * S}px` }}>
            {lineFor(act, name)}
          </div>
        )}
        <svg key={act} className={`bd-svg ${hopping ? "bd-hop" : ""}`} viewBox={`0 0 ${VBW} 66`} width={VBW * S} height={66 * S}>
          {/* Mirrored about his centre line when facing left. */}
          <g transform={mirror ? `translate(${CX * 2} 0) scale(-1 1)` : undefined}>
            {act === "sit" && <SitPose front={hover} />}
            {act === "lie" && <LiePose front={hover} />}
            {act === "walk" && <WalkPose front={hover} />}
            {act === "cycle" && <CyclePose front={hover} />}
            {act === "desk" && <DeskPose front={hover} />}
            {act === "bed" && <BedPose />}
            {act === "coffee" && <CoffeePose front={hover} />}
            {act === "stretch" && <StretchPose />}
            {act === "jump" && <JumpPose />}
          </g>
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- drawing
// Units: ground at y = 51, character centred on x = 30, facing right.
// White fill with an ink outline; limbs are an ink stroke under a thinner
// white one so they read as outlined white shapes. <Me> wraps the parts of
// him that take the mouse.

const Me = ({ children }: { children: ReactNode }) => <g className="bd-me">{children}</g>;

function Limb({ d, cls, o, anim }: { d: string; cls?: string; o?: string; anim?: { values: string; dur: string; begin?: string } }) {
  const a = anim ? <animate attributeName="d" values={anim.values} dur={anim.dur} begin={anim.begin ?? "0s"} repeatCount="indefinite" /> : null;
  return (
    <g className={cls} style={o ? { transformOrigin: o } : undefined}>
      <path d={d} className="bd-limb-ink">
        {a}
      </path>
      <path d={d} className="bd-limb">
        {a}
      </path>
    </g>
  );
}

/** Profile head, facing right: one eye, a little nose, mouth at the front. */
function PHead({ cx, cy, eyes = "open", mouth = "smile", cls, o }: { cx: number; cy: number; eyes?: "open" | "closed"; mouth?: "smile" | "o" | "flat"; cls?: string; o?: string }) {
  return (
    <g className={cls} style={o ? { transformOrigin: o } : undefined}>
      <circle cx={cx} cy={cy} r={9.5} className="bd-body" />
      <path d={`M${cx + 9.1} ${cy - 0.6} q2.3 0.9 0.2 2.6`} className="bd-body nose" />
      <path d={`M${cx - 3.5} ${cy - 8.8} q1.2 -3.9 4 -3`} className="bd-line" />
      <path d={`M${cx - 3.2} ${cy - 1.8} q-1.8 1.8 0 3.6`} className="bd-line faint" />
      <circle cx={cx + 3.2} cy={cy + 2.6} r={1.5} className="bd-cheek" />
      {eyes === "open" ? (
        <g className="bd-blink" style={{ transformOrigin: `${cx + 4.4}px ${cy - 1.3}px` }}>
          <circle cx={cx + 4.4} cy={cy - 1.3} r={1.25} className="bd-ink" />
        </g>
      ) : (
        <path d={`M${cx + 2.8} ${cy - 1} q1.5 1.3 3 0`} className="bd-line" />
      )}
      {mouth === "smile" && <path d={`M${cx + 5.6} ${cy + 3.6} q1.3 0.7 2.4 -0.4`} className="bd-line" />}
      {mouth === "o" && <ellipse cx={cx + 6.6} cy={cy + 4} rx={1} ry={1.4} className="bd-ink" />}
      {mouth === "flat" && <path d={`M${cx + 5.5} ${cy + 4} h2`} className="bd-line" />}
    </g>
  );
}

/** Facing you — only when you hover, or for a quick glance. */
function FHead({ cx, cy, eyes = "open", mouth = "smile" }: { cx: number; cy: number; eyes?: "open" | "closed"; mouth?: "smile" | "o" }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={9.5} className="bd-body" />
      <path d={`M${cx - 1.2} ${cy - 9.2} q1.6 -3.8 3.8 -2.6`} className="bd-line" />
      <circle cx={cx - 4.9} cy={cy + 1.8} r={1.5} className="bd-cheek" />
      <circle cx={cx + 4.9} cy={cy + 1.8} r={1.5} className="bd-cheek" />
      {eyes === "open" ? (
        <g className="bd-blink" style={{ transformOrigin: `${cx}px ${cy - 1}px` }}>
          <circle cx={cx - 2.4} cy={cy - 1} r={1.2} className="bd-ink" />
          <circle cx={cx + 2.4} cy={cy - 1} r={1.2} className="bd-ink" />
        </g>
      ) : (
        <>
          <path d={`M${cx - 3.6} ${cy - 1} q1.2 1.2 2.4 0`} className="bd-line" />
          <path d={`M${cx + 1.2} ${cy - 1} q1.2 1.2 2.4 0`} className="bd-line" />
        </>
      )}
      {mouth === "smile" ? <path d={`M${cx - 1.7} ${cy + 2.7} q1.7 1.6 3.4 0`} className="bd-line" /> : <ellipse cx={cx} cy={cy + 3.4} rx={1.3} ry={1.8} className="bd-ink" />}
    </g>
  );
}

const Head = ({ front, cx, cy }: { front?: boolean; cx: number; cy: number }) => (front ? <FHead cx={cx} cy={cy} /> : <PHead cx={cx} cy={cy} />);
const Torso = ({ x, y, w = 11, h = 14 }: { x: number; y: number; w?: number; h?: number }) => <rect x={x} y={y} width={w} height={h} rx={Math.min(w, h) / 2.2} className="bd-body" />;
const Shadow = ({ cx = CX, rx = 10 }: { cx?: number; rx?: number }) => <ellipse cx={cx} cy={GROUND + 0.6} rx={rx} ry={1.8} className="bd-shadow" />;

/** On the ledge, legs over the page; he looks about — this way, that way, the page below. */
function SitPose({ front }: { front: boolean }) {
  return (
    <Me>
      <Limb d="M27.5 50 L26.5 62.5" cls="bd-swing-a" o="27.5px 50px" />
      <Limb d="M32.5 50 L33.5 62.5" cls="bd-swing-b" o="32.5px 50px" />
      <Torso x={24.5} y={37} />
      <Limb d="M25.5 40 L21.5 50" />
      <Limb d="M34.5 40 L38.5 50" />
      {front ? (
        <FHead cx={30} cy={28} />
      ) : (
        <g className="bd-tilt" style={{ transformOrigin: "30px 37px" }}>
          <g className="bd-look-r">
            <PHead cx={30} cy={28} />
          </g>
          <g className="bd-look-l">
            <g transform="translate(60 0) scale(-1 1)">
              <PHead cx={30} cy={28} />
            </g>
          </g>
          <g className="bd-look-down">
            <g transform="rotate(28 30 28)">
              <PHead cx={30} cy={28} />
            </g>
          </g>
        </g>
      )}
    </Me>
  );
}

/** Lying on the ledge, hands behind his head, one foot bouncing. */
function LiePose({ front }: { front: boolean }) {
  return (
    <Me>
      <Limb d="M34 48 L50 49.5" />
      <Limb d="M34 44 L42 37" />
      <Limb d="M42 37 L48.5 44" cls="bd-bounce" o="42px 37px" />
      <Torso x={18} y={41} w={17} h={10} />
      <Limb d="M21 43 L15 34.5 L8.5 36.5" />
      {front ? (
        <FHead cx={11} cy={42.5} />
      ) : (
        <g transform="rotate(-90 11 42.5)">
          <PHead cx={11} cy={42.5} />
        </g>
      )}
    </Me>
  );
}

function WalkPose({ front }: { front: boolean }) {
  return (
    <>
      <Shadow />
      <Me>
        <g className="bd-bob">
          <Limb d="M29 38 L28.5 50.5 L31 50.5" cls="bd-step-a" o="29px 38px" />
          <Limb d="M29 28 L28 37" cls="bd-arm-b" o="29px 28px" />
          <Limb d="M31 38 L31.5 50.5 L34 50.5" cls="bd-step-b" o="31px 38px" />
          <Torso x={24.5} y={25} />
          <Limb d="M31 28 L32 37" cls="bd-arm-a" o="31px 28px" />
          <Head front={front} cx={30} cy={16.5} />
        </g>
      </Me>
    </>
  );
}

// Bicycle geometry, and pedalling legs solved per frame (two-bone IK) so the
// feet stay on the pedals as the crank turns.
const HIP = { x: 24.5, y: 27.5 };
const CRANK = { x: 31, y: 44 };
const CRANK_R = 4;
const THIGH = 11.5;
const SHIN = 11.5;
const PEDAL_DUR = 0.9;

function legPath(theta: number): string {
  const px = CRANK.x + CRANK_R * Math.cos(theta);
  const py = CRANK.y + CRANK_R * Math.sin(theta);
  const dx = px - HIP.x;
  const dy = py - HIP.y;
  const d = Math.min(Math.hypot(dx, dy), THIGH + SHIN - 0.2);
  const a = (THIGH * THIGH - SHIN * SHIN + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, THIGH * THIGH - a * a));
  const bx = HIP.x + (a * dx) / d;
  const by = HIP.y + (a * dy) / d;
  const k1 = { x: bx - (h * dy) / d, y: by + (h * dx) / d };
  const k2 = { x: bx + (h * dy) / d, y: by - (h * dx) / d };
  const knee = k1.x > k2.x ? k1 : k2; // knees point forward
  const f = (n: number) => n.toFixed(2);
  return `M${f(HIP.x)} ${f(HIP.y)} L${f(knee.x)} ${f(knee.y)} L${f(px)} ${f(py)} L${f(px + 2.4)} ${f(py)}`;
}
const LEG_FRAMES = Array.from({ length: 17 }, (_, i) => legPath((i / 16) * Math.PI * 2)).join(";");
const LEG_START = legPath(0);
const LEG_START_B = legPath(Math.PI);

function Wheel({ cx }: { cx: number }) {
  return (
    <g>
      <circle cx={cx} cy={43.5} r={7.4} className="bd-tyre" />
      <circle cx={cx} cy={43.5} r={5.6} className="bd-rim" />
      <g>
        <path d={`M${cx - 5.6} 43.5 H${cx + 5.6} M${cx} 37.9 V49.1 M${cx - 4} 39.5 L${cx + 4} 47.5 M${cx - 4} 47.5 L${cx + 4} 39.5`} className="bd-spoke" />
        <animateTransform attributeName="transform" type="rotate" from={`0 ${cx} 43.5`} to={`360 ${cx} 43.5`} dur="0.7s" repeatCount="indefinite" />
      </g>
      <circle cx={cx} cy={43.5} r={1} className="bd-ink" />
    </g>
  );
}

function CyclePose({ front }: { front: boolean }) {
  return (
    <>
      <Shadow cx={32} rx={20} />
      <g className="bd-ride">
        <Limb d={LEG_START_B} anim={{ values: LEG_FRAMES, dur: `${PEDAL_DUR}s`, begin: `-${PEDAL_DUR / 2}s` }} />
        <Wheel cx={18} />
        <Wheel cx={46} />
        {/* frame, saddle, fork, bars */}
        <path d="M18 43.5 L31 44 L42 32 L25.5 31 Z M25.5 31 L24.2 27.5 M42 32 L46 43.5 M42 32 L41.2 27.2 L44.6 26.4" className="bd-frame" />
        <path d="M21 27.3 H27.4" className="bd-saddle" />
        <g>
          <path d={`M${CRANK.x} ${CRANK.y} L${CRANK.x + CRANK_R} ${CRANK.y} M${CRANK.x} ${CRANK.y} L${CRANK.x - CRANK_R} ${CRANK.y}`} className="bd-frame thin" />
          <animateTransform attributeName="transform" type="rotate" from={`0 ${CRANK.x} ${CRANK.y}`} to={`360 ${CRANK.x} ${CRANK.y}`} dur={`${PEDAL_DUR}s`} repeatCount="indefinite" />
        </g>
        <circle cx={CRANK.x} cy={CRANK.y} r={2.2} className="bd-body" />
        <Me>
          <rect x={21} y={13.5} width={11} height={15.5} rx={5} className="bd-body" transform="rotate(34 26.5 27)" />
          <Limb d="M33 16.5 L38 22 L43.5 26.8" />
          <Limb d={LEG_START} anim={{ values: LEG_FRAMES, dur: `${PEDAL_DUR}s` }} />
          <Head front={front} cx={36.2} cy={9.8} />
        </Me>
      </g>
    </>
  );
}

/** At his desk, on an office chair, typing on a laptop — mug and a drawer unit beside it. */
function DeskPose({ front }: { front: boolean }) {
  return (
    <>
      <Shadow cx={44} rx={32} />
      {/* chair */}
      <rect x={13.5} y={19.5} width={4.6} height={19} rx={2.3} className="bd-body" />
      <rect x={15.5} y={36.5} width={18} height={3.8} rx={1.8} className="bd-body" />
      <path d="M24.5 40.3 V47.2 M18 49.4 H31" className="bd-line thick" />
      <circle cx={18.5} cy={49.7} r={1.6} className="bd-body" />
      <circle cx={30.5} cy={49.7} r={1.6} className="bd-body" />
      {/* desk */}
      <rect x={40} y={31} width={34} height={3.2} rx={1.2} className="bd-body" />
      <path d="M43.5 34.2 V51 M70.5 34.2 V51" className="bd-line thick" />
      <rect x={62} y={36} width={8.5} height={9} rx={1.2} className="bd-body" />
      <path d="M64.5 40.5 h3.5" className="bd-line" />
      {/* laptop, screen towards him, glowing */}
      <circle cx={55} cy={22} r={9} className="bd-glow" />
      <rect x={46} y={29.3} width={15} height={1.9} rx={0.8} className="bd-body" />
      <path d="M59.8 29.3 L63.2 16.5 L65.8 16.5 L62.4 29.3 Z" className="bd-body" />
      {/* mug */}
      <rect x={66.3} y={25.5} width={4.8} height={5.5} rx={1.1} className="bd-body" />
      <path d="M71.1 26.8 q2 0.6 0 2.8" className="bd-line" />
      <path d="M67.6 23.8 q-1 -1.6 0 -3.2 M70 23.8 q-1 -1.6 0 -3.2" className="bd-steam s1" />
      <Me>
        <Limb d="M24 36 L35.5 37 L35.5 50.5 L38 50.5" />
        <Limb d="M27.5 36 L38 37 L38.5 50.5 L41 50.5" />
        <Limb d="M26.5 25.5 L34 31 L47 29.3" cls="bd-type-a" o="34px 31px" />
        <Torso x={20.5} y={22.5} h={14.5} />
        <Limb d="M28.5 25.5 L37 31.3 L50 29.3" cls="bd-type-b" o="37px 31.3px" />
        <g className="bd-nod" style={{ transformOrigin: "26px 22px" }}>
          <Head front={front} cx={26.5} cy={13} />
        </g>
      </Me>
    </>
  );
}

/** Tucked up in bed: pillow, blanket rising and falling, Zs drifting up. */
function BedPose() {
  return (
    <>
      <Shadow cx={40} rx={36} />
      <rect x={3} y={25} width={5} height={26} rx={2} className="bd-body" />
      <rect x={72} y={35} width={5} height={16} rx={2} className="bd-body" />
      <rect x={5} y={41} width={70} height={6.5} rx={2.5} className="bd-body" />
      <path d="M9 47.5 V51 M71 47.5 V51" className="bd-line thick" />
      <ellipse cx={15.5} cy={37.8} rx={8} ry={3.8} className="bd-body" />
      <Me>
        <PHead cx={17} cy={31.5} eyes="closed" mouth="flat" />
        <g className="bd-breathe" style={{ transformOrigin: "46px 41px" }}>
          <path d="M23 41 Q24 30.5 38 30.5 Q58 29.5 68 34 Q71 36 71.5 41 Z" className="bd-blanket" />
          <path d="M25 34.5 Q40 33 54 33.8" className="bd-line faint" />
        </g>
      </Me>
      <text x={27} y={24} className="bd-z bd-z1">
        z
      </text>
      <text x={32} y={17} className="bd-z bd-z2">
        z
      </text>
      <text x={38} y={10} className="bd-z bd-z3">
        Z
      </text>
    </>
  );
}

function CoffeePose({ front }: { front: boolean }) {
  return (
    <>
      <Shadow />
      <Me>
        <Limb d="M29 38 L28.5 50.5 L31 50.5" />
        <Limb d="M29 28 L28 37" />
        <Limb d="M31 38 L31.5 50.5 L34 50.5" />
        <Torso x={24.5} y={25} />
        <Head front={front} cx={30} cy={16.5} />
        <g className="bd-sip" style={{ transformOrigin: "31px 28px" }}>
          <Limb d="M31 28 L36.5 32 L37.5 25.5" />
          <rect x={35.5} y={20} width={5.5} height={6} rx={1.2} className="bd-body" />
          <path d="M41 21.5 q2.2 0.6 0 3" className="bd-line" />
          <path d="M37 18 q-1.2 -2 0 -4 q1.2 -2 0 -4" className="bd-steam s1" />
          <path d="M39.5 18 q-1.2 -2 0 -4 q1.2 -2 0 -4" className="bd-steam s2" />
        </g>
      </Me>
    </>
  );
}

/** A big stretch and a yawn — the one moment he faces you unasked. */
function StretchPose() {
  return (
    <>
      <Shadow />
      <Me>
        <g className="bd-sway" style={{ transformOrigin: "30px 51px" }}>
          <Limb d="M27.5 38 L27 50.5" />
          <Limb d="M32.5 38 L33 50.5" />
          <Torso x={24.5} y={25} />
          <Limb d="M26 27 L21.5 17 L24.5 7.5" />
          <Limb d="M34 27 L38.5 17 L35.5 7.5" />
          <FHead cx={30} cy={16.5} eyes="closed" mouth="o" />
        </g>
      </Me>
    </>
  );
}

/** Mid-jump between the ledge and the floor. */
function JumpPose() {
  return (
    <Me>
      <Limb d="M29 38 L34 43 L30.5 48" />
      <Limb d="M31 38 L36 42.5 L33 47.5" />
      <Limb d="M29 28 L25 20 L27 13" />
      <Torso x={24.5} y={25} />
      <Limb d="M31 28 L36 20 L35 12.5" />
      <PHead cx={30} cy={16.5} mouth="o" />
    </Me>
  );
}

