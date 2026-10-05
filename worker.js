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
 * Entry point of the worker: receives the TLE catalog and search parameters,
 * then computes for each satellite whether it passes through the detection box
 * centered on the home location during the given time window (typically the current day).
 *
 * Two-phase algorithm per satellite:
 *  1. Coarse sweep: distance(t) sampled every `coarseStepMs` across the entire
 *     window to identify local minima below the threshold `candidateThresholdM`.
 *  2. Fine refinement: ternary search (refineMin) around each detected minimum
 *     to obtain the precise moment of closest approach and verify whether the
 *     pass actually enters the detection box (test dx/dy against boxHalfWidthM).
 *
 * An orbital inclination pre-filter eliminates upfront satellites that cannot
 * physically reach the target latitude, before any propagation computation.
 *
 * Progress updates are sent regularly via postMessage({type:'progress', ...}),
 * final results are sent via postMessage({type:'done', results, skippedByInclination}).
 *
 * @param {MessageEvent} e - Message received, with e.data containing:
 *   @param {Array<{name:string, line1:string, line2:string, catnr:string, func:string}>} e.data.tles
 *     Satellite catalog to test (raw TLEs + metadata already computed on the main page).
 *   @param {number} e.data.homeLat - Home location latitude (degrees).
 *   @param {number} e.data.homeLon - Home location longitude (degrees).
 *   @param {number} e.data.windowStartMs - Start of search window (timestamp ms).
 *   @param {number} e.data.windowEndMs - End of search window (timestamp ms).
 *   @param {number} e.data.coarseStepMs - Coarse sweep sampling step (ms).
 *   @param {number} e.data.candidateThresholdM - Distance (m) below which a local
 *     minimum from the coarse sweep triggers fine refinement.
 *   @param {number} e.data.boxHalfWidthM - Half-width of the detection box (m); 10000 for a 20km square.
 *   @param {Object<string,string>} e.data.countryMap - NORAD number → country code map (from SATCAT).
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
