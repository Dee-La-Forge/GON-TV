/* G-ON — service worker : bouclier anti-panne GitHub Pages (page licorne).
 * Strategie NETWORK-FIRST : le reseau prime (les mises a jour de code passent
 * exactement comme avant, le watcher 3 min inclus), le cache local ne sert QUE
 * quand GitHub repond mal (5xx / licorne) ou pas du tout — l'app se recharge
 * alors depuis la derniere bonne version connue et vit sur les donnees Binance
 * (WS + REST, independantes de GitHub).
 * NOTE armement : le SW ne controle pas la visite qui l'installe — le shell
 * n'est complet en cache qu'a la navigation SUIVANTE (bouclier total des la
 * 2e visite ; les fetchs tardifs de la 1re — archives — sont deja couverts).
 * Audit 2026-07-22 :
 * - nom de cache derive du SCOPE : /G-Bot/ et /GON-TV/ vivent sur le MEME
 *   origin github.io -> un nom fixe partageait le cache entre les deux apps
 *   (quota commun, purge de l'une detruisant le bouclier de l'autre) ;
 * - purge des variantes ?v=NN au put : sans elle le cache enflait sans borne
 *   (une entree par version deployee) ET le repli ignoreSearch servait la plus
 *   VIEILLE version jamais encachee (ordre d'insertion) — app Frankenstein au
 *   moment exact ou le bouclier devait servir ;
 * - repli : match EXACT d'abord (bonne version si presente), ignoreSearch en
 *   secours seulement. */
const CACHE = "gon-shell-" + self.registration.scope.replace(/\W/g, "") + "-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  // Revue : purge du cache orphelin pre-audit (nom fixe partage entre les deux
  // apps, expose ~26 min) — no-op s'il n'existe pas, sans risque depuis que
  // G-Bot ET GON-TV tournent sur le nom derive du scope.
  try { await caches.delete("gon-shell-v1"); } catch (_) {}
  await self.clients.claim();
})()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Binance & co : jamais interceptes
  if (url.pathname.endsWith(".mp4")) return;         // video : streaming direct (206), pas de cache

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fallback = async () =>
      (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
    try {
      const net = await fetch(req);
      if (net.status >= 500) {
        // GitHub en panne (licorne) : derniere bonne copie si on l'a
        const hit = await fallback();
        if (hit) return hit;
        return net;
      }
      if (net.ok) {
        // 1 entree par chemin : purge des anciennes variantes ?v=NN puis put,
        // en UNITE sous waitUntil (revue) — le delete awaite seul etait durable
        // mais le put fire-and-forget pouvait etre perdu (SW termine, quota) :
        // copie de secours detruite sans remplacante, trou dans le bouclier.
        // Bonus : plus rien n'est awaite AVANT la livraison de la reponse.
        const copy = net.clone();   // synchrone, AVANT le return (body non consomme)
        e.waitUntil((async () => {
          try { await cache.delete(req, { ignoreSearch: true }); } catch (_) {}
          try { await cache.put(req, copy); } catch (_) {}
        })());
      }
      return net;
    } catch (err) {
      // reseau coupe : meme repli que la panne
      const hit = await fallback();
      if (hit) return hit;
      throw err;
    }
  })());
});
