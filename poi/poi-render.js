/* G-ON — rendu POI sur canvas jumeau, aligne sur le chart Lightweight Charts de
 * G-Bot via ses convertisseurs natifs (series.priceToCoordinate + xOf).
 * Passe de design finale (spec DA) :
 * - hues directionnelles = PALETTE du chart (bull/bear via gon:theme, defauts
 *   long #2f8bff / short #ff2d5e) ; l'alpha seul encode le score ;
 * - statut par MORPHOLOGIE du trait : plein=actif, tirete=touche, pointille=mort ;
 * - anti-collision bougies par CASING (gainage couleur-de-fond, 2 passes, crisp) ;
 * - chips monospace tabulaires (prix | score), caret vers le prix exact, connecteur
 *   en equerre quand le chip est dodge ; morts = chip centre sur la ligne ;
 * - adaptation dark/light par luminance de gon.theme.bg (event gon:theme) ;
 * - lignes LASER (demande utilisateur) : double halo lumineux au shadowBlur +
 *   coeur sur-brillant tirant vers le blanc, pose PAR-DESSUS le casing qui
 *   preserve la lisibilite sur les bougies ; laser DIRECTIONNEL pour tous —
 *   les elites (S>=90) : fluo plus intense + pulsation, l'or reste reserve
 *   a la pastille et a la bordure de chip.
 * Toujours aucun degrade ni rectangle decoratif. */
(function () {
  "use strict";

  // Hues directionnelles pilotees par la PALETTE du chart (gon:theme) :
  // long = couleur achat (bull), short = couleur vente (bear) — memes teintes
  // que carnet/CVD/orbs/dominance. Defauts = canoniques bleu/rouge.
  const HUE = { long: [47, 139, 255], short: [255, 45, 94] };
  // POI provisoire (bougie en cours) : vert long / rouge short — palette
  // distincte des definitifs pour lire "en formation" d'un coup d'oeil.
  const PROV_HUE = { long: [34, 197, 94], short: [239, 68, 68] };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  // Teinte vers le blanc (coeur du laser) — melange arithmetique, pas un degrade.
  const tint = (c, f) => [Math.round(c[0] + (255 - c[0]) * f), Math.round(c[1] + (255 - c[1]) * f), Math.round(c[2] + (255 - c[2]) * f)];

  const ALPHA = {
    lineActive: 1.0, lineTouched: 0.70,
    lineDead: { dark: 0.52, light: 0.60 },   // lisible : un chip sans ligne visible = "flottant"
    chipActive: 1.0, chipTouched: 0.90, chipDead: 0.75,
    connector: 0.60
  };
  const W = { active: 0.5, touched: 0.5, dead: 0.5, casingExtra: 1.25 };   // traits ULTRA fins (laser) — les elites seules s'epaississent
  const DASH = { active: null, touched: [7, 4], dead: [1.5, 3.5] };
  const TAG_H = 17, TAG_GAP = 3, MAX_LEVELS = 300, DECLUTTER_GAP_PX = 8;
  // Niveaux d'ELITE (S >= seuil) : laser DORE (charte G-Bot) au lieu du laser
  // directionnel — les meilleurs scores se reperent d'un coup d'oeil.
  const ELITE_SCORE = 90;
  const DEAD_GAP_PX = TAG_H + 3;   // chips morts centres : jamais de chevauchement
  // Ligne FANTOME des morts (pleine largeur, au prix) : tres pale, juste assez
  // pour rester trouvable en scrollant sans encombrer ni "traverser" fort.
  const GHOST_ALPHA = { dark: 0.10, light: 0.14 };
  // Fantome RESERVE aux scores eleves : seuls les niveaux marquants gardent une
  // ligne de prix permanente (les faibles restent en detail naissance->mort
  // pres de l'evenement). Reduit fortement la densite.
  const GHOST_MIN_SCORE = 90;
  // Mort RECENT (donnees live) : un niveau qui meurt a l'ecran reste visible en
  // pointille dans TOUTES les vues pendant cette fenetre — il ne disparait plus
  // d'un coup. Filtre par le curseur (minScore), pas par le plancher FORT (>=80)
  // qui ne desencombre que les morts d'ARCHIVE (nombreux).
  const RECENT_DEAD_MS = 24 * 3600 * 1000;
  const W15 = 900;   // fenetre M15 en secondes — source unique des bornes d'anchorSec (audit 7)
  const PRICE_FONT = "600 11px Consolas, 'Roboto Mono', monospace";
  const SCORE_FONT = "700 9px Consolas, 'Roboto Mono', monospace";
  const CHIP_PAD = 6, CHIP_RULE_GAP = 5;

  function hexToRgb(hex) {
    const n = parseInt(String(hex || "#060604").slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function create(gon) {
    const host = gon.mount;
    const cv = document.createElement("canvas");
    cv.id = "poiOverlay";
    Object.assign(cv.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "4" });
    host.appendChild(cv);
    const ctx = cv.getContext("2d");

    let pois = [], prov = null, visible = true, dpr = 1, showConsumed = false, minScore = 0, climaxOnly = false;
    // P2 (audit 2026-07-24) : pre-index reconstruit a chaque setPois — les
    // boucles de paint ne re-parcourent plus les ~54k POI de l'archive a
    // chaque frame. Tri par score DESC : les filtres de seuil deviennent des
    // break (en vue FORT, seul le prefixe >= 80 est visite).
    let aliveIdx = [], deadIdx = [], ghostIdx = [], winIdx = [];
    function reindex() {
      aliveIdx = []; deadIdx = []; ghostIdx = []; winIdx = [];
      for (const p of pois) {
        if (p.status === "ACTIVE_UNTOUCHED") aliveIdx.push(p);
        else {
          deadIdx.push(p);
          if ((p.score || 0) >= GHOST_MIN_SCORE) ghostIdx.push(p);
        }
        if ((p.win === 1 || p.win === 0) && (p.firstTouchTs ?? p.statusChangedTs)) winIdx.push(p);
      }
      const byScore = (a, b) => (b.score || 0) - (a.score || 0);
      aliveIdx.sort(byScore); deadIdx.sort(byScore); ghostIdx.sort(byScore);
    }
    // Seuil de score SEPARE pour les niveaux MORTS : le score sert a desencombrer
    // les morts (tres nombreux), PAS a cacher les vivants (peu, actionnables).
    // minScore filtre les VIVANTS, deadMinScore filtre les MORTS.
    let deadMinScore = 0;
    // Reserve a droite (panneau FLUX au-dessus du chart) : les LIGNES passent
    // sous le verre (transparence voulue), seuls les chips se decalent.
    let rightInset = 0;
    let rafId = 0, lastSig = null, forceDirty = true, destroyed = false;
    // Identite (TF/symbole) de la DERNIERE image valide : si elle change alors
    // que l'echelle n'est pas encore prete, l'ancienne image est PERIMEE
    // (positions de l'ancienne TF) et doit etre effacee, pas figee.
    let lastGoodTf = null, lastGoodSym = null;
    // Pulsation discrete des ELITES : phase temporelle appliquee a leur glow.
    // hasEliteVisible arme le repaint continu ; sans elite a l'ecran, la
    // boucle reste purement dirty-based (zero repaint inutile).
    let pulseK = 1, hasEliteVisible = false, lastPulsePaint = 0;
    let glowBudgetOK = true;   // R4 : glow coupé au-delà de GLOW_MAX_LEVELS traits dessinés (perf)
    const mark = () => { forceDirty = true; };

    // --- tokens de theme (dark/light par luminance du fond) ------------------
    let T = null;
    function computeTheme() {
      const bg = (gon.theme && gon.theme.bg) || "#060604";
      const mode = luminance(bg) < 0.45 ? "dark" : "light";
      const bgRgb = hexToRgb(bg);
      T = {
        mode,
        casing: rgba(bgRgb, mode === "dark" ? 0.92 : 0.95),
        lineDeadAlpha: ALPHA.lineDead[mode],
        chipBg: mode === "dark" ? rgba(bgRgb, 0.92) : "rgba(255,253,246,.95)",
        chipText: mode === "dark" ? "#e8ecf2" : "#26303e",
        chipTextDim: mode === "dark" ? "rgba(232,236,242,.75)" : "rgba(38,48,62,.75)",
        chipRule: mode === "dark" ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.14)"
      };
    }
    computeTheme();
    function syncPalette() {
      const t = gon.theme || {};
      if (t.bull) HUE.long = hexToRgb(t.bull);
      if (t.bear) HUE.short = hexToRgb(t.bear);
    }
    syncPalette();
    const onTheme = () => { computeTheme(); syncPalette(); mark(); };
    window.addEventListener("gon:theme", onTheme);

    function size() {
      const rect = host.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(rect.width * dpr));
      cv.height = Math.max(1, Math.round(rect.height * dpr));
      cv.style.width = rect.width + "px";
      cv.style.height = rect.height + "px";
      mark();
    }

    function viewSig() {
      const ts = gon.ts();
      let lr = "", pr = "";
      try { const r = ts.getVisibleLogicalRange(); if (r) lr = r.from.toFixed(3) + "," + r.to.toFixed(3); } catch (_) {}
      try {
        const h = cv.height / dpr;
        pr = gon.series.coordinateToPrice(4) + "," + gon.series.coordinateToPrice(Math.floor(h * 0.6));
      } catch (_) {}
      const w = (typeof ts.width === "function" ? ts.width() : 0);
      // tf/tfSec dans la signature : un changement de TF peut retomber par
      // hasard sur les memes ranges logique/prix — sans ceci, pas de repaint.
      return lr + "|" + pr + "|" + w + "|" + cv.width + "x" + cv.height + "|" + (gon.tf || "") + "|" + (gon.tfSec || "");
    }

    function visibleRangeSec() {
      try {
        const r = gon.ts().getVisibleRange();
        if (r && typeof r.from === "number" && typeof r.to === "number") return { from: r.from, to: r.to };
      } catch (_) {}
      return null;
    }
    function intersectsView(poi, vis, now) {
      // cull sur l'ancre SNAPPEE (celle qui est dessinee) : le createdTs brut
      // peut etre jusqu'a un bucket a droite de l'ancre sur les TF hauts —
      // culler dessus fait disparaitre des niveaux visibles au bord droit.
      const startSec = anchorSec(poi, poi.createdTs, true);
      const active = poi.status === "ACTIVE_UNTOUCHED";
      // Fallback aligne sur drawLevel (endMs ?? now) : un POI mort sans champ
      // de touche est DESSINE jusqu'a maintenant — le culler a createdTs le
      // ferait disparaitre des qu'on scrolle sa bougie de naissance hors ecran.
      const endSec = active ? now / 1000 : anchorSec(poi, poi.firstTouchTs ?? poi.statusChangedTs ?? now);
      return startSec <= vis.to && Math.max(endSec, startSec) >= vis.from;
    }

    // M4 (audit 2026-07-24) : en REPLAY, le statut affiche est celui du moment
    // REJOUE, pas celui d'aujourd'hui — sinon l'outil d'entrainement montre
    // quels niveaux vont mourir (meme classe de fuite que la garde ✦).
    //   0 = statut inchange ; 1 = pas encore touche au curseur (rendre VIVANT) ;
    //   2 = touche mais pas encore mort au curseur (rendre TOUCHED).
    function replayResState(poi, cutMs) {
      if (!cutMs || poi.status === "ACTIVE_UNTOUCHED") return 0;
      const first = poi.firstTouchTs ?? poi.statusChangedTs ?? 0;
      if (first > cutMs) return 1;
      const last = poi.statusChangedTs ?? first;
      return (poi.status !== "TOUCHED" && last > cutMs) ? 2 : 0;
    }
    // Clone UNIQUEMENT au moment d'entrer dans `shown` (borne par la vue) —
    // jamais par POI du fichier.
    function replayResurrect(poi, r) {
      return r === 1
        ? Object.assign({}, poi, { status: "ACTIVE_UNTOUCHED", firstTouchTs: null, statusChangedTs: null, touchCount: 0, maxPenetrationPct: 0 })
        : Object.assign({}, poi, { status: "TOUCHED", statusChangedTs: poi.firstTouchTs ?? poi.statusChangedTs });
    }

    // --- primitives de dessin ------------------------------------------------
    // Trait LASER, en passes superposees (aucun degrade) :
    //   casing fond -> halo large -> halo serre -> trait directionnel ->
    //   COEUR sur-brillant (teinte vers le blanc).
    // Le casing sous les passes garde le niveau lisible sur les bougies ;
    // glowScale module l'intensite (actif 1, touche ~0.45, mort 0) ;
    // hot (elites) : coeur quasi blanc et alphas pulses — le TOP se voit au
    // trait (lw elargi en amont), pas a un halo plus epais.
    function laserHline(x1, x2, y, width, hue, alpha, dash, glowScale, hot) {
      const snapped = width % 2 === 0 ? Math.round(y) : Math.round(y) + 0.5;
      const pass = (w, style, blur, blurColor) => {
        if (blur) { ctx.shadowColor = blurColor; ctx.shadowBlur = blur; }
        ctx.beginPath(); ctx.moveTo(x1, snapped); ctx.lineTo(x2, snapped);
        ctx.strokeStyle = style; ctx.lineWidth = w; ctx.stroke();
        if (blur) ctx.shadowBlur = 0;
      };
      ctx.save();
      ctx.lineCap = "butt";
      if (dash) ctx.setLineDash(dash);
      pass(width + W.casingExtra, T.casing);
      // Les elites (hot) respirent en LUMINOSITE : leurs alphas suivent pulseK
      // (le rayon seul etait imperceptible — retour utilisateur).
      const k = hot ? pulseK : 1;
      const A = (a) => Math.min(1, a * k);
      if (glowScale > 0) {
        // Halo CONCENTRE (fluo, pas bloom) : rayons courts, alpha soutenu.
        const dim = T.mode === "light" ? 0.55 : 1;   // halo attenue sur fond clair
        pass(width, rgba(hue, A(0.40 * dim)), 6 * glowScale, rgba(hue, 0.95));
        pass(width, rgba(hue, A(0.65 * dim)), 3 * glowScale, rgba(hue, 0.95));
      }
      pass(width, rgba(hue, alpha));
      if (glowScale > 0) {
        const coreW = Math.max(0.5, width - 0.5);
        pass(coreW, rgba(tint(hue, hot ? 0.85 : 0.62), A(0.95)), 1.5 * glowScale, rgba(hue, 0.95));
      }
      ctx.restore();
    }

    // Ancre temporelle SNAPPEE au centre de la bougie contenante du TF
    // affiche : l'interpolation exacte posait les origines ENTRE les bougies
    // des TF superieurs (POI ne 15:45 -> 3/4 entre deux bougies 1h) — juste
    // temporellement, mais lu comme un decalage. Sur les TF <= 15m divisant
    // le bucket, le snap est un no-op.
    // Prix de reference d'un POI — MEME repli que le dessin (drawLevel trace
    // un short sans entry a zoneLow) : cull et declutter doivent tester le y
    // effectivement dessine.
    const refPrice = (p) => p.entry ?? p.entryPrice ?? (p.direction === "long" ? p.zoneHigh : p.zoneLow);

    function snapToBarSec(ms) {
      const s = Number(gon.tfSec) || 0;
      const t = ms / 1000;
      if (s <= 0) return t;
      // GRILLE = source UNIQUE `gon.bucketStart` (l'ouverture de bougie de G-Bot :
      // epoch pour l'intraday, lundi W0 pour l'hebdo, MOIS CALENDAIRE pour le
      // mensuel). Plus aucune grille reimplementee ici a resynchroniser — c'est
      // la meme fonction qui positionne les bougies qui positionne les pastilles.
      const bucket = gon.bucketStart;
      if (typeof bucket === "function") {
        // Equipe debug 2026-07-22 : la bougie CONTENANTE partout (floor). L'ancien
        // CEIL sous M15 (« 1re bougie PLEINE ») decalait le repli d'UNE bougie a
        // droite sur 48-87 % des fenetres 2m/4m/8m — pose sur un centre de bougie
        // pixel-parfait... de la MAUVAISE bougie. Depuis que xOf snape au centre,
        // la contenante est le choix honnete (1/2 bougie tot au pire, jamais 1 tard).
        return bucket(t);
      }
      // Repli si le seam bucketStart n'est pas expose (G-Bot anterieur) : ancienne
      // grille inline. Correcte partout SAUF le mensuel (interpolation) — pas de
      // casse, seulement l'ancien comportement mensuel le temps d'un cache.
      // Audit 7 : FLOOR aussi ici (le ceil residuel contredisait la decision
      // bougie-contenante et re-creerait le +1 bougie si jamais atteint).
      if (s >= 2419200) return t;
      if (s % 604800 === 0) return Math.floor((t - 345600) / s) * s + 345600;
      return Math.floor(t / s) * s;
    }

    // --- ancre RAFFINEE : la bougie du TF affiche qui TOUCHE le niveau -------
    // Les timestamps POI sont a resolution M15 (debut de bougie M15). Sur un TF
    // plus fin, cet instant designe une FENETRE de bougies : snapper a son debut
    // posait naissance et tick de mort jusqu'a plusieurs bougies AVANT la vraie
    // touche (mesure live 2m : 39% seulement des ticks sur une bougie touchant
    // le niveau). On cherche donc DANS la fenetre M15 la premiere bougie du TF
    // courant dont la plage recouvre la zone du POI — la bougie que l'oeil
    // attend (97% mesure). Repli : snap M15 classique (fenetre hors donnees).
    // Memoise par POI+instant (les bougies passees ne changent pas) ; le cache
    // saute au changement de symbole/TF.
    // birth=true : bougie qui FORME le niveau = l'extreme de la fenetre M15
    // (max high pour un short — zone au sommet ; min low pour un long) ; une
    // bougie "en chemin" peut recouvrir la zone avant celle de l'extreme, la
    // premiere-qui-touche est donc fausse pour une NAISSANCE.
    // birth=false (touche/mort) : premiere bougie dont la plage recouvre la zone.
    let anchorCache = new Map(), anchorKey = "", paintData;
    const loadPaintData = () => {
      if (paintData === undefined) {
        try { paintData = (typeof gon.dataNow === "function" ? gon.dataNow() : gon.series.data()) || null; }
        catch (_) { paintData = null; }
      }
      return paintData;
    };
    // (alignement 2026-07-24) : un temps snappe peut tomber sur un seau VIDE —
    // frequent en secondes (un seau sans trade n'a PAS de bougie), possible en
    // klines (trou d'exchange). xOf interpolerait alors ENTRE deux bougies et
    // le trait flottait "dans le vide". On ancre au centre de la bougie REELLE
    // contenante (dernier time <= t) quand t est dans la plage des donnees.
    function toExistingBar(t) {
      const A = loadPaintData();
      if (!A || !A.length || t < A[0].time || t > A[A.length - 1].time) return t;
      let lo = 0, hi = A.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m].time <= t) lo = m; else hi = m; }
      return A[hi].time <= t ? A[hi].time : A[lo].time;
    }
    function anchorSec(poi, ms, birth) {
      const snapped = snapToBarSec(ms);
      const s = Number(gon.tfSec) || 0;
      if (s <= 0) return snapped;
      if (s >= 900) return toExistingBar(snapped);   // TF >= M15 : bougie contenante exacte — sur bougie REELLE (kline absente couverte)
      // Cle de cache = symbole|tf|TETE des donnees (alignement 2026-07-24) : la
      // tete d'une page est un seau PARTIEL (coupe par la pagination), complete
      // ensuite par deepenSec — une ancre calculee dessus restait figee fausse,
      // aucun prepend n'invalidait le cache. Inclure A[0].time vide le cache a
      // chaque prepend (rares apres stabilisation, cout negligeable).
      const D = loadPaintData();
      const ck = (gon.symbol || "") + "|" + (gon.tf || "") + "|" + (D && D.length ? D[0].time : 0);
      if (ck !== anchorKey) { anchorCache.clear(); anchorKey = ck; }
      const key = (poi.id || "") + "|" + ms + (birth ? "|b" : "");
      let v = anchorCache.get(key);
      if (v !== undefined) return v;
      v = snapped;
      // Audit 2026-07-22 : ne memoiser que si la fenetre M15 est ENTIEREMENT
      // couverte par les bougies chargees — une ancre calculee sur une fenetre
      // en formation (bougie courante), tronquee (replay) ou hors donnees
      // (scroll-back a venir) restait figee fausse jusqu'au changement de TF.
      let cacheable = false;
      try {
        const A = loadPaintData();
        if (A && A.length) {
          const w0 = Math.floor(ms / (W15 * 1000)) * W15;   // debut de la fenetre M15 (s)
          const tSec = ms / 1000;
          if (birth) {
            // Cacheable durci (alignement) : la tete des donnees ne doit JAMAIS
            // etre DANS la plage cherchee (w0 - s couvre la chevauchante).
            cacheable = A[0].time <= w0 - s && A[A.length - 1].time >= w0 + 900;
            // FIDELITE (equipe debug) : fpTimeStart/fpTimeEnd = datation REELLE
            // de la formation du cluster (ms, 9821/9821 valides dans l'archive,
            // pose aussi par le detecteur live). L'extreme se cherche dans CETTE
            // plage — la bougie qui a forme le niveau, plus une heuristique de
            // fenetre entiere. Repli : fenetre M15 complete.
            let from = w0, to = w0 + 900;
            if (Number.isFinite(poi.fpTimeStart) && Number.isFinite(poi.fpTimeEnd) && poi.fpTimeEnd > poi.fpTimeStart) {
              from = Math.max(w0, Math.floor(poi.fpTimeStart / 1000));
              to = Math.min(w0 + 900, Math.ceil(poi.fpTimeEnd / 1000) + 1);
              if (to <= from) { from = w0; to = w0 + 900; }
            }
            const f0 = from - s;   // chevauchante incluse aussi pour l'extreme de naissance
            // GATE de couverture GAUCHE (alignement 2026-07-24, cause majeure en
            // secondes) : si la tete des donnees tombe DANS la plage cherchee
            // (fenetre M15 a cheval sur le debut de l'historique — chronique en
            // 3 s ou l'historique ne couvre que ~25 min), la vraie bougie
            // formatrice est peut-etre ABSENTE : raffiner poserait la pastille
            // sur une mauvaise bougie, tiree vers la tete des donnees. Repli
            // snapped (temporellement exact). Le cote DROIT reste ouvert : la
            // fenetre M15 COURANTE se raffine legitimement sur l'extreme
            // "jusqu'ici" (provisoire, naissances live).
            if (A[0].time <= f0) {
              // Alignement visuel (Meddy 2026-07-24, mesure en reel 15s : 21/36
              // anneaux de naissance sur une bougie qui n'ATTEINT pas la ligne
              // tracee — l'extreme de la fenetre forme la zone mais s'arrete
              // souvent sous/dessus l'entry). Parmi les bougies de la fenetre,
              // PRIORITE a celles qui intersectent la ligne (extreme parmi
              // elles) ; repli : extreme brut (comportement precedent).
              const eB = poi.entry ?? poi.entryPrice ?? (poi.direction === "long" ? poi.zoneHigh : poi.zoneLow);
              const epsB = (Number.isFinite(eB) ? Math.abs(eB) : 1) * 1e-9;   // meme epsilon IEEE754 que la fin
              let lo = 0, hi = A.length - 1;
              while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m].time < f0) lo = m; else hi = m; }
              let bestV = null, bestTouchV = null, vTouch = null;
              for (let i = lo; i < A.length && A[i].time < to; i++) {
                const b = A[i];
                if (b.time + s <= from) continue;
                const touches = eB != null && b.low <= eB + epsB && b.high >= eB - epsB;
                if (poi.direction === "short") {
                  if (bestV == null || b.high > bestV) { bestV = b.high; v = b.time; }
                  if (touches && (bestTouchV == null || b.high > bestTouchV)) { bestTouchV = b.high; vTouch = b.time; }
                } else {
                  if (bestV == null || b.low < bestV) { bestV = b.low; v = b.time; }
                  if (touches && (bestTouchV == null || b.low < bestTouchV)) { bestTouchV = b.low; vTouch = b.time; }
                }
              }
              if (vTouch != null) v = vTouch;
            }
          } else {
            // TOUCHE/MORT — recherche ETAGEE (equipe debug, mesures : 17 % des
            // morts d'archive sans bougie touchante dans leur fenetre, vraie
            // traversee a 10-35 bougies ; 13/14 fallbacks 1m = cassure de
            // CLUSTER hors zone ; bougie CHEVAUCHANTE exclue = 11-42 % de
            // mauvaises bougies en 2m/4m/8m). Une bougie appartient a la
            // fenetre si son INTERVALLE [time, time+s) l'intersecte.
            const e = poi.entry ?? poi.entryPrice;   // la LIGNE visible est au prix d'entree
            const zsLo = poi.zoneLow, zsHi = poi.zoneHigh;                                 // zone PURE
            const zLo = Math.min(zsLo, poi.clusterLow ?? zsLo);                            // enveloppe
            const zHi = Math.max(zsHi, poi.clusterHigh ?? zsHi);                           //  ∪ cluster
            // EPSILON flottant (mesure en reel TIA 3s, 2026-07-24) : les prix
            // d'archive portent du bruit IEEE754 (entry 0.34790000000000004 vs
            // high de bougie 0.3479 EXACT) — une touche au tick pres echouait
            // pour 4e-17. Tolerance relative 1e-9 : des millions de fois sous
            // le tick le plus fin, aucun faux positif possible.
            const eps = (Number.isFinite(e) ? Math.abs(e) : Math.abs(zsHi) || 1) * 1e-9;
            const seek = (from, to, mode, first) => {   // bougie qui touche, 1re (first) ou la PLUS PROCHE de tSec
              const f0 = from - s;   // attrape la chevauchante
              // GATE de couverture GAUCHE (alignement 2026-07-24) : plage
              // tronquee par la tete des donnees -> la vraie bougie touchante
              // est peut-etre absente, "premiere qui touche" serait EN RETARD
              // et "plus proche de tSec" fausse des deux cotes. On refuse.
              if (A[0].time > f0) return null;
              let lo = 0, hi = A.length - 1;
              while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m].time < f0) lo = m; else hi = m; }
              let best = null, bd = Infinity;
              for (let i = lo; i < A.length && A[i].time < to; i++) {
                const b = A[i];
                if (b.time + s <= from) continue;   // finit avant la fenetre : vraiment exclue
                const hit = mode === "line" ? (e != null && b.low <= e + eps && b.high >= e - eps)
                  : mode === "zoneStrict" ? (b.low <= zsHi + eps && b.high >= zsLo - eps)
                  : (b.low <= zHi + eps && b.high >= zLo - eps);
                if (!hit) continue;
                if (first) return b.time;
                const d = Math.abs(b.time - tSec);
                if (d < bd) { bd = d; best = b.time; }
              }
              return best;
            };
            // Etage 1 (fenetre exacte) : ligne -> zone PURE (audit 7 : l'enveloppe
            // cluster en premier pouvait attraper une bougie AVANT la vraie
            // touche de zone) -> enveloppe cluster. Etages 2-3 elargis. Repli :
            // snapped = bougie CONTENANTE (FLOOR).
            // Alignement visuel (Meddy 2026-07-24, mesure en reel 15s : 5/33
            // fins ancrees sur une bougie qui ne TOUCHE PAS le prix trace —
            // un hit de zone/cluster dans la fenetre exacte court-circuitait
            // la recherche LIGNE elargie ; la ligne est dessinee a l'ENTRY et
            // la meche s'arretait quelques dollars avant). PRIORITE ABSOLUE a
            // une bougie qui intersecte la ligne tracee, fenetres de plus en
            // plus larges ; la zone ne sert plus que de dernier repli.
            let viaExact = true;
            let r = seek(w0, w0 + W15, "line", true);
            if (r == null) {
              viaExact = false;
              r = seek(w0 - W15, w0 + 2 * W15, "line", false)
                ?? seek(w0 - 3 * W15, w0 + 4 * W15, "line", false)
                ?? seek(w0, w0 + W15, "zoneStrict", true)
                ?? seek(w0, w0 + W15, "zone", true)
                ?? seek(w0 - 3 * W15, w0 + 4 * W15, "zone", false);
            }
            v = r ?? snapped;
            // Cache a deux niveaux (audit 7) : un resultat d'etage 1 est stable des
            // que SA fenetre est couverte (l'exigence large rendait les TF secondes
            // et toute mort recente JAMAIS cacheables -> recalcul par frame) ;
            // l'exigence large ne s'applique qu'aux resultats des etages 2-4.
            cacheable = viaExact
              ? (A[0].time <= w0 - s && A[A.length - 1].time >= w0 + W15)
              : (A[0].time <= w0 - 3 * W15 - s && A[A.length - 1].time >= w0 + 4 * W15);
          }
          // Repli snapped (fenetre non couverte, ou aucune bougie touchante) :
          // ancre sur la bougie REELLE contenante, jamais entre deux bougies.
          if (v === snapped) v = toExistingBar(snapped);
        }
      } catch (_) {}
      if (cacheable) {
        if (anchorCache.size > 4000) {
          // Eviction PARTIELLE (audit 7) : le clear() total en cours de frame sur
          // vue tres dezoomee (>2000 POI visibles) forcait le recalcul de TOUT a
          // chaque frame. Map itere en ordre d'insertion -> on retire les 1000
          // plus anciennes entrees.
          let n = 0;
          for (const k of anchorCache.keys()) { anchorCache.delete(k); if (++n >= 1000) break; }
        }
        anchorCache.set(key, v);
      }
      return v;
    }

    function drawLevel(poi, plotW, now, wantLabel, centeredPrices) {
      const entryPrice = poi.entry ?? poi.entryPrice;
      const yEntry = entryPrice == null ? null : gon.priceToY(entryPrice);
      const oppPrice = poi.direction === "long" ? poi.zoneHigh : poi.zoneLow;
      const yOpp = oppPrice == null ? null : gon.priceToY(oppPrice);
      if (yEntry == null && yOpp == null) return null;
      const active = poi.status === "ACTIVE_UNTOUCHED";
      // Origine du trait (ACTIF comme MORT) : la BOUGIE DE NAISSANCE (createdTs),
      // sur toutes les TF. Decision Meddy : la pastille au bout du trait doit
      // atteindre la bougie qui lui appartient. (Les variantes availableAt /
      // fin-de-gap posaient l'origine APRES la naissance — jusqu'a DANS LE FUTUR
      // pour un niveau recent — et la pastille flottait dans le vide.)
      const originMs = poi.createdTs;
      let x1 = gon.timeToX(anchorSec(poi, originMs, true));
      if (x1 == null || !isFinite(x1)) x1 = gon.timeToX(anchorSec(poi, poi.availableAt, true));
      if (x1 == null || !isFinite(x1)) return null;

      const endMs = active ? now : (poi.firstTouchTs ?? poi.statusChangedTs ?? now);
      let x2 = active ? plotW : gon.timeToX(anchorSec(poi, endMs));
      if (active && (x2 == null || !isFinite(x2))) x2 = plotW;
      // Niveau MORT : trait BORNE. Une queue pointillee qui se termine PILE sur
      // la bougie de mort (x2) et remonte au plus DEAD_TAIL_PX vers la gauche
      // (ou la naissance si plus proche). Fini le trait plein-ecran qui balaie
      // toutes les bougies et le repli sur plotW (source des labels alignes).
      if (!active && (x2 == null || !isFinite(x2))) return null;   // mort non placable -> rien (plus de repli plotW)
      // MORT : le trait va de la bougie de DEPART (naissance, x1) a la bougie de
      // FIN (mort, x2). Span REEL, borne a la mort (fini le repli plein-ecran).
      const left = Math.max(0, x1);
      // Largeur MINIMALE aussi pour les morts : un POI ne/mort dans la MEME
      // bougie (x1===x2, frequent sur TF hauts) aurait right<=left -> invisible.
      // Le tick de mort reste ancre a Math.round(x2), on ne gagne que ~2px.
      const right = Math.min(plotW, Math.max(x2, x1 + 2));
      if (right <= 0 || left >= plotW || right <= left) return null;

      const hue = HUE[poi.direction] || HUE.long;
      const y = yEntry != null ? yEntry : yOpp;
      // DEUX ETATS VISUELS SEULEMENT : VIVANT (plein) ou MORT (pointille fin).
      // Les distinctions internes touched / mitigated / invalidated existent
      // toujours dans le moteur (stats de perf, verdicts win), mais ne changent
      // PLUS l'apparence a l'ecran — un mort est un mort, un seul style.
      const lineAlpha = active ? ALPHA.lineActive : T.lineDeadAlpha;
      const width = active ? W.active : W.dead;
      const dash = active ? DASH.active : DASH.dead;
      // Laser : plein feu sur les actifs, eteint sur les morts. Le laser reste
      // DIRECTIONNEL (bleu/rouge) pour tous — les elites (S>=90) tirent un fluo
      // PLUS INTENSE (pas d'or sur la ligne : lisibilite long/short d'abord) ;
      // leur or vit sur pastille + chip.
      const elite = active && Number(poi.score) >= ELITE_SCORE;
      // R4 (audit 6) : au-delà du budget (vue FORT très dézoomée, centaines de
      // traits), le glow (shadowBlur = rasterisation CPU ×5 passes) est coupé —
      // rendu plat net, hiérarchie conservée par l'épaisseur élite. Même
      // principe que le plafond des ✦. La pulsation s'éteint aussi (invisible
      // sans glow) pour ne pas payer 30 fps de scène complète.
      if (elite && glowBudgetOK) hasEliteVisible = true;
      const glowScale = !glowBudgetOK ? 0 : elite ? 1.7 * pulseK : active ? 1 : 0;
      // Elite : trait nettement plus epais + pulsation lumineuse (pulseK sur les
      // alphas du laser) — les standards restent des filaments ultra fins.
      const lw = elite ? width + 1.25 : width;
      // (La LIGNE FANTOME pleine largeur des morts est dessinee dans une passe
      // dediee AVANT, independante du temps — voir drawGhostLines. Ici on ne
      // trace que la portee reelle naissance->mort, nette.)
      laserHline(left, right, y, lw, hue, lineAlpha, dash, glowScale, elite);

      const ySnap = Math.round(y) + 0.5;
      const deadMarkA = T.lineDeadAlpha + 0.25;   // bouts un peu plus francs que le trait
      if (active) {
        // Point d'ORIGINE actif : disque chaud + anneau de gainage.
        if (x1 >= 0 && x1 <= plotW) {
          if (glowScale > 0) { ctx.shadowColor = rgba(hue, 0.9); ctx.shadowBlur = 10 * glowScale; }
          ctx.beginPath(); ctx.arc(x1, ySnap, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = glowScale > 0 ? rgba(tint(hue, 0.45), lineAlpha) : rgba(hue, lineAlpha);
          ctx.fill(); ctx.shadowBlur = 0;
          ctx.lineWidth = 1.5; ctx.strokeStyle = T.casing; ctx.stroke();
        }
      } else {
        // MORT : marqueur aux DEUX bouts du trait, sur leurs bougies exactes.
        // DEPART (naissance) = petit rond CREUX sur la bougie source.
        if (x1 >= 0 && x1 <= plotW) {
          ctx.beginPath(); ctx.arc(x1, ySnap, 3, 0, Math.PI * 2);
          ctx.fillStyle = T.casing; ctx.fill();
          ctx.lineWidth = 1.25; ctx.strokeStyle = rgba(hue, deadMarkA); ctx.stroke();
        }
        // FIN (mort) = tick vertical net "consomme ici" sur la bougie de mort.
        if (x2 > 0 && x2 < plotW) {
          ctx.save(); ctx.lineCap = "butt";
          ctx.beginPath();
          ctx.moveTo(Math.round(x2) + 0.5, ySnap - 4); ctx.lineTo(Math.round(x2) + 0.5, ySnap + 4);
          ctx.strokeStyle = rgba(hue, deadMarkA); ctx.lineWidth = 1.25; ctx.stroke();
          ctx.restore();
        }
      }

      if (!Number.isFinite(poi.score) || !wantLabel) return null;
      const price = entryPrice != null ? entryPrice : oppPrice;
      // (elite est reporte sur le chip de droite via une pastille or)
      if (!active) {
        // Niveaux MORTS : label centre sur le MILIEU DE LA PARTIE VISIBLE de sa
        // vie (audit 8). L'ancien centre-de-vie-ENTIERE sortait de l'ecran pour
        // tout niveau historique a longue vie -> ZERO chip sur les vues
        // profondes sub-M15 (constate des que l'IndexedDB a ouvert la
        // navigation loin dans le passe). On borne dans [left,right] (portion
        // visible du span) — ce n'est PAS le rabat-au-bord-d'ecran d'antan
        // (colonnes alignees) : la borne varie avec chaque span, et si la
        // portion visible est trop courte pour un chip lisible on garde
        // l'ancien comportement (centre-vie ou rien).
        const cw = chipWidth(price, poi.score);
        let cx = (x1 + x2) / 2;
        const lower = left + cw / 2 + 2;
        const upper = Math.min(right, plotW - rightInset) - cw / 2 - 2;
        if (upper >= lower) cx = Math.min(Math.max(cx, lower), upper);
        else if (cx < cw / 2 + 2 || cx > plotW - rightInset - cw / 2 - 2) return null;
        drawChip(Math.round(cx - cw / 2), Math.round(y - TAG_H / 2), price, poi.score, hue, "dead", cw);
        if (centeredPrices) centeredPrices.add(price);
        return null;
      }
      return { y, price, score: poi.score, hue, active, elite };
    }

    function fmtPrice(p) {
      if (!Number.isFinite(p)) return "";
      // Sub-dollar (PEPE, DOGE, SHIB...) : 2 decimales rendaient tous les chips
      // identiques ("0.01") — 4 chiffres significatifs preservent l'info.
      if (p !== 0 && Math.abs(p) < 1) return p.toLocaleString("en-US", { maximumSignificantDigits: 4 });
      return Number.isInteger(p) ? p.toLocaleString("en-US") : p.toLocaleString("en-US", { maximumFractionDigits: 2 });
    }

    const PASTILLE_R = 2.5, PASTILLE_W = PASTILLE_R * 2 + 4;   // pastille or des elites
    // Largeurs memoisees : measureText est appele a chaque paint (60 fps
    // pendant la pulsation des elites) pour des textes tres repetitifs.
    const chipWidthCache = new Map();
    // Les premieres mesures peuvent utiliser la police de repli avant que la
    // monospace cible soit chargee : on purge le cache a l'arrivee des fontes.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { chipWidthCache.clear(); mark(); }).catch(() => {});
    }
    function chipWidth(price, score, elite) {
      const key = price + "|" + score + (elite ? "|e" : "");
      let w = chipWidthCache.get(key);
      if (w == null) {
        ctx.font = PRICE_FONT; const wPrice = ctx.measureText(fmtPrice(price)).width;
        ctx.font = SCORE_FONT; const wScore = ctx.measureText(String(score)).width;
        w = Math.ceil(CHIP_PAD + (elite ? PASTILLE_W : 0) + wPrice + CHIP_RULE_GAP + 1 + CHIP_RULE_GAP + wScore + CHIP_PAD);
        if (chipWidthCache.size > 2000) chipWidthCache.clear();
        chipWidthCache.set(key, w);
      }
      return w;
    }

    // Chip prix | score. state: "active" | "touched" | "dead". elite: pastille or.
    function drawChip(px, py, price, score, hue, state, cw, elite) {
      const priceStr = fmtPrice(price), scoreStr = String(score);
      if (cw == null) cw = chipWidth(price, score, elite);
      const cy = py + TAG_H / 2;
      const alpha = state === "active" ? ALPHA.chipActive : state === "touched" ? ALPHA.chipTouched : ALPHA.chipDead;
      const borderAlpha = state === "active" ? 1 : state === "touched" ? 0.65 : 0.45;
      const scoreAlpha = state === "active" ? 1 : state === "touched" ? 0.75 : 0.70;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = T.chipBg;
      roundRect(ctx, px, py, cw, TAG_H, 2); ctx.fill();
      // Bordure affinee (0.75px) : hue directionnelle, OR pour les elites
      ctx.strokeStyle = elite ? "rgba(217,182,77,.95)" : rgba(hue, borderAlpha); ctx.lineWidth = 0.75;
      roundRect(ctx, px + 0.5, py + 0.5, cw - 1, TAG_H - 1, 2); ctx.stroke();
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      // Pastille OR (elites) : disque plein avant le prix
      const xText = px + CHIP_PAD + (elite ? PASTILLE_W : 0);
      if (elite) {
        ctx.beginPath();
        ctx.arc(px + CHIP_PAD + PASTILLE_R, cy + 0.5, PASTILLE_R, 0, Math.PI * 2);
        ctx.fillStyle = "#d9b64d"; ctx.fill();
        ctx.lineWidth = 0.75; ctx.strokeStyle = "rgba(240,212,120,.9)"; ctx.stroke();
      }
      ctx.font = PRICE_FONT;
      ctx.fillStyle = state === "dead" ? T.chipTextDim : T.chipText;
      const wPrice = ctx.measureText(priceStr).width;
      ctx.fillText(priceStr, xText, cy + 0.5);
      const xSep = xText + wPrice + CHIP_RULE_GAP;
      ctx.save(); ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(Math.round(xSep) + 0.5, py + 4); ctx.lineTo(Math.round(xSep) + 0.5, py + TAG_H - 4);
      ctx.strokeStyle = T.chipRule; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
      ctx.font = SCORE_FONT; ctx.fillStyle = rgba(hue, scoreAlpha);
      ctx.fillText(scoreStr, xSep + 1 + CHIP_RULE_GAP, cy + 0.5);
      ctx.globalAlpha = 1;
    }

    // Colonne de droite (vivants) : caret vers le prix exact, ou connecteur en
    // equerre si le chip a ete dodge.
    function drawTags(tags, plotW, paneH) {
      if (!tags.length) return;
      tags.sort((a, b) => a.y - b.y);
      const maxY = (paneH != null ? paneH : cv.height / dpr) - TAG_H - 2;
      // Saturation : quand la cascade depasse maxY, tous les chips suivants se
      // clampent au meme y et s'empilent en une pile illisible en bas de pane.
      // Un chip qui chevaucherait le precedent est supprime, pas superpose.
      let cursor = 2, lastPy = -Infinity;
      const placed = [];
      for (const t of tags) {
        const py = Math.round(Math.min(maxY, Math.max(t.y - TAG_H / 2, cursor)));
        if (py - lastPy < TAG_H) continue;
        t.py = py; lastPy = py; cursor = py + TAG_H + TAG_GAP;
        placed.push(t);
      }
      const rightX = plotW - 3 - rightInset;
      for (const t of placed) {
        const cw = chipWidth(t.price, t.score, t.elite);
        const px = Math.round(rightX - cw), cy = t.py + TAG_H / 2;
        const state = t.active ? "active" : "touched";
        const chipAlpha = t.active ? ALPHA.chipActive : ALPHA.chipTouched;
        const ySnap = Math.round(t.y) + 0.5;
        if (Math.abs(cy - t.y) <= 1.5) {
          // Caret : triangle plein pointant vers le prix exact
          ctx.globalAlpha = chipAlpha;
          ctx.beginPath();
          ctx.moveTo(px - 4, ySnap); ctx.lineTo(px, t.y - 3.5); ctx.lineTo(px, t.y + 3.5);
          ctx.closePath();
          ctx.fillStyle = rgba(t.hue, t.active ? 1 : 0.65); ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          // Connecteur en equerre : horizontal -> vertical -> pied sur la ligne
          ctx.save(); ctx.lineCap = "butt";
          ctx.strokeStyle = rgba(t.hue, ALPHA.connector); ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, Math.round(cy) + 0.5); ctx.lineTo(px - 4.5, Math.round(cy) + 0.5);
          ctx.moveTo(px - 4.5, Math.round(cy) + 0.5); ctx.lineTo(px - 4.5, ySnap);
          ctx.moveTo(px - 4.5, ySnap); ctx.lineTo(px - 8, ySnap);
          ctx.stroke();
          ctx.restore();
        }
        drawChip(px, t.py, t.price, t.score, t.hue, state, cw, t.elite);
      }
    }

    // POI PROVISOIRE : bande de zone translucide + ligne d'entree pointillee
    // partant du CENTRE exact de la bougie ouverte (timeToCoordinate = centre
    // de barre en LWC), chip "P·S<score>". Hors declutter et hors lifecycle
    // par design (slot unique, remplace — jamais empile). Aucun degrade.
    function drawProvisional(plotW, paneH) {
      const p = prov;
      if (!p) return;
      if ((p.score || 0) < minScore) return;
      if (climaxOnly && !p.climax) return;
      const hue = PROV_HUE[p.direction] || PROV_HUE.long;
      const entry = p.entry ?? p.entryPrice;
      const y = entry == null ? null : gon.priceToY(entry);
      let x1 = gon.timeToX(anchorSec(p, p.createdTs, true));
      if (y == null || !isFinite(y) || x1 == null || !isFinite(x1)) return;
      // Hors echelle de prix : ne rien dessiner (sinon le chip, clampe dans
      // le pane, flotterait au bord sans ligne associee — niveau fantome).
      const paneMax = paneH != null ? paneH : cv.height / dpr;
      if (y < 0 || y > paneMax) return;
      x1 = Math.max(0, Math.min(plotW, x1));
      const ySnap = Math.round(y) + 0.5;
      const yA = gon.priceToY(p.zoneLow), yB = gon.priceToY(p.zoneHigh);
      if (yA != null && yB != null && isFinite(yA) && isFinite(yB)) {
        const top = Math.min(yA, yB), h = Math.max(1, Math.abs(yA - yB));
        ctx.fillStyle = rgba(hue, 0.09);
        ctx.fillRect(x1, top, Math.max(0, plotW - x1), h);
        ctx.save(); ctx.lineCap = "butt"; ctx.setLineDash([3, 3]);
        ctx.strokeStyle = rgba(hue, 0.35); ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(x1, Math.round(top) + 0.5); ctx.lineTo(plotW, Math.round(top) + 0.5);
        ctx.moveTo(x1, Math.round(top + h) + 0.5); ctx.lineTo(plotW, Math.round(top + h) + 0.5);
        ctx.stroke(); ctx.restore();
      }
      ctx.save(); ctx.lineCap = "butt"; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x1, ySnap); ctx.lineTo(plotW, ySnap);
      ctx.strokeStyle = rgba(hue, 0.85); ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
      ctx.beginPath(); ctx.arc(x1, ySnap, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = rgba(hue, 0.95); ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = T.casing; ctx.stroke();
      // (le chip P·S est empile dans la colonne des actifs via drawTags —
      // ici on ne dessine que la bande, la ligne et le point d'origine)
    }

    function paint() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      hasEliteVisible = false;
      paintData = undefined;   // le cache de bougies (anchorSec) vit UNE frame
      // Etat stable "rien a montrer" (masque / aucun POI) : on efface, c'est
      // definitif tant que la vue ne change pas.
      if (!visible || (!pois.length && !prov)) { ctx.clearRect(0, 0, cv.width, cv.height); lastGoodTf = gon.tf; lastGoodSym = gon.symbol; return true; }
      // (alignement 2026-07-24, cause 4) : pendant un switch TF/symbole, la
      // serie AFFICHEE est encore l'ancienne alors que la grille (tfSec,
      // bucketStart) est deja la nouvelle -> snap sur des temps qui ne sont
      // pas des ouvertures de l'ancienne grille, niveaux visiblement decales
      // qui "sautent" a l'arrivee des donnees. On efface et on retente au
      // tick suivant (meme mecanique que lastGoodTf).
      if (typeof gon.dataCtx === "string" && gon.dataCtx !== (gon.symbol + "|" + gon.tf)) {
        ctx.clearRect(0, 0, cv.width, cv.height);
        return false;
      }
      let axisH = 0;
      try { axisH = (typeof gon.ts().height === "function" ? gon.ts().height() : 0) || 0; } catch (_) {}
      const paneH = Math.max(1, cv.height / dpr - axisH);
      let pLo = -Infinity, pHi = Infinity;
      try {
        const a = gon.series.coordinateToPrice(0), b = gon.series.coordinateToPrice(paneH);
        if (a != null && b != null) { pHi = Math.max(a, b); pLo = Math.min(a, b); }
      } catch (_) {}
      // Echelle de prix pas encore prete (transitoire pendant un zoom/pan/maj) :
      // on NE VIDE PAS le canvas -> on garde la derniere image et on RETENTE au
      // tick suivant. Sans ca, les zones s'effacent et ne reviennent qu'au
      // prochain changement de vue. MAIS si la TF/symbole a CHANGE depuis la
      // derniere image, celle-ci montre les positions de l'ANCIENNE TF (traits/
      // labels decales) : on l'efface au lieu de la figer. Retour false = retry.
      if (!isFinite(pLo) || !isFinite(pHi)) {
        if (gon.tf !== lastGoodTf || gon.symbol !== lastGoodSym) ctx.clearRect(0, 0, cv.width, cv.height);
        return false;
      }
      ctx.clearRect(0, 0, cv.width, cv.height);   // on efface SEULEMENT quand on va redessiner
      const plotW = (typeof gon.ts().width === "function" ? gon.ts().width() : cv.width / dpr) || cv.width / dpr;
      const now = Date.now();
      // Battement MAXIMAL (~2 s, +/-80%) : au creux le halo elite retombe
      // SOUS celui d'un actif standard (attenue, jamais tout a fait eteint),
      // au pic il s'embrase — l'epaisseur du trait reste le socle de
      // hierarchie au creux.
      pulseK = 1.0 + 0.80 * Math.sin(now * 0.0031);
      const vis = visibleRangeSec();
      // M4 : curseur du replay = derniere bougie de la tranche rejouee (le
      // seam sert dataNow par reference — live: candles, replay: tranche).
      let replayCutMs = 0;
      if (gon.replay) {
        try {
          const d = gon.dataNow();
          const t = d && d.length ? Number(d[d.length - 1].time) : NaN;
          if (Number.isFinite(t) && t > 0) replayCutMs = t * 1000;
        } catch (_) {}
      }
      ctx.save();
      try {
        ctx.scale(dpr, dpr);
        ctx.beginPath(); ctx.rect(0, 0, plotW, paneH); ctx.clip();

        // --- PASSE FANTOME : ligne pleine largeur au PRIX de chaque niveau MORT,
        // INDEPENDANTE DU TEMPS (comme un support/resistance). Un mort reste
        // trouvable tant que son prix est visible -> il ne disparait plus a la
        // molette quand sa vie naissance->mort sort de la fenetre. Dedupliquee
        // par prix (un seul trait par niveau de prix, pas un par POI) : leger et
        // sans surcharge. Tres pale ; le detail naissance->mort est trace apres.
        if (showConsumed) {
          const ghostSeen = new Set();
          const ghostFloor = Math.max(deadMinScore, GHOST_MIN_SCORE);
          ctx.save(); ctx.lineCap = "butt"; ctx.setLineDash(DASH.dead); ctx.lineWidth = W.dead;
          for (const poi of ghostIdx) {   // P2 : index morts >= GHOST_MIN_SCORE, trie par score desc
            if ((poi.score || 0) < ghostFloor) break;   // tri desc : plus rien d'eligible apres
            if (climaxOnly && !poi.climax) continue;
            if (replayCutMs && replayResState(poi, replayCutMs) === 1) continue;   // M4 : pas encore touche au moment rejoue
            const lvl = refPrice(poi);
            if (!(lvl >= pLo && lvl <= pHi)) continue;
            const key = Math.round(lvl * 1e6);
            if (ghostSeen.has(key)) continue;
            ghostSeen.add(key);
            const y = gon.priceToY(lvl);
            if (y == null || !isFinite(y)) continue;
            const yg = Math.round(y) + 0.5;
            ctx.beginPath(); ctx.moveTo(0, yg); ctx.lineTo(plotW, yg);
            ctx.strokeStyle = rgba(HUE[poi.direction] || HUE.long, GHOST_ALPHA[T.mode]); ctx.stroke();
          }
          ctx.restore();
        }

        let shown = [];
        // P2 : vivants et morts visites separement depuis les index tries par
        // score desc — les seuils deviennent des break, plus de scan des 54k.
        for (const poi of aliveIdx) {
          if ((poi.score || 0) < minScore) break;
          if (climaxOnly && !poi.climax) continue;   // vue climax : bougies a volume dominant
          const lvl = refPrice(poi);
          if (!(lvl >= pLo && lvl <= pHi)) continue;
          if (vis && !intersectsView(poi, vis, now)) continue;
          shown.push(poi);
        }
        const deadFloor = Math.min(minScore, deadMinScore);
        for (const poi0 of deadIdx) {
          if ((poi0.score || 0) < deadFloor) break;   // sous les DEUX seuils : rien d'eligible apres
          if (climaxOnly && !poi0.climax) continue;
          // M4 : statut au moment rejoue — un niveau pas encore touche au
          // curseur du replay est montre VIVANT, un touche-pas-encore-mort en
          // TOUCHED. Le clone n'est cree que pour les POI qui entrent en vue.
          const res = replayCutMs ? replayResState(poi0, replayCutMs) : 0;
          if (res === 1) {
            if ((poi0.score || 0) < minScore) continue;
            const lvl = refPrice(poi0);
            if (!(lvl >= pLo && lvl <= pHi)) continue;
            const poi = replayResurrect(poi0, 1);
            if (vis && !intersectsView(poi, vis, now)) continue;
            shown.push(poi);
            continue;
          }
          const poi = res === 2 ? replayResurrect(poi0, 2) : poi0;
          // Mort recent (live) : visible partout, au seuil du curseur.
          const recentDead = now - (poi.firstTouchTs ?? poi.statusChangedTs ?? 0) < RECENT_DEAD_MS;
          if ((poi.score || 0) < (recentDead ? minScore : deadMinScore)) continue;   // seuils separes morts/vivants
          if (!showConsumed && !recentDead) continue;
          const lvl = refPrice(poi);
          if (!(lvl >= pLo && lvl <= pHi)) continue;
          if (vis && !intersectsView(poi, vis, now)) continue;
          shown.push(poi);
        }
        const rank = (p) => p.status === "ACTIVE_UNTOUCHED" ? 2 : p.status === "TOUCHED" ? 1 : 0;
        shown.sort((a, b) => rank(b) - rank(a) || b.score - a.score);
        const keptLive = [], liveY = [], keptDead = [], deadY = [];
        for (const poi of shown) {
          const y = gon.priceToY(refPrice(poi));
          if (y == null || !isFinite(y)) continue;
          // "dead" au sens du RENDU (chip centre) = tout niveau non-actif, y
          // compris TOUCHED : drawLevel rend TOUCHED comme un mort (chip centre,
          // hauteur TAG_H). L'ancien `rank===0` mettait TOUCHED dans liveY avec un
          // gap 8px alors que son chip centre (16px) exige le gap DEAD_GAP_PX(19)
          // -> chips de touches qui se chevauchaient. On aligne sur le rendu.
          const dead = poi.status !== "ACTIVE_UNTOUCHED";
          const arr = dead ? keptDead : keptLive;
          const arrY = dead ? deadY : liveY;
          const gap = dead ? DEAD_GAP_PX : DECLUTTER_GAP_PX;
          if (arr.length >= MAX_LEVELS) continue;
          let clash = false;
          for (let k = 0; k < arrY.length; k++) { if (Math.abs(arrY[k] - y) < gap) { clash = true; break; } }
          if (!clash) { arr.push(poi); arrY.push(y); }
        }
        const maxTags = Math.max(4, Math.floor((paneH - 4) / (TAG_H + TAG_GAP)));
        // Le declutter (keptLive/keptDead) ne decide QUE des LABELS a afficher
        // (anti-chevauchement de texte). Les LIGNES, elles, se dessinent TOUJOURS
        // pour TOUS les niveaux en vue : un niveau ne doit jamais etre masque en
        // entier selon le zoom -> sinon il "reapparait" en dezoomant (bug).
        const labelled = new Set(keptLive.slice(0, maxTags).map((p) => p.id));
        keptDead.forEach((p) => labelled.add(p.id));
        glowBudgetOK = shown.length <= 80;   // R4 : budget de lignes laser avec halo
        shown.sort((a, b) => rank(a) - rank(b));   // morts d'abord (labels ancres) puis vivants (colonne droite)
        const tags = [];
        const centeredPrices = new Set();
        for (const poi of shown) { const t = drawLevel(poi, plotW, now, labelled.has(poi.id), centeredPrices); if (t) tags.push(t); }
        // Le chip du PROVISOIRE entre dans l'empilement normal de la colonne
        // (tag ordinaire, caret vers sa ligne) : dessine apres coup en
        // s'esquivant, il derivait en cascade sous toute la pile des actifs.
        if (prov && (prov.score || 0) >= minScore && (!climaxOnly || prov.climax)) {
          const pe = prov.entry ?? prov.entryPrice;
          const py = pe != null ? gon.priceToY(pe) : null;
          if (py != null && isFinite(py) && py >= 0 && py <= paneH && Number.isFinite(prov.score))
            tags.push({ y: py, price: pe, score: "P·S" + prov.score,
              hue: PROV_HUE[prov.direction] || PROV_HUE.long, active: true, elite: false });
        }
        // Anti-doublon : un prix deja etiquete au centre (mort) ne reapparait pas
        // a droite — SAUF pour un ACTIF (actionnable) au meme prix, qui prime sur
        // le mort et garde son chip.
        drawTags(tags.filter((t) => t.active || !centeredPrices.has(t.price)), plotW, paneH);
        drawProvisional(plotW, paneH);
        drawWins(plotW, paneH, pLo, pHi, vis, now);
      } finally {
        ctx.restore();
      }
      lastGoodTf = gon.tf; lastGoodSym = gon.symbol;   // identite de l'image valide
      return true;   // frame dessinee avec succes
    }

    // ✦ VALIDES — regle de retest (long sur trait bleu, short sur trait
    // rouge ; SL 0.15 %, cible +1 % — verdict du backfill-outcome, SANS
    // notion de score). Losange dore au point exact du touch : la preuve
    // visuelle que le marche est venu servir le niveau et a paye. Dessine
    // dans toutes les vues, independant des filtres score/climax.
    const WIN_GOLD = "#d9b64d";
    function drawWins(plotW, paneH, pLo, pHi, vis, now) {
      // En REPLAY, le ✦ (verdict resolu des heures APRES le touch) est une
      // info future : on ne l'affiche pas pendant un entrainement.
      if (gon.replay) return;
      // 1re passe : collecter UNIQUEMENT les ✦ reellement dessinables (x/y
      // finis) — le compteur ne doit annoncer que ce qui est a l'ecran, et
      // les perdus dessinables comptent pour le %.
      const pts = [];
      let l = 0;
      for (const p of winIdx) {   // P2 : index des verdicts, pas le fichier entier
        const t = p.firstTouchTs ?? p.statusChangedTs;
        if (!t) continue;
        const sec = anchorSec(p, t);
        if (vis && (sec < vis.from || sec > vis.to)) continue;
        const e = p.entry ?? p.entryPrice;
        if (!(e >= pLo && e <= pHi)) continue;
        const x = gon.timeToX(sec), y = gon.priceToY(e);
        if (x == null || y == null || !isFinite(x) || !isFinite(y)) continue;
        if (p.win === 0) { l++; continue; }      // perdus : comptes, pas dessines
        pts.push({ x, y });
      }
      const w = pts.length;
      // Perf : le shadowBlur est rasterise CPU. Au-dela de ~60 losanges (vue
      // tres dezoomee), on coupe le glow (rendu plat, toujours dore et net)
      // pour ne pas payer des centaines de fills flous par frame.
      const glow = w > 0 && w <= 60, s = 4.5;
      ctx.save();
      if (glow) { ctx.shadowColor = WIN_GOLD; ctx.shadowBlur = 8; }
      ctx.fillStyle = "rgba(217,182,77,.9)";
      for (const pt of pts) {
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y - s); ctx.lineTo(pt.x + s, pt.y);
        ctx.lineTo(pt.x, pt.y + s); ctx.lineTo(pt.x - s, pt.y);
        ctx.closePath(); ctx.fill();
      }
      if (glow) ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,255,255,.95)";
      for (const pt of pts) { ctx.beginPath(); ctx.arc(pt.x, pt.y, 1.1, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      // compteur sobre : validations dessinables dans la fenetre affichee
      if (w + l > 0) {
        ctx.save();
        ctx.font = "600 10px Segoe UI";
        if (glow) { ctx.shadowColor = WIN_GOLD; ctx.shadowBlur = 6; }
        ctx.fillStyle = "rgba(217,182,77,.9)";
        // a droite de la ligne ATR de la legende (12,16 chevauchait le titre)
        ctx.fillText(`✦ ${w} validés · ${Math.round(100 * w / (w + l))}%`, 235, 79);
        ctx.restore();
      }
    }

    function tick() {
      if (destroyed) return;
      try {
        // deplacement d'ecran 1x <-> 2x sans changement de taille CSS : le
        // ResizeObserver ne tire pas, seul dpr change
        if ((window.devicePixelRatio || 1) !== dpr) size();
        const sig = viewSig();
        // Le repaint pulse (elites visibles) est plafonne a ~30 fps : une
        // sinusoide de ~2 s est indiscernable a 30 vs 60 images/s, et chaque
        // paint refait filtrage + declutter + passes laser.
        const now = performance.now();
        const pulseDue = hasEliteVisible && now - lastPulsePaint >= 33;
        if (forceDirty || sig !== lastSig || pulseDue) {
          // paint() renvoie false si l'echelle de prix n'etait pas prete
          // (transitoire) : on GARDE l'etat dirty pour retenter au tick suivant
          // au lieu de figer un canvas vide jusqu'au prochain changement de vue.
          if (paint() !== false) { forceDirty = false; lastSig = sig; lastPulsePaint = now; }
          else { forceDirty = true; }
        }
      } catch (error) {
        if (!tick.warned) { tick.warned = true; console.warn("[POI] erreur de rendu (boucle preservee)", error); }
      }
      rafId = requestAnimationFrame(tick);
    }

    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(size) : null;
    ro?.observe(host);
    size();
    rafId = requestAnimationFrame(tick);

    return {
      setPois(list) { pois = Array.isArray(list) ? list : []; reindex(); mark(); },
      setProvisional(p) { prov = p || null; mark(); },
      setRightInset(px) { rightInset = Math.max(0, Number(px) || 0); mark(); },
      setVisible(v) { visible = !!v; mark(); },
      setShowConsumed(v) { showConsumed = !!v; mark(); },
      setMinScore(v) { minScore = Math.max(0, Math.min(100, Number(v) || 0)); mark(); },
      setDeadMinScore(v) { deadMinScore = Math.max(0, Math.min(100, Number(v) || 0)); mark(); },
      setClimaxOnly(v) { climaxOnly = !!v; mark(); },
      repaint: mark,
      destroy() {
        destroyed = true;
        window.removeEventListener("gon:theme", onTheme);
        ro?.disconnect(); if (rafId) cancelAnimationFrame(rafId); cv.remove();
      }
    };
  }

  window.GonPoiRender = { create };
})();
