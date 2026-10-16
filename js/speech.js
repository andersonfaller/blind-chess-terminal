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

/** Facts about the browser that decide how voice input can work. */
export function platformInfo() {
  if (typeof navigator === 'undefined') return { iOS: false, standalone: false, secure: true };
  const ua = navigator.userAgent || '';
  // iPadOS reports itself as a Mac; touch support gives it away.
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let standalone = navigator.standalone === true;
  try { standalone = standalone || window.matchMedia('(display-mode: standalone)').matches; } catch { /* ignore */ }
  return { iOS, standalone, secure: typeof window === 'undefined' || !!window.isSecureContext };
}

// Errors that end voice input; the rest ("aborted", "no-speech") are routine.
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported', 'bad-grammar']);

export class Listener {
  /**
   * onResult(alternatives)  a final transcript (array of alternatives)
   * onState(listening)      listening started/stopped
   * onError({ code, message, restart })  restart=true when only an automatic
   *                         restart was refused (it worked before), not a denial
   */
  constructor(settings, { onResult, onState, onError = () => {} }) {
    this.settings = settings;
    this.onResult = onResult;
    this.onState = onState;
    this.onError = onError;
    const Rec = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    this.Rec = Rec || null;
    this.platform = platformInfo();
    this.rec = null;
    this.active = false; // the user wants to listen
  }

  get supported() {
    return !!this.Rec;
  }

  /**
   * iOS/iPadOS only start recognition from a tap and don't keep listening
   * reliably, so there every tap captures one utterance ("tap to talk").
   */
  get tapToTalk() {
    return this.platform.iOS;
  }

  get lang() {
    return LANG_TAGS[this.settings.get('lang')] || 'en-US';
  }

  /** Must be called from a user gesture (click / Enter) for iOS to allow it. */
  start() {
    if (!this.supported || this.rec) return false;
    this.active = true;
    this._spawn(true);
    return this.active;
  }

  _spawn(fromGesture) {
    let rec;
    try {
      rec = new this.Rec();
    } catch (err) {
      this.active = false;
      this.onError({ code: 'start-failed', message: (err && err.message) || String(err), restart: !fromGesture });
      this.onState(false);
      return;
    }
    rec.lang = this.lang;
    rec.continuous = !this.tapToTalk;
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
      const code = (e && e.error) || 'unknown';
      if (code === 'aborted') return;
      if (code === 'no-speech') {
        if (this.tapToTalk) this.onError({ code, message: e.message || '', restart: false });
        return;
      }
      if (FATAL.has(code) || code === 'unknown') {
        this.active = false;
        this.onError({ code, message: (e && e.message) || '', restart: !fromGesture });
      }
    };
    rec.onend = () => {
      if (this.rec !== rec) return; // replaced or stopped
      if (this.active && !this.tapToTalk) {
        // Desktop browsers stop after a silence: keep listening.
        this.rec = null;
        setTimeout(() => { if (this.active && !this.rec) this._spawn(false); }, 250);
        return;
      }
      this.rec = null;
      this.active = false;
      this.onState(false);
    };
    this.rec = rec;
    try {
      rec.start();
      if (fromGesture) this.onState(true);
    } catch (err) {
      this.rec = null;
      this.active = false;
      this.onError({ code: 'start-failed', message: (err && err.message) || String(err), restart: !fromGesture });
      this.onState(false);
    }
  }

  stop() {
    this.active = false;
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      try { rec.abort ? rec.abort() : rec.stop(); } catch { /* ignore */ }
    }
    this.onState(false);
  }
}
