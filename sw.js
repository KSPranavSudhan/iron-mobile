/* sw.js -- offline app shell. Bump CACHE whenever any shipped file changes. */
const CACHE = 'iron-app-v3';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'worker.js', 'pipeline.js', 'bundle.js', 'exif.js', 'config.js',
  'manifest.webmanifest', 'lib/opencv.js', 'model/model.json', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;                 // other origins (remote model host): straight to network
  if (/\/model\/(latest\.json|model-v\d+\.json)$/.test(url.pathname)) return;        // OTA model files must never come from the cache
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
