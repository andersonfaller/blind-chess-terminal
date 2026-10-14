// Board rendering for "peeks": a coloured unicode board, a plain ASCII board
// (friendlier to screen readers and copy/paste) and a "shadow" board that only
// shows which squares are occupied.
import { FILES, GLYPHS, NOTATION_LETTERS, listPieces, piecesToSpeech } from './chess-utils.js';

const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };

export function capturedPieces(chess) {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of chess.board()) for (const c of row) if (c && c.type !== 'k') count[c.color][c.type]++;
  const lost = { w: [], b: [] };
  for (const color of ['w', 'b']) {
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      const n = Math.max(0, START_COUNT[t] - count[color][t]);
      for (let i = 0; i < n; i++) lost[color].push(t);
    }
  }
  const val = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const material = (c) => Object.entries(count[c]).reduce((s, [t, n]) => s + val[t] * n, 0);
  return { lost, diff: material('w') - material('b') };
}

function letter(type, color, notation) {
  const l = type === 'p' ? 'P' : NOTATION_LETTERS[notation === 'pt' ? 'pt' : 'en'][type];
  return color === 'w' ? l : l.toLowerCase();
}

export function asciiBoard(chess, { flip = false, notation = 'en', shadow = false } = {}) {
  const rows = [];
  const border = '   +------------------------+';
  rows.push(border);
  const board = chess.board(); // board[0] = rank 8
  for (let i = 0; i < 8; i++) {
    const r = flip ? 7 - i : i;
    const cells = [];
    for (let j = 0; j < 8; j++) {
      const f = flip ? 7 - j : j;
      const c = board[r][f];
      if (!c) cells.push('.');
      else if (shadow) cells.push(c.color === 'w' ? 'o' : 'x');
      else cells.push(letter(c.type, c.color, notation));
    }
    rows.push(` ${8 - r} | ${cells.join('  ')} |`);
  }
  rows.push(border);
  const files = flip ? [...FILES].reverse() : FILES;
  rows.push('     ' + files.join('  '));
  return rows.join('\n');
}

/**
 * Build the board element.
 * opts: { flip, style: 'unicode'|'ascii'|'shadow', lastMove: {from,to}, notation, lang, side: [lines] }
 */
export function renderBoard(chess, opts = {}) {
  const { flip = false, style = 'unicode', lastMove = null, notation = 'en', lang = 'en', side = [], check = null } = opts;
  const wrap = document.createElement('div');
  wrap.className = 'board-block';

  const pieces = listPieces(chess);
  const label = `${lang === 'pt' ? 'Brancas' : 'White'}: ${piecesToSpeech(pieces.w, lang)}. ${lang === 'pt' ? 'Pretas' : 'Black'}: ${piecesToSpeech(pieces.b, lang)}.`;

  if (style === 'ascii') {
    const pre = document.createElement('pre');
    pre.className = 'ascii-board';
    pre.textContent = asciiBoard(chess, { flip, notation });
    pre.setAttribute('aria-label', label);
    wrap.appendChild(pre);
  } else {
    const grid = document.createElement('div');
    grid.className = 'board' + (style === 'shadow' ? ' shadow' : '');
    grid.setAttribute('role', 'img');
    grid.setAttribute('aria-label', label);
    const board = chess.board();
    for (let i = 0; i < 8; i++) {
      const r = flip ? 7 - i : i;
      const rank = document.createElement('span');
      rank.className = 'coord rank';
      rank.textContent = String(8 - r);
      grid.appendChild(rank);
      for (let j = 0; j < 8; j++) {
        const f = flip ? 7 - j : j;
        const sq = FILES[f] + (8 - r);
        const cell = document.createElement('span');
        cell.className = 'sq ' + ((r + f) % 2 === 0 ? 'light' : 'dark');
        if (lastMove && (sq === lastMove.from || sq === lastMove.to)) cell.classList.add('last');
        if (check && sq === check) cell.classList.add('check');
        const c = board[r][f];
        if (c) {
          const pc = document.createElement('span');
          pc.className = 'pc ' + c.color;
          if (style === 'shadow') pc.textContent = '●';
          else pc.textContent = GLYPHS.b[c.type] + '︎';
          cell.appendChild(pc);
        }
        grid.appendChild(cell);
      }
    }
    grid.appendChild(document.createElement('span'));
    const files = flip ? [...FILES].reverse() : FILES;
    for (const f of files) {
      const s = document.createElement('span');
      s.className = 'coord file';
      s.textContent = f;
      grid.appendChild(s);
    }
    wrap.appendChild(grid);
  }

  if (side.length) {
    const info = document.createElement('div');
    info.className = 'board-side';
    for (const l of side) {
      const d = document.createElement('div');
      if (typeof l === 'string') d.textContent = l;
      else {
        d.textContent = l.t;
        if (l.c) d.className = l.c;
      }
      info.appendChild(d);
    }
    wrap.appendChild(info);
  }
  return wrap;
}

export function capturedLine(chess) {
  const { lost, diff } = capturedPieces(chess);
  // Pieces White has captured are Black's lost pieces, and vice versa.
  const byWhite = lost.b.map((t) => GLYPHS.b[t]).join('');
  const byBlack = lost.w.map((t) => GLYPHS.w[t]).join('');
  return { byWhite, byBlack, diff };
}
