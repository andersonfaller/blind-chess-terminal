import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { S, hasKey } from '../js/i18n.js';
import { ACHIEVEMENTS } from '../js/stats.js';
import { DRILL_KINDS } from '../js/drills.js';

const files = ['js', 'js/engine'].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => `${d}/${f}`));
const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');

test('every static t() key exists', () => {
  const keys = [...source.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]);
  const missing = [...new Set(keys)].filter((k) => !k.endsWith('.') && !hasKey(k));
  assert.deepEqual(missing, []);
});

test('dynamic keys exist', () => {
  const expected = [];
  const commands = [...readFileSync('js/app.js', 'utf8').matchAll(/add\('([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(commands.length > 40);
  for (const c of commands) expected.push(`cmd.${c}`);
  for (const a of ACHIEVEMENTS) expected.push(`ach.${a.id}.title`, `ach.${a.id}.desc`);
  for (const k of DRILL_KINDS) expected.push(`drill.${k}.title`, `drill.${k}.intro`, `drill.${k}.format`);
  for (const m of ['off', 'on', 'strict']) expected.push(`blind.mode.${m}`, `blind.short.${m}`, `blind.desc.${m}`);
  for (const r of ['checkmate', 'stalemate', 'insufficient', 'repetition', 'fifty', 'resign', 'timeout', 'timeoutDraw', 'agreement']) expected.push(`reason.${r}`);
  for (const r of ['win', 'loss', 'draw']) expected.push(`result.${r}`);
  for (const e of ['auto', 'local', 'online', 'chessapi', 'basic']) expected.push(`engine.desc.${e}`);
  for (const s of ['idle', 'loading', 'ready', 'error']) expected.push(`engine.state.${s}`);
  for (const g of ['play', 'aids', 'train', 'position', 'settings', 'info']) expected.push(`help.group.${g}`);
  for (let i = 1; i <= 7; i++) expected.push(`guide.${i}.title`, `guide.${i}.desc`, `guide.${i}.cmd`);
  for (const m of ['colors', 'diagonals', 'knight', 'visualize', 'memory', 'puzzle', 'easyGame', 'guide']) expected.push(`menu.${m}.title`, `menu.${m}.desc`);
  for (const k of ['human', 'skill', 'elo', 'max']) expected.push(`level.desc.${k}`);
  for (const k of ['blunder', 'mistake', 'inaccuracy']) expected.push(`review.kind.${k}`);
  for (const s of ['white', 'black']) expected.push(`eval.slight.${s}`, `eval.better.${s}`, `eval.winning.${s}`);
  expected.push('announce.set.san', 'announce.set.full', 'notation.set.en', 'notation.set.pt', 'drill.colors.light', 'drill.colors.dark');
  assert.deepEqual(expected.filter((k) => !hasKey(k)), []);
});

test('all strings have English and Portuguese', () => {
  const noPt = Object.entries(S).filter(([k, v]) => !v.en || (!v.pt && !/^guide\.\d\.cmd$/.test(k))).map(([k]) => k);
  assert.deepEqual(noPt, []);
});

test('placeholders match between languages', () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const bad = Object.entries(S).filter(([, v]) => v.pt && vars(v.en) !== vars(v.pt)).map(([k]) => k);
  assert.deepEqual(bad, []);
});
