// ETA engine. Pure functions, shared by the dashboard and the simulation.
//
// Inputs are open: an OpenStreetMap route with free-flow speeds, a recurring
// congestion pattern, weather (Open-Meteo), traffic situations (DATEX II
// style records) and what the vehicles actually measured. Nothing here calls
// the network, so every estimate can be replayed and tested.

export const TRUCK_MAX_KMH = 85;
export const BREAK_AFTER_S = 4.5 * 3600; // EU driving-time rule, to be checked per vehicle class
export const BREAK_S = 45 * 60;

const R = 6371000;
const rad = deg => deg * Math.PI / 180;

export function haversineM(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// coords: [[lat, lon], ...]; freeFlowKmh: one number or one value per segment.
export function buildRoute(coords, freeFlowKmh) {
  const cum = [0];
  const seg = [];
  for (let i = 0; i < coords.length - 1; i++) {
    cum.push(cum[i] + haversineM(coords[i], coords[i + 1]));
    const v = Array.isArray(freeFlowKmh) ? freeFlowKmh[i] : freeFlowKmh;
    seg.push(Math.min(Math.max(v, 10), TRUCK_MAX_KMH) / 3.6); // m/s, trucks are speed limited
  }
  return { coords, cum, seg, totalM: cum[cum.length - 1] };
}

export function segmentAt(route, d) {
  let lo = 0;
  let hi = route.seg.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (route.cum[mid] <= d) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function positionAt(route, d) {
  const dd = Math.min(Math.max(d, 0), route.totalM);
  const i = segmentAt(route, dd);
  const len = route.cum[i + 1] - route.cum[i];
  const f = len > 0 ? (dd - route.cum[i]) / len : 0;
  const a = route.coords[i];
  const b = route.coords[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// Distance along the route of the point nearest to `point`, searched around a hint.
export function nearestProgress(route, point, hintM = 0, windowM = 60000) {
  const k = Math.cos(rad(point[0]));
  let best = Infinity;
  let bestD = hintM;
  for (let i = 0; i < route.seg.length; i++) {
    if (route.cum[i + 1] < hintM - windowM || route.cum[i] > hintM + windowM) continue;
    const a = route.coords[i];
    const b = route.coords[i + 1];
    const ax = (a[1] - point[1]) * k, ay = a[0] - point[0];
    const dx = (b[1] - a[1]) * k, dy = b[0] - a[0];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy;
    const dist = Math.hypot(cx, cy);
    if (dist < best) {
      best = dist;
      bestD = route.cum[i] + t * (route.cum[i + 1] - route.cum[i]);
    }
  }
  return bestD;
}

// Recurring congestion: rush hours, felt mostly around the two ends of the trip.
// A synthetic stand-in until a measured weekly profile (168 values) is loaded.
export function patternFactor({ t, distM, totalM, tzOffsetH = 2 }) {
  const local = new Date(t + tzOffsetH * 3600e3);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  const weekend = local.getUTCDay() === 0 || local.getUTCDay() === 6;
  const peak = Math.min(1, Math.exp(-((h - 8) ** 2) / 2) + Math.exp(-((h - 18) ** 2) / 2.5));
  const near = Math.max(0, 1 - Math.min(distM, totalM - distM) / 40000);
  return 1 - (weekend ? 0.1 : 0.35) * peak * near;
}

// w: { precipMm, visibilityM, windMs } as published by Open-Meteo.
export function weatherFactor(w = {}) {
  const { precipMm = 0, visibilityM = 30000, windMs = 0 } = w;
  let f = 1;
  if (precipMm > 2) f -= 0.08; else if (precipMm > 0.2) f -= 0.04;
  if (visibilityM < 1000) f -= 0.12; else if (visibilityM < 4000) f -= 0.05;
  if (windMs > 15) f -= 0.05;
  return Math.max(0.75, f);
}

// Traffic situation: speed cap on a stretch for a time window. Only
// situations published before `knownAtMs` are visible to the estimate.
export function incidentCapMs(incidents, d, t, knownAtMs) {
  let cap = Infinity;
  for (const x of incidents) {
    if (x.publishedMs > knownAtMs) continue;
    if (t < x.startMs || t > x.endMs || d < x.fromM || d > x.toM) continue;
    cap = Math.min(cap, x.speedKmh / 3.6);
  }
  return cap;
}

// What the vehicles measured against what the model expected, clamped.
export function observedRatio(pairs) {
  let obs = 0;
  let model = 0;
  for (const p of pairs) {
    obs += p.obsMs;
    model += p.modelMs;
  }
  if (model <= 0) return 1;
  return Math.min(1.3, Math.max(0.5, obs / model));
}

// Estimated arrival time. Walks the remaining route in 2 km chunks, advancing
// the clock, and inserts the mandatory driver break when it falls due.
export function predictEta({ route, nowMs, progressM, drivenS = 0, weather = () => ({}), incidents = [],
  ratio = 1, tzOffsetH = 2, restUntilMs = 0 }) {
  let t = Math.max(nowMs, restUntilMs); // a break in progress ends first
  let d = progressM;
  let driven = drivenS;
  let breaks = 0;
  const step = 2000;
  while (d < route.totalM - 1) {
    const end = Math.min(d + step, route.totalM);
    const mid = (d + end) / 2;
    const base = route.seg[segmentAt(route, mid)];
    const adapt = 1 + (ratio - 1) * Math.exp(-(mid - progressM) / 80000);
    let v = base * patternFactor({ t, distM: mid, totalM: route.totalM, tzOffsetH }) * weatherFactor(weather(t, mid)) * adapt;
    v = Math.min(v, incidentCapMs(incidents, mid, t, nowMs)); // only what was published by `nowMs`
    const dt = (end - d) / Math.max(v, 1);
    t += dt * 1000;
    driven += dt;
    d = end;
    if (driven >= BREAK_AFTER_S && d < route.totalM - 1) {
      t += BREAK_S * 1000;
      driven = 0;
      breaks++;
    }
  }
  return { etaMs: t, remainingM: route.totalM - progressM, breaks };
}
