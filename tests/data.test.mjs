import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js/chess.js';
import { OPENINGS } from '../js/data/openings.js';
import { identifyOpening } from '../js/openings.js';

test('every opening line is legal', () => {
  for (const [eco, en, pt, moves] of OPENINGS) {
    const c = new Chess();
    for (const san of moves.split(' ')) {
      assert.doesNotThrow(() => c.move(san), `${eco} ${en}: ${san} in "${moves}"`);
    }
    assert.ok(en && pt && /^[A-E]\d\d$/.test(eco));
  }
});

test('identifies openings, including transpositions', () => {
  const play = (moves) => {
    const c = new Chess();
    const fens = [];
    for (const m of moves.split(' ')) { c.move(m); fens.push(c.fen()); }
    return identifyOpening(Chess, fens);
  };
  assert.equal(play('e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3').en, 'Sicilian Defense: Najdorf Variation');
  assert.equal(play('e4 e5 Nf3 Nc6 Bb5 a6').en, 'Ruy Lopez: Morphy Defense');
  // An English move order that transposes into the Nimzo-Indian.
  assert.equal(play('c4 e6 Nc3 Nf6 d4 Bb4').en, 'Nimzo-Indian Defense');
  assert.equal(play('e4 e5 Ke2').pt, 'Ataque Bongcloud');
});
