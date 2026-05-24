import React, { useState, useRef, useEffect, useCallback } from "react";
import { RotateCcw, Undo2, Volume2, VolumeX, HelpCircle, Zap, ChevronRight, X } from "lucide-react";

/*  HEX BLAST  — an original sweep-combo hex puzzle.
    Tap a tile: it flies off the board in its arrow direction, sweeping any
    SAME-direction tile in its path along with it. A DIFFERENT-direction tile
    blocks the shot. Big sweeps + fast chains = huge scores.            */

const SIZE = 30;                       // hex radius (user units)
const CHAIN_WINDOW = 2600;             // ms to keep a chain alive

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

// ---------- hex geometry ----------
const px = (q, r) => ({ x: SIZE * 1.5 * q, y: SIZE * Math.sqrt(3) * (r + q / 2) });
const cubeMax = (q, r) => { const x = q, z = r, y = -x - z; return Math.max(Math.abs(x), Math.abs(y), Math.abs(z)); };
const key = (q, r) => q + "," + r;

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
  return board;
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

// ---------- tiny web-audio juice ----------
function useBlips(enabledRef) {
  const ctxRef = useRef(null);
  const ensure = () => {
    if (!ctxRef.current) {
      try { ctxRef.current = new (window.AudioContext || window.webkitAudioContext)(); }
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
  return {
    pop: (n, mult) => tone(280 + n * 55 + mult * 70, 0.16 + n * 0.015, "triangle", 0.16),
    block: () => tone(120, 0.14, "sawtooth", 0.12),
    win: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.22, "triangle", 0.18), i * 90)); },
  };
}

// ---------- a single hex tile drawn at origin ----------
function HexShape({ color, dir, faded }) {
  const c = COLORS[color];
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * 60 * i;
    corners.push(`${(SIZE * 0.94 * Math.cos(a)).toFixed(2)},${(SIZE * 0.94 * Math.sin(a)).toFixed(2)}`);
  }
  const pts = corners.join(" ");
  if (faded) {
    return <polygon points={pts} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="1.4" />;
  }
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
  const [first] = useState(() => genBoardDiff(3, 1, DIFFS[1]));
  const [board, setBoard] = useState(() => first.board);
  const [metric, setMetric] = useState(() => ({ axB: first.axB, minAxis: first.minAxis, tiles: first.tiles }));
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(0);
  const [best, setBest] = useState(0);
  const [bestChain, setBestChain] = useState(1);
  const [flying, setFlying] = useState([]);
  const [pops, setPops] = useState([]);
  const [chain, setChain] = useState({ mult: 1, expire: 0, barKey: 0 });
  const [won, setWon] = useState(false);
  const [help, setHelp] = useState(false);
  const [sound, setSound] = useState(true);

  const boardRef = useRef(board); boardRef.current = board;
  const chainRef = useRef(chain); chainRef.current = chain;
  const histRef = useRef([]);
  const idRef = useRef(0);
  const tileRefs = useRef(new Map());
  const soundRef = useRef(sound); soundRef.current = sound;
  const blip = useBlips(soundRef);

  // chain decay
  useEffect(() => {
    const id = setInterval(() => {
      if (chainRef.current.mult > 1 && Date.now() > chainRef.current.expire) {
        setChain((c) => ({ ...c, mult: 1 }));
      }
    }, 120);
    return () => clearInterval(id);
  }, []);

  const startLevel = useCallback((lvl, R, di) => {
    const res = genBoardDiff(R, lvl, DIFFS[di]);
    setBoard(res.board);
    setMetric({ axB: res.axB, minAxis: res.minAxis, tiles: res.tiles });
    setMoves(0);
    setWon(false);
    setChain({ mult: 1, expire: 0, barKey: 0 });
    histRef.current = [];
    setFlying([]); setPops([]);
  }, []);

  const newBoard = () => startLevel(level, sizeR, diffIdx);
  const nextLevel = () => { const n = level + 1; setLevel(n); startLevel(n, sizeR, diffIdx); };
  const chooseSize = (R) => { setSizeR(R); startLevel(level, R, diffIdx); };
  const chooseDiff = (di) => { setDiffIdx(di); startLevel(level, sizeR, di); };

  const undo = () => {
    const h = histRef.current.pop();
    if (!h) return;
    setBoard(h.board);
    setScore(h.score);
    setMoves(h.moves);
    setWon(false);
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
  const span = Math.hypot(vb[2], vb[3]);

  const launch = (q, r) => {
    if (won) return;
    const b = boardRef.current;
    const tile = b.get(key(q, r));
    if (!tile) return;
    const d = DIRS[tile.dir];

    // sweep from tapped cell toward edge
    const group = [];
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
      blip.block();
      const el = tileRefs.current.get(key(q, r));
      if (el) el.animate(
        [{ transform: "translate(0,0)" }, { transform: "translate(3px,0)" },
         { transform: "translate(-3px,0)" }, { transform: "translate(2px,0)" },
         { transform: "translate(0,0)" }],
        { duration: 220, easing: "ease-in-out" });
      return;
    }

    // ---- success: scoring ----
    const now = Date.now();
    const prev = chainRef.current;
    const mult = now < prev.expire ? prev.mult + 1 : 1;
    const n = group.length;
    const sameColor = group.every((g) => g.color === group[0].color);
    const diag = isDiagonal(tile.dir);

    const base = n * 12;
    const sweepBonus = n > 1 ? n * n * 6 : 0;                       // length
    const colorBonus = sameColor && n > 1 ? n * n * 10 : 0;         // same-color run
    const diagBonus = sameColor && diag && n >= 2 ? n * n * 16 : 0; // same-color diagonal
    const gained = (base + sweepBonus + colorBonus + diagBonus) * mult;

    const tags = [];
    if (n > 1) tags.push(`${n}× SWEEP`);
    if (diagBonus) tags.push("◆ DIAGONAL");
    else if (colorBonus) tags.push("PURE COLOR");

    histRef.current.push({ board: new Map(b), score, moves });
    if (histRef.current.length > 40) histRef.current.shift();

    // remove from board
    const nb = new Map(b);
    group.forEach((g) => nb.delete(key(g.q, g.r)));
    setBoard(nb);
    setMoves((m) => m + 1);
    setScore((s) => { const ns = s + gained; setBest((bs) => Math.max(bs, ns)); return ns; });
    setChain({ mult, expire: now + CHAIN_WINDOW, barKey: prev.barKey + 1 });
    setBestChain((bc) => Math.max(bc, mult));
    blip.pop(n, mult);

    // fly-out animation
    const u = dirUnitPx(d);
    const dist = span + SIZE * 4;
    const newFly = group.map((g, i) => {
      const p = px(g.q, g.r);
      return { id: ++idRef.current, x: p.x, y: p.y, color: g.color, dir: g.dir, dx: u.x * dist, dy: u.y * dist, delay: i * 26 };
    });
    setFlying((f) => [...f, ...newFly]);

    // score popup at tapped tile
    const tp = px(q, r);
    const popId = ++idRef.current;
    setPops((ps) => [...ps, {
      id: popId, x: tp.x, y: tp.y, gained, mult, tags, hot: !!diagBonus,
    }]);
    setTimeout(() => setPops((ps) => ps.filter((p) => p.id !== popId)), 950);

    // win check
    if (nb.size === 0) { setTimeout(() => { setWon(true); blip.win(); }, 350); }
  };

  // remove flying tiles after their animation
  const flyDone = (id) => setFlying((f) => f.filter((x) => x.id !== id));

  const chainAlive = chain.mult > 1 && Date.now() < chain.expire;

  return (
    <div style={styles.root}>
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
              <p style={styles.sub}>sweep · chain · clear the grid</p>
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

        {/* stat strip */}
        <div style={styles.stats}>
          <Stat label="LEVEL" value={level} />
          <Stat label="SCORE" value={score.toLocaleString()} big />
          <Stat label="MOVES" value={moves} />
          <Stat label="BEST ×" value={bestChain} accent={COLORS.amber.base} />
        </div>

        {/* chain meter */}
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
        <div style={styles.boardWrap}>
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
            {[...board.entries()].map(([k, t]) => {
              const [q, r] = k.split(",").map(Number);
              const p = px(q, r);
              return (
                <g
                  key={k}
                  ref={(el) => { if (el) tileRefs.current.set(k, el); else tileRefs.current.delete(k); }}
                  transform={`translate(${p.x},${p.y})`}
                  className="tile"
                  onClick={() => launch(q, r)}
                >
                  <HexShape color={t.color} dir={t.dir} />
                </g>
              );
            })}
            {/* flying tiles */}
            {flying.map((f) => (
              <g key={f.id} transform={`translate(${f.x},${f.y})`} style={{ pointerEvents: "none" }}>
                <g
                  ref={(el) => {
                    if (!el || el.dataset.run) return;
                    el.dataset.run = "1";
                    const anim = el.animate(
                      [
                        { transform: "translate(0px,0px) scale(1)", opacity: 1 },
                        { opacity: 1, offset: 0.55 },
                        { transform: `translate(${f.dx}px,${f.dy}px) scale(.35)`, opacity: 0 },
                      ],
                      { duration: 540, delay: f.delay, easing: "cubic-bezier(.45,0,.85,.35)", fill: "forwards" }
                    );
                    anim.onfinish = () => flyDone(f.id);
                  }}
                >
                  <HexShape color={f.color} dir={f.dir} />
                </g>
              </g>
            ))}
            {/* score popups */}
            {pops.map((p) => {
              const line2 = [...p.tags, p.mult > 1 ? `CHAIN ×${p.mult}` : null].filter(Boolean).join("  ·  ");
              return (
                <g key={p.id} transform={`translate(${p.x},${p.y})`} className="pop" style={{ pointerEvents: "none" }}>
                  <text textAnchor="middle" y={-4} style={{ font: "700 18px 'Space Mono', monospace", fill: p.hot ? COLORS.sun.base : "#fff", paintOrder: "stroke", stroke: "rgba(0,0,0,.6)", strokeWidth: 3.5 }}>
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
            <p style={styles.cardSub}>Level {level} done in {moves} moves</p>
            <div style={styles.cardStats}>
              <div><div style={styles.csVal}>{score.toLocaleString()}</div><div style={styles.csLbl}>SCORE</div></div>
              <div><div style={styles.csVal}>×{bestChain}</div><div style={styles.csLbl}>BEST CHAIN</div></div>
            </div>
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
              <li><b>Tap a tile</b> — it flies off the board in the direction its arrow points.</li>
              <li><b>Sweep combo:</b> any tile in its path pointing the <i>same</i> direction gets blasted off <i>with</i> it. Empty gaps are flown over freely.</li>
              <li><b>Blockers:</b> a tile pointing a <i>different</i> direction stops the shot. Clear it first.</li>
              <li><b>Score:</b> big sweeps pay off fast — a 5-tile sweep is worth far more than five singles.</li>
              <li><b>◆ Diagonal bonus:</b> sweep a run that's all <i>one color</i> along a <i>diagonal</i> for a big extra payout (a same-color run in any direction earns a smaller "pure color" bonus).</li>
              <li><b>Chains:</b> fire again before the chain meter empties to stack ×2, ×3, ×4… on every point you earn.</li>
              <li><b>Difficulty</b> is set by the <i>weakest of the three lane families</i> — vertical ↕, diagonal ╱, and diagonal ╲. The readout shows each one's blocked %, so there's no easy diagonal to escape through. Expert maximizes the weakest lane.</li>
              <li><b>Goal:</b> clear every tile. Each board is always solvable.</li>
            </ul>
            <button style={styles.cta} onClick={() => setHelp(false)}>Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, big, accent }) {
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
.tile{cursor:pointer;transition:filter .12s;}
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

const styles = {
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
  rules: { textAlign: "left", margin: "8px 0 20px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 11, fontSize: 14, color: "#cdc7da", lineHeight: 1.45 },
};

// keyframes that can't live in inline styles
const sheet = typeof document !== "undefined" ? document.createElement("style") : null;
if (sheet) {
  sheet.textContent = `@keyframes drain{from{transform:scaleX(1);}to{transform:scaleX(0);}}@keyframes fade{from{opacity:0;}to{opacity:1;}}`;
  document.head.appendChild(sheet);
}
