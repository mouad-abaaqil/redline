// Builds the two demo trips for the dashboard (web/src/demo-trips.json).
//
// Real inputs : the Paris-Lyon route (OpenStreetMap), the weather forecast (Open-Meteo),
//               both stored as dated snapshots in simulation/data/.
// Simulated   : the vehicle, the traffic incident, the jammer, the thief, the fleet peers.
// Real code   : every device decision comes from firmware/RedlineCore.h through
//               simulation/build/runner; every estimate from web/src/eta.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRoute, positionAt, haversineM, segmentAt, patternFactor, weatherFactor, incidentCapMs,
  observedRatio, predictEta
} from '../web/src/eta.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = f => JSON.parse(readFileSync(resolve(here, 'data', f), 'utf8'));
const routeAData = load('route-a.json');
const routeBData = load('route-b.json');
const weatherData = load('weather.json');

execFileSync('sh', [resolve(here, 'build.sh')], { stdio: 'inherit' });
const RUNNER = resolve(here, 'build/runner');

// ------------------------------------------------------------------ helpers

function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

// Douglas-Peucker, tolerance in metres.
function simplify(coords, tolM) {
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  const k = Math.cos(coords[0][0] * Math.PI / 180);
  const m = 111195;
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, wi = -1;
    const ax = coords[a][1] * k * m, ay = coords[a][0] * m, bx = coords[b][1] * k * m, by = coords[b][0] * m;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = coords[i][1] * k * m - ax, py = coords[i][0] * m - ay;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tolM) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}
function simplifyTo(coords, maxPoints) {
  for (let tol = 50; tol < 5000; tol *= 1.4) {
    const s = simplify(coords, tol);
    if (s.length <= maxPoints) return s;
  }
  return simplify(coords, 5000);
}

function weatherLookup(offsetM = 0) {
  const pts = weatherData.points.map(p => ({ ...p, idx: new Map(p.time.map((t, i) => [t, i])) }));
  return (tMs, distM) => {
    const target = distM + offsetM;
    let best = pts[0], bd = Infinity;
    for (const p of pts) {
      const dd = Math.abs(p.distM - target);
      if (dd < bd) { bd = dd; best = p; }
    }
    const hour = new Date(Math.floor(tMs / 3600e3) * 3600e3).toISOString().slice(0, 13) + ':00';
    const i = best.idx.get(hour);
    return i === undefined ? {} : { precipMm: best.precipMm[i], visibilityM: best.visibilityM[i], windMs: best.windMs[i] };
  };
}

// ------------------------------------------------------------------ vehicle

// 10 s steps along a route. `rest` is the planned driver break.
function drive({ route, t0, d0 = 0, rest, incidents, weather, rng, driven0 = 0 }) {
  const steps = [];
  let t = t0, d = d0, driven = driven0, restUntil = 0, restDone = !rest || d0 >= rest.distM;
  let slow = 1, slowT = -Infinity;
  while (d < route.totalM - 1) {
    if (restUntil > t) { steps.push({ t, d, v: 0, driven, state: 'rest', model: 0 }); t += 10e3; continue; }
    if (t - slowT > 600e3) { slow = 1 + 0.04 * gauss(rng); slowT = t; }
    const base = route.seg[segmentAt(route, d)];
    const pat = patternFactor({ t, distM: d, totalM: route.totalM });
    const w = weather(t, d);
    const wfModel = weatherFactor(w);
    const wfTrue = wfModel * ((w.visibilityM ?? 30000) < 1000 ? 0.93 : 1); // real fog costs more than the model assumes
    let v = base * pat * slow * wfTrue * (1 + 0.03 * gauss(rng));
    const cap = incidentCapMs(incidents, d, t, Infinity);
    if (cap < Infinity) v = Math.min(v, cap * (0.9 + 0.2 * rng()));
    v = Math.max(0.5, Math.min(v, 25));
    const model = Math.min(base * pat * wfModel, incidentCapMs(incidents, d, t, t));
    steps.push({ t, d, v, driven, state: 'drive', model });
    d += v * 10; driven += 10; t += 10e3;
    if (!restDone && d >= rest.distM) { d = rest.distM; restDone = true; restUntil = t + rest.durMs; driven = 0; }
  }
  steps.push({ t, d: route.totalM, v: 0, driven, state: 'end', model: 0 });
  return steps;
}

const iso = ms => new Date(ms).toISOString();
const parisClock = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

// ------------------------------------------------------------------ runner I/O

function runCore({ t0, plan, samples, cfg = {}, budget = 3.0 }) {
  const lines = [];
  for (const [k, v] of Object.entries({ corridorM: 3000, deviationConfirmS: 120, stopConfirmS: 600, delayWarnS: 900,
    gnssLossConfirmS: 60, reportNormalS: 900, reportAlertS: 60, reportTheftS: 10, ...cfg })) lines.push(`CFG ${k} ${v}`);
  lines.push(`G ${budget} 0`); // satellite layer disabled by default
  for (const p of plan.route) lines.push(`R ${p[0].toFixed(6)} ${p[1].toFixed(6)}`);
  for (const z of plan.zones) lines.push(`Z ${z.lat.toFixed(6)} ${z.lon.toFixed(6)} ${z.radiusM}`);
  for (const c of plan.checkpoints) lines.push(`C ${c.lat.toFixed(6)} ${c.lon.toFixed(6)} ${Math.round((c.plannedMs - t0) / 1000)} ${c.radiusM}`);
  for (const s of samples) {
    lines.push(['S', Math.round((s.t - t0) / 1000), s.devLat.toFixed(6), s.devLon.toFixed(6), (s.v * 3.6).toFixed(1),
      s.gnss ? 1 : 0, s.cell ? 1 : 0, s.peer ?? -1, s.peerCell ? 1 : 0, 0, s.motion ? 1 : 0, s.tamperMount ? 1 : 0,
      0, s.power === false ? 0 : 1, (s.shock ?? 0).toFixed(1), s.armed ? 1 : 0].join(' '));
  }
  const out = execFileSync(RUNNER, [], { input: lines.join('\n') + '\n', maxBuffer: 1 << 28 }).toString();
  const res = { ticks: [], events: [], delivered: [], gasp: [], end: null };
  for (const l of out.split('\n')) {
    if (!l.trim()) continue;
    const j = JSON.parse(l);
    ({ t: res.ticks, e: res.events, d: res.delivered, g: res.gasp }[j.k]?.push(j));
    if (j.k === 'end') res.end = j;
  }
  return res;
}

const EVT = ['none', 'deviation_start', 'deviation_end', 'unauthorized_stop', 'stop_end', 'checkpoint', 'schedule_delay',
  'gnss_loss', 'gnss_restored', 'armed_motion', 'tamper', 'power_loss', 'shock', 'mode_change'];

function describe(e, ctx) {
  const min = s => Math.round(Math.abs(s) / 60);
  switch (e.type) {
    case 'deviation_start': return ['high', 'Left the planned corridor', `${(e.value / 1000).toFixed(1)} km away from the planned route`];
    case 'deviation_end': return ['info', 'Back inside the planned corridor', ''];
    case 'unauthorized_stop': return ['high', 'Unauthorized stop', `Stopped ${min(e.value)} min outside every authorized zone`];
    case 'stop_end': return ['info', 'Moving again', ''];
    case 'checkpoint': {
      const c = ctx.checkpointAt(e);
      return ['info', c ? c.name : 'Checkpoint', e.value > 60 ? `${min(e.value)} min late` : e.value < -60 ? `${min(e.value)} min early` : 'On schedule'];
    }
    case 'schedule_delay': return ['medium', 'Behind schedule', `${min(e.value)} min late at ${ctx.checkpointAt(e)?.name ?? 'checkpoint'}`];
    case 'gnss_loss': return ['high', 'GNSS lost while the network is up', 'No satellite fix for 60 s while the cellular link is healthy: jamming suspected'];
    case 'gnss_restored': return ['info', 'GNSS restored', ''];
    case 'armed_motion': return ['high', 'Movement while parked and armed', 'Motion confirmed for 10 s'];
    case 'tamper': return ['critical', e.value === 1 ? 'Device removed from its mount' : 'Cover opened', 'Tamper switch released'];
    case 'power_loss': return ['critical', 'Power lost', 'Battery or supply cut: last gasp triggered'];
    case 'shock': return [e.value >= 150 ? 'critical' : 'medium', 'Shock', `${e.value.toFixed(0)} g peak recorded by the black box`];
    case 'mode_change': return e.value === 2 ? ['critical', 'THEFT MODE', 'Reporting every 10 s on every available channel']
      : e.value === 1 ? ['high', 'Alert mode', 'Reporting every 60 s'] : ['info', 'Back to normal mode', ''];
    default: return ['info', e.type, ''];
  }
}

function assemble({ id, meta, t0, route, planRoute, plan, samples, core, extraEvents = [], eta = [], peers = [], arrivedMs = null }) {
  const checkpointAt = e => plan.checkpoints.find(c => haversineM([e.lat, e.lon], [c.lat, c.lon]) <= c.radiusM * 1.5);
  const delivered = core.delivered;
  const events = core.events.map(e => {
    const [severity, title, detail] = describe(e, { checkpointAt });
    const tMs = t0 + e.t * 1000;
    const evtIndex = EVT.indexOf(e.type);
    const d = delivered.find(x => x.evt === evtIndex && x.created === e.t);
    return { t: tMs, deliveredMs: d ? t0 + d.t * 1000 : null, via: d ? d.ch : null, peer: d && d.peer >= 0 ? d.peer : null,
      type: e.type, severity, title, detail, lat: e.lat, lon: e.lon, value: e.value };
  }).filter(e => !(e.type === 'checkpoint' && e.severity === 'info' && false));
  const modeAt = new Map(core.ticks.map(k => [k.t, k]));
  const track = samples.map(s => {
    const k = modeAt.get(Math.round((s.t - t0) / 1000));
    const link = s.cell ? 1 : (s.peer != null && s.peer >= 0 && s.peerCell ? 2 : 0);
    return { t: s.t, la: +s.lat.toFixed(5), lo: +s.lon.toFixed(5), v: Math.round(s.v * 3.6), m: k ? k.mode : 0, l: link, g: s.gnss ? 1 : 0 };
  });
  const reports = delivered.filter(d => d.evt === 0).map(d => ({
    id: d.id, createdMs: t0 + d.created * 1000, deliveredMs: t0 + d.t * 1000, via: d.ch, peer: d.peer, hops: d.hops, prio: d.prio,
    lat: d.lat, lon: d.lon, mode: d.mode
  }));
  const gasp = core.gasp.map(g => ({ t: t0 + g.t * 1000, ch: g.ch, ok: !!g.ok, peer: g.peer, remaining: g.remaining, lat: g.lat, lon: g.lon }));
  return { id, ...meta, departMs: t0, arrivedMs, route, plan, track, reports, events: [...events, ...extraEvents].sort((a, b) => a.t - b.t),
    eta, peers, gasp, blackbox: core.end };
}

// ------------------------------------------------------------------ route model

const routeA = buildRoute(routeAData.coords, routeAData.speedsKmh);
const routeB = buildRoute(routeBData.coords, routeBData.speedsKmh);
const planRoute = simplifyTo(routeAData.coords, 380);
const displayRoute = simplifyTo(routeAData.coords, 600).map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]);
const rest = { distM: 350000, durMs: 45 * 60e3 };
const restPos = positionAt(routeA, rest.distM);

function makePlan(t0, weatherFn) {
  const fracs = [0.25, 0.5, 0.75, 1];
  const names = ['Checkpoint 1 of 4', 'Checkpoint 2 of 4', 'Checkpoint 3 of 4', 'Destination'];
  const checkpoints = fracs.map((f, i) => {
    const target = f * routeA.totalM;
    const sub = { ...routeA, totalM: target };
    const eta = predictEta({ route: sub, nowMs: t0, progressM: 0, weather: weatherFn }).etaMs;
    const [lat, lon] = positionAt(routeA, target);
    return { name: names[i], lat, lon, plannedMs: eta, radiusM: 2500 };
  });
  const [oLat, oLon] = routeAData.from;
  const [dLat, dLon] = routeAData.to;
  const zones = [
    { name: 'Origin depot', lat: oLat, lon: oLon, radiusM: 3000 },
    { name: 'Destination depot', lat: dLat, lon: dLon, radiusM: 3000 },
    { name: 'Planned rest stop (45 min)', lat: restPos[0], lon: restPos[1], radiusM: 800 }
  ];
  return { route: planRoute, corridorM: 3000, checkpoints, zones,
    plannedEtaMs: checkpoints[3].plannedMs };
}

function sampleOf(step, route, extra = {}) {
  const [lat, lon] = positionAt(route, step.d);
  return { t: step.t, lat, lon, devLat: lat, devLon: lon, v: step.v, gnss: true, cell: true, motion: step.state === 'drive',
    ...extra };
}

// ------------------------------------------------------------------ trip A: delayed by traffic

function tripA() {
  const rng = rng32(1001);
  const t0 = Date.parse('2026-10-06T03:30:00Z');
  const depart = t0 + 10 * 60e3;
  const forecast = weatherLookup();
  const plan = makePlan(depart, forecast);

  // Dry run to find when the truck reaches the stretch where the accident will happen.
  const dry = drive({ route: routeA, t0: depart, rest, incidents: [], weather: forecast, rng: rng32(7) });
  const tAt = d => dry.find(s => s.d >= d).t;
  const start = tAt(395000) - 20 * 60e3;
  const incidents = [{ id: 'RL-INC-1', fromM: 395000, toM: 415000, speedKmh: 20, startMs: start, endMs: start + 3 * 3600e3,
    publishedMs: start + 35 * 60e3 }];
  const steps = drive({ route: routeA, t0: depart, rest, incidents, weather: forecast, rng });
  const arrivedMs = steps[steps.length - 1].t;

  const samples = [];
  for (let t = t0; t < depart; t += 60e3) samples.push({ ...sampleOf({ t, d: 0, v: 0, state: 'park' }, routeA), motion: false, armed: true });
  const sixty = steps.filter(s => ((s.t - depart) / 1000) % 60 === 0);
  let shockDone = false;
  const modelPairs = [];
  const etaSeries = [];
  const staticEta = plan.plannedEtaMs;
  sixty.forEach((s, i) => {
    const smp = sampleOf(s, routeA);
    if (s.d >= 205000 && s.d <= 214000) smp.cell = false; // a valley without coverage: reports are stored, then sent
    if (!shockDone && s.d >= 120000) { smp.shock = 58; shockDone = true; }
    samples.push(smp);
    if (s.state === 'drive' && s.v > 1.4) modelPairs.push({ obsMs: s.v, modelMs: s.model });
    if (i % 5 === 0 && s.state !== 'end') {
      const ratio = observedRatio(modelPairs.slice(-30));
      const restUntilMs = s.state === 'rest' ? steps.find(x => x.t > s.t && x.state !== 'rest')?.t ?? 0 : 0;
      const e = predictEta({ route: routeA, nowMs: s.t, progressM: s.d, drivenS: s.driven, weather: forecast, incidents, ratio, restUntilMs });
      etaSeries.push({ t: s.t, eta: e.etaMs, rem: Math.round(e.remainingM) });
    }
  });
  for (let t = arrivedMs + 60e3; t <= arrivedMs + 10 * 60e3; t += 60e3)
    samples.push({ ...sampleOf({ t, d: routeA.totalM, v: 0, state: 'park' }, routeA), motion: false, armed: true });

  const core = runCore({ t0, plan, samples });
  // Platform view: an ETA slip alert the first time the estimate passes 15 and 30 minutes of delay.
  const extra = [];
  for (const [min, severity] of [[15, 'medium'], [30, 'high']]) {
    const hit = etaSeries.find(e => e.eta - staticEta >= min * 60e3);
    if (hit) extra.push({ t: hit.t, deliveredMs: hit.t, via: 'platform', peer: null, type: 'eta_slip', severity,
      title: `Arrival now ${min}+ min later than planned`, detail: `Estimate ${parisClock(hit.eta)} against ${parisClock(staticEta)} planned (Paris time)`,
      lat: positionAt(routeA, steps.find(s => s.t >= hit.t).d)[0], lon: positionAt(routeA, steps.find(s => s.t >= hit.t).d)[1], value: min });
  }
  const incidentEvent = { t: incidents[0].publishedMs, deliveredMs: incidents[0].publishedMs, via: 'open data', peer: null, type: 'traffic_situation',
    severity: 'medium', title: 'Traffic situation published', detail: 'Accident ahead: traffic at 20 km/h on 20 km (DATEX II style record, simulated)',
    lat: positionAt(routeA, 395000)[0], lon: positionAt(routeA, 395000)[1], value: 20 };

  const errAt = e => Math.abs(e.eta - arrivedMs) / 60e3;
  const stats = {
    distanceKm: +(routeA.totalM / 1000).toFixed(0),
    plannedDurationMin: Math.round((staticEta - depart) / 60e3),
    actualDurationMin: Math.round((arrivedMs - depart) / 60e3),
    delayMin: Math.round((arrivedMs - staticEta) / 60e3),
    staticEtaErrorMin: +(Math.abs(staticEta - arrivedMs) / 60e3).toFixed(0),
    liveEtaError120MinBefore: +errAt(etaSeries.filter(e => arrivedMs - e.t >= 120 * 60e3).pop()).toFixed(0),
    liveEtaError60MinBefore: +errAt(etaSeries.filter(e => arrivedMs - e.t >= 60 * 60e3).pop()).toFixed(0),
    liveEtaError15MinBefore: +errAt(etaSeries.filter(e => arrivedMs - e.t >= 15 * 60e3).pop()).toFixed(0)
  };
  const trip = assemble({
    id: 'RL-1001',
    meta: { title: 'Optical instruments, Paris to Lyon', scenario: 'delay', cargo: 'Precision optics, 14 crates', vehicle: 'Truck 12', device: 'RL-0042',
      origin: 'Paris', destination: 'Lyon' },
    t0, route: displayRoute, plan, samples, core, extraEvents: [...extra, incidentEvent],
    eta: etaSeries, arrivedMs
  });
  trip.stats = stats;
  trip.incidents = incidents.map(i => ({ ...i, lat: positionAt(routeA, (i.fromM + i.toM) / 2)[0], lon: positionAt(routeA, (i.fromM + i.toM) / 2)[1] }));
  return trip;
}

// ------------------------------------------------------------------ trip B: theft

function tripB() {
  const rng = rng32(2207);
  const t0 = Date.parse('2026-10-06T19:00:00Z');
  const depart = t0 + 10 * 60e3;
  const forecast = weatherLookup();
  const plan = makePlan(depart, forecast);
  const splitDist = 0.37 * routeA.totalM;

  const stepsA = drive({ route: { ...routeA, totalM: splitDist }, t0: depart, rest, incidents: [], weather: forecast, rng });
  const tSplit = stepsA[stepsA.length - 1].t;
  const stepsB = drive({ route: routeB, t0: tSplit, incidents: [], weather: weatherLookup(splitDist), rng });
  const tSite = stepsB[stepsB.length - 1].t;
  const site = routeB.coords[routeB.coords.length - 1];

  const samples = [];
  for (let t = t0; t < depart; t += 60e3) samples.push({ ...sampleOf({ t, d: 0, v: 0, state: 'park' }, routeA), motion: false, armed: true });
  for (const s of stepsA.filter(s => ((s.t - depart) / 1000) % 60 === 0 && s.state !== 'end')) samples.push(sampleOf(s, routeA));

  // Fleet peers crossing the area: path 500 m east of the site, heading north.
  const peers = [
    { id: 7, label: 'RL-PEER-07', centreMs: tSite + 21 * 60e3, speedMs: 16.7 },
    { id: 12, label: 'RL-PEER-12', centreMs: tSite + 52 * 60e3, speedMs: 8.3 }
  ];
  const peerPos = (p, t) => {
    const dy = (t - p.centreMs) / 1000 * p.speedMs;
    return [site[0] + dy / 111195, site[1] + 500 / (111195 * Math.cos(site[0] * Math.PI / 180))];
  };
  const MESH_RANGE_M = 2000; // assumption to measure on hardware
  const peerFor = (lat, lon, t) => peers.find(p => haversineM([lat, lon], peerPos(p, t)) <= MESH_RANGE_M);

  // Phase 2: the detour. The jammer starts 12 km into it, the dead zone 20 km into it.
  let lastFix = null;
  const bStep = stepsB.filter(s => ((s.t - tSplit) / 1000) % 10 === 0 && s.state !== 'end');
  for (const s of bStep) {
    const jam = s.d >= 12000, dead = s.d >= 20000;
    const smp = sampleOf(s, routeB, { gnss: !jam, cell: !dead });
    if (!jam) lastFix = [smp.lat, smp.lon]; else { smp.devLat = lastFix[0]; smp.devLon = lastFix[1]; }
    const pr = peerFor(smp.lat, smp.lon, s.t);
    if (pr) { smp.peer = pr.id; smp.peerCell = true; }
    samples.push(smp);
  }
  // Phase 3: parked at the isolated site. The thief removes the device, then cuts the power.
  const tTamper = tSite + 50 * 60e3, tPower = tSite + 53 * 60e3;
  const [sLat, sLon] = site;
  for (let t = tSite; t <= tPower + 25e3; t += (t >= tPower ? 1e3 : 10e3)) {
    const smp = { t, lat: sLat, lon: sLon, devLat: lastFix[0], devLon: lastFix[1], v: 0, gnss: false, cell: false, motion: false,
      tamperMount: t >= tTamper, power: t < tPower };
    const pr = peerFor(sLat, sLon, t);
    if (pr) { smp.peer = pr.id; smp.peerCell = true; }
    samples.push(smp);
  }

  const core = runCore({ t0, plan, samples });
  const lastDelivered = core.delivered.reduce((m, d) => Math.max(m, d.t), 0);
  const gaspOk = core.gasp.find(g => g.ok);
  const extra = [];
  if (gaspOk) extra.push({ t: t0 + gaspOk.t * 1000, deliveredMs: t0 + gaspOk.t * 1000, via: gaspOk.ch, peer: gaspOk.peer, type: 'last_gasp', severity: 'critical',
    title: 'LAST GASP received', detail: `Final position and black-box summary delivered through RL-PEER-${String(gaspOk.peer).padStart(2, '0')} (1 hop), cellular was down`,
    lat: gaspOk.lat, lon: gaspOk.lon, value: 0 });
  const silentAt = t0 + lastDelivered * 1000 + 60e3;
  extra.push({ t: silentAt, deliveredMs: silentAt, via: 'platform', peer: null, type: 'silent', severity: 'critical', title: 'Device silent',
    detail: 'No report for 6 intervals in theft mode: the platform raises the alarm on its own (dead-man switch)', lat: sLat, lon: sLon, value: 0 });

  const trip = assemble({
    id: 'RL-2207',
    meta: { title: 'Pharmaceutical shipment, Paris to Lyon', scenario: 'theft', cargo: 'Temperature-sensitive medicines, 6 pallets', vehicle: 'Truck 31', device: 'RL-0107',
      origin: 'Paris', destination: 'Lyon' },
    t0, route: displayRoute, plan, samples, core, extraEvents: extra, peers: peers.map(p => ({
      id: p.id, label: p.label,
      path: Array.from({ length: 36 }, (_, i) => { const t = p.centreMs + (i - 18) * 40e3; const q = peerPos(p, t); return [t, +q[0].toFixed(5), +q[1].toFixed(5)]; })
    })), arrivedMs: null
  });
  const ev = type => trip.events.find(e => e.type === type);
  trip.stats = {
    detourAlertDelayS: Math.round((ev('deviation_start').deliveredMs - (t0 + (stepsB.find(s => s.d >= 5600 + 0).t - t0))) / 1000),
    stopAlertDelayMin: +((ev('unauthorized_stop').deliveredMs - ev('unauthorized_stop').t) / 60e3).toFixed(1),
    tamperAlertDelayS: Math.round((ev('tamper').deliveredMs - ev('tamper').t) / 1000),
    lastGaspChannel: gaspOk ? gaspOk.ch : null,
    lastGaspDelayS: gaspOk ? Math.round((gaspOk.t - (ev('power_loss').t - t0) / 1000)) : null,
    relayedMessages: core.delivered.filter(d => d.ch === 'mesh').length,
    meshRangeAssumedM: MESH_RANGE_M
  };
  trip.detour = simplifyTo(routeBData.coords, 160).map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]);
  trip.site = { lat: sLat, lon: sLon, name: 'Isolated site (simulated)' };
  trip.meshRangeM = MESH_RANGE_M;
  return trip;
}

const A = tripA();
const B = tripB();
const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sources: {
    route: { name: routeAData.source, fetchedAt: routeAData.fetchedAt },
    weather: { name: weatherData.source, fetchedAt: weatherData.fetchedAt },
    note: 'Route and weather are real open data. Vehicles, traffic incident, jammer, thief and fleet peers are simulated. Device decisions come from the real firmware core.'
  },
  trips: [A, B]
};
writeFileSync(resolve(here, '../web/src/demo-trips.json'), JSON.stringify(out));
const kb = Math.round(JSON.stringify(out).length / 1024);
console.log(`demo-trips.json written (${kb} kB)`);
for (const t of out.trips) {
  console.log(`\n${t.id} ${t.title}: ${t.track.length} samples, ${t.events.length} events, ${t.reports.length} reports`);
  for (const e of t.events.filter(e => !['checkpoint', 'stop_end', 'deviation_end'].includes(e.type)).slice(0, 40))
    console.log('  ', iso(e.t).slice(11, 19), e.severity.padEnd(8), e.title.padEnd(42), e.deliveredMs ? `-> ${iso(e.deliveredMs).slice(11, 19)} via ${e.via}` : '(not delivered)');
  if (t.stats) console.log('  stats', t.stats);
  console.log('  black box', t.blackbox);
}
