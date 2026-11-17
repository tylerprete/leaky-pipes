/* Leaky Pipes service worker: lets the game open with no connection.
 *
 * The whole game is one page plus a few icons, so this is small:
 *   install    save the page and icons (a fresh copy for each build)
 *   the page   ask the network first, so an open game is always the current version; if there is
 *              no answer within a moment (offline, bad signal), use the saved copy
 *   icons      saved copy first
 *   fonts      saved the first time they load, then always from the saved copy
 * Online play still needs a connection: WebSockets never pass through here.
 */
const BUILD = 'eafac0c2900e';
const CACHE = 'leaky-' + BUILD;
const FONTS = 'leaky-fonts-1';
const SHELL = ['./', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'];
const PAGE = new URL('./', self.location).href; // works at a site root and in a sub-folder (GitHub Pages)
const WAIT_MS = 2500;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()) // safe: an open page has all its code already and loads nothing later
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('leaky-') && k !== CACHE && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function page(e) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(PAGE);
  const fresh = fetch(e.request).then((res) => {
    if (!res.ok) throw new Error('status ' + res.status);
    if (!res.redirected) cache.put(PAGE, res.clone());
    return res;
  });
  if (!saved) return fresh;
  e.waitUntil(fresh.catch(() => {})); // if the saved copy wins the race, still keep the newer one for next time
  const late = new Promise((done) => setTimeout(() => done(saved), WAIT_MS));
  return Promise.race([fresh, late]).catch(() => saved);
}
async function shell(req) {
  const cache = await caches.open(CACHE);
  return (await cache.match(req, { ignoreSearch: true })) || fetch(req);
}
async function font(req) {
  const cache = await caches.open(FONTS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    const path = url.origin + url.pathname;
    if (req.mode === 'navigate') {
      if (path === PAGE || path === PAGE + 'index.html') e.respondWith(page(e));
    } else if (SHELL.some((u) => u !== './' && path === PAGE + u)) e.respondWith(shell(req));
    return; // anything else on this site (health check, sockets) goes straight to the network
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') e.respondWith(font(req));
});
