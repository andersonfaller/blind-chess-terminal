// localStorage wrapper. Every access is guarded: private windows, blocked
// storage or full quotas must never break the app.

const PREFIX = 'bct:';

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

const detectLang = () => {
  try {
    return (navigator.language || 'en').toLowerCase().startsWith('pt') ? 'pt' : 'en';
  } catch {
    return 'en';
  }
};

export const DEFAULT_SETTINGS = {
  lang: null, // null = follow the browser
  theme: 'phosphor',
  crt: true,
  fontSize: null, // null = automatic (smaller on phones)
  notation: 'en',
  speak: true,
  voiceName: null,
  rate: 1,
  sound: true,
  blind: 'on', // off | on | strict
  level: 4,
  elo: null,
  engine: 'auto',
  boardStyle: 'unicode', // unicode | ascii
  announce: 'san', // san | full
  clock: null, // { base: seconds, inc: seconds }
  color: 'white',
};

export class Settings {
  constructor() {
    const saved = load('settings', {});
    // v1 stored the old default font size (15) for everybody: make it automatic.
    if (!saved.v && saved.fontSize === 15) saved.fontSize = null;
    this.values = { ...DEFAULT_SETTINGS, ...saved, v: 2 };
    if (!this.values.lang) this.values.lang = detectLang();
    this.listeners = new Set();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
    save('settings', this.values);
    for (const fn of this.listeners) fn(key, value);
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  reset() {
    const lang = this.values.lang;
    this.values = { ...DEFAULT_SETTINGS, lang, v: 2 };
    save('settings', this.values);
    for (const fn of this.listeners) fn('*', null);
  }
}
