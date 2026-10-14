// Blindfold puzzles: the position is read as a list of pieces, the solution
// is played by typing (or saying) moves. Built-in set works offline; the
// Lichess puzzle API is used for "online" puzzles when reachable.
import { Chess } from '../vendor/chess.js/chess.js';
import { t, getLang } from './i18n.js';
import {
  parseMove, uciToObj, moveToUci, sanToLocal, sanToSpeech, listPieces, piecesToText, piecesToSpeech,
  moveLabel, COLOR_NAMES, PIECE_NAMES, capitalize, pick,
} from './chess-utils.js';
import { PUZZLES } from './data/puzzles.js';

export const PUZZLE_THEMES = ['any', 'mate1', 'mate2', 'mate3', 'online'];
export const PUZZLE_ALIASES = {
  any: 'any', all: 'any', todos: 'any', qualquer: 'any',
  mate1: 'mate1', m1: 'mate1', 1: 'mate1',
  mate2: 'mate2', m2: 'mate2', 2: 'mate2',
  mate3: 'mate3', m3: 'mate3', 3: 'mate3',
  online: 'online', lichess: 'online', web: 'online',
};

async function fetchLichessPuzzle() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch('https://lichess.org/api/puzzle/next', { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return parseLichessPuzzle(data);
  } finally {
    clearTimeout(timer);
  }
}

/** Lichess puzzle JSON -> internal puzzle. Exported for tests. */
export function parseLichessPuzzle(data) {
  const sol = data.puzzle.solution;
  const sans = String(data.game.pgn || '').replace(/\{[^}]*\}/g, ' ').replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/).filter(Boolean);
  const attempt = (n) => {
    const c = new Chess();
    for (const s of sans.slice(0, n)) c.move(s);
    const ok = c.moves({ verbose: true }).some((m) => moveToUci(m) === sol[0] || m.from + m.to === sol[0].slice(0, 4));
    return ok ? c : null;
  };
  const c = attempt(sans.length) || attempt((data.puzzle.initialPly ?? sans.length - 1) + 1);
  if (!c) throw new Error('puzzle data not understood');
  const hist = c.history({ verbose: true });
  const last = hist[hist.length - 1];
  const fen = c.fen();
  const mateTheme = (data.puzzle.themes || []).find((th) => /^mateIn\d$/.test(th));
  return {
    id: data.puzzle.id,
    source: 'lichess',
    fen,
    solution: sol,
    mate: mateTheme ? +mateTheme.slice(-1) : null,
    rating: data.puzzle.rating,
    lastMove: last ? { san: last.san, label: moveLabel(last.before) } : null,
    themes: data.puzzle.themes || [],
  };
}

export class PuzzleMode {
  constructor(app, theme = 'any') {
    this.app = app;
    this.name = 'puzzle';
    this.theme = theme;
    this.puzzle = null;
    this.chess = null;
    this.state = 'loading'; // loading | solving | done
    this.count = 0;
    this.sessionSolved = 0;
  }

  get notation() { return this.app.settings.get('notation'); }
  local(san) { return sanToLocal(san, this.notation); }

  start() {
    this.next();
  }

  acceptsEmpty() { return this.state === 'done'; }

  async next() {
    const app = this.app;
    if (this.state === 'solving' && this.puzzle && this.attempted) this.record(false, { silent: true });
    this.state = 'loading';
    app.refresh();
    let pz = null;
    if (this.theme === 'online') {
      const spin = app.term.spinner(t('puzzle.fetching'));
      try {
        pz = await fetchLichessPuzzle();
        spin.stop();
      } catch (err) {
        spin.stop();
        app.term.print(t('puzzle.fetchFailed', { msg: err.message }), 'warn');
      }
      if (app.mode !== this) return;
    }
    if (!pz) pz = this.pickBuiltin();
    this.load(pz);
  }

  pickBuiltin() {
    const stats = this.app.stats.data.puzzles;
    const rating = stats.rating;
    const solved = new Set(stats.solvedIds);
    let pool = PUZZLES.filter(([, , , mate]) => this.theme === 'any' || this.theme === 'online' || `mate${mate}` === this.theme);
    const fresh = pool.filter(([id]) => !solved.has(id));
    if (fresh.length) pool = fresh;
    if (this.puzzle) {
      const others = pool.filter(([id]) => id !== this.puzzle.id);
      if (others.length) pool = others;
    }
    const near = pool.filter(([, , , , r]) => Math.abs(r - rating) <= 200);
    const [id, fen, sol, mate, r] = pick(near.length >= 3 ? near : pool);
    return { id, source: 'builtin', fen, solution: sol.split(' '), mate, rating: r, lastMove: null, themes: [] };
  }

  load(pz) {
    const app = this.app;
    this.puzzle = pz;
    this.chess = new Chess(pz.fen);
    this.step = 0;
    this.mistakes = 0;
    this.hints = 0;
    this.hintStage = 0;
    this.peeks = 0;
    this.revealed = false;
    this.attempted = false;
    this.state = 'solving';
    this.count++;
    this.solver = this.chess.turn();
    const lang = getLang();
    const side = capitalize(COLOR_NAMES[lang][this.solver]);
    const goal = pz.mate ? t('puzzle.goalMate', { n: pz.mate }) : t('puzzle.goalBest');
    const pieces = listPieces(this.chess);
    const order = this.solver === 'w' ? ['w', 'b'] : ['b', 'w'];
    const rows = [];
    rows.push({ t: `${t('puzzle.toMove', { side })} — ${goal}`, c: 'hl' });
    if (pz.lastMove) rows.push({ t: t('puzzle.lastMove', { move: `${pz.lastMove.label} ${this.local(pz.lastMove.san)}` }), c: 'dim' });
    for (const c of order) {
      const { officers, pawns } = piecesToText(pieces[c], this.notation);
      const label = capitalize(COLOR_NAMES[lang][c]);
      rows.push([label, officers.join(' ') + (pawns.length ? `  ·  ${t('puzzle.pawns')}: ${pawns.join(' ')}` : '')]);
    }
    const src = pz.source === 'lichess' ? `lichess #${pz.id}` : `#${pz.id}`;
    app.term.printNode(app.ui.card(`🧩 ${t('puzzle.title')} ${src} · ${t('puzzle.rating')} ${pz.rating}`, rows, { cls: 'puzzle' }), { forceScroll: true });
    app.term.print(t('puzzle.instructions'), 'dim');
    const speech = [
      `${t('puzzle.toMove', { side })}. ${goal}.`,
      ...order.map((c) => `${capitalize(COLOR_NAMES[lang][c])}: ${piecesToSpeech(pieces[c], lang)}.`),
    ].join(' ');
    app.say(speech);
    app.refresh();
  }

  isLastSolverMove() {
    return this.step >= this.puzzle.solution.length - 1;
  }

  input(text) {
    const app = this.app;
    if (this.state === 'done') {
      if (!text.trim()) { this.next(); return true; }
      app.term.print(t('puzzle.doneHint'), 'dim');
      return true;
    }
    if (this.state !== 'solving') return true;
    const r = parseMove(this.chess, text, { notation: this.notation });
    if (!r.ok) {
      if (r.error === 'syntax') app.term.print(t('move.syntax', { input: text }), 'err');
      else if (r.error === 'ambiguous') app.term.print(t('move.ambiguous', { list: r.candidates.map((s) => this.local(s)).join(', ') }), 'err');
      else app.term.print(t('move.illegal', { input: text }), 'err');
      app.sound.play('error');
      return true;
    }
    this.attempted = true;
    const expected = this.puzzle.solution[this.step];
    const uci = moveToUci(r.move);
    const label = moveLabel(this.chess.fen());
    const probe = new Chess(this.chess.fen());
    probe.move(r.move);
    const mates = probe.isCheckmate();
    if (uci === expected || (expected && uci.slice(0, 4) === expected.slice(0, 4) && !expected[4]) || (mates && (this.isLastSolverMove() || this.puzzle.mate))) {
      this.playSolver(r.move, label);
      return true;
    }
    if (this.puzzle.mate && !this.isLastSolverMove()) {
      // Maybe an alternative that still mates in time: ask the engine.
      this.verifyAlternative(r.move, label);
      return true;
    }
    this.wrong(r.move);
    return true;
  }

  async verifyAlternative(move, label) {
    const app = this.app;
    const fenBefore = this.chess.fen();
    const probe = new Chess(fenBefore);
    probe.move(move);
    const movesLeft = Math.ceil((this.puzzle.solution.length - this.step) / 2) - 1;
    const spin = app.term.spinner(t('puzzle.checking'));
    try {
      const res = await app.engines.analyse(probe.fen(), { depth: 14 });
      spin.stop();
      if (app.mode !== this || this.chess.fen() !== fenBefore) return;
      const s = res.lines[0] && res.lines[0].score;
      const solverSign = this.solver === 'w' ? 1 : -1;
      const ok = s && s.mate != null && s.mate * solverSign > 0 && Math.abs(s.mate) <= movesLeft;
      if (ok) {
        // Accept and continue along the engine's line.
        this.puzzle = { ...this.puzzle, solution: [...this.puzzle.solution.slice(0, this.step), moveToUci(move), ...res.lines[0].pv] };
        this.puzzle.solution = this.puzzle.solution.slice(0, this.step + 1 + 2 * movesLeft);
        this.playSolver(move, label);
      } else {
        this.wrong(move);
      }
    } catch {
      spin.stop();
      this.wrong(move);
    }
  }

  playSolver(move, label) {
    const app = this.app;
    const mv = this.chess.move(move);
    this.step++;
    app.term.print([{ t: '✓ ', c: 'ok' }, { t: `${label} ${this.local(mv.san)}`, c: 'you' }]);
    app.sound.play(mv.san.includes('+') || mv.san.includes('#') ? 'check' : mv.captured ? 'capture' : 'move');
    if (this.chess.isCheckmate() || this.step >= this.puzzle.solution.length) {
      this.solved();
      return;
    }
    const reply = this.puzzle.solution[this.step];
    const replyLabel = moveLabel(this.chess.fen());
    setTimeout(() => {
      if (app.mode !== this || this.state !== 'solving') return;
      let rm;
      try { rm = this.chess.move(uciToObj(reply)); } catch { this.solved(); return; }
      this.step++;
      app.term.print([{ t: `${replyLabel} ${this.local(rm.san)}`, c: 'opp' }, { t: '  ' + t('puzzle.yourMove'), c: 'dim' }]);
      app.say(sanToSpeech(rm.san, getLang()));
      app.sound.play(rm.captured ? 'capture' : 'move');
      app.refresh();
    }, 500);
  }

  wrong(move) {
    const app = this.app;
    this.mistakes++;
    const san = new Chess(this.chess.fen()).move(move).san;
    app.term.print([{ t: '✗ ', c: 'err' }, t('puzzle.wrong', { move: this.local(san) })], 'err-line');
    app.sound.play('wrong');
    app.say(t('puzzle.wrongSpeech'));
    if (this.mistakes === 1) app.term.print([t('puzzle.wrongHelp.pre'), { t: 'hint', cmd: 'hint', run: true }, ' · ', { t: 'solution', cmd: 'solution', run: true }], 'dim');
  }

  solved() {
    const app = this.app;
    this.state = 'done';
    const clean = this.mistakes === 0 && this.hints === 0 && !this.revealed;
    const change = this.record(clean);
    this.sessionSolved++;
    app.term.print([{ t: '🎉 ', c: 'ok' }, { t: t('puzzle.solved'), c: 'ok' }, change ? { t: '  ' + ratingText(change), c: change.delta >= 0 ? 'ok' : 'err' } : null]);
    app.sound.play('win');
    app.say(t('puzzle.solved'));
    app.term.print([t('puzzle.nextHint.pre'), { t: 'next', cmd: 'next', run: true }, t('puzzle.nextHint.mid'), { t: 'board', cmd: 'board', run: true }], 'dim');
    app.refresh();
  }

  record(success, { silent = false } = {}) {
    if (this.recorded === this.puzzle) return null;
    this.recorded = this.puzzle;
    const change = this.app.stats.recordPuzzle({ id: this.puzzle.id, success, rating: this.puzzle.rating, builtin: this.puzzle.source === 'builtin' });
    this.app.checkAchievements({ type: 'puzzle', success });
    if (!success && !silent && change) this.app.term.print(ratingText(change), 'dim');
    return change;
  }

  async hint() {
    const app = this.app;
    if (this.state !== 'solving') return;
    const expected = this.puzzle.solution[this.step];
    const mv = new Chess(this.chess.fen()).move(uciToObj(expected));
    this.hints++;
    this.hintStage++;
    const lang = getLang();
    if (this.hintStage === 1) {
      app.term.print([{ t: '💡 ', c: 'accent' }, t('puzzle.hintPiece', { piece: PIECE_NAMES[lang][mv.piece], square: mv.from })], 'hl');
      app.say(t('puzzle.hintPiece', { piece: PIECE_NAMES[lang][mv.piece], square: mv.from }));
    } else {
      app.term.print([{ t: '💡 ', c: 'accent' }, t('hint.move', { move: this.local(mv.san) })], 'hl');
      app.say(t('hint.moveSpeech', { move: sanToSpeech(mv.san, lang) }));
    }
  }

  showSolution() {
    const app = this.app;
    if (!this.puzzle) return;
    this.revealed = true;
    const c = new Chess(this.chess.fen());
    const sans = [];
    for (const u of this.puzzle.solution.slice(this.step)) {
      try {
        const label = moveLabel(c.fen());
        const m = c.move(uciToObj(u));
        sans.push(`${label} ${this.local(m.san)}`);
      } catch { break; }
    }
    app.term.print([{ t: t('puzzle.solutionIs') + ' ', c: 'dim' }, { t: sans.join('  '), c: 'hl' }]);
    if (this.state === 'solving') {
      this.record(false);
      this.state = 'done';
      app.term.print([t('puzzle.nextHint.pre'), { t: 'next', cmd: 'next', run: true }], 'dim');
    }
    app.refresh();
  }

  boardForPeek() {
    if (this.state === 'solving') {
      this.peeks++;
      this.app.term.print(t('blind.peekCount', { n: this.peeks }), 'dim');
    }
    return this.chess;
  }

  stop() {
    if (this.state === 'solving' && this.attempted) this.record(false, { silent: true });
    this.state = 'stopped';
    this.app.term.print(t('puzzle.stopped', { n: this.sessionSolved }), 'dim');
  }

  prompt() {
    if (this.state === 'done') return t('prompt.next');
    if (!this.chess) return '… ❯';
    return `${moveLabel(this.chess.fen())} ❯`;
  }

  status() {
    const st = this.app.stats.data.puzzles;
    return [
      { t: '🧩 ' + t('puzzle.title'), c: 'hl' },
      this.puzzle ? { t: this.puzzle.mate ? t('puzzle.mateShort', { n: this.puzzle.mate }) : this.puzzle.source } : null,
      { t: `${t('puzzle.rating')} ${Math.round(st.rating)}`, c: 'accent' },
      st.streak >= 2 ? { t: `🔥 ${st.streak}`, c: 'accent' } : null,
      this.state === 'solving' && this.mistakes ? { t: `✗ ${this.mistakes}`, c: 'err' } : null,
    ].filter(Boolean);
  }

  actions() {
    if (this.state === 'done') return [{ label: 'next', cmd: 'next' }, { label: 'board', cmd: 'board' }, { label: 'stop', cmd: 'stop' }];
    return [{ label: 'board', cmd: 'board' }, { label: 'hint', cmd: 'hint' }, { label: 'solution', cmd: 'solution' }, { label: 'next', cmd: 'next' }, { label: 'stop', cmd: 'stop' }];
  }
}

function ratingText(change) {
  const sign = change.delta >= 0 ? '+' : '';
  return t('puzzle.ratingChange', { from: Math.round(change.from), to: Math.round(change.to), delta: sign + Math.round(change.delta) });
}
