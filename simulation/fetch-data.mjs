// Fetches the open data used by the simulation and stores dated snapshots in
// simulation/data/. Run once; the snapshots are committed so the build is
// reproducible offline.
//   Route    OpenStreetMap, routed by the public OSRM demo server (light use only)
//   Weather  Open-Meteo forecast (CC BY 4.0 data)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoute, positionAt, haversineM } from '../web/src/eta.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, 'data');
mkdirSync(out, { recursive: true });

const PARIS = [48.8566, 2.3522];
const LYON = [45.764, 4.8357];
const RURAL = [47.64, 3.07]; // an isolated area west of the A6, for the theft scenario

async function osrm(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}` +
    '?overview=full&geometries=geojson&annotations=duration,distance';
  const res = await fetch(url, { headers: { 'User-Agent': 'redline-simulation (open source project)' } });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const json = await res.json();
  const r = json.routes[0];
  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const ann = r.legs[0].annotation;
  if (ann.duration.length !== coords.length - 1) throw new Error('annotation length mismatch');
  const speedsKmh = ann.duration.map((s, i) => (s > 0 ? (ann.distance[i] / s) * 3.6 : 30));
  return { coords, speedsKmh, distanceM: r.distance, durationS: r.duration };
}

const a = await osrm(PARIS, LYON);
const routeA = buildRoute(a.coords, a.speedsKmh);
const split = positionAt(routeA, 0.37 * routeA.totalM); // about where the A6 passes Auxerre
const b = await osrm(split, RURAL);

const stamp = new Date().toISOString();
const meta = { source: 'OpenStreetMap contributors via the public OSRM demo server', fetchedAt: stamp };
writeFileSync(resolve(out, 'route-a.json'), JSON.stringify({ ...meta, from: PARIS, to: LYON, ...a }));
writeFileSync(resolve(out, 'route-b.json'), JSON.stringify({ ...meta, from: split, to: RURAL, ...b }));

// Weather at 6 points along the main route, hourly for the next 3 days.
const pts = [0, 0.2, 0.4, 0.6, 0.8, 1].map(f => positionAt(routeA, f * routeA.totalM));
const q = new URLSearchParams({
  latitude: pts.map(p => p[0].toFixed(3)).join(','),
  longitude: pts.map(p => p[1].toFixed(3)).join(','),
  hourly: 'precipitation,wind_speed_10m,visibility',
  wind_speed_unit: 'ms',
  timezone: 'UTC',
  forecast_days: '3'
});
let wr;
for (let attempt = 1; attempt <= 5; attempt++) {
  wr = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
  if (wr.ok) break;
  await new Promise(r => setTimeout(r, 2000 * attempt)); // the free API sometimes answers 503
}
if (!wr.ok) throw new Error(`Open-Meteo ${wr.status}`);
const wj = await wr.json();
writeFileSync(resolve(out, 'weather.json'), JSON.stringify({
  source: 'Open-Meteo (CC BY 4.0)', fetchedAt: stamp,
  points: wj.map((w, i) => ({
    distM: Math.round(([0, 0.2, 0.4, 0.6, 0.8, 1][i]) * routeA.totalM), lat: pts[i][0], lon: pts[i][1],
    time: w.hourly.time, precipMm: w.hourly.precipitation, windMs: w.hourly.wind_speed_10m, visibilityM: w.hourly.visibility
  }))
}));

console.log(`Route A: ${(a.distanceM / 1000).toFixed(0)} km, ${a.coords.length} points, ${(a.durationS / 3600).toFixed(2)} h by car`);
console.log(`Route B: ${(b.distanceM / 1000).toFixed(0)} km, ${b.coords.length} points from [${split.map(x => x.toFixed(3))}]`);
console.log(`Detour start is ${(haversineM(split, RURAL) / 1000).toFixed(0)} km from the isolated area`);
