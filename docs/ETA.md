# Arrival time

`web/src/eta.js`, tested by `web/src/eta.test.js` (8 tests). Pure functions: nothing calls the network, so every estimate can be replayed.

## Method

The remaining route is walked in 2 km chunks, advancing the clock. For each chunk the speed is

```
v = free-flow speed
    × rush-hour factor      (near the two ends of the trip, less on weekends)
    × weather factor        (rain, visibility, wind: from the Open-Meteo forecast)
    × fleet correction      (what the vehicle measured against the model, clamped 0.5 to 1.3, fading over 80 km)
  capped by any traffic situation published before "now"
```

Trucks are limited to 85 km/h. When 4.5 h of driving is reached, a 45-minute break is inserted once (a break already under way is respected). The engine returns the estimated arrival and the number of breaks.

## What is real and what is not

| Part | Status |
| --- | --- |
| Road geometry and free-flow speeds | Real: OpenStreetMap, routed by the public OSRM demo server, stored as a dated snapshot in `simulation/data/` |
| Weather | Real: Open-Meteo forecast for 6 points along the route, snapshot in `simulation/data/` |
| Rush-hour pattern | **Synthetic.** A smooth bump around 08:00 and 18:00 near the trip ends. It must be replaced by a measured weekly speed profile (168 values per road segment, as Valhalla supports) |
| Traffic accident | **Simulated**, injected as a DATEX II style record with a publication time |
| Vehicle speeds | **Simulated**, with noise, slow-downs, and extra slowing in real fog that the model only partly knows |

## Reading the result

In the delayed shipment the plan (made at departure, with the forecast) is 52 minutes off. The live estimate cannot see the accident before it is published, so for the first hours it is about as wrong as the plan: the 120-minute-before error is 44 min. After the publication and the observed slow-down it converges: 10 min at 60 minutes before arrival and 1 min at 15. This shows the mechanism; it is not a field accuracy figure.

## Using real traffic data

- **DATEX II.** European national access points publish situations (accidents, roadworks) in this format, for example [transport.data.gouv.fr](https://transport.data.gouv.fr/) in France. A situation maps to `{ fromM, toM, speedKmh, startMs, endMs, publishedMs }`: project its location onto the route with `nearestProgress` and keep its publication time.
- **Historical speeds.** [Valhalla](https://mapzen.com/blog/speed-tiles/) accepts 168 speeds per edge (one per hour of the week). Measured fleet speeds can build this profile over time, which would replace the synthetic pattern.
- **Licenses.** OpenStreetMap data is ODbL (attribution required). The public OSRM demo server is for light use: self-host it for anything real.
