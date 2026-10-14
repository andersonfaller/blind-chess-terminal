// Opening identification by position (so transpositions are recognised).
import { OPENINGS } from './data/openings.js';
import { epd } from './chess-utils.js';

let index = null;

function build(ChessCtor) {
  index = new Map();
  for (const [eco, en, pt, moves] of OPENINGS) {
    const c = new ChessCtor();
    const list = moves.split(' ');
    for (const san of list) c.move(san);
    const key = epd(c.fen());
    const prev = index.get(key);
    // Keep the most specific (longest) name for a position.
    if (!prev || prev.plies < list.length) index.set(key, { eco, en, pt, moves, plies: list.length });
  }
}

/** Given the FENs of the game (after each ply), return the deepest known opening. */
export function identifyOpening(ChessCtor, fens) {
  if (!index) build(ChessCtor);
  let found = null;
  for (let i = 0; i < Math.min(fens.length, 40); i++) {
    const hit = index.get(epd(fens[i]));
    if (hit) found = hit;
  }
  return found;
}

export function openingName(op, lang) {
  if (!op) return null;
  return `${op.eco} ${lang === 'pt' ? op.pt : op.en}`;
}

export function openingLines() {
  return OPENINGS.map(([eco, en, pt, moves]) => ({ eco, en, pt, moves: moves.split(' ') }));
}
