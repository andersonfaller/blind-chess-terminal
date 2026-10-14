#!/usr/bin/env node
// Generates the built-in blindfold puzzle set (js/data/puzzles.js).
//
// Positions are random but sparse (few pieces, easy to hold in your head),
// and every puzzle is verified with Stockfish: forced mate in N with a single
// winning first move.
//
//   node tools/gen-puzzles.mjs [mate1=60] [mate2=60] [mate3=30]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Chess, validateFen } from '../vendor/chess.js/chess.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const want = { 1: +(process.argv[2] || 60), 2: +(process.argv[3] || 60), 3: +(process.argv[4] || 30) };

// --- tiny UCI client over stdin/stdout ---------------------------------------
const sf = spawn(process.execPath, [path.join(root, 'vendor/stockfish/stockfish-18-lite-single.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let waiter = null;
const lines = [];
sf.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    lines.push(line);
    if (waiter && waiter.test(line)) {
      const w = waiter;
      waiter = null;
      w.resolve(lines.splice(0));
    }
  }
});
const send = (c) => sf.stdin.write(c + '\n');
const until = (re) => new Promise((resolve) => { waiter = { test: (l) => re.test(l), resolve }; });

async function analyse(fen, depth, multipv) {
  send(`setoption name MultiPV value ${multipv}`);
  send(`position fen ${fen}`);
  send(`go depth ${depth}`);
  const out = await until(/^bestmove/);
  const best = {};
  for (const l of out) {
    if (!l.startsWith('info') || !l.includes(' pv ')) continue;
    const mpv = +(l.match(/ multipv (\d+)/) || [0, 1])[1];
    const mate = l.match(/ score mate (-?\d+)/);
    const cp = l.match(/ score cp (-?\d+)/);
    const pv = l.split(' pv ')[1].trim().split(/\s+/);
    best[mpv] = { mate: mate ? +mate[1] : null, cp: cp ? +cp[1] : null, pv };
  }
  return best;
}

// --- random sparse positions ---------------------------------------------------
const rnd = (n) => Math.floor(Math.random() * n);
const pickW = (items) => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of items) { r -= w; if (r <= 0) return v; }
  return items[0][0];
};

function randomPosition() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null)); // [rank][file], rank 0 = 1st
  const free = (r, f) => !board[r][f];
  const place = (piece, r, f) => { board[r][f] = piece; };
  // Black king near an edge: that is where mates happen.
  const bkr = pickW([[7, 6], [6, 3], [5, 1], [4, 0.5]]);
  const bkf = pickW([[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1.2], [7, 1.2]]);
  place('k', bkr, bkf);
  let wkr, wkf;
  do { wkr = rnd(8); wkf = rnd(8); } while (Math.abs(wkr - bkr) <= 1 && Math.abs(wkf - bkf) <= 1);
  place('K', wkr, wkf);

  const counts = {};
  const limits = { q: 1, r: 2, b: 2, n: 2, p: 8 };
  const putRandom = (piece, nearKing = false) => {
    // Keep material natural: at most one queen and two of each minor/rook per side.
    if ((counts[piece] || 0) >= limits[piece.toLowerCase()]) return;
    counts[piece] = (counts[piece] || 0) + 1;
    for (let tries = 0; tries < 50; tries++) {
      let r, f;
      if (nearKing) { r = bkr + rnd(5) - 2; f = bkf + rnd(5) - 2; } else { r = rnd(8); f = rnd(8); }
      if (r < 0 || r > 7 || f < 0 || f > 7 || !free(r, f)) continue;
      if (piece.toLowerCase() === 'p' && (r === 0 || r === 7)) continue;
      place(piece, r, f);
      return;
    }
  };
  // Pawn shield in front of the black king, sometimes.
  if (bkr >= 6 && Math.random() < 0.7) {
    for (const df of [-1, 0, 1]) {
      const f = bkf + df;
      if (f >= 0 && f < 8 && Math.random() < 0.7 && free(bkr - 1, f) && bkr - 1 > 0) place('p', bkr - 1, f);
    }
  }
  const whiteOfficers = 1 + rnd(3);
  for (let i = 0; i < whiteOfficers; i++) putRandom(pickW([['Q', 3], ['R', 4], ['B', 3], ['N', 3]]), Math.random() < 0.5);
  for (let i = rnd(3); i > 0; i--) putRandom('P');
  for (let i = rnd(3); i > 0; i--) putRandom(pickW([['r', 3], ['b', 3], ['n', 3], ['q', 1]]), Math.random() < 0.6);
  for (let i = rnd(3); i > 0; i--) putRandom('p');

  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/') + ' w - - 0 1';
}

function sane(fen) {
  if (!validateFen(fen).ok) return false;
  const c = new Chess(fen);
  // Black (not to move) must not be in check.
  const flipped = fen.replace(' w ', ' b ');
  try {
    if (new Chess(flipped).inCheck()) return false;
  } catch { return false; }
  if (c.isGameOver()) return false;
  // Same-coloured bishops are fine, but limit material for blindfold friendliness.
  const pieces = fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
  return pieces >= 4 && pieces <= 12;
}

// Mirror a white-to-move puzzle so Black solves it.
function mirrorFen(fen) {
  const [placement] = fen.split(' ');
  const swapped = placement.split('/').reverse().map((row) => row.replace(/[a-zA-Z]/g, (ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()))).join('/');
  return `${swapped} b - - 0 1`;
}
const mirrorSq = (sq) => sq[0] + (9 - +sq[1]);
const mirrorUci = (u) => mirrorSq(u.slice(0, 2)) + mirrorSq(u.slice(2, 4)) + u.slice(4);

function verifyLine(fen, pv, n) {
  const c = new Chess(fen);
  for (const u of pv.slice(0, 2 * n - 1)) {
    try { c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { return false; }
  }
  return c.isCheckmate();
}

function keyIsQuiet(fen, uci) {
  const c = new Chess(fen);
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return !m.captured && !m.san.includes('+');
}

// --- main loop -------------------------------------------------------------------
send('uci');
await until(/^uciok/);
send('isready');
await until(/^readyok/);

const found = { 1: [], 2: [], 3: [] };
const seen = new Set();
let tried = 0;
const started = Date.now();
while (found[1].length < want[1] || found[2].length < want[2] || found[3].length < want[3]) {
  tried++;
  const fen = randomPosition();
  if (!sane(fen) || seen.has(fen)) continue;
  seen.add(fen);
  const r = await analyse(fen, 12, 2);
  const a = r[1];
  if (!a || a.mate == null || a.mate < 1 || a.mate > 3) continue;
  const n = a.mate;
  if (found[n].length >= want[n]) continue;
  const b = r[2];
  if (b && b.mate != null && b.mate > 0 && b.mate <= n) continue; // not unique
  // Deeper confirmation.
  const deep = await analyse(fen, 18, 2);
  if (!deep[1] || deep[1].mate !== n) continue;
  if (deep[2] && deep[2].mate != null && deep[2].mate > 0 && deep[2].mate <= n) continue;
  const pv = deep[1].pv.slice(0, 2 * n - 1);
  if (!verifyLine(fen, pv, n)) continue;
  const pieces = fen.split(' ')[0].replace(/[^a-zA-Z]/g, '').length;
  const quiet = keyIsQuiet(fen, pv[0]);
  const base = { 1: 900, 2: 1300, 3: 1700 }[n];
  const rating = base + 25 * (pieces - 4) + (quiet ? 150 : 0);
  found[n].push({ fen, pv, mate: n, rating });
  process.stderr.write(`\rmate1 ${found[1].length}/${want[1]}  mate2 ${found[2].length}/${want[2]}  mate3 ${found[3].length}/${want[3]}  (tried ${tried})   `);
}
process.stderr.write(`\ndone in ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
send('quit');

const all = [];
for (const n of [1, 2, 3]) {
  found[n].forEach((p, i) => {
    // Every other puzzle is mirrored so you also solve as Black.
    if (i % 2 === 1) all.push({ ...p, fen: mirrorFen(p.fen), pv: p.pv.map(mirrorUci) });
    else all.push(p);
  });
}
all.sort((a, b) => a.rating - b.rating);
const rows = all.map((p, i) => `  ['p${String(i + 1).padStart(3, '0')}', '${p.fen}', '${p.pv.join(' ')}', ${p.mate}, ${p.rating}],`);
const file = `// Generated by tools/gen-puzzles.mjs - do not edit by hand.
// Sparse positions (easy to visualise) with a forced mate verified by Stockfish.
// [id, fen, solution (UCI, solver moves and replies), mate in N, rating]
export const PUZZLES = [
${rows.join('\n')}
];
`;
writeFileSync(path.join(root, 'js/data/puzzles.js'), file);
console.log(`wrote ${all.length} puzzles`);
process.exit(0);
