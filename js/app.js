// Application core: command registry, activity (mode) switching, status line,
// voice input, achievements and all the "glue" between modules.
import { Chess, validateFen } from '../vendor/chess.js/chess.js';
import { t, setLang, getLang, hasKey } from './i18n.js';
import { load, save, remove } from './storage.js';
import { Speaker, Listener, normalizeSpoken } from './speech.js';
import { Sound } from './sound.js';
import { Stats, ACHIEVEMENTS } from './stats.js';
import { EngineManager, ENGINE_IDS, LEVELS, resolveLevel } from './engine/manager.js';
import { GameMode } from './game.js';
import { createDrill, DRILL_ALIASES, DRILL_KINDS } from './drills.js';
import { PuzzleMode, PUZZLE_ALIASES } from './puzzles.js';
import { ReviewMode } from './review.js';
import { renderBoard, capturedLine } from './board-view.js';
import { logoNode } from './banner.js';
import * as ui from './ui.js';
import {
  parseMove, sanToLocal, movesToText, listPieces, piecesToText, PIECE_NAMES, PIECE_NAMES_PLURAL,
  COLOR_NAMES, stripAccents, levenshtein, capitalize, isSquare, uciToObj, moveToUci, sanToSpeech, pick,
} from './chess-utils.js';

export const VERSION = '2.0.3';
export const THEMES = ['phosphor', 'amber', 'ice', 'dracula', 'solarized', 'paper', 'mono'];
const STD_FEN = new Chess().fen();

const WHITE = ['white', 'w', 'brancas', 'branco', 'branca', 'brancos'];
const BLACK = ['black', 'b', 'pretas', 'preto', 'preta', 'pretos', 'p', 'negras'];
const RANDOM = ['random', 'r', 'aleatorio', 'sorte', 'any', 'qualquer', '?'];
const ON = ['on', 'yes', 'true', '1', 'sim', 'ligado', 'ligar', 'ativar'];
const OFF = ['off', 'no', 'false', '0', 'nao', 'desligado', 'desligar', 'desativar'];
const VOICE_COMMANDS = new Set(['board', 'repeat', 'hint', 'undo', 'moves', 'time', 'pieces', 'where', 'legal', 'next', 'skip', 'solution', 'stop', 'eval', 'resign', 'draw', 'help', 'play', 'resume', 'go', 'train', 'puzzle']);
// Something shaped like a chess move (SAN in English or Portuguese letters, castling, UCI).
const MOVE_LIKE = /^([KQRBNDTC]?[a-h]?[1-8]?x?[a-h][1-8](=?[QRBNDTCqrbn])?|O-O(-O)?|0-0(-0)?|[a-h][1-8][a-h][1-8][qrbn]?)[+#]?$/;

export class App {
  constructor(term, settings) {
    this.term = term;
    this.settings = settings;
    setLang(settings.get('lang'));
    this.speaker = new Speaker(settings);
    this.sound = new Sound(settings);
    this.stats = new Stats();
    this.ui = { card: ui.card, table: ui.table };
    this.engines = new EngineManager({
      stockfishUrl: new URL('../vendor/stockfish/stockfish-18-lite-single.js', import.meta.url).href,
      onEvent: (e) => this.onEngineEvent(e),
    });
    this.engines.setPreference(settings.get('engine'));
    this.listener = new Listener(settings, {
      onResult: (alts) => this.onVoice(alts),
      onState: (on) => this.onListenState(on),
      onError: (err) => this.onListenError(err),
    });
    this.mode = null;
    this.lastGame = load('lastGame', null);
    this.lastSaid = null;
    this.confirmKey = null;
    this.commands = this.buildCommands();
    this.commandMap = new Map();
    for (const c of this.commands) {
      this.commandMap.set(c.name, c);
      for (const a of c.aliases) this.commandMap.set(a, c);
    }
    term.onSubmit = (text) => this.submit(text);
    term.onInterrupt = () => this.interrupt();
    term.completer = (v) => this.complete(v);
    settings.onChange((k) => this.onSetting(k));
    setInterval(() => this.tick(), 200);
  }

  // -- boot ---------------------------------------------------------------------

  boot() {
    this.applyAppearance();
    const term = this.term;
    term.printNode(logoNode());
    term.print([{ t: t('boot.tagline'), c: 'hl' }, { t: `  v${VERSION}`, c: 'dim' }]);
    term.blank();
    term.print(t('boot.quick'), 'dim');
    const quick = [
      ['play', t('boot.q.play')],
      ['train', t('boot.q.train')],
      ['puzzle', t('boot.q.puzzle')],
      ['guide', t('boot.q.guide')],
      ['help', t('boot.q.help')],
    ];
    term.printList(quick.map(([cmd, desc]) => [{ t: cmd, cmd, run: true, c: 'cmd' }, desc]));
    term.blank();
    term.print([{ t: '💡 ', c: 'accent' }, { t: pick(t('tips').split('|')), c: 'dim' }]);
    if (getLang() === 'en') term.print([{ t: 'Português? ', c: 'dim' }, { t: 'lang pt', cmd: 'lang pt', run: true }], 'dim');
    else term.print([{ t: 'English? ', c: 'dim' }, { t: 'lang en', cmd: 'lang en', run: true }], 'dim');
    const saved = load('game');
    if (saved && saved.moves) {
      term.print([{ t: '♞ ', c: 'accent' }, t('boot.savedGame', { n: Math.ceil(saved.moves.length / 2) }), ' ', { t: 'resume', cmd: 'resume', run: true }], 'hl');
    }
    if (location.protocol === 'file:') term.print(t('boot.fileProtocol'), 'warn');
    term.blank();
    this.engines.warmup();
    this.refresh();
  }

  applyAppearance() {
    const root = document.documentElement;
    root.dataset.theme = this.settings.get('theme');
    root.classList.toggle('crt', !!this.settings.get('crt'));
    const fs = this.settings.get('fontSize');
    if (fs) root.style.setProperty('--font-size', `${fs}px`);
    else root.style.removeProperty('--font-size');
    root.lang = getLang() === 'pt' ? 'pt-BR' : 'en';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || '#0b0f0b';
  }

  onSetting(key) {
    if (['theme', 'crt', 'fontSize', 'lang', '*'].includes(key)) this.applyAppearance();
    if (key === 'engine') this.engines.setPreference(this.settings.get('engine'));
    this.refresh();
  }

  // -- input ----------------------------------------------------------------------

  submit(text) {
    if (!text) {
      if (this.mode && this.mode.acceptsEmpty && this.mode.acceptsEmpty()) {
        this.term.echo('');
        this.mode.input('');
        this.refresh();
      } else {
        this.term.echo('');
      }
      return;
    }
    this.term.echo(text);
    this.execute(text);
  }

  execute(text) {
    const trimmed = text.trim();
    const head = trimmed.split(/\s+/)[0];
    const key = stripAccents(head.toLowerCase());
    const cmd = this.commandMap.get(key);
    const rawArgs = trimmed.slice(head.length).trim();
    const args = rawArgs ? rawArgs.split(/\s+/) : [];
    if (cmd) {
      if (key !== this.confirmKey && cmd.name !== this.confirmKey) this.confirmKey = null;
      try {
        const r = cmd.run(args.map((a) => a.toLowerCase()), rawArgs);
        if (r && typeof r.then === 'function') r.catch((err) => this.fail(err)).finally(() => this.refresh());
      } catch (err) {
        this.fail(err);
      }
      this.refresh();
      return;
    }
    if (this.mode && this.mode.input(trimmed)) {
      this.refresh();
      return;
    }
    // Looks like a chess move without a game?
    if (MOVE_LIKE.test(trimmed)) {
      this.term.print([t('err.noGame'), ' ', { t: 'play', cmd: 'play', run: true }], 'warn');
      return;
    }
    const names = this.commands.map((c) => c.name);
    const best = names.map((n) => [n, levenshtein(key, n)]).sort((a, b) => a[1] - b[1])[0];
    const suggestion = best && best[1] <= 2 ? best[0] : null;
    this.term.print([t('err.unknown', { cmd: head }), suggestion ? ' ' : '', suggestion ? t('err.didYouMean') + ' ' : '', suggestion ? { t: suggestion, cmd: suggestion, run: true } : '', suggestion ? '?' : '', ' ', t('err.typeHelp')], 'err');
    this.sound.play('error');
  }

  fail(err) {
    console.error(err);
    this.term.print(t('err.internal', { msg: (err && err.message) || String(err) }), 'err');
  }

  interrupt() {
    this.speaker.stop();
    if (this.engines.busy) {
      this.engines.cancel();
      const g = this.game;
      if (g) {
        g.turnToken++;
        g.thinking = false;
      }
      this.term.print(g && !g.result && !g.isPlayerTurn() ? [t('interrupt.engine'), ' ', { t: 'go', cmd: 'go', run: true }] : t('interrupt.engine'), 'dim');
    } else if (this.mode && this.mode.name !== 'game') {
      this.stopMode();
    }
    this.refresh();
  }

  confirm(key, message) {
    if (this.confirmKey === key) {
      this.confirmKey = null;
      return true;
    }
    this.confirmKey = key;
    this.term.print(message || t('confirm.again', { cmd: key }), 'warn');
    return false;
  }

  complete(value) {
    const parts = value.split(' ');
    if (parts.length === 1) {
      const p = stripAccents(parts[0].toLowerCase());
      const options = this.commands.map((c) => c.name).filter((n) => n.startsWith(p));
      // Moves are completed only when the board is visible anyway.
      const m = this.mode;
      if (m && m.name === 'game' && m.blind === 'off' && m.isPlayerTurn()) {
        for (const san of m.chess.moves()) {
          const l = sanToLocal(san, this.settings.get('notation'));
          if (l.toLowerCase().startsWith(p)) options.push(l);
        }
      }
      return { prefix: '', options };
    }
    const cmd = this.commandMap.get(stripAccents(parts[0].toLowerCase()));
    if (!cmd || !cmd.complete) return null;
    const last = parts[parts.length - 1].toLowerCase();
    const options = cmd.complete(parts.slice(1, -1)).filter((o) => o.toLowerCase().startsWith(last));
    return { prefix: parts.slice(0, -1).join(' ') + ' ', options };
  }

  // -- modes ------------------------------------------------------------------------

  setMode(mode) {
    if (this.mode && this.mode !== mode && this.mode.stop) this.mode.stop();
    this.mode = mode;
    this.refresh();
  }

  endMode(mode) {
    if (this.mode === mode) {
      this.mode = null;
      this.refresh();
    }
  }

  stopMode() {
    const m = this.mode;
    if (!m) {
      this.term.print(t('stop.nothing'), 'dim');
      return;
    }
    this.mode = null;
    if (m.stop) m.stop();
    this.refresh();
  }

  get game() {
    return this.mode && this.mode.name === 'game' ? this.mode : null;
  }

  tick() {
    const m = this.mode;
    if (m && m.tick) m.tick();
    if (m && m.clock && m.clock.running) this.refreshStatus();
  }

  refresh() {
    const m = this.mode;
    this.term.setPrompt(m ? m.prompt() : '❯');
    this.refreshStatus();
    this.term.setActions(m ? m.actions() : this.idleActions());
  }

  refreshStatus() {
    const m = this.mode;
    this.term.setStatus({ left: m ? m.status() : this.idleStatus(), right: this.rightStatus() });
  }

  idleStatus() {
    const segs = [{ t: t('status.ready'), c: 'dim' }];
    const p = this.stats.data.puzzles;
    if (p.attempted) segs.push({ t: `🧩 ${Math.round(p.rating)}`, title: t('puzzle.rating') });
    const g = this.stats.data.games;
    if (g.played) segs.push({ t: `♟ ${g.win}/${g.draw}/${g.loss}`, title: t('stats.wdl') });
    const streak = this.stats.streakDays();
    if (streak >= 2) segs.push({ t: `🔥 ${streak}`, title: t('stats.streakDays'), c: 'accent' });
    return segs;
  }

  rightStatus() {
    const st = this.engines.status();
    const segs = [];
    if (this.listener.active || this.listener.rec) segs.push({ t: '🎙', c: 'ok pulse', title: t('status.listening') });
    segs.push({ t: this.settings.get('speak') ? '🔊' : '🔇', title: t('status.voice') });
    let label;
    let cls = 'ok';
    if (st.preference === 'auto' || st.preference === 'local') {
      if (st.localState === 'loading') { label = 'Stockfish ⟳'; cls = 'accent pulse'; }
      else if (st.localState === 'ready') label = st.id === 'local' ? 'Stockfish ●' : `${shortEngine(st.id)} ●`;
      else if (st.localState === 'error') { label = `${shortEngine(st.id === 'local' ? 'basic' : st.id)} ●`; cls = 'warn'; }
      else label = `${shortEngine(st.id)} ○`;
    } else {
      label = `${shortEngine(st.preference)} ●`;
    }
    if (st.busy) cls = 'accent pulse';
    segs.push({ t: label, c: cls, title: t('status.engine') });
    return segs;
  }

  idleActions() {
    const a = [];
    if (load('game')) a.push({ label: 'resume', cmd: 'resume', c: 'primary' });
    a.push({ label: 'play', cmd: 'play', c: a.length ? '' : 'primary' }, { label: 'train', cmd: 'train' }, { label: 'puzzle', cmd: 'puzzle' });
    if (this.lastGame) a.push({ label: 'review', cmd: 'review' });
    a.push({ label: 'help', cmd: 'help' });
    return a;
  }

  // -- shared helpers -------------------------------------------------------------------

  say(text, opts) {
    this.lastSaid = text;
    this.speaker.say(text, opts);
  }

  showBoard(chess, { flip = false, lastMove = null, style = null, side = [] } = {}) {
    const st = style || this.settings.get('boardStyle');
    const check = chess.inCheck() ? chess.findPiece({ type: 'k', color: chess.turn() })[0] : null;
    const el = renderBoard(chess, { flip, lastMove, style: st, side, lang: getLang(), notation: this.settings.get('notation'), check });
    this.term.printNode(el, { forceScroll: true });
  }

  capturedText(chess) {
    const { byWhite, byBlack, diff } = capturedLine(chess);
    if (!byWhite && !byBlack) return null;
    const lead = diff === 0 ? t('board.materialEqual') : t('board.materialLead', { side: capitalize(COLOR_NAMES[getLang()][diff > 0 ? 'w' : 'b']), n: Math.abs(diff) });
    return `${t('board.captured')} ♔ ${byWhite || '–'}  ♚ ${byBlack || '–'}  · ${lead}`;
  }

  setLastGame(record) {
    this.lastGame = record;
    save('lastGame', record);
  }

  /** Chess position the user is "looking at": game, puzzle or last game. */
  contextChess() {
    const m = this.mode;
    if (m && m.chess) return m.chess;
    if (this.lastGame) {
      const c = new Chess(this.lastGame.startFen);
      for (const u of this.lastGame.moves) c.move(uciToObj(u));
      return c;
    }
    return null;
  }

  checkAchievements(event) {
    for (const a of ACHIEVEMENTS) {
      if (this.stats.data.achievements[a.id]) continue;
      let ok = false;
      try { ok = a.test(event, this.stats); } catch { ok = false; }
      if (ok && this.stats.unlock(a.id)) {
        this.term.printNode(ui.card(`🏆 ${t('ach.unlocked')}`, [{ t: `${a.icon}  ${t(`ach.${a.id}.title`)}`, c: 'hl' }, { t: t(`ach.${a.id}.desc`), c: 'dim' }], { cls: 'achievement' }), { forceScroll: true });
        this.sound.play('win');
      }
    }
  }

  onEngineEvent(e) {
    if (e.type === 'status') {
      this.refreshStatus();
    } else if (e.type === 'fallback') {
      // Say it once per session and engine pair, not on every move.
      this.fallbackSeen = this.fallbackSeen || new Set();
      const key = `${e.from}>${e.to}`;
      if (this.fallbackSeen.has(key)) return;
      this.fallbackSeen.add(key);
      const from = this.engines.engines[e.from].name;
      const to = this.engines.engines[e.to].name;
      this.term.print(t('engine.fallback', { from, to, msg: (e.error && e.error.message) || '' }), 'warn');
    } else if (e.type === 'local-failed') {
      this.term.print(t('engine.localFailed', { msg: (e.error && e.error.message) || '' }), 'warn');
    }
  }

  // -- voice ------------------------------------------------------------------------------

  onVoice(alts) {
    const notation = this.settings.get('notation');
    const local = (san) => sanToLocal(san, notation);
    const m = this.mode;
    const board = m && (m.name === 'game' || m.name === 'puzzle') && m.chess ? m : null;
    const spoken = alts.map((alt) => ({ alt, n: normalizeSpoken(alt) }));

    // 1. A move that can be played right now (checked first, so "h 3" is the
    //    pawn move and not the "h" help alias).
    if (board) {
      for (const { alt, n } of spoken) {
        const r = parseMove(board.chess, n.compact, { notation: 'en' });
        if (r.ok) {
          this.term.echo(`${alt}  →  ${local(r.move.san)}`, '🎙');
          board.input(moveToUci(r.move));
          this.refresh();
          return;
        }
      }
    }

    // 2. A spoken command ("tabuleiro", "repetir", "continuar"...).
    for (const { alt } of spoken) {
      const raw = stripAccents(alt.toLowerCase()).replace(/[.,!?]/g, '').trim();
      const first = raw.split(/\s+/)[0];
      const cmd = first.length > 1 ? this.commandMap.get(first) : null;
      if (cmd && VOICE_COMMANDS.has(cmd.name)) {
        this.term.echo(alt, '🎙');
        this.execute(raw);
        return;
      }
    }

    // 3. A drill answer ("clara", "sim", "c3 e4 g5"...).
    if (m && m.name === 'drill' && spoken[0].n.spaced) {
      this.term.echo(spoken[0].alt, '🎙');
      this.execute(spoken[0].n.spaced);
      return;
    }

    // 4. A move that can't be played here: explain it like a typed move.
    let playable = null;
    let moveShaped = null;
    for (const { alt, n } of spoken) {
      if (board && !playable) {
        const r = parseMove(board.chess, n.compact, { notation: 'en' });
        if (r.error !== 'syntax') playable = { alt, compact: n.compact, r };
      }
      if (!moveShaped && MOVE_LIKE.test(n.compact)) moveShaped = { alt, compact: n.compact };
    }
    if (playable) {
      this.term.echo(`${playable.alt}  →  ${local(playable.compact)}`, '🎙');
      if (board.name === 'game' && !board.isPlayerTurn()) this.term.print(t(board.result ? 'game.isOver' : 'game.notYourTurn'), 'warn');
      else if (board.name === 'game') board.reportIllegal(playable.r, local(playable.compact));
      else if (playable.r.error === 'ambiguous') this.term.print(t('move.ambiguous', { list: playable.r.candidates.map(local).join(', ') }), 'err');
      else this.term.print(t('move.illegal', { input: local(playable.compact) }), 'err');
      this.refresh();
      return;
    }
    if (moveShaped && !board) {
      // Heard a move, but there is no game or puzzle to play it in.
      this.term.echo(`${moveShaped.alt}  →  ${local(moveShaped.compact)}`, '🎙');
      this.term.print(t('voice.noGame', { move: local(moveShaped.compact) }), 'warn');
      if (load('game')) this.term.print([t('voice.resumeHint.pre'), { t: 'resume', cmd: 'resume', run: true }, t('voice.resumeHint.mid'), { t: 'play', cmd: 'play', run: true }], 'dim');
      else this.term.print([t('voice.playHint'), ' ', { t: 'play', cmd: 'play', run: true }], 'dim');
      this.speaker.say(t('voice.noGameSpeech'));
      return;
    }

    // 5. Nothing usable: show what was heard and how it was read.
    const heard = spoken[0].n.spaced;
    const same = !heard || heard.toLowerCase() === String(alts[0]).toLowerCase().trim();
    this.term.print(t('voice.notUnderstood', { text: alts[0] }) + (same ? '' : ' ' + t('voice.heardAs', { text: heard })), 'warn');
    this.term.print(t('voice.tryLike'), 'dim');
  }

  onListenState(on) {
    const mic = document.getElementById('mic-btn');
    if (mic) mic.classList.toggle('on', !!on);
    this.refresh();
  }

  /** Explain a speech-recognition failure: what failed, how to fix it, raw detail. */
  onListenError({ code, message, restart }) {
    const plat = this.listener.platform;
    if (code === 'no-speech') {
      this.term.print(t('listen.noSpeech'), 'dim');
      return;
    }
    this.sound.play('error');
    if (restart && (code === 'not-allowed' || code === 'service-not-allowed')) {
      // It worked before; only the automatic restart was refused.
      this.term.print(t('listen.restartRefused'), 'warn');
      return;
    }
    const kind = {
      'not-allowed': 'mic', 'service-not-allowed': 'service', 'audio-capture': 'audio',
      network: 'network', 'language-not-supported': 'language',
    }[code] || 'generic';
    this.term.print(t(`listen.err.${kind}`, { lang: this.listener.lang, code }), 'err');
    const fixKey = `listen.fix.${plat.iOS ? 'ios' : 'desktop'}.${kind}`;
    if (hasKey(fixKey)) for (const line of t(fixKey).split('\n')) this.term.print(line, 'dim');
    if (plat.iOS && plat.standalone && (kind === 'service' || kind === 'mic')) this.term.print(t('listen.fix.standalone'), 'warn');
    this.term.print([t('listen.detail', { code, message: message || '—' }), ' ', { t: 'listen info', cmd: 'listen info', run: true }], 'dim');
  }

  // -- commands --------------------------------------------------------------------------

  buildCommands() {
    const C = [];
    const add = (name, aliases, group, usage, run, complete = null) => C.push({ name, aliases, group, usage, run, complete });
    const levels = () => Object.keys(LEVELS);
    const onoff = () => ['on', 'off'];

    // --- play ---
    add('play', ['new', 'jogar', 'novo', 'start', 'partida'], 'play', 'play [white|black|random] [1-10]', (a) => this.cmdPlay(a), () => ['white', 'black', 'random', ...levels()]);
    add('resume', ['continue', 'continuar', 'retomar'], 'play', 'resume', () => this.cmdResume());
    add('go', ['jogue', 'move'], 'play', 'go', () => (this.game ? this.game.go() : this.noGame()));
    add('undo', ['takeback', 'back', 'voltar', 'desfazer'], 'play', 'undo', () => (this.game ? this.game.undo() : this.noGame()));
    add('resign', ['abandonar', 'desistir', 'abandon'], 'play', 'resign', () => this.cmdResign());
    add('draw', ['empate', 'offerdraw'], 'play', 'draw', () => (this.game ? this.game.offerDraw() : this.noGame()));
    add('repeat', ['again', 'repetir', 'denovo'], 'play', 'repeat', () => this.cmdRepeat());
    add('moves', ['history', 'lances', 'historico', 'score'], 'play', 'moves', () => this.cmdMoves());
    add('time', ['tempo'], 'play', 'time', () => this.cmdTime());

    // --- aids (count as peeks in blindfold mode) ---
    add('board', ['peek', 'tabuleiro', 'ver'], 'aids', 'board [unicode|ascii|shadow]', (a) => this.cmdBoard(a), () => ['unicode', 'ascii', 'shadow']);
    add('pieces', ['list', 'pecas', 'position', 'posicao'], 'aids', 'pieces', () => this.cmdPieces());
    add('where', ['onde', 'find'], 'aids', 'where [white|black] <piece>', (a) => this.cmdWhere(a), () => ['knight', 'bishop', 'rook', 'queen', 'king', 'pawn', 'white', 'black']);
    add('what', ['sq', 'square', 'casa', 'oque'], 'aids', 'what <square>', (a) => this.cmdWhat(a));
    add('legal', ['legais', 'options'], 'aids', 'legal', () => this.cmdLegal());
    add('hint', ['dica', 'help-me', 'ajudinha'], 'aids', 'hint', () => this.cmdHint());
    add('eval', ['evaluate', 'avaliar', 'avaliacao', 'analysis'], 'aids', 'eval [FEN]', (a, raw) => this.cmdEval(raw));

    // --- training ---
    add('train', ['training', 'treinar', 'treino', 'menu'], 'train', 'train', () => this.cmdTrain());
    add('drill', ['exercise', 'exercicio', 'ex'], 'train', 'drill <colors|diagonals|knight|visualize|memory> [n] [easy|hard]', (a) => this.cmdDrill(a), () => [...DRILL_KINDS, 'easy', 'normal', 'hard']);
    add('puzzle', ['puzzles', 'problema', 'problemas', 'tactics', 'taticas'], 'train', 'puzzle [any|mate1|mate2|mate3|online]', (a) => this.cmdPuzzle(a), () => ['any', 'mate1', 'mate2', 'mate3', 'online']);
    add('next', ['proximo', 'nextpuzzle', 'outro'], 'train', 'next', () => this.cmdNext());
    add('skip', ['pular', 'pass', 'passar'], 'train', 'skip', () => this.cmdSkip());
    add('solution', ['solucao', 'resposta', 'answer', 'reveal'], 'train', 'solution', () => this.cmdSolution());
    add('review', ['analyze', 'analyse', 'analisar', 'revisar', 'analise'], 'train', 'review [fast|deep]', (a) => this.cmdReview(a), () => ['fast', 'deep']);
    add('guide', ['guia', 'tutorial', 'howto', 'plano'], 'train', 'guide', () => this.cmdGuide());
    add('stop', ['quit', 'exit', 'sair', 'parar', 'leave', 'fim'], 'train', 'stop', () => this.stopMode());

    // --- position / export ---
    add('fen', [], 'position', 'fen [FEN]', (a, raw) => this.cmdFen(raw));
    add('pgn', [], 'position', 'pgn', () => this.cmdPgn());
    add('load', ['carregar', 'setup', 'position-load'], 'position', 'load <FEN|PGN>', (a, raw) => this.cmdLoad(raw));
    add('copy', ['copiar', 'clipboard'], 'position', 'copy', () => this.cmdCopy());
    add('download', ['baixar', 'save', 'salvar'], 'position', 'download', () => this.cmdDownload());
    add('lichess', ['analysisboard', 'abrir'], 'position', 'lichess', () => this.cmdLichess());

    // --- settings ---
    add('level', ['nivel', 'strength', 'forca', 'lvl'], 'settings', 'level [1-10]', (a) => this.cmdLevel(a), levels);
    add('elo', [], 'settings', 'elo [1320-3190|off]', (a) => this.cmdElo(a), () => ['off', '1400', '1600', '1800', '2000', '2200']);
    add('blind', ['blindfold', 'cego', 'vendado', 'venda'], 'settings', 'blind [off|on|strict]', (a) => this.cmdBlind(a), () => ['off', 'on', 'strict']);
    add('engine', ['motor', 'engines'], 'settings', 'engine [auto|local|online|chessapi|basic|test]', (a) => this.cmdEngine(a), () => [...ENGINE_IDS, 'test']);
    add('voice', ['speak', 'voz', 'falar', 'tts'], 'settings', 'voice [on|off|list|rate <0.5-2>|<n>|test]', (a) => this.cmdVoice(a), () => ['on', 'off', 'list', 'rate', 'test']);
    add('listen', ['mic', 'ouvir', 'microfone', 'microphone'], 'settings', 'listen [on|off|info]', (a) => this.cmdListen(a), () => ['on', 'off', 'info']);
    add('sound', ['som', 'sfx', 'beep'], 'settings', 'sound [on|off]', (a) => this.cmdToggle('sound', a, 'set.sound'), onoff);
    add('notation', ['notacao'], 'settings', 'notation [en|pt]', (a) => this.cmdNotation(a), () => ['en', 'pt']);
    add('lang', ['language', 'idioma', 'lingua'], 'settings', 'lang [en|pt]', (a) => this.cmdLang(a), () => ['en', 'pt']);
    add('theme', ['tema', 'color', 'cores-tema'], 'settings', `theme [${THEMES.join('|')}]`, (a) => this.cmdTheme(a), () => THEMES);
    add('crt', ['scanlines'], 'settings', 'crt [on|off]', (a) => this.cmdToggle('crt', a, 'set.crt'), onoff);
    add('font', ['fonte', 'zoom', 'size'], 'settings', 'font [12-24|+|-|auto]', (a) => this.cmdFont(a), () => ['auto', '+', '-', '14', '16', '18', '20']);
    add('clock', ['relogio', 'timecontrol', 'tc'], 'settings', 'clock [5+3|10|off]', (a) => this.cmdClock(a), () => ['off', '1+0', '3+2', '5+3', '10+5', '15+10', '30+0']);
    add('announce', ['anunciar', 'anuncio'], 'settings', 'announce [san|full]', (a) => this.cmdAnnounce(a), () => ['san', 'full']);
    add('boardstyle', ['estilo'], 'settings', 'boardstyle [unicode|ascii]', (a) => this.cmdBoardStyle(a), () => ['unicode', 'ascii']);
    add('settings', ['config', 'configuracoes', 'opcoes', 'options', 'prefs'], 'settings', 'settings [reset]', (a) => this.cmdSettings(a), () => ['reset']);

    // --- info ---
    add('stats', ['statistics', 'estatisticas', 'progresso', 'progress'], 'info', 'stats [reset]', (a) => this.cmdStats(a), () => ['reset']);
    add('achievements', ['conquistas', 'badges', 'trophies', 'trofeus'], 'info', 'achievements', () => this.cmdAchievements());
    add('about', ['sobre', 'credits', 'creditos', 'version', 'versao'], 'info', 'about', () => this.cmdAbout());
    add('help', ['?', 'ajuda', 'h', 'comandos', 'commands', 'man'], 'info', 'help [command]', (a) => this.cmdHelp(a), () => C.map((c) => c.name));
    add('clear', ['cls', 'limpar', 'clean'], 'info', 'clear', () => this.term.clear());
    return C;
  }

  noGame() {
    this.term.print([t('err.noGameActive'), ' ', { t: 'play', cmd: 'play', run: true }, ' · ', { t: 'resume', cmd: 'resume', run: true }], 'warn');
  }

  // --- play ---

  cmdPlay(args) {
    let color = 'w';
    let level = this.settings.get('level');
    let colorSet = false;
    for (const a of args) {
      const x = stripAccents(a);
      if (WHITE.includes(x)) { color = 'w'; colorSet = true; }
      else if (BLACK.includes(x)) { color = 'b'; colorSet = true; }
      else if (RANDOM.includes(x)) { color = Math.random() < 0.5 ? 'w' : 'b'; colorSet = true; }
      else if (/^\d+$/.test(x) && +x >= 1 && +x <= 10) {
        level = +x;
        this.settings.set('level', level);
        this.settings.set('elo', null);
      } else {
        this.term.print(t('play.badArg', { arg: a }), 'err');
        return;
      }
    }
    if (!colorSet) color = this.settings.get('color') === 'black' ? 'b' : 'w';
    else this.settings.set('color', color === 'w' ? 'white' : 'black');
    this.startGame({ color, level });
  }

  /** True when starting would throw away an unfinished game (asks to confirm). */
  needsAbandonConfirm(key) {
    const g = this.game;
    const saved = load('game');
    const unfinished = (g && !g.result && g.chess.history().length) || (!g && saved && saved.moves && saved.moves.length);
    return unfinished && !this.confirm(key, t('play.confirmAbandon'));
  }

  startGame({ color, level = this.settings.get('level'), startFen = null, confirmKey = 'play' }) {
    if (this.needsAbandonConfirm(confirmKey)) return false;
    const game = new GameMode(this, {
      color,
      level,
      elo: this.settings.get('elo'),
      clock: this.settings.get('clock'),
      startFen,
    });
    if (this.mode && this.mode.name === 'game') this.mode.result = this.mode.result || 'abandoned';
    this.setMode(game);
    game.start();
    return true;
  }

  cmdResume() {
    const data = load('game');
    if (!data || !data.moves) {
      this.term.print([t('resume.none'), ' ', { t: 'play', cmd: 'play', run: true }], 'warn');
      return;
    }
    if (this.game && this.game.id === data.id && !this.game.result) {
      this.term.print(t('resume.already'), 'dim');
      return;
    }
    let game;
    try {
      game = GameMode.restore(this, data);
    } catch (err) {
      this.term.print(t('resume.corrupt'), 'err');
      remove('game');
      return;
    }
    this.setMode(game);
    game.start({ resumed: true });
  }

  cmdResign() {
    const g = this.game;
    if (!g) return this.noGame();
    if (g.result) return this.term.print(t('game.isOver'), 'warn');
    if (!this.confirm('resign', t('resign.confirm'))) return;
    g.resign();
  }

  cmdRepeat() {
    const m = this.mode;
    if (m && m.name === 'game') {
      const san = m.lastEngineSan;
      if (!san) return this.term.print(t('repeat.nothing'), 'dim');
      this.term.print([{ t: t('repeat.last') + ' ', c: 'dim' }, { t: sanToLocal(san, this.settings.get('notation')), c: 'opp' }, { t: '  ' + (m.lastMoveText() ? t('repeat.lastPly', { move: m.lastMoveText() }) : ''), c: 'dim' }]);
      this.speaker.say(sanToSpeech(san, getLang()), { force: true });
      return;
    }
    if (m && m.current && m.current.text) {
      this.term.print(m.current.text, 'hl');
      this.speaker.say(m.current.speech || m.current.text, { force: true });
      return;
    }
    if (this.lastSaid) {
      this.term.print(this.lastSaid, 'dim');
      this.speaker.say(this.lastSaid, { force: true });
      return;
    }
    this.term.print(t('repeat.nothing'), 'dim');
  }

  cmdMoves() {
    const m = this.mode;
    const notation = this.settings.get('notation');
    if (m && m.name === 'game') {
      const sans = m.chess.history();
      if (!sans.length) return this.term.print(t('moves.none'), 'dim');
      this.term.print(movesToText(sans, m.startFen, notation), 'moves-line');
      return;
    }
    if (this.lastGame && this.lastGame.sans.length) {
      this.term.print(t('moves.lastGame'), 'dim');
      this.term.print(movesToText(this.lastGame.sans, this.lastGame.startFen, notation), 'moves-line');
      return;
    }
    this.term.print(t('moves.none'), 'dim');
  }

  cmdTime() {
    const g = this.game;
    if (!g) return this.noGame();
    const c = g.clockText();
    if (!c) return this.term.print([t('time.noClock'), ' ', { t: 'clock 5+3', cmd: 'clock 5+3', run: false }], 'dim');
    const text = t('time.status', c);
    this.term.print(text, c.low ? 'err' : 'hl');
    this.speaker.say(text, { force: true });
  }

  // --- aids ---

  cmdBoard(args) {
    const style = ['unicode', 'ascii', 'shadow'].includes(args[0]) ? args[0] : null;
    const m = this.mode;
    if (m && m.name === 'game') {
      if (!m.allowAid('peeks')) return;
      m.countAid('peeks');
      m.showBoard(style);
      return;
    }
    if (m && (m.name === 'drill' || m.boardForPeek)) {
      const chess = m.boardForPeek ? m.boardForPeek() : null;
      if (!chess) return this.term.print(t('drill.noBoard'), 'warn');
      this.showBoard(chess, { flip: m.name === 'puzzle' && m.solver === 'b', style });
      return;
    }
    const chess = this.contextChess() || new Chess();
    const side = [];
    if (this.lastGame && !m) side.push(t('board.lastGameFinal', { result: this.lastGame.result }));
    this.showBoard(chess, { flip: this.lastGame && !m ? this.lastGame.color === 'b' : false, style, side });
  }

  piecesOf(chess) {
    const notation = this.settings.get('notation');
    const lang = getLang();
    const pieces = listPieces(chess);
    this.term.printList(['w', 'b'].map((c) => {
      const { officers, pawns } = piecesToText(pieces[c], notation);
      return [
        { t: capitalize(COLOR_NAMES[lang][c]), c: 'hl' },
        [{ t: officers.join(' '), c: 'fg' }, pawns.length ? { t: `  ·  ${t('puzzle.pawns')}: ${pawns.join(' ')}` } : ''],
      ];
    }), { cls: 'pieces-list' });
  }

  cmdPieces() {
    const m = this.mode;
    if (m && m.name === 'game') {
      if (!m.allowAid('peeks')) return;
      m.countAid('peeks');
      this.piecesOf(m.chess);
      return;
    }
    const chess = this.contextChess();
    if (!chess) return this.noGame();
    if (m && m.name === 'drill') return this.term.print(t('drill.noBoard'), 'warn');
    this.piecesOf(chess);
  }

  cmdWhere(args) {
    const m = this.mode;
    const chess = m && m.chess ? m.chess : null;
    if (!chess || (m.name !== 'game' && m.name !== 'puzzle')) return this.noGame();
    if (m.name === 'game' && !m.allowAid('queries')) return;
    let color = m.name === 'game' ? m.playerColor : m.solver || chess.turn();
    let type = null;
    for (const a of args) {
      const x = stripAccents(a);
      if (WHITE.includes(x)) color = 'w';
      else if (BLACK.includes(x) && x !== 'b' && x !== 'p') color = 'b';
      else if (['their', 'opponent', 'enemy', 'adversario', 'oponente', 'dele'].includes(x)) color = (m.name === 'game' ? m.playerColor : m.solver || chess.turn()) === 'w' ? 'b' : 'w';
      else {
        const tp = pieceType(x);
        if (tp) type = tp;
      }
    }
    if (!type) return this.term.print(t('where.usage'), 'warn');
    if (m.name === 'game') m.countAid('queries');
    const squares = chess.findPiece({ type, color }).sort();
    const lang = getLang();
    const name = squares.length > 1 ? PIECE_NAMES_PLURAL[lang][type] : PIECE_NAMES[lang][type];
    const who = capitalize(COLOR_NAMES[lang][color]);
    const text = squares.length ? t('where.result', { who, piece: name, squares: squares.join(', ') }) : t('where.none', { who, piece: PIECE_NAMES_PLURAL[lang][type] });
    this.term.print(text, 'hl');
    this.speaker.say(text);
  }

  cmdWhat(args) {
    const m = this.mode;
    const chess = m && m.chess ? m.chess : null;
    if (!chess || (m.name !== 'game' && m.name !== 'puzzle')) return this.noGame();
    const sq = (args[0] || '').toLowerCase();
    if (!isSquare(sq)) return this.term.print(t('what.usage'), 'warn');
    if (m.name === 'game') {
      if (!m.allowAid('queries')) return;
      m.countAid('queries');
    }
    const p = chess.get(sq);
    const lang = getLang();
    const text = p ? t('what.result', { sq, color: COLOR_NAMES[lang][p.color], piece: PIECE_NAMES[lang][p.type] }) : t('what.empty', { sq });
    this.term.print(text, 'hl');
    this.speaker.say(text);
  }

  cmdLegal() {
    const m = this.mode;
    if (!m || !m.chess || (m.name !== 'game' && m.name !== 'puzzle')) return this.noGame();
    if (m.name === 'game') {
      if (!m.allowAid('queries')) return;
      m.countAid('queries');
    }
    const notation = this.settings.get('notation');
    const moves = m.chess.moves().map((s) => sanToLocal(s, notation));
    this.term.print(moves.length ? t('legal.list', { n: moves.length, moves: moves.join(' ') }) : t('legal.none'), 'dim');
  }

  cmdHint() {
    const m = this.mode;
    if (m && m.name === 'game') return m.giveHint();
    if (m && m.name === 'puzzle') return m.hint();
    if (m && m.name === 'drill') return this.term.print(t(`drill.${m.kind}.format`), 'dim');
    this.noGame();
  }

  cmdEval(raw) {
    if (raw) {
      const fen = raw.trim();
      if (!validateFen(fen).ok) return this.term.print(t('fen.invalid', { msg: validateFen(fen).error }), 'err');
      return this.evalFen(fen);
    }
    const m = this.mode;
    if (m && m.name === 'game') return m.evaluate();
    if (m && m.name === 'puzzle') return this.term.print(t('eval.noSpoilers'), 'warn');
    const chess = this.contextChess();
    if (!chess) return this.noGame();
    return this.evalFen(chess.fen());
  }

  async evalFen(fen) {
    const fake = new GameMode(this, { color: 'w', level: 10, startFen: fen });
    fake.result = 'analysis';
    await fake.evaluate();
  }

  // --- training ---

  cmdTrain() {
    const items = [
      ['drill colors', 'menu.colors'],
      ['drill diagonals', 'menu.diagonals'],
      ['drill knight', 'menu.knight'],
      ['drill visualize', 'menu.visualize'],
      ['drill memory', 'menu.memory'],
      ['puzzle', 'menu.puzzle'],
      ['play white 1', 'menu.easyGame'],
      ['guide', 'menu.guide'],
    ];
    this.setMode(new MenuMode(this, items.map(([cmd]) => cmd)));
    this.term.print([{ t: '☰ ', c: 'accent' }, { t: t('menu.title'), c: 'hl' }]);
    this.term.printList(items.map(([cmd, key], i) => {
      const best = cmd.startsWith('drill ') ? this.stats.drillBest(cmd.slice(6)) : null;
      return [
        [{ t: `${i + 1}. `, c: 'num' }, { t: t(`${key}.title`), cmd, run: true, c: 'cmd' }],
        [t(`${key}.desc`), best ? { t: `  🏅 ${best.correct}/${best.total}`, c: 'accent' } : null],
      ];
    }));
  }

  cmdDrill(args) {
    const kindArg = args.find((a) => DRILL_ALIASES[stripAccents(a)]);
    if (!kindArg) {
      this.term.print(t('drill.usage'), 'warn');
      this.term.printList(DRILL_KINDS.map((k) => [{ t: `drill ${k}`, cmd: `drill ${k}`, run: true, c: 'cmd' }, t(`drill.${k}.title`)]));
      return;
    }
    const kind = DRILL_ALIASES[stripAccents(kindArg)];
    const num = args.find((a) => /^\d+$/.test(a));
    const diff = args.find((a) => ['easy', 'normal', 'hard', 'facil', 'dificil'].includes(stripAccents(a)));
    const difficulty = diff ? { facil: 'easy', dificil: 'hard' }[stripAccents(diff)] || diff : undefined;
    const drill = createDrill(this, kind, { total: num ? +num : undefined, difficulty });
    this.setMode(drill);
    drill.start();
  }

  cmdPuzzle(args) {
    const theme = PUZZLE_ALIASES[stripAccents(args[0] || 'any')];
    if (!theme) return this.term.print(t('puzzle.usage'), 'warn');
    const mode = new PuzzleMode(this, theme);
    this.setMode(mode);
    mode.start();
  }

  cmdNext() {
    const m = this.mode;
    if (m && m.name === 'puzzle') return m.next();
    if (m && m.name === 'drill') return m.skip();
    this.term.print(t('next.nothing'), 'dim');
  }

  cmdSkip() {
    const m = this.mode;
    if (m && m.name === 'drill') return m.skip();
    if (m && m.name === 'puzzle') return m.next();
    this.term.print(t('next.nothing'), 'dim');
  }

  cmdSolution() {
    const m = this.mode;
    if (m && m.name === 'puzzle') return m.showSolution();
    if (m && m.name === 'drill') return m.skip();
    this.term.print(t('next.nothing'), 'dim');
  }

  cmdReview(args) {
    const g = this.game;
    if (g && !g.result) {
      this.term.print([t('review.inProgress'), ' ', { t: 'eval', cmd: 'eval', run: true }], 'warn');
      return;
    }
    const record = this.lastGame;
    if (!record || !record.moves || !record.moves.length) return this.term.print(t('review.nothing'), 'warn');
    const movetime = args[0] === 'fast' ? 120 : args[0] === 'deep' ? 900 : 300;
    const mode = new ReviewMode(this, record, { movetime });
    this.setMode(mode);
    mode.start();
  }

  cmdGuide() {
    const steps = [1, 2, 3, 4, 5, 6, 7];
    const rows = steps.map((i) => {
      const line = document.createElement('div');
      line.className = 'card-line guide-step';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = `${i}. `;
      const title = document.createElement('span');
      title.className = 'hl';
      title.textContent = t(`guide.${i}.title`);
      const desc = document.createElement('div');
      desc.className = 'dim';
      desc.textContent = t(`guide.${i}.desc`);
      const cmd = t(`guide.${i}.cmd`);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmd-link cmd';
      btn.dataset.cmd = cmd;
      btn.dataset.run = '1';
      btn.textContent = cmd;
      line.append(num, title, ' ', btn, desc);
      return line;
    });
    this.term.printNode(ui.card(`🧭 ${t('guide.title')}`, [{ t: t('guide.intro'), c: 'dim' }, ...rows, { t: t('guide.outro'), c: 'dim' }], { cls: 'guide' }), { forceScroll: true });
  }

  // --- position ---

  cmdFen(raw) {
    if (raw) return this.cmdLoad(raw);
    const chess = this.contextChess() || new Chess();
    const m = this.mode;
    if (m && m.name === 'game') {
      if (!m.allowAid('peeks')) return;
      m.countAid('peeks');
    }
    this.term.print(chess.fen(), 'mono-line');
  }

  currentRecord() {
    const g = this.game;
    if (g) return { pgn: g.pgn(), startFen: g.startFen, sans: g.chess.history(), moves: g.movesUci(), finalFen: g.chess.fen() };
    if (this.lastGame) {
      const fake = GameMode.restore(this, { ...this.lastGame, startFen: this.lastGame.startFen });
      fake.result = this.lastGame.outcome;
      fake.resultTag = this.lastGame.result;
      fake.startedAt = Date.parse(this.lastGame.date) || Date.now();
      return { pgn: fake.pgn(), startFen: this.lastGame.startFen, sans: this.lastGame.sans, moves: this.lastGame.moves, finalFen: fake.chess.fen() };
    }
    return null;
  }

  cmdPgn() {
    const rec = this.currentRecord();
    if (!rec) return this.term.print(t('pgn.nothing'), 'warn');
    const pre = document.createElement('pre');
    pre.className = 'pgn';
    pre.textContent = rec.pgn;
    this.term.printNode(pre, { forceScroll: true });
    this.term.print([{ t: 'copy', cmd: 'copy', run: true }, ' · ', { t: 'download', cmd: 'download', run: true }, ' · ', { t: 'lichess', cmd: 'lichess', run: true }], 'dim');
  }

  cmdLoad(raw) {
    const text = (raw || '').trim();
    if (!text) return this.term.print(t('load.usage'), 'warn');
    if (validateFen(text).ok) {
      const c = new Chess(text);
      if (c.isGameOver()) return this.term.print(t('load.gameOver'), 'err');
      if (this.startGame({ color: c.turn(), startFen: text, confirmKey: 'load' })) this.term.print(t('load.fenOk'), 'ok');
      return;
    }
    // Try PGN (full or just movetext).
    const c = new Chess();
    try {
      c.loadPgn(text);
    } catch {
      const parts = text.split(/\s+/).filter(Boolean);
      if (parts.length >= 4 && /^[rnbqkpRNBQKP1-8/]+$/.test(parts[0])) {
        return this.term.print(t('fen.invalid', { msg: validateFen(text).error }), 'err');
      }
      return this.term.print(t('load.invalid'), 'err');
    }
    if (!c.history().length) return this.term.print(t('load.invalid'), 'err');
    if (c.isGameOver()) return this.term.print(t('load.gameOver'), 'err');
    const headers = c.getHeaders();
    const startFen = headers.FEN || STD_FEN;
    const color = c.turn();
    if (this.needsAbandonConfirm('load')) return;
    const game = new GameMode(this, {
      color, level: this.settings.get('level'), elo: this.settings.get('elo'), clock: this.settings.get('clock'),
      startFen, moves: c.history({ verbose: true }).map(moveToUci),
    });
    if (this.game) this.game.result = this.game.result || 'abandoned';
    this.term.print(t('load.pgnOk', { n: c.history().length }), 'ok');
    this.setMode(game);
    game.start({ resumed: true });
  }

  async cmdCopy() {
    const rec = this.currentRecord();
    if (!rec) return this.term.print(t('pgn.nothing'), 'warn');
    const ok = await copyText(rec.pgn);
    this.term.print(ok ? t('copy.ok') : t('copy.fail'), ok ? 'ok' : 'err');
  }

  cmdDownload() {
    const rec = this.currentRecord();
    if (!rec) return this.term.print(t('pgn.nothing'), 'warn');
    try {
      const blob = new Blob([rec.pgn + '\n'], { type: 'application/x-chess-pgn' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `blind-chess-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pgn`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      this.term.print(t('download.ok'), 'ok');
    } catch {
      this.term.print(t('copy.fail'), 'err');
    }
  }

  cmdLichess() {
    const rec = this.currentRecord();
    const chess = rec ? null : this.contextChess();
    let url;
    if (rec && rec.startFen === STD_FEN && rec.sans.length) url = 'https://lichess.org/analysis/pgn/' + rec.sans.map(encodeURIComponent).join('_');
    else url = 'https://lichess.org/analysis/' + (rec ? rec.finalFen : (chess || new Chess()).fen()).replace(/ /g, '_');
    const w = window.open(url, '_blank', 'noopener');
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = url;
    this.term.print([w ? t('lichess.opened') + ' ' : t('lichess.open') + ' ', a], 'dim');
  }

  // --- settings ---

  cmdLevel(args) {
    if (!args.length) {
      const cur = this.settings.get('elo') ? `Elo ${this.settings.get('elo')}` : String(this.settings.get('level'));
      this.term.print(t('level.current', { level: cur }), 'hl');
      const rows = Object.entries(LEVELS).map(([n, l]) => [
        { t: n, cmd: `level ${n}`, run: true },
        n === '10' ? 'max' : `~${l.elo}`,
        t(`level.desc.${n <= 3 ? 'human' : n === '4' ? 'skill' : n === '10' ? 'max' : 'elo'}`),
      ]);
      this.term.printNode(ui.table([t('level.h.level'), 'Elo', t('level.h.style')], rows.map((r) => [linkCell(r[0]), r[1], r[2]])));
      return;
    }
    const n = parseInt(args[0], 10);
    if (!(n >= 1 && n <= 10)) return this.term.print(t('level.bad'), 'err');
    this.settings.set('level', n);
    this.settings.set('elo', null);
    this.term.print(t('level.set', { n, elo: n === 10 ? 'max' : `~${LEVELS[n].elo}` }), 'ok');
    this.applyLevelToGame();
  }

  applyLevelToGame() {
    const g = this.game;
    if (!g || g.result) return;
    g.level = this.settings.get('level');
    g.elo = this.settings.get('elo');
    g.spec = resolveLevel(g.level, g.elo);
    g.save();
    this.term.print(t('level.appliedToGame'), 'dim');
  }

  cmdElo(args) {
    if (!args.length) return this.term.print(t('elo.current', { elo: this.settings.get('elo') || t('elo.none') }), 'hl');
    if (OFF.includes(args[0])) {
      this.settings.set('elo', null);
      this.term.print(t('elo.off'), 'ok');
      this.applyLevelToGame();
      return;
    }
    const n = parseInt(args[0], 10);
    if (!(n >= 1320 && n <= 3190)) return this.term.print(t('elo.bad'), 'err');
    this.settings.set('elo', n);
    this.term.print(t('elo.set', { n }), 'ok');
    this.applyLevelToGame();
  }

  cmdBlind(args) {
    const map = { off: 'off', on: 'on', strict: 'strict', normal: 'on', estrito: 'strict', total: 'strict', desligado: 'off', ligado: 'on', none: 'off', sighted: 'off' };
    if (!args.length) {
      const cur = this.settings.get('blind');
      this.term.print(t('blind.current', { mode: t(`blind.mode.${cur}`) }), 'hl');
      this.term.printList(['off', 'on', 'strict'].map((k) => [{ t: `blind ${k}`, cmd: `blind ${k}`, run: true, c: 'cmd' }, t(`blind.desc.${k}`)]));
      return;
    }
    const v = map[stripAccents(args[0])];
    if (!v) return this.term.print(t('blind.bad'), 'err');
    this.settings.set('blind', v);
    this.term.print(t('blind.set', { mode: t(`blind.mode.${v}`) }), 'ok');
    if (this.game && v === 'off' && !this.game.result) this.game.showBoard();
  }

  async cmdEngine(args) {
    const em = this.engines;
    if (!args.length) {
      const st = em.status();
      this.term.print(t('engine.current', { pref: st.preference, name: em.engines[st.id].name }), 'hl');
      const rows = ['auto', 'local', 'online', 'chessapi', 'basic'].map((id) => {
        let state = '';
        if (id === 'local') state = t(`engine.state.${em.engines.local.state}`);
        else if (id === 'online' || id === 'chessapi') state = navigator.onLine === false ? t('engine.state.offline') : t('engine.state.remote');
        else if (id === 'basic') state = t('engine.state.ready');
        return [linkCell({ t: id, cmd: `engine ${id}`, run: true }), t(`engine.desc.${id}`), state];
      });
      this.term.printNode(ui.table([t('engine.h.id'), t('engine.h.desc'), t('engine.h.state')], rows));
      this.term.print([t('engine.testHint.pre'), { t: 'engine test', cmd: 'engine test', run: true }], 'dim');
      return;
    }
    const id = args[0];
    if (id === 'test') {
      const spin = this.term.spinner(t('engine.testing'));
      const start = Date.now();
      try {
        const res = await em.analyse(STD_FEN, { movetime: 500 });
        spin.stop();
        const line = res.lines[0] || {};
        this.term.print(t('engine.testOk', { name: em.engines[res.engine].name, move: res.bestmove, ms: Date.now() - start, depth: line.depth || '?' }), 'ok');
      } catch (err) {
        spin.stop();
        this.term.print(t('engine.error', { msg: err.message }), 'err');
      }
      return;
    }
    if (!ENGINE_IDS.includes(id)) return this.term.print(t('engine.bad'), 'err');
    this.settings.set('engine', id);
    em.setPreference(id);
    if (id === 'local') em.failures.local = 0;
    em.warmup();
    this.term.print(t('engine.set', { id, desc: t(`engine.desc.${id}`) }), 'ok');
    if (id === 'online' || id === 'chessapi') this.term.print(t('engine.remoteNote'), 'dim');
  }

  cmdVoice(args) {
    const sp = this.speaker;
    if (!sp.supported) return this.term.print(t('voice.unsupported'), 'err');
    const a = args[0];
    if (!a) {
      this.settings.set('speak', !this.settings.get('speak'));
    } else if (ON.includes(a)) {
      this.settings.set('speak', true);
    } else if (OFF.includes(a)) {
      this.settings.set('speak', false);
      sp.stop();
    } else if (a === 'list' || a === 'lista') {
      const voices = sp.voicesForLang();
      if (!voices.length) return this.term.print(t('voice.noVoices'), 'warn');
      const cur = sp.pickVoice();
      voices.forEach((v, i) => this.term.print(['  ', { t: String(i + 1).padStart(2), cmd: `voice ${i + 1}`, run: true, c: 'num' }, ` ${v.name} (${v.lang})`, cur && cur.name === v.name ? { t: '  ◀', c: 'ok' } : ''], 'dim'));
      return;
    } else if (a === 'rate' || a === 'velocidade') {
      const r = parseFloat(args[1]);
      if (!(r >= 0.5 && r <= 2)) return this.term.print(t('voice.badRate'), 'err');
      this.settings.set('rate', r);
      sp.say(t('voice.sample'), { force: true });
      return this.term.print(t('voice.rateSet', { r }), 'ok');
    } else if (a === 'test' || a === 'teste') {
      sp.say(t('voice.sample'), { force: true });
      return;
    } else if (/^\d+$/.test(a)) {
      const v = sp.voicesForLang()[+a - 1];
      if (!v) return this.term.print(t('voice.badIndex'), 'err');
      this.settings.set('voiceName', v.name);
      sp.say(t('voice.sample'), { force: true });
      return this.term.print(t('voice.voiceSet', { name: v.name }), 'ok');
    } else {
      return this.term.print(t('voice.usage'), 'warn');
    }
    const on = this.settings.get('speak');
    this.term.print(on ? t('voice.on') : t('voice.off'), 'ok');
    if (on) sp.say(t('voice.on'), { force: true });
  }

  cmdListen(args) {
    const l = this.listener;
    if (['info', 'diag', 'diagnostico', 'test', 'teste'].includes(args[0])) return this.listenInfo();
    if (!l.supported) {
      this.term.print(t('listen.unsupported'), 'err');
      return this.term.print([t('listen.detail', { code: 'no SpeechRecognition', message: '—' }), ' ', { t: 'listen info', cmd: 'listen info', run: true }], 'dim');
    }
    const want = args[0] ? (ON.includes(args[0]) ? true : OFF.includes(args[0]) ? false : null) : !l.active;
    if (want === null) return this.term.print(t('listen.usage'), 'warn');
    if (!want) {
      l.stop();
      return this.term.print(t('listen.off'), 'ok');
    }
    // The engine's voice would be picked up (and iOS can't record while speaking).
    this.speaker.stop();
    if (!l.start()) return;
    if (l.tapToTalk) {
      this.term.print(t('listen.speakNow'), 'ok');
      if (!this.listenHintShown) this.term.print(t('listen.tapHint'), 'dim');
    } else {
      this.term.print(t('listen.on'), 'ok');
    }
    if (!this.listenHintShown) this.term.print(t('listen.examples'), 'dim');
    this.listenHintShown = true;
  }

  async listenInfo() {
    const l = this.listener;
    const p = l.platform;
    const yes = t('listen.info.yes');
    const no = t('listen.info.no');
    let mic = t('listen.info.unknown');
    try {
      if (navigator.permissions && navigator.permissions.query) mic = (await navigator.permissions.query({ name: 'microphone' })).state;
    } catch { /* not supported by this browser */ }
    const api = typeof window.SpeechRecognition !== 'undefined' ? 'SpeechRecognition' : typeof window.webkitSpeechRecognition !== 'undefined' ? 'webkitSpeechRecognition' : null;
    const rows = [
      [t('listen.info.api'), api ? `${yes} (${api})` : no],
      [t('listen.info.mode'), l.tapToTalk ? t('listen.info.modeTap') : t('listen.info.modeContinuous')],
      [t('listen.info.lang'), l.lang],
      [t('listen.info.micPerm'), mic],
      [t('listen.info.secure'), p.secure ? yes : no],
      [t('listen.info.standalone'), p.standalone ? yes : no],
      [t('listen.info.device'), p.iOS ? 'iOS / iPadOS' : (navigator.platform || '?')],
    ];
    this.term.printNode(ui.card(`🎙 ${t('listen.info.title')}`, rows), { forceScroll: true });
    if (p.iOS) for (const line of t('listen.fix.ios.service').split('\n')) this.term.print(line, 'dim');
  }

  cmdToggle(key, args, msgKey) {
    const a = args[0];
    const v = !a ? !this.settings.get(key) : ON.includes(a) ? true : OFF.includes(a) ? false : null;
    if (v === null) return this.term.print(t('err.onoff'), 'err');
    this.settings.set(key, v);
    this.term.print(t(msgKey, { state: v ? 'on' : 'off' }), 'ok');
    if (key === 'sound' && v) this.sound.play('correct');
  }

  cmdNotation(args) {
    const v = args[0];
    if (!v) return this.term.print(t('notation.current', { n: this.settings.get('notation') }), 'hl');
    if (!['en', 'pt'].includes(v)) return this.term.print(t('notation.bad'), 'err');
    this.settings.set('notation', v);
    this.term.print(t(`notation.set.${v}`), 'ok');
  }

  cmdLang(args) {
    const v = (args[0] || '').slice(0, 2);
    if (!['en', 'pt'].includes(v)) return this.term.print(t('lang.usage'), 'warn');
    this.settings.set('lang', v);
    setLang(v);
    this.applyAppearance();
    this.term.print(t('lang.set'), 'ok');
    if (v === 'pt' && this.settings.get('notation') === 'en') this.term.print([t('lang.notationHint'), ' ', { t: 'notation pt', cmd: 'notation pt', run: true }], 'dim');
  }

  cmdTheme(args) {
    const v = args[0];
    if (!v || !THEMES.includes(v)) {
      if (v) this.term.print(t('theme.bad'), 'err');
      const parts = [t('theme.list') + ' '];
      THEMES.forEach((th, i) => parts.push({ t: th, cmd: `theme ${th}`, run: true, c: th === this.settings.get('theme') ? 'ok' : '' }, i < THEMES.length - 1 ? ' · ' : ''));
      return this.term.print(parts);
    }
    this.settings.set('theme', v);
    this.term.print(t('theme.set', { theme: v }), 'ok');
  }

  cmdFont(args) {
    const a = args[0];
    if (a === 'auto') {
      this.settings.set('fontSize', null);
      return this.term.print(t('font.auto'), 'ok');
    }
    let size = this.settings.get('fontSize') || Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-size'))) || 15;
    if (a === '+') size++;
    else if (a === '-') size--;
    else if (/^\d+$/.test(a || '')) size = +a;
    else return this.term.print(t('font.current', { n: size }), 'hl');
    size = Math.max(11, Math.min(26, size));
    this.settings.set('fontSize', size);
    this.term.print(t('font.set', { n: size }), 'ok');
  }

  cmdClock(args) {
    const a = args.join('');
    if (!a) {
      const c = this.settings.get('clock');
      return this.term.print(c ? t('clock.current', { base: c.base / 60, inc: c.inc }) : t('clock.none'), 'hl');
    }
    if (OFF.includes(a) || a === 'none') {
      this.settings.set('clock', null);
      return this.term.print(t('clock.off'), 'ok');
    }
    const m = a.match(/^(\d+(?:\.\d+)?)(?:\+(\d+))?$/);
    if (!m || +m[1] <= 0 || +m[1] > 180) return this.term.print(t('clock.bad'), 'err');
    const clock = { base: Math.round(+m[1] * 60), inc: +(m[2] || 0) };
    this.settings.set('clock', clock);
    this.term.print(t('clock.set', { base: +m[1], inc: clock.inc }), 'ok');
  }

  cmdAnnounce(args) {
    const v = args[0];
    if (!['san', 'full'].includes(v)) return this.term.print(t('announce.usage'), 'warn');
    this.settings.set('announce', v);
    this.term.print(t(`announce.set.${v}`), 'ok');
  }

  cmdBoardStyle(args) {
    const v = args[0];
    if (!['unicode', 'ascii'].includes(v)) return this.term.print(t('boardstyle.usage'), 'warn');
    this.settings.set('boardStyle', v);
    this.term.print(t('boardstyle.set', { v }), 'ok');
  }

  cmdSettings(args) {
    if (args[0] === 'reset') {
      if (!this.confirm('settings', t('settings.confirmReset'))) return;
      this.settings.reset();
      setLang(this.settings.get('lang'));
      this.engines.setPreference(this.settings.get('engine'));
      return this.term.print(t('settings.resetDone'), 'ok');
    }
    const s = this.settings;
    const clock = s.get('clock');
    const rows = [
      ['lang', s.get('lang'), 'lang pt'],
      ['notation', s.get('notation'), 'notation pt'],
      ['level', s.get('elo') ? `Elo ${s.get('elo')}` : `${s.get('level')} (~${LEVELS[s.get('level')].elo})`, 'level'],
      ['blind', s.get('blind'), 'blind'],
      ['engine', s.get('engine'), 'engine'],
      ['clock', clock ? `${clock.base / 60}+${clock.inc}` : 'off', 'clock 5+3'],
      ['voice', s.get('speak') ? `on · ${s.get('rate')}x` : 'off', 'voice'],
      ['listen', this.listener.active ? 'on' : 'off', 'listen'],
      ['sound', s.get('sound') ? 'on' : 'off', 'sound'],
      ['announce', s.get('announce'), 'announce full'],
      ['theme', s.get('theme'), 'theme'],
      ['crt', s.get('crt') ? 'on' : 'off', 'crt'],
      ['font', s.get('fontSize') ? `${s.get('fontSize')}px` : 'auto', 'font +'],
      ['boardstyle', s.get('boardStyle'), 'boardstyle ascii'],
    ];
    this.term.printNode(ui.table([t('settings.h.setting'), t('settings.h.value'), t('settings.h.change')], rows.map(([k, v, cmd]) => [k, { t: v, c: 'accent' }, linkCell({ t: cmd, cmd, run: false })])));
    this.term.print([t('settings.resetHint'), ' ', { t: 'settings reset', cmd: 'settings reset', run: false }], 'dim');
  }

  // --- info ---

  cmdStats(args) {
    if (args[0] === 'reset') {
      if (!this.confirm('stats', t('stats.confirmReset'))) return;
      this.stats.reset();
      return this.term.print(t('stats.resetDone'), 'ok');
    }
    const d = this.stats.data;
    const g = d.games;
    const p = d.puzzles;
    const rows = [
      [t('stats.games'), g.played ? t('stats.gamesValue', g) : '—'],
      [t('stats.blindWins'), String(g.blindWins)],
      [t('stats.puzzles'), p.attempted ? t('stats.puzzlesValue', { solved: p.solved, attempted: p.attempted, rating: Math.round(p.rating), peak: Math.round(p.peak), best: p.bestStreak }) : '—'],
      [t('stats.days'), t('stats.daysValue', { n: d.days.length, streak: this.stats.streakDays() })],
      d.reviews.count ? [t('stats.reviews'), t('stats.reviewsValue', { n: d.reviews.count, last: d.reviews.lastAccuracy.toFixed(1), best: d.reviews.bestAccuracy.toFixed(1) })] : null,
    ];
    this.term.printNode(ui.card(`📊 ${t('stats.title')}`, rows, { cls: 'stats' }), { forceScroll: true });
    const drillRows = DRILL_KINDS.filter((k) => d.drills[k]).map((k) => {
      const x = d.drills[k];
      const acc = x.answered ? Math.round((x.correct / x.answered) * 100) : 0;
      return [t(`drill.${k}.title`), String(x.sessions), `${ui.bar(acc, 100, 10)} ${acc}%`, x.best ? `${x.best.correct}/${x.best.total} · ${(x.best.avgMs / 1000).toFixed(2)}s` : '—'];
    });
    if (drillRows.length) this.term.printNode(ui.table([t('stats.h.drill'), t('stats.h.sessions'), t('stats.h.accuracy'), t('stats.h.best')], drillRows));
    const levels = Object.entries(g.byLevel);
    if (levels.length) {
      this.term.printNode(ui.table([t('stats.h.level'), t('stats.h.wdl'), ''], levels.sort().map(([k, v]) => {
        const n = v.win + v.draw + v.loss;
        return [k.startsWith('elo') ? `Elo ${k.slice(3)}` : `${t('level.h.level')} ${k}`, `${v.win} / ${v.draw} / ${v.loss}`, ui.bar(v.win + v.draw / 2, n, 12)];
      })));
    }
    if (g.recent.length) {
      this.term.print(t('stats.recent'), 'dim');
      for (const r of g.recent.slice(0, 5)) {
        this.term.print([
          { t: `  ${r.date.slice(0, 10)} `, c: 'dim' },
          { t: r.result.padEnd(8), c: r.outcome === 'win' ? 'ok' : r.outcome === 'loss' ? 'err' : 'warn' },
          `${r.color === 'w' ? '♔' : '♚'} ${r.elo ? 'Elo ' + r.elo : t('level.h.level') + ' ' + r.level}`,
          r.blindScore != null ? { t: `  👁 ${r.blindScore}/100`, c: 'accent' } : '',
          r.opening ? { t: `  ${r.opening}`, c: 'dim' } : '',
        ]);
      }
    }
    if (!g.played && !p.attempted && !drillRows.length) this.term.print([t('stats.empty'), ' ', { t: 'train', cmd: 'train', run: true }], 'dim');
  }

  cmdAchievements() {
    const got = this.stats.data.achievements;
    const n = Object.keys(got).length;
    this.term.print([{ t: '🏆 ', c: 'accent' }, { t: t('ach.title', { n, total: ACHIEVEMENTS.length }), c: 'hl' }]);
    this.term.printList(ACHIEVEMENTS.map((a) => {
      const date = got[a.id];
      return [
        [{ t: date ? `${a.icon} ` : '·  ', c: date ? 'ok' : 'dim' }, { t: t(`ach.${a.id}.title`), c: date ? 'hl' : 'dim' }],
        [t(`ach.${a.id}.desc`), date ? `  · ${date}` : ''],
      ];
    }));
  }

  cmdAbout() {
    const link = (href, text) => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = text || href;
      return a;
    };
    const rows = [
      t('about.desc'),
      [t('about.version'), `v${VERSION}`],
      [t('about.engines'), t('about.enginesValue')],
      [t('about.chess'), 'chess.js 1.4 (BSD-2)'],
      [t('about.code'), link('https://github.com/andersonfaller/blind-chess-terminal', 'github.com/andersonfaller/blind-chess-terminal')],
      { t: t('about.license'), c: 'dim' },
    ];
    this.term.printNode(ui.card('♞ Blind Chess Terminal', rows, { cls: 'about' }), { forceScroll: true });
  }

  cmdHelp(args) {
    const term = this.term;
    if (args[0]) {
      const c = this.commandMap.get(stripAccents(args[0]));
      if (!c) return term.print(t('err.unknown', { cmd: args[0] }), 'err');
      term.print([{ t: c.usage, c: 'hl' }]);
      term.print(t(`cmd.${c.name}`), '');
      const more = t(`cmd.${c.name}.more`);
      if (more !== `cmd.${c.name}.more`) for (const line of more.split('\n')) term.print(line, 'dim');
      if (c.aliases.length) term.print(t('help.aliases', { list: c.aliases.join(', ') }), 'dim');
      return;
    }
    const groups = ['play', 'aids', 'train', 'position', 'settings', 'info'];
    for (const g of groups) {
      term.print(t(`help.group.${g}`), 'help-group');
      term.printList(this.commands.filter((x) => x.group === g).map((c) => [
        { t: c.name, cmd: c.name === 'play' || c.usage === c.name ? c.name : `help ${c.name}`, run: true, c: 'cmd' },
        t(`cmd.${c.name}`),
      ]), { cls: 'help-list' });
    }
    term.print(t('help.moves'), 'hl');
    term.print(t('help.keys'), 'dim');
  }
}

class MenuMode {
  constructor(app, cmds) {
    this.app = app;
    this.name = 'menu';
    this.cmds = cmds;
  }

  input(text) {
    const n = parseInt(text, 10);
    if (String(n) === text.trim() && n >= 1 && n <= this.cmds.length) {
      this.app.endMode(this);
      this.app.execute(this.cmds[n - 1]);
      return true;
    }
    return false;
  }

  prompt() { return `1-${this.cmds.length} ❯`; }
  status() { return [{ t: '☰ ' + t('menu.title'), c: 'hl' }, { t: t('menu.pick'), c: 'dim' }]; }
  actions() { return this.cmds.map((c, i) => ({ label: `${i + 1}`, cmd: String(i + 1), title: c })).concat([{ label: 'stop', cmd: 'stop' }]); }
  stop() {}
}

function shortEngine(id) {
  return { local: 'Stockfish', online: 'stockfish.online', chessapi: 'chess-api', basic: 'JS engine', auto: 'auto' }[id] || id;
}

function pieceType(word) {
  for (const lang of ['en', 'pt']) {
    for (const [tp, name] of Object.entries(PIECE_NAMES[lang])) if (stripAccents(name) === word) return tp;
    for (const [tp, name] of Object.entries(PIECE_NAMES_PLURAL[lang])) if (stripAccents(name) === word) return tp;
  }
  const letters = { k: 'k', q: 'q', r: 'r', n: 'n', p: 'p', d: 'q', t: 'r', c: 'n', b: 'b' };
  if (word.length === 1) return letters[word] || null;
  return { horse: 'n', horses: 'n', rainha: 'q', peao: 'p', peoes: 'p' }[word] || null;
}

function linkCell(part) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cmd-link cmd';
  b.dataset.cmd = part.cmd;
  if (part.run) b.dataset.run = '1';
  b.textContent = part.t;
  return b;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
