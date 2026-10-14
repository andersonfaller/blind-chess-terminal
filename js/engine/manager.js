// Chooses an engine, applies the playing strength and falls back to the next
// engine in the chain whenever one fails (offline, API down, no WASM...).
import { StockfishLocal } from './stockfish-local.js';
import { StockfishOnline, ChessApi } from './remote.js';
import { BasicEngine } from './basic.js';
import { Chess } from '../../vendor/chess.js/chess.js';
import { fenInfo } from '../chess-utils.js';

export const ENGINE_IDS = ['auto', 'local', 'online', 'chessapi', 'basic'];
const AUTO_ORDER = ['local', 'online', 'chessapi', 'basic'];

/**
 * Playing levels. Levels 1-3 pick human-like inaccuracies on purpose,
 * 4 uses Stockfish's Skill Level, 5-9 its calibrated UCI_Elo, 10 is full strength.
 */
export const LEVELS = {
  1: { elo: 400, humanize: { margin: 400, randomRate: 0.3 }, depth: 6, basic: { depth: 1, noise: 250 }, remoteDepth: 1 },
  2: { elo: 700, humanize: { margin: 220, randomRate: 0.14 }, depth: 7, basic: { depth: 2, noise: 140 }, remoteDepth: 2 },
  3: { elo: 1000, humanize: { margin: 110, randomRate: 0.06 }, depth: 8, basic: { depth: 2, noise: 60 }, remoteDepth: 3 },
  4: { elo: 1200, skill: 0, depth: 5, basic: { depth: 3, noise: 30 }, remoteDepth: 4 },
  5: { elo: 1400, ucielo: 1400, movetime: 300, basic: { depth: 3, noise: 10 }, remoteDepth: 6 },
  6: { elo: 1600, ucielo: 1600, movetime: 400, basic: { depth: 4, noise: 0 }, remoteDepth: 8 },
  7: { elo: 1800, ucielo: 1800, movetime: 500, basic: { depth: 4, noise: 0 }, remoteDepth: 10 },
  8: { elo: 2000, ucielo: 2000, movetime: 700, basic: { depth: 5, noise: 0 }, remoteDepth: 12 },
  9: { elo: 2300, ucielo: 2300, movetime: 1000, basic: { depth: 5, noise: 0 }, remoteDepth: 14 },
  10: { elo: 3000, movetime: 1500, basic: { depth: 6, noise: 0 }, remoteDepth: 15 },
};

/** Settings -> level spec. `elo` (1320..3190) overrides `level` when set. */
export function resolveLevel(level, customElo) {
  if (customElo) {
    const elo = Math.max(1320, Math.min(3190, customElo));
    const nearest = Object.entries(LEVELS).reduce((a, b) => (Math.abs(b[1].elo - elo) < Math.abs(a[1].elo - elo) ? b : a));
    return { ...nearest[1], ucielo: elo, elo, movetime: nearest[1].movetime || 500, humanize: null, skill: null, custom: true, level: +nearest[0] };
  }
  const n = Math.max(1, Math.min(10, Math.round(level) || 4));
  return { ...LEVELS[n], level: n };
}

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.cancelled = true; }
}

export class EngineManager {
  constructor({ stockfishUrl, onEvent = () => {} } = {}) {
    this.engines = {
      local: new StockfishLocal(stockfishUrl),
      online: new StockfishOnline(),
      chessapi: new ChessApi(),
      basic: new BasicEngine(),
    };
    this.preference = 'auto';
    this.onEvent = onEvent;
    this.token = 0;
    this.active = null; // id of the engine that answered last
    this.busy = false;
    this.failures = {}; // id -> consecutive failures
  }

  setPreference(id) {
    if (!ENGINE_IDS.includes(id)) return false;
    this.preference = id;
    if (id !== 'auto') this.failures[id] = 0;
    return true;
  }

  chain() {
    if (this.preference === 'auto') return AUTO_ORDER;
    return [this.preference, ...AUTO_ORDER.filter((x) => x !== this.preference)];
  }

  /** Start downloading the local engine in the background. */
  warmup() {
    if (this.preference !== 'auto' && this.preference !== 'local') return;
    const sf = this.engines.local;
    if (!sf.available || sf.state === 'ready' || sf.state === 'loading') return;
    this._emitStatus();
    sf.init().then(
      () => this._emitStatus(),
      (err) => { this.failures.local = 99; this.onEvent({ type: 'local-failed', error: err }); this._emitStatus(); },
    );
    this._emitStatus();
  }

  status() {
    const id = this.active || this.chain()[0];
    const eng = this.engines[id];
    const local = this.engines.local;
    return {
      preference: this.preference,
      id,
      name: eng.name,
      busy: this.busy,
      localState: local.state,
    };
  }

  _emitStatus() {
    this.onEvent({ type: 'status', status: this.status() });
  }

  _usable(id) {
    const eng = this.engines[id];
    if (id === 'local') {
      if (!eng.available) return false;
      // A local engine that failed to load is skipped in auto mode.
      if (this.preference === 'auto' && (this.failures.local || 0) >= 2) return false;
    }
    if (eng.kind === 'remote' && typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (eng.kind === 'remote' && this.preference !== id && (this.failures[id] || 0) >= 3) return false;
    return true;
  }

  async _run(task) {
    const token = this.token;
    let lastErr = null;
    const ids = this.chain().filter((id) => this._usable(id));
    if (!ids.includes('basic')) ids.push('basic');
    this.busy = true;
    this._emitStatus();
    try {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const eng = this.engines[id];
        try {
          const result = await task(eng, id);
          if (token !== this.token) throw new CancelledError();
          this.failures[id] = 0;
          if (this.active !== id) {
            this.active = id;
          }
          return { ...result, engine: id };
        } catch (err) {
          if (err && err.cancelled) throw err;
          if (token !== this.token) throw new CancelledError();
          lastErr = err;
          this.failures[id] = (this.failures[id] || 0) + 1;
          const next = ids[i + 1];
          if (next) this.onEvent({ type: 'fallback', from: id, to: next, error: err });
        }
      }
      throw lastErr || new Error('no engine available');
    } finally {
      if (token === this.token) this.busy = false;
      this._emitStatus();
    }
  }

  /** Pick a move for the computer opponent at the given strength. */
  play(fen, levelSpec) {
    return this._run(async (eng, id) => {
      if (id === 'local') return this._playLocal(eng, fen, levelSpec);
      if (id === 'basic') {
        const r = await eng.search(fen, { depth: levelSpec.basic.depth, noise: levelSpec.basic.noise, movetime: 1500 });
        return { move: r.bestmove };
      }
      // Remote engines only expose depth; spice weak levels with random moves.
      const rate = levelSpec.humanize ? levelSpec.humanize.randomRate : 0;
      if (rate && Math.random() < rate) return { move: randomLegal(fen) };
      const r = await eng.search(fen, { depth: levelSpec.remoteDepth });
      return { move: r.bestmove };
    });
  }

  async _playLocal(eng, fen, spec) {
    if (spec.humanize) {
      const { margin, randomRate } = spec.humanize;
      if (Math.random() < randomRate) {
        await eng.init(); // still make sure the engine works, for consistent fallbacks
        return { move: randomLegal(fen) };
      }
      const r = await eng.search(fen, { depth: spec.depth, multipv: 6 });
      return { move: humanPick(r, margin) };
    }
    if (spec.skill != null) {
      const r = await eng.search(fen, { depth: spec.depth, skill: spec.skill });
      return { move: r.bestmove };
    }
    if (spec.ucielo) {
      const r = await eng.search(fen, { movetime: spec.movetime, elo: spec.ucielo });
      return { move: r.bestmove };
    }
    const r = await eng.search(fen, { movetime: spec.movetime || 1500 });
    return { move: r.bestmove };
  }

  /**
   * Full-strength analysis. Returns { bestmove, lines: [{score, pv, depth}], engine }
   * with scores always from White's point of view.
   */
  analyse(fen, { movetime = 800, depth = null, multipv = 1, onInfo = null } = {}) {
    const whiteToMove = fenInfo(fen).turn === 'w';
    return this._run(async (eng, id) => {
      let r;
      if (id === 'local') r = await eng.search(fen, { movetime: depth ? null : movetime, depth, multipv, onInfo });
      else if (id === 'basic') r = await eng.search(fen, { depth: 4, movetime: Math.min(movetime, 2000) });
      else r = await eng.search(fen, { depth: depth || 14 });
      if (!r.bestmove) throw new Error('no move');
      const flip = r.pov === 'stm' && !whiteToMove;
      const lines = r.lines.map((l) => ({ ...l, score: flipScore(l.score, flip) }));
      return { bestmove: r.bestmove, lines };
    });
  }

  cancel() {
    this.token++;
    this.busy = false;
    for (const eng of Object.values(this.engines)) eng.stop();
    this._emitStatus();
  }

  newGame() {
    this.engines.local.newGame();
  }
}

function flipScore(score, flip) {
  if (!score || !flip) return score;
  return score.mate != null ? { mate: -score.mate } : { cp: -score.cp };
}

function randomLegal(fen) {
  const moves = new Chess(fen).moves({ verbose: true });
  const m = moves[Math.floor(Math.random() * moves.length)];
  return m.from + m.to + (m.promotion || '');
}

const lineValue = (l) => (l.score.mate != null ? (l.score.mate > 0 ? 100000 - l.score.mate : -100000 - l.score.mate) : l.score.cp);

// Choose among the engine's top lines, favouring better moves but allowing
// mistakes up to `margin` centipawns: a much more human way to play weakly.
function humanPick(result, margin) {
  const lines = result.lines.filter((l) => l.score && l.pv && l.pv.length);
  if (!lines.length) return result.bestmove;
  const best = lineValue(lines[0]);
  const ok = lines.filter((l) => best - lineValue(l) <= margin);
  const weights = ok.map((_, i) => 1 / (i + 1));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ok.length; i++) {
    r -= weights[i];
    if (r <= 0) return ok[i].pv[0];
  }
  return ok[0].pv[0];
}
