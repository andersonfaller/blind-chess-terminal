// Pure chess helpers shared by the UI, the drills and the tests.
// No DOM access in this file.

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
export const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'];
export const ALL_SQUARES = RANKS.flatMap((r) => FILES.map((f) => f + r));
export const PIECE_ORDER = ['k', 'q', 'r', 'b', 'n', 'p'];
export const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const PIECE_NAMES = {
  en: { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' },
  pt: { k: 'rei', q: 'dama', r: 'torre', b: 'bispo', n: 'cavalo', p: 'peão' },
};

export const PIECE_NAMES_PLURAL = {
  en: { k: 'kings', q: 'queens', r: 'rooks', b: 'bishops', n: 'knights', p: 'pawns' },
  pt: { k: 'reis', q: 'damas', r: 'torres', b: 'bispos', n: 'cavalos', p: 'peões' },
};

export const COLOR_NAMES = {
  en: { w: 'white', b: 'black' },
  pt: { w: 'brancas', b: 'pretas' },
};

// Letters used to write SAN in each notation.
export const NOTATION_LETTERS = {
  en: { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N' },
  pt: { k: 'R', q: 'D', r: 'T', b: 'B', n: 'C' },
};

const EN_TO_PT = { K: 'R', Q: 'D', R: 'T', B: 'B', N: 'C' };
const PT_TO_EN = { R: 'K', D: 'Q', T: 'R', B: 'B', C: 'N', P: 'P' };
const PT_PROMO_LOWER = { d: 'q', t: 'r', c: 'n', b: 'b' };

const FIGURINES = {
  '♔': 'K', '♕': 'Q', '♖': 'R', '♗': 'B', '♘': 'N', '♙': 'P',
  '♚': 'K', '♛': 'Q', '♜': 'R', '♝': 'B', '♞': 'N', '♟': 'P',
};

export const GLYPHS = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

export const isSquare = (s) => typeof s === 'string' && /^[a-h][1-8]$/.test(s);

export function squareColor(sq) {
  const f = sq.charCodeAt(0) - 97;
  const r = sq.charCodeAt(1) - 49;
  return (f + r) % 2 === 0 ? 'dark' : 'light';
}

export const sqToXY = (sq) => [sq.charCodeAt(0) - 97, sq.charCodeAt(1) - 49];
export const xyToSq = (x, y) => String.fromCharCode(97 + x) + String.fromCharCode(49 + y);
export const onBoard = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;

export function sameDiagonal(a, b) {
  if (a === b) return false;
  const [ax, ay] = sqToXY(a);
  const [bx, by] = sqToXY(b);
  return Math.abs(ax - bx) === Math.abs(ay - by);
}

const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

export function knightMoves(sq) {
  const [x, y] = sqToXY(sq);
  const out = [];
  for (const [dx, dy] of KNIGHT_DELTAS) {
    if (onBoard(x + dx, y + dy)) out.push(xyToSq(x + dx, y + dy));
  }
  return out;
}

export const isKnightMove = (a, b) => knightMoves(a).includes(b);

// Shortest knight path from a to b (inclusive of both ends).
export function knightPath(a, b) {
  if (a === b) return [a];
  const prev = { [a]: null };
  const queue = [a];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of knightMoves(cur)) {
      if (nxt in prev) continue;
      prev[nxt] = cur;
      if (nxt === b) {
        const path = [b];
        let p = cur;
        while (p) { path.unshift(p); p = prev[p]; }
        return path;
      }
      queue.push(nxt);
    }
  }
  return null;
}

export const knightDistance = (a, b) => knightPath(a, b).length - 1;

// ---------------------------------------------------------------------------
// Notation

export function sanToLocal(san, notation = 'en') {
  if (notation !== 'pt' || !san) return san;
  return san.replace(/[KQRBN]/g, (c) => EN_TO_PT[c]);
}

export function pieceLetter(type, notation = 'en') {
  return type === 'p' ? '' : NOTATION_LETTERS[notation === 'pt' ? 'pt' : 'en'][type];
}

function replaceFigurines(s) {
  return s.replace(/[♔♕♖♗♘♙♚♛♜♝♞♟]︎?/g, (c) => FIGURINES[c[0]]);
}

const PROMO_RE = /^[qrbn]$/;

function legalMoves(chess) {
  return chess.moves({ verbose: true });
}

function tryCoordinate(s, moves) {
  const m = s.match(/^([a-h][1-8])[-x:]?([a-h][1-8])=?([qrbn])?$/i);
  if (!m) return null;
  const from = m[1].toLowerCase();
  const to = m[2].toLowerCase();
  const promo = m[3] ? m[3].toLowerCase() : null;
  let cands = moves.filter((mv) => mv.from === from && mv.to === to);
  return finishCandidates(cands, promo, { piece: null, to });
}

function trySan(s, moves) {
  const m = s.match(/^([KQRBNP])?([a-h])?([1-8])?[x:]?([a-h][1-8])=?([QRBNqrbn])?$/);
  if (!m) return null;
  const piece = m[1] ? m[1].toLowerCase() : 'p';
  const fromFile = m[2];
  const fromRank = m[3];
  const to = m[4];
  const promo = m[5] ? m[5].toLowerCase() : null;
  if (promo && piece !== 'p') return null;
  const cands = moves.filter((mv) =>
    mv.piece === piece &&
    mv.to === to &&
    (!fromFile || mv.from[0] === fromFile) &&
    (!fromRank || mv.from[1] === fromRank));
  return finishCandidates(cands, promo, { piece, to });
}

function finishCandidates(cands, promo, info) {
  let autoQueen = false;
  if (promo) {
    if (!PROMO_RE.test(promo)) return { syntaxOk: true, cands: [], ...info };
    cands = cands.filter((mv) => mv.promotion === promo);
  } else if (cands.length && cands.every((mv) => mv.promotion)) {
    cands = cands.filter((mv) => mv.promotion === 'q');
    autoQueen = true;
  }
  return { syntaxOk: true, cands, autoQueen, ...info };
}

/**
 * Parse a move typed (or spoken) by a human. Very tolerant: SAN, long algebraic,
 * UCI, castling with 0/o, missing "x", wrong letter case, figurines and the
 * Portuguese piece letters (R D T B C) when notation === 'pt'.
 *
 * Returns { ok: true, move, autoQueen } or
 *         { ok: false, error: 'empty'|'syntax'|'illegal'|'ambiguous', candidates, piece, to }
 */
export function parseMove(chess, rawInput, { notation = 'en' } = {}) {
  let s = String(rawInput ?? '').trim();
  if (!s) return { ok: false, error: 'empty' };

  s = s.replace(/\s*(e\.p\.|ep)$/i, '').replace(/[+#!?]+$/g, '').replace(/[+#]/g, '');
  s = s.replace(/\s+/g, '');
  const moves = legalMoves(chess);

  // Castling, written in any of the usual ways (O-O, 0-0, o-o, OO).
  const c = s.replace(/0/g, 'O').toUpperCase();
  if (/^O-?O(-?O)?$/.test(c)) {
    const long = /^O-?O-?O$/.test(c);
    const mv = moves.find((m) => (long ? m.isQueensideCastle() : m.isKingsideCastle()));
    if (mv) return { ok: true, move: mv };
    return { ok: false, error: 'illegal', piece: 'k', castle: long ? 'long' : 'short', candidates: [] };
  }

  const original = s;
  if (notation === 'pt') {
    s = s.replace(/[RDTBCP]/g, (ch) => PT_TO_EN[ch]);
    // Lower-case Portuguese promotion letter (e8d, e8=t...)
    s = s.replace(/([a-h][18])(=?)([dtc])$/i, (_, sq, eq, p) => sq + eq + PT_PROMO_LOWER[p.toLowerCase()]);
  }
  s = replaceFigurines(s);

  // Interpretations in order of likelihood.
  const variants = [s];
  const add = (v) => { if (v && !variants.includes(v)) variants.push(v); };
  if (/^[A-H]/.test(s)) add(s[0].toLowerCase() + s.slice(1));
  if (/^[nrqkb]/.test(s)) add(s[0].toUpperCase() + s.slice(1));
  add(s.toLowerCase());
  if (/^[a-h]/i.test(s)) add(s[0].toUpperCase() + s.slice(1).toLowerCase());
  // Phone keyboards capitalise the first letter: "D4" in Portuguese mode is a pawn move.
  add(replaceFigurines(original).toLowerCase());

  let syntaxOk = false;
  let ambiguous = null;
  let info = null;
  for (const v of variants) {
    for (const res of [tryCoordinate(v, moves), trySan(v, moves)]) {
      if (!res) continue;
      syntaxOk = true;
      if (!info) info = res;
      if (res.cands.length === 1) return { ok: true, move: res.cands[0], autoQueen: res.autoQueen };
      if (res.cands.length > 1 && !ambiguous) ambiguous = res;
    }
  }
  if (ambiguous) {
    return { ok: false, error: 'ambiguous', candidates: ambiguous.cands.map((m) => m.san), piece: ambiguous.piece, to: ambiguous.to };
  }
  if (syntaxOk) return { ok: false, error: 'illegal', candidates: [], piece: info.piece, to: info.to };
  return { ok: false, error: 'syntax', candidates: [] };
}

export function uciToObj(uci) {
  if (!uci || uci.length < 4) return null;
  const obj = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  if (uci.length > 4) obj.promotion = uci[4].toLowerCase();
  return obj;
}

export const moveToUci = (m) => m.from + m.to + (m.promotion || '');

// Convert a UCI principal variation into SAN using a scratch board.
export function pvToSan(ChessCtor, fen, pv, max = 8) {
  const board = new ChessCtor(fen);
  const out = [];
  for (const uci of pv.slice(0, max)) {
    try {
      const mv = board.move(uciToObj(uci));
      out.push(mv.san);
    } catch {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Speech helpers

const PT_FILE_SOUNDS = { a: 'á', b: 'bê', c: 'cê', d: 'dê', e: 'é', f: 'éfe', g: 'gê', h: 'agá' };

export function squareToSpeech(sq, lang = 'en') {
  if (lang === 'pt') return `${PT_FILE_SOUNDS[sq[0]]} ${sq[1]}`;
  return `${sq[0].toUpperCase()} ${sq[1]}`;
}

const SPEECH = {
  en: { takes: 'takes', on: 'on', promotes: 'promotes to', check: 'check', mate: 'checkmate', short: 'castles kingside', long: 'castles queenside' },
  pt: { takes: 'toma', on: 'em', promotes: 'promove a', check: 'xeque', mate: 'xeque-mate', short: 'roque pequeno', long: 'roque grande' },
};

/** Turn a SAN move into words, e.g. "Nxe5+" -> "Knight takes E 5, check". */
export function sanToSpeech(san, lang = 'en', { captured = null } = {}) {
  const L = lang === 'pt' ? 'pt' : 'en';
  const w = SPEECH[L];
  const names = PIECE_NAMES[L];
  const suffix = san.endsWith('#') ? `, ${w.mate}` : san.includes('+') ? `, ${w.check}` : '';
  const core = san.replace(/[+#!?]/g, '');
  if (/^O-O-O$/.test(core)) return cap(w.long) + suffix;
  if (/^O-O$/.test(core)) return cap(w.short) + suffix;
  const m = core.match(/^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=([QRBN]))?$/);
  if (!m) return san;
  const [, piece, dFile, dRank, x, to, promo] = m;
  const parts = [];
  if (piece) parts.push(cap(names[piece.toLowerCase()]));
  if (dFile) parts.push(L === 'pt' ? PT_FILE_SOUNDS[dFile] : dFile.toUpperCase());
  if (dRank) parts.push(dRank);
  if (x) {
    parts.push(w.takes);
    if (captured) parts.push(`${names[captured]} ${w.on}`);
  }
  parts.push(squareToSpeech(to, L));
  if (promo) parts.push(`${w.promotes} ${names[promo.toLowerCase()]}`);
  return parts.join(' ') + suffix;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const capitalize = cap;

// ---------------------------------------------------------------------------
// Position description (for blindfold players)

/** Group pieces by color: { w: [{type, square}], b: [...] } sorted K Q R B N P. */
export function listPieces(chess) {
  const out = { w: [], b: [] };
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) out[cell.color].push({ type: cell.type, square: cell.square });
    }
  }
  const order = (p) => PIECE_ORDER.indexOf(p.type);
  for (const c of ['w', 'b']) {
    out[c].sort((a, b) => order(a) - order(b) || a.square.localeCompare(b.square));
  }
  return out;
}

/** "Ke1 Qd1 Ra1 · a2 b2 c2" style string for one side. */
export function piecesToText(list, notation = 'en') {
  const officers = list.filter((p) => p.type !== 'p').map((p) => pieceLetter(p.type, notation) + p.square);
  const pawns = list.filter((p) => p.type === 'p').map((p) => p.square);
  return { officers, pawns };
}

export function piecesToSpeech(list, lang = 'en') {
  const L = lang === 'pt' ? 'pt' : 'en';
  const names = PIECE_NAMES[L];
  const parts = list.filter((p) => p.type !== 'p').map((p) => `${names[p.type]} ${squareToSpeech(p.square, L)}`);
  const pawns = list.filter((p) => p.type === 'p').map((p) => squareToSpeech(p.square, L));
  if (pawns.length) parts.push(`${PIECE_NAMES_PLURAL[L].p}: ${pawns.join(', ')}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Move lists

export function fenInfo(fen) {
  const parts = fen.split(/\s+/);
  return { turn: parts[1] || 'w', moveNumber: parseInt(parts[5], 10) || 1 };
}

/**
 * Number a list of SAN moves: ["e4","e5","Nf3"] -> [{n:1, w:"e4", b:"e5"}, {n:2, w:"Nf3"}]
 */
export function numberMoves(sans, startFen) {
  const { turn, moveNumber } = startFen ? fenInfo(startFen) : { turn: 'w', moveNumber: 1 };
  const rows = [];
  let n = moveNumber;
  let i = 0;
  if (turn === 'b' && sans.length) {
    rows.push({ n, w: null, b: sans[0] });
    i = 1;
    n++;
  }
  for (; i < sans.length; i += 2) {
    rows.push({ n, w: sans[i], b: sans[i + 1] ?? null });
    n++;
  }
  return rows;
}

export function movesToText(sans, startFen, notation = 'en') {
  return numberMoves(sans, startFen)
    .map((r) => (r.w ? `${r.n}. ${sanToLocal(r.w, notation)}` : `${r.n}...`) + (r.b ? ` ${sanToLocal(r.b, notation)}` : ''))
    .join(' ');
}

/** Label for the move about to be played, e.g. "12." or "12...". */
export function moveLabel(fen) {
  const { turn, moveNumber } = fenInfo(fen);
  return turn === 'w' ? `${moveNumber}.` : `${moveNumber}...`;
}

// ---------------------------------------------------------------------------
// Evaluation helpers

/** Score from White's point of view: { cp } or { mate } -> "+0.34", "-1.20", "#3", "-#2" */
export function formatScore(score) {
  if (!score) return '?';
  if (score.mate != null) {
    if (score.mate === 0) return '#';
    return (score.mate > 0 ? '#' : '-#') + Math.abs(score.mate);
  }
  if (Math.abs(score.cp) >= 10000) return score.cp > 0 ? '#' : '-#'; // mate on the board
  const v = score.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '' : '') + v.toFixed(2);
}

/** Centipawns (any perspective) -> win chance 0..100 for that perspective (Lichess formula). */
export function winPercent(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/** Collapse a {cp|mate} score into a single centipawn number. */
export function scoreToCp(score) {
  if (!score) return 0;
  if (score.mate != null) {
    if (score.mate === 0) return -10000;
    return score.mate > 0 ? 10000 - score.mate * 10 : -10000 - score.mate * 10;
  }
  return score.cp;
}

export function moveAccuracy(winBefore, winAfter) {
  const drop = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

// ---------------------------------------------------------------------------
// Misc

export function randomInt(n) {
  return Math.floor(Math.random() * n);
}

export function pick(arr) {
  return arr[randomInt(arr.length)];
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Edit distance, used for "did you mean" suggestions. */
export function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function formatClock(ms) {
  if (ms == null) return '--:--';
  const neg = ms < 0;
  ms = Math.abs(ms);
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, '0');
  const body = h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (!h && total < 10) return (neg ? '-' : '') + `${pad(m)}:${pad(s)}.${Math.floor((ms % 1000) / 100)}`;
  return (neg ? '-' : '') + body;
}

/** Position key without move counters, for repetition/opening lookups. */
export function epd(fen) {
  return fen.split(/\s+/).slice(0, 4).join(' ');
}
