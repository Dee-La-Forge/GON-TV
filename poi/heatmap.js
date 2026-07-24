(function () {
  "use strict";

  /* G-ON HEATMAP — liquidité du carnet d'ordres DERRIÈRE les bougies.
   * Design validé par maquette live (maquette-heatmap-live.html, données réelles) :
   *   sonde fapi depth 500/côté toutes les 2,5 s (poids 10), symbole affiché,
   *   60 min de mémoire ; USD par palier (pas = portée réelle / 70) ; luminosité
   *   log vs MÉDIANE (q=1 à 48×) ; style retenu BRAISE (extrémités feutrées +
   *   lissage GPU) + 7 styles en option ; dégradé au choix ; slider d'intensité ;
   *   échelle $ ; MURS SUIVIS sous l'échelle ; zone EN AVANCE (carnet actuel
   *   projeté dans la marge live) ; survol = valeur exacte.
   * Perf (revue 3 relecteurs, 2026-07-25) : AUCUNE boucle rAF permanente ; tout
   * ce qui dépend des DONNÉES (mini-image, projection, runs des styles, liste
   * hot, échelle $) est construit UNE fois par sonde (buildImage) ; un repaint
   * (pan/zoom/resize) ne fait que des drawImage + traits sur caches ; zéro
   * shadowBlur ; garde-fou : >8 ms de peinture moyenne → sonde espacée (réarmé
   * sous 4 ms). Heat OFF = aucun timer, aucun listener actif, fond LWC restauré
   * — application strictement identique. Module additif, aucun refactor. */

  const EVERY = 2500, CAP = 1440;
  const K_ON = "gon.heat.on", K_STYLE = "gon.heat.style", K_RAMP = "gon.heat.ramp",
        K_INT = "gon.heat.int", K_SCALE = "gon.heat.scale", K_WALLS = "gon.heat.walls";
  const GOLD = "#d9b64d", GOLD_B = "#f0d478";
  let BULL = "#3ecfd4", BEAR = "#ff2d5e";
  const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
  const fmtUsd = v => v >= 1e6 ? (v/1e6).toFixed(1) + "M$" :
    v >= 1e3 ? (v/1e3).toFixed(0) + "k$" : v.toFixed(0) + "$";

  /* ---------- rampes 256 teintes ---------- */
  function buildRamp(stops) {
    const L = new Uint8ClampedArray(256*4);
    for (let i = 0; i < 256; i++) {
      const q = i/255;
      let a = stops[0], b = stops[stops.length - 1];
      for (let s = 0; s < stops.length - 1; s++)
        if (q >= stops[s][0] && q <= stops[s+1][0]) { a = stops[s]; b = stops[s+1]; break; }
      const t = (q - a[0]) / ((b[0] - a[0]) || 1);
      for (let c = 0; c < 4; c++) L[i*4+c] = Math.round(a[c+1] + (b[c+1] - a[c+1])*t);
    }
    return L;
  }
  /* rampe directionnelle depuis une teinte du THÈME (revue : camps suivait
     une palette figée pendant que le chart en changeait) */
  function dirRamp(hex) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    const mx = (c, t) => Math.round(c + (255 - c)*t);
    return buildRamp([
      [0.00, Math.round(r*.2), Math.round(g*.2), Math.round(b*.2), 0],
      [0.10, Math.round(r*.24), Math.round(g*.24), Math.round(b*.24), 0],
      [0.28, Math.round(r*.43), Math.round(g*.43), Math.round(b*.43), 80],
      [0.55, r, g, b, 160],
      [0.80, mx(r, .55), mx(g, .55), mx(b, .55), 225],
      [1.00, mx(r, .9), mx(g, .9), mx(b, .9), 255]]);
  }
  const LUT_OR = buildRamp([
    [0.00, 26, 20, 8, 0], [0.10, 40, 32, 14, 0], [0.28, 107, 90, 42, 80],
    [0.55, 217, 182, 77, 160], [0.80, 240, 212, 120, 225], [1.00, 255, 248, 224, 255]]);
  const LUT_BRAISE = buildRamp([
    [0.00, 107, 90, 42, 0], [0.16, 107, 90, 42, 0], [0.47, 166, 136, 60, 51],
    [0.82, 217, 182, 77, 140], [1.00, 240, 212, 120, 191]]);
  const LUT_IVOIRE = buildRamp([
    [0.00, 60, 54, 38, 0], [0.16, 60, 54, 38, 0], [0.47, 150, 138, 110, 60],
    [0.82, 225, 215, 190, 150], [1.00, 255, 250, 235, 205]]);
  const LUT_GLACE = dirRamp("#3ecfd4");
  let LUT_CBULL = dirRamp(BULL), LUT_CBEAR = dirRamp(BEAR);
  const RAMPS = { braise: LUT_BRAISE, or: LUT_OR, glace: LUT_GLACE, ivoire: LUT_IVOIRE };
  const STYLES = ["braise", "filaments", "lingot", "sillage", "cicatrice", "soie", "net", "camps"];

  /* ---------- état ---------- */
  let gon = null, cv = null, cx = null, btn = null, panEl = null, tipEl = null;
  const off = document.createElement("canvas"), octx = off.getContext("2d");
  const tmp = document.createElement("canvas"), tctx = tmp.getContext("2d");
  const prj = document.createElement("canvas"), prjx = prj.getContext("2d");
  const scl = document.createElement("canvas"), sclx = scl.getContext("2d");
  let on = false, style = "braise", ramp = "braise", intensity = 1,
      showScale = true, showWalls = true;
  let samples = [], binSize = 0, priceDec = 1, curSymbol = "";
  let wallHist = new Map(), walls = [], fled = [];
  let pollTimer = 0, repaintQueued = 0, inFlight = false;
  let imgDirty = true, imgVersion = 0, tmpVersion = -1, tmpW = 0;
  let P = null;                                 /* caches par-sonde (buildImage) */
  let savedBg = null;
  let paintMsAvg = 0, degraded = false, calmPaints = 0;

  const pref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) {} };
  const perNow = () => degraded ? EVERY*2 : EVERY;

  /* ---------- axes LWC mesurés (revue : jamais codés en dur) ---------- */
  let axW = 64, axH = 28;
  function measureAxes() {
    try { const w = gon.chart.priceScale("right").width(); if (w > 0) axW = w; } catch (_) {}
    try { const h = gon.ts().height(); if (h > 0) axH = h; } catch (_) {}
  }

  /* ---------- sonde ---------- */
  function resetBook() {
    samples = []; binSize = 0; wallHist.clear(); walls = []; fled = [];
    imgDirty = true; P = null;
  }
  async function poll() {
    if (!on || inFlight) return;
    if (document.hidden || (gon && gon.replay)) return;
    if (gon.apiCool && gon.apiCool.until() > Date.now()) return;
    const sym = gon.symbol;
    if (!sym) return;
    if (sym !== curSymbol) { curSymbol = sym; resetBook(); }       /* jamais 2 symboles mêlés */
    inFlight = true;
    try {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${sym}&limit=500`);
      if (r.status === 429 || r.status === 418) {
        if (gon.apiCool) gon.apiCool.hit(r.headers.get("Retry-After"));
        return;
      }
      if (!r.ok) return;
      const d = await r.json();
      if (sym !== gon.symbol || !d.bids?.length || !d.asks?.length) return;
      /* trou de sonde (onglet caché, pause, réseau) : la nappe suppose un pas
         UNIFORME — on repart d'un tampon propre plutôt que de mentir sur l'axe temps */
      if (samples.length && Date.now() - samples[samples.length - 1].t > 2.5*perNow()) resetBook();
      const mid = (+d.bids[0][0] + +d.asks[0][0]) / 2;
      if (!binSize) {
        const span = Math.max(mid*1e-4, +d.asks[d.asks.length-1][0] - +d.bids[d.bids.length-1][0]);
        const raw = span / 70, e = Math.pow(10, Math.floor(Math.log10(raw))), m = raw/e;
        binSize = e * (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10);
        priceDec = binSize < .1 ? 3 : binSize < 1 ? 2 : binSize < 10 ? 1 : 0;
      }
      const bins = new Map();
      for (const [p, q] of d.bids) { const k = Math.floor(+p/binSize); bins.set(k, (bins.get(k)||0) + (+p)*(+q)); }
      for (const [p, q] of d.asks) { const k = Math.floor(+p/binSize); bins.set(k, (bins.get(k)||0) + (+p)*(+q)); }
      samples.push({ t: Date.now(), mid, bins });
      if (samples.length > CAP) samples.shift();
      trackWalls();
      imgDirty = true;
      queueRepaint();
    } catch (_) {}
    finally { inFlight = false; }
  }

  /* ---------- murs suivis ---------- */
  function trackWalls() {
    const s = samples[samples.length - 1];
    let max = 0; for (const v of s.bins.values()) if (v > max) max = v;
    if (!max) return;
    const seen = new Set();
    for (const [k, v] of s.bins) if (v >= .30*max) { wallHist.set(k, (wallHist.get(k)||0) + 1); seen.add(k); }
    for (const [k, c] of [...wallHist]) if (!seen.has(k)) {
      if (c >= 48 && (s.bins.get(k)||0) < .12*max) {
        const at = new Date();
        fled.unshift({ p: (k + .5)*binSize,
          at: `${String(at.getHours()).padStart(2,"0")}:${String(at.getMinutes()).padStart(2,"0")}` });
        fled = fled.slice(0, 3);
      }
      wallHist.delete(k);
    }
    walls = [...s.bins].filter(([k, v]) => v >= .45*max && (wallHist.get(k)||0) >= 4)
      .map(([k, v]) => ({ p: (k + .5)*binSize, usd: v, mins: (wallHist.get(k)||0)*EVERY/60000 }))
      .sort((a, b) => b.usd - a.usd).slice(0, 4);
  }

  /* ---------- ÉTIQUETTES DÉDIÉES par mur, SUR LA CHARTE (demande Meddy :
     pas de tableau — chaque mur porte son label à son prix ; fuites barrées) ---------- */
  function drawWallLabels(Y, plotW) {
    if (!showWalls) return;
    const items = walls.map(w => ({
      y: Y(w.p), fled: false,
      txt: `${w.p.toFixed(priceDec)} · ${fmtUsd(w.usd)} · TENU ${w.mins < 1 ? "<1" : Math.round(w.mins)} min`,
    })).concat(fled.map(f => ({
      y: Y(f.p), fled: true,
      txt: `${f.p.toFixed(priceDec)} · FUITE ${f.at}`,
    }))).filter(it => Number.isFinite(it.y)).sort((a, b) => a.y - b.y);
    if (!items.length) return;
    const lx = plotW - 92;                       /* à gauche de la colonne des chips POI */
    let prevY = -1e9;
    cx.textAlign = "right"; cx.font = "700 9px Consolas, monospace";
    for (const it of items) {
      const y = Math.max(it.y, prevY + 13); prevY = y;
      if (y < 8 || y > paneHeight() - 8) continue;
      const tw = cx.measureText(it.txt).width;
      cx.fillStyle = "rgba(6,6,4,.78)"; cx.fillRect(lx - tw - 6, y - 6.5, tw + 10, 13);
      if (it.fled) {
        cx.fillStyle = "#8a5560"; cx.fillText(it.txt, lx, y + 3.5);
        cx.strokeStyle = "rgba(138,85,96,.8)"; cx.lineWidth = 1;
        cx.beginPath(); cx.moveTo(lx - tw - 2, y); cx.lineTo(lx + 2, y); cx.stroke();
      } else {
        cx.fillStyle = GOLD_B; cx.fillText(it.txt, lx, y + 3.5);
      }
    }
    cx.textAlign = "left";
  }

  /* ---------- construction PAR SONDE : image + projection + runs + hot + échelle ---------- */
  function runsOf(vis, qOf, kLo, kHi, thr, minLen) {
    const out = [];
    for (let k = kLo; k <= kHi; k++) {
      let i0 = -1, qMax = 0, vMax = 0;
      for (let i = 0; i <= vis.length; i++) {
        const v = i < vis.length ? (vis[i].bins.get(k) || 0) : 0;
        const q = v > 0 ? qOf(v) : 0;
        if (q >= thr) {
          if (i0 < 0) { i0 = i; qMax = q; vMax = v; }
          else { if (q > qMax) qMax = q; if (v > vMax) vMax = v; }
        } else if (i0 >= 0) {
          if (i - i0 >= minLen) out.push({ k, i0, i1: i, qMax, vMax, live: i === vis.length });
          i0 = -1;
        }
      }
    }
    return out;
  }
  function buildImage() {
    const vis = samples.slice(-720);            /* toujours une COPIE (revue : réf vive) */
    if (vis.length < 2) return null;
    let kLo = Infinity, kHi = -Infinity;
    for (const s of vis) for (const k of s.bins.keys()) { if (k < kLo) kLo = k; if (k > kHi) kHi = k; }
    if (!isFinite(kLo)) return null;
    kLo -= 2; kHi += 2;
    const rows = kHi - kLo + 1;
    const vals = []; let cnt = 0;
    for (const s of vis) for (const v of s.bins.values()) if ((cnt++ & 7) === 0) vals.push(v);
    vals.sort((a, b) => a - b);
    const med = vals[vals.length >> 1] || 1;
    const qOf = v => { const r = v/med; return r <= 1 ? 0 : Math.min(1, Math.log(r)/Math.log(48)); };
    const dual = style === "camps", braise = style === "braise";

    if (style !== "lingot") {
      off.width = vis.length; off.height = rows;
      const img = octx.createImageData(vis.length, rows), px = img.data;
      const coolFrom = Math.max(1, vis.length - 96);
      const grid = new Float32Array(vis.length*rows);
      for (let i = 0; i < vis.length; i++) {
        const s = vis[i];
        const cool = braise && i < coolFrom ? .55 + .45*(i/coolFrom) : 1;
        for (const [k, v] of s.bins) {
          if (k < kLo || k > kHi) continue;
          grid[(kHi - k)*vis.length + i] = qOf(v)*cool;
        }
      }
      let G = grid;
      if (braise) {                              /* feutrage des extrémités (fini le cubique) */
        const gh = new Float32Array(vis.length*rows);
        for (let r = 0; r < rows; r++) {
          const o = r*vis.length;
          for (let i = 0; i < vis.length; i++)
            gh[o+i] = Math.max(grid[o+i], .55*(i > 0 ? grid[o+i-1] : 0), .55*(i < vis.length-1 ? grid[o+i+1] : 0));
        }
        const gv = new Float32Array(vis.length*rows);
        for (let r = 0; r < rows; r++) {
          const o = r*vis.length, oU = (r-1)*vis.length, oD = (r+1)*vis.length;
          for (let i = 0; i < vis.length; i++)
            gv[o+i] = Math.max(gh[o+i], .45*(r > 0 ? gh[oU+i] : 0), .45*(r < rows-1 ? gh[oD+i] : 0));
        }
        G = gv;
      }
      const LUT_MAP = braise ? RAMPS[ramp] : LUT_OR;
      for (let r = 0; r < rows; r++) {
        const o = r*vis.length, k = kHi - r;
        for (let i = 0; i < vis.length; i++) {
          const q = Math.min(1, G[o+i]*intensity);
          if (q <= 0) continue;
          const L = dual ? ((k + .5)*binSize < vis[i].mid ? LUT_CBULL : LUT_CBEAR) : LUT_MAP;
          const li = Math.round(q*255)*4, p2 = (o+i)*4;
          px[p2] = L[li]; px[p2+1] = L[li+1]; px[p2+2] = L[li+2]; px[p2+3] = L[li+3];
        }
      }
      octx.putImageData(img, 0, 0);
    }

    /* projection EN AVANCE : colonne 1 px feutrée, construite ICI (pas au repaint) */
    const lastS = vis[vis.length - 1];
    const lastQ = new Float32Array(rows);
    for (const [k, v] of lastS.bins) if (k >= kLo && k <= kHi) lastQ[kHi - k] = qOf(v);
    prj.width = 1; prj.height = rows;
    const pimg = prjx.createImageData(1, rows), pd = pimg.data;
    for (let r = 0; r < rows; r++) {
      const q = Math.min(1, Math.max(lastQ[r], .45*(r > 0 ? lastQ[r-1] : 0), .45*(r < rows-1 ? lastQ[r+1] : 0))*intensity);
      if (q <= 0) continue;
      const k = kHi - r;
      const L = braise ? RAMPS[ramp] : dual ? ((k + .5)*binSize < lastS.mid ? LUT_CBULL : LUT_CBEAR) : LUT_OR;
      const li = Math.round(q*255)*4, o = r*4;
      pd[o] = L[li]; pd[o+1] = L[li+1]; pd[o+2] = L[li+2]; pd[o+3] = Math.round(L[li+3]*.55);
    }
    prjx.putImageData(pimg, 0, 0);

    /* runs du style ACTIF (revue : jamais recalculés par frame de pan) */
    let runs = null, filItems = null, hot = null;
    if (style === "filaments") {
      runs = runsOf(vis, qOf, kLo, kHi, .32, 2);
      filItems = [];
      for (const [k, v] of lastS.bins) {
        if (k < kLo || k > kHi) continue;
        const q = qOf(v);
        if (q >= .32) filItems.push({ k, p: (k + .5)*binSize, v, q });
      }
      filItems.sort((a, b) => b.q - a.q); filItems.length = Math.min(filItems.length, 8);
    } else if (style === "lingot") runs = runsOf(vis, qOf, kLo, kHi, .35, 2);
    else if (style === "sillage") {
      const rs = runsOf(vis, qOf, kLo, kHi, .32, 4);
      for (const r0 of rs) r0.camp = (r0.k + .5)*binSize < vis[r0.i0].mid ? BULL : BEAR;
      rs.sort((a, b) => b.qMax - a.qMax);
      const kept = {}; runs = [];
      for (const r0 of rs) { kept[r0.camp] = (kept[r0.camp]||0) + 1; if (kept[r0.camp] <= 10) runs.push(r0); }
    } else if (style === "cicatrice") {
      runs = runsOf(vis, qOf, kLo, kHi, .35, 24);
      for (const r0 of runs) r0.camp = (r0.k + .5)*binSize < vis[r0.i0].mid ? BULL : BEAR;
      runs.sort((a, b) => (b.live - a.live) || (b.i1 - a.i1) || (b.qMax - a.qMax));
      runs.length = Math.min(runs.length, 24);
    } else if (braise) {
      hot = [...lastS.bins].map(([k, v]) => [k, qOf(v)])
        .filter(x => x[1] >= .6 && x[0] >= kLo && x[0] <= kHi)
        .sort((a, b) => b[1] - a[1]).slice(0, 4);
    }

    if (braise && showScale) buildScale(med);

    imgDirty = false; imgVersion++;
    return (P = { kLo, kHi, med, rows, n: vis.length, vis, qOf, runs, filItems, hot,
                  hasImg: style !== "lingot" });
  }

  /* ---------- échelle $ NUE (demande Meddy : plus de boîte) — offscreen, blit au repaint ---------- */
  const SCL_W = 116, SCL_H = 178;
  function buildScale(med) {
    const SC = RAMPS[ramp], sh = 130, sw = 9, sx = 2, sy = 18;
    scl.width = SCL_W; scl.height = SCL_H;
    sclx.clearRect(0, 0, SCL_W, SCL_H);
    sclx.fillStyle = rgba(GOLD, .8); sclx.font = "8px Segoe UI";
    sclx.fillText("LIQUIDITÉ POSÉE", sx, 9);
    for (let p2 = 0; p2 < sh; p2++) {
      const q = 1 - p2/(sh - 1), li = Math.round(q*255)*4;
      sclx.fillStyle = `rgba(${SC[li]},${SC[li+1]},${SC[li+2]},${Math.max(.10, SC[li+3]/255)})`;
      sclx.fillRect(sx, sy + p2, sw, 1);
    }
    sclx.font = "9px Consolas, monospace";
    for (const q of [1, .82, .47, .16]) {
      const y = sy + (1 - q)*(sh - 1);
      const txt = fmtUsd(med*Math.pow(48, Math.min(1.1, q/intensity)));
      const tw = sclx.measureText(txt).width;
      sclx.fillStyle = "rgba(6,6,4,.7)"; sclx.fillRect(sx + sw + 5, y - 5, tw + 4, 11);
      sclx.fillStyle = rgba(GOLD_B, .85); sclx.fillRect(sx + sw + 1, y, 3, 1);
      sclx.fillText(txt, sx + sw + 7, y + 3);
    }
    sclx.fillStyle = "#7d795f"; sclx.font = "8px Segoe UI";
    sclx.fillText(`sous ${fmtUsd(med)} : éteint`, sx, sy + sh + 12);
  }

  /* ---------- repaint : mappage viewport + blits sur caches ---------- */
  function queueRepaint() {
    if (repaintQueued) return;
    repaintQueued = requestAnimationFrame(() => { repaintQueued = 0; repaint(); });
  }
  function paneHeight() {
    /* hauteur du pane PRINCIPAL (le bas du canvas, c'est le pane CVD !) */
    try { const s = gon.chart.paneSize(); if (s && s.height > 0) return s.height; } catch (_) {}
    return cv.height - axH;
  }
  function yMap() {
    /* 2 ancres DANS le pane principal — coordinateToPrice(bas du canvas)
       tombait dans le pane CVD et renvoyait null : rien ne se peignait */
    const a = gon.series.coordinateToPrice(0), b = gon.series.coordinateToPrice(100);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
    const slope = (b - a)/100;
    return p => (p - a)/slope;
  }
  function xMap() {
    const bars = gon.dataNow();
    if (!bars || !bars.length) return null;
    const lastB = bars[bars.length - 1];
    const x0 = gon.timeToX(lastB.time);
    if (x0 == null) return null;
    let barSp = 6;
    try { barSp = gon.ts().options().barSpacing || 6; } catch (_) {}
    const tfSec = gon.tfSec || 60;
    return tMs => x0 + (tMs/1000 - lastB.time)/tfSec*barSp;
  }
  function repaint() {
    if (!on || !cv) return;
    const t0 = performance.now();
    const host = gon.mount.getBoundingClientRect();
    const w = Math.round(host.width), h = Math.round(host.height);
    if (w > 0 && h > 0 && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
    cx.clearRect(0, 0, cv.width, cv.height);
    if (gon.replay) return;
    if (gon.symbol !== curSymbol) { curSymbol = gon.symbol; resetBook(); return; }
    /* switch TF/symbole en cours : ne jamais peindre l'ancien carnet sur la
       nouvelle grille (même garde que poi-render, via dataCtx) */
    if (gon.dataCtx && gon.dataCtx !== gon.symbol + "|" + gon.tf) return;
    if (samples.length < 2) return;
    if (imgDirty || !P) { if (!buildImage()) return; }
    measureAxes();
    const Y = yMap(), X = xMap();
    if (!Y || !X) return;
    const { kLo, kHi, med, rows, n, vis } = P;
    const plotW = cv.width - axW, plotH = paneHeight();
    const colW = Math.max(.5, X(vis[0].t + EVERY*(degraded ? 2 : 1)) - X(vis[0].t));
    const xA = X(vis[0].t) - colW/2, xB = X(vis[n-1].t) + colW/2;
    const yT = Y((kHi + 1)*binSize), yB2 = Y(kLo*binSize);
    if (!Number.isFinite(yT) || !Number.isFinite(yB2)) return;

    cx.save();
    cx.beginPath(); cx.rect(0, 0, plotW, plotH); cx.clip();

    /* nappe AU-DESSUS du chart en transparence douce (retour Meddy : le montage
       sous les bougies ne se voyait pas) — plafond d'alpha .8, bougies lisibles */
    if (P.hasImg) {
      if (style === "net" || style === "sillage") {
        cx.imageSmoothingEnabled = false;
        cx.globalAlpha = style === "sillage" ? .30 : .8;
        cx.drawImage(off, 0, 0, n, rows, xA, yT, xB - xA, yB2 - yT);
        cx.globalAlpha = 1;
      } else if (style === "braise") {
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
        cx.globalAlpha = .8;
        cx.drawImage(off, 0, 0, n, rows, xA, yT, xB - xA, yB2 - yT);
        cx.globalAlpha = 1;
      } else {
        /* colonnes franches en X, fondu en Y — l'intermédiaire n'est reconstruit
           que si l'image a changé (sonde) ou si le zoom a changé sa largeur */
        const wantW = Math.max(1, Math.min(2048, Math.round(xB - xA)));
        if (tmpVersion !== imgVersion || Math.abs(wantW - tmpW) > 1) {
          tmp.width = wantW; tmp.height = rows; tmpW = wantW; tmpVersion = imgVersion;
          tctx.imageSmoothingEnabled = false;
          tctx.drawImage(off, 0, 0, n, rows, 0, 0, wantW, rows);
        }
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
        cx.globalAlpha = style === "filaments" ? .45 : style === "cicatrice" ? .40 : .8;
        cx.drawImage(tmp, 0, 0, tmp.width, rows, xA, yT, xB - xA, yB2 - yT);
        cx.globalAlpha = 1;
      }
    }
    drawOverlays(X, Y, colW, plotW, plotH);
    drawAhead(X, Y, colW, plotW, plotH);
    drawWallLabels(p => Y(p), plotW);
    cx.restore();
    if (style === "braise" && showScale && plotH > SCL_H + 200)
      cx.drawImage(scl, 8, plotH - SCL_H - 150);

    const dt = performance.now() - t0;
    paintMsAvg = paintMsAvg ? paintMsAvg*.8 + dt*.2 : dt;
    if (!degraded && paintMsAvg > 8) { degraded = true; calmPaints = 0; restartPoll(); resetBook(); }
    else if (degraded && paintMsAvg < 4 && ++calmPaints > 40) {
      degraded = false; calmPaints = 0; restartPoll(); resetBook();
    }
  }

  function drawAhead(X, Y, colW, plotW, plotH) {
    const { kLo, kHi, rows, vis } = P;
    const lastS = vis[vis.length - 1];
    if (Date.now() - lastS.t > 2.5*perNow()) return;      /* sonde périmée : pas de fausse avance */
    const x1 = X(lastS.t) + colW/2;
    if (x1 >= plotW - 4) return;
    cx.strokeStyle = "rgba(217,182,77,.22)"; cx.lineWidth = 1;
    cx.setLineDash([2, 3]);
    cx.beginPath(); cx.moveTo(x1 + .5, 0); cx.lineTo(x1 + .5, plotH); cx.stroke();
    cx.setLineDash([]);
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    const yT = Y((kHi + 1)*binSize), yB2 = Y(kLo*binSize);
    cx.drawImage(prj, 0, 0, 1, rows, x1 + 2, yT, plotW - x1 - 2, yB2 - yT);
    cx.fillStyle = "#7d795f"; cx.font = "8px Segoe UI";
    cx.fillText("EN AVANCE · carnet posé", x1 + 6, 12);
  }

  /* ---------- couches styles depuis les CACHES (aucun scan par frame) ---------- */
  function drawOverlays(X, Y, colW, plotW, plotH) {
    const { runs, filItems, hot, vis } = P;
    const yOfK = k => Y((k + .5)*binSize);
    const xOfI = i => X(vis[Math.max(0, Math.min(vis.length - 1, i))].t);

    if (style === "filaments" && runs) {
      const FIL_T = .32;
      for (const r0 of runs) {
        const y = yOfK(r0.k);
        const x0 = xOfI(r0.i0) - colW/2, x1 = xOfI(r0.i1 - 1) + colW/2;
        const lw = 1 + 2.6*(r0.qMax - FIL_T)/(1 - FIL_T);
        if (r0.qMax >= .80) {                    /* halo SANS shadowBlur : sous-trait élargi */
          cx.strokeStyle = rgba(GOLD_B, .22); cx.lineWidth = lw + 3;
          cx.beginPath(); cx.moveTo(x0, y); cx.lineTo(x1, y); cx.stroke();
        }
        cx.strokeStyle = rgba(r0.qMax >= .80 ? "#fff8e0" : GOLD_B, .35 + .6*r0.qMax);
        cx.lineWidth = lw;
        cx.beginPath(); cx.moveTo(x0, y); cx.lineTo(x1, y); cx.stroke();
      }
      if (filItems && filItems.length) {
        const items = filItems.map(it => ({ ...it, y: yOfK(it.k) })).sort((a, b) => a.y - b.y);
        let prevY = -1e9;
        /* étiquettes décalées à GAUCHE de la colonne des chips POI (revue) */
        const lx = plotW - 92;
        cx.textAlign = "right"; cx.font = "700 9px Consolas, monospace";
        for (const it of items) {
          const y = Math.max(it.y, prevY + 12); prevY = y;
          const txt = `${it.p.toFixed(priceDec)} · ${fmtUsd(it.v)}`;
          const tw = cx.measureText(txt).width;
          cx.fillStyle = "rgba(8,7,4,.85)"; cx.fillRect(lx - tw - 6, y - 6.5, tw + 9, 13);
          cx.fillStyle = it.q >= .80 ? "#fff8e0" : GOLD_B;
          cx.fillText(txt, lx, y + 3.5);
        }
        cx.textAlign = "left";
      }
    }

    if (style === "lingot" && runs) {
      for (const r0 of runs) {
        const q = r0.qMax, y = yOfK(r0.k);
        const x0 = xOfI(r0.i0) - colW/2, w2 = xOfI(r0.i1 - 1) + colW/2 - x0;
        const h2 = Math.max(3, Math.min(9, 2 + 6*q));
        cx.fillStyle = rgba(GOLD, .05 + .13*q*q); cx.fillRect(x0, y - h2/2, w2, h2);
        const edgeA = Math.min(.72, .15 + .45*q + .0008*(r0.i1 - r0.i0));
        cx.fillStyle = rgba(GOLD_B, r0.live ? edgeA : edgeA*.45); cx.fillRect(x0, y - h2/2, w2, 1);
        cx.fillStyle = "rgba(107,90,42,.35)"; cx.fillRect(x0, y + h2/2 - 1, w2, 1);
        for (let nn = 1, c = r0.i0 + 120; c < r0.i1 && nn <= 6; nn++, c += 120) {
          cx.fillStyle = rgba(GOLD_B, .7); cx.fillRect(xOfI(c) - 1, y - h2/2 - 3, 2, 2);
        }
      }
    }

    if (style === "sillage" && runs) {
      for (const r0 of runs) {
        const q = r0.qMax, y = yOfK(r0.k);
        const x0 = xOfI(r0.i0) - colW/2, x1 = xOfI(r0.i1 - 1) + colW/2;
        const h2 = Math.min(5, Math.round(1 + 3*q));
        cx.fillStyle = rgba(r0.camp, .10 + .45*q); cx.fillRect(x0, y - h2/2, x1 - x0, h2);
        if (r0.i1 - r0.i0 >= 240) { cx.fillStyle = rgba(r0.camp, Math.min(.9, .28 + .45*q)); cx.fillRect(x0, y, x1 - x0, 1); }
        if (!r0.live) {
          cx.fillStyle = rgba(r0.camp, .9); cx.fillRect(x1 - 1, y - h2, 1, 2*h2);
          cx.strokeStyle = rgba(r0.camp, .12); cx.lineWidth = 1; cx.setLineDash([2, 4]);
          cx.beginPath(); cx.moveTo(x1, y + .5); cx.lineTo(plotW, y + .5); cx.stroke();
          cx.setLineDash([]);
        }
      }
    }

    if (style === "cicatrice" && runs) {
      let labels = 0;
      cx.font = "9px Consolas, monospace";
      for (const r0 of runs) {
        const q = r0.qMax, y = yOfK(r0.k);
        const x0 = xOfI(r0.i0) - colW/2, x1 = xOfI(r0.i1 - 1) + colW/2;
        if (r0.live) {
          cx.fillStyle = rgba(r0.camp, .8);
          cx.beginPath(); cx.moveTo(x0, y - 3); cx.lineTo(x0 + 4, y); cx.lineTo(x0, y + 3); cx.closePath(); cx.fill();
          cx.fillStyle = rgba(r0.camp, .30); cx.fillRect(x0, y, plotW - x0, 1);
        } else {
          const h2 = Math.max(3, Math.min(9, 2 + 6*q));
          cx.strokeStyle = rgba(r0.camp, .35); cx.lineWidth = 1;
          cx.strokeRect(x0, y - h2/2, x1 - x0, h2);
          cx.strokeStyle = "rgba(255,45,94,.6)";
          cx.beginPath(); cx.moveTo(x0, y + h2/2); cx.lineTo(x1, y - h2/2); cx.stroke();
          if (labels < 10) {
            labels++;
            const d = new Date(vis[Math.max(0, r0.i1 - 1)].t);
            cx.fillStyle = rgba(GOLD_B, .6);
            cx.fillText(`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`, x1 + 3, y + 3);
          }
        }
      }
    }

    if (style === "braise" && hot) {
      const lastS = vis[vis.length - 1];
      const x1 = X(lastS.t) + colW/2;
      for (const [k, q] of hot) {
        cx.fillStyle = rgba(GOLD_B, .25);
        cx.beginPath(); cx.arc(Math.min(x1, plotW) - 5, yOfK(k), 4 + 3*q, 0, Math.PI*2); cx.fill();
      }
    }
  }

  /* ---------- survol ---------- */
  function hideTip() { if (tipEl && tipEl.style.display !== "none") tipEl.style.display = "none"; }
  function onMove(e) {
    if (!on || !tipEl || gon.replay || samples.length < 2 || !P) { hideTip(); return; }
    if (e.target && e.target.closest && e.target.closest("[data-tip],[title]")) { hideTip(); return; }
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (mx < 0 || my < 0 || mx > cv.width - axW || my > paneHeight()) { hideTip(); return; }
    const { kLo, kHi, med, vis } = P;
    const Y = yMap(), X = xMap();
    if (!Y || !X) { hideTip(); return; }
    const colW = Math.max(.5, X(vis[0].t + EVERY*(degraded ? 2 : 1)) - X(vis[0].t));
    const lastT = vis[vis.length - 1].t;
    const x1 = X(lastT) + colW/2;
    const fresh = Date.now() - lastT <= 2.5*perNow();
    const inProj = fresh && mx > x1;
    let i;
    if (inProj) i = vis.length - 1;
    else {
      i = Math.round((mx - X(vis[0].t))/colW);
      if (i < 0 || i >= vis.length) { hideTip(); return; }
    }
    const a = gon.series.coordinateToPrice(my);
    if (!Number.isFinite(a)) { hideTip(); return; }
    const k = Math.floor(a/binSize);
    if (k < kLo || k > kHi) { hideTip(); return; }
    const v = vis[i].bins.get(k) || 0;
    if (v <= med) { hideTip(); return; }
    const d = new Date(vis[i].t);
    const hh = `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
    tipEl.innerHTML = `<b>${((k + .5)*binSize).toFixed(priceDec)}</b> — <b>${fmtUsd(v)}</b>` +
      ` <span style="color:#7d795f">posés · ${inProj ? "EN AVANCE (carnet actuel)" : hh} · ${(v/med).toFixed(0)}× la normale</span>`;
    tipEl.style.display = "block";
    const tw = tipEl.offsetWidth, th2 = tipEl.offsetHeight;      /* clampé au viewport (revue) */
    tipEl.style.left = Math.min(window.innerWidth - tw - 6, e.clientX + 14) + "px";
    tipEl.style.top = Math.min(window.innerHeight - th2 - 6, e.clientY + 12) + "px";
  }

  /* ---------- cycle de vie ---------- */
  function restartPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, perNow());
  }
  function applyOn() {
    btn.classList.toggle("on", on);
    cv.style.display = on ? "block" : "none";
    hideTip();
    if (on) {
      resetBook(); curSymbol = gon.symbol;
      paintMsAvg = 0; calmPaints = 0;
      restartPoll(); poll();
      gon.mount.addEventListener("mousemove", onMove, { passive: true });
      gon.mount.addEventListener("mouseleave", hideTip, { passive: true });
    } else {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
      samples = []; P = null;                    /* revue : ne rien retenir de l'ancien carnet */
      gon.mount.removeEventListener("mousemove", onMove);
      gon.mount.removeEventListener("mouseleave", hideTip);
    }
    save(K_ON, on ? "1" : "0");
    queueRepaint();
  }

  /* ---------- réglages (clic droit sur ◱, ancré au bouton) ---------- */
  function buildPanel() {
    panEl = document.createElement("div");
    panEl.id = "gonHeatPan";
    const stBtns = STYLES.map(s =>
      `<button class="ghSt${s === style ? " on" : ""}" data-s="${s}">${s.toUpperCase()}</button>`).join("");
    const rpBtns = Object.keys(RAMPS).map(r =>
      `<button class="ghRp${r === ramp ? " on" : ""}" data-p="${r}">${r.toUpperCase()}</button>`).join("");
    panEl.innerHTML =
      `<div class="ghT">◱ HEATMAP · RÉGLAGES</div>` +
      `<div class="ghL">STYLE</div><div class="ghG">${stBtns}</div>` +
      `<div class="ghL">DÉGRADÉ (braise)</div><div class="ghG">${rpBtns}</div>` +
      `<div class="ghL">INTENSITÉ <span id="ghIntV">${Math.round(intensity*100)}%</span></div>` +
      `<input id="ghInt" type="range" min="40" max="220" value="${Math.round(intensity*100)}">` +
      `<label class="ghC"><input id="ghScale" type="checkbox"${showScale ? " checked" : ""}> Échelle $ (dégradé = valeurs)</label>` +
      `<label class="ghC"><input id="ghWalls" type="checkbox"${showWalls ? " checked" : ""}> Étiquettes murs (sur la charte)</label>`;
    document.body.appendChild(panEl);
    panEl.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.s) { style = b.dataset.s; save(K_STYLE, style);
        panEl.querySelectorAll(".ghSt").forEach(x => x.classList.toggle("on", x === b)); }
      if (b.dataset.p) { ramp = b.dataset.p; save(K_RAMP, ramp);
        panEl.querySelectorAll(".ghRp").forEach(x => x.classList.toggle("on", x === b)); }
      paintMsAvg = 0;
      imgDirty = true; queueRepaint();
    });
    panEl.querySelector("#ghInt").oninput = e => {
      intensity = +e.target.value/100; save(K_INT, e.target.value);
      panEl.querySelector("#ghIntV").textContent = e.target.value + "%";
      imgDirty = true; queueRepaint();
    };
    panEl.querySelector("#ghScale").onchange = e => { showScale = e.target.checked; save(K_SCALE, showScale ? "1" : "0");
      imgDirty = true; queueRepaint(); };
    panEl.querySelector("#ghWalls").onchange = e => { showWalls = e.target.checked; save(K_WALLS, showWalls ? "1" : "0");
      queueRepaint(); };
    document.addEventListener("pointerdown", e => {
      if (panEl.style.display === "block" && !panEl.contains(e.target) && e.target !== btn) panEl.style.display = "none";
    }, true);
  }

  /* ---------- construction ---------- */
  function build() {
    gon = window.__gon;
    if (!gon || !gon.mount) { setTimeout(build, 500); return; }
    const syncTheme = t => {
      if (t && t.bull) BULL = t.bull;
      if (t && t.bear) BEAR = t.bear;
      LUT_CBULL = dirRamp(BULL); LUT_CBEAR = dirRamp(BEAR);
    };
    syncTheme(gon.theme);
    window.addEventListener("gon:theme", e => {
      syncTheme(e.detail);
      if (on) { imgDirty = true; queueRepaint(); }
    });

    style = pref(K_STYLE, "braise"); if (!STYLES.includes(style)) style = "braise";
    ramp = pref(K_RAMP, "braise"); if (!RAMPS[ramp]) ramp = "braise";
    intensity = Math.min(2.2, Math.max(.4, (+pref(K_INT, "100") || 100)/100));
    showScale = pref(K_SCALE, "1") !== "0";
    showWalls = pref(K_WALLS, "1") !== "0";
    on = pref(K_ON, "0") === "1";

    const css = document.createElement("style");
    css.textContent = `
      #gonHeatCv { position:absolute; inset:0; pointer-events:none; }
      #gonHeatTip { position:fixed; display:none; z-index:60; pointer-events:none;
        background:rgba(10,9,6,.96); border:1px solid #6b5a2a; border-radius:5px;
        padding:4px 8px; font:10.5px "Segoe UI", sans-serif; color:#e8dcb0;
        font-variant-numeric:tabular-nums; box-shadow:0 4px 14px rgba(0,0,0,.5); }
      #gonHeatTip b { color:#f0d478; font-family:Consolas, monospace; }
      #gonHeatBtn { background:none; border:1px solid #232635; color:#d9b64d;
        font-size:12px; line-height:1; padding:2px 7px; cursor:pointer; opacity:.5; }
      #gonHeatBtn:hover { border-color:#d9b64d; }
      #gonHeatBtn.on { opacity:1; text-shadow:0 0 8px rgba(217,182,77,.6); }
      #gonHeatPan { position:fixed; display:none; z-index:70; width:240px;
        background:rgba(10,9,6,.97); border:1px solid #6b5a2a; border-radius:7px; padding:10px 12px;
        font:11px "Segoe UI", sans-serif; color:#cbb26a; box-shadow:0 8px 24px rgba(0,0,0,.6); }
      #gonHeatPan .ghT { font-size:9px; letter-spacing:2.5px; color:#d9b64d; margin-bottom:7px; }
      #gonHeatPan .ghL { font-size:8px; letter-spacing:2px; color:#7d795f; margin:7px 0 3px; }
      #gonHeatPan .ghG { display:flex; flex-wrap:wrap; gap:4px; }
      #gonHeatPan button { background:#0f0d08; border:1px solid #26200e; color:#8d8154;
        padding:3px 7px; border-radius:3px; font-size:9px; letter-spacing:.5px; cursor:pointer; }
      #gonHeatPan button.on { color:#060604; background:linear-gradient(180deg,#f0d478,#d9b64d); font-weight:700; }
      #gonHeatPan input[type=range] { width:100%; accent-color:#d9b64d; margin:2px 0 4px; }
      #gonHeatPan .ghC { display:flex; align-items:center; gap:6px; padding:3px 0; font-size:10.5px; cursor:pointer; }
      #gonHeatPan .ghC input { accent-color:#d9b64d; }
    `;
    document.head.appendChild(css);

    cv = document.createElement("canvas"); cv.id = "gonHeatCv";
    cx = cv.getContext("2d");
    /* juste APRÈS le conteneur LWC : au-dessus des bougies (alpha plafonné .8),
       SOUS les overlays POI/sonar qui arrivent plus tard dans le DOM */
    const lwc = gon.mount.querySelector(".tv-lightweight-charts");
    if (lwc && lwc.nextSibling) gon.mount.insertBefore(cv, lwc.nextSibling);
    else if (lwc) gon.mount.appendChild(cv);
    else gon.mount.insertBefore(cv, gon.mount.firstChild ? gon.mount.firstChild.nextSibling : null);

    tipEl = document.createElement("div"); tipEl.id = "gonHeatTip";
    document.body.appendChild(tipEl);

    btn = document.createElement("button");
    btn.id = "gonHeatBtn"; btn.textContent = "◱";
    btn.setAttribute("data-tip", "Heatmap de liquidité du carnet — clic : on/off · clic droit : réglages (style, dégradé, intensité, échelle $, murs suivis). Brume = liquidité posée, blanc-or = mur géant ; zone à droite du pointillé = carnet actuel projeté (ce que le prix va rencontrer).");
    (function mountBtn(tries) {
      const host = document.getElementById("gonPoiCtl");
      if (host) { host.appendChild(btn); return; }
      if (tries > 0) { setTimeout(() => mountBtn(tries - 1), 300); return; }
      const tb = document.getElementById("topbar"); if (tb) tb.appendChild(btn);
    })(20);
    btn.onclick = () => { on = !on; applyOn(); };
    btn.oncontextmenu = e => {
      e.preventDefault();
      if (panEl.style.display === "block") { panEl.style.display = "none"; return; }
      const r = btn.getBoundingClientRect();            /* ancré au bouton (revue) */
      panEl.style.left = Math.max(8, Math.min(window.innerWidth - 252, r.left + r.width/2 - 120)) + "px";
      panEl.style.top = (r.bottom + 8) + "px";
      panEl.style.display = "block";
    };

    buildPanel();

    try { gon.ts().subscribeVisibleLogicalRangeChange(() => { if (on) queueRepaint(); }); } catch (_) {}
    if (window.ResizeObserver) new ResizeObserver(() => { if (on) queueRepaint(); }).observe(gon.mount);
    document.addEventListener("visibilitychange", () => { if (on && !document.hidden) { poll(); queueRepaint(); } });

    applyOn();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
