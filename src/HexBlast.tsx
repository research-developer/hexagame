import React, { useState, useRef, useEffect, useCallback } from "react";
import { RotateCcw, Undo2, Volume2, VolumeX, HelpCircle, Zap, ChevronRight, X, User, Users, Bomb, Eye, Sparkles, Repeat } from "lucide-react";

/*  HEX BLAST  — an original sweep-combo hex puzzle.
    Tap a tile: it folds cell-by-cell off the board in its arrow direction,
    sweeping any SAME-direction tile in its path along with it. A DIFFERENT-
    direction tile blocks the shot — the tile leans forward and reflects
    back to its origin.                                                  */

const SIZE = 30;                       // hex radius (user units)
const CHAIN_WINDOW = 2600;             // ms to keep a chain alive (solo only)
const FOLD_MS = 130;                   // ms per cell when folding

// flat-top hex, axial (q,r). Six directions w/ draw angle (0 = up, clockwise).
const DIRS = {
  N:  { dq: 0,  dr: -1, angle: 0 },
  NE: { dq: 1,  dr: -1, angle: 60 },
  SE: { dq: 1,  dr: 0,  angle: 120 },
  S:  { dq: 0,  dr: 1,  angle: 180 },
  SW: { dq: -1, dr: 1,  angle: 240 },
  NW: { dq: -1, dr: 0,  angle: 300 },
};
const DIR_KEYS = Object.keys(DIRS);

const COLORS = {
  coral:  { lite: "#ff8a7a", base: "#ff4d4d", dark: "#c0233a", arrow: "#fff" },
  amber:  { lite: "#ffc06b", base: "#ff9d2e", dark: "#c96a06", arrow: "#fff" },
  sun:    { lite: "#ffe588", base: "#ffd23f", dark: "#d39a00", arrow: "#7a5500" },
  mint:   { lite: "#86eea4", base: "#34d36b", dark: "#138c41", arrow: "#fff" },
  azure:  { lite: "#8cbbff", base: "#3f8cff", dark: "#1a52c4", arrow: "#fff" },
  violet: { lite: "#caa1ff", base: "#a45cff", dark: "#6f25d6", arrow: "#fff" },
};
const COLOR_KEYS = Object.keys(COLORS);

// Each direction has a fixed rainbow color, walking clockwise around the wheel
// starting from N. Color = direction signal; the arrow glyph is redundant info.
const DIR_COLOR = {
  N:  "coral",  // red
  NE: "amber",  // orange
  SE: "sun",    // yellow
  S:  "mint",   // green
  SW: "azure",  // blue
  NW: "violet", // violet
};

// per-player palette (clearly distinct from any tile palette accent)
const PLAYERS = [
  { name: "P1", glow: "#3fc7ff", base: "#1aa7e6", deep: "#0a3a55", soft: "rgba(63,199,255,.18)" },
  { name: "P2", glow: "#ff6bd4", base: "#e63ab0", deep: "#5a0a48", soft: "rgba(255,107,212,.18)" },
];

// ---------- 2P modifier cells & powerups ----------
// Modifiers ride on top of a normal rainbow tile. They never change a tile's
// dir/color, only relax sweep rules or boost score. None can strand a tile
// that wasn't already strandable, so packBoard's solvability invariant holds.
type Modifier = "star" | "crystal" | "wild" | "chain" | "sling";
const MODIFIERS: { type: Modifier; glyph: string; tint: string; name: string; blurb: string }[] = [
  { type: "star",    glyph: "★", tint: "#ffd23f", name: "Score Star",  blurb: "Sweep that touches it scores ×2." },
  { type: "crystal", glyph: "◆", tint: "#3fd1ff", name: "Crystal",     blurb: "Sweep that touches it scores ×3." },
  { type: "wild",    glyph: "◎", tint: "#f4f1fa", name: "Wildcard",    blurb: "Counts as any color in a sweep. Stays on the board." },
  { type: "chain",   glyph: "⊕", tint: "#ff9d2e", name: "Chain Boost", blurb: "Take an extra turn after this move." },
  { type: "sling",   glyph: "↠", tint: "#a45cff", name: "Slingshot",   blurb: "Sweep continues past the first blocker, taking one more matching tile." },
];
const MODIFIER_BY_TYPE: Record<Modifier, typeof MODIFIERS[number]> = MODIFIERS.reduce(
  (acc, m) => ((acc[m.type] = m), acc), {} as any
);
const MODIFIER_DENSITY = 0.08;  // ~8% of tiles get a modifier in 2P
const MODIFIER_MIN = 3;

type PowerupType = "bomb" | "forecast" | "wildTap" | "freeTurn";
type PowerupCounts = Record<PowerupType, number>;
const POWERUPS: { type: PowerupType; name: string; blurb: string; tint: string }[] = [
  { type: "bomb",     name: "Bomb",      blurb: "Clears that tile + its 6 neighbors. No sweep, no chain.", tint: "#ff4d4d" },
  { type: "forecast", name: "Forecast",  blurb: "Preview the sweep. Doesn't consume your turn.",            tint: "#3fd1ff" },
  { type: "wildTap",  name: "Wild Tap",  blurb: "Launch the next tap in any direction you choose.",         tint: "#ffd23f" },
  { type: "freeTurn", name: "Free Turn", blurb: "Don't pass the turn after your next move.",                tint: "#34d36b" },
];
const STARTING_HAND: PowerupCounts = { bomb: 1, forecast: 1, wildTap: 1, freeTurn: 1 };
const FORECAST_MS = 1600;
const POWERUP_ICON: Record<PowerupType, any> = {
  bomb: Bomb, forecast: Eye, wildTap: Sparkles, freeTurn: Repeat,
};

// Tag a fraction of tiles on a fully-packed board with random modifiers,
// distributed roughly evenly across the 5 types. Safe to call after packBoard.
function sprinkleModifiers(board: Map<string, any>, R: number) {
  const total = cellCount(R);
  const count = Math.min(board.size, Math.max(MODIFIER_MIN, Math.round(total * MODIFIER_DENSITY)));
  const keys = [...board.keys()];
  for (let i = keys.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  for (let i = 0; i < count; i++) {
    const k = keys[i];
    const t = board.get(k);
    const mod = MODIFIERS[i % MODIFIERS.length].type;
    board.set(k, { ...t, modifier: mod });
  }
}

// ---------- hex geometry ----------
const px = (q, r) => ({ x: SIZE * 1.5 * q, y: SIZE * Math.sqrt(3) * (r + q / 2) });
const cubeMax = (q, r) => { const x = q, z = r, y = -x - z; return Math.max(Math.abs(x), Math.abs(y), Math.abs(z)); };
const key = (q, r) => q + "," + r;
const STEP_PX = SIZE * Math.sqrt(3); // distance between adjacent flat-top hex centers

function allCells(R) {
  const out = [];
  for (let q = -R; q <= R; q++)
    for (let r = -R; r <= R; r++)
      if (cubeMax(q, r) <= R) out.push({ q, r });
  return out;
}
function dirUnitPx(d) {
  const dx = 1.5 * d.dq, dy = Math.sqrt(3) * (d.dr + d.dq / 2);
  const m = Math.hypot(dx, dy);
  return { x: dx / m, y: dy / m };
}
const rnd = (n) => Math.floor(Math.random() * n);

const SIZES = [
  { R: 3, label: "S" },
  { R: 4, label: "M" },
  { R: 5, label: "L" },
  { R: 6, label: "XL" },
];
const cellCount = (R) => 3 * R * R + 3 * R + 1;
const isDiagonal = (dir) => dir === "NE" || dir === "SE" || dir === "SW" || dir === "NW";

// Flat-top hexes have THREE lane families. Each direction travels along one:
//   V  (vertical column)  : N / S
//   D1 ( ╱  diagonal)      : NE / SW
//   D2 ( ╲  diagonal)      : SE / NW
const AXIS = { N: "V", S: "V", NE: "D1", SW: "D1", SE: "D2", NW: "D2" };
const AXES = ["V", "D1", "D2"];
const AXIS_GLYPH = { V: "↕", D1: "╱", D2: "╲" };

// Difficulty is driven by the WEAKEST lane family's blocked %, so a board can't
// hide an easy diagonal escape behind a high pooled average.
const DIFFS = [
  { label: "Easy",   lo: 0.00, hi: 0.30, expert: false },
  { label: "Med",    lo: 0.30, hi: 0.45, expert: false },
  { label: "Hard",   lo: 0.45, hi: 0.60, expert: false },
  { label: "Expert", lo: 0.60, hi: 1.00, expert: true  },
];
const DIFF_COLOR = ["#34d36b", "#ffd23f", "#ff9d2e", "#ff4d4d"];

// Pure greedy pack from an empty board: each step places a tile in the empty
// cell with the fewest valid directions (ties broken at random), with a random
// direction chosen from that cell's valid set. Because every tile is placed
// with its exit path already clear of different-direction tiles given the
// current board, the constructive-solvability invariant holds: launching in
// reverse-placement order leaves every prior tile's exit unblocked.
//
// Empirically this fills every cell on every attempt across all board sizes
// (R=3..6), so the board always spawns fully packed.
function packBoard(board, R) {
  const total = cellCount(R);
  while (board.size < total) {
    let bestList: { q: number; r: number; v: string[] }[] = [];
    let bestLen = 7;
    for (let q = -R; q <= R; q++) {
      for (let r = -R; r <= R; r++) {
        if (cubeMax(q, r) > R) continue;
        if (board.has(key(q, r))) continue;
        const v: string[] = [];
        for (const dName of DIR_KEYS) {
          const d = DIRS[dName];
          let cq = q + d.dq, cr = r + d.dr, bad = false;
          while (cubeMax(cq, cr) <= R) {
            const t = board.get(key(cq, cr));
            if (t && t.dir !== dName) { bad = true; break; }
            cq += d.dq; cr += d.dr;
          }
          if (!bad) v.push(dName);
        }
        if (v.length === 0) continue;
        if (v.length < bestLen) { bestLen = v.length; bestList = [{ q, r, v }]; }
        else if (v.length === bestLen) bestList.push({ q, r, v });
      }
    }
    if (bestList.length === 0) return; // unpackable cell remains
    const pick = bestList[rnd(bestList.length)];
    const dName = pick.v[rnd(pick.v.length)];
    board.set(key(pick.q, pick.r), { color: DIR_COLOR[dName], dir: dName });
  }
}

// a tile can launch iff nothing of a DIFFERENT direction sits on its path to the edge
function canLaunch(board, R, q, r, dir) {
  const d = DIRS[dir];
  let cq = q, cr = r;
  while (cubeMax(cq, cr) <= R) {
    const t = board.get(key(cq, cr));
    if (t && t.dir !== dir) return false;
    cq += d.dq; cr += d.dr;
  }
  return true;
}
// per-axis blocked %, plus overall and the weakest-lane value that sets difficulty
function metrics(board, R) {
  let total = 0, free = 0;
  const at = { V: [0, 0], D1: [0, 0], D2: [0, 0] }; // [count, launchable]
  for (const [k, tile] of board) {
    total++;
    const [q, r] = k.split(",").map(Number);
    const ok = canLaunch(board, R, q, r, tile.dir);
    if (ok) free++;
    const a = AXIS[tile.dir];
    at[a][0]++; if (ok) at[a][1]++;
  }
  const axB = {};
  for (const a of AXES) axB[a] = at[a][0] >= 3 ? 1 - at[a][1] / at[a][0] : 0;
  const minAxis = Math.min(axB.V, axB.D1, axB.D2);
  return { overall: total ? 1 - free / total : 0, axB, minAxis, tiles: total };
}
// Sample N fully-packed boards via packBoard, then pick the one whose weakest-
// lane blocked % best fits the requested difficulty band (Expert maximizes it).
// Level nudges the band slightly upward — each level makes the same band a bit
// tougher within the difficulty's range.
function genBoardDiff(R, lvl, band) {
  const trials = band.expert ? 80 : 40;
  const bump = Math.min(0.06 * (lvl - 1), Math.max(0, band.hi - band.lo - 0.05));
  const lo = Math.min(band.lo + bump, band.hi - 0.02);
  let best: any = null, bestScore = -Infinity;
  for (let i = 0; i < trials; i++) {
    const b = new Map();
    packBoard(b, R);
    const m = metrics(b, R);
    let diffScore;
    if (band.expert) {
      diffScore = m.minAxis;
    } else if (m.minAxis >= lo && m.minAxis <= band.hi) {
      diffScore = 1;
    } else {
      const dist = m.minAxis < lo ? (lo - m.minAxis) : (m.minAxis - band.hi);
      diffScore = Math.max(0, 1 - dist * 3);
    }
    if (diffScore > bestScore) {
      bestScore = diffScore;
      best = { board: b, ...m };
      if (!band.expert && diffScore >= 1 && i >= 6) break;
    }
  }
  return best;
}

// number of cells from (q,r) traveling in dir until fully off the board
function stepsToEdge(q, r, dir, R) {
  const d = DIRS[dir];
  let cq = q, cr = r, steps = 0;
  while (cubeMax(cq, cr) <= R) { cq += d.dq; cr += d.dr; steps++; }
  return steps + 1; // one extra so the tile leaves the visible frame
}

// Compute the sweep group for a tap at (q0,r0) in direction `dir`.
// Wildcard tiles (modifier: 'wild') count as matching color and join the
// group. If the sweep would be blocked but a slingshot is in scope (on the
// launched tile, on the sweep group, or adjacent to any of them), the sweep
// continues past the first blocker and picks up the next encountered tile if
// it also matches. Returns the swept group plus the set of modifiers (with
// their cell keys) that the move touches.
function computeSweep(
  b: Map<string, any>, R: number, q0: number, r0: number, dir: string
): { group: any[]; blocked: boolean; modKeys: { type: Modifier; q: number; r: number }[]; extended: boolean } {
  const d = DIRS[dir];
  const group: any[] = [];
  let cq = q0, cr = r0, blocked = false;
  let bq = 0, br = 0;
  while (cubeMax(cq, cr) <= R) {
    const t = b.get(key(cq, cr));
    if (t) {
      if (t.dir === dir || t.modifier === "wild") {
        group.push({ q: cq, r: cr, ...t });
      } else {
        blocked = true; bq = cq; br = cr;
        break;
      }
    }
    cq += d.dq; cr += d.dr;
  }
  if (group.length === 0) return { group, blocked, modKeys: [], extended: false };

  // scope = group ∪ 6 neighbors of each group tile
  const scope = new Set<string>();
  for (const g of group) {
    scope.add(key(g.q, g.r));
    for (const dn of DIR_KEYS) scope.add(key(g.q + DIRS[dn].dq, g.r + DIRS[dn].dr));
  }
  const modKeys: { type: Modifier; q: number; r: number }[] = [];
  for (const sk of scope) {
    const t = b.get(sk);
    if (!t || !t.modifier) continue;
    const [sq, sr] = sk.split(",").map(Number);
    modKeys.push({ type: t.modifier, q: sq, r: sr });
  }
  // slingshot: extend past blocker, sweeping next matching tile
  let extended = false;
  if (blocked && modKeys.some((m) => m.type === "sling")) {
    let nq = bq + d.dq, nr = br + d.dr;
    while (cubeMax(nq, nr) <= R) {
      const t = b.get(key(nq, nr));
      if (t) {
        if (t.dir === dir || t.modifier === "wild") {
          group.push({ q: nq, r: nr, ...t });
          extended = true;
        }
        break;
      }
      nq += d.dq; nr += d.dr;
    }
    blocked = false;
  }
  return { group, blocked, modKeys, extended };
}

// ---------- tiny web-audio juice ----------
function useBlips(enabledRef) {
  const ctxRef = useRef(null);
  const ensure = () => {
    if (!ctxRef.current) {
      try { ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)(); }
      catch { ctxRef.current = null; }
    }
    return ctxRef.current;
  };
  const tone = (freq, dur, type = "triangle", vol = 0.18) => {
    if (!enabledRef.current) return;
    const ctx = ensure(); if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.6, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + dur);
  };
  // subtle two-step descending blip — soft, never harsh
  const errSoft = () => {
    if (!enabledRef.current) return;
    const ctx = ensure(); if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;
    const mk = (f, t0, dur) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(f, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur);
    };
    mk(440, t, 0.09);
    mk(330, t + 0.07, 0.13);
  };
  return {
    pop: (n, mult) => tone(280 + n * 55 + mult * 70, 0.16 + n * 0.015, "triangle", 0.16),
    block: () => tone(120, 0.14, "sawtooth", 0.12),
    errSoft,
    turn: (p) => tone(p === 0 ? 520 : 380, 0.12, "triangle", 0.09),
    win: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.22, "triangle", 0.18), i * 90)); },
  };
}

// ---------- a single hex tile drawn at origin ----------
function HexShape({ color, dir, faded, modifier }: { color?: string; dir?: string; faded?: boolean; modifier?: Modifier }) {
  const corners: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * 60 * i;
    corners.push(`${(SIZE * 0.94 * Math.cos(a)).toFixed(2)},${(SIZE * 0.94 * Math.sin(a)).toFixed(2)}`);
  }
  const pts = corners.join(" ");
  if (faded || !color || !dir) {
    return <polygon points={pts} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="1.4" />;
  }
  const c = COLORS[color];
  const d = DIRS[dir];
  const A = SIZE * 0.46, hw = SIZE * 0.36, hy = SIZE * 0.0, sw = SIZE * 0.135, sb = SIZE * 0.46;
  const arrow = `M0,${-A} L${hw},${hy} L${sw},${hy} L${sw},${sb} L${-sw},${sb} L${-sw},${hy} L${-hw},${hy} Z`;
  const mod = modifier ? MODIFIER_BY_TYPE[modifier] : null;
  return (
    <g>
      <polygon points={pts} fill={c.dark} transform="translate(0,2.5)" opacity="0.55" />
      <polygon points={pts} fill={`url(#g-${color})`} stroke={c.dark} strokeWidth="1.5" strokeLinejoin="round" />
      <polygon points={corners.slice(4).concat(corners.slice(0, 1)).join(" ")} fill="rgba(255,255,255,.28)" opacity="0.0" />
      <ellipse cx="0" cy={-SIZE * 0.42} rx={SIZE * 0.5} ry={SIZE * 0.16} fill="rgba(255,255,255,.35)" />
      <g transform={`rotate(${d.angle})`}>
        <path d={arrow} fill={c.arrow} stroke="rgba(0,0,0,.18)" strokeWidth="0.8" strokeLinejoin="round" />
      </g>
      {mod && (
        <g transform={`translate(${SIZE * 0.52}, ${-SIZE * 0.52})`}>
          <circle r={SIZE * 0.3} fill="rgba(20,16,32,.92)" stroke={mod.tint} strokeWidth={1.6} />
          <text textAnchor="middle" y={SIZE * 0.14} style={{ font: `700 ${(SIZE * 0.42).toFixed(1)}px 'Space Mono', monospace`, fill: mod.tint, pointerEvents: "none" }}>
            {mod.glyph}
          </text>
        </g>
      )}
    </g>
  );
}

export default function HexBlast() {
  const [level, setLevel] = useState(1);
  const [sizeR, setSizeR] = useState(3);
  const [diffIdx, setDiffIdx] = useState(1);
  const [mode, setMode] = useState<"solo" | "2p">("solo");
  const [first] = useState(() => genBoardDiff(3, 1, DIFFS[1]));
  const [board, setBoard] = useState(() => first.board);
  const [metric, setMetric] = useState(() => ({ axB: first.axB, minAxis: first.minAxis, tiles: first.tiles }));
  const [score, setScore] = useState(0);
  const [pScores, setPScores] = useState<[number, number]>([0, 0]);
  const [turn, setTurn] = useState<0 | 1>(0);
  const [moves, setMoves] = useState(0);
  const [best, setBest] = useState(0);
  const [bestChain, setBestChain] = useState(1);
  const [flying, setFlying] = useState<any[]>([]);
  const [pops, setPops] = useState<any[]>([]);
  const [chain, setChain] = useState({ mult: 1, expire: 0, barKey: 0 });
  const [won, setWon] = useState(false);
  const [help, setHelp] = useState(false);
  const [sound, setSound] = useState(true);

  // 2P powerups: per-player inventory; one powerup armed at a time (active player)
  const [pPowerups, setPPowerups] = useState<[PowerupCounts, PowerupCounts]>(() => [
    { ...STARTING_HAND }, { ...STARTING_HAND },
  ]);
  const [armedPowerup, setArmedPowerup] = useState<PowerupType | null>(null);
  const [wildPick, setWildPick] = useState<{ q: number; r: number } | null>(null);
  const [forecast, setForecast] = useState<{ keys: string[]; until: number } | null>(null);

  const boardRef = useRef(board); boardRef.current = board;
  const chainRef = useRef(chain); chainRef.current = chain;
  const modeRef = useRef(mode); modeRef.current = mode;
  const turnRef = useRef(turn); turnRef.current = turn;
  const armedRef = useRef(armedPowerup); armedRef.current = armedPowerup;
  const wildPickRef = useRef(wildPick); wildPickRef.current = wildPick;
  const pPowerupsRef = useRef(pPowerups); pPowerupsRef.current = pPowerups;
  const histRef = useRef<any[]>([]);
  const idRef = useRef(0);
  const tileRefs = useRef(new Map<string, SVGGElement>());
  const animLockRef = useRef(false);
  const soundRef = useRef(sound); soundRef.current = sound;
  const blip = useBlips(soundRef);

  // chain decay (solo only)
  useEffect(() => {
    const id = setInterval(() => {
      if (chainRef.current.mult > 1 && Date.now() > chainRef.current.expire) {
        setChain((c) => ({ ...c, mult: 1 }));
      }
    }, 120);
    return () => clearInterval(id);
  }, []);

  const startLevel = useCallback((lvl, R, di, m: "solo" | "2p" = modeRef.current) => {
    const res = genBoardDiff(R, lvl, DIFFS[di]);
    if (m === "2p") sprinkleModifiers(res.board, R);
    setBoard(res.board);
    setMetric({ axB: res.axB, minAxis: res.minAxis, tiles: res.tiles });
    setMoves(0);
    setWon(false);
    setChain({ mult: 1, expire: 0, barKey: 0 });
    histRef.current = [];
    setFlying([]); setPops([]);
    setArmedPowerup(null);
    setWildPick(null);
    setForecast(null);
    if (m === "2p") {
      setPScores([0, 0]);
      setTurn(0);
      setScore(0);
      setPPowerups([{ ...STARTING_HAND }, { ...STARTING_HAND }]);
    } else {
      setScore(0);
    }
  }, []);

  // auto-expire forecast preview
  useEffect(() => {
    if (!forecast) return;
    const remain = forecast.until - Date.now();
    if (remain <= 0) { setForecast(null); return; }
    const id = setTimeout(() => setForecast(null), remain);
    return () => clearTimeout(id);
  }, [forecast]);

  const newBoard = () => startLevel(level, sizeR, diffIdx);
  const nextLevel = () => { const n = level + 1; setLevel(n); startLevel(n, sizeR, diffIdx); };
  const chooseSize = (R) => { setSizeR(R); startLevel(level, R, diffIdx); };
  const chooseDiff = (di) => { setDiffIdx(di); startLevel(level, sizeR, di); };
  const chooseMode = (m: "solo" | "2p") => { setMode(m); startLevel(level, sizeR, diffIdx, m); };

  const undo = () => {
    const h = histRef.current.pop();
    if (!h) return;
    setBoard(h.board);
    setScore(h.score);
    setMoves(h.moves);
    setWon(false);
    if (h.pScores) setPScores(h.pScores);
    if (typeof h.turn === "number") setTurn(h.turn);
    if (h.pPowerups) setPPowerups(h.pPowerups);
    setArmedPowerup(null);
    setWildPick(null);
    setForecast(null);
  };

  const armPowerup = (type: PowerupType) => {
    if (mode !== "2p" || won || animLockRef.current) return;
    if (pPowerups[turn][type] <= 0) return;
    setWildPick(null);
    setForecast(null);
    setArmedPowerup((cur) => (cur === type ? null : type));
  };

  // geometry / viewBox from the full board region (stable layout)
  const R = sizeR;
  const region = allCells(R);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  region.forEach(({ q, r }) => {
    const p = px(q, r);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const pad = SIZE * 1.5;
  const vb = [minX - pad, minY - pad, (maxX - minX) + pad * 2, (maxY - minY) + pad * 2];

  const snapshotHistory = (b: Map<string, any>) => {
    histRef.current.push({
      board: new Map(b), score, moves,
      pScores: [...pScores] as [number, number], turn,
      pPowerups: [{ ...pPowerups[0] }, { ...pPowerups[1] }] as [PowerupCounts, PowerupCounts],
    });
    if (histRef.current.length > 40) histRef.current.shift();
  };

  // tap dispatcher: route to armed-powerup action, wildTap picker, or normal launch
  const launch = (q, r) => {
    if (won) return;
    if (animLockRef.current) return;
    // cancel an open wildTap picker on any board tap that's not a picker arrow
    if (wildPickRef.current) { setWildPick(null); return; }
    const armed = armedRef.current;
    if (armed === "bomb")     return executeBomb(q, r);
    if (armed === "forecast") return executeForecast(q, r);
    if (armed === "wildTap") {
      if (!boardRef.current.has(key(q, r))) { setArmedPowerup(null); return; }
      setWildPick({ q, r });
      return;
    }
    // freeTurn falls through to normal launch (consumed on successful sweep)
    launchTile(q, r);
  };

  const launchTile = (q: number, r: number, forceDir?: string) => {
    const b = boardRef.current;
    const tile = b.get(key(q, r));
    if (!tile) return;
    const dir = forceDir ?? tile.dir;
    const d = DIRS[dir];

    const sweep = computeSweep(b, R, q, r, dir);
    const { group, blocked, modKeys, extended } = sweep;

    if (blocked || group.length === 0) {
      // lean-and-reflect (wildTap not consumed on failure)
      blip.errSoft();
      const el = tileRefs.current.get(key(q, r));
      if (el) {
        const u = dirUnitPx(d);
        const lean = STEP_PX * 0.4;
        el.animate(
          [
            { transform: "translate(0px,0px) rotate(0deg)", offset: 0 },
            { transform: `translate(${u.x * lean}px,${u.y * lean}px) rotate(45deg)`, offset: 0.45 },
            { transform: `translate(${u.x * lean * 0.7}px,${u.y * lean * 0.7}px) rotate(30deg)`, offset: 0.6 },
            { transform: "translate(0px,0px) rotate(0deg)", offset: 1 },
          ],
          { duration: 360, easing: "cubic-bezier(.4,.0,.3,1)" }
        );
      }
      return;
    }

    // ---- success ----
    const now = Date.now();
    const prev = chainRef.current;
    const chainMult = modeRef.current === "2p" ? 1 : (now < prev.expire ? prev.mult + 1 : 1);
    const n = group.length;
    const diag = isDiagonal(dir);
    const base = n * 12;
    const sweepBonus = n > 1 ? n * n * 16 : 0;
    const diagBonus = diag && n >= 2 ? n * n * 16 : 0;

    // collect modifier effects from in-scope modifiers
    let modMult = 1, chains = 0;
    for (const m of modKeys) {
      if (m.type === "star") modMult *= 2;
      else if (m.type === "crystal") modMult *= 3;
      else if (m.type === "chain") chains++;
    }
    const gained = (base + sweepBonus + diagBonus) * chainMult * modMult;

    const tags: string[] = [];
    if (n > 1) tags.push(`${n}× SWEEP`);
    if (diagBonus) tags.push("◆ DIAGONAL");
    if (extended) tags.push("↠ SLING");
    if (modMult > 1) tags.push(`★ ×${modMult}`);
    if (forceDir !== undefined && armedRef.current === "wildTap") tags.push("⚡ WILD");

    snapshotHistory(b);

    // remove sweep tiles + strip any non-wild modifier triggered this turn
    const nb = new Map(b);
    group.forEach((g) => nb.delete(key(g.q, g.r)));
    for (const m of modKeys) {
      if (m.type === "wild") continue;
      const k = key(m.q, m.r);
      const t: any = nb.get(k);
      if (!t) continue; // was in sweep group
      const { modifier, ...rest } = t;
      nb.set(k, rest);
    }
    setBoard(nb);
    setMoves((mv) => mv + 1);

    // consume powerups
    const wildTapUsed = forceDir !== undefined && armedRef.current === "wildTap";
    const freeTurnUsed = modeRef.current === "2p" && armedRef.current === "freeTurn";
    if (wildTapUsed || freeTurnUsed) {
      setPPowerups((p) => {
        const np = [{ ...p[0] }, { ...p[1] }] as [PowerupCounts, PowerupCounts];
        if (wildTapUsed) np[turnRef.current].wildTap = Math.max(0, np[turnRef.current].wildTap - 1);
        if (freeTurnUsed) np[turnRef.current].freeTurn = Math.max(0, np[turnRef.current].freeTurn - 1);
        return np;
      });
    }
    if (armedRef.current) setArmedPowerup(null);
    setForecast(null);

    const extraTurn = freeTurnUsed || chains > 0;

    if (modeRef.current === "2p") {
      setPScores((ps) => {
        const next = [...ps] as [number, number];
        next[turnRef.current] += gained;
        return next;
      });
      setChain({ mult: 1, expire: 0, barKey: 0 });
    } else {
      setScore((s) => { const ns = s + gained; setBest((bs) => Math.max(bs, ns)); return ns; });
      setChain({ mult: chainMult, expire: now + CHAIN_WINDOW, barKey: prev.barKey + 1 });
      setBestChain((bc) => Math.max(bc, chainMult));
    }
    blip.pop(n, chainMult);

    // fold-fly animation
    const u = dirUnitPx(d);
    animLockRef.current = true;
    const newFly = group.map((g, i) => {
      const p = px(g.q, g.r);
      const steps = stepsToEdge(g.q, g.r, dir, R);
      return { id: ++idRef.current, x: p.x, y: p.y, color: g.color, dir: g.dir, modifier: g.modifier, ux: u.x, uy: u.y, steps, delay: i * 60 };
    });
    setFlying((f) => [...f, ...newFly]);

    const maxSteps = Math.max(...newFly.map((f) => f.steps));
    const lastDelay = newFly[newFly.length - 1]?.delay ?? 0;
    const totalAnim = lastDelay + maxSteps * FOLD_MS + 40;
    setTimeout(() => {
      animLockRef.current = false;
      if (modeRef.current === "2p" && nb.size > 0 && !extraTurn) {
        setTurn((t) => {
          const nxt = (t === 0 ? 1 : 0) as 0 | 1;
          blip.turn(nxt);
          return nxt;
        });
      }
    }, totalAnim);

    // score popup
    const tp = px(q, r);
    const popId = ++idRef.current;
    const popPlayer = modeRef.current === "2p" ? turnRef.current : -1;
    setPops((ps) => [...ps, {
      id: popId, x: tp.x, y: tp.y, gained, mult: chainMult, tags, hot: !!diagBonus || modMult > 1, player: popPlayer,
    }]);
    setTimeout(() => setPops((ps) => ps.filter((p) => p.id !== popId)), 950);

    if (nb.size === 0) { setTimeout(() => { setWon(true); blip.win(); }, 350); }
  };

  const launchWildTap = (dir: string) => {
    const wp = wildPickRef.current;
    if (!wp) return;
    setWildPick(null);
    launchTile(wp.q, wp.r, dir);
  };

  const executeBomb = (q: number, r: number) => {
    if (modeRef.current !== "2p") return;
    const b = boardRef.current;
    const cells: { q: number; r: number }[] = [];
    if (cubeMax(q, r) <= R) cells.push({ q, r });
    for (const dn of DIR_KEYS) {
      const nq = q + DIRS[dn].dq, nr = r + DIRS[dn].dr;
      if (cubeMax(nq, nr) <= R) cells.push({ q: nq, r: nr });
    }
    const affected = cells.filter((c) => b.has(key(c.q, c.r)));
    if (affected.length === 0) { setArmedPowerup(null); return; }

    snapshotHistory(b);
    const nb = new Map(b);
    affected.forEach((c) => nb.delete(key(c.q, c.r)));
    setBoard(nb);
    setMoves((mv) => mv + 1);

    const gained = affected.length * 14;
    setPScores((ps) => {
      const next = [...ps] as [number, number];
      next[turnRef.current] += gained;
      return next;
    });
    setChain({ mult: 1, expire: 0, barKey: 0 });
    setPPowerups((p) => {
      const np = [{ ...p[0] }, { ...p[1] }] as [PowerupCounts, PowerupCounts];
      np[turnRef.current].bomb = Math.max(0, np[turnRef.current].bomb - 1);
      return np;
    });
    setArmedPowerup(null);
    blip.pop(affected.length, 1);

    // explode-outward: each tile pops one cell out from bomb center
    const center = px(q, r);
    animLockRef.current = true;
    const newFly = affected.map((c, i) => {
      const cp = px(c.q, c.r);
      const dx = cp.x - center.x, dy = cp.y - center.y;
      const dist = Math.hypot(dx, dy);
      const ux = dist > 0.001 ? dx / dist : 0;
      const uy = dist > 0.001 ? dy / dist : -1;
      const t = b.get(key(c.q, c.r));
      return { id: ++idRef.current, x: cp.x, y: cp.y, color: t.color, dir: t.dir, modifier: t.modifier, ux, uy, steps: 1, delay: i * 25 };
    });
    setFlying((f) => [...f, ...newFly]);
    const totalAnim = (affected.length - 1) * 25 + FOLD_MS + 40;
    setTimeout(() => {
      animLockRef.current = false;
      if (nb.size > 0) {
        setTurn((t) => {
          const nxt = (t === 0 ? 1 : 0) as 0 | 1;
          blip.turn(nxt);
          return nxt;
        });
      }
    }, totalAnim);

    const popId = ++idRef.current;
    setPops((ps) => [...ps, {
      id: popId, x: center.x, y: center.y, gained, mult: 1, tags: ["✸ BOMB"], hot: true, player: turnRef.current,
    }]);
    setTimeout(() => setPops((ps) => ps.filter((p) => p.id !== popId)), 950);

    if (nb.size === 0) { setTimeout(() => { setWon(true); blip.win(); }, 350); }
  };

  const executeForecast = (q: number, r: number) => {
    if (modeRef.current !== "2p") return;
    const b = boardRef.current;
    const tile = b.get(key(q, r));
    setPPowerups((p) => {
      const np = [{ ...p[0] }, { ...p[1] }] as [PowerupCounts, PowerupCounts];
      np[turnRef.current].forecast = Math.max(0, np[turnRef.current].forecast - 1);
      return np;
    });
    setArmedPowerup(null);
    if (!tile) { setForecast({ keys: [key(q, r)], until: Date.now() + FORECAST_MS }); return; }
    const { group, blocked } = computeSweep(b, R, q, r, tile.dir);
    if (blocked || group.length === 0) {
      setForecast({ keys: [key(q, r)], until: Date.now() + FORECAST_MS });
      blip.errSoft();
      return;
    }
    setForecast({ keys: group.map((g) => key(g.q, g.r)), until: Date.now() + FORECAST_MS });
  };

  const flyDone = (id) => setFlying((f) => f.filter((x) => x.id !== id));

  const chainAlive = mode === "solo" && chain.mult > 1 && Date.now() < chain.expire;
  const winner = mode === "2p" && won
    ? (pScores[0] === pScores[1] ? "tie" : (pScores[0] > pScores[1] ? 0 : 1))
    : null;

  return (
    <div style={{ ...styles.root, transition: "box-shadow .25s", boxShadow: mode === "2p" ? `inset 0 0 0 3px ${PLAYERS[turn].soft}` : undefined }}>
      <style>{css}</style>

      {/* gradient defs */}
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <defs>
          {COLOR_KEYS.map((k) => (
            <linearGradient id={`g-${k}`} key={k} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS[k].lite} />
              <stop offset="55%" stopColor={COLORS[k].base} />
              <stop offset="100%" stopColor={COLORS[k].dark} />
            </linearGradient>
          ))}
        </defs>
      </svg>

      <div style={styles.shell}>
        {/* header */}
        <header style={styles.head}>
          <div style={styles.brand}>
            <span style={styles.logoMark}><Zap size={20} strokeWidth={2.6} /></span>
            <div>
              <h1 style={styles.title}>HEX&nbsp;BLAST</h1>
              <p style={styles.sub}>sweep · fold · clear the grid</p>
            </div>
          </div>
          <div style={styles.headBtns}>
            <button style={styles.iconBtn} onClick={() => setSound((s) => !s)} title="sound">
              {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <button style={styles.iconBtn} onClick={() => setHelp(true)} title="how to play">
              <HelpCircle size={18} />
            </button>
          </div>
        </header>

        {/* mode toggle */}
        <div style={styles.sizeRow}>
          <span style={styles.sizeLbl}>MODE</span>
          <div style={styles.seg}>
            <button
              onClick={() => chooseMode("solo")}
              style={{ ...styles.segBtn, ...(mode === "solo" ? styles.segBtnOn : {}), display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <User size={14} /> Solo
            </button>
            <button
              onClick={() => chooseMode("2p")}
              style={{ ...styles.segBtn, ...(mode === "2p" ? styles.segBtnOn : {}), display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <Users size={14} /> 2 Player
            </button>
          </div>
        </div>

        {/* stat strip — solo */}
        {mode === "solo" && (
          <div style={styles.stats}>
            <Stat label="LEVEL" value={level} />
            <Stat label="SCORE" value={score.toLocaleString()} big />
            <Stat label="MOVES" value={moves} />
            <Stat label="BEST ×" value={bestChain} accent={COLORS.amber.base} />
          </div>
        )}

        {/* stat strip — 2 player */}
        {mode === "2p" && (
          <div style={styles.players}>
            {PLAYERS.map((p, i) => {
              const active = turn === i && !won;
              return (
                <div key={p.name} style={{
                  ...styles.player,
                  borderColor: active ? p.glow : "rgba(255,255,255,.08)",
                  background: active ? p.soft : "rgba(255,255,255,.03)",
                  boxShadow: active ? `0 0 0 1px ${p.glow}, 0 6px 22px ${p.soft}` : "none",
                  transform: active ? "translateY(-1px)" : "none",
                }}>
                  <div style={{ ...styles.playerName, color: active ? p.glow : "#857f96" }}>
                    <span style={{ ...styles.dot, background: p.glow, boxShadow: active ? `0 0 10px ${p.glow}` : "none" }} />
                    {p.name}{active ? " · YOUR TURN" : ""}
                  </div>
                  <div style={{ ...styles.playerScore, color: active ? "#fff" : "#cdc7da" }}>
                    {pScores[i].toLocaleString()}
                  </div>
                  <div style={styles.powerupRow}>
                    {POWERUPS.map((pu) => {
                      const count = pPowerups[i][pu.type];
                      const canTap = active && count > 0 && !animLockRef.current;
                      const armed = active && armedPowerup === pu.type;
                      const Icon = POWERUP_ICON[pu.type];
                      return (
                        <button key={pu.type}
                          disabled={!canTap}
                          onClick={() => armPowerup(pu.type)}
                          title={`${pu.name} — ${pu.blurb}`}
                          style={{
                            ...styles.puBtn,
                            opacity: count === 0 ? 0.32 : active ? 1 : 0.55,
                            borderColor: armed ? pu.tint : "rgba(255,255,255,.1)",
                            background: armed ? `${pu.tint}28` : "rgba(255,255,255,.04)",
                            boxShadow: armed ? `0 0 0 1px ${pu.tint}, 0 0 14px ${pu.tint}66` : "none",
                            color: armed ? pu.tint : "#cdc7da",
                            cursor: canTap ? "pointer" : "default",
                          }}>
                          <Icon size={15} strokeWidth={2.2} />
                          <span style={styles.puCount}>{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* armed-powerup hint */}
        {mode === "2p" && armedPowerup && (
          <div style={styles.hint}>
            {armedPowerup === "bomb" && "Tap any tile to bomb it + its 6 neighbors."}
            {armedPowerup === "forecast" && "Tap a tile to preview its sweep."}
            {armedPowerup === "wildTap" && "Tap a tile, then pick a direction."}
            {armedPowerup === "freeTurn" && "Your next successful move won't pass the turn."}
          </div>
        )}

        {/* chain meter (solo only) */}
        {mode === "solo" && (
          <div style={styles.chainWrap}>
            <div style={{ ...styles.chainLabel, opacity: chainAlive ? 1 : 0.35, color: chainAlive ? COLORS.amber.base : "#7d7a86" }}>
              CHAIN&nbsp;×{chain.mult}
            </div>
            <div style={styles.chainTrack}>
              {chainAlive && (
                <div key={chain.barKey} style={styles.chainBar} />
              )}
            </div>
          </div>
        )}

        {/* difficulty */}
        <div style={styles.sizeRow}>
          <span style={styles.sizeLbl}>DIFF</span>
          <div style={styles.seg}>
            {DIFFS.map((d, i) => (
              <button key={d.label}
                onClick={() => chooseDiff(i)}
                style={{ ...styles.segBtn, ...(diffIdx === i ? styles.segBtnOn : {}) }}>
                {d.label}
              </button>
            ))}
          </div>
        </div>

        {/* board size */}
        <div style={styles.sizeRow}>
          <span style={styles.sizeLbl}>BOARD</span>
          <div style={styles.seg}>
            {SIZES.map((s) => (
              <button key={s.label}
                onClick={() => chooseSize(s.R)}
                style={{ ...styles.segBtn, ...(sizeR === s.R ? styles.segBtnOn : {}) }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* live metric readout: per-lane blocked %, weakest lane sets difficulty */}
        <div style={styles.metricRow}>
          <span>{metric.tiles} tiles</span>
          <span style={styles.metricSep}>·</span>
          <span>weakest lane {Math.round(metric.minAxis * 100)}% blocked</span>
          <span style={styles.metricSep}>·</span>
          <span style={{ color: DIFF_COLOR[diffIdx], fontWeight: 700 }}>{DIFFS[diffIdx].label}</span>
        </div>
        <div style={styles.axisRow}>
          {AXES.map((a) => {
            const weak = metric.axB[a] === metric.minAxis;
            return (
              <span key={a} style={{ ...styles.axisChip, ...(weak ? { color: DIFF_COLOR[diffIdx], borderColor: DIFF_COLOR[diffIdx], fontWeight: 700 } : {}) }}>
                {AXIS_GLYPH[a]} {Math.round(metric.axB[a] * 100)}%
              </span>
            );
          })}
        </div>

        {/* board */}
        <div style={{
          ...styles.boardWrap,
          borderColor: mode === "2p" ? PLAYERS[turn].glow : "rgba(255,255,255,.06)",
          boxShadow: mode === "2p"
            ? `inset 0 1px 0 rgba(255,255,255,.05), 0 0 0 1px ${PLAYERS[turn].soft}, 0 12px 40px ${PLAYERS[turn].soft}`
            : "inset 0 1px 0 rgba(255,255,255,.05)",
          transition: "border-color .25s, box-shadow .25s",
        }}>
          <svg viewBox={vb.join(" ")} style={styles.svg} preserveAspectRatio="xMidYMid meet">
            {/* faint empty grid */}
            {region.map(({ q, r }) => {
              const p = px(q, r);
              return (
                <g key={"e" + key(q, r)} transform={`translate(${p.x},${p.y})`}>
                  <HexShape faded />
                </g>
              );
            })}
            {/* forecast preview glow */}
            {forecast && forecast.keys.map((fk) => {
              const [q, r] = fk.split(",").map(Number);
              const p = px(q, r);
              return (
                <g key={"fc" + fk} transform={`translate(${p.x},${p.y})`} className="forecastGlow" style={{ pointerEvents: "none" }}>
                  <polygon
                    points={Array.from({ length: 6 }, (_, i) => {
                      const a = (Math.PI / 180) * 60 * i;
                      return `${(SIZE * 1.05 * Math.cos(a)).toFixed(2)},${(SIZE * 1.05 * Math.sin(a)).toFixed(2)}`;
                    }).join(" ")}
                    fill="none" stroke="#3fd1ff" strokeWidth={2.2} opacity={0.9}
                  />
                </g>
              );
            })}
            {/* live tiles */}
            {[...board.entries()].map(([k, t]: any) => {
              const [q, r] = k.split(",").map(Number);
              const p = px(q, r);
              return (
                <g
                  key={k}
                  ref={(el) => { if (el) tileRefs.current.set(k, el as SVGGElement); else tileRefs.current.delete(k); }}
                  transform={`translate(${p.x},${p.y})`}
                  className="tile"
                  onClick={() => launch(q, r)}
                >
                  <HexShape color={t.color} dir={t.dir} modifier={t.modifier} />
                </g>
              );
            })}
            {/* flying / folding tiles */}
            {flying.map((f) => {
              const kfs: any[] = [];
              for (let k = 0; k <= f.steps; k++) {
                kfs.push({
                  transform: `translate(${k * STEP_PX * f.ux}px, ${k * STEP_PX * f.uy}px) rotate(${k * 180}deg)`,
                  opacity: k === f.steps ? 0 : 1,
                  offset: k / f.steps,
                });
              }
              return (
                <g key={f.id} transform={`translate(${f.x},${f.y})`} style={{ pointerEvents: "none" }}>
                  <g
                    ref={(el) => {
                      if (!el || (el as any).dataset.run) return;
                      (el as any).dataset.run = "1";
                      const anim = el.animate(kfs, {
                        duration: f.steps * FOLD_MS,
                        delay: f.delay,
                        easing: "cubic-bezier(.5,.05,.4,1)",
                        fill: "forwards",
                      });
                      anim.onfinish = () => flyDone(f.id);
                    }}
                  >
                    <HexShape color={f.color} dir={f.dir} modifier={f.modifier} />
                  </g>
                </g>
              );
            })}
            {/* wildTap direction picker */}
            {wildPick && (() => {
              const wp = wildPick;
              const p = px(wp.q, wp.r);
              const A = SIZE * 0.42, hw = SIZE * 0.3, hy = 0, sw = SIZE * 0.12, sb = SIZE * 0.42;
              const arrow = `M0,${-A} L${hw},${hy} L${sw},${hy} L${sw},${sb} L${-sw},${sb} L${-sw},${hy} L${-hw},${hy} Z`;
              return (
                <g transform={`translate(${p.x},${p.y})`}>
                  <circle r={SIZE * 2.2} fill="rgba(8,6,14,.55)" onClick={() => setWildPick(null)} style={{ cursor: "pointer" }} />
                  <g onClick={() => setWildPick(null)} style={{ cursor: "pointer" }}>
                    <circle r={SIZE * 0.38} fill="rgba(20,16,32,.92)" stroke="#cdc7da" strokeWidth={1.4} />
                    <text textAnchor="middle" y={SIZE * 0.18} style={{ font: `700 ${(SIZE * 0.5).toFixed(1)}px 'Space Mono', monospace`, fill: "#cdc7da", pointerEvents: "none" }}>×</text>
                  </g>
                  {DIR_KEYS.map((dn) => {
                    const dd = DIRS[dn];
                    const u = dirUnitPx(dd);
                    const off = STEP_PX * 1.05;
                    const cc = COLORS[DIR_COLOR[dn]];
                    return (
                      <g key={dn} transform={`translate(${u.x * off},${u.y * off})`} onClick={() => launchWildTap(dn)} style={{ cursor: "pointer" }} className="dirPick">
                        <circle r={SIZE * 0.42} fill={cc.base} stroke="#fff" strokeWidth={1.6} />
                        <g transform={`rotate(${dd.angle})`}>
                          <path d={arrow} fill={cc.arrow} stroke="rgba(0,0,0,.18)" strokeWidth={0.6} />
                        </g>
                      </g>
                    );
                  })}
                </g>
              );
            })()}
            {/* score popups */}
            {pops.map((p) => {
              const line2 = [...p.tags, p.mult > 1 ? `CHAIN ×${p.mult}` : null].filter(Boolean).join("  ·  ");
              const baseColor = p.player === 0 ? PLAYERS[0].glow
                              : p.player === 1 ? PLAYERS[1].glow
                              : (p.hot ? COLORS.sun.base : "#fff");
              return (
                <g key={p.id} transform={`translate(${p.x},${p.y})`} className="pop" style={{ pointerEvents: "none" }}>
                  <text textAnchor="middle" y={-4} style={{ font: "700 18px 'Space Mono', monospace", fill: baseColor, paintOrder: "stroke", stroke: "rgba(0,0,0,.6)", strokeWidth: 3.5 }}>
                    +{p.gained.toLocaleString()}
                  </text>
                  {line2 && (
                    <text textAnchor="middle" y={15} style={{ font: "700 11px 'Fredoka', sans-serif", fill: p.hot ? COLORS.sun.lite : COLORS.amber.base, paintOrder: "stroke", stroke: "rgba(0,0,0,.6)", strokeWidth: 2.5 }}>
                      {line2}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* controls */}
        <div style={styles.controls}>
          <button style={styles.btn} onClick={undo}><Undo2 size={16} /> Undo</button>
          <button style={styles.btn} onClick={newBoard}><RotateCcw size={16} /> New board</button>
        </div>
      </div>

      {/* win overlay */}
      {won && (
        <div style={styles.overlay}>
          <div style={styles.card}>
            <div style={styles.cardBadge}><Zap size={26} strokeWidth={2.6} /></div>
            <h2 style={styles.cardTitle}>GRID CLEARED</h2>
            {mode === "solo" ? (
              <>
                <p style={styles.cardSub}>Level {level} done in {moves} moves</p>
                <div style={styles.cardStats}>
                  <div><div style={styles.csVal}>{score.toLocaleString()}</div><div style={styles.csLbl}>SCORE</div></div>
                  <div><div style={styles.csVal}>×{bestChain}</div><div style={styles.csLbl}>BEST CHAIN</div></div>
                </div>
              </>
            ) : (
              <>
                <p style={{ ...styles.cardSub, color: winner === "tie" ? "#cdc7da" : PLAYERS[winner as number].glow, fontWeight: 700 }}>
                  {winner === "tie" ? "IT'S A TIE" : `${PLAYERS[winner as number].name} WINS`}
                </p>
                <div style={styles.cardStats}>
                  {PLAYERS.map((p, i) => (
                    <div key={p.name}>
                      <div style={{ ...styles.csVal, color: p.glow }}>{pScores[i].toLocaleString()}</div>
                      <div style={styles.csLbl}>{p.name}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
            <button style={styles.cta} onClick={nextLevel}>Next level <ChevronRight size={18} /></button>
            <button style={styles.ghost} onClick={newBoard}>Replay this level</button>
          </div>
        </div>
      )}

      {/* help overlay */}
      {help && (
        <div style={styles.overlay} onClick={() => setHelp(false)}>
          <div style={styles.card} onClick={(e) => e.stopPropagation()}>
            <button style={styles.close} onClick={() => setHelp(false)}><X size={18} /></button>
            <h2 style={styles.cardTitle}>HOW TO PLAY</h2>
            <ul style={styles.rules}>
              <li><b>Tap a tile</b> — it folds cell-by-cell off the board in the direction its arrow points.</li>
              <li><b>Color = direction:</b> each rainbow color points its own way — red ↑, orange ↗, yellow ↘, green ↓, blue ↙, violet ↖. Same color in a row = sweepable lane.</li>
              <li><b>Sweep combo:</b> any tile in its path pointing the <i>same</i> direction (same color) tumbles off <i>with</i> it. Empty gaps are passed over freely.</li>
              <li><b>Blocked:</b> a tile of a <i>different</i> color stops the shot. The tapped tile leans forward, plays a soft error tone, and reflects back to its origin.</li>
              <li><b>Score:</b> big sweeps pay off fast — a 5-tile sweep is worth far more than five singles.</li>
              <li><b>◆ Diagonal bonus:</b> sweep along a <i>diagonal</i> (orange, yellow, blue, violet) for an extra payout.</li>
              <li><b>Chains (solo only):</b> fire again before the chain meter empties to stack ×2, ×3… on every point you earn.</li>
              <li><b>2 Player:</b> players alternate turns — even on a blocked tap, your turn ends. No chain multiplier. Highest score when the grid clears wins.</li>
              <li><b>2P modifier cells:</b> some tiles wear a badge. Trigger by sweeping the tile or any of its 6 neighbors.
                <span style={{ display: "block", marginTop: 6, color: "#a59fb6", fontSize: 13 }}>
                  <b style={{ color: "#ffd23f" }}>★ Star</b> ×2 score · <b style={{ color: "#3fd1ff" }}>◆ Crystal</b> ×3 score · <b>◎ Wildcard</b> counts as any color · <b style={{ color: "#ff9d2e" }}>⊕ Chain</b> extra turn · <b style={{ color: "#a45cff" }}>↠ Sling</b> sweep past one blocker
                </span>
              </li>
              <li><b>2P powerups:</b> each player gets a starting hand of 4 one-shots — <b>Bomb</b> clears a tile + 6 neighbors · <b>Forecast</b> previews a sweep for free · <b>Wild Tap</b> launches in any direction you pick · <b>Free Turn</b> keeps the turn after your next move.</li>
              <li><b>Goal:</b> clear every tile. Each board is always solvable.</li>
            </ul>
            <button style={styles.cta} onClick={() => setHelp(false)}>Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, big, accent }: { label: string; value: any; big?: boolean; accent?: string }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLbl}>{label}</div>
      <div style={{ ...styles.statVal, fontSize: big ? 26 : 20, color: accent || "#f4f1fa" }}>{value}</div>
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Space+Mono:wght@400;700&display=swap');
*{box-sizing:border-box;}
.tile{cursor:pointer;transition:filter .12s;transform-origin:center;transform-box:fill-box;}
.tile:hover{filter:brightness(1.12) drop-shadow(0 0 6px rgba(255,255,255,.25));}
.tile:active{filter:brightness(.92);}
.pop{animation:popUp .95s ease-out forwards;}
@keyframes popUp{
  0%{transform:translate(var(--x,0),0) scale(.6);opacity:0;}
  18%{opacity:1;transform:scale(1.12);}
  100%{opacity:0;}
}
.pop text{transform:translateY(0);animation:popRise .95s ease-out forwards;}
@keyframes popRise{from{transform:translateY(6px);}to{transform:translateY(-26px);}}
.forecastGlow polygon{animation:fcPulse 1.6s ease-out forwards;transform-origin:center;transform-box:fill-box;}
@keyframes fcPulse{0%{opacity:0;transform:scale(.85);}18%{opacity:1;transform:scale(1.05);}80%{opacity:.95;transform:scale(1);}100%{opacity:0;transform:scale(1.1);}}
.dirPick{animation:dirPop .18s ease-out backwards;transform-origin:center;transform-box:fill-box;}
@keyframes dirPop{from{opacity:0;transform:scale(.6);}to{opacity:1;transform:scale(1);}}
.dirPick:hover{filter:brightness(1.15) drop-shadow(0 0 6px rgba(255,255,255,.4));}
.dirPick:active{filter:brightness(.92);}
`;

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh", width: "100%",
    background: "radial-gradient(1200px 700px at 50% -10%, #2a2440 0%, #16131f 45%, #0e0c14 100%)",
    color: "#f4f1fa", fontFamily: "'Fredoka', system-ui, sans-serif",
    display: "flex", justifyContent: "center", padding: "18px 14px 40px",
  },
  shell: { width: "100%", maxWidth: 540, display: "flex", flexDirection: "column", gap: 14 },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  logoMark: {
    width: 40, height: 40, borderRadius: 12, display: "grid", placeItems: "center",
    background: "linear-gradient(145deg,#ffd23f,#ff9d2e)", color: "#3a2300",
    boxShadow: "0 6px 18px rgba(255,157,46,.35)",
  },
  title: { margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: 1, lineHeight: 1 },
  sub: { margin: "3px 0 0", fontSize: 12, color: "#9b95ad", letterSpacing: 0.5 },
  headBtns: { display: "flex", gap: 8 },
  iconBtn: {
    width: 38, height: 38, borderRadius: 11, border: "1px solid rgba(255,255,255,.1)",
    background: "rgba(255,255,255,.05)", color: "#cfc9dd", display: "grid", placeItems: "center", cursor: "pointer",
  },
  stats: {
    display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8,
    background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)",
    borderRadius: 16, padding: "12px 8px",
  },
  stat: { textAlign: "center" },
  statLbl: { fontSize: 10, letterSpacing: 1.2, color: "#857f96", fontWeight: 600 },
  statVal: { fontFamily: "'Space Mono', monospace", fontWeight: 700, marginTop: 2 },
  players: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10,
  },
  player: {
    borderRadius: 16, padding: "12px 14px",
    border: "1px solid rgba(255,255,255,.08)",
    transition: "background .25s, border-color .25s, box-shadow .25s, transform .25s",
  },
  playerName: {
    fontSize: 11, letterSpacing: 1.2, fontWeight: 700,
    display: "flex", alignItems: "center", gap: 6, transition: "color .25s",
  },
  dot: {
    width: 8, height: 8, borderRadius: 8, display: "inline-block",
  },
  playerScore: {
    fontFamily: "'Space Mono', monospace", fontWeight: 700, fontSize: 26, marginTop: 4,
    transition: "color .25s",
  },
  powerupRow: {
    display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 5, marginTop: 10,
  },
  puBtn: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
    padding: "6px 0", borderRadius: 9, border: "1px solid rgba(255,255,255,.1)",
    background: "rgba(255,255,255,.04)", color: "#cdc7da",
    fontFamily: "'Space Mono', monospace", fontWeight: 700, fontSize: 12,
    transition: "background .15s, border-color .15s, box-shadow .15s, color .15s",
  },
  puCount: { fontSize: 11, opacity: 0.85 },
  hint: {
    textAlign: "center", fontFamily: "'Space Mono', monospace", fontSize: 12,
    color: "#ffd23f", padding: "8px 10px", borderRadius: 10,
    background: "rgba(255,210,63,.08)", border: "1px solid rgba(255,210,63,.25)",
    marginTop: -4,
  },
  chainWrap: { display: "flex", alignItems: "center", gap: 12 },
  chainLabel: { fontSize: 13, fontWeight: 700, letterSpacing: 1, minWidth: 78, transition: "opacity .2s,color .2s" },
  chainTrack: { flex: 1, height: 8, borderRadius: 6, background: "rgba(255,255,255,.07)", overflow: "hidden" },
  chainBar: {
    height: "100%", width: "100%", transformOrigin: "left",
    background: "linear-gradient(90deg,#ffd23f,#ff6a3d)",
    animation: `drain ${CHAIN_WINDOW}ms linear forwards`,
  },
  boardWrap: {
    background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.06)",
    borderRadius: 20, padding: 10, boxShadow: "inset 0 1px 0 rgba(255,255,255,.05)",
  },
  svg: { width: "100%", height: "auto", display: "block", overflow: "visible" },
  sizeRow: { display: "flex", alignItems: "center", gap: 12 },
  metricRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: "#857f96", fontFamily: "'Space Mono', monospace", marginTop: -4 },
  metricSep: { opacity: 0.45 },
  axisRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 2 },
  axisChip: { fontFamily: "'Space Mono', monospace", fontSize: 12, color: "#9b95ad", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, padding: "3px 9px", letterSpacing: 0.5 },
  sizeLbl: { fontSize: 11, fontWeight: 700, letterSpacing: 1.2, color: "#857f96", minWidth: 78 },
  seg: { flex: 1, display: "flex", gap: 6, background: "rgba(255,255,255,.05)", padding: 4, borderRadius: 12, border: "1px solid rgba(255,255,255,.07)" },
  segBtn: { flex: 1, padding: "8px 0", borderRadius: 9, border: "none", cursor: "pointer", background: "transparent", color: "#9b95ad", fontFamily: "'Fredoka',sans-serif", fontWeight: 700, fontSize: 14 },
  segBtnOn: { background: "linear-gradient(135deg,#ffd23f,#ff9d2e)", color: "#3a2300", boxShadow: "0 4px 12px rgba(255,157,46,.3)" },
  controls: { display: "flex", gap: 10 },
  btn: {
    flex: 1, padding: "13px 10px", borderRadius: 14, cursor: "pointer",
    border: "1px solid rgba(255,255,255,.1)", background: "rgba(255,255,255,.06)",
    color: "#e8e4f0", fontFamily: "'Fredoka',sans-serif", fontWeight: 600, fontSize: 15,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
  },
  overlay: {
    position: "fixed", inset: 0, background: "rgba(8,6,14,.72)", backdropFilter: "blur(6px)",
    display: "grid", placeItems: "center", padding: 20, zIndex: 50, animation: "fade .25s ease",
  },
  card: {
    position: "relative", width: "100%", maxWidth: 360, textAlign: "center",
    background: "linear-gradient(160deg,#221d33,#161221)", border: "1px solid rgba(255,255,255,.1)",
    borderRadius: 24, padding: "30px 26px", boxShadow: "0 30px 80px rgba(0,0,0,.6)",
  },
  cardBadge: {
    width: 56, height: 56, margin: "0 auto 14px", borderRadius: 16, display: "grid", placeItems: "center",
    background: "linear-gradient(145deg,#ffd23f,#ff6a3d)", color: "#3a2300",
    boxShadow: "0 10px 26px rgba(255,106,61,.4)",
  },
  cardTitle: { margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: 1 },
  cardSub: { margin: "6px 0 18px", color: "#a59fb6", fontSize: 14 },
  cardStats: { display: "flex", justifyContent: "center", gap: 34, marginBottom: 22 },
  csVal: { fontFamily: "'Space Mono',monospace", fontWeight: 700, fontSize: 26, color: "#ffd23f" },
  csLbl: { fontSize: 10, letterSpacing: 1.2, color: "#857f96", marginTop: 2 },
  cta: {
    width: "100%", padding: "14px", borderRadius: 14, border: "none", cursor: "pointer",
    background: "linear-gradient(135deg,#ffd23f,#ff6a3d)", color: "#3a1c00",
    fontFamily: "'Fredoka',sans-serif", fontWeight: 700, fontSize: 16,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    boxShadow: "0 10px 24px rgba(255,106,61,.35)",
  },
  ghost: {
    width: "100%", marginTop: 10, padding: "11px", borderRadius: 12, cursor: "pointer",
    background: "transparent", border: "1px solid rgba(255,255,255,.12)", color: "#cfc9dd",
    fontFamily: "'Fredoka',sans-serif", fontWeight: 600, fontSize: 14,
  },
  close: {
    position: "absolute", top: 14, right: 14, width: 32, height: 32, borderRadius: 9,
    border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.05)",
    color: "#cfc9dd", display: "grid", placeItems: "center", cursor: "pointer",
  },
  rules: { textAlign: "left", margin: "8px 0 20px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 11, fontSize: 14, color: "#cdc7da", lineHeight: 1.45 } as React.CSSProperties,
};

// keyframes that can't live in inline styles
const sheet = typeof document !== "undefined" ? document.createElement("style") : null;
if (sheet) {
  sheet.textContent = `@keyframes drain{from{transform:scaleX(1);}to{transform:scaleX(0);}}@keyframes fade{from{opacity:0;}to{opacity:1;}}`;
  document.head.appendChild(sheet);
}
