/* Offline support: the app shell and river data are network-first (so a
 * republished map shows up immediately) with a cache fallback on the water;
 * basemap tiles you have viewed are cache-first, capped. Tiles are requested
 * with CORS — opaque responses would each be billed ~7 MB of storage quota. */
const SHELL = 'srz-shell-v4', TILES = 'srz-tiles-v2', MAX_TILES = 1500;
// a connection that is up but moves no data (weak LTE, captive portal) must not
// strand the app: after this long, answer from the cache and let the network finish
const NET_TIMEOUT_MS = 4000;
const CORE = ['./', 'index.html', 'style.css', 'app.js', 'engine.js', 'export.js', 'print.html', 'icon.svg',
  'manifest.webmanifest', 'data/config.json', 'data/reach.json', 'data/features.geojson',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/geoman/leaflet-geoman.js', 'vendor/geoman/leaflet-geoman.css', 'vendor/qrcode/qrcode.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
const isTile = u => /\/tile\/\d+\/\d+\/\d+/.test(u.pathname);
async function trim() {
  const c = await caches.open(TILES), keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (isTile(u)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { c.put(req, res.clone()); e.waitUntil(trim()); }
      return res;
    }));
    return;
  }
  if (u.origin !== location.origin) return;           // live gauges / weather: always network
  // revalidate with the server (cheap with ETags) so a republished map isn't hidden behind max-age;
  // navigations keep their own request (rebuilding one breaks redirect handling)
  const net = fetch(req.mode === 'navigate' ? req : new Request(req, { cache: 'no-cache' })).then(res => {
    if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(SHELL).then(c => c.put(req, copy))); }
    return res;
  });
  e.waitUntil(net.catch(() => null));                  // a late answer still refreshes the cache
  const cached = () => caches.match(req, { ignoreSearch: true });
  e.respondWith(new Promise(resolve => {
    let done = false;
    const answer = r => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => cached().then(hit => { if (hit) answer(hit); }), NET_TIMEOUT_MS);
    net.then(res => { clearTimeout(timer); answer(res); },
      () => { clearTimeout(timer); cached().then(hit => answer(hit || Response.error())); });
  }));
});
