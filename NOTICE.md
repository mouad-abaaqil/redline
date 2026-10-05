# Notice

## Licenses of this repository

| Content | License |
| --- | --- |
| Firmware, software, simulation, drawing generators | MIT, see `LICENSE` |
| Hardware design: `hardware/`, `cad/` models and plans | CERN-OHL-P v2 (permissive), see `LICENSE-HARDWARE.txt` |

## Data and third-party material

- **Road geometry and speeds** (`simulation/data/route-*.json`): OpenStreetMap contributors, Open Database License (ODbL) 1.0, https://www.openstreetmap.org/copyright. Routed by the public OSRM demo server. The snapshot is stored with its retrieval date.
- **Weather** (`simulation/data/weather.json`): Open-Meteo.com, data under CC BY 4.0, https://open-meteo.com/en/about. Attribution: "Weather data by Open-Meteo.com".
- **Map tiles in the dashboard**: OpenStreetMap contributors, loaded at run time.
- **Leaflet** (BSD-2-Clause) and **Vite** (MIT) are dependencies of the dashboard.
- **build123d** (Apache-2.0) generates the CAD files.
- The **logo** is generated from a system font by `branding/generate.py` and drawn as outlines. Rebuild it with a font whose license allows it.

Component names (Nordic Semiconductor, Analog Devices, Macronix, Taoglas, Ignion, Adafruit, Skylo) belong to their owners and are used to identify parts. No affiliation or endorsement is implied.

This is a concept and a simulation. Dimensions and architecture are not validated for manufacture.
