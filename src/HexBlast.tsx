import React, { useState, useRef, useEffect, useCallback } from "react";
import { RotateCcw, Undo2, Volume2, VolumeX, HelpCircle, Zap, ChevronRight, X, User, Users } from "lucide-react";

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

// per-player palette (clearly distinct from any tile palette accent)
const PLAYERS = [
  { name: "P1", glow: "#3fc7ff", base: "#1aa7e6", deep: "#0a3a55", soft: "rgba(63,199,255,.18)" },
  { name: "P2", glow: "#ff6bd4", base: "#e63ab0", deep: "#5a0a48", soft: "rgba(255,107,212,.18)" },
];

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

// ---------- guaranteed-solvable generator (reverse construction) ----------
function genBoard(R, targetGroups) {
  const cells = allCells(R);
  const inB = (q, r) => cubeMax(q, r) <= R;
  const board = new Map();
  let tries = 0;
  let placed = 0;
  while (placed < targetGroups && tries < targetGroups * 60) {
    tries++;
    const dName = DIR_KEYS[rnd(6)];
    const d = DIRS[dName];
    const start = cells[rnd(cells.length)];
    const k = 1 + rnd(4);
    const ray = [];
    let cq = start.q, cr = start.r, ok = true;
    for (let i = 0; i < k; i++) {
      if (!inB(cq, cr) || board.has(key(cq, cr))) { ok = false; break; }
      ray.push({ q: cq, r: cr });
      cq += d.dq; cr += d.dr;
    }
    if (!ok) continue;
    // exit path toward edge must hold no DIFFERENT-direction tile right now
    let eq = cq, er = cr, blocked = false;
    while (inB(eq, er)) {
      const t = board.get(key(eq, er));
      if (t && t.dir !== dName) { blocked = true; break; }
      eq += d.dq; er += d.dr;
    }
    if (blocked) continue;
    const color = COLOR_KEYS[rnd(6)];
    for (const c of ray) board.set(key(c.q, c.r), { color, dir: dName });
    placed++;
  }
  return board;
}

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
const AXIS_DIRS = { V: ["N", "S"], D1: ["NE", "SW"], D2: ["SE", "NW"] };
const AXIS_GLYPH = { V: "↕", D1: "╱", D2: "╲" };

// Difficulty is driven by the WEAKEST lane family's blocked %, so a board can't
// hide an easy diagonal escape behind a high pooled average.
const DIFFS = [
  { label: "Easy",   density: 0.45, lo: 0.00, hi: 0.20, expert: false },
  { label: "Med",    density: 0.62, lo: 0.20, hi: 0.38, expert: false },
  { label: "Hard",   density: 0.74, lo: 0.38, hi: 0.54, expert: false },
  { label: "Expert", density: 0.84, lo: 0.54, hi: 1.00, expert: true },
];
const DIFF_COLOR = ["#34d36b", "#ffd23f", "#ff9d2e", "#ff4d4d"];
const groupsFor = (R, lvl, band) => Math.floor(cellCount(R) * band.density) + lvl * 2;

// solvable generator, biased to balance tiles across the three lane families
function genBoardBalanced(R, groups) {
  const cells = allCells(R);
  const inB = (q, r) => cubeMax(q, r) <= R;
  const board = new Map();
  const axc = { V: 0, D1: 0, D2: 0 };
  let tries = 0, placed = 0;
  while (placed < groups && tries < groups * 80) {
    tries++;
    // prefer an underused axis so every lane family gets crossing traffic
    const ax = [...AXES].sort((a, b) => axc[a] - axc[b])[rnd(2)];
    const dName = AXIS_DIRS[ax][rnd(2)];
    const d = DIRS[dName];
    const start = cells[rnd(cells.length)];
    const k = 1 + rnd(4);
    const ray = [];
    let cq = start.q, cr = start.r, ok = true;
    for (let i = 0; i < k; i++) {
      if (!inB(cq, cr) || board.has(key(cq, cr))) { ok = false; break; }
      ray.push({ q: cq, r: cr });
      cq += d.dq; cr += d.dr;
    }
    if (!ok) continue;
    let eq = cq, er = cr, blocked = false;
    while (inB(eq, er)) {
      const t = board.get(key(eq, er));
      if (t && t.dir !== dName) { blocked = true; break; }
      eq += d.dq; er += d.dr;
    }
    if (blocked) continue;
    const color = COLOR_KEYS[rnd(6)];
    for (const c of ray) { board.set(key(c.q, c.r), { color, dir: dName }); axc[ax]++; }
    placed++;
  }
  packBoard(board, R);
  return board;
}

// fill every remaining empty cell with a single tile whose exit path is clear
// of different-direction tiles. Maintains the constructive solvability invariant:
// packing tiles are placed last, so launching them first in reverse-placement
// order leaves the originally-generated board intact.
function packBoard(board, R) {
  const empties = [];
  for (let q = -R; q <= R; q++)
    for (let r = -R; r <= R; r++)
      if (cubeMax(q, r) <= R && !board.has(key(q, r))) empties.push({ q, r });
  // shuffle so the fill order doesn't bias toward a corner
  for (let i = empties.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [empties[i], empties[j]] = [empties[j], empties[i]];
  }
  for (const { q, r } of empties) {
    const dirs = DIR_KEYS.slice().sort(() => Math.random() - 0.5);
    for (const dName of dirs) {
      const d = DIRS[dName];
      let cq = q + d.dq, cr = r + d.dr, blocked = false;
      while (cubeMax(cq, cr) <= R) {
        const t = board.get(key(cq, cr));
        if (t && t.dir !== dName) { blocked = true; break; }
        cq += d.dq; cr += d.dr;
      }
      if (blocked) continue;
      board.set(key(q, r), { color: COLOR_KEYS[rnd(6)], dir: dName });
      break;
    }
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
// generate solvable boards; pick by weakest-lane blocked %. Expert = maximize it.
function genBoardDiff(R, lvl, band) {
  let inBand = null, bestForExpert = null, bestExpVal = -1, closest = null, closestDist = Infinity;
  for (let i = 0; i < 320; i++) {
    const b = genBoardBalanced(R, groupsFor(R, lvl, band));
    if (!b.size) continue;
    const m = metrics(b, R);
    if (band.expert) {
      if (m.minAxis > bestExpVal) { bestExpVal = m.minAxis; bestForExpert = { board: b, ...m }; }
    } else if (m.minAxis >= band.lo && m.minAxis <= band.hi) {
      inBand = { board: b, ...m }; break;
    }
    const dist = m.minAxis < band.lo ? band.lo - m.minAxis : m.minAxis - band.hi;
    if (dist < closestDist) { closestDist = dist; closest = { board: b, ...m }; }
  }
  return band.expert ? bestForExpert : (inBand || closest);
}

// number of cells from (q,r) traveling in dir until fully off the board
function stepsToEdge(q, r, dir, R) {
  const d = DIRS[dir];
  let cq = q, cr = r, steps = 0;
  while (cubeMax(cq, cr) <= R) { cq += d.dq; cr += d.dr; steps++; }
  return steps + 1; // one extra so the tile leaves the visible frame
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
function HexShape({ color, dir, faded }: { color?: string; dir?: string; faded?: boolean }) {
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
  return (
    <g>
      <polygon points={pts} fill={c.dark} transform="translate(0,2.5)" opacity="0.55" />
      <polygon points={pts} fill={`url(#g-${color})`} stroke={c.dark} strokeWidth="1.5" strokeLinejoin="round" />
      <polygon points={corners.slice(4).concat(corners.slice(0, 1)).join(" ")} fill="rgba(255,255,255,.28)" opacity="0.0" />
      <ellipse cx="0" cy={-SIZE * 0.42} rx={SIZE * 0.5} ry={SIZE * 0.16} fill="rgba(255,255,255,.35)" />
      <g transform={`rotate(${d.angle})`}>
        <path d={arrow} fill={c.arrow} stroke="rgba(0,0,0,.18)" strokeWidth="0.8" strokeLinejoin="round" />
      </g>
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

  const boardRef = useRef(board); boardRef.current = board;
  const chainRef = useRef(chain); chainRef.current = chain;
  const modeRef = useRef(mode); modeRef.current = mode;
  const turnRef = useRef(turn); turnRef.current = turn;
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
    setBoard(res.board);
    setMetric({ axB: res.axB, minAxis: res.minAxis, tiles: res.tiles });
    setMoves(0);
    setWon(false);
    setChain({ mult: 1, expire: 0, barKey: 0 });
    histRef.current = [];
    setFlying([]); setPops([]);
    if (m === "2p") {
      setPScores([0, 0]);
      setTurn(0);
      setScore(0);
    } else {
      setScore(0);
    }
  }, []);

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

  const launch = (q, r) => {
    if (won) return;
    if (animLockRef.current) return; // ignore taps mid-animation
    const b = boardRef.current;
    const tile = b.get(key(q, r));
    if (!tile) return;
    const d = DIRS[tile.dir];

    // sweep from tapped cell toward edge
    const group: any[] = [];
    let cq = q, cr = r, blocked = false;
    while (cubeMax(cq, cr) <= R) {
      const t = b.get(key(cq, cr));
      if (t) {
        if (t.dir === tile.dir) group.push({ q: cq, r: cr, ...t });
        else { blocked = true; break; }
      }
      cq += d.dq; cr += d.dr;
    }

    if (blocked || group.length === 0) {
      // subtle error tone + lean-and-reflect fold animation
      blip.errSoft();
      const el = tileRefs.current.get(key(q, r));
      if (el) {
        const u = dirUnitPx(d);
        // first half: fold ~40% of a step forward (45deg lean). second half: snap back.
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

    // ---- success: scoring ----
    const now = Date.now();
    const prev = chainRef.current;
    // chain disabled in two-player mode
    const mult = modeRef.current === "2p" ? 1 : (now < prev.expire ? prev.mult + 1 : 1);
    const n = group.length;
    const sameColor = group.every((g) => g.color === group[0].color);
    const diag = isDiagonal(tile.dir);

    const base = n * 12;
    const sweepBonus = n > 1 ? n * n * 6 : 0;
    const colorBonus = sameColor && n > 1 ? n * n * 10 : 0;
    const diagBonus = sameColor && diag && n >= 2 ? n * n * 16 : 0;
    const gained = (base + sweepBonus + colorBonus + diagBonus) * mult;

    const tags: string[] = [];
    if (n > 1) tags.push(`${n}× SWEEP`);
    if (diagBonus) tags.push("◆ DIAGONAL");
    else if (colorBonus) tags.push("PURE COLOR");

    histRef.current.push({ board: new Map(b), score, moves, pScores: [...pScores] as [number, number], turn });
    if (histRef.current.length > 40) histRef.current.shift();

    // remove from board
    const nb = new Map(b);
    group.forEach((g) => nb.delete(key(g.q, g.r)));
    setBoard(nb);
    setMoves((m) => m + 1);

    if (modeRef.current === "2p") {
      setPScores((ps) => {
        const next = [...ps] as [number, number];
        next[turnRef.current] += gained;
        return next;
      });
      setChain({ mult: 1, expire: 0, barKey: 0 });
    } else {
      setScore((s) => { const ns = s + gained; setBest((bs) => Math.max(bs, ns)); return ns; });
      setChain({ mult, expire: now + CHAIN_WINDOW, barKey: prev.barKey + 1 });
      setBestChain((bc) => Math.max(bc, mult));
    }
    blip.pop(n, mult);

    // ---- fold-fly animation: each tile tumbles cell-by-cell off the board ----
    const u = dirUnitPx(d);
    animLockRef.current = true;
    const newFly = group.map((g, i) => {
      const p = px(g.q, g.r);
      const steps = stepsToEdge(g.q, g.r, g.dir, R);
      return { id: ++idRef.current, x: p.x, y: p.y, color: g.color, dir: g.dir, ux: u.x, uy: u.y, steps, delay: i * 60 };
    });
    setFlying((f) => [...f, ...newFly]);

    // estimate when all fold anims finish, then advance turn / unlock
    const maxSteps = Math.max(...newFly.map((f) => f.steps));
    const lastDelay = newFly[newFly.length - 1]?.delay ?? 0;
    const totalAnim = lastDelay + maxSteps * FOLD_MS + 40;
    setTimeout(() => {
      animLockRef.current = false;
      if (modeRef.current === "2p" && nb.size > 0) {
        setTurn((t) => {
          const nxt = (t === 0 ? 1 : 0) as 0 | 1;
          blip.turn(nxt);
          return nxt;
        });
      }
    }, totalAnim);

    // score popup at tapped tile
    const tp = px(q, r);
    const popId = ++idRef.current;
    const popPlayer = modeRef.current === "2p" ? turnRef.current : -1;
    setPops((ps) => [...ps, {
      id: popId, x: tp.x, y: tp.y, gained, mult, tags, hot: !!diagBonus, player: popPlayer,
    }]);
    setTimeout(() => setPops((ps) => ps.filter((p) => p.id !== popId)), 950);

    // win check
    if (nb.size === 0) { setTimeout(() => { setWon(true); blip.win(); }, 350); }
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
                </div>
              );
            })}
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
                  <HexShape color={t.color} dir={t.dir} />
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
                    <HexShape color={f.color} dir={f.dir} />
                  </g>
                </g>
              );
            })}
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
              <li><b>Sweep combo:</b> any tile in its path pointing the <i>same</i> direction tumbles off <i>with</i> it. Empty gaps are passed over freely.</li>
              <li><b>Blocked:</b> a tile pointing a <i>different</i> direction stops the shot. The tapped tile leans forward, plays a soft error tone, and reflects back to its origin.</li>
              <li><b>Score:</b> big sweeps pay off fast — a 5-tile sweep is worth far more than five singles.</li>
              <li><b>◆ Diagonal bonus:</b> sweep a run that's all <i>one color</i> along a <i>diagonal</i> for a big extra payout.</li>
              <li><b>Chains (solo only):</b> fire again before the chain meter empties to stack ×2, ×3… on every point you earn.</li>
              <li><b>2 Player:</b> players alternate turns — even on a blocked tap, your turn ends. No chain multiplier. Highest score when the grid clears wins.</li>
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
