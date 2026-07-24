(function () {
  "use strict";

  /* G-ON CONFLUENCE — colonne "CARNET & PROFIL" + CVD en zone volume.
   * Design valide par maquette (maquette-confluence.html) :
   *   - colonne de verre dediee (soeur de flex, entre le chart et FLUX) :
   *     Volume Profile reconstruit des KLINES de la fenetre visible (split
   *     acheteur par takerBuyVolume), POC dore ;
   *   - murs de liquidite du carnet reel (@depth20@500ms, chemins routes) :
   *     barre = ordre passif massif, solidite = anciennete, "SPOOF ?" sur un
   *     mur qui disparait jeune ; cadre or "MUR + NIVEAU" en confluence avec
   *     un POI actif ;
   *   - CVD en bas du chart, par-dessus la zone volume, aire en DEGRADE
   *     (exception charte actee par Meddy 19/07 — ne pas generaliser).
   * Alignement prix : tout passe par gon.priceToY / gon.timeToX — la colonne
   * partage exactement l'echelle de la chart. Module independant : sa propre
   * socket depth ; lecture seule de __gonPoi (accumulator/config/pois). */

  // Paire directionnelle pilotée par la palette du chart (gon:theme) : le
  // carnet, le profil et le CVD s'accordent avec bougies/orbs/dominance.
  let BUY = "#2f8bff", SELL = "#ff2d5e";
  const GOLD = "#d9b64d";
  const syncPalette = (t) => { if (t && t.bull) BUY = t.bull; if (t && t.bear) SELL = t.bear; };
  syncPalette(window.__gon && window.__gon.theme);
  window.addEventListener("gon:theme", (e) => syncPalette(e.detail));
  const ON_KEY = "gon.confl.on";
  const PANEL_W = 165;
  const WALL_MIN_USD = 1.5e6;          // plancher absolu d'un mur
  const WALL_FACTOR = 6;               // ... et >= 6x la mediane du carnet
  const STALL_MS = 20000;
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
  // teinte vers le blanc (pointe des barres-laser) — hex -> hex
  const tint = (hex, f) => { const n = parseInt(hex.slice(1), 16);
    const r = Math.round((n >> 16 & 255) + (255 - (n >> 16 & 255)) * f);
    const g = Math.round((n >> 8 & 255) + (255 - (n >> 8 & 255)) * f);
    const b = Math.round((n & 255) + (255 - (n & 255)) * f);
    return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0"); };

  let gon = null, P = null;
  let panel, cvPanel, cxPanel, cvCvd, cxCvd, btn;
  let visible = true, curSymbol = "", rafId = 0;
  let ws = null, attempt = 0, lastMsgAt = 0, reconnectTimer = 0;

  /* ---------- profil + CVD : reconstruits des klines sur la FENETRE VISIBLE
   * de la chart (comme un VPVR) — l'intervalle s'adapte au zoom pour rester
   * sous ~700 bougies. CVD EXACT (2*takerBuy - volume, volume agresseur reel) ;
   * profil = volume distribue sur le range de chaque bougie. Refetch quand la
   * fenetre visible bouge de >25 % (mini 8 s entre appels) ou toutes les 60 s. */
  let profile = new Map(), profMax = 0, pocBin = null, cvdPts = [], binSize = 10;
  let vaLoBin = null, vaHiBin = null;   // Value Area 70 % (calculee a la reconstruction)
  let lastKlinesAt = 0, klinesBusy = false, lastFetchRange = null, lastTf = "";
  // Memo du filtre ACTIFS (audit) : invalide sur reassignation de pois OU apres
  // 1 s — poi-feature MUTE AUSSI EN PLACE (bootstrap pois[pos]=/push, revue) et
  // l'identite seule figeait les murs jusqu'a ~15 min apres un switch.
  let activePoisSrc = null, activePois = [], activePoisAt = 0;
  let fapiCoolUntil = 0;                       // 429/418 (audit) : plus aucune requete klines avant l'echeance
  function pickInterval(spanSec) {
    for (const [iv, sec] of [["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400], ["1d", 86400]]) {
      if (spanSec / sec <= 700) return [iv, sec];
    }
    return ["1d", 86400];
  }
  function visibleRange() {
    try {
      // gon.ts est une FONCTION dans le seam G-Bot : () => chart.timeScale()
      const t = typeof gon.ts === "function" ? gon.ts() : gon.ts;
      const vr = t && t.getVisibleRange ? t.getVisibleRange() : null;
      if (vr && Number.isFinite(+vr.from) && Number.isFinite(+vr.to)) return { from: +vr.from, to: +vr.to };
    } catch (_) {}
    const now = Math.floor(Date.now() / 1000);
    return { from: now - 48 * 3600, to: now };
  }
  async function rebuildFromKlines() {
    if (klinesBusy) return;
    const now = Date.now();
    const vr = visibleRange();
    let from = Math.floor(vr.from), to = Math.min(Math.ceil(vr.to), Math.floor(now / 1000) + 900);
    if (to - from < 3600) from = to - 3600;
    const span = to - from;
    if (lastFetchRange && now - lastKlinesAt < 55000 &&
        Math.abs(from - lastFetchRange.from) < span * 0.25 &&
        Math.abs(to - lastFetchRange.to) < span * 0.25) return;
    if (now - lastKlinesAt < 8000) return;       // cadence dure pendant un pan
    klinesBusy = true;
    lastKlinesAt = now;                          // avance MEME sur echec : pas de martelage 429
    const sym = curSymbol;
    try {
      // ban/limite en cours (LOCAL ou PARTAGÉ — revue) : ne pas l'entretenir
      if (Date.now() < Math.max(fapiCoolUntil, gon.apiCool ? gon.apiCool.until() : 0)) return;
      const [iv] = pickInterval(span);
      const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${iv}` +
        `&startTime=${from * 1000}&endTime=${to * 1000}&limit=1000`,
        { signal: AbortSignal.timeout(10000) });   // fetch pendu = klinesBusy bloque (audit)
      if (r.status === 429 || r.status === 418) {   // honorer Retry-After : marteler PROLONGE le ban Binance
        const ra = Number(r.headers.get("retry-after")) || 30;
        fapiCoolUntil = Date.now() + ra * 1000;
        if (gon.apiCool) gon.apiCool.hit(ra);   // horloge partagée (revue) : fait taire chart/POI/whale aussi
        return;
      }
      if (!r.ok) return;
      const rows = await r.json();
      if (curSymbol !== sym || !Array.isArray(rows) || rows.length < 2) return;
      lastFetchRange = { from, to };
      let lo = Infinity, hi = -Infinity;
      for (const k of rows) { lo = Math.min(lo, +k[3]); hi = Math.max(hi, +k[2]); }
      // bin d'AFFICHAGE ~90 lignes, quantifie sur l'echelle 1/2/5 et avec
      // HYSTERESIS : on ne change de bin que si l'ecart depasse ~2x — sinon
      // chaque refetch reshufflait toutes les barres (profil "instable").
      const raw = (hi - lo) / 90;
      // Fenetre parfaitement plate (high===low, marche halte) : raw=0 ->
      // log10(0)=-Inf -> target=0 -> binSize=0 -> b0/b1=+-Inf, share=NaN, profil
      // corrompu 1 cycle. On garde le binSize precedent (ou 1 au demarrage).
      if (!(raw > 0)) {
        if (!(binSize > 0)) binSize = 1;
      } else {
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        let target = 10 * mag;
        for (const m of [1, 2, 5]) if (raw <= m * mag) { target = m * mag; break; }
        if (!(binSize > 0) || target > binSize * 1.9 || target < binSize / 1.9) binSize = target;
      }
      const prof = new Map(), pts = [];
      let cum = 0;
      for (const k of rows) {
        const l = +k[3], h = +k[2], vol = +k[5], buy = +k[9];
        const b0 = Math.floor(l / binSize), b1 = Math.floor(h / binSize);
        const share = vol / (b1 - b0 + 1), buyFrac = vol > 0 ? buy / vol : 0.5;
        for (let b = b0; b <= b1; b++) {
          const e = prof.get(b) || { vol: 0, buy: 0 };
          e.vol += share; e.buy += share * buyFrac;
          prof.set(b, e);
        }
        cum += 2 * buy - vol;                      // delta agresseur exact
        pts.push({ tSec: +k[0] / 1000, cvd: cum });
      }
      profile = prof; cvdPts = pts;
      profMax = 0; pocBin = null;
      let totalVol = 0;
      for (const [b, e] of profile) { totalVol += e.vol; if (e.vol > profMax) { profMax = e.vol; pocBin = b; } }
      // VALUE AREA 70 % : expansion bilatérale depuis le POC vers le voisin le
      // plus volumineux — calculée ICI (une fois par refetch), jamais par frame.
      vaLoBin = vaHiBin = null;
      if (pocBin != null && totalVol > 0) {
        const bins = [...profile.keys()].sort((x, y) => x - y);
        let lo = bins.indexOf(pocBin), hi = lo;
        let covered = profile.get(pocBin).vol;
        const target = totalVol * 0.7;
        while (covered < target && (lo > 0 || hi < bins.length - 1)) {
          const vLo = lo > 0 ? profile.get(bins[lo - 1]).vol : -1;
          const vHi = hi < bins.length - 1 ? profile.get(bins[hi + 1]).vol : -1;
          if (vHi >= vLo) { hi += 1; covered += profile.get(bins[hi]).vol; }
          else { lo -= 1; covered += profile.get(bins[lo]).vol; }
        }
        vaLoBin = bins[lo]; vaHiBin = bins[hi];
      }
    } catch (_) {} finally { klinesBusy = false; }
  }

  /* ---------- murs (carnet @depth20) ---------- */
  // cle = prix ; un mur garde son anciennete (firstSeen) tant qu'il reste
  // present ; un mur qui disparait avant 8 s laisse un fantome "SPOOF ?" 3 s.
  let walls = new Map(), ghosts = [];
  function onDepth(bids, asks) {
    const now = Date.now();
    const rows = [];
    for (const [p, q] of bids) rows.push({ price: +p, usd: +p * +q, side: "bid" });
    for (const [p, q] of asks) rows.push({ price: +p, usd: +p * +q, side: "ask" });
    const meds = rows.map((r) => r.usd).sort((a, b) => a - b);
    const median = meds[meds.length >> 1] || 0;
    const thr = Math.max(WALL_MIN_USD, median * WALL_FACTOR);
    const seen = new Set();
    for (const r of rows) {
      if (r.usd < thr) continue;
      const key = r.side + ":" + r.price;
      seen.add(key);
      const w = walls.get(key);
      if (w) { w.usd = r.usd; w.lastSeen = now; }
      else walls.set(key, { price: r.price, usd: r.usd, side: r.side, firstSeen: now, lastSeen: now });
    }
    for (const [key, w] of walls) {
      if (seen.has(key)) continue;
      walls.delete(key);
      if (now - w.firstSeen < 8000) ghosts.push({ price: w.price, usd: w.usd, side: w.side, died: now });
    }
    while (ghosts.length > 12) ghosts.shift();
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (!curSymbol) return;
    const sym = curSymbol.toLowerCase();
    const socket = new WebSocket(`wss://fstream.binance.com/market/ws/${sym}@depth20@500ms`);
    ws = socket;
    socket.onopen = () => { if (ws !== socket) return; attempt = 0; lastMsgAt = Date.now(); };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      reconnectTimer = setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, attempt++)));
    };
    socket.onmessage = (m) => {
      if (ws !== socket) return;
      lastMsgAt = Date.now();
      let d; try { d = JSON.parse(m.data); } catch (_) { return; }
      const bids = d.b || d.bids, asks = d.a || d.asks;
      if (Array.isArray(bids) && Array.isArray(asks)) onDepth(bids, asks);
    };
  }

  /* ---------- rendu ---------- */
  const shown = () => visible && panel && panel.offsetParent !== null;

  function drawPanel(now) {
    // rect du CANVAS (top:26px dans le panneau) — dimensionner sur le rect du
    // panneau decalait tout le rendu de 26 px vers le bas (audit #3).
    const host = cvPanel.getBoundingClientRect();
    const w = Math.round(host.width), h = Math.round(host.height);
    // Garde readiness AVANT le resize : reassigner cvPanel.width EFFACE le
    // bitmap ; si un resize coincide avec une frame ou priceToY est null (TF en
    // rechargement + fenetre qui se redimensionne), on aurait efface PUIS
    // return -> flash blanc. On garde l'image precedente intacte a la place.
    if (profile.size) {
      const anyBin = profile.keys().next().value;
      const py = gon.priceToY(anyBin * binSize);
      if (py == null || !isFinite(py)) return;
    }
    if (w > 0 && h > 0 && (cvPanel.width !== w || cvPanel.height !== h)) { cvPanel.width = w; cvPanel.height = h; }
    cxPanel.clearRect(0, 0, w, h);
    // le panneau partage l'echelle du chart : y_chart -> y_panel via l'offset
    // vertical entre les deux boites (tops alignes par le flex, mais robuste)
    const chartTop = gon.mount.getBoundingClientRect().top;
    const dy = chartTop - host.top;
    const innerR = w - 12, maxW = w - 70;

    // --- SCANLINE : balayage lumineux lent (fond, ~7 s par traversee)
    {
      const sy = ((now * 0.045) % (h + 90)) - 45;
      const g = cxPanel.createLinearGradient(0, sy - 26, 0, sy + 26);
      g.addColorStop(0, "rgba(180,200,255,0)");
      g.addColorStop(0.5, "rgba(180,200,255,.045)");
      g.addColorStop(1, "rgba(180,200,255,0)");
      cxPanel.fillStyle = g;
      cxPanel.fillRect(0, sy - 26, w, 52);
    }

    // --- RAIL : axe vertical dore d'ou emanent les barres du profil
    cxPanel.save();
    cxPanel.shadowColor = GOLD; cxPanel.shadowBlur = 4;
    cxPanel.strokeStyle = "rgba(217,182,77,.28)"; cxPanel.lineWidth = 1;
    cxPanel.beginPath(); cxPanel.moveTo(innerR + 0.5, 30); cxPanel.lineTo(innerR + 0.5, h - 8); cxPanel.stroke();
    cxPanel.restore();

    // --- VALUE AREA 70 % : voile + bornes VAH/VAL en pointilles
    if (vaLoBin != null && vaHiBin != null) {
      const yVaTop = gon.priceToY((vaHiBin + 1) * binSize), yVaBot = gon.priceToY(vaLoBin * binSize);
      if (yVaTop != null && yVaBot != null && isFinite(yVaTop) && isFinite(yVaBot)) {
        const t = Math.min(yVaTop, yVaBot) + dy, b = Math.max(yVaTop, yVaBot) + dy;
        if (b > 30 && t < h - 8) {
          cxPanel.fillStyle = "rgba(217,182,77,.05)";
          cxPanel.fillRect(6, Math.max(30, t), w - 18, Math.min(h - 8, b) - Math.max(30, t));
          cxPanel.setLineDash([3, 4]);
          cxPanel.strokeStyle = "rgba(217,182,77,.30)"; cxPanel.lineWidth = 1;
          for (const [yy, lbl] of [[t, "VAH"], [b, "VAL"]]) {
            if (yy < 30 || yy > h - 8) continue;
            cxPanel.beginPath(); cxPanel.moveTo(6, Math.round(yy) + 0.5); cxPanel.lineTo(innerR, Math.round(yy) + 0.5); cxPanel.stroke();
            cxPanel.fillStyle = "rgba(217,182,77,.55)"; cxPanel.font = "600 7px Segoe UI";
            cxPanel.fillText(lbl, 7, yy + (lbl === "VAH" ? -3 : 9));
          }
          cxPanel.setLineDash([]);
        }
      }
    }

    // --- profil (geometrie PAR BARRE depuis les bords exacts du bin :
    // stable sous n'importe quel rescale de la barre des prix — plus aucun
    // fallback global qui faisait sauter toutes les barres quand le POC
    // sortait de l'ecran)
    if (profile.size && profMax > 0) {
      const bars = [];
      for (const [b, e] of profile) {
        const y0 = gon.priceToY(b * binSize), y1 = gon.priceToY((b + 1) * binSize);
        if (y0 == null || y1 == null || !isFinite(y0) || !isFinite(y1)) continue;
        const hh = Math.max(1.2, Math.abs(y0 - y1) * 0.82);
        const yTop = Math.min(y0, y1) + dy + Math.abs(y0 - y1) * 0.09;
        if (yTop + hh < 30 || yTop > h - 8) continue;
        const wBar = e.vol / profMax * maxW;
        const buyFrac = e.vol > 0 ? Math.max(0, Math.min(1, e.buy / e.vol)) : 0.5;   // 0/0 -> NaN sinon
        bars.push({ b, yTop, hh, wBar, wBuy: wBar * buyFrac, buyFrac });
      }
      // glow UNE fois par passe de couleur (pas par barre) et seulement si les
      // lignes sont assez hautes. Base sur la MEDIANE des hauteurs (stable), pas
      // sur bars[0] (barre arbitraire dont le hh traversait le seuil au zoom de
      // l'axe prix -> tout le profil scintillait). Seuil un peu plus haut = pas
      // de bascule au ras.
      const hMed = bars.length ? bars.map((bb) => bb.hh).sort((a, b) => a - b)[bars.length >> 1] : 0;
      const glow = hMed >= 3;
      cxPanel.save();
      // BARRES-LASER : base bicolore un peu tamisee + POINTE lumineuse teintee
      // blanc a l'extremite (la ou finit le volume) — lecture immediate de la
      // portee de chaque ligne, style faisceau.
      if (glow) { cxPanel.shadowColor = BUY; cxPanel.shadowBlur = 5; }
      for (const bar of bars) {
        cxPanel.fillStyle = rgba(BUY, bar.b === pocBin ? 0.9 : 0.42);
        cxPanel.fillRect(innerR - bar.wBar, bar.yTop, bar.wBuy, bar.hh);
      }
      if (glow) cxPanel.shadowColor = SELL;
      for (const bar of bars) {
        cxPanel.fillStyle = rgba(SELL, bar.b === pocBin ? 0.9 : 0.42);
        cxPanel.fillRect(innerR - bar.wBar + bar.wBuy, bar.yTop, bar.wBar - bar.wBuy, bar.hh);
      }
      // pointes (une passe, sans glow — le point net au bout du faisceau)
      cxPanel.shadowBlur = 0;
      for (const bar of bars) {
        if (bar.wBar < 6) continue;
        const hue = bar.buyFrac >= 0.5 ? BUY : SELL;
        cxPanel.fillStyle = rgba(tint(hue, 0.65), bar.b === pocBin ? 0.95 : 0.65);
        cxPanel.fillRect(innerR - bar.wBar, bar.yTop, 1.6, bar.hh);
      }
      cxPanel.restore();
      const poc = bars.find((bar) => bar.b === pocBin);
      if (poc) {
        const pulse = 0.75 + 0.25 * Math.sin(now * 0.004);
        const yMid = Math.round(poc.yTop + poc.hh / 2) + 0.5;
        // ligne POC pleine largeur (sous la barre) + contour pulse + chip
        cxPanel.save();
        cxPanel.strokeStyle = `rgba(217,182,77,${0.20 + 0.10 * pulse})`; cxPanel.lineWidth = 1;
        cxPanel.beginPath(); cxPanel.moveTo(6, yMid); cxPanel.lineTo(innerR, yMid); cxPanel.stroke();
        cxPanel.shadowColor = GOLD; cxPanel.shadowBlur = 8 * pulse;
        cxPanel.strokeStyle = `rgba(255,255,255,${0.8 * pulse})`; cxPanel.lineWidth = 0.7;
        cxPanel.strokeRect(innerR - poc.wBar, poc.yTop, poc.wBar, poc.hh);
        cxPanel.restore();
        // chip ANCREE au bord gauche (jamais noyee dans les barres), avec le
        // PRIX du POC — la ligne doree pleine largeur la relie a sa barre.
        const pocPrice = (pocBin + 0.5) * binSize;
        const txt = "POC " + Math.round(pocPrice).toLocaleString("fr-FR");
        cxPanel.font = "600 9px Segoe UI";
        const tw = cxPanel.measureText(txt).width;
        const cy = poc.yTop + poc.hh / 2;
        cxPanel.save();
        cxPanel.shadowColor = GOLD; cxPanel.shadowBlur = 6;
        cxPanel.fillStyle = "rgba(10,10,8,.92)";
        cxPanel.fillRect(5, cy - 7.5, tw + 8, 15);
        cxPanel.restore();
        cxPanel.strokeStyle = "rgba(217,182,77,.65)"; cxPanel.lineWidth = 0.8;
        cxPanel.strokeRect(5, cy - 7.5, tw + 8, 15);
        cxPanel.fillStyle = GOLD;
        cxPanel.fillText(txt, 9, cy + 3.5);
      }
    }

    // --- murs + fantomes spoof
    // Audit 2026-07-22 : le filtre refaisait ~10k iterations + 1 allocation PAR
    // FRAME (60 fps) pour quelques murs. Memoise sur l'identite du tableau —
    // poi-feature REASSIGNE pois a chaque mutation (merge/flush), la reference
    // est donc un numero de version fiable.
    const rawPois = P.pois() || [];
    const nowP = performance.now();
    if (rawPois !== activePoisSrc || nowP - activePoisAt > 1000) {
      activePoisSrc = rawPois; activePoisAt = nowP;
      activePois = rawPois.filter((p) => p.status === "ACTIVE_UNTOUCHED");
    }
    const pois = activePois;
    const drawWall = (price, usd, side, alpha, spoof) => {
      const yC = gon.priceToY(price);
      if (yC == null || !isFinite(yC)) return;
      const y = Math.round(yC + dy);
      if (y < 30 || y > h - 8) return;
      const hue = side === "bid" ? BUY : SELL;
      const len = 40 + Math.max(0, Math.log10(usd / 1e6)) * 46;
      cxPanel.save();
      cxPanel.shadowColor = hue; cxPanel.shadowBlur = 12 * alpha;
      cxPanel.fillStyle = rgba(hue, 0.6 * alpha);
      cxPanel.fillRect(innerR - len, y - 3, len, 6);
      cxPanel.fillStyle = `rgba(255,255,255,${0.9 * alpha})`;
      cxPanel.fillRect(innerR - len, y - 3, 2.2, 6);
      cxPanel.restore();
      cxPanel.fillStyle = rgba(hue, Math.max(0.3, alpha)); cxPanel.font = "600 9px Segoe UI";
      cxPanel.fillText((usd / 1e6).toFixed(0) + "M$", innerR - len - 28, y + 3);
      if (spoof) { cxPanel.fillStyle = "rgba(110,106,88,.9)"; cxPanel.fillText("SPOOF ?", innerR - len - 74, y + 3); }
      if (!spoof) {
        for (const p of pois) {
          const e = p.entry ?? p.entryPrice, ly = e != null ? gon.priceToY(e) : null;
          if (ly == null || Math.abs(ly - yC) >= 12) continue;
          const pulse = 0.7 + 0.3 * Math.sin(now * 0.005);
          cxPanel.save(); cxPanel.shadowColor = GOLD; cxPanel.shadowBlur = 10 * pulse;
          cxPanel.strokeStyle = `rgba(217,182,77,${0.75 * pulse})`; cxPanel.lineWidth = 1;
          cxPanel.strokeRect(innerR - len - 4, y - 7, len + 8, 14); cxPanel.restore();
          cxPanel.fillStyle = GOLD; cxPanel.font = "600 8px Segoe UI";
          cxPanel.fillText("MUR + NIVEAU", innerR - len - 4, y - 11);
          break;
        }
      }
    };
    const nowMs = Date.now();
    // flux carnet perime (socket muette) : ne PAS afficher des murs figes qui
    // paraissent de plus en plus solides — donnee morte = rien.
    const bookFresh = lastMsgAt && nowMs - lastMsgAt < STALL_MS;
    if (bookFresh) for (const w of walls.values()) {
      // solidite par anciennete : nait a 0.35, plein a 0.9 apres 20 s
      const age = Math.min(1, (nowMs - w.firstSeen) / 20000);
      drawWall(w.price, w.usd, w.side, 0.35 + 0.55 * age, false);
    }
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i], a = 1 - (nowMs - g.died) / 3000;
      if (a <= 0) { ghosts.splice(i, 1); continue; }
      drawWall(g.price, g.usd, g.side, 0.18 * a, true);
    }
  }

  let cvdSig = "";
  function drawCvd() {
    const host = gon.mount.getBoundingClientRect();
    const w = Math.round(host.width), h = Math.round(host.height);
    if (w > 0 && h > 0 && (cvCvd.width !== w || cvCvd.height !== h)) { cvCvd.width = w; cvCvd.height = h; }
    // P3 (audit 2026-07-24) : le CVD est STATIQUE entre deux pans/zooms/
    // refetchs — le repeindre a 60 fps payait ~700 segments laser ombres par
    // frame a vue figee. Signature de vue : on ne redessine que si quelque
    // chose a reellement change (l'image precedente reste sinon).
    let vr = "";
    try { const r = gon.ts().getVisibleRange(); vr = r ? r.from + ":" + r.to : ""; } catch (_) {}
    const sig = w + "x" + h + "|" + vr + "|" + cvdPts.length + "|" +
      (cvdPts.length ? cvdPts[cvdPts.length - 1].cvd : 0) + "|" +
      (lastFetchRange ? lastFetchRange.to : 0) + "|" + BUY + SELL;
    if (sig === cvdSig) return;
    cvdSig = sig;
    cxCvd.clearRect(0, 0, w, h);
    if (cvdPts.length < 2) return;
    // zone volume de G-Bot : scaleMargins top .85 -> le bandeau occupe ~15 %
    const zTop = h * 0.85, zBot = h - 22;
    // Echelle verticale du CVD sur TOUTE la serie (stable), pas sur les seuls
    // points visibles : sinon l'aire se redimensionne a chaque pan/zoom et SAUTE
    // au changement de TF (le sous-ensemble visible change).
    let cMin = Infinity, cMax = -Infinity;
    for (const p of cvdPts) { if (p.cvd < cMin) cMin = p.cvd; if (p.cvd > cMax) cMax = p.cvd; }
    const pts = [];
    for (const p of cvdPts) {
      const x = gon.timeToX(p.tSec);
      if (x == null || !isFinite(x) || x < -40 || x > w - 60) continue;
      pts.push({ x, cvd: p.cvd });
    }
    if (pts.length < 2 || !(cMax > cMin)) return;
    const yC = (v) => zBot - (v - cMin) / (cMax - cMin) * (zBot - zTop - 6);
    const y0 = yC(Math.max(cMin, Math.min(cMax, 0)));
    cxCvd.save();
    cxCvd.beginPath(); cxCvd.rect(0, zTop, w - 58, zBot - zTop + 8); cxCvd.clip();
    // aire en DEGRADE vers la base (exception charte, actee)
    for (const sign of [1, -1]) {
      cxCvd.beginPath(); cxCvd.moveTo(pts[0].x, y0);
      for (const p of pts) {
        const vy = sign > 0 ? Math.min(yC(p.cvd), y0) : Math.max(yC(p.cvd), y0);
        cxCvd.lineTo(p.x, vy);
      }
      cxCvd.lineTo(pts[pts.length - 1].x, y0); cxCvd.closePath();
      const grad = cxCvd.createLinearGradient(0, sign > 0 ? zTop : zBot, 0, y0);
      const hue = sign > 0 ? BUY : SELL;
      grad.addColorStop(0, rgba(hue, 0.14));
      grad.addColorStop(1, rgba(hue, 0.01));
      cxCvd.fillStyle = grad; cxCvd.fill();
    }
    cxCvd.setLineDash([4, 4]);
    cxCvd.strokeStyle = "rgba(110,106,88,.22)"; cxCvd.lineWidth = 1;
    cxCvd.beginPath(); cxCvd.moveTo(0, y0); cxCvd.lineTo(w - 58, y0); cxCvd.stroke();
    cxCvd.setLineDash([]);
    // trace LASER deux passes : halo large doux puis coeur net et brillant.
    // P3 : batche PAR TEINTE — un stroke ombre par (passe, teinte), soit 4 au
    // total, au lieu de 2 par segment (~1400 composites shadowBlur par frame).
    // Geometrie identique : chaque segment reste un sous-chemin moveTo/lineTo.
    for (const pass of [{ blur: 6, alpha: 0.18, lw: 2.4 }, { blur: 2, alpha: 0.75, lw: 1 }]) {
      for (const hue of [BUY, SELL]) {
        cxCvd.beginPath();
        let any = false;
        for (let i = 1; i < pts.length; i++) {
          if ((pts[i].cvd >= pts[i - 1].cvd ? BUY : SELL) !== hue) continue;
          cxCvd.moveTo(pts[i - 1].x, yC(pts[i - 1].cvd));
          cxCvd.lineTo(pts[i].x, yC(pts[i].cvd));
          any = true;
        }
        if (!any) continue;
        cxCvd.shadowColor = hue; cxCvd.shadowBlur = pass.blur;
        cxCvd.strokeStyle = rgba(hue, pass.alpha); cxCvd.lineWidth = pass.lw;
        cxCvd.stroke();
      }
    }
    cxCvd.shadowBlur = 0;
    cxCvd.fillStyle = "rgba(217,182,77,.50)"; cxCvd.font = "600 8px Segoe UI";
    const spanH = lastFetchRange ? Math.round((lastFetchRange.to - lastFetchRange.from) / 3600) : 0;
    cxCvd.fillText(spanH >= 48 ? `CVD ${Math.round(spanH / 24)}j` : `CVD ${spanH}h`, 8, zTop + 11);
    cxCvd.restore();
  }

  let hiddenCleared = false;
  function loop() {
    if (!shown()) {
      // le CVD vit sur le CHART : si la colonne se masque (media query),
      // l'overlay doit etre efface — sinon il reste incruste et se desaligne.
      if (!hiddenCleared && cxCvd && cvCvd.width) {
        cxCvd.clearRect(0, 0, cvCvd.width, cvCvd.height);
        cvdSig = "";   // P3 : le canvas vient d'etre vide — la signature ne doit pas faire sauter le redraw au retour
        hiddenCleared = true;
      }
      // On ARRETE la boucle rAF quand le panneau est masque (fenetre etroite) au
      // lieu de tourner a 60 fps a vide (CPU/batterie) ; slowTick la relance.
      rafId = 0;
      return;
    }
    hiddenCleared = false;
    rafId = requestAnimationFrame(loop);
    const now = performance.now();
    drawPanel(now);
    drawCvd();
  }

  function applyVisible() {
    panel.style.display = visible ? "block" : "none";
    cvCvd.style.display = visible ? "block" : "none";
    if (btn) btn.classList.toggle("on", visible);
    if (!visible) { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
    else if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function slowTick() {
    if (gon.symbol && gon.symbol !== curSymbol) {
      curSymbol = gon.symbol;
      walls = new Map(); ghosts = []; profile = new Map(); cvdPts = [];
      lastKlinesAt = 0; lastFetchRange = null;
      attempt = 0;   // backoff neuf pour le nouveau symbole (sinon demarre haut)
      if (ws) { ws.onclose = null; try { ws.close(); } catch (_) {} ws = null; }
      connect();
      rebuildFromKlines();
    }
    // Changement de TF : le module derivait son intervalle du span visible et
    // etait bloque par les throttles 8 s / 55 s -> profil de l'ancien TF affiche
    // puis saut differe. On force un refetch IMMEDIAT en annulant les throttles.
    if (gon.tf && gon.tf !== lastTf) {
      lastTf = gon.tf;
      lastKlinesAt = 0; lastFetchRange = null;
    }
    if (ws && ws.readyState === 1 && lastMsgAt && Date.now() - lastMsgAt > STALL_MS) ws.close();
    if (shown()) { rebuildFromKlines(); if (!rafId) rafId = requestAnimationFrame(loop); }   // relance la boucle si masquee puis re-affichee
    // (l'ancien suivi video<->toggle ≋ est retire : le toggle n'existe plus,
    // la visibilite de la video est geree par la media query CSS + le cinema)
  }

  /* ---------- construction ---------- */
  function build() {
    gon = window.__gon; P = window.__gonPoi;
    if (!gon || !gon.mount || !P || !P.pois) { setTimeout(build, 500); return; }
    curSymbol = gon.symbol;

    const css = document.createElement("style");
    css.textContent = `
      #gonConflPanel { flex:0 0 ${PANEL_W}px; position:relative; margin:0 8px 8px 0; padding-top:8px;
        pointer-events:auto;
        background:linear-gradient(180deg, rgba(15,14,10,.92), rgba(8,8,6,.85));
        border:1px solid rgba(217,182,77,.14); border-radius:6px;
        font-family:"Segoe UI",system-ui,sans-serif; }
      /* coins lumineux (brackets futuristes) */
      #gonConflPanel::before, #gonConflPanel::after { content:""; position:absolute; top:-1px;
        width:14px; height:14px; border:1px solid rgba(217,182,77,.55); pointer-events:none; }
      #gonConflPanel::before { left:-1px; border-right:none; border-bottom:none;
        border-top-left-radius:6px; }
      #gonConflPanel::after { right:-1px; border-left:none; border-bottom:none;
        border-top-right-radius:6px; }
      #gonConflPanel .hd { position:relative; font-size:9px; letter-spacing:3px; color:#d9b64d;
        text-align:center; padding-bottom:6px; text-shadow:0 0 10px rgba(217,182,77,.35); }
      #gonConflPanel .hd::after { content:""; position:absolute; left:8%; right:8%; bottom:0;
        height:1px; background:linear-gradient(90deg, transparent,
        rgba(217,182,77,.55), transparent); }
      #gonConflCv { position:absolute; left:0; right:0; top:26px; bottom:0; width:100%;
        height:calc(100% - 26px); }
      #gonConflCvd { position:absolute; inset:0; pointer-events:none; z-index:6; }
      #gonConflBtn { background:none; border:1px solid #232635; color:#d9b64d;
        font-size:13px; line-height:1; padding:2px 7px; cursor:pointer; opacity:.5; }
      #gonConflBtn:hover { border-color:#d9b64d; }
      #gonConflBtn.on { opacity:1; text-shadow:0 0 8px rgba(217,182,77,.6); }
      @media (max-width: 1100px) { #gonConflPanel { display:none !important; } }
      @media (max-width: 860px) { #gonRightCol > #gonLiqVideo { display:none !important; } }
      /* colonne de droite : [profil | liquidations] puis l'ECRAN video
         pleine largeur en dessous des deux panneaux */
      #gonRightCol { display:flex; flex-direction:column; min-height:0; }
      #gonRightRow { display:flex; flex:1 1 auto; min-height:0; }
      /* equilibre de la colonne : deux tours de largeur EGALE, et l'ecran
         video au FORMAT D'ORIGINE (16:9, image complete) en petit, centre */
      #gonRightRow > #gonLiqPanel { flex:0 0 165px; }
      /* les deux tours (165+8+165) font exactement la largeur de l'ecran */
      #gonRightCol > #gonLiqVideo { margin:0 8px 8px 0; align-self:flex-start; width:338px;
        aspect-ratio:16/9; border-radius:6px; overflow:hidden;
        border:1px solid rgba(217,182,77,.14); }
      /* mode CINEMA : la video prend la place du chart (le chart continue
         de tourner dessous), re-clic pour revenir */
      #gonLiqVideo.gonCinema { position:absolute; inset:0; z-index:8; width:100% !important;
        height:100%; aspect-ratio:auto; margin:0 !important; border:none; border-radius:0;
        background:#000; }
      #gonLiqVideo.gonCinema video { object-fit:cover; }
      #gonVidSwap { position:absolute; left:8px; bottom:9px; z-index:9; background:rgba(10,10,8,.6);
        color:#d9b64d; border:1px solid #232635; font-size:12px; line-height:1;
        padding:2px 7px; cursor:pointer; pointer-events:auto; }
      #gonVidSwap:hover { border-color:#d9b64d; }
      /* en plein ecran, le bouton de retour passe EN HAUT A GAUCHE */
      #gonLiqVideo.gonCinema #gonVidSwap { top:10px; left:10px; bottom:auto; font-size:14px; }
      /* cinema : la video opaque couvre le chart -> masquer les overlays
         (leurs rAF s'arretent, et le sonar se tait car shown()=false) */
      .gonCinemaActive > #poiOverlay,
      .gonCinemaActive > #gonWhaleCv,
      .gonCinemaActive > #gonWhaleRadar,
      .gonCinemaActive > #gonConflCvd { display:none !important; }
    `;
    document.head.appendChild(css);

    panel = document.createElement("div"); panel.id = "gonConflPanel";
    panel.innerHTML = `<div class="hd" title="Profil de volume de la fenetre AFFICHEE (s'adapte au zoom) : POC (prix le plus trade), VAH/VAL (zone de valeur 70 %), et murs du carnet d'ordres en direct">CARNET &nbsp;&amp;&nbsp; PROFIL</div>`;
    cvPanel = document.createElement("canvas"); cvPanel.id = "gonConflCv";
    panel.appendChild(cvPanel); cxPanel = cvPanel.getContext("2d");
    // colonne entre le chart et le panneau FLUX (soeur de flex)
    gon.mount.parentElement.insertBefore(panel, gon.mount.nextSibling);
    // puis restructuration : les deux panneaux cote a cote dans une colonne,
    // l'ecran video (celui du panneau FLUX) descend SOUS les deux.
    (function mountRightColumn(tries) {
      const liq = document.getElementById("gonLiqPanel");
      const vid = document.getElementById("gonLiqVideo");
      if (!liq || !vid) {
        if (tries > 0) setTimeout(() => mountRightColumn(tries - 1), 500);
        // liq-flux absent : le panneau confluence reste frere du chart (ok)
        return;
      }
      const parent = liq.parentElement;
      const col = document.createElement("div"); col.id = "gonRightCol";
      const row = document.createElement("div"); row.id = "gonRightRow";
      parent.insertBefore(col, liq);
      col.appendChild(row);
      row.appendChild(panel); row.appendChild(liq);
      col.appendChild(vid);
      // bouton SWITCH chart <-> video (mode cinema)
      const sw = document.createElement("button");
      sw.id = "gonVidSwap"; sw.title = "Basculer video / chart"; sw.textContent = "⇄";
      vid.appendChild(sw);
      let cinema = false;
      sw.onclick = (e) => {
        e.stopPropagation();
        cinema = !cinema;
        if (cinema) {
          gon.mount.appendChild(vid); vid.classList.add("gonCinema");
          gon.mount.classList.add("gonCinemaActive");   // masque les overlays
          // en grand ecran, les panneaux de droite sont MASQUES : le film
          // prend toute la largeur, retour a l'identique au re-clic
          col.style.display = "none";
        } else {
          vid.classList.remove("gonCinema"); col.appendChild(vid);
          gon.mount.classList.remove("gonCinemaActive");
          col.style.display = "";
        }
      };
    })(20);

    cvCvd = document.createElement("canvas"); cvCvd.id = "gonConflCvd";
    cxCvd = cvCvd.getContext("2d");
    gon.mount.appendChild(cvCvd);

    // Pas de bouton de bascule (demande Meddy) : le panneau reste toujours
    // affiche (la media query <1100px le masque seule). On purge un eventuel
    // etat "masque" herite de l'ancien toggle.
    visible = true;
    try { localStorage.removeItem(ON_KEY); } catch (_) {}

    applyVisible();
    connect();
    rebuildFromKlines();
    setInterval(slowTick, 2500);

    window.__gonConfl = {
      state: () => ({ symbol: curSymbol, socket: ws ? ws.readyState : null,
        lastMsgAgeMs: lastMsgAt ? Date.now() - lastMsgAt : null, visible,
        walls: walls.size, ghosts: ghosts.length, profileBins: profile.size,
        cvdPts: cvdPts.length, poc: pocBin != null ? pocBin * binSize : null })
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else build();
})();
