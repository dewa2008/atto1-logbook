// Offline cache. App makes no network calls; all data stays in this phone (IndexedDB).
const CACHE = 'atto1-ca94f068c9';
const ASSETS = ["./", "./index.html", "./styles.css?v=ca94f068c9", "./app.js?v=ca94f068c9", "./manifest.webmanifest", "./icons/apple-touch-icon.png", "./icons/favicon.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./fonts/jetbrains-mono-latin-600-normal.woff2", "./fonts/jetbrains-mono-latin-700-normal.woff2", "./fonts/jetbrains-mono-latin-800-normal.woff2", "./fonts/plus-jakarta-sans-latin-500-normal.woff2", "./fonts/plus-jakarta-sans-latin-600-normal.woff2", "./fonts/plus-jakarta-sans-latin-700-normal.woff2", "./fonts/plus-jakarta-sans-latin-800-normal.woff2", "./fonts/space-grotesk-latin-700-normal.woff2", "./ocr/tesseract.min.js", "./ocr/worker.min.js", "./ocr/core/tesseract-core-simd-lstm.wasm.js", "./ocr/core/tesseract-core-lstm.wasm.js", "./ocr/lang/eng.traineddata.gz"];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(r => r || fetch(e.request)));
});
