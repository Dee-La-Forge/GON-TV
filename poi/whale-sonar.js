(function () {
  "use strict";

  /* G-ON SONAR — detection de baleines sur le flux aggTrade des 20 symboles.
   * Design valide par maquette (maquette-baleines.html) :
   *   - onde de choc laser au point d'impact d'un BURST (>=3 prints extremes
   *     meme sens en 5 s) sur le symbole affiche ;
   *   - embrasement 30 s du niveau POI touche (⌾ DEFENDU) ;
   *   - sillage vertical qui s'estompe sur la bougie d'impact ;
   *   - radar sonar en bas a gauche : blips du symbole + ambiance all-market ;
   *   - journal 4 lignes, ping sonar optionnel (clic sur le radar).
   * Seuils en PERCENTILE GLISSANT par symbole (P99.9 / P99.99 du notionnel,
   * ~6000 derniers trades) — jamais de seuil fixe en dollars. Frequences
   * mesurees sur dumps reels (2026-07-17) : ~9 prints/h, ~0.35 burst/h/symbole.
   * Module independant : son propre socket combine, aucun couplage moteur POI
   * (lecture seule de window.__gonPoi.pois() pour l'embrasement). */

  const SYMS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT",
    "LINKUSDT","APTUSDT","ARBUSDT","OPUSDT","SUIUSDT","FILUSDT","INJUSDT","ETCUSDT",
    "AAVEUSDT","WLDUSDT","TIAUSDT","1000PEPEUSDT","1000SHIBUSDT"];
  const WS_URL = "wss://fstream.binance.com/market/stream?streams=" +
    SYMS.map((s) => s.toLowerCase() + "@aggTrade").join("/");
  const STALL_MS = 25000;            // flux all-market : 25 s de silence = socket morte
  const BUY = "#2f8bff", SELL = "#ff2d5e", GOLD = "#d9b64d";
  const ON_KEY = "gon.whale.on", SND_KEY = "gon.whale.snd", THR_KEY = "gon.whale.thr";
  const MIN_SAMPLES = 800, MAX_SAMPLES = 6000;
  const BURST_N = 3, BURST_WINDOW_MS = 5000, BURST_COOLDOWN_MS = 30000;
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

  let gon = null;
  let ws = null, attempt = 0, lastMsgAt = 0, reconnectTimer = 0;
  let visible = true, muted = false, curSymbol = "", rafId = 0;
  let cv, cx, radarCv, radarCx, journalEl, btn;
  const waves = [], scars = [], surges = [], blips = [];
  let sweepA = 0, lastDimBlipAt = 0, lastThrSaveAt = 0, lastEchoAt = 0, lastAmbEchoAt = 0;

  /* ---------- statistiques par symbole ---------- */
  const stats = {};
  for (const s of SYMS) stats[s] = { arr: [], thrLo: 0, thrHi: 0, ready: false,
    lastCompute: 0, bigs: [], lastBurst: { buy: 0, sell: 0 } };

  // Seuils persistes (<24 h) : le detecteur est operationnel des le chargement
  // au lieu d'attendre ~20 min d'echantillonnage a froid sur les alts calmes.
  (function loadThr() {
    try {
      const raw = JSON.parse(localStorage.getItem(THR_KEY) || "{}");
      for (const s of SYMS) {
        const t = raw[s];
        if (t && Number.isFinite(t.lo) && Number.isFinite(t.hi) &&
            Date.now() - t.at < 24 * 3600e3) {
          stats[s].thrLo = t.lo; stats[s].thrHi = t.hi; stats[s].ready = true;
        }
      }
    } catch (_) {}
  })();
  function saveThr() {
    const out = {};
    for (const s of SYMS) if (stats[s].ready)
      out[s] = { lo: stats[s].thrLo, hi: stats[s].thrHi, at: Date.now() };
    try { localStorage.setItem(THR_KEY, JSON.stringify(out)); } catch (_) {}
  }
  function computeThr(st, now) {
    st.lastCompute = now;
    if (st.arr.length < MIN_SAMPLES) return;
    const sorted = st.arr.slice().sort((a, b) => a - b);
    st.thrLo = sorted[Math.floor(0.999 * sorted.length)];
    st.thrHi = sorted[Math.floor(0.9999 * sorted.length)];
    st.ready = true;
  }

  /* ---------- detection ---------- */
  function onTrade(sym, price, qty, maker, T) {
    const st = stats[sym];
    if (!st || !(price > 0) || !(qty > 0)) return;
    const n = price * qty, now = Date.now();
    st.arr.push(n);
    if (st.arr.length > MAX_SAMPLES) st.arr = st.arr.slice(-Math.floor(MAX_SAMPLES * 0.75));
    if (now - st.lastCompute > 20000) computeThr(st, now);
    if (!st.ready || n < st.thrLo) return;

    const side = maker ? "sell" : "buy";
    const isCur = sym === curSymbol;
    if (isCur) {
      addBlip(side, n, false);
      journal(side, n, sym, false);
      // MINI-ECHO : print isole >= P99.99 (~1/h) — petit anneau discret sur
      // la bougie, sans sillage, sans embrasement, sans ping. La pleine onde
      // de choc reste reservee aux bursts.
      if (n >= st.thrHi && shown())
        waves.push({ tSec: T / 1000, price, side, born: performance.now(), mini: true });
    } else if (now - lastDimBlipAt > 1200) {
      // meme cadence que le tick sonore doux : 1 point d'ambiance = 1 son
      lastDimBlipAt = now; addBlip(side, n, true);
    }
    st.bigs.push({ t: now, side });
    while (st.bigs.length && now - st.bigs[0].t > BURST_WINDOW_MS) st.bigs.shift();
    const sameSide = st.bigs.filter((b) => b.side === side).length;
    if (sameSide >= BURST_N && now - st.lastBurst[side] > BURST_COOLDOWN_MS) {
      st.lastBurst[side] = now;
      if (isCur) burst(side, price, T, n);
      else addBlip(side, n * 3, true);            // burst distant : blip ambiant appuye
    }
  }

  function burst(side, price, T, usd) {
    const tSec = T / 1000, now = performance.now();
    waves.push({ tSec, price, side, born: now });
    scars.push({ tSec, side, born: now });
    const P = window.__gonPoi;
    if (P && gon) {
      const y = gon.priceToY(price);
      if (y != null) {
        for (const p of (P.pois() || [])) {
          if (p.status !== "ACTIVE_UNTOUCHED") continue;
          const e = p.entry ?? p.entryPrice, ly = e != null ? gon.priceToY(e) : null;
          if (ly != null && Math.abs(ly - y) < 34)
            surges.push({ price: e, hue: p.direction === "long" ? BUY : SELL,
              until: now + 30000 });
        }
      }
    }
    addBlip(side, usd * 4, false, true);   // silent : le burst a son propre ping grave
    journal(side, usd, curSymbol, true);
    ping(side);
  }

  /* ---------- amorcage REST des seuils (demarrage a froid) ---------- */
  // Sans lui, un alt calme mettrait des heures a atteindre MIN_SAMPLES : on
  // seme 1000 aggTrades recents par symbole non pret (cadence 350 ms — le
  // poids IP est partage). Avec ~1000 echantillons le P99.9 est volontairement
  // HAUT (sous-detection conservatrice) et converge avec le flux live ; les
  // seuils sont ensuite persistes 24 h, donc cout premiere session seulement.
  async function seedThresholds() {
    for (const s of SYMS) {
      if (stats[s].ready) continue;
      try {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${s}&limit=1000`);
        if (r.ok) {
          const st = stats[s];
          for (const t of await r.json()) { const n = +t.p * +t.q; if (n > 0) st.arr.push(n); }
          computeThr(st, Date.now());
        }
      } catch (_) {}
      await new Promise((res) => setTimeout(res, 350));
    }
    saveThr();
  }

  /* ---------- socket ---------- */
  function connect() {
    clearTimeout(reconnectTimer);
    const socket = new WebSocket(WS_URL);
    ws = socket;
    socket.onopen = () => { if (ws !== socket) return; attempt = 0; lastMsgAt = Date.now(); };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt++));
      reconnectTimer = setTimeout(connect, delay);
    };
    socket.onmessage = (m) => {
      if (ws !== socket) return;
      lastMsgAt = Date.now();
      let d; try { d = JSON.parse(m.data).data; } catch (_) { return; }
      if (!d || d.e !== "aggTrade") return;
      onTrade(d.s, +d.p, +d.q, d.m === true, +d.T);
    };
  }

  /* ---------- visuels ---------- */
  const shown = () => visible && cv && cv.offsetParent !== null;

  function addBlip(side, usd, dim, silent) {
    if (!shown()) return;
    // orbite 44-58 : hors du logo (42), sous l'anneau externe (60)
    blips.push({ side, dim, born: performance.now(),
      r: dim ? 1.6 : Math.min(6, 2 + Math.log10(Math.max(1, usd / 1e5)) * 2.2),
      ang: Math.random() * Math.PI * 2, dist: 44 + Math.random() * 18 });
    if (blips.length > 90) blips.shift();
  }

  function journal(side, usd, sym, big) {
    if (!journalEl) return;
    const hue = side === "buy" ? BUY : SELL;
    const row = document.createElement("div");
    row.className = "gonWhEv";
    row.innerHTML = `<i style="background:${hue}; box-shadow:0 0 6px ${hue}"></i>` +
      `<span style="color:${hue}; font-weight:600">${big ? "🐋 " : ""}${(usd / 1e6).toFixed(2)}M</span>` +
      `<span>${side === "buy" ? "ACHAT" : "VENTE"}</span>` +
      `<span style="margin-left:auto; color:#6e6a58; font-size:9px">${new Date().toISOString().slice(11, 16)}</span>`;
    journalEl.prepend(row);
    while (journalEl.children.length > 4) journalEl.lastChild.remove();
    let a = 1; for (const c of journalEl.children) { c.style.opacity = a; a *= 0.68; }
  }

  function drawWaves(now, w, plotW) {
    for (let i = waves.length - 1; i >= 0; i--) {
      const wv = waves[i], a = (now - wv.born) / (wv.mini ? 1200 : 1900);
      if (a >= 1) { waves.splice(i, 1); continue; }
      let x = gon.timeToX(wv.tSec); const y = gon.priceToY(wv.price);
      if (y == null || !isFinite(y)) continue;
      if (x == null || !isFinite(x) || x > plotW) x = plotW - 60;
      const r = wv.mini ? 5 + a * a * 58 : 14 + a * a * 230;
      const al = (1 - a) * (wv.mini ? 0.55 : 1), hue = wv.side === "buy" ? BUY : SELL;
      cx.save();
      cx.beginPath(); cx.rect(0, 0, plotW, cv.height); cx.clip();
      cx.shadowColor = hue; cx.shadowBlur = (wv.mini ? 10 : 22) * al;
      cx.strokeStyle = rgba(hue, 0.75 * al); cx.lineWidth = (wv.mini ? 1.2 : 2.2) * al + 0.4;
      cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.stroke();
      cx.shadowBlur = 8 * al;
      cx.strokeStyle = `rgba(255,255,255,${0.85 * al})`; cx.lineWidth = wv.mini ? 0.5 : 0.7;
      cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.stroke();
      if (!wv.mini) {
        cx.shadowBlur = 14; cx.fillStyle = `rgba(255,255,255,${al})`;
        cx.beginPath(); cx.arc(x, y, 2.4, 0, Math.PI * 2); cx.fill();
      }
      cx.restore();
    }
    for (let i = scars.length - 1; i >= 0; i--) {
      const s = scars[i], a = (now - s.born) / 90000;
      if (a >= 1) { scars.splice(i, 1); continue; }
      const x = gon.timeToX(s.tSec);
      if (x == null || !isFinite(x) || x < 0 || x > plotW) continue;
      cx.strokeStyle = rgba(s.side === "buy" ? BUY : SELL, 0.16 * (1 - a));
      cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, cv.height); cx.stroke();
    }
  }

  function drawSurges(now, plotW) {
    for (let i = surges.length - 1; i >= 0; i--) {
      const s = surges[i];
      if (now > s.until) { surges.splice(i, 1); continue; }
      const y = gon.priceToY(s.price);
      if (y == null || !isFinite(y)) continue;
      const k = (s.until - now) / 30000, pulse = 1 + 0.8 * Math.sin(now * 0.012) * k;
      cx.save();
      cx.shadowColor = s.hue; cx.shadowBlur = 16 * k * pulse;
      cx.strokeStyle = rgba(s.hue, 0.5 * k); cx.lineWidth = 1.4 * pulse;
      cx.beginPath(); cx.moveTo(0, y + 0.5); cx.lineTo(plotW, y + 0.5); cx.stroke();
      cx.shadowBlur = 6 * k;
      cx.fillStyle = rgba(s.hue, Math.min(1, 0.4 + 0.6 * k));
      cx.font = "9px Segoe UI";
      // a gauche de la ligne : la droite est occupee par la colonne de chips
      cx.fillText("⌾ DÉFENDU", 70, y - 5);
      cx.restore();
    }
  }

  // 130x130 centre (65,65) — le watermark G-Bot est deplace sous le radar
  // (applyVisible) : anneaux HORS du logo (rayon 42), il est le coeur.
  const RC_X = 72, RC_Y = 72, R_MAX = 66;
  function drawRadar(now) {
    radarCx.setTransform(2, 0, 0, 2, 0, 0);
    radarCx.clearRect(0, 0, 144, 144);
    const cxr = RC_X, cyr = RC_Y;
    radarCx.strokeStyle = "rgba(217,182,77,.34)"; radarCx.lineWidth = 1;
    radarCx.beginPath(); radarCx.arc(cxr, cyr, 43, 0, Math.PI * 2); radarCx.stroke();
    radarCx.strokeStyle = "rgba(217,182,77,.16)";
    for (const rr of [54, R_MAX]) {
      radarCx.beginPath(); radarCx.arc(cxr, cyr, rr, 0, Math.PI * 2); radarCx.stroke();
    }
    // ECHO style radar (prefere par Meddy) : quand le faisceau PASSE sur un
    // contact, le point FLASHE et le bip part au meme instant — flash et son
    // sont le meme evenement, synchro par construction. Contact vif = bip
    // franc, ambiance = tick doux (300 ms mini entre echos).
    const TAU = Math.PI * 2, prevA = sweepA % TAU;
    sweepA += 0.014;
    const curA = sweepA % TAU, nowMs = performance.now();
    for (const b of blips) {
      const a = ((b.ang % TAU) + TAU) % TAU;
      const crossed = prevA <= curA ? (a > prevA && a <= curA) : (a > prevA || a <= curA);
      if (!crossed) continue;
      b.lit = nowMs;
      if (nowMs - lastEchoAt > 300) { lastEchoAt = nowMs; sonarTick(b.dim); }
    }
    for (let s = 0; s < 6; s++) {
      const a = sweepA - s * 0.06;
      radarCx.strokeStyle = `rgba(217,182,77,${0.5 * (1 - s / 6)})`;
      radarCx.lineWidth = s ? 1 : 1.4;
      radarCx.beginPath(); radarCx.moveTo(cxr, cyr);
      radarCx.lineTo(cxr + Math.cos(a) * R_MAX, cyr + Math.sin(a) * R_MAX); radarCx.stroke();
    }
    radarCx.save();
    for (let i = blips.length - 1; i >= 0; i--) {
      const b = blips[i], age = (performance.now() - b.born) / (b.dim ? 4000 : 9000);
      if (age >= 1) { blips.splice(i, 1); continue; }
      const hue = b.side === "buy" ? BUY : SELL;
      // flash d'illumination quand le faisceau vient de passer (echo visuel)
      const flash = b.lit ? Math.max(0, 1 - (performance.now() - b.lit) / 500) : 0;
      const al = Math.min(1, (1 - age) * (b.dim ? 0.35 : 0.95) * (1 + flash));
      const x = cxr + Math.cos(b.ang) * b.dist, y = cyr + Math.sin(b.ang) * b.dist;
      radarCx.shadowColor = hue; radarCx.shadowBlur = (b.dim ? 3 : 9) + 8 * flash;
      radarCx.fillStyle = rgba(hue, al);
      radarCx.beginPath(); radarCx.arc(x, y, b.r, 0, Math.PI * 2); radarCx.fill();
      if (!b.dim && age < 0.25) {
        radarCx.strokeStyle = rgba(hue, (0.25 - age) * 3);
        radarCx.beginPath(); radarCx.arc(x, y, b.r + age * 26, 0, Math.PI * 2); radarCx.stroke();
      }
    }
    radarCx.restore();
    radarCx.fillStyle = muted ? "rgba(110,106,88,.9)" : "rgba(217,182,77,.9)";
    radarCx.font = "9px Segoe UI";
    radarCx.fillText(muted ? "♪ off" : "♪", 4, 140);
  }

  /* ---------- son ---------- */
  let actx = null, armed = false;
  function armAudio() {
    if (armed) return; armed = true;
    try { actx = new AudioContext(); } catch (_) {}
  }
  // echo de naissance d'un contact. soft = blip d'ambiance (tres doux,
  // plus grave). Contexte suspendu : on resume et on SAUTE ce son — un
  // bip en retard est pire qu'un bip absent pour la synchro percue.
  function sonarTick(soft) {
    if (muted || !actx || !shown()) return;
    if (actx.state === "suspended") { actx.resume().catch(() => {}); return; }
    const o = actx.createOscillator(), g = actx.createGain();
    const f0 = soft ? 560 : 920, f1 = soft ? 420 : 640;
    o.type = "sine"; o.frequency.setValueAtTime(f0, actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(f1, actx.currentTime + (soft ? 0.25 : 0.45));
    g.gain.setValueAtTime(soft ? 0.045 : 0.16, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0004, actx.currentTime + (soft ? 0.3 : 0.5));
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.55);
  }

  function ping(side) {
    if (muted || !actx) return;
    if (actx.state === "suspended") { actx.resume().catch(() => {}); }
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = "sine"; o.frequency.value = side === "buy" ? 96 : 74;
    g.gain.setValueAtTime(0.22, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.9);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.95);
  }

  /* ---------- boucle ---------- */
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!shown()) return;
    const host = gon.mount.getBoundingClientRect();
    const w = Math.round(host.width), h = Math.round(host.height);
    if (w > 0 && h > 0 && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
    cx.clearRect(0, 0, cv.width, cv.height);
    const plotW = cv.width - 64;
    const now = performance.now();
    drawSurges(now, plotW);
    drawWaves(now, cv.width, plotW);
    drawRadar(now);
    if (Date.now() - lastThrSaveAt > 60000) { lastThrSaveAt = Date.now(); saveThr(); }
  }

  function applyVisible() {
    cv.style.display = visible ? "block" : "none";
    radarCv.style.display = visible ? "block" : "none";
    journalEl.style.display = visible ? "block" : "none";
    // le logo vient se placer SOUS le radar (centre commun 77,169) et
    // retrouve sa position G-Bot d'origine quand le sonar est masque
    const wm = document.getElementById("watermark");
    if (wm) {
      wm.style.left = visible ? "calc(5% + 30px)" : "";
      wm.style.top = visible ? "111px" : "";
      wm.style.bottom = visible ? "auto" : "";
    }
    btn.classList.toggle("on", visible);
    if (!visible) { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      waves.length = 0; scars.length = 0; surges.length = 0; blips.length = 0; }
    else if (!rafId) rafId = requestAnimationFrame(loop);
  }

  /* ---------- tick lent ---------- */
  function slowTick() {
    if (gon.symbol && gon.symbol !== curSymbol) {
      curSymbol = gon.symbol;
      waves.length = 0; scars.length = 0; surges.length = 0;
      if (journalEl) journalEl.textContent = "";
    }
    if (ws && ws.readyState === 1 && lastMsgAt && Date.now() - lastMsgAt > STALL_MS) ws.close();
  }

  /* ---------- construction ---------- */
  function build() {
    gon = window.__gon;
    if (!gon || !gon.mount) { setTimeout(build, 500); return; }
    curSymbol = gon.symbol;

    const css = document.createElement("style");
    css.textContent = `
      #gonWhaleCv { position:absolute; inset:0; pointer-events:none; z-index:6; }
      /* Radar autonome en HAUT A GAUCHE, sous la legende ATR ; le journal
         forme une colonne cockpit juste en dessous. Le logo reste intact. */
      #gonWhaleRadar { position:absolute; left:5%; top:81px; width:144px; height:144px;
        pointer-events:auto; cursor:pointer; z-index:7; }
      #gonWhaleLog { position:absolute; left:calc(5% + 7px); top:232px; width:200px; z-index:7;
        pointer-events:none; font:11px "Segoe UI", sans-serif; }
      .gonWhEv { display:flex; align-items:center; gap:6px; padding:2px 0; color:#c9c4b4; }
      .gonWhEv i { width:5px; height:5px; border-radius:50%; flex:none; }
      #gonWhaleBtn { background:none; border:1px solid #232635; color:#d9b64d;
        font-size:13px; line-height:1; padding:2px 7px; cursor:pointer; opacity:.5; }
      #gonWhaleBtn:hover { border-color:#d9b64d; }
      #gonWhaleBtn.on { opacity:1; text-shadow:0 0 8px rgba(217,182,77,.6); }
      @media (max-width: 860px) { #gonWhaleRadar, #gonWhaleLog { display:none !important; } }
    `;
    document.head.appendChild(css);

    cv = document.createElement("canvas"); cv.id = "gonWhaleCv";
    cx = cv.getContext("2d");
    radarCv = document.createElement("canvas"); radarCv.id = "gonWhaleRadar";
    radarCv.width = 288; radarCv.height = 288;
    radarCx = radarCv.getContext("2d");
    journalEl = document.createElement("div"); journalEl.id = "gonWhaleLog";
    gon.mount.appendChild(cv); gon.mount.appendChild(radarCv); gon.mount.appendChild(journalEl);

    try { muted = localStorage.getItem(SND_KEY) === "0"; } catch (_) {}
    radarCv.title = "Sonar baleines — clic : son on/off";
    radarCv.onclick = () => {
      muted = !muted;
      try { localStorage.setItem(SND_KEY, muted ? "0" : "1"); } catch (_) {}
    };
    document.addEventListener("pointerdown", armAudio, { once: true });

    btn = document.createElement("button");
    btn.id = "gonWhaleBtn"; btn.title = "Sonar baleines"; btn.textContent = "◎︎";
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
    seedThresholds();
    setInterval(slowTick, 2000);

    window.__gonWhale = {
      state: () => ({ symbol: curSymbol, socket: ws ? ws.readyState : null,
        lastMsgAgeMs: lastMsgAt ? Date.now() - lastMsgAt : null, visible, muted,
        ready: SYMS.filter((s) => stats[s].ready).length,
        samples: Object.fromEntries(SYMS.map((s) => [s, stats[s].arr.length])),
        thr: curSymbol && stats[curSymbol]
          ? { lo: Math.round(stats[curSymbol].thrLo), hi: Math.round(stats[curSymbol].thrHi) } : null }),
      // Sonde de test : __gonWhale.test("buy", 64200) — prix obligatoire
      test: (side, price) => { if (price > 0) burst(side || "buy", price, Date.now(), 2e6); }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else build();
})();
