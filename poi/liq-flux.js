/* G-ON — FLUX : panneau de liquidations en temps reel (design "FLUX", valide
 * par maquette). Module AUTONOME : aucun contact avec le moteur POI ni le
 * chart G-Bot — un panneau de verre flottant sur le bord droit du chart, une
 * onde d'horizon sous la topbar, un picto topbar pour afficher/masquer.
 *
 * Donnees : WS Binance !forceOrder@arr (toutes liquidations du marche),
 * filtre sur le symbole courant. LIMITE CONNUE : Binance n'emet qu'UNE
 * liquidation par symbole et par seconde (echantillon) — les montants
 * affiches sont des MINORANTS. Fenetre glissante reelle de 15 min.
 * Discipline WS maison : reconnexion backoff (BiquetteStream), watchdog
 * socket muette (3 min — les liqs tous-marches sont sporadiques), aucun
 * traitement quand l'onglet est cache (rAF suspendu par le navigateur).
 * Charte : fluo directionnel, or, glow, AUCUN degrade. */
(function () {
  "use strict";

  const WS_URL = "wss://fstream.binance.com/market/ws/!forceOrder@arr";
  const WINDOW_MS = 15 * 60 * 1000;
  const JOURNAL_MIN_USD = 250000;
  const STALL_MS = 180000;
  const ON_KEY = "gon.liq.on";
  const LONG = "long", SHORT = "short";
  const COLOR = { long: [255, 45, 94], short: [47, 139, 255] };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  // Teinte vers le blanc (coeur lumineux) — melange arithmetique, pas un degrade.
  const tint = (c, f) => [Math.round(c[0] + (255 - c[0]) * f), Math.round(c[1] + (255 - c[1]) * f), Math.round(c[2] + (255 - c[2]) * f)];

  let gon = null, S = null;
  let events = [], orbs = [], pings = [], waves = [];
  let panel, waveCv, waveCx, fluxCv, fluxCx, numEls, domEls, evList, symEl, btn;
  let visible = true, curSymbol = "", rafId = 0;
  // Dimensions CSS (px logiques) du canal et de l'onde : le bitmap est mis a
  // l'echelle DPR (net en retina), le dessin/la logique restent en px CSS.
  let fluxW = 0, fluxH = 0, waveW = 0;
  let isLight = false;   // thème clair (luminance du fond > 0.5) — tons neutres du panneau

  // Luminance relative approx d'un hex #rrggbb (0 sombre → 1 clair).
  function lumHex(hex) {
    const n = parseInt(String(hex || "#060604").slice(1), 16);
    return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
  }
  let ws = null, attempt = 0, lastMsgAt = 0, reconnectTimer = 0, fluxFrame = 0;

  /* ---------- donnees ---------- */
  // Affiche REELLEMENT : le toggle utilisateur ne suffit pas — la media query
  // <860px masque le panneau en CSS (offsetParent null) alors que visible
  // reste true : rAF et visuels tourneraient pour un panneau invisible.
  function panelShown() { return visible && panel && panel.offsetParent !== null; }

  function pushEvent(side, usd, at) {
    events.push({ side, usd, at });
    // Visuels UNIQUEMENT quand le panneau est affiche : masque, rien ne les
    // purge (rAF suspendu) et waves croissait sans borne toute la nuit.
    if (panelShown()) {
      // Rampe log ACCENTUEE : petites liq discretes (~5-8 px), grosses
      // spectaculaires (jusqu'a ~44 px). Pente forte -> hierarchie nette sans
      // seuil discret (choix utilisateur : continu accentue).
      const r = Math.min(44, Math.max(5, (Math.log10(usd) - 4.1) * 10));
      if (orbs.length < 140) {
        const w = fluxW || 130, h = fluxH || 300;
        const x = 12 + Math.random() * Math.max(20, w - 24);
        orbs.push({ side, r, x, y: side === LONG ? -r : h + r, ph: Math.random() * 6.28,
          amp: 2.5 + Math.random() * 3,   // derive propre a chaque orbe (moins mecanique)
          v: (0.8 + Math.random() * 1.3) * (side === LONG ? 1 : -1) });
        // r porte dans le ping -> l'anneau de choc grandit avec la liquidation
        // (petit = discret, gros = onde de choc d'impact).
        pings.push({ side, x, y: side === LONG ? 8 : h - 8, born: performance.now(), r });
      }
      waves.push({ side, x: -60, v: 9 + Math.log10(usd), w: 30 + (Math.log10(usd) - 4) * 34 });
      if (waves.length > 80) waves.splice(0, waves.length - 80);   // borne dure
    }
    if (usd >= JOURNAL_MIN_USD) addJournalRow(side, usd, at);
    const el = numEls[side], c = COLOR[side];
    el.style.textShadow = `0 0 22px ${rgba(c, 0.8)}`;
    el.classList.add("hit");
    setTimeout(() => { el.style.textShadow = `0 0 6px ${rgba(c, 0.25)}`; el.classList.remove("hit"); }, 200);
  }

  function onMessage(raw) {
    let o;
    try { o = JSON.parse(raw).o; } catch (_) { return; }
    if (!o) return;
    const usd = Number(o.z) * Number(o.ap || o.p);
    if (!Number.isFinite(usd) || usd <= 0) return;
    // SELL = des LONGS sont liquides ; BUY = des SHORTS sont liquides
    const side = o.S === "SELL" ? LONG : SHORT;
    if (o.s === curSymbol) { pushEvent(side, usd, Number(o.T) || Date.now()); return; }
    // Autres symboles : petites boules d'AMBIANCE dans le canal uniquement —
    // tamisees, sans ping ni onde, hors compteurs/journal (qui restent la
    // verite du symbole affiche). Le canal vit au rythme du marche entier.
    if (panelShown() && orbs.length < 140) {
      const w = fluxCv.width || 130, h = fluxCv.height || 300;
      orbs.push({ side, dim: true,
        r: Math.min(7, Math.max(3.5, (Math.log10(usd) - 3.3) * 1.7)),
        x: 12 + Math.random() * Math.max(20, w - 24),
        y: side === LONG ? -3 : h + 3, ph: Math.random() * 6.28,
        v: (0.5 + Math.random() * 0.8) * (side === LONG ? 1 : -1) });
    }
  }

  function sums() {
    const cut = Date.now() - WINDOW_MS;
    while (events.length && events[0].at < cut) events.shift();
    const s = { long: 0, short: 0 };
    for (const e of events) s[e.side] += e.usd;
    return s;
  }

  function resetForSymbol(sym) {
    curSymbol = sym;
    events = []; orbs = []; pings = []; waves = [];
    shown.long = 0; shown.short = 0;   // sinon les compteurs affichent des millions fantomes qui decroissent
    evList.textContent = "";
    symEl.textContent = sym;
  }

  /* ---------- socket (discipline maison) ---------- */
  function connect() {
    if (ws) { ws.onclose = null; try { ws.close(); } catch (_) {} }
    const socket = new WebSocket(WS_URL);
    ws = socket;
    socket.onopen = () => { if (ws !== socket) return; attempt = 0; lastMsgAt = Date.now(); };
    socket.onmessage = (ev) => { if (ws !== socket) return; lastMsgAt = Date.now(); onMessage(ev.data); };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (ws !== socket) return;
      const delay = S && S.reconnectDelayMs ? S.reconnectDelayMs(attempt++) : Math.min(30000, 1000 * Math.pow(2, attempt++));
      reconnectTimer = setTimeout(connect, delay);
    };
  }

  /* ---------- rendu ---------- */
  function fluxLoop() {
    if (panelShown()) {
      // resync bitmap sur LES DEUX dimensions (largeur seule = animation
      // etiree quand la hauteur du cadre change) ; jamais sur un cadre 0.
      // Bitmap a l'echelle DPR (net en retina), dessin/logique en px CSS.
      const dpr = window.devicePixelRatio || 1;
      const host = fluxCv.parentElement.getBoundingClientRect();
      const cw = Math.round(host.width), ch = Math.round(host.height);
      if (cw > 0 && ch > 0) {
        fluxW = cw; fluxH = ch;
        const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
        if (fluxCv.width !== bw || fluxCv.height !== bh) { fluxCv.width = bw; fluxCv.height = bh; }
      }
      fluxCx.setTransform(dpr, 0, 0, dpr, 0, 0);   // repere en px CSS
      // remanence phosphore SANS assombrir : fondu vers la transparence
      // (destination-out) — le canal garde le fond du panneau, pas de bloc
      // sombre encadre. Purge dure periodique : l'arrondi 8 bits fait stagner
      // les alphas 1-2/255 (voile fantome permanent sur les trajets frequents).
      if ((fluxFrame++ & 1023) === 0) fluxCx.clearRect(0, 0, fluxW, fluxH);
      fluxCx.globalCompositeOperation = "destination-out";
      fluxCx.fillStyle = "rgba(0,0,0,.18)";
      fluxCx.fillRect(0, 0, fluxW, fluxH);
      fluxCx.globalCompositeOperation = "source-over";
      const now = performance.now();
      for (let i = pings.length - 1; i >= 0; i--) {
        const p = pings[i], age = (now - p.born) / 700;
        if (age >= 1) { pings.splice(i, 1); continue; }
        // Anneau de choc : expansion en ease-out (rapide puis freine) + echo
        // interieur discret. Rayon final et epaisseur croissent avec r.
        const rr = p.r || 6, ease = 1 - (1 - age) * (1 - age);
        const a0 = Math.min(0.95, 0.5 + rr * 0.013) * (1 - age);
        fluxCx.strokeStyle = rgba(COLOR[p.side], a0);
        fluxCx.lineWidth = 1 + rr * 0.05;
        fluxCx.beginPath(); fluxCx.arc(p.x, p.y, 3 + ease * (14 + rr * 2.2), 0, Math.PI * 2); fluxCx.stroke();
        fluxCx.strokeStyle = rgba(COLOR[p.side], a0 * 0.45);
        fluxCx.lineWidth = 0.75;
        fluxCx.beginPath(); fluxCx.arc(p.x, p.y, 2 + ease * (8 + rr * 1.1), 0, Math.PI * 2); fluxCx.stroke();
      }
      for (let i = orbs.length - 1; i >= 0; i--) {
        const o = orbs[i]; o.y += o.v; o.ph += 0.045;
        const x = o.x + Math.sin(o.ph) * (o.amp || 4);
        if ((o.side === LONG && o.y - o.r > fluxH) || (o.side === SHORT && o.y + o.r < 0)) { orbs.splice(i, 1); continue; }
        const c = COLOR[o.side];
        fluxCx.save();
        // Fusion ADDITIVE : les passes s'illuminent au lieu de s'empiler en
        // disques opaques — rendu plasma, chevauchements lumineux, zero bord dur.
        fluxCx.globalCompositeOperation = "lighter";
        if (o.dim) {
          // boule d'ambiance (autre symbole) : petit plasma doux, sans coeur ni
          // queue — subordonnee aux liquidations du symbole courant.
          fluxCx.shadowColor = rgba(c, 0.9); fluxCx.shadowBlur = 8 + o.r;
          fluxCx.fillStyle = rgba(c, 0.30);
          fluxCx.beginPath(); fluxCx.arc(x, o.y, o.r, 0, Math.PI * 2); fluxCx.fill();
          fluxCx.shadowBlur = 4;
          fluxCx.fillStyle = rgba(tint(c, 0.25), 0.45);
          fluxCx.beginPath(); fluxCx.arc(x, o.y, o.r * 0.55, 0, Math.PI * 2); fluxCx.fill();
        } else {
          // QUEUE EFFILEE : segments a largeur et alpha degressifs (vraie comete,
          // fini le gros trait uniforme). Longueur croissante avec r.
          const tailLen = o.v * (16 + o.r * 1.2);
          fluxCx.lineCap = "round";
          for (let s = 4; s >= 0; s--) {
            const f0 = s / 5, f1 = (s + 1) / 5, fade = (1 - f0) * (1 - f0);
            fluxCx.strokeStyle = rgba(c, 0.40 * fade);
            fluxCx.lineWidth = Math.max(0.8, o.r * 0.72 * (1 - f0));
            fluxCx.beginPath();
            fluxCx.moveTo(x, o.y - tailLen * f1); fluxCx.lineTo(x, o.y - tailLen * f0);
            fluxCx.stroke();
          }
          // CORPS en trois passes : halo large tres doux -> disque colore ->
          // coeur teinte blanc + point speculaire. Le tout en additif.
          fluxCx.shadowColor = rgba(c, 1); fluxCx.shadowBlur = 14 + o.r * 1.4;
          fluxCx.fillStyle = rgba(c, 0.34);
          fluxCx.beginPath(); fluxCx.arc(x, o.y, o.r, 0, Math.PI * 2); fluxCx.fill();
          fluxCx.shadowBlur = 8;
          fluxCx.fillStyle = rgba(c, 0.55);
          fluxCx.beginPath(); fluxCx.arc(x, o.y, o.r * 0.72, 0, Math.PI * 2); fluxCx.fill();
          fluxCx.shadowBlur = 5;
          fluxCx.fillStyle = rgba(tint(c, 0.55), 0.85);
          fluxCx.beginPath(); fluxCx.arc(x, o.y, o.r * 0.42, 0, Math.PI * 2); fluxCx.fill();
          fluxCx.shadowBlur = 0; fluxCx.fillStyle = "rgba(255,255,255,.85)";
          fluxCx.beginPath(); fluxCx.arc(x, o.y - o.r * 0.22, Math.max(0.8, o.r * 0.16), 0, Math.PI * 2); fluxCx.fill();
        }
        fluxCx.restore();
      }
      // onde d'horizon : bitmap DPR (5 px CSS de haut), dessin en px CSS
      const wrect = waveCv.parentElement.getBoundingClientRect();
      waveW = Math.round(wrect.width);
      const wbw = Math.round(waveW * dpr), wbh = Math.round(5 * dpr);
      if (waveCv.width !== wbw || waveCv.height !== wbh) { waveCv.width = wbw; waveCv.height = wbh; }
      waveCx.setTransform(dpr, 0, 0, dpr, 0, 0);
      waveCx.clearRect(0, 0, waveW, 5);
      waveCx.strokeStyle = isLight ? "rgba(150,120,40,.28)" : "rgba(217,182,77,.10)";
      waveCx.beginPath(); waveCx.moveTo(0, 2.5); waveCx.lineTo(waveW, 2.5); waveCx.stroke();
      for (let i = waves.length - 1; i >= 0; i--) {
        const p = waves[i]; p.x += p.v;
        if (p.x - p.w > waveW) { waves.splice(i, 1); continue; }
        const c = COLOR[p.side];
        for (let sgi = 0; sgi < 5; sgi++) {
          const a = 0.85 * (1 - sgi / 5), seg = p.w / 5;
          waveCx.strokeStyle = rgba(c, a); waveCx.lineWidth = 2.2;
          waveCx.beginPath(); waveCx.moveTo(p.x - seg * (sgi + 1), 2.5); waveCx.lineTo(p.x - seg * sgi, 2.5); waveCx.stroke();
        }
        waveCx.save(); waveCx.shadowColor = rgba(c, 1); waveCx.shadowBlur = 8;
        waveCx.fillStyle = "#fff"; waveCx.fillRect(p.x - 4, 1, 4, 3); waveCx.restore();
      }
    }
    // Masque (media-query fenetre etroite, offsetParent null) : on STOPPE la
    // boucle rAF au lieu de tourner a 60 fps a vide ; slowTick la relance.
    rafId = panelShown() ? requestAnimationFrame(fluxLoop) : 0;
  }

  function addJournalRow(side, usd, at) {
    const c = side === LONG ? "var(--liqlong, #ff2d5e)" : "var(--liqshort, #2f8bff)";
    const cc = side === LONG ? "#ff2d5e" : "#2f8bff";
    const row = document.createElement("div");
    row.className = "gonLiqEv";
    row.innerHTML = `<i style="background:${cc}; box-shadow:0 0 6px ${cc}"></i>` +
      `<span class="amt" style="color:${cc}">${(usd / 1e6).toFixed(2)}M</span>` +
      `<span class="who">${side === LONG ? "LONGS" : "SHORTS"}</span>` +
      `<span style="flex:1"></span><span class="who">${new Date(at).toISOString().slice(11, 16)}</span>`;
    evList.prepend(row);
    while (evList.children.length > 4) evList.lastChild.remove();
    let a = 1;
    for (const child of evList.children) { child.style.opacity = a; a *= 0.65; }
  }

  /* ---------- tick lent : compteurs, dominance, symbole, watchdog ---------- */
  const shown = { long: 0, short: 0 };
  function slowTick() {
    if (gon.symbol && gon.symbol !== curSymbol) resetForSymbol(gon.symbol);
    const s = sums();
    for (const side of [LONG, SHORT]) {
      shown[side] += (s[side] - shown[side]) * 0.25;
      numEls[side].textContent = (shown[side] / 1e6).toFixed(1);
    }
    const tot = s.long + s.short, pl = tot > 0 ? s.long / tot : 0.5;
    domEls.long.style.width = (pl * 50).toFixed(1) + "%";
    domEls.short.style.width = ((1 - pl) * 50).toFixed(1) + "%";
    if (tot > 50000) {
      const side = pl >= 0.5 ? "LONGS" : "SHORTS";
      domEls.pct.textContent = Math.round(Math.max(pl, 1 - pl) * 100) + "% " + side;
      domEls.pct.style.color = pl >= 0.5 ? "rgba(255,45,94,.8)" : "rgba(47,139,255,.8)";
    } else { domEls.pct.textContent = "—"; domEls.pct.style.color = ""; }
    // watchdog socket muette (les liqs tous-marches arrivent en continu)
    if (ws && ws.readyState === 1 && lastMsgAt && Date.now() - lastMsgAt > STALL_MS) ws.close();
    // relance la boucle rAF si le panneau, masque puis re-affiche (media-query),
    // l'avait arretee (fluxLoop met rafId=0 quand !panelShown).
    if (panelShown() && !rafId) rafId = requestAnimationFrame(fluxLoop);
  }

  /* ---------- construction ---------- */
  function applyVisible() {
    panel.style.display = visible ? "flex" : "none";
    waveCv.style.display = visible ? "block" : "none";
    if (btn) btn.classList.toggle("on", visible);
    // rAF suspendu quand le panneau est masque : la boucle ne tournait que
    // pour tester un booleen 60x/s (batterie). Le WS reste connecte : la
    // fenetre 15 min et le journal restent chauds pour le re-affichage.
    if (!visible) { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
    else if (!rafId) rafId = requestAnimationFrame(fluxLoop);
  }

  function boot() {
    gon = window.__gon; S = window.BiquetteStream;
    if (!gon || !gon.mount) { console.warn("[LIQ] seam absent"); return; }

    const css = document.createElement("style");
    css.textContent = `
      /* Colonne de flex A DROITE de la barre des prix (frere de #chartwrap) :
         le ResizeObserver de G-Bot redimensionne le chart tout seul. */
      /* boite alignee sur le haut du chart ; le rythme interieur d'origine
         est conserve via un padding-top equivalent a l'ancienne marge */
      #gonLiqPanel { flex:0 0 280px; position:relative; margin:0 8px 8px 0; padding-top:8px;
        display:flex; flex-direction:column; pointer-events:auto;
        background:rgba(10,10,8,.85);
        border:1px solid rgba(217,182,77,.14); border-radius:6px;
        font-family:"Segoe UI",system-ui,sans-serif; }
      #gonLiqPanel .notch { position:absolute; width:7px; height:7px;
        border-color:rgba(217,182,77,.30); border-style:solid; border-width:0; }
      #gonLiqPanel .notch.tl { top:-1px; left:-1px; border-top-width:1px; border-left-width:1px; }
      #gonLiqPanel .notch.tr { top:-1px; right:-1px; border-top-width:1px; border-right-width:1px; }
      #gonLiqPanel .notch.bl { bottom:-1px; left:-1px; border-bottom-width:1px; border-left-width:1px; }
      #gonLiqPanel .notch.br { bottom:-1px; right:-1px; border-bottom-width:1px; border-right-width:1px; }
      .gonLiqHead { padding:9px 11px 7px; text-align:center; }
      .gonLiqHead .t { font-size:8px; letter-spacing:3px; color:#d9b64d; }
      .gonLiqHead .sym { font-size:8px; letter-spacing:2px; color:#7d795f; margin-top:3px; }
      .gonLiqRule { display:flex; align-items:center; gap:8px; margin-top:8px; }
      .gonLiqRule::before, .gonLiqRule::after { content:""; flex:1; height:1px; background:rgba(217,182,77,.14); }
      .gonLiqRule i { width:3px; height:3px; background:rgba(217,182,77,.30); transform:rotate(45deg); }
      .gonLiqCnt { text-align:right; padding:0 11px; margin-top:8px; }
      .gonLiqCnt .num { font-weight:100; font-size:36px; line-height:1; color:inherit;
        font-variant-numeric:tabular-nums; display:inline-block; transform-origin:right center;
        transition:text-shadow .25s, transform .12s; }
      .gonLiqCnt .num.hit { transform:scale(1.05); }
      .gonLiqCnt .unit { font-size:13px; font-weight:300; opacity:.7; margin-left:3px; }
      .gonLiqCnt .cap { font-size:7px; letter-spacing:2px; margin-top:2px; }
      #gonLiqDomWrap { padding:8px 11px 10px; }
      #gonLiqDomBar { position:relative; height:3px; background:#14130e; border-radius:1px; }
      #gonLiqDomBar .l { position:absolute; left:0; top:0; bottom:0; background:#ff2d5e;
        box-shadow:0 0 8px rgba(255,45,94,.55); }
      #gonLiqDomBar .s { position:absolute; right:0; top:0; bottom:0; background:#2f8bff;
        box-shadow:0 0 8px rgba(47,139,255,.55); }
      #gonLiqDomBar .n { position:absolute; left:50%; top:-3px; bottom:-3px; width:1px;
        background:rgba(217,182,77,.30); }
      #gonLiqDomCap { display:flex; justify-content:space-between; font-size:7px;
        letter-spacing:1.5px; color:#7d795f; margin-top:5px; }
      #gonLiqChan { flex:1; margin:0 11px; position:relative;
        border-top:1px solid rgba(217,182,77,.14); border-bottom:1px solid rgba(217,182,77,.14); }
      #gonLiqChan canvas { position:absolute; inset:0; }
      #gonLiqJournal { padding:7px 11px 9px; }
      #gonLiqJournal .t { font-size:7px; letter-spacing:2.5px; color:#7d795f; margin-bottom:6px; }
      .gonLiqEv { display:flex; align-items:center; gap:6px; font:9px Consolas,monospace;
        color:#e8ecf2; margin-bottom:4px; white-space:nowrap; }
      .gonLiqEv i { width:3px; height:9px; flex:none; }
      .gonLiqEv .amt { font-weight:700; min-width:38px; }
      .gonLiqEv .who { color:#7d795f; }
      #gonLiqWave { position:absolute; top:0; left:0; right:0; height:5px; z-index:5;
        pointer-events:none; }
      /* video identitaire en pied de panneau (mp4 compresse, versionne) :
         pleine largeur, sans marge — epouse les angles bas du panneau.
         Le panneau vit A COTE du chart (colonne flex) : pointer-events:auto
         est sans danger et rend le survol video/volume fonctionnel. */
      /* ecran au VRAI ratio de la video (640x360 = 16:9) sur toute la
         largeur du panneau : image complete, aucun recadrage */
      #gonLiqVideo { position:relative; margin-top:auto; flex:0 0 auto; aspect-ratio:16/9;
        overflow:hidden; border-radius:0 0 5px 5px; }
      #gonLiqVideo video { display:block; width:100%; height:100%; object-fit:cover; }
      #gonLiqSnd { position:absolute; right:6px; bottom:8px; pointer-events:auto;
        background:rgba(10,10,8,.72); border:1px solid rgba(217,182,77,.3);
        color:#d9b64d; border-radius:3px; font:12px Consolas,monospace;
        padding:2px 7px; cursor:pointer; opacity:.5; }
      #gonLiqSnd:hover { border-color:#d9b64d; }
      #gonLiqSnd.on { opacity:1; text-shadow:0 0 8px rgba(217,182,77,.7); }
      /* curseur invisible au repos — n'apparait qu'au survol de la video */
      #gonLiqVol { position:absolute; right:36px; bottom:11px; width:64px; height:12px;
        pointer-events:auto; cursor:pointer; accent-color:#d9b64d; opacity:0;
        background:transparent; transition:opacity .2s; }
      #gonLiqVideo:hover #gonLiqVol { opacity:.85; }
      /* meme langage que les pictos POI (gp-toggle) : fond nu, or */
      #gonLiqBtn { font-size:14px; line-height:1; opacity:.45; }
      #gonLiqBtn.on { opacity:1; text-shadow:0 0 8px rgba(217,182,77,.6); }
      /* THEME CLAIR : surcharge des seuls TONS NEUTRES (fond, textes) ; les
         teintes directionnelles rouge/bleu et l'or restent identiques. Classe
         .light basculee par l'evenement gon:theme (cf. boot). */
      #gonLiqPanel.light { background:rgba(250,248,242,.92); border-color:rgba(150,120,40,.28); }
      #gonLiqPanel.light .gonLiqEv { color:#26303e; }
      #gonLiqPanel.light .gonLiqEv .who,
      #gonLiqPanel.light .gonLiqHead .sym,
      #gonLiqPanel.light #gonLiqDomCap,
      #gonLiqPanel.light #gonLiqJournal .t { color:#726b4f; }
      #gonLiqPanel.light #gonLiqDomBar { background:#e4e0d3; }
      /* fenetres etroites : le chart prime sur un panneau decoratif rigide */
      @media (max-width: 860px) { #gonLiqPanel, #gonLiqWave { display:none !important; } }
    `;
    document.head.appendChild(css);

    panel = document.createElement("div");
    panel.id = "gonLiqPanel";
    panel.innerHTML = `
      <i class="notch tl"></i><i class="notch tr"></i><i class="notch bl"></i><i class="notch br"></i>
      <div class="gonLiqHead">
        <div class="t">LIQUIDATIONS · 15'</div>
        <div class="sym" id="gonLiqSym"></div>
        <div class="gonLiqRule"><i></i></div>
      </div>
      <div class="gonLiqCnt" style="color:#ff2d5e">
        <span class="num" id="gonLiqNumL">0.0</span><span class="unit">M</span>
        <div class="cap" style="color:rgba(255,45,94,.55)">&#9660; LONGS BR&Ucirc;L&Eacute;S</div>
      </div>
      <div class="gonLiqCnt" style="color:#2f8bff">
        <span class="num" id="gonLiqNumS">0.0</span><span class="unit">M</span>
        <div class="cap" style="color:rgba(47,139,255,.55)">&#9650; SHORTS BR&Ucirc;L&Eacute;S</div>
      </div>
      <div id="gonLiqDomWrap">
        <div id="gonLiqDomBar"><div class="l" style="width:50%"></div><div class="s" style="width:50%"></div><div class="n"></div></div>
        <div id="gonLiqDomCap"><span>DOMINANCE</span><span id="gonLiqPct">&mdash;</span></div>
      </div>
      <div id="gonLiqChan"><canvas></canvas></div>
      <div id="gonLiqJournal"><div class="t">JOURNAL</div><div id="gonLiqEvList"></div></div>
      <div id="gonLiqVideo">
        <video src="laforge.mp4" autoplay muted loop playsinline></video>
        <input type="range" id="gonLiqVol" min="0" max="100" value="70" title="Volume">
        <button id="gonLiqSnd" title="Activer / couper le son">&#9834;</button>
      </div>
    `;
    // Frere de flex apres le chartwrap : hors du chart, a droite de l'axe.
    gon.mount.parentElement.insertBefore(panel, gon.mount.nextSibling);

    waveCv = document.createElement("canvas");
    waveCv.id = "gonLiqWave"; waveCv.height = 5;
    gon.mount.appendChild(waveCv);
    waveCx = waveCv.getContext("2d");

    fluxCv = panel.querySelector("#gonLiqChan canvas");
    fluxCx = fluxCv.getContext("2d");
    numEls = { long: document.getElementById("gonLiqNumL"), short: document.getElementById("gonLiqNumS") };
    domEls = { long: panel.querySelector("#gonLiqDomBar .l"), short: panel.querySelector("#gonLiqDomBar .s"),
      pct: document.getElementById("gonLiqPct") };
    evList = document.getElementById("gonLiqEvList");
    symEl = document.getElementById("gonLiqSym");

    // THEME : bascule la classe .light du panneau (tons neutres uniquement) au
    // rythme de l'evenement gon:theme emis par G-Bot. isLight sert aussi a la
    // ligne d'horizon dessinee en canvas (alpha renforce sur fond clair).
    const applyTheme = () => {
      isLight = lumHex(gon.theme && gon.theme.bg) > 0.5;
      panel.classList.toggle("light", isLight);
    };
    applyTheme();
    window.addEventListener("gon:theme", applyTheme);

    // Pas de bouton de bascule (demande Meddy) : le panneau reste toujours
    // affiche (la media query <860px le masque seule). Purge de l'etat herite.
    visible = true;
    try { localStorage.removeItem(ON_KEY); } catch (_) {}

    // son de la video : bouton mute + curseur de volume (persiste). Chrome
    // exige un geste utilisateur pour l'audio — clic et drag en sont.
    const vid = panel.querySelector("#gonLiqVideo video");
    const snd = panel.querySelector("#gonLiqSnd");
    const vol = panel.querySelector("#gonLiqVol");
    try { vol.value = localStorage.getItem("gon.liq.vol") || "70"; } catch (_) {}
    vid.volume = Number(vol.value) / 100;
    // SON PAR DEFAUT : tentative directe (marche si Chrome autorise le son
    // pour ce site — Parametres du site > Son > Autoriser) ; sinon Chrome
    // bloque l'autoplay sonore, et on l'active au PREMIER geste utilisateur
    // (clic/touche n'importe ou dans l'app).
    const wantSound = () => { vid.muted = false; snd.classList.add("on"); return vid.play(); };
    wantSound().catch(() => {
      vid.muted = true; snd.classList.remove("on"); vid.play().catch(() => {});
      // Les DEUX ecouteurs sont retires au premier geste : un survivant
      // re-demuterait la video plus tard contre la volonte de l'utilisateur
      // (ex : mute explicite via le bouton, puis une touche clavier).
      const arm = () => {
        window.removeEventListener("pointerdown", arm);
        window.removeEventListener("keydown", arm);
        wantSound().catch(() => {});
      };
      window.addEventListener("pointerdown", arm);
      window.addEventListener("keydown", arm);
    });
    snd.onclick = () => {
      vid.muted = !vid.muted;
      snd.classList.toggle("on", !vid.muted);
      if (!vid.muted) vid.play().catch(() => {});
    };
    vol.oninput = () => {
      vid.volume = Number(vol.value) / 100;
      try { localStorage.setItem("gon.liq.vol", vol.value); } catch (_) {}
      if (vid.muted && Number(vol.value) > 0) {   // toucher le volume = vouloir du son
        vid.muted = false; snd.classList.add("on");
        vid.play().catch(() => {});
      }
    };

    resetForSymbol(gon.symbol || "BTCUSDT");
    applyVisible();
    connect();
    setInterval(slowTick, 250);
    // (la boucle rAF est demarree/arretee par applyVisible ci-dessus)

    // Hook de debug/test (remplace les boutons "cascade" de la maquette)
    window.__gonLiq = {
      test: (side, usd) => pushEvent(side === "short" ? SHORT : LONG, usd || 1500000, Date.now()),
      state: () => ({ symbol: curSymbol, events: events.length, socket: ws ? ws.readyState : null,
        lastMsgAgeMs: lastMsgAt ? Date.now() - lastMsgAt : null, visible })
    };
  }

  setTimeout(boot, 0);
})();
