// Wrapper around the built-in engine: runs it in a module worker when the
// browser allows, otherwise on the main thread.
import { Chess } from '../../vendor/chess.js/chess.js';
import { searchBest } from './basic-search.js';

export class BasicEngine {
  constructor() {
    this.id = 'basic';
    this.name = 'Built-in JS engine';
    this.kind = 'local';
    this.state = 'ready';
    this.worker = null;
    this.workerBroken = false;
    this.pending = new Map();
    this.seq = 0;
  }

  async init() {}

  _getWorker() {
    if (this.worker || this.workerBroken || typeof Worker === 'undefined') return this.worker;
    try {
      this.worker = new Worker(new URL('./basic-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const job = this.pending.get(e.data.id);
        if (!job) return;
        this.pending.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data.result);
      };
      this.worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this.workerBroken = true;
        this.worker = null;
        // Re-run whatever was pending on the main thread.
        for (const [, job] of this.pending) job.retryInline();
        this.pending.clear();
      };
    } catch {
      this.workerBroken = true;
      this.worker = null;
    }
    return this.worker;
  }

  _inline(fen, opts) {
    return new Promise((resolve, reject) => {
      // Yield first so the UI can paint "thinking...".
      setTimeout(() => {
        try { resolve(searchBest(Chess, fen, opts)); } catch (err) { reject(err); }
      }, 30);
    });
  }

  async search(fen, { depth = 3, movetime = 1200, noise = 0 } = {}) {
    const opts = { maxDepth: depth, timeMs: movetime, noise };
    const worker = this._getWorker();
    let r;
    if (worker) {
      r = await new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, {
          resolve,
          reject,
          retryInline: () => this._inline(fen, opts).then(resolve, reject),
        });
        worker.postMessage({ id, fen, opts });
      });
    } else {
      r = await this._inline(fen, opts);
    }
    if (!r.bestmove) throw new Error('no legal moves');
    return { bestmove: r.bestmove, lines: [{ multipv: 1, depth: r.depth, score: r.score, pv: r.pv }], pov: 'stm' };
  }

  stop() {}
  newGame() {}
}
