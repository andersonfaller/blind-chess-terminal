// Stockfish compiled to WebAssembly, running in a Web Worker and spoken to
// through the UCI protocol. No network needed after the first download.

const INIT_TIMEOUT = 90_000; // first load downloads ~7 MB of WASM

export class StockfishLocal {
  constructor(url) {
    this.id = 'local';
    this.name = 'Stockfish 18 Lite (WASM)';
    this.kind = 'local';
    this.url = url;
    this.worker = null;
    this.state = 'idle'; // idle | loading | ready | error
    this.error = null;
    this.readyPromise = null;
    this.waiters = [];
    this.current = null;
    this.queue = Promise.resolve();
    this.options = {};
  }

  get available() {
    return typeof Worker !== 'undefined' && typeof WebAssembly === 'object';
  }

  // The emscripten loader fails silently inside the worker when the .wasm
  // cannot be fetched, so check it is reachable first (headers only).
  async _preflight() {
    if (typeof fetch === 'undefined') return;
    const wasm = this.url.replace(/\.js(\?.*)?$/, '.wasm');
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20_000) : null;
    try {
      const res = await fetch(wasm, { cache: 'force-cache', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error(`engine file HTTP ${res.status}`);
      try { if (res.body) res.body.cancel(); } catch { /* ignore */ }
    } catch (err) {
      throw new Error(err && err.name === 'AbortError' ? 'engine download timeout' : `engine file unavailable (${(err && err.message) || err})`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.state = 'loading';
    this.readyPromise = this._preflight().then(() => this._start());
    this.readyPromise.catch((err) => {
      this.state = 'error';
      this.error = err;
      this.readyPromise = null;
    });
    return this.readyPromise;
  }

  _start() {
    return new Promise((resolve, reject) => {
      if (!this.available) {
        reject(new Error('WebAssembly/Worker not supported'));
        return;
      }
      let worker;
      try {
        worker = new Worker(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      this.worker = worker;
      const timer = setTimeout(() => fail(new Error('engine load timeout')), INIT_TIMEOUT);
      const fail = (err) => {
        clearTimeout(timer);
        this._teardown(err);
        reject(err);
      };
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        fail(new Error((e && e.message) || 'worker error'));
      };
      worker.onmessage = (e) => this._onLine(String(e.data));
      this._expect('uciok')
        .then(() => {
          this.send('isready');
          return this._expect('readyok');
        })
        .then(() => {
          clearTimeout(timer);
          worker.onerror = (e) => {
            if (e && e.preventDefault) e.preventDefault();
            this._teardown(new Error((e && e.message) || 'worker crashed'));
          };
          this.state = 'ready';
          resolve();
        }, fail);
      this.send('uci');
    });
  }

  send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
  }

  _expect(token) {
    return new Promise((resolve) => this.waiters.push({ token, resolve }));
  }

  _teardown(err) {
    this.state = 'error';
    this.error = err;
    try { this.worker && this.worker.terminate(); } catch { /* ignore */ }
    this.worker = null;
    this.options = {};
    this.readyPromise = null; // allow a later retry
    if (this.current) {
      const job = this.current;
      this.current = null;
      job.reject(err);
    }
  }

  _onLine(line) {
    if (this.waiters.length) {
      for (let i = 0; i < this.waiters.length; i++) {
        if (line.startsWith(this.waiters[i].token)) {
          const w = this.waiters.splice(i, 1)[0];
          w.resolve(line);
          break;
        }
      }
    }
    const job = this.current;
    if (!job) return;
    if (line.startsWith('info ') && line.includes(' pv ')) {
      const info = parseInfo(line);
      if (info && !info.bound) {
        job.lines[info.multipv] = info;
        if (job.onInfo) job.onInfo(info);
      }
    } else if (line.startsWith('bestmove')) {
      const parts = line.split(/\s+/);
      clearTimeout(job.watchdog);
      this.current = null;
      job.resolve({
        bestmove: parts[1] && parts[1] !== '(none)' ? parts[1] : null,
        ponder: parts[3] || null,
        lines: Object.values(job.lines).sort((a, b) => a.multipv - b.multipv),
        pov: 'stm',
      });
    }
  }

  _setOption(name, value) {
    const v = String(value);
    if (this.options[name] === v) return;
    this.options[name] = v;
    this.send(`setoption name ${name} value ${v}`);
  }

  _applyLimits({ elo = null, skill = null, multipv = 1 }) {
    if (elo) {
      this._setOption('UCI_LimitStrength', 'true');
      this._setOption('UCI_Elo', Math.max(1320, Math.min(3190, Math.round(elo))));
      this._setOption('Skill Level', 20);
    } else {
      this._setOption('UCI_LimitStrength', 'false');
      this._setOption('Skill Level', skill == null ? 20 : skill);
    }
    this._setOption('MultiPV', multipv);
  }

  /**
   * Run one search. Resolves with { bestmove, lines: [{multipv, depth, score, pv}] }
   * where scores are from the side to move.
   */
  search(fen, { movetime = null, depth = null, multipv = 1, elo = null, skill = null, onInfo = null } = {}) {
    const run = async () => {
      await this.init();
      return new Promise((resolve, reject) => {
        const job = { resolve, reject, lines: {}, onInfo };
        this.current = job;
        this._applyLimits({ elo, skill, multipv });
        this.send(`position fen ${fen}`);
        let go = 'go';
        if (depth) go += ` depth ${depth}`;
        if (movetime) go += ` movetime ${movetime}`;
        if (!depth && !movetime) go += ' movetime 1000';
        this.send(go);
        const budget = (movetime || 0) + (depth ? 20_000 : 0) + 15_000;
        job.watchdog = setTimeout(() => {
          // Ask nicely first, then give up and restart the worker.
          this.send('stop');
          job.watchdog = setTimeout(() => this._teardown(new Error('engine not responding')), 5000);
        }, budget);
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  stop() {
    if (this.current) this.send('stop');
  }

  newGame() {
    if (this.state !== 'ready') return;
    const run = async () => {
      this.send('ucinewgame');
      this.send('isready');
      await this._expect('readyok');
    };
    this.queue = this.queue.then(run, run).catch(() => {});
  }
}

export function parseInfo(line) {
  const t = line.trim().split(/\s+/);
  const info = { multipv: 1, depth: 0, score: null, pv: [], bound: false };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': info.depth = +t[++i]; break;
      case 'seldepth': info.seldepth = +t[++i]; break;
      case 'multipv': info.multipv = +t[++i]; break;
      case 'nodes': info.nodes = +t[++i]; break;
      case 'nps': info.nps = +t[++i]; break;
      case 'score': {
        const kind = t[++i];
        const val = +t[++i];
        info.score = kind === 'mate' ? { mate: val } : { cp: val };
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') { info.bound = true; i++; }
        break;
      }
      case 'pv': info.pv = t.slice(i + 1); i = t.length; break;
      default: break;
    }
  }
  return info.score ? info : null;
}
