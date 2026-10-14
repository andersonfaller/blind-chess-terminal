// A small alpha-beta engine written in plain JavaScript on top of chess.js.
// It is much weaker than Stockfish (roughly club level at its best), but it has
// zero dependencies and works offline in any browser, so it is the last line of
// the fallback chain and a nice opponent for beginners.

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;
const INF = 1e9;

// Piece-square tables (Tomasz Michniewski's "simplified evaluation function"),
// from White's point of view, index 0 = a8 ... 63 = h1.
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
  kEnd: [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
  ],
};

class Timeout extends Error {}

const SQ_NAMES = [];
for (let i = 0; i < 128; i++) {
  SQ_NAMES[i] = i & 0x88 ? null : 'abcdefgh'[i & 7] + (8 - (i >> 4));
}

const hasInternals = (c) =>
  typeof c._moves === 'function' && typeof c._makeMove === 'function' &&
  typeof c._undoMove === 'function' && typeof c._isKingAttacked === 'function' && Array.isArray(c._board);

/**
 * Search the position and return { bestmove, score: {cp}|{mate}, depth, nodes, pv }.
 * Scores are from the side to move.
 */
export function searchBest(ChessCtor, fen, { maxDepth = 3, timeMs = 1500, noise = 0, seed = Math.random() } = {}) {
  const chess = new ChessCtor(fen);
  if (!hasInternals(chess)) return publicApiFallback(chess);

  const deadline = Date.now() + timeMs;
  const seedInt = Math.floor(seed * 0xffff) | 0;
  let nodes = 0;

  const evaluate = () => {
    const board = chess._board;
    let mg = 0;
    let nonPawn = 0;
    let wk = -1;
    let bk = -1;
    for (let i = 0; i < 128; i++) {
      if (i & 0x88) { i += 7; continue; }
      const p = board[i];
      if (!p) continue;
      const row = i >> 4;
      const col = i & 7;
      const idx = p.color === 'w' ? row * 8 + col : (7 - row) * 8 + col;
      if (p.type === 'k') {
        if (p.color === 'w') wk = idx; else bk = idx;
        continue;
      }
      if (p.type !== 'p') nonPawn += VAL[p.type];
      const v = VAL[p.type] + PST[p.type][idx];
      mg += p.color === 'w' ? v : -v;
    }
    const endgame = nonPawn <= 2600;
    const kt = endgame ? PST.kEnd : PST.k;
    if (wk >= 0) mg += kt[wk];
    if (bk >= 0) mg -= kt[bk];
    let score = chess._turn === 'w' ? mg : -mg;
    if (noise) {
      // Deterministic per position within one search, so alpha-beta stays sane.
      const h = Number(BigInt.asUintN(16, chess._hash ?? 0n)) ^ seedInt;
      score += ((h * 2654435761) % 1000 / 1000 - 0.5) * 2 * noise;
    }
    return score;
  };

  const ordering = (m, pvMove) => {
    if (pvMove && m.from === pvMove.from && m.to === pvMove.to && m.promotion === pvMove.promotion) return 1e6;
    let s = 0;
    if (m.captured) s += 10 * VAL[m.captured] - VAL[m.piece] + 1000;
    if (m.promotion) s += VAL[m.promotion] + 800;
    return s;
  };

  const sortMoves = (moves, pvMove) => {
    const scored = moves.map((m) => [ordering(m, pvMove), m]);
    scored.sort((a, b) => b[0] - a[0]);
    return scored.map((x) => x[1]);
  };

  const quiesce = (alpha, beta, qdepth) => {
    nodes++;
    const standPat = evaluate();
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    if (qdepth >= 6) return alpha;
    const us = chess._turn;
    const caps = sortMoves(chess._moves({ legal: false }).filter((m) => m.captured || m.promotion));
    for (const m of caps) {
      chess._makeMove(m);
      if (chess._isKingAttacked(us)) { chess._undoMove(); continue; }
      const score = -quiesce(-beta, -alpha, qdepth + 1);
      chess._undoMove();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  };

  const negamax = (depth, alpha, beta, ply) => {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new Timeout();
    if (chess._halfMoves >= 100) return 0;
    const us = chess._turn;
    const inCheck = chess._isKingAttacked(us);
    if (inCheck && ply < 12) depth++;
    if (depth <= 0) return quiesce(alpha, beta, 0);
    const moves = sortMoves(chess._moves({ legal: false }));
    let legal = 0;
    let best = -INF;
    for (const m of moves) {
      chess._makeMove(m);
      if (chess._isKingAttacked(us)) { chess._undoMove(); continue; }
      legal++;
      const score = -negamax(depth - 1, -beta, -alpha, ply + 1);
      chess._undoMove();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    return best;
  };

  let rootMoves = chess._moves({ legal: true });
  if (!rootMoves.length) return { bestmove: null, score: { cp: 0 }, depth: 0, nodes: 0, pv: [] };

  let bestMove = rootMoves[0];
  let bestScore = -INF;
  let completedDepth = 0;
  for (let depth = 1; depth <= maxDepth; depth++) {
    try {
      rootMoves = sortMoves(rootMoves, bestMove);
      let alpha = -INF;
      let iterBest = null;
      let iterScore = -INF;
      for (const m of rootMoves) {
        chess._makeMove(m);
        const score = -negamax(depth - 1, -INF, -alpha, 1);
        chess._undoMove();
        if (score > iterScore) { iterScore = score; iterBest = m; }
        if (score > alpha) alpha = score;
      }
      bestMove = iterBest;
      bestScore = iterScore;
      completedDepth = depth;
      if (Math.abs(bestScore) > MATE - 100) break;
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
      // Unwind the moves that were in flight when time ran out.
      while (chess._history.length > 0) chess._undoMove();
      break;
    }
  }
  const uci = SQ_NAMES[bestMove.from] + SQ_NAMES[bestMove.to] + (bestMove.promotion || '');
  let score;
  if (Math.abs(bestScore) > MATE - 1000) {
    const plies = MATE - Math.abs(bestScore);
    const moves = Math.ceil(plies / 2);
    score = { mate: bestScore > 0 ? moves : -moves };
  } else {
    score = { cp: Math.round(bestScore === -INF ? 0 : bestScore) };
  }
  return { bestmove: uci, score, depth: completedDepth, nodes, pv: [uci] };
}

// Very slow path in case chess.js internals ever change: one-ply greedy search.
function publicApiFallback(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return { bestmove: null, score: { cp: 0 }, depth: 0, nodes: 0, pv: [] };
  let best = moves[0];
  let bestScore = -INF;
  for (const m of moves) {
    chess.move(m);
    let s = 0;
    if (chess.isCheckmate()) s = MATE;
    else if (m.captured) s = VAL[m.captured] * 10 - VAL[m.piece];
    if (m.promotion) s += VAL[m.promotion];
    s += Math.random();
    chess.undo();
    if (s > bestScore) { bestScore = s; best = m; }
  }
  const uci = best.from + best.to + (best.promotion || '');
  return { bestmove: uci, score: { cp: 0 }, depth: 1, nodes: moves.length, pv: [uci] };
}
