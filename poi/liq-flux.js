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
  // Triplets rgb pilotés par la palette du chart (gon:theme) : longs brûlés
  // = couleur VENTE (bear), shorts brûlés = couleur ACHAT (bull). Les CSS du
  // panneau consomment les vars --gon-bull/--gon-bear posées par le chart.
  const COLOR = { long: [255, 45, 94], short: [47, 139, 255] };
  const hexT = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const syncPalette = (t) => {
    if (t && t.bear) COLOR.long = hexT(t.bear);
    if (t && t.bull) COLOR.short = hexT(t.bull);
  };
  window.addEventListener("gon:theme", (e) => syncPalette(e.detail));
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  // Teinte vers le blanc (coeur lumineux) — melange arithmetique, pas un degrade.
  const tint = (c, f) => [Math.round(c[0] + (255 - c[0]) * f), Math.round(c[1] + (255 - c[1]) * f), Math.round(c[2] + (255 - c[2]) * f)];

  /* ---------- moteur organique (V2 Meddy — Partie 2) ---------- */
  function noise(x, y, t) {
    return Math.sin(x * 0.013 + t * 0.0017) *
           Math.cos(y * 0.017 - t * 0.0013);
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Champ de turbulence GLOBAL : deux octaves de bruit sinusoidal partagees
  // par tous les orbes + rafale lente commune (gust) — le canal "respire"
  // d'un seul souffle au lieu de N sinusoides independantes.
  function flowField(x, y, t) {
    const gust = 0.6 + 0.4 * Math.sin(t * 0.00037);
    const a = noise(x, y, t);
    const b = Math.sin(y * 0.021 + t * 0.0009) * Math.cos(x * 0.011 + t * 0.0011);
    return { ax: (a * 0.03 + b * 0.015) * gust, ay: b * 0.01 * gust };
  }

  // POOLING : orbes, particules et points de queue sont recycles — zero
  // allocation en regime etabli (le point de queue etait le pire offenseur :
  // 1 objet/orbe/frame). Pools bornes (pression memoire nulle).
  const orbPool = [], particlePool = [], trailPool = [];
  const takePt = (x, y) => { const p = trailPool.pop() || { x: 0, y: 0 }; p.x = x; p.y = y; return p; };
  const freePt = (p) => { if (trailPool.length < 2000) trailPool.push(p); };
  function freeOrb(o) {
    for (let i = 0; i < o.trail.length; i++) freePt(o.trail[i]);
    o.trail.length = 0;
    if (orbPool.length < 50) orbPool.push(o);
  }
  const freeParticle = (p) => { if (particlePool.length < 240) particlePool.push(p); };

  function createOrb(side, usd, dim = false) {
    // PLUS PETIT (demande Meddy) : rampes reduites — max 26 px au lieu de 44,
    // ambiance 2-4 px. Les flous/queues suivent le rayon : gros gain perf.
    const r = dim
      ? Math.min(4, Math.max(2, (Math.log10(usd) - 3.3) * 1.1))
      : Math.min(26, Math.max(3.5, (Math.log10(usd) - 4.1) * 6));

    const w = fluxW || 130;
    const h = fluxH || 300;

    const orb = orbPool.pop() || { trail: [] };
    orb.side = side;
    orb.dim = dim;
    orb.r = r;
    orb.baseR = r;
    orb.x = 12 + Math.random() * Math.max(20, w - 24);
    orb.y = side === LONG ? -r : h + r;
    // METEORE : vitesse portee, trajectoire legerement diagonale et decidee
    // (retour Meddy : "pas des meduses") ; l'ambiance reste plus calme.
    orb.vx = (Math.random() - 0.5) * 1.2;
    orb.vy = (dim ? 1.0 + Math.random() * 0.8 : 2.2 + Math.random() * 1.4) * (side === LONG ? 1 : -1);
    orb.ax = 0;
    orb.ay = 0;
    orb.seed = Math.random() * 1000;
    orb.life = 0;
    orb.fade = 1;
    orb.dying = false;
    orb.sparkAt = 0;
    orb.pulse = Math.random() * 6.28;
    orb.amp = 2 + Math.random() * 4;
    // PERF : les orbes d'AMBIANCE (marche entier) n'ont pas de queue — seuls
    // les meteores du symbole affiche paient le rendu riche. Queue raccourcie
    // (perf 2026-07-24) : ~40 segments/meteore au max devenaient le premier
    // poste de strokes sous cascade.
    orb.maxTrail = dim ? 0 : Math.round(8 + r * 0.7);

    orbs.push(orb);

    if (!dim) {
      // particules satellites pour les grosses liquidations
      if (usd > 5e6) {
        const count = Math.min(8, Math.round(usd / 5e6));   // perf : 14 -> 8, et cap global respecte
        for (let i = 0; i < count; i++) {
          if (particles.length >= 90) break;   // P4 (audit 8) : plafond PROPRE, plus de ~700 en pire cas
          const p = particlePool.pop() || {};
          p.x = orb.x;
          p.y = orb.y;
          p.vx = (Math.random() - 0.5) * 3;
          p.vy = (Math.random() - 0.5) * 3;
          p.life = 1;
          p.side = side;
          particles.push(p);
        }
      }

      pings.push({
        side,
        x: orb.x,
        y: side === LONG ? 8 : h - 8,
        born: performance.now(),
        r
      });
    }
  }

  let gon = null, S = null;
  let events = [], orbs = [], pings = [], waves = [], particles = [];
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

  // M6 (audit 2026-07-24) : le plafond de 50 etait PARTAGE ambiance/meteores —
  // sous cascade tous-marches, l'ambiance (sans throttle de cadence) saturait
  // seule le plafond et supprimait les meteores du symbole AFFICHE au moment
  // le plus interessant. Quotas separes + un meteore evince la plus vieille
  // orbe d'ambiance quand le canal est plein.
  // Resserres (perf 2026-07-24, demande Meddy : les cascades faisaient lagger
  // la navigation du chart) : 28/14 — la cascade reste vivante, le pire cas
  // coute ~2x moins, et l'ambiance est en plus cadencee (1/250 ms, cf.
  // onMessage) comme les blips du sonar.
  const ORB_CAP = 28, DIM_CAP = 14;
  let lastDimSpawnAt = 0;
  function dimCount() { let n = 0; for (const o of orbs) if (o.dim) n++; return n; }
  function evictOldestDim() {
    for (let i = 0; i < orbs.length; i++) {
      if (orbs[i].dim) { const o = orbs[i]; orbs.splice(i, 1); freeOrb(o); return; }
    }
  }

  function pushEvent(side, usd, at) {
    events.push({ side, usd, at });
    // Visuels UNIQUEMENT quand le panneau est affiche : masque, rien ne les
    // purge (rAF suspendu) et waves croissait sans borne toute la nuit.
    if (panelShown()) {
      // Rampe log ACCENTUEE (dans createOrb) : petites liq discretes, grosses
      // spectaculaires jusqu'a ~44 px + particules satellites au-dela de 5M$.
      if (orbs.length >= ORB_CAP) evictOldestDim();   // M6 : le meteore prime sur l'ambiance
      if (orbs.length < ORB_CAP) {
        createOrb(side, usd, false);
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
    if (panelShown() && orbs.length < ORB_CAP && dimCount() < DIM_CAP) {   // M6 : quota propre a l'ambiance
      const nowMs = performance.now();
      if (nowMs - lastDimSpawnAt < 250) return;   // cadence (perf) : la cascade tous-marches ne mitraille plus
      lastDimSpawnAt = nowMs;
      createOrb(side, usd, true);   // dims en px CSS dans createOrb (audit retina conserve)
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
    events = []; orbs = []; pings = []; waves = []; particles = [];
    shown.long = 0; shown.short = 0;   // sinon les compteurs affichent des millions fantomes qui decroissent
    evList.textContent = "";
    symEl.textContent = sym;
    resetOi();   // OI/funding/régime : historiques et hystérésis de l'ANCIEN symbole jetés
    regPending = ""; regPendingN = 0; regShown = ""; regShownAt = 0; lastRegEval = 0;
    if (oiEls.regime) { oiEls.regime.hidden = true; }
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
      if ((fluxFrame++ & 1023) === 0) fluxCx.clearRect(0, 0, fluxW + 1, fluxH + 1);   // +1 : couvre la demi-colonne d'arrondi DPR fractionnaire (liseré fantome)
      fluxCx.globalCompositeOperation = "destination-out";
      fluxCx.fillStyle = "rgba(0,0,0,.18)";
      fluxCx.fillRect(0, 0, fluxW + 1, fluxH + 1);
      fluxCx.globalCompositeOperation = "source-over";
      const now = performance.now();
      for (let i = pings.length - 1; i >= 0; i--) {
        const p = pings[i], age = (now - p.born) / 700;
        if (age >= 1) { pings.splice(i, 1); continue; }
        // Anneau de choc : expansion en ease-out (rapide puis freine) + echo
        // interieur discret. Rayon final et epaisseur croissent avec r.
        const rr = p.r || 6;
        const ease = 1 - Math.pow(1 - age, 3);
        const a0 = Math.min(0.95, 0.55 + rr * 0.015) * (1 - age);

        fluxCx.strokeStyle = rgba(COLOR[p.side], a0);
        fluxCx.lineWidth = 1.2 + rr * 0.06;
        fluxCx.beginPath();
        fluxCx.arc(p.x, p.y, 3 + ease * (16 + rr * 2.8), 0, Math.PI * 2);
        fluxCx.stroke();

        fluxCx.strokeStyle = rgba(COLOR[p.side], a0 * 0.45);
        fluxCx.lineWidth = 0.8;
        fluxCx.beginPath();
        fluxCx.arc(p.x, p.y, 2 + ease * (10 + rr * 1.4), 0, Math.PI * 2);
        fluxCx.stroke();
      }
      /* ---------- interactions : fusion + collisions douces (V2 P2) ------ */
      // O(n^2) borne (<=140 orbes) avec rejet rapide par boite englobante.
      for (let i = 0; i < orbs.length; i++) {
        const a = orbs[i];
        if (a.dying || a.dim) continue;   // PERF : l'ambiance ne collisionne pas
        for (let j = i + 1; j < orbs.length; j++) {
          const b = orbs[j];
          if (b.dying || b.dim) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const rs = (a.r + b.r) * 0.9;
          if (dx > rs || dx < -rs || dy > rs || dy < -rs) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 >= rs * rs || d2 === 0) continue;
          const d = Math.sqrt(d2);
          if (a.side === b.side && !a.dim && !b.dim && d < Math.max(a.r, b.r) * 0.6) {
            // FUSION LUMINEUSE : le gros absorbe le petit — volume conserve
            // (cbrt de la somme des cubes), plafond 44 ; le petit s'eteint
            // en fondu, sa queue persiste un instant (rendu organique).
            const big = a.baseR >= b.baseR ? a : b;
            const small = big === a ? b : a;
            big.baseR = Math.min(44, Math.cbrt(big.baseR ** 3 + small.baseR ** 3));
            big.maxTrail = Math.round(8 + big.baseR * 0.7);
            small.dying = true;
            continue;
          }
          // COLLISION : deviation VISIBLE a l'echelle meteore (0,06 etait
          // calibre pour des meduses lentes — les meteores se traversaient).
          const push = (1 - d / rs) * 0.22;
          const nx = dx / d, ny = dy / d;
          a.ax -= nx * push; a.ay -= ny * push;
          b.ax += nx * push; b.ay += ny * push;
          // ETINCELLES D'IMPACT : choc franc (recouvrement profond + vitesse
          // relative) -> salve de particules au point de contact, avec
          // refroidissement par orbe (sinon une paire encastree crache une
          // tempete a 60 fps).
          const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
          const impact = Math.sqrt(rvx * rvx + rvy * rvy);
          if (impact > 2.2 && d < rs * 0.55 && particles.length < 90 &&
              now - (a.sparkAt || 0) > 350 && now - (b.sparkAt || 0) > 350) {
            a.sparkAt = now; b.sparkAt = now;
            const cx2 = (a.x + b.x) / 2, cy2 = (a.y + b.y) / 2;
            const nSp = Math.min(6, 2 + Math.round(impact));
            for (let k = 0; k < nSp; k++) {
              const q = particlePool.pop() || {};
              q.x = cx2; q.y = cy2;
              q.vx = (Math.random() - 0.5) * (2 + impact * 0.8);
              q.vy = (Math.random() - 0.5) * (2 + impact * 0.8);
              q.life = 0.7;
              q.side = Math.random() < 0.5 ? a.side : b.side;
              particles.push(q);
            }
          }
        }
      }

      /* ---------- orbs organiques (V2 — fluxLoop final) ---------- */
      // Etat canvas pose UNE fois pour orbes + particules (fini le
      // save/restore par orbe : ~140 paires economisees par frame).
      fluxCx.save();
      fluxCx.globalCompositeOperation = "lighter";
      fluxCx.lineCap = "round";
      fluxCx.lineJoin = "round";
      for (let i = orbs.length - 1; i >= 0; i--) {
        const o = orbs[i];

        // apparition progressive / agonie (fusion absorbee, sortie de canal)
        o.life = Math.min(1, o.life + 0.05);
        if (o.dying) o.fade -= 0.05;

        // turbulence : champ GLOBAL tres attenue — un meteore devie a peine,
        // il ne flotte pas (retour Meddy : "meteores, pas meduses")
        const f = flowField(o.x, o.y, now + o.seed * 100);
        o.ax += f.ax * 0.25;
        o.ay += f.ay * 0.25;

        // MURS LATERAUX doux : jamais hors cadre — rappel proportionnel a la
        // penetration de la marge, + garde-fou dur en position.
        const m = 8 + o.r * 0.5;
        if (o.x < m) o.vx += (m - o.x) * 0.02;
        else if (o.x > fluxW - m) o.vx -= (o.x - (fluxW - m)) * 0.02;

        // inertie : lateral amorti, vertical PORTE (legere acceleration de
        // chute, vitesse bornee) — trajectoire decidee, queue etiree derriere
        o.vy += 0.012 * (o.side === LONG ? 1 : -1);
        o.vx += o.ax;
        o.vy += o.ay;
        o.vx *= 0.96;
        o.vy = clamp(o.vy, -4.5, 4.5);
        o.x += o.vx;
        o.y += o.vy;
        o.x = clamp(o.x, 2, Math.max(4, fluxW - 2));
        o.ax = 0;
        o.ay = 0;

        // pulsation quasi eteinte (un meteore ne palpite pas) ; lissage du
        // rayon vers baseR — la fusion gonfle en douceur
        o.r += (o.baseR - o.r) * 0.15;
        const pulse =
          1 +
          Math.sin(now * 0.003 + o.seed) * 0.03 +
          Math.sin(now * 0.007 + o.seed * 3) * 0.015;
        const radius = o.r * pulse;

        // queue physique (points recycles par le pool)
        o.trail.unshift(takePt(o.x, o.y));
        if (o.trail.length > o.maxTrail) freePt(o.trail.pop());

        // disparition progressive en sortie de canal
        if (
          (o.side === LONG && o.y - radius > fluxH - 20) ||
          (o.side === SHORT && o.y + radius < 20)
        ) {
          o.fade -= 0.04;
        }

        if (o.fade <= 0) {
          orbs.splice(i, 1);
          freeOrb(o);
          continue;
        }

        const c = COLOR[o.side];
        const alpha = o.life * o.fade;

        /* PERF 2026-07-24 (demande Meddy : cascades = lag de navigation) :
           chaque orbe payait 3-4 passes shadowBlur (rasterisation CPU) a
           60 fps. Desormais : AMBIANCE 100 % a plat (a 2-4 px le flou est
           invisible), METEORE = UNE seule passe floutee (le corps) — le halo
           externe devient un disque alpha sans ombre, visuellement equivalent
           en composition "lighter". Sous charge (>18 orbes), queues un
           segment sur deux et flou reduit. */
        if (o.dim) {
          fluxCx.shadowBlur = 0;
          fluxCx.fillStyle = rgba(c, alpha * 0.10);
          fluxCx.beginPath();
          fluxCx.arc(o.x, o.y, radius * 1.6, 0, Math.PI * 2);
          fluxCx.fill();
          fluxCx.fillStyle = rgba(c, alpha * 0.38);
          fluxCx.beginPath();
          fluxCx.arc(o.x, o.y, radius, 0, Math.PI * 2);
          fluxCx.fill();
          continue;
        }

        const heavy = orbs.length > 18;

        /* ----- queue de comete (degradee sous charge) ----- */
        const step = heavy ? 2 : 1;
        for (let t = o.trail.length - 1; t > 0; t -= step) {
          const p1 = o.trail[t];
          const p2 = o.trail[Math.max(0, t - step)];
          const k = 1 - t / o.trail.length;
          const a = alpha * k * k * 0.45;
          fluxCx.strokeStyle = rgba(c, a);
          fluxCx.lineWidth = Math.max(0.5, radius * k * 0.7);
          fluxCx.beginPath();
          fluxCx.moveTo(p1.x, p1.y);
          fluxCx.lineTo(p2.x, p2.y);
          fluxCx.stroke();
        }

        /* ----- halo externe A PLAT (l'ex-blur 2.2r etait le poste n.1) ----- */
        fluxCx.shadowBlur = 0;
        fluxCx.fillStyle = rgba(c, alpha * 0.12);
        fluxCx.beginPath();
        fluxCx.arc(o.x, o.y, radius * 1.8, 0, Math.PI * 2);
        fluxCx.fill();

        /* ----- corps : SEULE passe floutee ----- */
        fluxCx.shadowColor = rgba(c, 1);
        fluxCx.shadowBlur = radius * (heavy ? 0.6 : 1.1);
        fluxCx.fillStyle = rgba(c, alpha * 0.6);
        fluxCx.beginPath();
        fluxCx.arc(o.x, o.y, radius, 0, Math.PI * 2);
        fluxCx.fill();

        /* ----- coeur (sans ombre) ----- */
        fluxCx.shadowBlur = 0;
        fluxCx.fillStyle = rgba(tint(c, 0.55), alpha * 0.9);
        fluxCx.beginPath();
        fluxCx.arc(o.x, o.y, radius * 0.45, 0, Math.PI * 2);
        fluxCx.fill();

        /* ----- reflet ----- */
        fluxCx.fillStyle = `rgba(255,255,255,${0.75 * alpha})`;
        fluxCx.beginPath();
        fluxCx.arc(
          o.x - radius * 0.18,
          o.y - radius * 0.18,
          Math.max(1, radius * 0.14),
          0,
          Math.PI * 2
        );
        fluxCx.fill();
      }

      /* ---------- particules satellites (meme etat canvas) ---------- */
      fluxCx.shadowBlur = 0;   // perf : le blur par particule (jusqu'a 90/frame) ne se voit pas a cette taille
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];

        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.life -= 0.03;

        if (p.life <= 0) {
          particles.splice(i, 1);
          freeParticle(p);
          continue;
        }

        const c = COLOR[p.side];
        fluxCx.fillStyle = rgba(c, p.life * 0.6);
        fluxCx.beginPath();
        fluxCx.arc(p.x, p.y, 1.8 + p.life * 2, 0, Math.PI * 2);
        fluxCx.fill();
      }
      fluxCx.restore();

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
    const cc = rgba(COLOR[side], 1);
    const row = document.createElement("div");
    row.className = "gonLiqEv";
    row.innerHTML = `<i style="background:${cc}; box-shadow:0 0 6px ${cc}"></i>` +
      `<span class="amt" style="color:${cc}">${(usd / 1e6).toFixed(2)}M</span>` +
      `<span class="who">${side === LONG ? "LONGS" : "SHORTS"}</span>` +
      `<span style="flex:1"></span><span class="who">${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>`;   // heure LOCALE (l'axe du chart l'est aussi)
    evList.prepend(row);
    while (evList.children.length > 4) evList.lastChild.remove();
    let a = 1;
    for (const child of evList.children) { child.style.opacity = a; a *= 0.65; }
  }

  /* ---------- OI / funding / régime (proposition C, validée 2026-07-24) ----
     Sondes légères : openInterest (poids 1) toutes les 10 s, premiumIndex
     (poids 1 : mark + funding + prochain règlement) toutes les 30 s — via le
     budget PARTAGÉ (gon.apiCool). Historiques 15 min en ring ; « — » tant que
     la fenêtre n'est pas remplie. Régime = prix 15' x OI 15' x dominance :
     SQUEEZE (positions forcées, fragile) vs AFFLUX (positionnement, construit). */
  let oiHist = [], markHist = [], fundRate = null, fundNext = 0;
  let lastOiPoll = 0, lastPremPoll = 0;
  const oiEls = {};
  function resetOi() { oiHist = []; markHist = []; fundRate = null; fundNext = 0; lastOiPoll = 0; lastPremPoll = 0; }
  function histDelta(hist) {   // Δ% vs l'échantillon d'il y a >= 15 min (null si fenêtre incomplète)
    const cut = Date.now() - 15 * 60e3;
    let ref = null;
    for (const h of hist) { if (h.t <= cut) ref = h; else break; }
    if (!ref || !(ref.v > 0)) return null;
    return (hist[hist.length - 1].v - ref.v) / ref.v * 100;
  }
  function pollOi() {
    const n = Date.now();
    if (gon && gon.apiCool && n < gon.apiCool.until()) return;   // budget partagé : on s'efface
    const sym = curSymbol;
    if (!sym) return;
    if (n - lastOiPoll >= 10000) {
      lastOiPoll = n;
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`, { signal: AbortSignal.timeout(6000) })
        .then((r) => { if (r.status === 429 || r.status === 418) { gon?.apiCool?.hit(r.headers.get("retry-after")); return null; } return r.ok ? r.json() : null; })
        .then((j) => {
          if (!j || sym !== curSymbol) return;
          const v = Number(j.openInterest);
          if (v > 0) { oiHist.push({ t: Date.now(), v }); if (oiHist.length > 120) oiHist.shift(); }
        }).catch(() => {});
    }
    if (n - lastPremPoll >= 30000) {
      lastPremPoll = n;
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`, { signal: AbortSignal.timeout(6000) })
        .then((r) => { if (r.status === 429 || r.status === 418) { gon?.apiCool?.hit(r.headers.get("retry-after")); return null; } return r.ok ? r.json() : null; })
        .then((j) => {
          if (!j || sym !== curSymbol) return;
          const mp = Number(j.markPrice);
          if (mp > 0) { markHist.push({ t: Date.now(), v: mp }); if (markHist.length > 60) markHist.shift(); }
          fundRate = Number(j.lastFundingRate);
          fundNext = Number(j.nextFundingTime) || 0;
        }).catch(() => {});
    }
  }
  // Régime avec HYSTÉRÉSIS (spec design) : affiché après 2 évaluations
  // concordantes, tenu au moins 60 s — jamais de clignotement.
  let regPending = "", regPendingN = 0, regShown = "", regShownAt = 0, lastRegEval = 0;
  function renderOi(sums15) {
    if (!oiEls.val) return;
    const dOi = histDelta(oiHist), dPx = histDelta(markHist);
    oiEls.val.textContent = dOi == null ? "—" : (dOi >= 0 ? "+" : "") + dOi.toFixed(1) + " % " + (dOi >= 0 ? "▲" : "▼");
    oiEls.val.className = "v " + (dOi == null ? "" : dOi >= 0 ? "up" : "dn");
    oiEls.fund.textContent = fundRate == null || !Number.isFinite(fundRate) ? "—"
      : (fundRate >= 0 ? "+" : "") + (fundRate * 100).toFixed(4) + " %";
    if (fundNext > Date.now()) {
      const s = Math.floor((fundNext - Date.now()) / 1000);
      oiEls.cd.textContent = s >= 3600 ? Math.floor(s / 3600) + "h" + String(Math.floor(s % 3600 / 60)).padStart(2, "0")
        : String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
    } else oiEls.cd.textContent = "--:--";
    // badge ABSENT tant que la fenêtre 15' n'est pas calculable (jamais un faux NEUTRE)
    if (dPx == null || dOi == null) { oiEls.regime.hidden = true; regPending = ""; regPendingN = 0; return; }
    oiEls.regime.hidden = false;
    // seuils spec : prix ±0.25 %, OI ±0.8 %, dominance liqs >= 60 % sur >= 100 k$
    const tot = sums15.long + sums15.short;
    const domShorts = tot >= 100000 && sums15.short / tot >= 0.6;
    const domLongs = tot >= 100000 && sums15.long / tot >= 0.6;
    let want = "NEUTRE", cls = "";
    if (dPx >= 0.25 && dOi <= -0.8 && domShorts) { want = "SQUEEZE SHORTS"; cls = "sqS"; }
    else if (dPx <= -0.25 && dOi <= -0.8 && domLongs) { want = "SQUEEZE LONGS"; cls = "sqL"; }
    else if (dOi >= 0.8 && Math.abs(dPx) >= 0.25) { want = "TENDANCE " + (dPx > 0 ? "▲" : "▼"); cls = "trend"; }
    if (Date.now() - lastRegEval < 30000) return;   // cadence d'évaluation 30 s (2 concordantes = 60 s, spec)
    lastRegEval = Date.now();
    if (want === regPending) regPendingN += 1; else { regPending = want; regPendingN = 1; }
    const held = Date.now() - regShownAt < 60000;
    if (regPendingN >= 2 && want !== regShown && !held) {
      regShown = want; regShownAt = Date.now();
      oiEls.regime.textContent = want;
      oiEls.regime.className = cls;
    }
  }

  /* ---------- tick lent : compteurs, dominance, symbole, watchdog ---------- */
  const shown = { long: 0, short: 0 };
  function slowTick() {
    if (gon.symbol && gon.symbol !== curSymbol) resetForSymbol(gon.symbol);
    const s = sums();
    pollOi(); renderOi(s);   // bloc OI/funding/régime (proposition C)
    for (const side of [LONG, SHORT]) {
      shown[side] += (s[side] - shown[side]) * 0.25;
      numEls[side].textContent = (shown[side] / 1e6).toFixed(1);
    }
    const tot = s.long + s.short, pl = tot > 0 ? s.long / tot : 0.5;
    // balance : seul l'EXCEDENT net s'affiche depuis le centre (50/50 = zero,
    // 100 % un camp = barre pleine du centre jusqu'a son bord)
    const net = pl - 0.5;
    domEls.long.style.width = (net > 0 ? net * 100 : 0).toFixed(1) + "%";
    domEls.short.style.width = (net < 0 ? -net * 100 : 0).toFixed(1) + "%";
    if (tot > 50000) {
      const side = pl >= 0.5 ? "LONGS" : "SHORTS";
      domEls.pct.textContent = Math.round(Math.max(pl, 1 - pl) * 100) + "% " + side;
      domEls.pct.style.color = rgba(COLOR[pl >= 0.5 ? "long" : "short"], 0.8);
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
      /* --- Bloc OI / funding / régime (proposition C, spec design 2026-07-24) :
         LIGNES NUES au langage du panneau (hairline + espacement, jamais de
         boîte), couleurs 100 % système bull/bear/or, NEUTRE quasi invisible. */
      #gonOiWrap { padding:7px 11px 9px; border-top:1px solid rgba(217,182,77,.14); }
      #gonOiWrap .oiRow { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
      #gonOiWrap .oiRow .k { font-size:7px; letter-spacing:2px; color:#7d795f; }
      #gonOiWrap .oiRow .v { font:600 11px Consolas, monospace; font-variant-numeric:tabular-nums; color:#cbb26a; }
      #gonOiWrap .oiRow .v.up { color:var(--gon-bull,#2f8bff); }
      #gonOiWrap .oiRow .v.dn { color:var(--gon-bear,#ff2d5e); }
      #gonOiWrap .oiRow .v.fund { color:#f0d478; }
      #gonRegime { margin-top:6px; height:16px; line-height:16px; text-align:center; font-size:9px;
        font-weight:700; letter-spacing:2px; border-radius:3px; transition:background .4s, color .4s, box-shadow .4s;
        color:#7d795f; background:transparent; border:1px solid rgba(217,182,77,.14); }
      #gonRegime.sqS { color:#060604; border-color:transparent; background:var(--gon-bull,#2f8bff);
        box-shadow:0 0 12px rgba(var(--gon-bull-rgb,47,139,255),.45); }
      #gonRegime.sqL { color:#060604; border-color:transparent; background:var(--gon-bear,#ff2d5e);
        box-shadow:0 0 12px rgba(var(--gon-bear-rgb,255,45,94),.45); }
      #gonRegime.trend { color:#060604; border-color:transparent; background:#d9b64d;
        box-shadow:0 0 10px rgba(217,182,77,.4); }
      /* Balance : zero AU CENTRE, chaque camp s'etend depuis le centre vers
         SON bord, proportionnel a l'EXCEDENT net (50/50 = barres vides).
         Le RAIL reste lisible meme a l'equilibre : directions teintees en
         fantome (rouge a gauche, bleu a droite) + pivot central dore. */
      #gonLiqDomBar { position:relative; height:4px; border-radius:2px;
        background:linear-gradient(90deg, rgba(var(--gon-bear-rgb,255,45,94),.22), rgba(20,19,14,.9) 42%,
          rgba(20,19,14,.9) 58%, rgba(var(--gon-bull-rgb,47,139,255),.22)); }
      #gonLiqDomBar .l { position:absolute; right:50%; top:0; bottom:0; background:var(--gon-bear,#ff2d5e);
        border-radius:1px 0 0 1px; box-shadow:0 0 8px rgba(var(--gon-bear-rgb,255,45,94),.55);
        transition:width .4s ease; }
      #gonLiqDomBar .s { position:absolute; left:50%; top:0; bottom:0; background:var(--gon-bull,#2f8bff);
        border-radius:0 1px 1px 0; box-shadow:0 0 8px rgba(var(--gon-bull-rgb,47,139,255),.55);
        transition:width .4s ease; }
      #gonLiqDomBar .n { position:absolute; left:50%; top:-4px; bottom:-4px; width:2px;
        margin-left:-1px; border-radius:1px; background:rgba(217,182,77,.75);
        box-shadow:0 0 6px rgba(217,182,77,.5); }
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
      /* ENCART VIDEO RETIRE (demande Meddy 2026-07-23) : les deux panneaux
         descendent jusqu'en bas de page. Le bloc DOM reste (le cablage vol/
         son/cinema s'y accroche sans risque) mais il est masque et la video
         est dechargee au boot — zero bande passante, zero decodage. */
      #gonLiqVideo { display:none !important; }
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
      #gonLiqPanel.light #gonLiqDomBar { background:linear-gradient(90deg,
        rgba(var(--gon-bear-rgb,255,45,94),.25), #e4e0d3 42%, #e4e0d3 58%,
        rgba(var(--gon-bull-rgb,47,139,255),.25)); }
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
      <div class="gonLiqCnt" style="color:var(--gon-bear,#ff2d5e)" title="Total des positions LONGUES liquid&eacute;es sur les 15 derni&egrave;res minutes (symbole affich&eacute;)">
        <span class="num" id="gonLiqNumL">0.0</span><span class="unit">M</span>
        <div class="cap" style="color:rgba(var(--gon-bear-rgb,255,45,94),.55)">&#9660; LONGS BR&Ucirc;L&Eacute;S</div>
      </div>
      <div class="gonLiqCnt" style="color:var(--gon-bull,#2f8bff)" title="Total des positions COURTES liquid&eacute;es sur les 15 derni&egrave;res minutes (symbole affich&eacute;)">
        <span class="num" id="gonLiqNumS">0.0</span><span class="unit">M</span>
        <div class="cap" style="color:rgba(var(--gon-bull-rgb,47,139,255),.55)">&#9650; SHORTS BR&Ucirc;L&Eacute;S</div>
      </div>
      <div id="gonLiqDomWrap" title="Dominance des liquidations 15 min : longs vs shorts, z&eacute;ro au centre &mdash; le c&ocirc;t&eacute; qui d&eacute;borde est celui qui br&ucirc;le le plus">
        <div id="gonLiqDomBar"><div class="l" style="width:0"></div><div class="s" style="width:0"></div><div class="n"></div></div>
        <div id="gonLiqDomCap"><span>DOMINANCE</span><span id="gonLiqPct">&mdash;</span></div>
      </div>
      <div id="gonOiWrap">
        <div class="oiRow" title="Variation de l'Open Interest (positions ouvertes) sur 15 min : il MONTE = du monde entre (mouvement construit), il FOND = des positions ferment ou sont liquid&eacute;es (nettoyage)">
          <span class="k">OPEN INTEREST 15'</span><span class="v" id="gonOiVal">&mdash;</span></div>
        <div class="oiRow" title="Taux de funding du perp et compte &agrave; rebours du prochain r&egrave;glement : positif = les longs paient (march&eacute; charg&eacute; long), n&eacute;gatif = les shorts paient">
          <span class="k">FUNDING &middot; <span id="gonFundCd">--:--</span></span><span class="v fund" id="gonFundVal">&mdash;</span></div>
        <div id="gonRegime" hidden title="Lecture crois&eacute;e prix + OI + liquidations : SQUEEZE = nettoyage de positions forc&eacute;es (fragile), TENDANCE = nouveau positionnement (construit), NEUTRE = rien &agrave; signaler">NEUTRE</div>
      </div>
      <div id="gonLiqChan" title="Canal tous-march&eacute;s : chaque orbe = une liquidation en direct. M&eacute;t&eacute;ores brillants = symbole affich&eacute;, petites boules = autres march&eacute;s. Descend = longs, monte = shorts."><canvas></canvas></div>
      <div id="gonLiqJournal" title="Journal : liquidations &ge; 250 k$ du symbole affich&eacute;, heure locale"><div class="t">JOURNAL</div><div id="gonLiqEvList"></div></div>
      <div id="gonLiqVideo">
        <video src="laforge.mp4" autoplay muted playsinline></video>
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
    oiEls.val = document.getElementById("gonOiVal");
    oiEls.fund = document.getElementById("gonFundVal");
    oiEls.cd = document.getElementById("gonFundCd");
    oiEls.regime = document.getElementById("gonRegime");

    // THEME : bascule la classe .light du panneau (tons neutres uniquement) au
    // rythme de l'evenement gon:theme emis par G-Bot. isLight sert aussi a la
    // ligne d'horizon dessinee en canvas (alpha renforce sur fond clair).
    const applyTheme = () => {
      isLight = lumHex(gon.theme && gon.theme.bg) > 0.5;
      panel.classList.toggle("light", isLight);
    };
    applyTheme();
    syncPalette(gon.theme);   // etat initial (l'event ne rejoue pas le passe)
    window.addEventListener("gon:theme", applyTheme);

    // Pas de bouton de bascule (demande Meddy) : le panneau reste toujours
    // affiche (la media query <860px le masque seule). Purge de l'etat herite.
    visible = true;
    try { localStorage.removeItem(ON_KEY); } catch (_) {}

    // son de la video : bouton mute + curseur de volume (persiste). Chrome
    // exige un geste utilisateur pour l'audio — clic et drag en sont.
    const vid = panel.querySelector("#gonLiqVideo video");
    // encart masque -> ne pas telecharger/decoder la video pour rien
    vid.autoplay = false;
    vid.removeAttribute("src");
    try { vid.load(); } catch (_) {}
    const snd = panel.querySelector("#gonLiqSnd");
    const vol = panel.querySelector("#gonLiqVol");
    try { vol.value = localStorage.getItem("gon.liq.vol") || "70"; } catch (_) {}
    vid.volume = Number(vol.value) / 100;
    // PLAYLIST : les videos s'enchainent puis rebouclent (l'attribut loop a
    // ete retire — c'est le handler ended qui fait tourner la liste).
    const PLAYLIST = ["laforge.mp4", "montage_kenzo7_gon_v2.mp4"];
    let vidIdx = 0;
    vid.addEventListener("ended", () => {
      vidIdx = (vidIdx + 1) % PLAYLIST.length;
      vid.src = PLAYLIST[vidIdx];
      vid.play().catch(() => {});
    });
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
