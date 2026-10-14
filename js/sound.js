// Tiny synthesized sound effects (no audio files to download).

let ctx = null;

function audio() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

function tone(freq, start, dur, { type = 'sine', gain = 0.08, slide = null } = {}) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const SOUNDS = {
  move: () => tone(220, 0, 0.08, { type: 'triangle', gain: 0.12, slide: 140 }),
  capture: () => { tone(320, 0, 0.06, { type: 'square', gain: 0.05, slide: 180 }); tone(160, 0.04, 0.1, { type: 'triangle', gain: 0.1 }); },
  check: () => { tone(660, 0, 0.09, { type: 'sine', gain: 0.07 }); tone(880, 0.1, 0.12, { type: 'sine', gain: 0.07 }); },
  error: () => tone(130, 0, 0.18, { type: 'sawtooth', gain: 0.04, slide: 90 }),
  correct: () => { tone(740, 0, 0.07, { gain: 0.06 }); tone(990, 0.07, 0.1, { gain: 0.06 }); },
  wrong: () => tone(200, 0, 0.2, { type: 'triangle', gain: 0.08, slide: 120 }),
  start: () => { tone(392, 0, 0.1, { gain: 0.06 }); tone(523, 0.1, 0.1, { gain: 0.06 }); tone(659, 0.2, 0.16, { gain: 0.06 }); },
  end: () => { tone(523, 0, 0.14, { gain: 0.06 }); tone(392, 0.14, 0.14, { gain: 0.06 }); tone(262, 0.28, 0.3, { gain: 0.06 }); },
  win: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.16, { gain: 0.06 })); },
  tick: () => tone(1200, 0, 0.03, { type: 'square', gain: 0.02 }),
};

export class Sound {
  constructor(settings) {
    this.settings = settings;
  }

  play(name) {
    if (!this.settings.get('sound')) return;
    const fn = SOUNDS[name];
    if (!fn) return;
    try {
      const ac = audio();
      if (ac && ac.state === 'suspended') ac.resume();
      fn();
    } catch {
      /* ignore */
    }
  }
}
