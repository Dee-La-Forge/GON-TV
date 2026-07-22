/* G-ON — service worker : bouclier anti-panne GitHub Pages (page licorne).
 * Strategie NETWORK-FIRST : le reseau prime (les mises a jour de code passent
 * exactement comme avant, le watcher 3 min inclus), le cache local ne sert QUE
 * quand GitHub repond mal (5xx / licorne) ou pas du tout — l'app se recharge
 * alors depuis la derniere bonne version connue et vit sur les donnees Binance
 * (WS + REST, independantes de GitHub). Premiere visite reussie = bouclier arme. */
const CACHE = "gon-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Binance & co : jamais interceptes
  if (url.pathname.endsWith(".mp4")) return;         // video : streaming direct (206), pas de cache

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await fetch(req);
      if (net.status >= 500) {
        // GitHub en panne (licorne) : derniere bonne copie si on l'a
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        return net;
      }
      if (net.ok) cache.put(req, net.clone()).catch(() => {});   // copie fraiche en reserve
      return net;
    } catch (err) {
      // reseau coupe : meme repli que la panne
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
