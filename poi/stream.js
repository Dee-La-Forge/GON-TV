(function (root) {
  "use strict";

  // Politique de transport live partagee par le chart et le flux POI.
  // Extraite d'app.js pour etre testable hors navigateur (voir
  // tests/js/engine.node.js). app.js consomme cette fonction : le test
  // couvre donc le code reellement execute, pas une copie.
  const api = root.BiquetteStream = root.BiquetteStream || {};

  const BASE_RECONNECT_DELAY_MS = 1000;
  const MAX_RECONNECT_DELAY_MS = 30000;

  // Backoff exponentiel borne : 1s, 2s, 4s, 8s, 16s, puis plafonne a 30s.
  function reconnectDelayMs(attempt) {
    const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
    return Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** step);
  }

  api.BASE_RECONNECT_DELAY_MS = BASE_RECONNECT_DELAY_MS;
  api.MAX_RECONNECT_DELAY_MS = MAX_RECONNECT_DELAY_MS;
  api.reconnectDelayMs = reconnectDelayMs;
})(typeof window !== "undefined" ? window : globalThis);
