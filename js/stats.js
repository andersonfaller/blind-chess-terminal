// Training statistics and achievements, kept in localStorage.
import { load, save } from './storage.js';

const DEFAULTS = () => ({
  v: 1,
  games: { played: 0, win: 0, draw: 0, loss: 0, byLevel: {}, blindWins: 0, peeks: 0, illegal: 0, recent: [] },
  drills: {},
  puzzles: { attempted: 0, solved: 0, rating: 1200, streak: 0, bestStreak: 0, solvedIds: [], peak: 1200 },
  reviews: { count: 0, lastAccuracy: null, bestAccuracy: null },
  days: [],
  achievements: {},
});

function merge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  for (const k of Object.keys(base)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) base[k] = merge(base[k], extra[k]);
    else if (extra[k] !== undefined) base[k] = extra[k];
  }
  for (const k of Object.keys(extra)) if (!(k in base)) base[k] = extra[k];
  return base;
}

const today = () => new Date().toISOString().slice(0, 10);

export class Stats {
  constructor() {
    this.data = merge(DEFAULTS(), load('stats', {}));
  }

  save() {
    save('stats', this.data);
  }

  reset() {
    const ach = this.data.achievements;
    this.data = DEFAULTS();
    this.data.achievements = ach; // achievements are forever
    this.save();
  }

  markDay() {
    const d = today();
    if (!this.data.days.includes(d)) {
      this.data.days.push(d);
      if (this.data.days.length > 400) this.data.days.shift();
    }
  }

  streakDays() {
    const set = new Set(this.data.days);
    let n = 0;
    const d = new Date();
    if (!set.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() - 1);
    while (set.has(d.toISOString().slice(0, 10))) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  recordGame(rec) {
    const g = this.data.games;
    g.played++;
    g[rec.outcome]++;
    const key = rec.elo ? `elo${rec.elo}` : String(rec.level);
    const lv = (g.byLevel[key] = g.byLevel[key] || { win: 0, draw: 0, loss: 0 });
    lv[rec.outcome]++;
    if (rec.blind !== 'off') {
      g.peeks += rec.metrics.peeks;
      g.illegal += rec.metrics.illegal;
      if (rec.outcome === 'win' && rec.metrics.peeks === 0 && rec.metrics.queries === 0) g.blindWins++;
    }
    g.recent.unshift({ date: rec.date, result: rec.result, outcome: rec.outcome, level: rec.level, elo: rec.elo, color: rec.color, blind: rec.blind, blindScore: rec.blindScore, moves: rec.sans.length, opening: rec.opening ? rec.opening.en : null });
    g.recent = g.recent.slice(0, 15);
    this.markDay();
    this.save();
  }

  drillBest(kind) {
    return this.data.drills[kind] ? this.data.drills[kind].best : null;
  }

  recordDrill(kind, { correct, total, avgMs }) {
    const d = (this.data.drills[kind] = this.data.drills[kind] || { sessions: 0, answered: 0, correct: 0, best: null, last: null });
    d.sessions++;
    d.answered += total;
    d.correct += correct;
    d.last = { correct, total, avgMs, date: today() };
    const better = (a, b) => !b || a.correct / a.total > b.correct / b.total || (a.correct / a.total === b.correct / b.total && (a.total > b.total || (a.total === b.total && a.avgMs < b.avgMs)));
    const newBest = better(d.last, d.best);
    if (newBest) d.best = d.last;
    this.markDay();
    this.save();
    return { newBest: newBest && d.sessions > 1 };
  }

  recordPuzzle({ id, success, rating, builtin }) {
    const p = this.data.puzzles;
    p.attempted++;
    const from = p.rating;
    const expected = 1 / (1 + Math.pow(10, (rating - from) / 400));
    const k = p.attempted < 20 ? 40 : 24;
    p.rating = Math.max(400, from + k * ((success ? 1 : 0) - expected));
    p.peak = Math.max(p.peak, p.rating);
    if (success) {
      p.solved++;
      p.streak++;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      if (builtin && !p.solvedIds.includes(id)) p.solvedIds.push(id);
    } else {
      p.streak = 0;
    }
    this.markDay();
    this.save();
    return { from, to: p.rating, delta: p.rating - from };
  }

  recordReview(accuracy) {
    const r = this.data.reviews;
    r.count++;
    r.lastAccuracy = accuracy;
    r.bestAccuracy = r.bestAccuracy == null ? accuracy : Math.max(r.bestAccuracy, accuracy);
    this.save();
  }

  unlock(id) {
    if (this.data.achievements[id]) return false;
    this.data.achievements[id] = today();
    this.save();
    return true;
  }
}

/** Achievement checks: each returns true when the event unlocks it. */
export const ACHIEVEMENTS = [
  { id: 'first_game', icon: '♟', test: (e) => e.type === 'game' && e.record.sans.length >= 10 },
  { id: 'first_win', icon: '🏁', test: (e) => e.type === 'game' && e.record.outcome === 'win' },
  { id: 'blind_win', icon: '🙈', test: (e) => e.type === 'game' && e.record.outcome === 'win' && e.record.sans.length >= 20 && e.record.blind !== 'off' && e.record.metrics.peeks === 0 && e.record.metrics.queries === 0 },
  { id: 'strict_win', icon: '🕶', test: (e) => e.type === 'game' && e.record.outcome === 'win' && e.record.sans.length >= 20 && e.record.blind === 'strict' },
  { id: 'slayer', icon: '🐉', test: (e) => e.type === 'game' && e.record.outcome === 'win' && e.record.sans.length >= 20 && (e.record.level >= 7 || (e.record.elo || 0) >= 1800) },
  { id: 'clean_game', icon: '✨', test: (e) => e.type === 'game' && e.record.blind !== 'off' && e.record.sans.length >= 40 && e.record.metrics.illegal === 0 },
  { id: 'colors_perfect', icon: '🎨', test: (e) => e.type === 'drill' && e.kind === 'colors' && e.total >= 20 && e.correct === e.total },
  { id: 'colors_speed', icon: '⚡', test: (e) => e.type === 'drill' && e.kind === 'colors' && e.total >= 20 && e.correct === e.total && e.avgMs < 1500 },
  { id: 'diagonal_eye', icon: '↗', test: (e) => e.type === 'drill' && e.kind === 'diagonals' && e.total >= 15 && e.correct === e.total },
  { id: 'knight_master', icon: '♞', test: (e) => e.type === 'drill' && e.kind === 'knight' && e.total >= 10 && e.correct === e.total },
  { id: 'visual_ace', icon: '🧠', test: (e) => e.type === 'drill' && e.kind === 'visualize' && e.total >= 8 && e.correct === e.total },
  { id: 'memory_ace', icon: '📸', test: (e) => e.type === 'drill' && e.kind === 'memory' && e.total >= 8 && e.correct === e.total },
  { id: 'puzzle_10', icon: '🧩', test: (e, s) => e.type === 'puzzle' && s.data.puzzles.solved >= 10 },
  { id: 'puzzle_streak5', icon: '🔥', test: (e, s) => e.type === 'puzzle' && s.data.puzzles.streak >= 5 },
  { id: 'puzzle_1600', icon: '📈', test: (e, s) => e.type === 'puzzle' && s.data.puzzles.rating >= 1600 },
  { id: 'week', icon: '📅', test: (e, s) => s.data.days.length >= 7 },
];
