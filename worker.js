importScripts('https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js');

const R_EARTH = 6371000; // Mean Earth radius in meters.

/**
 * Convert degrees to radians.
 * @param {number} d - Angle in degrees.
 * @returns {number} Angle in radians.
 */
function toRad(d) { return (d * Math.PI) / 180; }

/**
 * Compute local offset (dx, dy) in meters between a point (lat, lon) and the home position,
 * using an equirectangular approximation (local plane projection).
 * Valid only for small distances (up to tens of kilometers), which is more than sufficient here
 * since we only care about passes within ~25 km of home.
 * @param {number} lat - Latitude of the point to convert (degrees).
 * @param {number} lon - Longitude of the point to convert (degrees).
 * @param {number} homeLat - Latitude of the home reference point (degrees).
 * @param {number} homeLon - Longitude of the home reference point (degrees).
 * @returns {{dx: number, dy: number}} East-west (dx) and north-south (dy) offset in meters.
 */
function localDelta(lat, lon, homeLat, homeLon) {
  const dx = toRad(lon - homeLon) * R_EARTH * Math.cos(toRad(homeLat));
  const dy = toRad(lat - homeLat) * R_EARTH;
  return { dx, dy };
}

/**
 * Propagate a satellite (SGP4) at a given time and compute its ground distance from the
 * home position. This is the core function called at each time sample, both during the
 * coarse sweep and during fine refinement.
 * @param {Object} satrec - Satellite record from satellite.twoline2satrec().
 * @param {Date} date - Time at which to evaluate the satellite's position.
 * @param {number} homeLat - Latitude of the home reference point (degrees).
 * @param {number} homeLon - Longitude of the home reference point (degrees).
 * @returns {{d: number, dx: number, dy: number, alt: number, lat: number, lon: number}}
 *   Ground distance in meters (d), east-west/north-south offsets (dx, dy), altitude (alt, km),
 *   and geodetic position of the nadir point (lat, lon in degrees). If propagation fails
 *   (decayed satellite, numerical error, etc.), an infinite distance is returned.
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
 * Refine the exact moment of closest approach (distance minimum) using a ternary search,
 * within an interval where a local minimum was already detected by the coarse sweep.
 * The distance(t) function is assumed to be unimodal over this small interval
 * (single minimum, monotonically decreasing then increasing), a reasonable assumption since
 * the interval spans only 2 coarse steps around the detected minimum.
 * @param {Object} satrec - Satellite record from satellite.twoline2satrec().
 * @param {number} loMs - Lower bound of the search interval (timestamp ms).
 * @param {number} hiMs - Upper bound of the search interval (timestamp ms).
 * @param {number} homeLat - Latitude of the home reference point (degrees).
 * @param {number} homeLon - Longitude of the home reference point (degrees).
 * @param {number} iterations - Number of ternary search iterations (precision of result).
 * @returns {{t: number, d: number, dx: number, dy: number, alt: number, lat: number, lon: number}}
 *   Time of the minimum found (t) and the complete state of distanceAt() at that instant.
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
 * puis calcule pour chaque satellite s'il traverse une (ou les deux) boîtes concentriques
 * autour du domicile au cours de la fenêtre temporelle donnée (typiquement la journée en cours).
 *
 * Algorithme en deux temps par satellite :
 *  1. Balayage grossier : distance(t) échantillonnée par pas de `coarseStepMs` sur toute la
 *     fenêtre, pour repérer les minima locaux sous le seuil `candidateThresholdM`.
 *  2. Raffinement fin : recherche ternaire (refineMin) autour de chaque minimum repéré, pour
 *     obtenir l'instant précis du passage au plus près et vérifier s'il entre réellement
 *     dans l'une des deux boîtes (test sur dx/dy par rapport à innerBoxHalfWidthM et outerBoxHalfWidthM).
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
 *   @param {number} e.data.innerBoxHalfWidthM - Demi-largeur de la boîte interne (m).
 *   @param {number} e.data.outerBoxHalfWidthM - Demi-largeur de la boîte externe (m).
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
    innerBoxHalfWidthM,
    outerBoxHalfWidthM,
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

    // Pre-filter: a satellite cannot reach a latitude higher than its orbital inclination
    // (with a small margin for numerical imprecision).
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

        const inInner = Math.abs(refined.dx) <= innerBoxHalfWidthM && Math.abs(refined.dy) <= innerBoxHalfWidthM;
        const inOuter = Math.abs(refined.dx) <= outerBoxHalfWidthM && Math.abs(refined.dy) <= outerBoxHalfWidthM;

        if (inInner || inOuter) {
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
            boxType: inInner ? 'inner' : 'outer',
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
