# PubTrans Minneapolis

A browser-only, street-network transit simulation covering downtown Minneapolis and the University of Minnesota's West and East Bank campuses. It follows the dependency-free Canvas and shortest-path approach of `pubtrans_15_minute_city`, replacing the fictional block grid with a frozen geographic street graph.

## Run the application

Serve the repository root over HTTP, then open the shown local URL:

```sh
python3 -m http.server 8000
# http://localhost:8000
```

No installation, build step, account, API key, runtime map tiles, backend, or geographic download is required. Opening `index.html` through `file://` is not supported because browsers restrict loading the JSON dataset from local files.

### Publish with GitHub Pages

The repository root is already a complete static site. Push or upload `index.html`, `styles.css`, `app.js`, `data/`, and the documentation files to the default branch. In the GitHub repository, open **Settings → Pages**, choose **Deploy from a branch**, select **main** and **/(root)**, then save. GitHub will build the Pages site and show its public URL; no build command or backend configuration is needed.

### Explore the map

- Starts fitted to the complete downtown and campus street network.
- Drag to pan; use the mouse wheel, pinch, or **+/−** controls to zoom continuously.
- Saved views jump to the entire area, Downtown, West Bank, or East Bank. **Fit** restores the startup extent.
- Click a vehicle to inspect its state, occupancy, destination, and distance; optionally follow it.
- Keyboard users can focus the map and use arrow keys to pan, **+/−** to zoom, and **0** to fit.
- Layer switches independently control roads, buildings, labels, water, and live traffic pressure.
- Named building labels appear as you zoom in, with collision-aware placement. Residence halls such as Frontier Hall are prioritized; apartments, townhomes, shops, campus, and workplace labels appear at closer zoom levels.

### Simulate and monitor the queue

All passenger requests are generated automatically. Vehicles use Dijkstra routing over the directed graph; congestion-aware routing adds live vehicle pressure to edge costs and can be disabled for free-flow routes.

A running graph beneath the map shows queued requests over the last 30 simulated minutes. Large digits show the current queue, while a dashed amber threshold and separate peak digits show the maximum queue reached during the current run. Resetting the service day clears the graph and peak.

The simulation includes sedans, shuttles, and buses with different capacities; pickup and drop-off states; queued requests; distance- and speed-based movement; and live wait, ride, completion, and pressure metrics. Sedan, shuttle, and bus counts adjust independently from 0–60 each, with live per-type and total counts in the fleet legend. Controls also adjust demand, playback speed, pause/resume, and reset. Fleet reductions return affected requests to the queue. Empty vehicles without a compatible dispatch automatically route to the **Central Transit Hub at Nicollet & 7th** and wait there; newly added vehicles also enter service from the hub. Every vehicle has a persistent numeric ID. Activity events identify the vehicle type and ID, including pickup party size and intended destination and arrival events.

### Signals, human drivers, and avoidance

Directed one-way streets constrain fleet and human routes. Timed synthetic signals at 686 selected intersections create red-light stops. Human drivers enter from the area boundary, route to a shop or workplace, dwell for an errand, and leave through a boundary exit. Their entry rate defaults to **20 cars/hour** and adjusts up to **200 cars/hour**. Human cars are orange on the map and contribute to traffic pressure.

Fleet and human vehicles use right-hand offsets within directed lanes. Same-lane traffic slows following vehicles and stops them at close following distance, while opposing and crossing streams are excluded from lane-following braking. Signalized intersections use single-agent reservations to prevent conflicting streams from entering together. Vehicles that remain stuck reroute and receive 15 seconds of temporary recovery priority so queues can discharge. The interface includes live fleet-yield and active-human counters. Lane geometry, signal timing, human demand, right-of-way, and recovery behavior are illustrative rather than calibrated field measurements.

Demand defaults to **120 requests/hour** and can be raised to **600 requests/hour (10/minute)**. Requests are distributed across 933 real named buildings rather than only the 14 map landmarks. Apartments, townhomes, shops, employers, campus buildings, and large dorms have distinct trip-generation weights. Frontier, Territorial, Centennial, Pioneer, Sanford, and 17th Avenue residence halls each generate dozens of hourly requests at maximum demand. Morning demand favors residential origins and campus/employment destinations; evening demand reverses that pattern. Amber rings show waiting pickups on the map.

Desktop uses a three-column operational workspace. At narrower widths the map and controls stack, with panel shortcuts and touch-friendly controls. The interface supports 375–430px mobile viewports without horizontal overflow.

## Frozen geographic data

`data/minneapolis.json` contains:

- 22,645 projected graph nodes and 24,768 directed base street segments
- 8,615 building footprints
- 14 snapped, mutually reachable map landmarks
- 933 connected, building-weighted demand locations, including six large campus dorms
- A 512.1 km directed street network
- Local meter coordinates, street names, road classes, default speeds, source timestamps, labels, and approximate water geometry

The browser reads only this checked-in file. It does not contact OpenStreetMap or any external map service.

### Rebuild and validate

Python 3.10+ is sufficient; no packages are required.

```sh
python3 scripts/prepare_data.py --download
python3 tests/validate_data.py
```

The importer downloads the OSM-derived compact extracts listed in `CREDITS.md`, clips them to `44.962,-93.287,44.997,-93.213`, projects coordinates to meters, constructs the largest strongly connected road component, and snaps destinations. Existing local extracts can be supplied with `--roads` and `--buildings`.

The standard-library test suite checks schema and counts, edge references, destination reachability in both directions, demand-building connectivity and land-use coverage, high-volume dorm weighting, and a sensible West Bank–Northrop route.

## Implementation

- `index.html` — semantic application shell, controls, and guide
- `styles.css` — responsive operational interface
- `app.js` — Canvas renderer, camera, directed Dijkstra router, requests, vehicles, and UI state
- `scripts/prepare_data.py` — reproducible offline data importer
- `tests/validate_data.py` — geographic graph validation

Roads use viewport culling and level-of-detail rendering. The camera uses device-pixel-ratio-aware Canvas transforms. Simulation movement is independent of camera zoom and uses fixed time steps.

## Accuracy boundary

Street and building geometry is data-derived. Local street direction defaults and speeds are illustrative assumptions, not a verified municipal traffic rule set. Demand, fleet behavior, congestion pressure, signal placement/timing, human-driver behavior, and operations are synthetic. River geometry is a cartographic approximation. This is an illustrative simulation, not a navigation service or calibrated municipal traffic forecast. See `data/minneapolis.json` for source timestamps and assumptions.

## License and attribution

Map data © OpenStreetMap contributors, available under ODbL 1.0. Source details are in `CREDITS.md`. The frozen derived dataset retains ODbL share-alike terms. No source application code or visual assets were copied from the conceptual reference repository.
