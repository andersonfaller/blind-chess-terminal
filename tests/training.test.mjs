import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js/chess.js';
import { normalizeSpoken } from '../js/speech.js';
import { parsePieceAnswer, checkPositionAnswer } from '../js/drills.js';
import { classifyMoves, summarize } from '../js/review.js';
import { PUZZLES } from '../js/data/puzzles.js';
import { parseLichessPuzzle } from '../js/puzzles.js';
import { searchBest } from '../js/engine/basic-search.js';
import { resolveLevel, LEVELS } from '../js/engine/manager.js';
import { parseInfo } from '../js/engine/stockfish-local.js';
import { parseMove } from '../js/chess-utils.js';

test('spoken moves are normalised', () => {
  assert.equal(normalizeSpoken('knight f3').compact, 'Nf3');
  assert.equal(normalizeSpoken('Knight to F 3').compact, 'Nf3');
  assert.equal(normalizeSpoken('bishop takes e5').compact, 'Bxe5');
  assert.equal(normalizeSpoken('e four').compact, 'e4');
  assert.equal(normalizeSpoken('echo four').compact, 'e4');
  assert.equal(normalizeSpoken('castles kingside').compact, 'O-O');
  assert.equal(normalizeSpoken('castle queen side').compact, 'O-O-O');
  assert.equal(normalizeSpoken('roque pequeno').compact, 'O-O');
  assert.equal(normalizeSpoken('Roque grande').compact, 'O-O-O');
  assert.equal(normalizeSpoken('cavalo f3').compact, 'Nf3');
  assert.equal(normalizeSpoken('Dama toma d7').compact, 'Qxd7');
  assert.equal(normalizeSpoken('torre para a 1').compact, 'Ra1');
  assert.equal(normalizeSpoken('e 8 promotes to queen').compact, 'e8=Q');
  assert.equal(normalizeSpoken('c 3 e 4 g 5').spaced, 'c3 e4 g5');
  // The result is understood by the move parser.
  const c = new Chess();
  assert.equal(parseMove(c, normalizeSpoken('knight f three').compact).move.san, 'Nf3');
});

test('piece answers in drills', () => {
  assert.deepEqual(parsePieceAnswer('knight'), { type: 'n', color: null });
  assert.deepEqual(parsePieceAnswer('white pawn'), { type: 'p', color: 'w' });
  assert.deepEqual(parsePieceAnswer('Dama preta'), { type: 'q', color: 'b' });
  assert.deepEqual(parsePieceAnswer('peão'), { type: 'p', color: null });
  assert.deepEqual(parsePieceAnswer('N'), { type: 'n', color: null });
  assert.deepEqual(parsePieceAnswer('vazio'), { empty: true });
  assert.equal(parsePieceAnswer('banana'), null);
  const what = { kind: 'what', sq: 'f3', piece: { type: 'n', color: 'w' }, answerText: '' };
  assert.equal(checkPositionAnswer('knight', what).ok, true);
  assert.equal(checkPositionAnswer('black knight', what).ok, false);
  assert.equal(checkPositionAnswer('empty', what).ok, false);
  const where = { kind: 'where', squares: ['c3', 'f3'], answerText: 'c3 f3' };
  assert.equal(checkPositionAnswer('f3 c3', where).ok, true);
  assert.equal(checkPositionAnswer('c3', where).ok, false);
  assert.equal(checkPositionAnswer('hmm', where).valid, false);
});

test('review classification', () => {
  const plies = [
    { color: 'w', uci: 'e2e4' },
    { color: 'b', uci: 'f7f6' },
    { color: 'w', uci: 'd1h5' },
  ];
  const evals = [
    { score: { cp: 20 }, best: 'e2e4' },
    { score: { cp: 25 }, best: 'e7e5' },
    { score: { cp: 120 }, best: 'd1h5' },
    { score: { cp: -300 } }, // White blundered
  ];
  const moves = classifyMoves(plies, evals);
  assert.equal(moves[0].kind, null);
  assert.equal(moves[0].best, true);
  assert.ok(['inaccuracy', 'mistake'].includes(moves[1].kind));
  assert.equal(moves[2].kind, 'blunder');
  const s = summarize(moves, 'w');
  assert.equal(s.blunders, 1);
  assert.equal(s.n, 2);
  assert.ok(s.accuracy < 70);
});

test('every built-in puzzle is a forced mate with a legal solution', () => {
  assert.ok(PUZZLES.length >= 150);
  const ids = new Set();
  for (const [id, fen, sol, mate, rating] of PUZZLES) {
    assert.ok(!ids.has(id));
    ids.add(id);
    const c = new Chess(fen);
    const moves = sol.split(' ');
    assert.equal(moves.length, mate * 2 - 1, id);
    for (const u of moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    assert.ok(c.isCheckmate(), `${id} ends in mate`);
    assert.ok(rating >= 800 && rating <= 2400);
  }
});

test('lichess puzzle payload is understood', () => {
  // Shape of https://lichess.org/api/puzzle/next (trimmed).
  const data = {
    game: { pgn: 'e4 e5 Bc4 Nc6 Qh5 Nf6' },
    puzzle: { id: 'abc12', rating: 900, initialPly: 5, solution: ['h5f7'], themes: ['mate', 'mateIn1', 'opening'] },
  };
  const p = parseLichessPuzzle(data);
  assert.equal(p.id, 'abc12');
  assert.equal(p.mate, 1);
  assert.equal(p.lastMove.san, 'Nf6');
  const c = new Chess(p.fen);
  c.move({ from: 'h5', to: 'f7' });
  assert.ok(c.isCheckmate());
});

test('built-in engine finds mates and returns legal moves', () => {
  for (const [, fen, sol, mate] of PUZZLES.filter((p) => p[3] === 1).slice(0, 10)) {
    const r = searchBest(Chess, fen, { maxDepth: 2, timeMs: 2000 });
    const c = new Chess(fen);
    c.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: r.bestmove[4] });
    assert.ok(c.isCheckmate(), `${fen}: ${r.bestmove} (expected ${sol})`);
    assert.equal(r.score.mate, mate);
  }
  const r = searchBest(Chess, new Chess().fen(), { maxDepth: 3, timeMs: 1000, noise: 50 });
  assert.ok(new Chess().moves({ verbose: true }).some((m) => m.from + m.to === r.bestmove));
});

test('levels and UCI parsing', () => {
  assert.equal(resolveLevel(5).ucielo, 1400);
  assert.equal(resolveLevel(99).level, 10);
  assert.equal(resolveLevel(5, 1750).ucielo, 1750);
  assert.equal(resolveLevel(5, 900).ucielo, 1320); // clamped to Stockfish's range
  assert.ok(Object.keys(LEVELS).length === 10);
  const info = parseInfo('info depth 18 seldepth 25 multipv 2 score cp -34 nodes 123 nps 4 pv e7e5 g1f3 b8c6');
  assert.deepEqual(info.score, { cp: -34 });
  assert.equal(info.multipv, 2);
  assert.deepEqual(info.pv, ['e7e5', 'g1f3', 'b8c6']);
  assert.deepEqual(parseInfo('info depth 5 score mate -3 pv a1a2').score, { mate: -3 });
  assert.equal(parseInfo('info depth 9 score cp 10 lowerbound pv e2e4').bound, true);
});
