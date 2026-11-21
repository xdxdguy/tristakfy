// Caches the app shell so it opens instantly (and offline). Music and API calls are never cached here.
const CACHE = 'tristakfy-shell-v44';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'];
// How long to wait for the server before using the saved copy. With Airplane mode the network fails at once,
// but when the PC is off while Wi-Fi / Tailscale is on, requests just hang (nothing answers), so without
// this limit the app would sit on a white screen until the connection times out.
const NETWORK_WAIT = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreVary: the server marks files "Vary: Origin", and scripts are requested with an Origin header, so
    // without this the saved app.js never matches and the app waits for the network anyway
    const opts = { ignoreVary: true };
    const saved = (await cache.match(e.request, opts)) || (e.request.mode === 'navigate' ? (await cache.match('index.html', opts)) || (await cache.match('./', opts)) : undefined);
    // network first, so updates show up (no-cache: always ask the server, never reuse the phone's own HTTP cache); a fresh copy is saved whenever it arrives, even if it arrives late
    const fresh = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; });
    e.waitUntil(fresh.catch(() => {}));
    if (!saved) return fresh;                                        // first visit: nothing saved yet, so wait
    return Promise.race([
      fresh.catch(() => saved),                                      // server refused / no network: saved copy at once
      new Promise((done) => setTimeout(() => done(saved), NETWORK_WAIT)),   // server silent: saved copy after a moment
    ]);
  })());
});
