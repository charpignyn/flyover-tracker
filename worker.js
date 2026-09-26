importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');

const R_EARTH = 6371000; // rayon terrestre moyen, en mètres

/**
 * Convertit des degrés en radians.
 * @param {number} d - Angle en degrés.
 * @returns {number} Angle en radians.
 */
function toRad(d) { return (d * Math.PI) / 180; }

/**
 * Calcule le décalage local (dx, dy) en mètres entre un point (lat, lon) et la position
 * "domicile", par approximation équirectangulaire (projection plane locale).
 * Valable uniquement pour de petites distances (jusqu'à quelques dizaines de km), ce qui est
 * largement suffisant ici puisqu'on ne s'intéresse qu'aux passages à moins de 25 km du domicile.
 * @param {number} lat - Latitude du point à convertir (degrés).
 * @param {number} lon - Longitude du point à convertir (degrés).
 * @param {number} homeLat - Latitude du point de référence "domicile" (degrés).
 * @param {number} homeLon - Longitude du point de référence "domicile" (degrés).
 * @returns {{dx: number, dy: number}} Décalage est-ouest (dx) et nord-sud (dy) en mètres.
 */
function localDelta(lat, lon, homeLat, homeLon) {
  const dx = toRad(lon - homeLon) * R_EARTH * Math.cos(toRad(homeLat));
  const dy = toRad(lat - homeLat) * R_EARTH;
  return { dx, dy };
}

/**
 * Propage un satellite (SGP4) à un instant donné et calcule sa distance au sol par rapport
 * au point "domicile". C'est la fonction de base appelée à chaque échantillon temporel,
 * aussi bien pendant le balayage grossier que pendant le raffinement fin.
 * @param {Object} satrec - Enregistrement satellite issu de satellite.twoline2satrec().
 * @param {Date} date - Instant auquel évaluer la position du satellite.
 * @param {number} homeLat - Latitude du point de référence (degrés).
 * @param {number} homeLon - Longitude du point de référence (degrés).
 * @returns {{d: number, dx: number, dy: number, alt: number, lat: number, lon: number}}
 *   Distance au sol en mètres (d), décalages est-ouest/nord-sud (dx, dy), altitude (alt, km),
 *   et position géodésique du point nadir (lat, lon en degrés). Si la propagation échoue
 *   (satellite décayé, erreur numérique...), une distance infinie est renvoyée.
 */
function distanceAt(satrec, date, homeLat, homeLon) {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') {
    return { d: Infinity, dx: 0, dy: 0, alt: 0, lat: 0, lon: 0 };
  }
  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  const lat = satellite.degreesLat(geo.latitude);
  const lon = satellite.degreesLong(geo.longitude);
  const { dx, dy } = localDelta(lat, lon, homeLat, homeLon);
  return { d: Math.sqrt(dx * dx + dy * dy), dx, dy, alt: geo.height, lat, lon };
}

/**
 * Affine l'instant de passage au plus près (minimum de distance) par recherche ternaire,
 * à l'intérieur d'un intervalle où un minimum local a déjà été repéré par l'échantillonnage
 * grossier. La fonction distance(t) est supposée unimodale sur ce petit intervalle
 * (un seul minimum, décroissante puis croissante), hypothèse raisonnable puisque l'intervalle
 * ne couvre que 2 pas d'échantillonnage grossier autour du minimum détecté.
 * @param {Object} satrec - Enregistrement satellite issu de satellite.twoline2satrec().
 * @param {number} loMs - Borne basse de l'intervalle de recherche (timestamp ms).
 * @param {number} hiMs - Borne haute de l'intervalle de recherche (timestamp ms).
 * @param {number} homeLat - Latitude du point de référence (degrés).
 * @param {number} homeLon - Longitude du point de référence (degrés).
 * @param {number} iterations - Nombre d'itérations de la recherche ternaire (précision du résultat).
 * @returns {{t: number, d: number, dx: number, dy: number, alt: number, lat: number, lon: number}}
 *   Instant du minimum trouvé (t) et l'état complet de distanceAt() à cet instant.
 */
function refineMin(satrec, loMs, hiMs, homeLat, homeLon, iterations) {
  let lo = loMs;
  let hi = hiMs;
  for (let i = 0; i < iterations; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const d1 = distanceAt(satrec, new Date(m1), homeLat, homeLon).d;
    const d2 = distanceAt(satrec, new Date(m2), homeLat, homeLon).d;
    if (d1 < d2) hi = m2; else lo = m1;
  }
  const tMid = (lo + hi) / 2;
  const res = distanceAt(satrec, new Date(tMid), homeLat, homeLon);
  return { t: tMid, ...res };
}

/**
 * Point d'entrée du worker : reçoit le catalogue de TLE et les paramètres de recherche,
 * puis calcule pour chaque satellite s'il traverse le carré 500x500m autour du domicile
 * au cours de la fenêtre temporelle donnée (typiquement la journée en cours).
 *
 * Algorithme en deux temps par satellite :
 *  1. Balayage grossier : distance(t) échantillonnée par pas de `coarseStepMs` sur toute la
 *     fenêtre, pour repérer les minima locaux sous le seuil `candidateThresholdM`.
 *  2. Raffinement fin : recherche ternaire (refineMin) autour de chaque minimum repéré, pour
 *     obtenir l'instant précis du passage au plus près et vérifier s'il entre réellement
 *     dans le carré (test sur dx/dy par rapport à `boxHalfWidthM`).
 *
 * Un pré-filtre sur l'inclinaison orbitale élimine d'emblée les satellites qui ne peuvent
 * physiquement pas atteindre la latitude du domicile, avant tout calcul de propagation.
 *
 * Progression envoyée régulièrement via postMessage({type:'progress', ...}), résultat final
 * envoyé via postMessage({type:'done', results, skippedByInclination}).
 *
 * @param {MessageEvent} e - Message reçu, avec e.data contenant :
 *   @param {Array<{name:string, line1:string, line2:string, catnr:string, func:string}>} e.data.tles
 *     Catalogue de satellites à tester (TLE brutes + métadonnées déjà calculées côté page principale).
 *   @param {number} e.data.homeLat - Latitude du domicile (degrés).
 *   @param {number} e.data.homeLon - Longitude du domicile (degrés).
 *   @param {number} e.data.windowStartMs - Début de la fenêtre de recherche (timestamp ms).
 *   @param {number} e.data.windowEndMs - Fin de la fenêtre de recherche (timestamp ms).
 *   @param {number} e.data.coarseStepMs - Pas d'échantillonnage du balayage grossier (ms).
 *   @param {number} e.data.candidateThresholdM - Distance (m) sous laquelle un minimum local
 *     du balayage grossier déclenche un raffinement fin.
 *   @param {number} e.data.boxHalfWidthM - Demi-largeur du carré à détecter (m) ; 250 pour un
 *     carré de 500m de côté.
 *   @param {Object<string,string>} e.data.countryMap - Table numéro NORAD -> code pays (SATCAT).
 */
self.onmessage = function (e) {
  const {
    tles,
    homeLat,
    homeLon,
    windowStartMs,
    windowEndMs,
    coarseStepMs,
    candidateThresholdM,
    boxHalfWidthM,
    countryMap,
  } = e.data;

  const results = [];
  const total = tles.length;
  let processed = 0;
  let skippedByInclination = 0;

  for (const sat of tles) {
    let satrec;
    try {
      satrec = satellite.twoline2satrec(sat.line1, sat.line2);
    } catch (err) {
      processed++;
      continue;
    }

    // Pré-filtre : un satellite ne peut survoler une latitude supérieure à son inclinaison
    // (avec une petite marge pour les imprécisions numériques)
    const incDeg = (satrec.inclo * 180) / Math.PI;
    if (incDeg < Math.abs(homeLat) - 2) {
      skippedByInclination++;
      processed++;
      continue;
    }

    const nSteps = Math.floor((windowEndMs - windowStartMs) / coarseStepMs);
    const distances = new Float64Array(nSteps + 1);
    for (let i = 0; i <= nSteps; i++) {
      const t = windowStartMs + i * coarseStepMs;
      distances[i] = distanceAt(satrec, new Date(t), homeLat, homeLon).d;
    }

    for (let i = 1; i < nSteps; i++) {
      if (
        distances[i] < distances[i - 1] &&
        distances[i] < distances[i + 1] &&
        distances[i] < candidateThresholdM
      ) {
        const loMs = windowStartMs + (i - 1) * coarseStepMs;
        const hiMs = windowStartMs + (i + 1) * coarseStepMs;
        const refined = refineMin(satrec, loMs, hiMs, homeLat, homeLon, 28);

        if (Math.abs(refined.dx) <= boxHalfWidthM && Math.abs(refined.dy) <= boxHalfWidthM) {
          results.push({
            catnr: sat.catnr,
            name: sat.name,
            line1: sat.line1,
            line2: sat.line2,
            func: sat.func,
            t: refined.t,
            dx: refined.dx,
            dy: refined.dy,
            alt: refined.alt,
            lat: refined.lat,
            lon: refined.lon,
            country: countryMap[sat.catnr] || null,
          });
        }
      }
    }

    processed++;
    if (processed % 300 === 0) {
      self.postMessage({ type: 'progress', processed, total });
    }
  }

  results.sort((a, b) => a.t - b.t);
  self.postMessage({ type: 'done', results, skippedByInclination });
};
