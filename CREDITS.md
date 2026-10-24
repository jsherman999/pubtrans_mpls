# Credits

## Geographic data

- **OpenStreetMap contributors** — road and building source data, ODbL 1.0: https://www.openstreetmap.org/copyright
- **Osyanne/CitiesSkylines2-osm-toolkit** — compact Minneapolis OSM-derived road and building extracts used as importer inputs: https://github.com/Osyanne/CitiesSkylines2-osm-toolkit
- Road input: `visualizer/cities/minneapolis/datos_vial.json` (source extract generated 2026-05-20)
- Building input: `visualizer/cities/minneapolis/datos_zonificacion.json` (source extract generated 2026-10-01)

No source application's code or visual assets are copied. The preparation script reads the published data format and produces a new compact graph and rendering dataset. The resulting geographic database remains subject to ODbL 1.0, including attribution and share-alike requirements.

## Simulation inspiration

Architecture is informed by `jsherman999/pubtrans_15_minute_city`, but this implementation uses a new Minneapolis-specific data pipeline and application.
