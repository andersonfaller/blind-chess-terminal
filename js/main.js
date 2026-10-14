import { Terminal } from './terminal.js';
import { Settings } from './storage.js';
import { App } from './app.js';

const settings = new Settings();
const term = new Terminal(document.getElementById('app'));
const app = new App(term, settings);
window.__bctBooted = true;
window.__app = app; // handy for debugging from the console

app.boot();
term.forceFocus();

const mic = document.getElementById('mic-btn');
if (app.listener.supported) {
  mic.hidden = false;
  mic.addEventListener('click', () => {
    term.echo('listen');
    app.execute('listen');
    mic.classList.toggle('on', app.listener.active);
  });
}

window.addEventListener('error', (e) => {
  if (e && e.message && !/ResizeObserver/.test(e.message)) term.print(`⚠ ${e.message}`, 'err');
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e && e.reason && (e.reason.message || String(e.reason));
  if (msg && !/cancelled/.test(msg)) term.print(`⚠ ${msg}`, 'err');
});

// Offline support (GitHub Pages is HTTPS; localhost is fine for development).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  // Once Stockfish has loaded, keep a copy for offline use.
  const poll = setInterval(() => {
    if (app.engines.engines.local.state !== 'ready') return;
    clearInterval(poll);
    navigator.serviceWorker.ready.then((reg) => reg.active && reg.active.postMessage('cache-engine')).catch(() => {});
  }, 3000);
}
