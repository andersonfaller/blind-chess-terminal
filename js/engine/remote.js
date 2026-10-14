// Engines reached over HTTP. They are only used when chosen explicitly or
// as a fallback, so the app never depends on any single web service.

async function fetchJson(url, options = {}, timeoutMs = 15_000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { ...options, signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('timeout');
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** https://stockfish.online — the API used by the original version of this app. */
export class StockfishOnline {
  constructor() {
    this.id = 'online';
    this.name = 'stockfish.online (REST)';
    this.kind = 'remote';
    this.state = 'ready';
    this.maxDepth = 15;
  }

  async init() {}

  async search(fen, { depth = 12 } = {}) {
    const d = clamp(Math.round(depth), 1, this.maxDepth);
    const url = `https://stockfish.online/api/s/v2.php?fen=${encodeURIComponent(fen)}&depth=${d}`;
    const data = await fetchJson(url);
    if (!data || data.success !== true) throw new Error((data && (data.error || data.data)) || 'API error');
    const bestmove = String(data.bestmove || '').split(/\s+/)[1];
    if (!bestmove || bestmove === '(none)') throw new Error('no move returned');
    let score = null;
    if (data.mate != null && data.mate !== false) score = { mate: Number(data.mate) };
    else if (data.evaluation != null) score = { cp: Math.round(Number(data.evaluation) * 100) };
    const pv = String(data.continuation || '').split(/\s+/).filter(Boolean);
    return { bestmove, lines: [{ multipv: 1, depth: d, score, pv: pv.length ? pv : [bestmove] }], pov: 'white' };
  }

  stop() {}
  newGame() {}
}

/** https://chess-api.com — free Stockfish REST endpoint. */
export class ChessApi {
  constructor() {
    this.id = 'chessapi';
    this.name = 'chess-api.com (REST)';
    this.kind = 'remote';
    this.state = 'ready';
    this.maxDepth = 18;
  }

  async init() {}

  async search(fen, { depth = 12 } = {}) {
    const d = clamp(Math.round(depth), 1, this.maxDepth);
    const data = await fetchJson('https://chess-api.com/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen, depth: d, variants: 1, maxThinkingTime: 50 }),
    });
    if (!data || data.type === 'error' || data.error) throw new Error((data && (data.text || data.error)) || 'API error');
    let bestmove = data.move || data.lan;
    if (!bestmove && data.from && data.to) bestmove = data.from + data.to + (data.promotion || '');
    if (!bestmove) throw new Error('no move returned');
    let score = null;
    if (data.mate != null) score = { mate: Number(data.mate) };
    else if (data.centipawns != null) score = { cp: Math.round(Number(data.centipawns)) };
    else if (data.eval != null) score = { cp: Math.round(Number(data.eval) * 100) };
    const pv = Array.isArray(data.continuationArr) && data.continuationArr.length ? data.continuationArr : [bestmove];
    return { bestmove, lines: [{ multipv: 1, depth: data.depth || d, score, pv }], pov: 'white' };
  }

  stop() {}
  newGame() {}
}
