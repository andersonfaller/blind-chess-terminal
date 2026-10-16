// Service worker: makes the app (and the 7 MB engine) available offline.
// App files: network first, so updates show up immediately; cache when offline.
// Vendored libraries: cache first, they never change for a given version.
const VERSION = 'v2.0.3';
const CACHE = `blind-chess-${VERSION}`;
const CORE = [
  './',
  'index.html',
  'css/style.css',
  'manifest.webmanifest',
  'assets/icon.svg',
  'js/main.js',
  'js/app.js',
  'js/terminal.js',
  'js/i18n.js',
  'js/storage.js',
  'js/chess-utils.js',
  'js/board-view.js',
  'js/ui.js',
  'js/banner.js',
  'js/game.js',
  'js/drills.js',
  'js/puzzles.js',
  'js/review.js',
  'js/openings.js',
  'js/stats.js',
  'js/speech.js',
  'js/sound.js',
  'js/data/openings.js',
  'js/data/puzzles.js',
  'js/engine/manager.js',
  'js/engine/stockfish-local.js',
  'js/engine/remote.js',
  'js/engine/basic.js',
  'js/engine/basic-search.js',
  'js/engine/basic-worker.js',
  'vendor/chess.js/chess.js',
];

// The engine (~7 MB) is cached on request, once the page has downloaded it
// anyway, so the first visit doesn't download it twice.
const ENGINE = ['vendor/stockfish/stockfish-18-lite-single.js', 'vendor/stockfish/stockfish-18-lite-single.wasm'];

self.addEventListener('message', (event) => {
  if (event.data !== 'cache-engine') return;
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    for (const url of ENGINE) {
      if (!(await cache.match(url))) await cache.add(url).catch(() => {});
    }
  }));
});

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('blind-chess-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/vendor/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
