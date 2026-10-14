// Post-game analysis: accuracy, inaccuracies/mistakes/blunders, the best
// move you missed at each critical moment, and an evaluation graph.
import { Chess } from '../vendor/chess.js/chess.js';
import { t, getLang } from './i18n.js';
import {
  uciToObj, sanToLocal, moveLabel, formatScore, winPercent, scoreToCp, moveAccuracy, COLOR_NAMES, capitalize, moveToUci,
} from './chess-utils.js';
import { sparkline } from './ui.js';

const THRESHOLDS = { blunder: 15, mistake: 10, inaccuracy: 5 }; // drop in win %
const SYMBOL = { blunder: '??', mistake: '?', inaccuracy: '?!' };

/** Classify each move given evaluations of every position. Exported for tests. */
export function classifyMoves(plies, evals) {
  return plies.map((p, i) => {
    const sign = p.color === 'w' ? 1 : -1;
    const before = winPercent(sign * scoreToCp(evals[i].score));
    const after = winPercent(sign * scoreToCp(evals[i + 1].score));
    const drop = before - after;
    let kind = null;
    if (drop >= THRESHOLDS.blunder) kind = 'blunder';
    else if (drop >= THRESHOLDS.mistake) kind = 'mistake';
    else if (drop >= THRESHOLDS.inaccuracy) kind = 'inaccuracy';
    const best = evals[i].best && evals[i].best === p.uci;
    return { ...p, before, after, drop, kind, best, accuracy: moveAccuracy(before, after) };
  });
}

export function summarize(moves, color) {
  const mine = moves.filter((m) => m.color === color);
  const acc = mine.length ? mine.reduce((s, m) => s + m.accuracy, 0) / mine.length : 0;
  const count = (k) => mine.filter((m) => m.kind === k).length;
  return { accuracy: acc, blunders: count('blunder'), mistakes: count('mistake'), inaccuracies: count('inaccuracy'), best: mine.filter((m) => m.best).length, n: mine.length };
}

export class ReviewMode {
  constructor(app, record, { movetime = 300 } = {}) {
    this.app = app;
    this.name = 'review';
    this.record = record;
    this.movetime = movetime;
    this.cancelled = false;
    this.progress = 0;
    this.total = 0;
  }

  async start() {
    const app = this.app;
    const rec = this.record;
    const c = new Chess(rec.startFen);
    const fens = [c.fen()];
    const plies = [];
    for (const uci of rec.moves) {
      const label = moveLabel(c.fen());
      const m = c.move(uciToObj(uci));
      plies.push({ san: m.san, uci: moveToUci(m), color: m.color, label, fenBefore: m.before });
      fens.push(c.fen());
    }
    if (!plies.length) {
      app.term.print(t('review.empty'), 'warn');
      app.endMode(this);
      return;
    }
    this.total = fens.length;
    app.term.print([{ t: '🔍 ', c: 'accent' }, t('review.start', { n: plies.length })], 'hl');
    app.term.print([t('review.cancelHint.pre'), { t: 'stop', cmd: 'stop', run: true }], 'dim');
    const spin = app.term.spinner(t('review.progress', { i: 0, n: fens.length }));
    const evals = [];
    for (let i = 0; i < fens.length; i++) {
      if (this.cancelled) { spin.stop(); return; }
      const pos = new Chess(fens[i]);
      if (pos.isCheckmate()) {
        // The side to move is mated.
        evals.push({ score: { cp: pos.turn() === 'w' ? -10000 : 10000 } });
      } else if (pos.isGameOver()) {
        evals.push({ score: { cp: 0 } });
      } else {
        try {
          const res = await app.engines.analyse(fens[i], { movetime: this.movetime });
          const line = res.lines[0] || {};
          evals.push({ score: line.score || { cp: 0 }, best: res.bestmove, pv: line.pv });
          this.engineId = res.engine;
        } catch (err) {
          spin.stop();
          if (err && err.cancelled) return;
          app.term.print(t('engine.error', { msg: err.message }), 'err');
          app.endMode(this);
          return;
        }
      }
      this.progress = i + 1;
      spin.update(t('review.progress', { i: i + 1, n: fens.length }));
      app.refresh();
    }
    spin.stop();
    if (this.cancelled) return;
    this.report(plies, evals);
    app.endMode(this);
  }

  report(plies, evals) {
    const app = this.app;
    const lang = getLang();
    const notation = app.settings.get('notation');
    const L = (san) => sanToLocal(san, notation);
    const moves = classifyMoves(plies, evals);
    const you = this.record.color;
    const opp = you === 'w' ? 'b' : 'w';
    const sy = summarize(moves, you);
    const so = summarize(moves, opp);
    const wp = evals.map((e) => (winPercent(scoreToCp(e.score)) - 50) / 50);
    const fmt = (s) => (s.n ? `${s.accuracy.toFixed(1)}% · ${s.inaccuracies} ?! · ${s.mistakes} ? · ${s.blunders} ??` : '—');
    const rows = [
      [t('review.you', { color: capitalize(COLOR_NAMES[lang][you]) }), { t: fmt(sy), c: 'accent' }],
      [t('review.engine'), fmt(so)],
      [t('review.bestMoves'), t('review.bestMovesValue', { n: sy.best, total: sy.n })],
      [t('review.graph'), { t: sparkline(wp), c: 'spark' }],
    ];
    app.term.printNode(app.ui.card(`🔍 ${t('review.title')}`, rows, { cls: 'review' }), { forceScroll: true });

    const critical = moves.filter((m) => m.kind && m.color === you).sort((a, b) => b.drop - a.drop).slice(0, 8)
      .sort((a, b) => moves.indexOf(a) - moves.indexOf(b));
    if (!critical.length) {
      app.term.print([{ t: '★ ', c: 'ok' }, t('review.clean')], 'ok');
    } else {
      app.term.print(t('review.criticalTitle'), 'hl');
      for (const m of critical) {
        const i = moves.indexOf(m);
        const bestUci = evals[i].best;
        let bestSan = '';
        if (bestUci) {
          try { bestSan = new Chess(m.fenBefore).move(uciToObj(bestUci)).san; } catch { /* ignore */ }
        }
        app.term.print([
          { t: `${m.label} `, c: 'num' },
          { t: L(m.san) + SYMBOL[m.kind], c: m.kind === 'blunder' ? 'err' : m.kind === 'mistake' ? 'warn' : 'accent' },
          { t: `  ${t('review.kind.' + m.kind)}`, c: 'dim' },
          `  ${formatScore(evals[i].score)} → ${formatScore(evals[i + 1].score)}`,
          bestSan ? { t: `  ${t('review.best')} ${L(bestSan)}`, c: 'ok' } : null,
        ]);
      }
    }
    const oppBlunders = moves.filter((m) => m.kind === 'blunder' && m.color === opp);
    if (oppBlunders.length) {
      app.term.print(t('review.oppBlunders', { list: oppBlunders.map((m) => `${m.label} ${L(m.san)}`).join(', ') }), 'dim');
    }
    if (this.engineId) app.term.print(t('eval.by', { engine: app.engines.engines[this.engineId].name }), 'dim');
    app.say(t('review.speech', { acc: Math.round(sy.accuracy), b: sy.blunders, m: sy.mistakes }));
    app.stats.recordReview(sy.accuracy);
  }

  stop() {
    if (!this.cancelled && this.progress < this.total) {
      this.cancelled = true;
      this.app.engines.cancel();
      this.app.term.print(t('review.cancelled'), 'dim');
    }
  }

  input() { return false; }

  prompt() { return t('prompt.review'); }

  status() {
    return [{ t: '🔍 ' + t('review.title'), c: 'hl' }, { t: `${this.progress}/${this.total}`, c: 'accent pulse' }];
  }

  actions() { return [{ label: 'stop', cmd: 'stop' }]; }
}
