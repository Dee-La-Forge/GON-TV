(function () {
  "use strict";

  /* G-ON CONFLUENCE — colonne "CARNET & PROFIL" + CVD en zone volume.
   * Design valide par maquette (maquette-confluence.html) :
   *   - colonne de verre dediee (soeur de flex, entre le chart et FLUX) :
   *     Volume Profile construit des bins FOOTPRINT de notre accumulateur
   *     (fenetre des 192 bougies M15), split bleu/rouge par delta, POC dore ;
   *   - murs de liquidite du carnet reel (@depth20@500ms, chemins routes) :
   *     barre = ordre passif massif, solidite = anciennete, "SPOOF ?" sur un
   *     mur qui disparait jeune ; cadre or "MUR + NIVEAU" en confluence avec
   *     un POI actif ;
   *   - CVD en bas du chart, par-dessus la zone volume, aire en DEGRADE
   *     (exception charte actee par Meddy 19/07 — ne pas generaliser).
   * Alignement prix : tout passe par gon.priceToY / gon.timeToX — la colonne
   * partage exactement l'echelle de la chart. Module independant : sa propre
   * socket depth ; lecture seule de __gonPoi (accumulator/config/pois). */

  const BUY = "#2f8bff", SELL = "#ff2d5e", GOLD = "#d9b64d";
  const ON_KEY = "gon.confl.on";
  const PANEL_W = 225;
  const WALL_MIN_USD = 1.5e6;          // plancher absolu d'un mur
  const WALL_FACTOR = 6;               // ... et >= 6x la mediane du carnet
  const STALL_MS = 20000;
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

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
  let lastKlinesAt = 0, klinesBusy = false, lastFetchRange = null;
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
    const sym = curSymbol;
    try {
      const [iv] = pickInterval(span);
      const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${iv}` +
        `&startTime=${from * 1000}&endTime=${to * 1000}&limit=1000`);
      if (!r.ok) return;
      const rows = await r.json();
      if (curSymbol !== sym || !Array.isArray(rows) || rows.length < 2) return;
      lastKlinesAt = Date.now(); lastFetchRange = { from, to };
      let lo = Infinity, hi = -Infinity;
      for (const k of rows) { lo = Math.min(lo, +k[3]); hi = Math.max(hi, +k[2]); }
      // bin d'AFFICHAGE : ~90 lignes sur le range visible
      const raw = (hi - lo) / 90;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      binSize = Math.max(mag, Math.round(raw / mag) * mag);
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
      for (const [b, e] of profile) if (e.vol > profMax) { profMax = e.vol; pocBin = b; }
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
    const host = panel.getBoundingClientRect();
    const w = Math.round(host.width), h = Math.round(host.height);
    if (w > 0 && h > 0 && (cvPanel.width !== w || cvPanel.height !== h)) { cvPanel.width = w; cvPanel.height = h; }
    cxPanel.clearRect(0, 0, w, h);
    // le panneau partage l'echelle du chart : y_chart -> y_panel via l'offset
    // vertical entre les deux boites (tops alignes par le flex, mais robuste)
    const chartTop = gon.mount.getBoundingClientRect().top;
    const dy = chartTop - host.top;
    const innerR = w - 12, maxW = w - 70;

    // --- profil
    if (profile.size && profMax > 0 && pocBin != null) {
      // hauteur d'une ligne = distance ecran entre deux bins AU PRIX du POC
      const pPoc = pocBin * binSize;
      const yA = gon.priceToY(pPoc), yB = gon.priceToY(pPoc + binSize);
      const hBar = yA != null && yB != null ? Math.max(1.5, Math.abs(yA - yB) * 0.78) : 3;
      for (const [b, e] of profile) {
        const yC = gon.priceToY(b * binSize + binSize / 2);
        if (yC == null || !isFinite(yC)) continue;
        const y = yC + dy;
        if (y < 30 || y > h - 8) continue;
        const wBar = e.vol / profMax * maxW;
        const wBuy = wBar * Math.max(0, Math.min(1, e.buy / e.vol));
        // FLUO : alpha eleve + glow directionnel par barre (demande Meddy)
        cxPanel.save();
        cxPanel.shadowColor = BUY; cxPanel.shadowBlur = b === pocBin ? 10 : 5;
        cxPanel.fillStyle = rgba(BUY, b === pocBin ? 0.9 : 0.5);
        cxPanel.fillRect(innerR - wBar, y - hBar / 2, wBuy, hBar);
        cxPanel.shadowColor = SELL;
        cxPanel.fillStyle = rgba(SELL, b === pocBin ? 0.9 : 0.5);
        cxPanel.fillRect(innerR - wBar + wBuy, y - hBar / 2, wBar - wBuy, hBar);
        cxPanel.restore();
        if (b === pocBin) {
          const pulse = 0.75 + 0.25 * Math.sin(now * 0.004);
          cxPanel.save(); cxPanel.shadowColor = GOLD; cxPanel.shadowBlur = 8 * pulse;
          cxPanel.strokeStyle = `rgba(255,255,255,${0.8 * pulse})`; cxPanel.lineWidth = 0.7;
          cxPanel.strokeRect(innerR - wBar, y - hBar / 2, wBar, hBar); cxPanel.restore();
          cxPanel.fillStyle = GOLD; cxPanel.font = "600 9px Segoe UI";
          cxPanel.fillText("POC", innerR - wBar - 26, y + 3);
        }
      }
    }

    // --- murs + fantomes spoof
    const pois = (P.pois() || []).filter((p) => p.status === "ACTIVE_UNTOUCHED");
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
    for (const w of walls.values()) {
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

  function drawCvd() {
    const host = gon.mount.getBoundingClientRect();
    const w = Math.round(host.width), h = Math.round(host.height);
    if (w > 0 && h > 0 && (cvCvd.width !== w || cvCvd.height !== h)) { cvCvd.width = w; cvCvd.height = h; }
    cxCvd.clearRect(0, 0, w, h);
    if (cvdPts.length < 2) return;
    // zone volume de G-Bot : scaleMargins top .85 -> le bandeau occupe ~15 %
    const zTop = h * 0.85, zBot = h - 22;
    let cMin = Infinity, cMax = -Infinity;
    const pts = [];
    for (const p of cvdPts) {
      const x = gon.timeToX(p.tSec);
      if (x == null || !isFinite(x) || x < -40 || x > w - 60) continue;
      pts.push({ x, cvd: p.cvd });
      if (p.cvd < cMin) cMin = p.cvd; if (p.cvd > cMax) cMax = p.cvd;
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
    for (let i = 1; i < pts.length; i++) {
      const hue = pts[i].cvd >= pts[i - 1].cvd ? BUY : SELL;
      cxCvd.shadowColor = hue; cxCvd.shadowBlur = 2;
      cxCvd.strokeStyle = rgba(hue, 0.45); cxCvd.lineWidth = 1;
      cxCvd.beginPath(); cxCvd.moveTo(pts[i - 1].x, yC(pts[i - 1].cvd));
      cxCvd.lineTo(pts[i].x, yC(pts[i].cvd)); cxCvd.stroke();
    }
    cxCvd.shadowBlur = 0;
    cxCvd.fillStyle = "rgba(110,106,88,.45)"; cxCvd.font = "8px Segoe UI";
    cxCvd.fillText("CVD 48h", 8, zTop + 11);
    cxCvd.restore();
  }

  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!shown()) return;
    const now = performance.now();
    drawPanel(now);
    drawCvd();
  }

  function applyVisible() {
    panel.style.display = visible ? "block" : "none";
    cvCvd.style.display = visible ? "block" : "none";
    btn.classList.toggle("on", visible);
    if (!visible) { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
    else if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function slowTick() {
    if (gon.symbol && gon.symbol !== curSymbol) {
      curSymbol = gon.symbol;
      walls = new Map(); ghosts = []; profile = new Map(); cvdPts = [];
      lastKlinesAt = 0; lastFetchRange = null;
      if (ws) { ws.onclose = null; try { ws.close(); } catch (_) {} ws = null; }
      connect();
      rebuildFromKlines();
    }
    if (ws && ws.readyState === 1 && lastMsgAt && Date.now() - lastMsgAt > STALL_MS) ws.close();
    if (shown()) rebuildFromKlines();
  }

  /* ---------- construction ---------- */
  function build() {
    gon = window.__gon; P = window.__gonPoi;
    if (!gon || !gon.mount || !P || !P.accumulator) { setTimeout(build, 500); return; }
    curSymbol = gon.symbol;

    const css = document.createElement("style");
    css.textContent = `
      #gonConflPanel { flex:0 0 ${PANEL_W}px; position:relative; margin:0 8px 8px 0; padding-top:8px;
        pointer-events:auto; background:rgba(10,10,8,.85);
        border:1px solid rgba(217,182,77,.14); border-radius:6px;
        font-family:"Segoe UI",system-ui,sans-serif; }
      #gonConflPanel .hd { font-size:9px; letter-spacing:3px; color:#d9b64d; text-align:center;
        padding-bottom:6px; border-bottom:1px solid rgba(217,182,77,.10); }
      #gonConflCv { position:absolute; left:0; right:0; top:26px; bottom:0; width:100%;
        height:calc(100% - 26px); }
      #gonConflCvd { position:absolute; inset:0; pointer-events:none; z-index:6; }
      #gonConflBtn { background:none; border:1px solid #232635; color:#d9b64d;
        font-size:13px; line-height:1; padding:2px 7px; cursor:pointer; opacity:.5; }
      #gonConflBtn:hover { border-color:#d9b64d; }
      #gonConflBtn.on { opacity:1; text-shadow:0 0 8px rgba(217,182,77,.6); }
      @media (max-width: 1100px) { #gonConflPanel { display:none !important; } }
      /* colonne de droite : [profil | liquidations] puis l'ECRAN video
         pleine largeur en dessous des deux panneaux */
      #gonRightCol { display:flex; flex-direction:column; min-height:0; }
      #gonRightRow { display:flex; flex:1 1 auto; min-height:0; }
      /* equilibre de la colonne : deux tours de largeur EGALE, et la video
         en socle pleine largeur, format bandeau cinema (21:9, cover) */
      #gonRightRow > #gonLiqPanel { flex:0 0 225px; }
      #gonRightCol > #gonLiqVideo { margin:0 8px 8px 0; align-self:stretch; width:auto;
        aspect-ratio:21/9; border-radius:6px; overflow:hidden;
        border:1px solid rgba(217,182,77,.14); }
    `;
    document.head.appendChild(css);

    panel = document.createElement("div"); panel.id = "gonConflPanel";
    panel.innerHTML = `<div class="hd">CARNET &nbsp;&amp;&nbsp; PROFIL</div>`;
    cvPanel = document.createElement("canvas"); cvPanel.id = "gonConflCv";
    panel.appendChild(cvPanel); cxPanel = cvPanel.getContext("2d");
    // colonne entre le chart et le panneau FLUX (soeur de flex)
    gon.mount.parentElement.insertBefore(panel, gon.mount.nextSibling);
    // puis restructuration : les deux panneaux cote a cote dans une colonne,
    // l'ecran video (celui du panneau FLUX) descend SOUS les deux.
    (function mountRightColumn() {
      const liq = document.getElementById("gonLiqPanel");
      const vid = document.getElementById("gonLiqVideo");
      if (!liq || !vid) { setTimeout(mountRightColumn, 500); return; }
      const parent = liq.parentElement;
      const col = document.createElement("div"); col.id = "gonRightCol";
      const row = document.createElement("div"); row.id = "gonRightRow";
      parent.insertBefore(col, liq);
      col.appendChild(row);
      row.appendChild(panel); row.appendChild(liq);
      col.appendChild(vid);
    })();

    cvCvd = document.createElement("canvas"); cvCvd.id = "gonConflCvd";
    cxCvd = cvCvd.getContext("2d");
    gon.mount.appendChild(cvCvd);

    btn = document.createElement("button");
    btn.id = "gonConflBtn"; btn.title = "Carnet & profil + CVD"; btn.textContent = "▮︎";
    const host = document.getElementById("gonPoiCtl") || document.getElementById("topbar");
    if (host) host.appendChild(btn);
    try { visible = localStorage.getItem(ON_KEY) !== "0"; } catch (_) {}
    btn.onclick = () => {
      visible = !visible;
      try { localStorage.setItem(ON_KEY, visible ? "1" : "0"); } catch (_) {}
      applyVisible();
    };

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
