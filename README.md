# Satellite Passes Over Your Home

## Running the Project

The files must be served through a small local server (the `fetch` requests to CelesTrak/Nominatim are more reliable this way than when opening the file directly with `file://`):

```bash
git clone https://github.com/charpignyn/flyover-tracker.git flyover-tracker 
cd flyover-tracker
python -m http.server 8000
```

Then open http://localhost:8000/index.html in your browser.

No API key is required (CelesTrak, Nominatim, and Esri tiles are freely accessible).

## How It Works

1. **Geocoding**: the address is converted to latitude/longitude coordinates via Nominatim (OpenStreetMap).
2. **Retrieving orbital elements (TLEs)**: several CelesTrak groups are combined (`active`, `stations`, `tle-new`, plus the main debris clouds) to approximate a "complete catalog". CelesTrak does not provide a single anonymous feed containing the entire SATCAT (~30,000+ objects, including the most recent ones) — this combination of groups is a reasonable approximation without a Space-Track account.
3. **Nationality**: cross-referenced from CelesTrak's SATCAT text file (`pub/satcat.txt`), using the NORAD number. This field is not always available for the most recent objects.
4. **Function**: heuristic classification based on the name/group (communications, weather, navigation, debris, rocket body, etc.) — CelesTrak does not provide a structured "function" field for the entire catalog.
5. **Pass detection**: in a Web Worker, for each satellite whose inclination allows it to reach your latitude, the distance to the center of the square is sampled throughout the day (SGP4 via `satellite.js`), then refined using a ternary search around each local minimum to determine whether the satellite actually enters the 500 m square.
6. **Rare, and that's normal**: the square is small. On some days there may be only a few passes, or none at all when using "Active Only" mode. The "Complete Catalog" mode finds more passes (including debris).

## Available Interface Settings

- **Catalog scope**: Active Only (fast) vs. Complete Catalog + Debris (richer, slower on the first calculation).
- **Search resolution**: controls the coarse sampling step before refinement (Fast/Standard/Precise) — a trade-off between speed and the risk of missing a very brief pass.

## Known Limitations

- No Space-Track authentication: the catalog is an approximation (~15–20k objects) rather than the ~30k+ official objects.
- The "function" classification is heuristic, not an authoritative database.
- The first calculation may take a while (several tens of seconds) depending on the machine and selected mode — a progress bar indicates the progress.