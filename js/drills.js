// Blindfold training drills.
import { Chess } from '../vendor/chess.js/chess.js';
import { t, getLang } from './i18n.js';
import {
  ALL_SQUARES, squareColor, sameDiagonal, knightPath, isKnightMove, sqToXY, xyToSq, onBoard,
  pick, squareToSpeech, PIECE_NAMES, PIECE_NAMES_PLURAL, COLOR_NAMES,
  movesToText, sanToSpeech, stripAccents, listPieces,
} from './chess-utils.js';
import { openingLines } from './openings.js';
import { searchBest } from './engine/basic-search.js';
import { PUZZLES } from './data/puzzles.js';
import { renderBoard } from './board-view.js';

const norm = (s) => stripAccents(String(s).toLowerCase()).trim();

const LIGHT_WORDS = ['light', 'l', 'claro', 'clara', 'c', 'white', 'w', 'branca', 'branco'];
const DARK_WORDS = ['dark', 'd', 'escuro', 'escura', 'e', 'black', 'preta', 'preto', 'p'];
const YES = ['yes', 'y', 'sim', 's', 'true', 'yeah', 'yep', 'si'];
const NO = ['no', 'n', 'nao', 'false', 'nope'];
const EMPTY_WORDS = ['empty', 'none', 'nothing', '-', 'vazio', 'vazia', 'nada', 'nenhum', 'nenhuma', '0', 'free', 'livre'];
const WHITE_WORDS = ['white', 'branca', 'branco', 'brancas', 'brancos', 'w'];
const BLACK_WORDS = ['black', 'preta', 'preto', 'pretas', 'pretos'];

export const DRILL_KINDS = ['colors', 'diagonals', 'knight', 'visualize', 'memory'];
export const DRILL_ALIASES = {
  colors: 'colors', color: 'colors', cores: 'colors', cor: 'colors', squares: 'colors', casas: 'colors',
  diagonals: 'diagonals', diagonal: 'diagonals', diag: 'diagonals', diagonais: 'diagonals',
  knight: 'knight', knights: 'knight', cavalo: 'knight', cavalos: 'knight', horse: 'knight',
  visualize: 'visualize', visualise: 'visualize', vis: 'visualize', follow: 'visualize', visualizar: 'visualize', seguir: 'visualize', moves: 'visualize', lances: 'visualize',
  memory: 'memory', mem: 'memory', memoria: 'memory', memorize: 'memory', memorizar: 'memory',
};

const DEFAULT_TOTAL = { colors: 20, diagonals: 15, knight: 10, visualize: 8, memory: 8 };

export function createDrill(app, kind, opts = {}) {
  const total = opts.total || DEFAULT_TOTAL[kind];
  switch (kind) {
    case 'colors': return new ColorsDrill(app, total);
    case 'diagonals': return new DiagonalDrill(app, total);
    case 'knight': return new KnightDrill(app, total);
    case 'visualize': return new VisualizeDrill(app, total, opts.difficulty || 'normal');
    case 'memory': return new MemoryDrill(app, total, opts.difficulty || 'normal');
    default: return null;
  }
}

class Drill {
  constructor(app, kind, total) {
    this.app = app;
    this.name = 'drill';
    this.kind = kind;
    this.total = Math.max(1, Math.min(200, total));
    this.index = 0;
    this.correct = 0;
    this.times = [];
    this.streak = 0;
    this.bestStreak = 0;
    this.current = null;
    this.finished = false;
    this.startedAt = Date.now();
  }

  title() { return t(`drill.${this.kind}.title`); }

  start() {
    const app = this.app;
    app.term.printNode(app.ui.card(`🎯 ${this.title()}`, [
      t(`drill.${this.kind}.intro`),
      { t: t('drill.howToStop'), c: 'dim' },
    ], { cls: 'drill' }), { forceScroll: true });
    app.sound.play('start');
    this.next();
  }

  next() {
    if (this.finished) return;
    if (this.index >= this.total) {
      this.finish();
      return;
    }
    this.index++;
    this.current = this.makeQuestion();
    this.askedAt = Date.now();
    this.present();
    this.app.refresh();
  }

  present() {
    const q = this.current;
    this.app.term.print([{ t: `[${this.index}/${this.total}] `, c: 'num' }, { t: q.text, c: 'hl' }]);
    if (q.speech) this.app.say(q.speech);
  }

  input(text) {
    if (this.finished || !this.current) return false;
    const res = this.check(text, this.current);
    if (!res || !res.valid) {
      this.app.term.print(t(`drill.${this.kind}.format`), 'warn');
      return true;
    }
    const dt = Date.now() - this.askedAt;
    this.times.push(dt);
    const secs = (dt / 1000).toFixed(1) + 's';
    if (res.ok) {
      this.correct++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      this.app.term.print([{ t: '✓ ', c: 'ok' }, res.feedback || t('drill.correct'), { t: `  ${secs}`, c: 'dim' }], 'ok-line');
      this.app.sound.play('correct');
    } else {
      this.streak = 0;
      this.app.term.print([{ t: '✗ ', c: 'err' }, res.feedback || t('drill.wrong'), { t: `  ${secs}`, c: 'dim' }], 'err-line');
      this.app.sound.play('wrong');
      if (res.speech) this.app.say(res.speech);
    }
    this.afterAnswer();
    return true;
  }

  afterAnswer() {
    this.next();
  }

  skip() {
    if (this.finished || !this.current) return;
    this.times.push(Date.now() - this.askedAt);
    this.streak = 0;
    this.app.term.print([{ t: '↷ ', c: 'warn' }, this.reveal(this.current)], 'dim');
    this.afterAnswer();
  }

  reveal(q) { return t('drill.answerWas', { answer: q.answerText }); }

  finish() {
    this.finished = true;
    const app = this.app;
    const answered = this.times.length;
    const avg = answered ? this.times.reduce((a, b) => a + b, 0) / answered : 0;
    const total = (Date.now() - this.startedAt) / 1000;
    const pct = Math.round((this.correct / this.total) * 100);
    const prev = app.stats.drillBest(this.kind);
    const rec = app.stats.recordDrill(this.kind, { correct: this.correct, total: this.total, avgMs: Math.round(avg) });
    const rows = [
      [t('drill.summary.score'), { t: `${this.correct}/${this.total} (${pct}%)`, c: pct === 100 ? 'ok' : pct >= 70 ? 'accent' : 'warn' }],
      [t('drill.summary.avg'), `${(avg / 1000).toFixed(2)}s`],
      [t('drill.summary.time'), `${total.toFixed(0)}s`],
      [t('drill.summary.streak'), String(this.bestStreak)],
      prev ? [t('drill.summary.best'), `${prev.correct}/${prev.total} · ${(prev.avgMs / 1000).toFixed(2)}s`] : null,
    ];
    if (rec.newBest) rows.push({ t: '🏅 ' + t('drill.summary.newBest'), c: 'ok' });
    app.term.printNode(app.ui.card(`🎯 ${this.title()} — ${t('drill.summary.title')}`, rows, { cls: 'drill' }), { forceScroll: true });
    app.term.print([t('drill.again.pre'), { t: `drill ${this.kind}`, cmd: `drill ${this.kind}`, run: true }, t('drill.again.mid'), { t: 'train', cmd: 'train', run: true }], 'dim');
    app.sound.play(pct === 100 ? 'win' : 'end');
    app.say(t('drill.summary.speech', { correct: this.correct, total: this.total }));
    app.checkAchievements({ type: 'drill', kind: this.kind, correct: this.correct, total: this.total, avgMs: avg });
    app.endMode(this);
  }

  stop() {
    if (!this.finished) {
      this.finished = true;
      this.app.term.print(t('drill.stopped', { correct: this.correct, n: this.times.length }), 'dim');
    }
  }

  prompt() {
    return this.current && this.current.prompt ? `${this.current.prompt} ❯` : `${this.index}/${this.total} ❯`;
  }

  status() {
    return [
      { t: '🎯 ' + this.title(), c: 'hl' },
      { t: `${this.index}/${this.total}` },
      { t: `✓ ${this.correct}`, c: 'ok' },
      this.streak >= 3 ? { t: `🔥 ${this.streak}`, c: 'accent' } : null,
    ].filter(Boolean);
  }

  quickAnswers() { return []; }

  actions() {
    return [...this.quickAnswers(), { label: 'skip', cmd: 'skip' }, { label: 'stop', cmd: 'stop' }];
  }
}

// --- 1. Square colours --------------------------------------------------------------

class ColorsDrill extends Drill {
  constructor(app, total) { super(app, 'colors', total); this.last = null; }

  makeQuestion() {
    let sq;
    do { sq = pick(ALL_SQUARES); } while (sq === this.last);
    this.last = sq;
    const color = squareColor(sq);
    return {
      sq, color, text: t('drill.colors.q', { sq }), prompt: sq,
      speech: squareToSpeech(sq, getLang()), answerText: `${sq} ${t('drill.colors.' + color)}`,
    };
  }

  check(text, q) {
    const a = norm(text);
    let ans = null;
    if (LIGHT_WORDS.includes(a)) ans = 'light';
    else if (DARK_WORDS.includes(a)) ans = 'dark';
    if (!ans) return { valid: false };
    const ok = ans === q.color;
    return { valid: true, ok, feedback: t('drill.colors.fb', { sq: q.sq, color: t('drill.colors.' + q.color) }) };
  }

  quickAnswers() {
    return [{ label: t('drill.colors.light'), cmd: t('drill.colors.light'), c: 'answer' }, { label: t('drill.colors.dark'), cmd: t('drill.colors.dark'), c: 'answer' }];
  }
}

// --- 2. Diagonals ----------------------------------------------------------------

class DiagonalDrill extends Drill {
  constructor(app, total) { super(app, 'diagonals', total); }

  makeQuestion() {
    const a = pick(ALL_SQUARES);
    const [x, y] = sqToXY(a);
    let b;
    const wantTrue = Math.random() < 0.5;
    if (wantTrue) {
      const cands = [];
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        for (let k = 2; k < 8; k++) if (onBoard(x + dx * k, y + dy * k)) cands.push(xyToSq(x + dx * k, y + dy * k));
      }
      b = cands.length ? pick(cands) : null;
    }
    if (!b) {
      // Same colour but not on a diagonal: the tricky case.
      const cands = ALL_SQUARES.filter((s) => s !== a && squareColor(s) === squareColor(a) && !sameDiagonal(a, s));
      b = pick(cands);
    }
    const yes = sameDiagonal(a, b);
    return {
      a, b, yes, prompt: `${a}-${b}`,
      text: t('drill.diagonals.q', { a, b }),
      speech: t('drill.diagonals.speech', { a: squareToSpeech(a, getLang()), b: squareToSpeech(b, getLang()) }),
      answerText: yes ? t('drill.yes') : t('drill.no'),
    };
  }

  check(text, q) {
    const a = norm(text);
    let ans = null;
    if (YES.includes(a)) ans = true;
    else if (NO.includes(a)) ans = false;
    if (ans === null) return { valid: false };
    const ok = ans === q.yes;
    return { valid: true, ok, feedback: t(q.yes ? 'drill.diagonals.fbYes' : 'drill.diagonals.fbNo', { a: q.a, b: q.b }) };
  }

  quickAnswers() {
    return [{ label: t('drill.yes'), cmd: t('drill.yes'), c: 'answer' }, { label: t('drill.no'), cmd: t('drill.no'), c: 'answer' }];
  }
}

// --- 3. Knight routes ---------------------------------------------------------------

class KnightDrill extends Drill {
  constructor(app, total) { super(app, 'knight', total); }

  makeQuestion() {
    let a, b, path;
    do {
      a = pick(ALL_SQUARES);
      b = pick(ALL_SQUARES);
      path = knightPath(a, b);
    } while (a === b || path.length - 1 < 2 || path.length - 1 > 5);
    const n = path.length - 1;
    return {
      a, b, n, path, prompt: `♘${a}→${b}`,
      text: t('drill.knight.q', { a, b }),
      speech: t('drill.knight.speech', { a: squareToSpeech(a, getLang()), b: squareToSpeech(b, getLang()) }),
      answerText: `${n} — ${path.join(' ')}`,
    };
  }

  check(text, q) {
    const a = norm(text);
    const squares = a.match(/[a-h][1-8]/g) || [];
    const num = a.match(/^\d+$/) ? parseInt(a, 10) : null;
    if (!squares.length && num == null) return { valid: false };
    const sample = q.path.join(' → ');
    if (!squares.length) {
      const ok = num === q.n;
      return { valid: true, ok, feedback: t('drill.knight.fb', { n: q.n, path: sample }) };
    }
    let route = squares.slice();
    if (route[0] !== q.a) route.unshift(q.a);
    if (route[route.length - 1] !== q.b) {
      return { valid: true, ok: false, feedback: t('drill.knight.notReaching', { b: q.b, path: sample }) };
    }
    for (let i = 1; i < route.length; i++) {
      if (!isKnightMove(route[i - 1], route[i])) {
        return { valid: true, ok: false, feedback: t('drill.knight.badHop', { from: route[i - 1], to: route[i], path: sample }) };
      }
    }
    const hops = route.length - 1;
    if (hops > q.n) return { valid: true, ok: false, feedback: t('drill.knight.tooLong', { hops, n: q.n, path: sample }) };
    return { valid: true, ok: true, feedback: t('drill.knight.fbPath', { n: q.n, path: route.join(' → ') }) };
  }
}

// --- shared position questions ---------------------------------------------------------

function parsePieceAnswer(text) {
  const a = norm(text).replace(/[.!]/g, '');
  if (EMPTY_WORDS.includes(a)) return { empty: true };
  const words = a.split(/\s+/).filter(Boolean);
  let color = null;
  let type = null;
  for (const w of words) {
    if (WHITE_WORDS.includes(w)) { color = 'w'; continue; }
    if (BLACK_WORDS.includes(w)) { color = 'b'; continue; }
    const tp = pieceFromWord(w);
    if (tp) type = tp;
  }
  if (!type) return null;
  return { type, color };
}

const LETTERS = { k: 'k', q: 'q', r: 'r', b: 'b', n: 'n', p: 'p', d: 'q', t: 'r', c: 'n' };

function pieceFromWord(w) {
  for (const lang of ['en', 'pt']) {
    for (const [tp, name] of Object.entries(PIECE_NAMES[lang])) if (norm(name) === w) return tp;
    for (const [tp, name] of Object.entries(PIECE_NAMES_PLURAL[lang])) if (norm(name) === w) return tp;
  }
  const extra = { horse: 'n', cavaleiro: 'n', rainha: 'q', pawns: 'p', peao: 'p', peoes: 'p', kings: 'k' };
  if (extra[w]) return extra[w];
  if (w.length === 1 && LETTERS[w]) return LETTERS[w];
  return null;
}

function describePiece(p) {
  if (!p) return t('drill.pos.empty');
  const lang = getLang();
  return lang === 'pt'
    ? `${PIECE_NAMES.pt[p.type]} ${p.color === 'w' ? (p.type === 'k' || p.type === 'p' || p.type === 'n' || p.type === 'b' ? 'branco' : 'branca') : (p.type === 'k' || p.type === 'p' || p.type === 'n' || p.type === 'b' ? 'preto' : 'preta')}`
    : `${COLOR_NAMES.en[p.color]} ${PIECE_NAMES.en[p.type]}`;
}

/** Make a "what is on X?" or "where is Y?" question about a position. */
function positionQuestion(chess, { focus = [], avoid = new Set() } = {}) {
  const pieces = listPieces(chess);
  const all = [...pieces.w.map((p) => ({ ...p, color: 'w' })), ...pieces.b.map((p) => ({ ...p, color: 'b' }))];
  const lang = getLang();
  const askWhere = Math.random() < 0.45;
  if (askWhere) {
    // Prefer non-pawn pieces with one or two copies.
    const groups = {};
    for (const p of all) {
      if (p.type === 'p') continue;
      const key = p.color + p.type;
      (groups[key] = groups[key] || []).push(p.square);
    }
    const keys = Object.keys(groups).filter((k) => groups[k].length <= 2 && !avoid.has('where' + k));
    const focused = keys.filter((k) => groups[k].some((s) => focus.includes(s)));
    const key = pick(focused.length && Math.random() < 0.7 ? focused : keys.length ? keys : Object.keys(groups));
    if (key) {
      avoid.add('where' + key);
      const color = key[0];
      const type = key[1];
      const squares = groups[key].sort();
      const plural = squares.length > 1;
      const pieceName = plural ? PIECE_NAMES_PLURAL[lang][type] : PIECE_NAMES[lang][type];
      const colorName = colorAdj(color, type, plural);
      return {
        kind: 'where', squares,
        text: t(plural ? 'drill.pos.whereMany' : 'drill.pos.whereOne', { piece: pieceName, color: colorName }),
        prompt: t('drill.pos.wherePrompt'),
        answerText: squares.join(' '),
      };
    }
  }
  // "What is on X?" — mostly occupied squares, preferring ones that changed.
  let sq;
  const occupied = all.map((p) => p.square).filter((s) => !avoid.has('what' + s));
  const focusOcc = occupied.filter((s) => focus.includes(s));
  if (Math.random() < 0.15) {
    const empties = ALL_SQUARES.filter((s) => !chess.get(s) && !avoid.has('what' + s));
    const focusEmpty = empties.filter((s) => focus.includes(s));
    sq = pick(focusEmpty.length ? focusEmpty : empties);
  } else {
    sq = pick(focusOcc.length && Math.random() < 0.75 ? focusOcc : occupied);
  }
  avoid.add('what' + sq);
  const piece = chess.get(sq) || null;
  return {
    kind: 'what', sq, piece,
    text: t('drill.pos.what', { sq }),
    prompt: `${sq}?`,
    answerText: `${sq}: ${describePiece(piece)}`,
  };
}

function colorAdj(color, type, plural) {
  if (getLang() !== 'pt') return COLOR_NAMES.en[color];
  const masc = ['k', 'p', 'n', 'b'].includes(type);
  const base = color === 'w' ? (masc ? 'branco' : 'branca') : (masc ? 'preto' : 'preta');
  return plural ? base + 's' : base;
}

function checkPositionAnswer(text, q) {
  if (q.kind === 'where') {
    const a = norm(text);
    const squares = [...new Set(a.match(/[a-h][1-8]/g) || [])].sort();
    if (!squares.length) {
      if (EMPTY_WORDS.includes(a)) return { valid: true, ok: q.squares.length === 0, feedback: t('drill.pos.whereFb', { squares: q.answerText }) };
      return { valid: false };
    }
    const ok = squares.join(' ') === q.squares.join(' ');
    return { valid: true, ok, feedback: t('drill.pos.whereFb', { squares: q.answerText }) };
  }
  const ans = parsePieceAnswer(text);
  if (!ans) return { valid: false };
  let ok;
  if (ans.empty) ok = !q.piece;
  else ok = !!q.piece && q.piece.type === ans.type && (!ans.color || ans.color === q.piece.color);
  return { valid: true, ok, feedback: q.answerText };
}

// --- 4. Follow the moves -----------------------------------------------------------------

const PLIES = { easy: 4, normal: 8, hard: 14 };

function randomSequence(plies) {
  const lines = openingLines();
  const line = pick(lines);
  const c = new Chess();
  const sans = [];
  for (const san of line.moves.slice(0, plies)) sans.push(c.move(san).san);
  while (sans.length < plies && !c.isGameOver()) {
    const r = searchBest(Chess, c.fen(), { maxDepth: 2, timeMs: 120, noise: 45, seed: Math.random() });
    if (!r.bestmove) break;
    sans.push(c.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: r.bestmove[4] }).san);
  }
  return { chess: c, sans };
}

class VisualizeDrill extends Drill {
  constructor(app, total, difficulty) {
    super(app, 'visualize', total);
    this.difficulty = PLIES[difficulty] ? difficulty : 'normal';
    this.seq = null;
    this.perSeq = 2;
    this.asked = 0;
    this.avoid = new Set();
  }

  makeQuestion() {
    if (!this.seq || this.asked >= this.perSeq) {
      this.seq = randomSequence(PLIES[this.difficulty]);
      this.asked = 0;
      this.avoid = new Set();
      this.newSeq = true;
      const hist = this.seq.chess.history({ verbose: true });
      this.focus = [...new Set(hist.flatMap((m) => [m.from, m.to]))];
    } else {
      this.newSeq = false;
    }
    this.asked++;
    return positionQuestion(this.seq.chess, { focus: this.focus, avoid: this.avoid });
  }

  present() {
    const app = this.app;
    if (this.newSeq) {
      const notation = app.settings.get('notation');
      app.term.print(t('drill.visualize.seq'), 'dim');
      app.term.print(movesToText(this.seq.sans, null, notation), 'moves-line');
      const lang = getLang();
      app.say(this.seq.sans.map((s) => sanToSpeech(s, lang)).join('. '));
    }
    const q = this.current;
    app.term.print([{ t: `[${this.index}/${this.total}] `, c: 'num' }, { t: q.text, c: 'hl' }]);
    if (!this.newSeq) app.say(q.text, { interrupt: false });
  }

  check(text, q) { return checkPositionAnswer(text, q); }

  afterAnswer() {
    if (this.asked >= this.perSeq && this.seq) {
      // All questions about this sequence answered: its board may now be seen.
      this.revealable = this.seq.chess;
      this.app.term.print([t('drill.visualize.seeBoard.pre'), { t: 'board', cmd: 'board', run: true }], 'dim');
    }
    this.next();
  }

  boardForPeek() {
    return this.revealable || null;
  }

  quickAnswers() {
    return this.current && this.current.kind === 'what' ? [{ label: t('drill.pos.emptyWord'), cmd: t('drill.pos.emptyWord'), c: 'answer' }] : [];
  }
}

// --- 5. Position memory -----------------------------------------------------------------

const SHOW_SECONDS = { easy: 15, normal: 10, hard: 6 };

class MemoryDrill extends Drill {
  constructor(app, total, difficulty) {
    super(app, 'memory', total);
    this.difficulty = SHOW_SECONDS[difficulty] ? difficulty : 'normal';
    this.perPos = 4;
    this.asked = 0;
    this.phase = 'idle';
    this.chess = null;
    this.avoid = new Set();
  }

  acceptsEmpty() { return this.phase === 'memorize'; }

  next() {
    if (this.finished) return;
    if (this.index >= this.total) return this.finish();
    if (!this.chess || this.asked >= this.perPos) {
      this.showPosition();
      return;
    }
    super.next();
  }

  showPosition() {
    const app = this.app;
    const maxPieces = { easy: 6, normal: 9, hard: 12 }[this.difficulty];
    const pool = PUZZLES.filter((p) => p[1].split(' ')[0].replace(/[^a-zA-Z]/g, '').length <= maxPieces);
    const p = pick(pool);
    this.chess = new Chess(p[1]);
    this.asked = 0;
    this.avoid = new Set();
    this.phase = 'memorize';
    const secs = SHOW_SECONDS[this.difficulty];
    app.term.print(t('drill.memory.look', { s: secs }), 'hl');
    const board = renderBoard(this.chess, { style: 'unicode', lang: getLang(), notation: app.settings.get('notation') });
    this.boardEl = board;
    app.term.printNode(board, { forceScroll: true });
    const counter = app.term.print(t('drill.memory.countdown', { s: secs }), 'dim');
    let left = secs;
    this.timer = setInterval(() => {
      left--;
      if (left <= 0) this.hide();
      else counter.textContent = t('drill.memory.countdown', { s: left });
    }, 1000);
    this.counterEl = counter;
    app.refresh();
  }

  hide() {
    if (this.phase !== 'memorize') return;
    clearInterval(this.timer);
    this.phase = 'ask';
    if (this.boardEl) this.boardEl.classList.add('board-hidden');
    if (this.counterEl) this.counterEl.textContent = t('drill.memory.hidden');
    super.next();
  }

  makeQuestion() {
    this.asked++;
    return positionQuestion(this.chess, { avoid: this.avoid });
  }

  check(text, q) { return checkPositionAnswer(text, q); }

  input(text) {
    if (this.phase === 'memorize') {
      this.hide();
      return true;
    }
    return super.input(text);
  }

  afterAnswer() {
    if (this.asked >= this.perPos && this.boardEl) {
      this.boardEl.classList.remove('board-hidden');
      this.boardEl.classList.add('board-revealed');
      this.revealable = this.chess;
    }
    this.next();
  }

  boardForPeek() {
    return this.revealable || null;
  }

  stop() {
    clearInterval(this.timer);
    super.stop();
  }

  finish() {
    clearInterval(this.timer);
    super.finish();
  }

  prompt() {
    if (this.phase === 'memorize') return t('drill.memory.prompt');
    return super.prompt();
  }

  quickAnswers() {
    if (this.phase === 'memorize') return [{ label: t('drill.memory.ready'), cmd: 'ready', c: 'answer' }];
    return this.current && this.current.kind === 'what' ? [{ label: t('drill.pos.emptyWord'), cmd: t('drill.pos.emptyWord'), c: 'answer' }] : [];
  }
}

export { parsePieceAnswer, checkPositionAnswer, describePiece };
