# Satellite Passes Above Your Home

## Running the project

Serve the files with a small local server (`fetch` calls to CelesTrak/Nominatim are more reliable this way than opening the file directly with `file://`):

```bash
cd project-folder
python3 -m http.server 8000
```

Then open `http://localhost:8000/index.html` in your browser.

No API key needed (CelesTrak, Nominatim, and the Esri tiles are all free to use).

## How it works

1. **Geocoding**: the address is converted to lat/lon via Nominatim (OpenStreetMap).
2. **Fetching orbital elements (TLE)**: several CelesTrak groups are combined (`active`, `stations`, `tle-new`, + the main debris clouds) to approximate a "full catalog". CelesTrak doesn't expose a single, anonymous feed of the entire SATCAT (~30,000+ objects, including the very latest) — combining groups this way is a reasonable approximation without a Space-Track account.
3. **Nationality**: cross-referenced from CelesTrak's plain-text SATCAT (`pub/satcat.txt`) by NORAD number. The field isn't always present for the most recently launched objects.
4. **Function**: a heuristic classification by name/group (communications, weather, navigation, debris, rocket body...) — CelesTrak doesn't provide a structured "function" field for the whole catalog.
5. **Pass detection**: in a Web Worker, for every satellite whose inclination allows it to reach your latitude, the distance to the center of the square is sampled across the whole day (SGP4 via `satellite.js`), then refined with a ternary search around each local minimum to check whether the pass truly enters the 500m square.
6. **Rare, and that's expected**: the square is small. Some days there may be only a handful of passes, or none at all in "Active only" mode. "Full catalog" mode finds more (debris included).

## Settings available in the interface

- **Catalog scope**: Active only (faster) vs Full catalog + debris (richer, slower on the first computation).
- **Search resolution**: controls the coarse sampling step before refinement (Fast/Standard/Precise) — a speed vs. risk-of-missing-a-brief-pass trade-off.

## Known limitations

- No Space-Track authentication: the catalog is an approximation (~15-20k objects) rather than the official ~30k+.
- The "function" classification is a heuristic, not an authoritative database.
- The first computation can take a while (tens of seconds) depending on your machine and the chosen mode — a progress bar shows this.
