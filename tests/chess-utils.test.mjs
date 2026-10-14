import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js/chess.js';
import {
  parseMove, sanToLocal, sanToSpeech, squareColor, sameDiagonal, knightPath, knightDistance,
  movesToText, formatScore, winPercent, listPieces, piecesToText, formatClock, moveLabel, isKnightMove,
} from '../js/chess-utils.js';

const san = (fen, input, opts) => {
  const r = parseMove(new Chess(fen), input, opts);
  return r.ok ? r.move.san : r.error;
};
const START = undefined;

test('parses SAN, UCI and sloppy forms', () => {
  assert.equal(san(START, 'e4'), 'e4');
  assert.equal(san(START, 'E4'), 'e4');
  assert.equal(san(START, 'Nf3'), 'Nf3');
  assert.equal(san(START, 'nf3'), 'Nf3');
  assert.equal(san(START, 'g1f3'), 'Nf3');
  assert.equal(san(START, 'g1-f3'), 'Nf3');
  assert.equal(san(START, 'G1F3'), 'Nf3');
  assert.equal(san(START, 'e2 e4'), 'e4');
  assert.equal(san(START, 'Ng1f3'), 'Nf3');
  assert.equal(san(START, '♘f3'), 'Nf3');
  assert.equal(san(START, 'e4!?'), 'e4');
});

test('reports syntax / illegal / ambiguous', () => {
  assert.equal(san(START, 'hello'), 'syntax');
  assert.equal(san(START, 'e5'), 'illegal');
  assert.equal(san(START, 'Nf6'), 'illegal');
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
  // Only one knight can reach d2? No: both b1 and f3 can.
  const r = parseMove(new Chess(fen), 'Nd2');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'illegal'); // d2 is occupied by a pawn
  const fen2 = '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1';
  const r2 = parseMove(new Chess(fen2), 'Nd2');
  assert.equal(r2.error, 'ambiguous');
  assert.deepEqual(r2.candidates.sort(), ['Nbd2', 'Nfd2']);
  assert.equal(san(fen2, 'Nbd2'), 'Nbd2');
  assert.equal(san(fen2, 'b1d2'), 'Nbd2');
});

test('captures with or without x, pawn captures, en passant', () => {
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2';
  assert.equal(san(fen, 'exd5'), 'exd5');
  assert.equal(san(fen, 'ed5'), 'exd5');
  assert.equal(san(fen, 'e4d5'), 'exd5');
  const ep = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
  assert.equal(san(ep, 'exf6'), 'exf6');
  assert.equal(san(ep, 'exf6 e.p.'), 'exf6');
});

test('castling in every spelling', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  for (const s of ['O-O', '0-0', 'o-o', 'OO', 'e1g1']) assert.equal(san(fen, s), 'O-O', s);
  for (const s of ['O-O-O', '0-0-0', 'ooo', 'e1c1']) assert.equal(san(fen, s), 'O-O-O', s);
  assert.equal(san(START, 'O-O'), 'illegal');
});

test('promotions', () => {
  const fen = '7k/4P3/8/8/8/8/6K1/8 w - - 0 1';
  assert.equal(san(fen, 'e8=Q'), 'e8=Q+');
  assert.equal(san(fen, 'e8q'), 'e8=Q+');
  assert.equal(san(fen, 'e8=N'), 'e8=N');
  assert.equal(san(fen, 'e7e8n'), 'e8=N');
  const r = parseMove(new Chess(fen), 'e8');
  assert.equal(r.ok, true);
  assert.equal(r.autoQueen, true);
  assert.equal(r.move.promotion, 'q');
  assert.equal(san(fen, 'e8=D', { notation: 'pt' }), 'e8=Q+');
  assert.equal(san(fen, 'e8t', { notation: 'pt' }), 'e8=R+');
});

test('portuguese notation', () => {
  const opts = { notation: 'pt' };
  assert.equal(san(START, 'Cf3', opts), 'Nf3');
  assert.equal(san(START, 'cf3', opts), 'illegal'); // c-pawn cannot reach f3
  assert.equal(san(START, 'c4', opts), 'c4');
  assert.equal(san(START, 'D4', opts), 'd4');
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  assert.equal(san(fen, 'Rf1', opts), 'Kf1');
  assert.equal(san(fen, 'Tb1', opts), 'Rb1');
  assert.equal(sanToLocal('Nxe5+', 'pt'), 'Cxe5+');
  assert.equal(sanToLocal('Kf1', 'pt'), 'Rf1');
  assert.equal(sanToLocal('Rb1', 'pt'), 'Tb1');
  assert.equal(sanToLocal('e8=Q', 'pt'), 'e8=D');
  assert.equal(sanToLocal('O-O', 'pt'), 'O-O');
});

test('speech', () => {
  assert.equal(sanToSpeech('Nxe5+'), 'Knight takes E 5, check');
  assert.equal(sanToSpeech('Nxe5+', 'en', { captured: 'b' }), 'Knight takes bishop on E 5, check');
  assert.equal(sanToSpeech('exd5'), 'E takes D 5');
  assert.equal(sanToSpeech('O-O-O#', 'en'), 'Castles queenside, checkmate');
  assert.equal(sanToSpeech('e8=Q', 'en'), 'E 8 promotes to queen');
  assert.equal(sanToSpeech('Rad1', 'en'), 'Rook A D 1');
  assert.equal(sanToSpeech('Cxe5+', 'pt'), 'Cxe5+'); // input is always English SAN
  assert.equal(sanToSpeech('Nxe5+', 'pt'), 'Cavalo toma é 5, xeque');
  assert.equal(sanToSpeech('O-O', 'pt'), 'Roque pequeno');
});

test('geometry', () => {
  assert.equal(squareColor('a1'), 'dark');
  assert.equal(squareColor('h1'), 'light');
  assert.equal(squareColor('d1'), 'light');
  assert.equal(squareColor('e1'), 'dark');
  assert.equal(squareColor('f6'), 'dark');
  assert.ok(sameDiagonal('c1', 'h6'));
  assert.ok(sameDiagonal('a8', 'h1'));
  assert.ok(!sameDiagonal('c1', 'h5'));
  assert.equal(knightDistance('a1', 'h8'), 6);
  assert.equal(knightDistance('g1', 'f3'), 1);
  assert.equal(knightDistance('a1', 'b2'), 4);
  const p = knightPath('b1', 'h7');
  assert.equal(p[0], 'b1');
  assert.equal(p.at(-1), 'h7');
  for (let i = 1; i < p.length; i++) assert.ok(isKnightMove(p[i - 1], p[i]));
});

test('formatting', () => {
  assert.equal(movesToText(['e4', 'e5', 'Nf3']), '1. e4 e5 2. Nf3');
  assert.equal(movesToText(['Nf6', 'Nc3'], 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'), '1... Nf6 2. Nc3');
  assert.equal(movesToText(['Nf3', 'Nf6'], undefined, 'pt'), '1. Cf3 Cf6');
  assert.equal(formatScore({ cp: 34 }), '+0.34');
  assert.equal(formatScore({ cp: -120 }), '-1.20');
  assert.equal(formatScore({ mate: 3 }), '#3');
  assert.equal(formatScore({ mate: -2 }), '-#2');
  assert.equal(Math.round(winPercent(0)), 50);
  assert.ok(winPercent(300) > 70);
  assert.equal(formatClock(65_000), '01:05');
  assert.equal(formatClock(3_725_000), '1:02:05');
  assert.equal(formatClock(9_400), '00:09.4');
  assert.equal(moveLabel(new Chess().fen()), '1.');
  const pieces = listPieces(new Chess());
  const t = piecesToText(pieces.w);
  assert.deepEqual(t.officers, ['Ke1', 'Qd1', 'Ra1', 'Rh1', 'Bc1', 'Bf1', 'Nb1', 'Ng1']);
  assert.equal(t.pawns.length, 8);
});
