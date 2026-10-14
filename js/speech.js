// Text-to-speech (announce moves) and speech recognition (play by voice).
import { stripAccents } from './chess-utils.js';

const LANG_TAGS = { en: 'en-US', pt: 'pt-BR' };

export class Speaker {
  constructor(settings) {
    this.settings = settings;
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this.voices = [];
    if (this.synth) {
      const refresh = () => { this.voices = this.synth.getVoices() || []; };
      refresh();
      if ('onvoiceschanged' in this.synth) this.synth.onvoiceschanged = refresh;
    }
  }

  get supported() {
    return !!this.synth && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  voicesForLang(lang = this.settings.get('lang')) {
    const tag = LANG_TAGS[lang] || 'en-US';
    const base = tag.slice(0, 2);
    return this.voices.filter((v) => v.lang && v.lang.replace('_', '-').toLowerCase().startsWith(base));
  }

  pickVoice() {
    const lang = this.settings.get('lang');
    const wanted = this.settings.get('voiceName');
    if (wanted) {
      const v = this.voices.find((x) => x.name === wanted);
      if (v) return v;
    }
    const tag = (LANG_TAGS[lang] || 'en-US').toLowerCase();
    const cands = this.voicesForLang(lang);
    const score = (v) => {
      let s = 0;
      if (v.lang.replace('_', '-').toLowerCase() === tag) s += 10;
      if (/natural|neural|enhanced|premium|google/i.test(v.name)) s += 5;
      if (v.localService) s += 1;
      return s;
    };
    return cands.sort((a, b) => score(b) - score(a))[0] || null;
  }

  say(text, { force = false, interrupt = true } = {}) {
    if (!this.supported || !text) return;
    if (!force && !this.settings.get('speak')) return;
    try {
      if (interrupt) this.synth.cancel();
      const lang = this.settings.get('lang');
      const v = this.pickVoice();
      // Chrome cuts off long utterances, so speak sentence by sentence.
      for (const chunk of splitSpeech(text)) {
        const u = new SpeechSynthesisUtterance(chunk);
        u.lang = LANG_TAGS[lang] || 'en-US';
        if (v) u.voice = v;
        u.rate = Number(this.settings.get('rate')) || 1;
        this.synth.speak(u);
      }
    } catch {
      /* speech is a nicety; never break the app */
    }
  }

  stop() {
    try { if (this.synth) this.synth.cancel(); } catch { /* ignore */ }
  }
}

export function splitSpeech(text, max = 180) {
  const out = [];
  for (const sentence of String(text).split(/(?<=[.!?])\s+/)) {
    let rest = sentence.trim();
    while (rest.length > max) {
      let cut = rest.lastIndexOf(', ', max);
      if (cut < max / 3) cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Speech recognition

const WORDS = {
  // pieces
  knight: 'N', night: 'N', nite: 'N', horse: 'N', cavalo: 'N', cavaleiro: 'N',
  bishop: 'B', bispo: 'B',
  rook: 'R', rock: 'R', tower: 'R', torre: 'R',
  queen: 'Q', dama: 'Q', rainha: 'Q',
  king: 'K', rei: 'K',
  pawn: '', peao: '', pion: '',
  // captures
  takes: 'x', take: 'x', captures: 'x', capture: 'x', x: 'x', toma: 'x', come: 'x', captura: 'x',
  // promotion
  promotes: '=', promote: '=', equals: '=', promove: '=', promovendo: '=', vira: '=',
  // numbers
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  won: '1', too: '2', tree: '3', for: '4', fore: '4', sex: '6', ate: '8',
  um: '1', uma: '1', dois: '2', duas: '2', tres: '3', quatro: '4', cinco: '5', seis: '6', sete: '7', oito: '8',
  // files (NATO + English letter names + Portuguese letter names)
  alpha: 'a', alfa: 'a', bravo: 'b', charlie: 'c', delta: 'd', echo: 'e', eco: 'e', foxtrot: 'f', golf: 'g', hotel: 'h',
  bee: 'b', be: 'b', see: 'c', sea: 'c', ce: 'c', dee: 'd', de: 'd', ef: 'f', eff: 'f', efe: 'f', gee: 'g', ge: 'g', aitch: 'h', aga: 'h',
};

const FILLERS = new Set(['to', 'the', 'on', 'at', 'in', 'square', 'move', 'para', 'pra', 'em', 'na', 'no', 'casa', 'o', 'lance', 'jogo']);

const CASTLE_SHORT = /\b(castles?|castling|roque|roca)\s*(king\s*side|kingside|short|small|pequeno|curto|do rei)\b|\b(short|small)\s+castle\b|\broque pequeno\b/;
const CASTLE_LONG = /\b(castles?|castling|roque|roca)\s*(queen\s*side|queenside|long|big|grande|longo|da dama)\b|\blong\s+castle\b|\broque grande\b/;

/**
 * Turn a speech transcript into something the move parser / command parser
 * understands. Returns { compact, spaced } — e.g. "knight takes e 5" ->
 * { compact: "Nxe5", spaced: "N x e5" }.
 */
export function normalizeSpoken(transcript) {
  let s = stripAccents(String(transcript).toLowerCase()).replace(/[.,!?;]/g, ' ').trim();
  if (CASTLE_LONG.test(s)) return { compact: 'O-O-O', spaced: 'O-O-O' };
  if (CASTLE_SHORT.test(s)) return { compact: 'O-O', spaced: 'O-O' };
  // "e4" may arrive as "e4", "e 4", "e four", "echo four"...
  const raw = s.split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const w of raw) {
    if (/^[a-h][1-8]$/.test(w)) { tokens.push(w); continue; }
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(w)) { tokens.push(w); continue; }
    if (/^[1-8]$/.test(w)) { tokens.push(w); continue; }
    if (FILLERS.has(w)) continue;
    if (w in WORDS) { tokens.push(WORDS[w]); continue; }
    if (/^[a-h]$/.test(w)) { tokens.push(w); continue; }
    tokens.push(w);
  }
  // Merge file + rank pairs into squares.
  const merged = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[a-h]$/.test(t) && /^[1-8]$/.test(tokens[i + 1] || '')) {
      merged.push(t + tokens[i + 1]);
      i++;
    } else if (t !== '') {
      merged.push(t);
    }
  }
  // "promotes queen" -> "=Q"
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    if (merged[i] === '=' && /^[QRBN]$/.test(merged[i + 1] || '')) {
      out.push('=' + merged[i + 1]);
      i++;
    } else {
      out.push(merged[i]);
    }
  }
  return { compact: out.join(''), spaced: out.join(' ') };
}

export class Listener {
  constructor(settings, { onResult, onState }) {
    this.settings = settings;
    this.onResult = onResult;
    this.onState = onState;
    const Rec = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    this.Rec = Rec || null;
    this.rec = null;
    this.active = false;
  }

  get supported() {
    return !!this.Rec;
  }

  start() {
    if (!this.supported || this.active) return false;
    this.active = true;
    this._spawn();
    this.onState(true);
    return true;
  }

  _spawn() {
    const rec = new this.Rec();
    rec.lang = LANG_TAGS[this.settings.get('lang')] || 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const alts = [];
        for (let k = 0; k < e.results[i].length; k++) alts.push(e.results[i][k].transcript);
        this.onResult(alts);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.stop();
        this.onState(false, e.error);
      }
    };
    rec.onend = () => {
      // Browsers stop recognition after silence; keep listening while enabled.
      if (this.active) {
        try { rec.start(); } catch { setTimeout(() => this.active && this._spawn(), 300); }
      }
    };
    this.rec = rec;
    try { rec.start(); } catch { /* already started */ }
  }

  stop() {
    this.active = false;
    if (this.rec) {
      try { this.rec.stop(); } catch { /* ignore */ }
      this.rec = null;
    }
    this.onState(false);
  }
}
