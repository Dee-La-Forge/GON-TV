/* G-ON — rendu POI sur canvas jumeau, aligne sur le chart Lightweight Charts de
 * G-Bot via ses convertisseurs natifs (series.priceToCoordinate + xOf).
 * Passe de design finale (spec DA) :
 * - hues directionnelles IMMUABLES : long #2f8bff / short #ff2d5e, seul alpha varie ;
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

  const HUE = { long: [47, 139, 255], short: [255, 45, 94] };   // IMMUABLE
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
  const W = { active: 0.75, touched: 0.75, dead: 0.75, casingExtra: 1.5 };   // traits fins (spec)
  const DASH = { active: null, touched: [7, 4], dead: [1.5, 3.5] };
  const TAG_H = 16, TAG_GAP = 3, MAX_LEVELS = 300, DECLUTTER_GAP_PX = 8;
  // Niveaux d'ELITE (S >= seuil) : laser DORE (charte G-Bot) au lieu du laser
  // directionnel — les meilleurs scores se reperent d'un coup d'oeil.
  const ELITE_SCORE = 90;
  const DEAD_GAP_PX = TAG_H + 3;   // chips morts centres : jamais de chevauchement
  const PRICE_FONT = "600 10px Consolas, 'Roboto Mono', monospace";
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
    // Reserve a droite (panneau FLUX au-dessus du chart) : les LIGNES passent
    // sous le verre (transparence voulue), seuls les chips se decalent.
    let rightInset = 0;
    let rafId = 0, lastSig = null, forceDirty = true, destroyed = false;
    // Pulsation discrete des ELITES : phase temporelle appliquee a leur glow.
    // hasEliteVisible arme le repaint continu ; sans elite a l'ecran, la
    // boucle reste purement dirty-based (zero repaint inutile).
    let pulseK = 1, hasEliteVisible = false, lastPulsePaint = 0;
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
    const onTheme = () => { computeTheme(); mark(); };
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
      const startSec = snapToBarSec(poi.createdTs);
      const active = poi.status === "ACTIVE_UNTOUCHED";
      // Fallback aligne sur drawLevel (endMs ?? now) : un POI mort sans champ
      // de touche est DESSINE jusqu'a maintenant — le culler a createdTs le
      // ferait disparaitre des qu'on scrolle sa bougie de naissance hors ecran.
      const endSec = active ? now / 1000 : snapToBarSec(poi.firstTouchTs ?? poi.statusChangedTs ?? now);
      return startSec <= vis.to && Math.max(endSec, startSec) >= vis.from;
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
      // TF mensuels : bougies calendaires, aucune grille fixe -> pas de snap
      // (l'interpolation reste correcte au bucket pres).
      if (s >= 2419200) return t;
      // Semaines : la grille G-Bot est ancree LUNDI (W0 = 345600), pas sur
      // l'epoch — un floor epoch snapperait au jeudi, une barre trop tot.
      if (s % 604800 === 0) return Math.floor((t - 345600) / s) * s + 345600;
      return Math.floor(t / s) * s;
    }

    function drawLevel(poi, plotW, now, wantLabel, centeredPrices) {
      const entryPrice = poi.entry ?? poi.entryPrice;
      const yEntry = entryPrice == null ? null : gon.priceToY(entryPrice);
      const oppPrice = poi.direction === "long" ? poi.zoneHigh : poi.zoneLow;
      const yOpp = oppPrice == null ? null : gon.priceToY(oppPrice);
      if (yEntry == null && yOpp == null) return null;
      let x1 = gon.timeToX(snapToBarSec(poi.createdTs));
      if (x1 == null || !isFinite(x1)) x1 = gon.timeToX(snapToBarSec(poi.availableAt));
      if (x1 == null || !isFinite(x1)) return null;

      const active = poi.status === "ACTIVE_UNTOUCHED";
      const touched = poi.status === "TOUCHED";
      const endMs = active ? now : (poi.firstTouchTs ?? poi.statusChangedTs ?? now);
      let x2 = active ? plotW : gon.timeToX(snapToBarSec(endMs));
      if (x2 == null || !isFinite(x2)) x2 = plotW;
      const left = Math.max(0, x1);
      const right = Math.min(plotW, Math.max(x2, x1 + 2));
      if (right <= 0 || left >= plotW) return null;

      const hue = HUE[poi.direction] || HUE.long;
      const y = yEntry != null ? yEntry : yOpp;
      const lineAlpha = active ? ALPHA.lineActive : touched ? ALPHA.lineTouched : T.lineDeadAlpha;
      const width = active ? W.active : touched ? W.touched : W.dead;
      const dash = active ? DASH.active : touched ? DASH.touched : DASH.dead;
      // Laser : plein feu sur les actifs, discret sur les touches, eteint sur
      // les morts. Le laser reste DIRECTIONNEL (bleu/rouge) pour tous — les
      // elites (S>=90) tirent un fluo PLUS INTENSE (pas d'or sur la ligne :
      // lisibilite long/short d'abord) ; leur or vit sur pastille + chip.
      const elite = active && Number(poi.score) >= ELITE_SCORE;
      if (elite) hasEliteVisible = true;
      const glowScale = elite ? 1.7 * pulseK : active ? 1 : touched ? 0.45 : 0;
      const lw = elite ? width + 0.75 : width;   // trait elite plus epais : hierarchie au premier regard
      laserHline(left, right, y, lw, hue, lineAlpha, dash, glowScale, elite);

      const ySnap = Math.round(y) + 0.5;
      // Point d'ORIGINE (bougie source) : disque chaud + anneau de gainage
      if (x1 >= 0 && x1 <= plotW) {
        if (glowScale > 0) { ctx.shadowColor = rgba(hue, 0.9); ctx.shadowBlur = 10 * glowScale; }
        ctx.beginPath(); ctx.arc(x1, ySnap, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = glowScale > 0 ? rgba(tint(hue, 0.45), lineAlpha) : rgba(hue, lineAlpha);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5; ctx.strokeStyle = T.casing; ctx.stroke();
      }
      // Point de RETEST (touche) : cercle creux — plein = naissance, creux = retour
      if (touched && right > 0 && right < plotW) {
        ctx.beginPath(); ctx.arc(right, ySnap, 3, 0, Math.PI * 2);
        ctx.fillStyle = T.casing; ctx.fill();
        ctx.lineWidth = 1.25; ctx.strokeStyle = rgba(hue, 0.9); ctx.stroke();
      }
      // Terminator de niveau MORT : tick vertical net "consomme ici"
      if (!active && !touched && x2 > 0 && x2 < plotW) {
        ctx.save(); ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.moveTo(Math.round(x2) + 0.5, ySnap - 3); ctx.lineTo(Math.round(x2) + 0.5, ySnap + 3);
        ctx.strokeStyle = rgba(hue, T.lineDeadAlpha); ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }

      if (!Number.isFinite(poi.score) || !wantLabel) return null;
      const price = entryPrice != null ? entryPrice : oppPrice;
      // (elite est reporte sur le chip de droite via une pastille or)
      if (!active) {
        // Niveaux NON-ACTIFS (touches + consommes) : label centre sur la ligne.
        // La colonne de droite est reservee aux ACTIFS, et un prix deja etiquete
        // au centre n'est PAS re-etiquete a droite (anti-doublon de prix).
        // Pas de chip si le segment VISIBLE est plus court que lui : un label
        // clampe au bord sans ligne dessous se lit comme un niveau "flottant".
        const cw = chipWidth(price, poi.score);
        if (right - left < cw + 8) return null;
        const cx = Math.min(plotW - rightInset - cw / 2 - 2, Math.max(cw / 2 + 2, (left + right) / 2));
        drawChip(Math.round(cx - cw / 2), Math.round(y - TAG_H / 2), price, poi.score, hue, touched ? "touched" : "dead", cw);
        if (centeredPrices) centeredPrices.add(price);
        return null;
      }
      return { y, price, score: poi.score, hue, active, elite };
    }

    function fmtPrice(p) {
      if (!Number.isFinite(p)) return "";
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
      ctx.moveTo(Math.round(xSep) + 0.5, py + 4); ctx.lineTo(Math.round(xSep) + 0.5, py + 12);
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
      let x1 = gon.timeToX(snapToBarSec(p.createdTs));
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
      ctx.clearRect(0, 0, cv.width, cv.height);
      // Remis AVANT les early-returns : sinon la boucle pulse continue de
      // repeindre un canvas masque/vide a ~30fps toute la session.
      hasEliteVisible = false;
      if (!visible || (!pois.length && !prov)) return;
      let axisH = 0;
      try { axisH = (typeof gon.ts().height === "function" ? gon.ts().height() : 0) || 0; } catch (_) {}
      const paneH = Math.max(1, cv.height / dpr - axisH);
      let pLo = -Infinity, pHi = Infinity;
      try {
        const a = gon.series.coordinateToPrice(0), b = gon.series.coordinateToPrice(paneH);
        if (a != null && b != null) { pHi = Math.max(a, b); pLo = Math.min(a, b); }
      } catch (_) {}
      if (!isFinite(pLo) || !isFinite(pHi)) return;
      const plotW = (typeof gon.ts().width === "function" ? gon.ts().width() : cv.width / dpr) || cv.width / dpr;
      const now = Date.now();
      // Battement MAXIMAL (~2 s, +/-80%) : au creux le halo elite retombe
      // SOUS celui d'un actif standard (attenue, jamais tout a fait eteint),
      // au pic il s'embrase — l'epaisseur du trait reste le socle de
      // hierarchie au creux.
      pulseK = 1.0 + 0.80 * Math.sin(now * 0.0031);
      const vis = visibleRangeSec();
      ctx.save();
      try {
        ctx.scale(dpr, dpr);
        ctx.beginPath(); ctx.rect(0, 0, plotW, paneH); ctx.clip();
        let shown = [];
        for (const poi of pois) {
          if (climaxOnly && !poi.climax) continue;   // vue climax : bougies a volume dominant
          if ((poi.score || 0) < minScore) continue;
          if (!showConsumed && poi.status !== "ACTIVE_UNTOUCHED") continue;
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
          const dead = rank(poi) === 0;
          const arr = dead ? keptDead : keptLive;
          const arrY = dead ? deadY : liveY;
          const gap = dead ? DEAD_GAP_PX : DECLUTTER_GAP_PX;
          if (arr.length >= MAX_LEVELS) continue;
          let clash = false;
          for (let k = 0; k < arrY.length; k++) { if (Math.abs(arrY[k] - y) < gap) { clash = true; break; } }
          if (!clash) { arr.push(poi); arrY.push(y); }
        }
        const maxTags = Math.max(4, Math.floor((paneH - 4) / (TAG_H + TAG_GAP)));
        const labelled = new Set(keptLive.slice(0, maxTags).map((p) => p.id));
        keptDead.forEach((p) => labelled.add(p.id));
        shown = keptDead.concat(keptLive);
        shown.sort((a, b) => rank(a) - rank(b));   // non-actifs d'abord : leurs prix centres sont connus avant les tags
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
        // Anti-doublon : un prix deja etiquete au centre ne reapparait pas a droite.
        drawTags(tags.filter((t) => !centeredPrices.has(t.price)), plotW, paneH);
        drawProvisional(plotW, paneH);
        drawWins(plotW, paneH, pLo, pHi, vis, now);
      } finally {
        ctx.restore();
      }
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
      for (const p of pois) {
        if (p.win !== 1 && p.win !== 0) continue;
        const t = p.firstTouchTs ?? p.statusChangedTs;
        if (!t) continue;
        const sec = snapToBarSec(t);
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
          paint();
          // commit APRES un paint reussi : une exception laisse l'etat dirty
          // et la frame se retente au tick suivant au lieu de figer une frame
          // partiellement dessinee.
          forceDirty = false; lastSig = sig; lastPulsePaint = now;
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
      setPois(list) { pois = Array.isArray(list) ? list : []; mark(); },
      setProvisional(p) { prov = p || null; mark(); },
      setRightInset(px) { rightInset = Math.max(0, Number(px) || 0); mark(); },
      setVisible(v) { visible = !!v; mark(); },
      setShowConsumed(v) { showConsumed = !!v; mark(); },
      setMinScore(v) { minScore = Math.max(0, Math.min(100, Number(v) || 0)); mark(); },
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
