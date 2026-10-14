// A game against the engine, with blindfold aids, clocks and persistence.
import { Chess } from '../vendor/chess.js/chess.js';
import { t, getLang } from './i18n.js';
import {
  parseMove, sanToLocal, sanToSpeech, moveLabel, formatClock, uciToObj, PIECE_NAMES,
  COLOR_NAMES, formatScore, pvToSan, capitalize,
} from './chess-utils.js';
import { identifyOpening, openingName } from './openings.js';
import { save, remove } from './storage.js';
import { resolveLevel } from './engine/manager.js';
import { stars } from './ui.js';

export class GameMode {
  constructor(app, opts) {
    this.app = app;
    this.name = 'game';
    this.id = opts.id || Date.now().toString(36);
    this.playerColor = opts.color;
    this.level = opts.level;
    this.elo = opts.elo || null;
    this.spec = resolveLevel(this.level, this.elo);
    this.chess = new Chess(opts.startFen || undefined);
    this.startFen = this.chess.fen();
    this.metrics = { peeks: 0, queries: 0, illegal: 0, hints: 0, takebacks: 0, ...(opts.metrics || {}) };
    this.startedAt = opts.startedAt || Date.now();
    this.result = null;
    this.reason = null;
    this.thinking = false;
    this.turnToken = 0;
    this.hint = null;
    this.lastEngineSan = opts.lastEngineSan || null;
    this.opening = null;
    this.clock = null;
    if (opts.clock) {
      this.clock = {
        base: opts.clock.base,
        inc: opts.clock.inc,
        remaining: opts.clock.remaining ? { ...opts.clock.remaining } : { w: opts.clock.base * 1000, b: opts.clock.base * 1000 },
        running: null,
        since: 0,
      };
    }
    for (const uci of opts.moves || []) this.chess.move(uciToObj(uci));
    this._updateOpening(true);
  }

  // -- helpers ----------------------------------------------------------------

  get notation() { return this.app.settings.get('notation'); }
  get blind() { return this.app.settings.get('blind'); }
  isPlayerTurn() { return !this.result && this.chess.turn() === this.playerColor; }
  local(san) { return sanToLocal(san, this.notation); }
  colorName(c) { return COLOR_NAMES[getLang()][c]; }
  levelLabel() {
    return this.elo ? `Elo ${this.elo}` : t('level.label', { n: this.spec.level, elo: this.spec.level === 10 ? 'max' : `~${this.spec.elo}` });
  }

  lastMove() {
    const h = this.chess.history({ verbose: true });
    return h.length ? h[h.length - 1] : null;
  }

  lastMoveText() {
    const h = this.chess.history({ verbose: true });
    if (!h.length) return null;
    const m = h[h.length - 1];
    return `${moveLabel(m.before)} ${this.local(m.san)}`;
  }

  movesUci() {
    return this.chess.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
  }

  // -- lifecycle ----------------------------------------------------------------

  start({ resumed = false } = {}) {
    const app = this.app;
    if (!resumed) {
      app.engines.newGame();
      app.sound.play('start');
      app.term.print([
        { t: '♞ ', c: 'accent' },
        { t: t('game.new', { color: this.colorName(this.playerColor), level: this.levelLabel() }), c: 'hl' },
      ]);
      const blindText = t(`blind.mode.${this.blind}`);
      const details = [t('game.blindInfo', { mode: blindText })];
      if (this.clock) details.push(t('game.clockInfo', { base: this.clock.base / 60, inc: this.clock.inc }));
      app.term.print(details.join(' · '), 'dim');
      if (this.startFen !== new Chess().fen()) app.term.print(t('game.fromPosition', { fen: this.startFen }), 'dim');
      app.say(t('speech.newGame', { color: this.colorName(this.playerColor) }));
    } else {
      app.term.print([{ t: '♞ ', c: 'accent' }, { t: t('game.resumed', { color: this.colorName(this.playerColor), level: this.levelLabel() }), c: 'hl' }]);
      const last = this.lastMoveText();
      if (last) app.term.print(t('game.lastMoveWas', { move: last }), 'dim');
    }
    if (this.blind === 'off') this.showBoard();
    this._startClock();
    this.save();
    if (!this.isPlayerTurn()) this.engineTurn();
    else this._promptTurn(resumed);
  }

  _promptTurn(force) {
    if (force || this.chess.history().length === 0) {
      this.app.term.print(t('game.yourMove', { label: moveLabel(this.chess.fen()) }), 'dim');
    }
  }

  stop() {
    // Leaving the game (another activity started): pause, keep it saved.
    this.turnToken++;
    if (this.thinking) this.app.engines.cancel();
    this.thinking = false;
    this._pauseClock();
    if (!this.result) {
      this.save();
      this.app.term.print(t('game.paused'), 'dim');
    }
  }

  save() {
    if (this.result) return;
    save('game', {
      v: 1,
      id: this.id,
      color: this.playerColor,
      level: this.level,
      elo: this.elo,
      startFen: this.startFen,
      moves: this.movesUci(),
      metrics: this.metrics,
      startedAt: this.startedAt,
      lastEngineSan: this.lastEngineSan,
      clock: this.clock ? { base: this.clock.base, inc: this.clock.inc, remaining: this._remainingNow() } : null,
    });
  }

  static restore(app, data) {
    return new GameMode(app, data);
  }

  // -- clock ------------------------------------------------------------------

  _startClock() {
    if (!this.clock || this.result) return;
    this.clock.running = this.chess.turn();
    this.clock.since = Date.now();
  }

  _pauseClock() {
    if (!this.clock || !this.clock.running) return;
    this.clock.remaining = this._remainingNow();
    this.clock.running = null;
  }

  _remainingNow() {
    const c = this.clock;
    const r = { ...c.remaining };
    if (c.running) r[c.running] -= Date.now() - c.since;
    return r;
  }

  _pressClock(mover) {
    const c = this.clock;
    if (!c) return;
    const now = Date.now();
    if (c.running === mover) c.remaining[mover] -= now - c.since;
    c.remaining[mover] += c.inc * 1000;
    c.running = mover === 'w' ? 'b' : 'w';
    c.since = now;
  }

  tick() {
    if (!this.clock || !this.clock.running || this.result) return;
    const r = this._remainingNow();
    const side = this.clock.running;
    if (r[side] <= 0) {
      this.clock.remaining = r;
      this.clock.remaining[side] = 0;
      this.clock.running = null;
      this.turnToken++;
      if (this.thinking) this.app.engines.cancel();
      this.thinking = false;
      const loser = side;
      // Flag fall: a draw if the opponent cannot possibly mate.
      const winnerHasMaterial = this.chess.board().flat().some((p) => p && p.color !== loser && p.type !== 'k');
      if (!winnerHasMaterial) this.finish('draw', 'timeoutDraw');
      else this.finish(loser === this.playerColor ? 'loss' : 'win', 'timeout');
    }
  }

  clockText() {
    if (!this.clock) return null;
    const r = this._remainingNow();
    return { you: formatClock(r[this.playerColor]), opp: formatClock(r[this.playerColor === 'w' ? 'b' : 'w']), low: r[this.playerColor] < 20000 };
  }

  // -- moves -------------------------------------------------------------------

  input(text) {
    if (this.result) {
      this.app.term.print(t('game.isOver'), 'warn');
      return true;
    }
    if (!this.isPlayerTurn()) {
      this.app.term.print(t('game.notYourTurn'), 'warn');
      return true;
    }
    const r = parseMove(this.chess, text, { notation: this.notation });
    if (!r.ok) {
      this.reportIllegal(r, text);
      return true;
    }
    this.applyMove(r.move, 'player', { autoQueen: r.autoQueen });
    return true;
  }

  reportIllegal(r, text) {
    const app = this.app;
    const lang = getLang();
    if (r.error === 'syntax') {
      app.term.print(t('move.syntax', { input: text }), 'err');
      app.sound.play('error');
      return;
    }
    this.metrics.illegal++;
    app.sound.play('error');
    if (r.error === 'ambiguous') {
      app.term.print(t('move.ambiguous', { list: r.candidates.map((s) => this.local(s)).join(', ') }), 'err');
    } else if (r.castle) {
      app.term.print(t('move.cantCastle'), 'err');
    } else if (r.piece && r.to) {
      app.term.print(t('move.illegalPiece', { input: text, piece: PIECE_NAMES[lang][r.piece], square: r.to }), 'err');
    } else {
      app.term.print(t('move.illegal', { input: text }), 'err');
    }
    if (this.chess.inCheck()) app.term.print(t('move.inCheck'), 'warn');
    app.say(t('speech.illegal'), { interrupt: true });
    this.save();
  }

  applyMove(move, who, { autoQueen = false } = {}) {
    const app = this.app;
    const label = moveLabel(this.chess.fen());
    const mv = this.chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    this._pressClock(mv.color);
    this.hint = null;
    const isCheck = mv.san.includes('+') || mv.san.includes('#');
    const sanText = this.local(mv.san);
    if (who === 'player') {
      app.term.print([{ t: label + ' ', c: 'num' }, { t: sanText, c: 'you' }, autoQueen ? { t: '  ' + t('move.autoQueen'), c: 'dim' } : null]);
    } else {
      this.lastEngineSan = mv.san;
      const capturedName = mv.captured ? PIECE_NAMES[getLang()][mv.captured] : null;
      const extra = [];
      if (mv.captured && app.settings.get('announce') === 'full') extra.push(t('move.capturedPiece', { piece: capturedName }));
      app.term.print([
        { t: label + ' ', c: 'num' },
        { t: sanText, c: 'opp' },
        extra.length ? { t: '  ' + extra.join(' '), c: 'dim' } : null,
      ]);
      const full = app.settings.get('announce') === 'full';
      app.say(sanToSpeech(mv.san, getLang(), { captured: full ? mv.captured : null }));
    }
    app.sound.play(isCheck ? 'check' : mv.captured ? 'capture' : 'move');
    this._updateOpening(false);
    this.save();
    if (this.checkEnd()) return;
    if (who === 'player') {
      this.engineTurn();
    } else {
      if (this.chess.inCheck()) app.term.print(t('game.youAreInCheck'), 'warn');
      if (this.blind === 'off') this.showBoard();
    }
  }

  _updateOpening(silent) {
    if (this.chess.history().length > 40) return;
    const c = new Chess(this.startFen);
    const fens = [];
    for (const m of this.chess.history({ verbose: true })) {
      c.move(m);
      fens.push(c.fen());
    }
    const op = identifyOpening(Chess, fens);
    if (op && (!this.opening || op.eco + op.en !== this.opening.eco + this.opening.en)) {
      this.opening = op;
      if (!silent) this.app.term.print([{ t: '📖 ', c: 'dim' }, { t: openingName(op, getLang()), c: 'dim' }]);
    }
  }

  async engineTurn() {
    if (this.thinking || this.result) return;
    const app = this.app;
    const token = ++this.turnToken;
    this.thinking = true;
    app.refresh();
    const spin = app.term.spinner(t('game.thinking'));
    const started = Date.now();
    try {
      const res = await app.engines.play(this.chess.fen(), this.spec);
      // Don't answer instantly: it feels unnatural and is easy to miss.
      const minDelay = 350 + Math.random() * 450;
      const wait = minDelay - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      spin.stop();
      if (token !== this.turnToken || app.mode !== this || this.result) return;
      this.thinking = false;
      const mv = uciToObj(res.move);
      const legal = this.chess.moves({ verbose: true }).find((m) => m.from === mv.from && m.to === mv.to && (!m.promotion || m.promotion === (mv.promotion || 'q')));
      if (!legal) throw new Error(`illegal engine move ${res.move}`);
      this.applyMove(legal, 'engine');
    } catch (err) {
      spin.stop();
      if (err && err.cancelled) return;
      if (token !== this.turnToken) return;
      this.thinking = false;
      app.term.print(t('engine.error', { msg: (err && err.message) || String(err) }), 'err');
      app.term.print([t('engine.retryHint.pre'), { t: 'go', cmd: 'go', run: true }, t('engine.retryHint.mid'), { t: 'engine basic', cmd: 'engine basic', run: true }], 'dim');
    } finally {
      app.refresh();
    }
  }

  go() {
    if (this.result) return this.app.term.print(t('game.isOver'), 'warn');
    if (this.isPlayerTurn()) return this.app.term.print(t('game.yourTurnAlready'), 'dim');
    if (this.thinking) return this.app.term.print(t('game.alreadyThinking'), 'dim');
    this.engineTurn();
  }

  checkEnd() {
    const c = this.chess;
    if (c.isCheckmate()) {
      const loser = c.turn();
      this.finish(loser === this.playerColor ? 'loss' : 'win', 'checkmate');
      return true;
    }
    if (c.isStalemate()) { this.finish('draw', 'stalemate'); return true; }
    if (c.isInsufficientMaterial()) { this.finish('draw', 'insufficient'); return true; }
    if (c.isThreefoldRepetition()) { this.finish('draw', 'repetition'); return true; }
    if (c.isDrawByFiftyMoves()) { this.finish('draw', 'fifty'); return true; }
    return false;
  }

  blindScore() {
    if (this.blind === 'off') return null;
    const m = this.metrics;
    const score = Math.max(0, 100 - m.peeks * 10 - m.queries * 4 - m.illegal * 5 - m.hints * 8 - m.takebacks * 6);
    const n = score >= 95 ? 5 : score >= 80 ? 4 : score >= 60 ? 3 : score >= 40 ? 2 : 1;
    return { score, stars: n };
  }

  finish(outcome, reason) {
    const app = this.app;
    this.result = outcome;
    this.reason = reason;
    this.turnToken++;
    this.thinking = false;
    this._pauseClock();
    const resultTag = outcome === 'draw' ? '1/2-1/2' : (outcome === 'win') === (this.playerColor === 'w') ? '1-0' : '0-1';
    this.resultTag = resultTag;
    const moves = Math.ceil(this.chess.history().length / 2);
    const minutes = Math.round((Date.now() - this.startedAt) / 60000);
    const bs = this.blindScore();
    const headline = t(`result.${outcome}`) + ' · ' + t(`reason.${reason}`);
    const rows = [
      [t('summary.result'), { t: `${resultTag} — ${headline}`, c: outcome === 'win' ? 'ok' : outcome === 'loss' ? 'err' : 'warn' }],
      [t('summary.opponent'), this.levelLabel()],
      [t('summary.moves'), t('summary.movesValue', { n: moves, min: minutes })],
      this.opening ? [t('summary.opening'), openingName(this.opening, getLang())] : null,
      [t('summary.aids'), t('summary.aidsValue', this.metrics)],
      bs ? [t('summary.blindScore'), { t: `${stars(bs.stars)}  ${bs.score}/100`, c: 'accent' }] : [t('summary.blindScore'), t('summary.sighted')],
    ];
    app.term.printNode(app.ui.card(t('summary.title'), rows, { cls: 'result ' + outcome }), { forceScroll: true });
    app.term.print([
      t('summary.next.pre'),
      { t: 'review', cmd: 'review', run: true }, ' · ',
      { t: 'board', cmd: 'board', run: true }, ' · ',
      { t: 'pgn', cmd: 'pgn', run: true }, ' · ',
      { t: 'lichess', cmd: 'lichess', run: true }, ' · ',
      { t: 'play', cmd: 'play', run: false },
    ], 'dim');
    app.sound.play(outcome === 'win' ? 'win' : 'end');
    app.say(`${t(`result.${outcome}`)}. ${t(`reason.${reason}`)}.`);
    remove('game');
    const record = {
      id: this.id,
      date: new Date().toISOString(),
      color: this.playerColor,
      level: this.level,
      elo: this.elo,
      startFen: this.startFen,
      moves: this.movesUci(),
      sans: this.chess.history(),
      result: resultTag,
      outcome,
      reason,
      metrics: { ...this.metrics },
      blind: this.blind,
      blindScore: bs ? bs.score : null,
      opening: this.opening ? { eco: this.opening.eco, en: this.opening.en, pt: this.opening.pt } : null,
    };
    app.setLastGame(record);
    app.stats.recordGame(record);
    app.checkAchievements({ type: 'game', record });
    app.refresh();
  }

  // -- actions -------------------------------------------------------------------

  pgn() {
    const c = new Chess(this.startFen);
    for (const uci of this.movesUci()) c.move(uciToObj(uci));
    const d = new Date(this.startedAt);
    const date = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    const engineName = this.elo ? `Stockfish (Elo ${this.elo})` : `Engine (level ${this.spec.level})`;
    c.setHeader('Event', 'Blind Chess Terminal');
    c.setHeader('Site', typeof location !== 'undefined' ? location.origin + location.pathname : '?');
    c.setHeader('Date', date);
    c.setHeader('White', this.playerColor === 'w' ? 'Player' : engineName);
    c.setHeader('Black', this.playerColor === 'b' ? 'Player' : engineName);
    c.setHeader('Result', this.resultTag || '*');
    c.setHeader('Blindfold', this.blind);
    if (this.opening) {
      c.setHeader('ECO', this.opening.eco);
      c.setHeader('Opening', this.opening.en);
    }
    return c.pgn();
  }

  undo() {
    const app = this.app;
    if (!this.chess.history().length) {
      app.term.print(t('undo.nothing'), 'warn');
      return;
    }
    this.turnToken++;
    if (this.thinking) app.engines.cancel();
    this.thinking = false;
    let n = 0;
    do {
      this.chess.undo();
      n++;
    } while (this.chess.history().length && this.chess.turn() !== this.playerColor);
    const reopened = !!this.result;
    this.result = null;
    this.reason = null;
    this.hint = null;
    this.metrics.takebacks++;
    if (reopened) {
      app.term.print(t('undo.reopened'), 'dim');
      this._startClock();
    } else if (this.clock) {
      this.clock.running = this.chess.turn();
      this.clock.since = Date.now();
    }
    const last = this.lastMoveText();
    app.term.print(t('undo.done', { n, label: moveLabel(this.chess.fen()) }) + (last ? ' ' + t('undo.lastMove', { move: last }) : ''), 'hl');
    this._updateOpening(true);
    this.save();
    if (this.blind === 'off') this.showBoard();
    if (!this.isPlayerTurn()) this.engineTurn();
  }

  resign() {
    if (this.result) return this.app.term.print(t('game.isOver'), 'warn');
    this.finish('loss', 'resign');
  }

  async offerDraw() {
    const app = this.app;
    if (this.result) return app.term.print(t('game.isOver'), 'warn');
    const spin = app.term.spinner(t('draw.considering'));
    try {
      const res = await app.engines.analyse(this.chess.fen(), { movetime: 700 });
      spin.stop();
      const s = res.lines[0] && res.lines[0].score;
      let engineView = 0;
      if (s) engineView = s.mate != null ? (s.mate > 0 ? 10000 : -10000) : s.cp;
      if (this.playerColor === 'w') engineView = -engineView; // scores are from White's side
      const fullMoves = this.chess.moveNumber();
      const accept = engineView <= -150 || (engineView <= 25 && fullMoves >= 20);
      if (accept && app.mode === this && !this.result) {
        app.term.print(t('draw.accepted'), 'ok');
        this.finish('draw', 'agreement');
      } else {
        app.term.print(t('draw.declined'), 'warn');
        app.say(t('draw.declined'));
      }
    } catch (err) {
      spin.stop();
      if (!(err && err.cancelled)) app.term.print(t('engine.error', { msg: err.message }), 'err');
    }
  }

  async giveHint() {
    const app = this.app;
    if (this.result) return app.term.print(t('game.isOver'), 'warn');
    if (!this.isPlayerTurn()) return app.term.print(t('game.notYourTurn'), 'warn');
    const fen = this.chess.fen();
    if (!this.hint || this.hint.fen !== fen) {
      const spin = app.term.spinner(t('hint.thinking'));
      try {
        const res = await app.engines.analyse(fen, { movetime: 900 });
        spin.stop();
        if (this.chess.fen() !== fen) return;
        const mv = new Chess(fen).move(uciToObj(res.bestmove));
        this.hint = { fen, move: mv, stage: 0 };
      } catch (err) {
        spin.stop();
        if (!(err && err.cancelled)) app.term.print(t('engine.error', { msg: err.message }), 'err');
        return;
      }
    }
    const h = this.hint;
    h.stage++;
    this.metrics.hints++;
    const lang = getLang();
    if (h.stage === 1) {
      const name = PIECE_NAMES[lang][h.move.piece];
      app.term.print([{ t: '💡 ', c: 'accent' }, t('hint.piece', { piece: name })], 'hl');
      app.term.print(t('hint.more'), 'dim');
      app.say(t('hint.piece', { piece: name }));
    } else {
      const san = this.local(h.move.san);
      app.term.print([{ t: '💡 ', c: 'accent' }, t('hint.move', { move: san })], 'hl');
      app.say(t('hint.moveSpeech', { move: sanToSpeech(h.move.san, lang) }));
    }
    this.save();
  }

  async evaluate() {
    const app = this.app;
    const fen = this.chess.fen();
    const spin = app.term.spinner(t('eval.thinking'));
    try {
      const res = await app.engines.analyse(fen, { movetime: 1500 });
      spin.stop();
      const line = res.lines[0] || {};
      const sans = pvToSan(Chess, fen, line.pv || [res.bestmove], 8).map((s) => this.local(s));
      const score = formatScore(line.score);
      const who = evalWords(line.score);
      app.term.print([{ t: t('eval.label') + ' ', c: 'dim' }, { t: score, c: 'accent' }, ` (${who})`, { t: line.depth ? `  ${t('eval.depth', { d: line.depth })}` : '', c: 'dim' }]);
      if (sans.length) app.term.print([{ t: t('eval.line') + ' ', c: 'dim' }, sans.join(' ')]);
      app.term.print(t('eval.by', { engine: app.engines.engines[res.engine].name }), 'dim');
      if (!this.result && app.mode === this) {
        this.metrics.hints++;
        this.save();
      }
    } catch (err) {
      spin.stop();
      if (!(err && err.cancelled)) app.term.print(t('engine.error', { msg: err.message }), 'err');
    }
  }

  // Aids. Returns false if refused (strict blindfold).
  allowAid(kind) {
    if (this.result || this.blind !== 'strict') return true;
    this.app.term.print(t('blind.strictRefuse'), 'warn');
    this.app.sound.play('error');
    return false;
  }

  countAid(kind) {
    if (this.result || this.blind === 'off') return;
    this.metrics[kind]++;
    if (kind === 'peeks') this.app.term.print(t('blind.peekCount', { n: this.metrics.peeks }), 'dim');
    this.save();
  }

  showBoard(style) {
    const app = this.app;
    const last = this.lastMove();
    const side = [];
    side.push({ t: this.result ? t('board.gameOver', { result: this.resultTag }) : t('board.toMove', { color: capitalize(this.colorName(this.chess.turn())) }), c: 'hl' });
    const lm = this.lastMoveText();
    if (lm) side.push(t('board.last', { move: lm }));
    const cap = app.capturedText(this.chess);
    if (cap) side.push(cap);
    if (this.opening) side.push({ t: openingName(this.opening, getLang()), c: 'dim' });
    const clock = this.clockText();
    if (clock) side.push(t('board.clock', clock));
    app.showBoard(this.chess, {
      flip: this.playerColor === 'b',
      lastMove: last ? { from: last.from, to: last.to } : null,
      style,
      side,
    });
  }

  // -- status line -------------------------------------------------------------------

  prompt() {
    if (this.result) return t('prompt.over');
    if (this.thinking || !this.isPlayerTurn()) return '… ❯';
    return `${moveLabel(this.chess.fen())} ❯`;
  }

  status() {
    const segs = [];
    const you = this.playerColor === 'w' ? '♔' : '♚';
    segs.push({ t: `${you} ${capitalize(this.colorName(this.playerColor))}`, c: 'hl' });
    segs.push({ t: this.levelLabel() });
    segs.push({ t: t(`blind.short.${this.blind}`), c: this.blind === 'strict' ? 'warn' : this.blind === 'on' ? 'accent' : 'dim' });
    if (this.result) segs.push({ t: this.resultTag, c: 'warn' });
    else if (this.thinking) segs.push({ t: t('status.thinking'), c: 'accent pulse' });
    else if (this.isPlayerTurn()) segs.push({ t: t('status.yourMove'), c: 'ok' });
    if (this.blind !== 'off') {
      const m = this.metrics;
      segs.push({ t: `👁 ${m.peeks}`, title: t('status.peeks') });
      if (m.illegal) segs.push({ t: `✗ ${m.illegal}`, title: t('status.illegal'), c: 'err' });
    }
    const clock = this.clockText();
    if (clock) segs.push({ t: `⏱ ${clock.you} · ${clock.opp}`, c: clock.low ? 'err' : '' });
    return segs;
  }

  actions() {
    if (this.result) {
      return [
        { label: 'review', cmd: 'review' },
        { label: 'play', cmd: 'play', run: false },
        { label: 'pgn', cmd: 'pgn' },
        { label: 'undo', cmd: 'undo' },
      ];
    }
    const a = [
      { label: 'repeat', cmd: 'repeat' },
      { label: 'moves', cmd: 'moves' },
    ];
    if (this.blind !== 'strict') a.push({ label: 'board', cmd: 'board' });
    a.push({ label: 'hint', cmd: 'hint' }, { label: 'undo', cmd: 'undo' }, { label: 'resign', cmd: 'resign', run: false });
    return a;
  }
}

function evalWords(score) {
  if (!score) return '?';
  if (score.mate != null) return t(score.mate > 0 ? 'eval.whiteMates' : 'eval.blackMates', { n: Math.abs(score.mate) });
  const cp = score.cp;
  const a = Math.abs(cp);
  const side = cp > 0 ? 'white' : 'black';
  if (a < 30) return t('eval.equal');
  if (a < 80) return t(`eval.slight.${side}`);
  if (a < 200) return t(`eval.better.${side}`);
  return t(`eval.winning.${side}`);
}
